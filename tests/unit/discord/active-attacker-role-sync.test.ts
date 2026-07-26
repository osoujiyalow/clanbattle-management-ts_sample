import { afterEach, describe, expect, it } from "vitest";

import {
  type ActiveAttackerRoleGateway,
  ActiveAttackerRoleSyncService,
} from "../../../src/discord/active-attacker-role-sync.js";
import { AttackType } from "../../../src/domain/attack-type.js";
import { ClanData } from "../../../src/domain/clan-data.js";
import { CarryOver, PlayerData } from "../../../src/domain/player-data.js";
import { ActiveAttackerRoleRepository } from "../../../src/repositories/sqlite/active-attacker-role-repository.js";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../../src/repositories/sqlite/db.js";
import { RuntimeStateService } from "../../../src/services/runtime-state-service.js";
import { createCoreRepositorySchema } from "../repositories/sqlite/core-repository-schema.js";
import {
  createTempSqlitePath,
  type TempSqlitePath,
} from "../repositories/sqlite/test-sqlite-path.js";

class FakeActiveAttackerRoleGateway implements ActiveAttackerRoleGateway {
  readonly roleMembers = new Set<string>();
  readonly updates: Array<{ userId: string; assigned: boolean }> = [];
  ensureCount = 0;
  ensureError: Error | null = null;

  async ensureRole() {
    this.ensureCount += 1;
    if (this.ensureError) {
      throw this.ensureError;
    }
    return {
      roleId: "923456789012345678",
      memberIds: new Set(this.roleMembers),
    };
  }

  async updateMemberRole(
    _guildId: string,
    _roleId: string,
    userId: string,
    assigned: boolean,
  ) {
    this.updates.push({ userId, assigned });
    if (assigned) {
      this.roleMembers.add(userId);
    } else {
      this.roleMembers.delete(userId);
    }
    return "updated" as const;
  }
}

function createClanData(players: readonly PlayerData[]): ClanData {
  return new ClanData({
    guildId: "123456789012345678",
    categoryId: "223456789012345678",
    bossChannelIds: [
      "323456789012345678",
      "423456789012345678",
      "523456789012345678",
      "623456789012345678",
      "723456789012345678",
    ],
    remainAttackChannelId: "823456789012345678",
    commandChannelId: "833456789012345678",
    summaryChannelId: "843456789012345678",
    playerDataMap: new Map(players.map((player) => [player.userId, player])),
    date: "2026-03-08",
  });
}

describe("ActiveAttackerRoleSyncService", () => {
  let database: SqliteDatabase | undefined;
  let tempPath: TempSqlitePath | undefined;

  afterEach(() => {
    if (database) {
      closeSqliteDatabase(database);
      database = undefined;
    }
    tempPath?.cleanup();
    tempPath = undefined;
  });

  function createHarness(players: readonly PlayerData[]) {
    tempPath = createTempSqlitePath("active-attacker-role-");
    database = openSqliteDatabase({ filePath: tempPath.filePath });
    createCoreRepositorySchema(database);
    const runtimeStateService = new RuntimeStateService({ database });
    const clanData = createClanData(players);
    runtimeStateService.set(clanData);
    const gateway = new FakeActiveAttackerRoleGateway();
    const warnings: string[] = [];
    const service = new ActiveAttackerRoleSyncService({
      database,
      runtimeStateService,
      gateway,
      retryCooldownMs: 60_000,
      logger: {
        debug() {},
        info() {},
        warn(message) {
          warnings.push(message);
        },
        error() {},
      },
    });
    return { clanData, gateway, runtimeStateService, service, warnings };
  }

  it("creates the role lazily and mirrors the DB-derived eligible members", async () => {
    const eligible = new PlayerData({ userId: "333456789012345678" });
    const exhausted = new PlayerData({
      userId: "433456789012345678",
      battleAttackCount: 3,
    });
    const carryOnly = new PlayerData({
      userId: "533456789012345678",
      battleAttackCount: 3,
      carryOverList: [
        new CarryOver({
          attackType: AttackType.CARRYOVER,
          bossIndex: 0,
        }),
      ],
    });
    const { clanData, gateway, runtimeStateService, service } = createHarness([
      eligible,
      exhausted,
      carryOnly,
    ]);
    gateway.roleMembers.add("633456789012345678");

    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);

    expect(gateway.roleMembers).toEqual(
      new Set([eligible.userId, carryOnly.userId]),
    );
    expect(gateway.updates).toEqual([
      { userId: eligible.userId, assigned: true },
      { userId: carryOnly.userId, assigned: true },
      { userId: "633456789012345678", assigned: false },
    ]);
    expect(
      new ActiveAttackerRoleRepository(database!).findRoleId(clanData.categoryId),
    ).toBe("923456789012345678");
  });

  it("removes an exhausted member and adds them back after undo", async () => {
    const player = new PlayerData({ userId: "333456789012345678" });
    const { clanData, gateway, runtimeStateService, service } = createHarness([player]);

    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);
    gateway.updates.length = 0;

    player.battleAttackCount = 3;
    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);
    player.battleAttackCount = 2;
    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);

    expect(gateway.updates).toEqual([
      { userId: player.userId, assigned: false },
      { userId: player.userId, assigned: true },
    ]);
    expect(gateway.roleMembers).toEqual(new Set([player.userId]));
  });

  it("reconciles all registered members again when the clan battle day changes", async () => {
    const player = new PlayerData({
      userId: "333456789012345678",
      battleAttackCount: 3,
    });
    const { clanData, gateway, runtimeStateService, service } = createHarness([player]);

    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);
    expect(gateway.ensureCount).toBe(1);

    clanData.date = "2026-03-09";
    player.battleAttackCount = 0;
    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);

    expect(gateway.ensureCount).toBe(2);
    expect(gateway.roleMembers).toEqual(new Set([player.userId]));
  });

  it("isolates permission failures from primary state and throttles retries", async () => {
    const player = new PlayerData({ userId: "333456789012345678" });
    const { clanData, gateway, runtimeStateService, service, warnings } =
      createHarness([player]);
    gateway.ensureError = new Error("Missing Permissions");

    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);
    runtimeStateService.notifyCategoryStateChanged(clanData.categoryId);
    await service.waitForIdle(clanData.categoryId);

    expect(runtimeStateService.get(clanData.categoryId)?.getPlayerData(player.userId)).toBe(player);
    expect(gateway.ensureCount).toBe(1);
    expect(warnings).toEqual([
      "Active attacker role sync failed; primary operation was preserved",
    ]);
  });
});
