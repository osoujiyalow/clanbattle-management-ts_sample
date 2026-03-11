import { ClanBattleData } from "../domain/clan-battle-data.js";
import type { GuildBossInfoConfig } from "../domain/guild-bossinfo-config.js";
import type { GuildBossInfoRepository } from "../repositories/sqlite/guild-bossinfo-repository.js";
import {
  NumericTokenizationError,
  parseNormalizedIntegerToken,
  tokenizeNumericInput,
} from "../shared/numeric-tokenizer.js";
import { now, type Clock, systemClock } from "../shared/time.js";
import {
  type BossInfoSource,
  renderBossInfoBoundaryPrompt,
  renderBossInfoConfirmText,
  renderBossInfoHpPrompt,
  renderBossInfoIntroText,
  renderBossInfoSavedText,
  renderBossInfoShowMessage,
} from "../renderers/bossinfo-renderer.js";
import type { RuntimeStateService } from "./runtime-state-service.js";

const GUILD_ONLY_MESSAGE = "このコマンドはサーバー内で実行してください。";
const MANAGE_GUILD_REQUIRED_MESSAGE =
  "このコマンドを実行するには `サーバーの管理` 権限が必要です。";
const INTERACTION_OWNER_REQUIRED_MESSAGE =
  "この編集ウィザードはコマンド実行者のみ操作できます。";
const PHASE_COUNT_ERROR_PREFIX = "フェーズ数の入力エラー: ";
const BOUNDARY_ERROR_PREFIX = "境界入力エラー: ";
const HP_ERROR_PREFIX = "HP入力エラー: ";
const FINAL_VALIDATION_ERROR_PREFIX = "最終バリデーションでエラーになりました: ";
const SAVE_VALIDATION_ERROR_PREFIX = "保存前バリデーションエラー: ";
const SESSION_TIMEOUT_MS = 600_000;

type BossInfoViewAction = "start" | "cancel" | "open-boundary" | "open-hp" | "save";
type BossInfoViewStyle = "primary" | "secondary" | "success";

export interface BossInfoButtonSpec {
  label: string;
  style: BossInfoViewStyle;
  action: BossInfoViewAction;
}

export interface BossInfoViewSpec {
  kind: "start" | "boundary" | "hp" | "confirm";
  timeoutSeconds: number;
  buttons: readonly BossInfoButtonSpec[];
  bossNumber?: number;
  chunkIndex?: number;
  totalChunks?: number;
}

export interface BossInfoAttachment {
  filename: string;
  content: string;
}

export interface BossInfoMessageResult {
  kind: "message";
  visibility: "ephemeral";
  content: string;
  view?: BossInfoViewSpec;
  attachment?: BossInfoAttachment;
}

export interface BossInfoModalFieldSpec {
  label: string;
  required: boolean;
  defaultValue: string;
  placeholder: string;
  maxLength: number;
}

export interface BossInfoModalContext {
  kind: "phase-count" | "boundary" | "hp";
  startIndex?: number;
  endIndex?: number;
  bossIndex?: number;
}

export interface BossInfoModalResult {
  kind: "modal";
  visibility: "ephemeral";
  title: string;
  timeoutSeconds: number;
  fields: readonly BossInfoModalFieldSpec[];
  context?: BossInfoModalContext;
}

export type BossInfoUiResult = BossInfoMessageResult | BossInfoModalResult;

export interface BossInfoGuildRequest {
  guildId: string | null;
  hasManageGuildPermission: boolean;
}

export interface BossInfoSessionRequest extends BossInfoGuildRequest {
  userId: string;
}

export interface BossInfoPhaseCountSubmitRequest extends BossInfoSessionRequest {
  rawValue: string;
}

export interface BossInfoBoundarySubmitRequest extends BossInfoSessionRequest {
  values: readonly string[];
  startIndex: number;
  endIndex: number;
}

export interface BossInfoHpSubmitRequest extends BossInfoSessionRequest {
  values: readonly string[];
  bossIndex: number;
  startIndex: number;
  endIndex: number;
}

interface BossInfoSession {
  guildId: string;
  userId: string;
  originalConfig: GuildBossInfoConfig;
  config: GuildBossInfoConfig;
  originalPhaseCount: number;
  boundaryChunkIndex: number;
  hpBossIndex: number;
  hpChunkIndex: number;
  updatedAt: Date;
}

export interface BossInfoServiceOptions {
  runtimeStateService: RuntimeStateService;
  guildBossInfoRepository: GuildBossInfoRepository;
  clock?: Clock;
}

function createMessageResult(
  content: string,
  view?: BossInfoViewSpec,
  attachment?: BossInfoAttachment,
): BossInfoMessageResult {
  return {
    kind: "message",
    visibility: "ephemeral",
    content,
    ...(view ? { view } : {}),
    ...(attachment ? { attachment } : {}),
  };
}

function createStartView(): BossInfoViewSpec {
  return {
    kind: "start",
    timeoutSeconds: 600,
    buttons: [
      { label: "編集開始", style: "primary", action: "start" },
      { label: "キャンセル", style: "secondary", action: "cancel" },
    ],
  };
}

function createBoundaryView(chunkIndex: number, totalChunks: number): BossInfoViewSpec {
  return {
    kind: "boundary",
    timeoutSeconds: 600,
    chunkIndex,
    totalChunks,
    buttons: [
      { label: "境界入力を開く", style: "primary", action: "open-boundary" },
      { label: "キャンセル", style: "secondary", action: "cancel" },
    ],
  };
}

function createHpView(bossNumber: number, chunkIndex: number, totalChunks: number): BossInfoViewSpec {
  return {
    kind: "hp",
    timeoutSeconds: 600,
    bossNumber,
    chunkIndex,
    totalChunks,
    buttons: [
      { label: "HP入力を開く", style: "primary", action: "open-hp" },
      { label: "キャンセル", style: "secondary", action: "cancel" },
    ],
  };
}

function createConfirmView(): BossInfoViewSpec {
  return {
    kind: "confirm",
    timeoutSeconds: 600,
    buttons: [
      { label: "保存", style: "success", action: "save" },
      { label: "キャンセル", style: "secondary", action: "cancel" },
    ],
  };
}

function countActiveClansByGuild(runtimeStateService: RuntimeStateService, guildId: string): number {
  let count = 0;
  for (const clanData of runtimeStateService.getAll().values()) {
    if (clanData.guildId === guildId) {
      count += 1;
    }
  }
  return count;
}

export class BossInfoService {
  private readonly clock: Clock;
  private readonly sessions = new Map<string, BossInfoSession>();

  constructor(private readonly options: BossInfoServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  show(request: BossInfoGuildRequest): BossInfoMessageResult {
    const guildId = this.requireGuildAdmin(request);
    if (!guildId) {
      return this.guildValidationMessage(request);
    }

    const config = ClanBattleData.getGuildConfig(guildId);
    const source: BossInfoSource = ClanBattleData.hasGuildConfig(guildId) ? "custom(SQLite)" : "default";
    return createMessageResult(renderBossInfoShowMessage(config, source));
  }

  exportJson(request: BossInfoGuildRequest): BossInfoMessageResult {
    const guildId = this.requireGuildAdmin(request);
    if (!guildId) {
      return this.guildValidationMessage(request);
    }

    const config = ClanBattleData.getGuildConfig(guildId);
    return createMessageResult(
      "現在の guild bossinfo 設定を JSON で出力しました。",
      undefined,
      {
        filename: `bossinfo-${guildId}.json`,
        content: ClanBattleData.configToJson(config),
      },
    );
  }

  startEdit(request: BossInfoSessionRequest): BossInfoMessageResult {
    const guildId = this.requireGuildAdmin(request);
    if (!guildId) {
      return this.guildValidationMessage(request);
    }

    const current = ClanBattleData.getGuildConfig(guildId);
    const timestamp = now(this.clock);
    this.sessions.set(this.sessionKey(guildId, request.userId), {
      guildId,
      userId: request.userId,
      originalConfig: current.copy(),
      config: current.copy(),
      originalPhaseCount: current.boundaries.length,
      boundaryChunkIndex: 0,
      hpBossIndex: 0,
      hpChunkIndex: 0,
      updatedAt: timestamp,
    });

    return createMessageResult(renderBossInfoIntroText(current), createStartView());
  }

  ensureWizardOwner(
    expectedGuildId: string,
    expectedUserId: string,
    actualGuildId: string | null,
    actualUserId: string,
  ): BossInfoMessageResult | null {
    if (actualGuildId !== expectedGuildId || actualUserId !== expectedUserId) {
      return createMessageResult(INTERACTION_OWNER_REQUIRED_MESSAGE);
    }

    return null;
  }

  openPhaseCountModal(request: BossInfoSessionRequest): BossInfoUiResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    return {
      kind: "modal",
      visibility: "ephemeral",
      timeoutSeconds: 600,
      title: "bossinfo_edit: フェーズ数",
      fields: [
        {
          label: "いくつ段階がありますか？（空欄=変更なし）",
          required: false,
          defaultValue: String(session.config.boundaries.length),
          placeholder: `1-${ClanBattleData.MAX_PHASE_COUNT}`,
          maxLength: 2,
        },
      ],
    };
  }

  submitPhaseCount(request: BossInfoPhaseCountSubmitRequest): BossInfoMessageResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    try {
      const phaseCount = this.parsePhaseCount(request.rawValue, session.config.boundaries.length);
      this.resizeConfig(session, phaseCount);
    } catch (error) {
      return createMessageResult(`${PHASE_COUNT_ERROR_PREFIX}${this.getErrorMessage(error)}`);
    }

    session.boundaryChunkIndex = 0;
    session.hpBossIndex = 0;
    session.hpChunkIndex = 0;

    return this.buildBoundaryPrompt(session);
  }

  openBoundaryModal(request: BossInfoSessionRequest): BossInfoUiResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    const { startIndex, endIndex } = this.getBoundaryChunkRange(session);
    const fields: BossInfoModalFieldSpec[] = [];

    for (let phaseIndex = startIndex; phaseIndex <= endIndex; phaseIndex += 1) {
      fields.push({
        label: `${phaseIndex + 1}段階 (開始周 終了周)`,
        required: false,
        defaultValue: this.getBoundaryDefaultText(session, phaseIndex),
        placeholder: "例: 7 22 / 最終段階は 23 -1",
        maxLength: 24,
      });
    }

    return {
      kind: "modal",
      visibility: "ephemeral",
      timeoutSeconds: 600,
      title: `bossinfo_edit: 境界 (${startIndex + 1}-${endIndex + 1}段階)`,
      fields,
    };
  }

  getCurrentBoundaryRange(
    request: BossInfoSessionRequest,
  ): { startIndex: number; endIndex: number } | BossInfoMessageResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    return this.getBoundaryChunkRange(session);
  }

  submitBoundaries(request: BossInfoBoundarySubmitRequest): BossInfoMessageResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    try {
      for (
        let phaseIndex = request.startIndex, offset = 0;
        phaseIndex <= request.endIndex;
        phaseIndex += 1, offset += 1
      ) {
        const raw = request.values[offset]?.trim() ?? "";
        if (!raw) {
          if (phaseIndex >= session.originalPhaseCount) {
            throw new Error(`${phaseIndex + 1}段階は新規フェーズなので入力必須です。`);
          }
          continue;
        }

        session.config.boundaries[phaseIndex] = this.parseBoundary(raw);
      }
    } catch (error) {
      return createMessageResult(`${BOUNDARY_ERROR_PREFIX}${this.getErrorMessage(error)}`);
    }

    session.boundaryChunkIndex += 1;
    if (session.boundaryChunkIndex < this.totalPhaseChunks(session.config)) {
      return this.buildBoundaryPrompt(session);
    }

    session.hpBossIndex = 0;
    session.hpChunkIndex = 0;
    return this.buildHpPrompt(session);
  }

  openHpModal(request: BossInfoSessionRequest): BossInfoUiResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    const { startIndex, endIndex } = this.getHpChunkRange(session);
    const fields: BossInfoModalFieldSpec[] = [];

    for (let phaseIndex = startIndex; phaseIndex <= endIndex; phaseIndex += 1) {
      fields.push({
        label: `${phaseIndex + 1}段階 HP`,
        required: false,
        defaultValue: this.getHpDefaultText(session, session.hpBossIndex, phaseIndex),
        placeholder: "例: 5600",
        maxLength: 16,
      });
    }

    return {
      kind: "modal",
      visibility: "ephemeral",
      timeoutSeconds: 600,
      title: `bossinfo_edit: ${session.hpBossIndex + 1}ボスHP (${startIndex + 1}-${endIndex + 1}段階)`,
      fields,
    };
  }

  getCurrentHpContext(
    request: BossInfoSessionRequest,
  ): { bossIndex: number; startIndex: number; endIndex: number } | BossInfoMessageResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    const { startIndex, endIndex } = this.getHpChunkRange(session);
    return {
      bossIndex: session.hpBossIndex,
      startIndex,
      endIndex,
    };
  }

  submitHp(request: BossInfoHpSubmitRequest): BossInfoMessageResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    try {
      for (
        let phaseIndex = request.startIndex, offset = 0;
        phaseIndex <= request.endIndex;
        phaseIndex += 1, offset += 1
      ) {
        const raw = request.values[offset]?.trim() ?? "";
        if (!raw) {
          if (phaseIndex >= session.originalPhaseCount) {
            throw new Error(`${phaseIndex + 1}段階HPは新規フェーズなので入力必須です。`);
          }
          continue;
        }

        session.config.hp[phaseIndex]![request.bossIndex] = this.parseHpValue(raw, phaseIndex);
      }
    } catch (error) {
      return createMessageResult(`${HP_ERROR_PREFIX}${this.getErrorMessage(error)}`);
    }

    const nextChunkIndex = session.hpChunkIndex + 1;
    const totalChunks = this.totalPhaseChunks(session.config);
    if (nextChunkIndex < totalChunks) {
      session.hpChunkIndex = nextChunkIndex;
      return this.buildHpPrompt(session);
    }

    const nextBossIndex = session.hpBossIndex + 1;
    if (nextBossIndex < 5) {
      session.hpBossIndex = nextBossIndex;
      session.hpChunkIndex = 0;
      return this.buildHpPrompt(session);
    }

    return this.buildConfirmPrompt(session);
  }

  save(request: BossInfoSessionRequest): BossInfoMessageResult {
    const session = this.getSessionOrError(request);
    if ("kind" in session) {
      return session;
    }

    let validated: GuildBossInfoConfig;
    try {
      validated = ClanBattleData.validateConfig(session.config.hp, session.config.boundaries);
    } catch (error) {
      return createMessageResult(`${SAVE_VALIDATION_ERROR_PREFIX}${this.getErrorMessage(error)}`);
    }

    this.options.guildBossInfoRepository.upsert(session.guildId, validated, session.userId);
    ClanBattleData.setGuildConfig(session.guildId, validated);
    this.clearSession(session.guildId, session.userId);

    const activeClanCount = countActiveClansByGuild(this.options.runtimeStateService, session.guildId);
    return createMessageResult(renderBossInfoSavedText(validated, activeClanCount));
  }

  cancel(request: BossInfoSessionRequest): BossInfoMessageResult {
    if (request.guildId) {
      this.clearSession(request.guildId, request.userId);
    }

    return createMessageResult("bossinfo 編集ウィザードをキャンセルしました。");
  }

  getActiveSessionCount(): number {
    this.cleanupExpiredSessions();
    return this.sessions.size;
  }

  private buildBoundaryPrompt(session: BossInfoSession): BossInfoMessageResult {
    const totalChunks = this.totalPhaseChunks(session.config);
    return createMessageResult(
      renderBossInfoBoundaryPrompt(session.config, session.boundaryChunkIndex),
      createBoundaryView(session.boundaryChunkIndex, totalChunks),
    );
  }

  private buildHpPrompt(session: BossInfoSession): BossInfoMessageResult {
    const totalChunks = this.totalPhaseChunks(session.config);
    return createMessageResult(
      renderBossInfoHpPrompt(session.config, session.hpBossIndex, session.hpChunkIndex),
      createHpView(session.hpBossIndex + 1, session.hpChunkIndex, totalChunks),
    );
  }

  private buildConfirmPrompt(session: BossInfoSession): BossInfoMessageResult {
    try {
      const validated = ClanBattleData.validateConfig(session.config.hp, session.config.boundaries);
      session.config = validated;
      const source: BossInfoSource = ClanBattleData.hasGuildConfig(session.guildId)
        ? "custom(SQLite)"
        : "default";
      return createMessageResult(renderBossInfoConfirmText(validated, source), createConfirmView());
    } catch (error) {
      return createMessageResult(
        `${FINAL_VALIDATION_ERROR_PREFIX}${this.getErrorMessage(error)}\n再度 \`/bossinfo_edit\` でやり直してください。`,
      );
    }
  }

  private getBoundaryDefaultText(session: BossInfoSession, phaseIndex: number): string {
    if (phaseIndex >= session.config.boundaries.length) {
      return "";
    }

    const [start, end] = session.config.boundaries[phaseIndex]!;
    if (start <= 0) {
      return "";
    }

    return `${start} ${end}`;
  }

  private getHpDefaultText(
    session: BossInfoSession,
    bossIndex: number,
    phaseIndex: number,
  ): string {
    if (phaseIndex >= session.config.hp.length) {
      return "";
    }

    const value = session.config.hp[phaseIndex]?.[bossIndex] ?? 0;
    return value > 0 ? String(value) : "";
  }

  private totalPhaseChunks(config: GuildBossInfoConfig): number {
    return Math.max(1, Math.ceil(config.boundaries.length / 5));
  }

  private getBoundaryChunkRange(session: BossInfoSession): { startIndex: number; endIndex: number } {
    const startIndex = session.boundaryChunkIndex * 5;
    const endIndex = Math.min(startIndex + 4, session.config.boundaries.length - 1);
    return { startIndex, endIndex };
  }

  private getHpChunkRange(session: BossInfoSession): { startIndex: number; endIndex: number } {
    const startIndex = session.hpChunkIndex * 5;
    const endIndex = Math.min(startIndex + 4, session.config.boundaries.length - 1);
    return { startIndex, endIndex };
  }

  private resizeConfig(session: BossInfoSession, phaseCount: number): void {
    const config = session.config;
    const currentCount = config.boundaries.length;

    if (phaseCount === currentCount) {
      return;
    }

    if (phaseCount < currentCount) {
      config.boundaries.splice(phaseCount);
      config.hp.splice(phaseCount);
      return;
    }

    let nextStart = 1;
    if (config.boundaries.length > 0) {
      const [previousStart, previousEnd] = config.boundaries[config.boundaries.length - 1]!;
      if (previousEnd === -1) {
        config.boundaries[config.boundaries.length - 1] = [previousStart, previousStart];
        nextStart = previousStart + 1;
      } else {
        nextStart = previousEnd + 1;
      }
    }

    for (let phaseIndex = currentCount; phaseIndex < phaseCount; phaseIndex += 1) {
      const isLast = phaseIndex === phaseCount - 1;
      config.boundaries.push([nextStart, isLast ? -1 : nextStart]);
      config.hp.push([0, 0, 0, 0, 0]);
      nextStart += 1;
    }
  }

  private parsePhaseCount(rawValue: string, currentPhaseCount: number): number {
    const value = rawValue.trim();
    if (!value) {
      return currentPhaseCount;
    }

    const errorMessage = `フェーズ数は 1〜${ClanBattleData.MAX_PHASE_COUNT} の整数で入力してください。`;
    const phaseCount = this.parsePositiveInteger(value, errorMessage);
    if (phaseCount > ClanBattleData.MAX_PHASE_COUNT) {
      throw new Error(errorMessage);
    }

    return phaseCount;
  }

  private parseBoundary(rawValue: string): [number, number] {
    const errorMessage = "開始周と終了周の2つを入力してください。例: `7 22`";
    const parts = this.normalizeBoundaryTokens(rawValue, errorMessage);
    const start = parseNormalizedIntegerToken(parts[0]!);
    const end = parseNormalizedIntegerToken(parts[1]!);
    if (start === null || end === null) {
      throw new Error(errorMessage);
    }

    return [start, end];
  }

  private normalizeBoundaryTokens(rawValue: string, errorMessage: string): string[] {
    const tokens = this.tokenizeNumericTokens(rawValue, errorMessage);
    if (tokens.length !== 2) {
      throw new Error(errorMessage);
    }

    return tokens;
  }

  private parseHpValue(rawValue: string, phaseIndex: number): number {
    return this.parsePositiveInteger(
      rawValue,
      `${phaseIndex + 1}段階HPは正の整数で入力してください。`,
    );
  }

  private parsePositiveInteger(rawValue: string, errorMessage: string): number {
    const tokens = this.tokenizeNumericTokens(rawValue, errorMessage);
    if (tokens.length !== 1) {
      throw new Error(errorMessage);
    }

    const value = parseNormalizedIntegerToken(tokens[0]!);
    if (value === null || value <= 0) {
      throw new Error(errorMessage);
    }

    return value;
  }

  private tokenizeNumericTokens(rawValue: string, errorMessage: string): string[] {
    try {
      return tokenizeNumericInput(rawValue);
    } catch (error) {
      if (error instanceof NumericTokenizationError) {
        throw new Error(errorMessage);
      }

      throw error;
    }
  }

  private getSessionOrError(request: BossInfoSessionRequest): BossInfoSession | BossInfoMessageResult {
    if (!request.guildId) {
      return createMessageResult("編集セッションが見つかりません。もう一度 `/bossinfo_edit` から開始してください。");
    }

    this.cleanupExpiredSessions();
    const key = this.sessionKey(request.guildId, request.userId);
    const session = this.sessions.get(key);
    if (!session) {
      return createMessageResult("編集セッションが見つかりません。もう一度 `/bossinfo_edit` から開始してください。");
    }

    session.updatedAt = now(this.clock);
    return session;
  }

  private clearSession(guildId: string, userId: string): void {
    this.sessions.delete(this.sessionKey(guildId, userId));
  }

  private cleanupExpiredSessions(): void {
    const current = now(this.clock).getTime();
    for (const [key, session] of this.sessions.entries()) {
      if (current - session.updatedAt.getTime() >= SESSION_TIMEOUT_MS) {
        this.sessions.delete(key);
      }
    }
  }

  private sessionKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  private requireGuildAdmin(request: BossInfoGuildRequest): string | null {
    if (!request.guildId) {
      return null;
    }

    if (!request.hasManageGuildPermission) {
      return null;
    }

    return request.guildId;
  }

  private guildValidationMessage(request: BossInfoGuildRequest): BossInfoMessageResult {
    if (!request.guildId) {
      return createMessageResult(GUILD_ONLY_MESSAGE);
    }

    return createMessageResult(MANAGE_GUILD_REQUIRED_MESSAGE);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
