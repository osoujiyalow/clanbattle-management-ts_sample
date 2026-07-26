import { afterEach, describe, expect, it } from "vitest";

import { ClanBattleData } from "../../../../src/domain/clan-battle-data.js";
import { ClanData } from "../../../../src/domain/clan-data.js";
import { GuildBossInfoRepository } from "../../../../src/repositories/sqlite/guild-bossinfo-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../../src/repositories/sqlite/db.js";
import { BossInfoService } from "../../../../src/services/bossinfo-service.js";
import { RuntimeStateService } from "../../../../src/services/runtime-state-service.js";
import { createCoreRepositorySchema } from "../../../unit/repositories/sqlite/core-repository-schema.js";
import { createTempSqlitePath, type TempSqlitePath } from "../../../unit/repositories/sqlite/test-sqlite-path.js";

function createClanData(params?: Partial<ConstructorParameters<typeof ClanData>[0]>): ClanData {
  return new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: ["323", "423", "523", "623", "723"],
    remainAttackChannelId: "823",
    commandChannelId: "923",
    summaryChannelId: "10323",
    date: "2026-03-08",
    ...params,
  });
}

function createMutableClock(initialValue: string) {
  let current = new Date(initialValue);
  return {
    clock: {
      now: () => new Date(current.getTime()),
    },
    advanceMs(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe("BossInfoService", () => {
  let tempPath: TempSqlitePath | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    ClanBattleData.loadGuildConfigMap(new Map());
    if (database) {
      closeSqliteDatabase(database);
    }
    database = undefined;
    tempPath?.cleanup();
    tempPath = undefined;
  });

  it("shows current config and exports json", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    const repository = new GuildBossInfoRepository(database);
    const service = new BossInfoService({ runtimeStateService, guildBossInfoRepository: repository });

    const showResult = service.show({
      guildId: "123456789012345678",
      hasManageGuildPermission: true,
    });
    const exportResult = service.exportJson({
      guildId: "123456789012345678",
      hasManageGuildPermission: true,
    });

    expect(showResult.kind).toBe("message");
    expect(showResult.content).toContain("現在の bossinfo 設定 (default)");
    expect(showResult.content).toContain("```json");
    expect(exportResult).toMatchObject({
      kind: "message",
      content: "現在の guild bossinfo 設定を JSON で出力しました。",
      attachment: {
        filename: "bossinfo-123456789012345678.json",
        content: ClanBattleData.configToJson(ClanBattleData.getDefaultConfig()),
      },
    });
  });

  it("returns guild and permission errors", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new BossInfoService({
      runtimeStateService: new RuntimeStateService({ database }),
      guildBossInfoRepository: new GuildBossInfoRepository(database),
    });

    expect(
      service.show({
        guildId: null,
        hasManageGuildPermission: true,
      }).content,
    ).toBe("このコマンドはサーバー内で実行してください。");
    expect(
      service.show({
        guildId: "123456789012345678",
        hasManageGuildPermission: false,
      }).content,
    ).toBe("このコマンドを実行するには `サーバーの管理` 権限が必要です。");
    expect(
      service.ensureWizardOwner(
        "123456789012345678",
        "111",
        "123456789012345678",
        "222",
      )?.content,
    ).toBe("この編集ウィザードはコマンド実行者のみ操作できます。");
  });

  it("walks the edit wizard and saves the new config to sqlite and in-memory state", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const runtimeStateService = new RuntimeStateService({ database });
    runtimeStateService.set(createClanData());
    runtimeStateService.set(
      createClanData({
        categoryId: "323456789012345678",
      }),
    );
    runtimeStateService.set(
      createClanData({
        guildId: "999999999999999999",
        categoryId: "423456789012345678",
      }),
    );

    const repository = new GuildBossInfoRepository(database);
    const service = new BossInfoService({ runtimeStateService, guildBossInfoRepository: repository });

    const start = service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    const phaseModal = service.openPhaseCountModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    const afterPhaseCount = service.submitPhaseCount({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      rawValue: "\uFF14",
    });
    const boundaryModal = service.openBoundaryModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    const afterBoundaries = service.submitBoundaries({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      startIndex: 0,
      endIndex: 3,
      values: [
        "\uFF11\u3000\uFF16",
        "\uFF17\u3000\uFF12\uFF12",
        "\uFF12\uFF13\u3000\uFF13\uFF10",
        "\uFF13\uFF11\u3000\uFF0D1",
      ],
    });

    expect(start.kind).toBe("message");
    expect(start.view?.kind).toBe("menu");
    expect(phaseModal).toMatchObject({
      kind: "modal",
      title: "ボス情報書き換え: フェーズ数",
      fields: [
        {
          label: "いくつ段階がありますか？（空欄=変更なし）",
          defaultValue: "3",
        },
      ],
    });
    expect(afterPhaseCount.view?.kind).toBe("menu");
    expect(afterPhaseCount.content).toContain("段階数を下書きに反映しました");
    expect(boundaryModal).toMatchObject({
      kind: "modal",
      title: "ボス情報書き換え: 境界 (1-4段階)",
    });
    expect(afterBoundaries.view?.kind).toBe("menu");
    expect(afterBoundaries.content).toContain("境界を下書きに反映しました");

    const hpRows = [
      "\uFF11\uFF0C\uFF12\uFF10\uFF10 \uFF11\uFF0C\uFF15\uFF10\uFF10 \uFF12\uFF0C\uFF10\uFF10\uFF10 \uFF12\uFF0C\uFF13\uFF10\uFF10 \uFF13\uFF0C\uFF10\uFF10\uFF10",
      "\uFF15\uFF0C\uFF10\uFF10\uFF10 \uFF15\uFF0C\uFF16\uFF10\uFF10 \uFF16\uFF0C\uFF14\uFF10\uFF10 \uFF17\uFF0C\uFF10\uFF10\uFF10 \uFF18\uFF0C\uFF15\uFF10\uFF10",
      "\uFF11\uFF10\uFF10\uFF0C\uFF10\uFF10\uFF10 \uFF11\uFF10\uFF14\uFF0C\uFF10\uFF10\uFF10 \uFF11\uFF10\uFF18\uFF0C\uFF10\uFF10\uFF10 \uFF11\uFF11\uFF12\uFF0C\uFF10\uFF10\uFF10 \uFF11\uFF11\uFF16\uFF0C\uFF10\uFF10\uFF10",
      "\uFF12\uFF10\uFF10\uFF0C\uFF10\uFF10\uFF10 \uFF12\uFF10\uFF14\uFF0C\uFF10\uFF10\uFF10 \uFF12\uFF10\uFF18\uFF0C\uFF10\uFF10\uFF10 \uFF12\uFF11\uFF12\uFF0C\uFF10\uFF10\uFF10 \uFF12\uFF11\uFF16\uFF0C\uFF10\uFF10\uFF10",
    ] as const;

    const hpModal = service.openHpModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    expect(hpModal).toMatchObject({
      kind: "modal",
      title: "ボス情報書き換え: HP (1-4段階)",
    });

    const afterHp = service.submitHp({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      bossIndex: -1,
      startIndex: 0,
      endIndex: 3,
      values: hpRows,
    });

    expect(afterHp.view?.kind).toBe("menu");
    expect(afterHp.content).toContain("HPを下書きに反映しました");

    const preview = service.previewSave({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    expect(preview.view?.kind).toBe("confirm");
    expect(preview.content).toContain("入力が完了しました。保存前プレビュー:");

    const saved = service.save({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const savedConfig = repository.loadAll().get("123456789012345678");
    const inMemoryConfig = ClanBattleData.getGuildConfig("123456789012345678");
    const sessionMissing = service.openPhaseCountModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    expect(saved.content).toContain("bossinfo 設定を保存しました (SQLite)。");
    expect(saved.content).toContain("備考: この guild の管理カテゴリ数=2。");
    expect(savedConfig?.boundaries).toEqual([
      [1, 6],
      [7, 22],
      [23, 30],
      [31, -1],
    ]);
    expect(savedConfig?.hp).toEqual([
      [1200, 1500, 2000, 2300, 3000],
      [5000, 5600, 6400, 7000, 8500],
      [100000, 104000, 108000, 112000, 116000],
      [200000, 204000, 208000, 212000, 216000],
    ]);
    expect(inMemoryConfig.boundaries).toEqual(savedConfig?.boundaries);
    expect(inMemoryConfig.hp).toEqual(savedConfig?.hp);
    expect(sessionMissing).toMatchObject({
      kind: "message",
      content: "編集セッションが見つかりません。もう一度 `/bossinfo_edit` から開始してください。",
    });
  });

  it("rejects malformed phase count tokens and keeps the current phase count", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new BossInfoService({
      runtimeStateService: new RuntimeStateService({ database }),
      guildBossInfoRepository: new GuildBossInfoRepository(database),
    });

    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const invalid = service.submitPhaseCount({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      rawValue: "2abc",
    });
    const phaseModal = service.openPhaseCountModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    expect(invalid.kind).toBe("message");
    expect(invalid.view?.kind).toBe("menu");
    expect(phaseModal).toMatchObject({
      kind: "modal",
      fields: [{ defaultValue: "3" }],
    });
  });

  it("rejects malformed boundary tokens and keeps the previous boundary values", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new BossInfoService({
      runtimeStateService: new RuntimeStateService({ database }),
      guildBossInfoRepository: new GuildBossInfoRepository(database),
    });

    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    service.submitPhaseCount({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      rawValue: "\uFF14",
    });

    const invalid = service.submitBoundaries({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      startIndex: 0,
      endIndex: 3,
      values: ["1 6", "8abc 22", "23 30", "31 -1"],
    });
    const boundaryModal = service.openBoundaryModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    expect(invalid.kind).toBe("message");
    expect(invalid.view?.kind).toBe("boundary");
    expect(boundaryModal).toMatchObject({
      kind: "modal",
      fields: [
        { defaultValue: "1 6" },
        { defaultValue: "7 22" },
        { defaultValue: "23 23" },
        { defaultValue: "24 -1" },
      ],
    });
  });

  it("rejects malformed hp tokens and leaves hp values unchanged", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new BossInfoService({
      runtimeStateService: new RuntimeStateService({ database }),
      guildBossInfoRepository: new GuildBossInfoRepository(database),
    });

    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    service.submitPhaseCount({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      rawValue: "\uFF14",
    });
    service.submitBoundaries({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      startIndex: 0,
      endIndex: 3,
      values: ["1 6", "7 22", "23 30", "31 -1"],
    });

    const invalid = service.submitHp({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
      bossIndex: 0,
      startIndex: 0,
      endIndex: 3,
      values: ["1300abc", "5000", "100000", "200000"],
    });
    const hpModal = service.openHpModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    expect(invalid.kind).toBe("message");
    expect(invalid.view?.kind).toBe("hp");
    expect(hpModal).toMatchObject({
      kind: "modal",
      fields: [
        { defaultValue: "1200 1500 2000 2300 3000" },
        { defaultValue: "5000 5600 6400 7000 8500" },
        { defaultValue: "100000 104000 108000 112000 116000" },
        { defaultValue: "" },
      ],
    });
  });

  it("expires edit sessions after 600 seconds", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const mutableClock = createMutableClock("2026-03-08T00:00:00+09:00");
    const service = new BossInfoService({
      runtimeStateService: new RuntimeStateService({ database }),
      guildBossInfoRepository: new GuildBossInfoRepository(database),
      clock: mutableClock.clock,
    });

    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    mutableClock.advanceMs(600_001);

    const result = service.openPhaseCountModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    expect(result).toMatchObject({
      kind: "message",
      content: "編集セッションが見つかりません。もう一度 `/bossinfo_edit` から開始してください。",
    });
    expect(service.getActiveSessionCount()).toBe(0);
  });

  it("clears the session on cancel", () => {
    tempPath = createTempSqlitePath();
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);

    const service = new BossInfoService({
      runtimeStateService: new RuntimeStateService({ database }),
      guildBossInfoRepository: new GuildBossInfoRepository(database),
    });

    service.startEdit({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    const cancelled = service.cancel({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });
    const missing = service.openPhaseCountModal({
      guildId: "123456789012345678",
      userId: "111",
      hasManageGuildPermission: true,
    });

    expect(cancelled.content).toBe("bossinfo 編集ウィザードをキャンセルしました。");
    expect(missing).toMatchObject({
      kind: "message",
      content: "編集セッションが見つかりません。もう一度 `/bossinfo_edit` から開始してください。",
    });
  });
});
