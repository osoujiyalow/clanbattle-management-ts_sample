import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type MessageActionRowComponentBuilder,
} from "discord.js";

import { ATTACK_TYPE_INPUTS } from "../../domain/attack-type.js";
import type { BossStatusData } from "../../domain/boss-status-data.js";
import { ClanBattleData } from "../../domain/clan-battle-data.js";
import type { ClanData } from "../../domain/clan-data.js";
import { OperationLogType, type OperationLog } from "../../domain/operation-log.js";
import type { PlayerResourceState } from "../../domain/player-resource-state.js";
import type { AttackDeclareResponseChannel, AttackService } from "../../services/attack-service.js";
import type { RuntimeStateService } from "../../services/runtime-state-service.js";
import type { InteractionRouter } from "../interaction-router.js";
import {
  DiscordGuildTextGateway,
  deferChatInputReply,
  resolveGuildDisplayNamesForUserIds,
  resolveManagedInteractionContext,
  resolvePreferredGuildMemberDisplayName,
  type DiscordMemberIdentity,
} from "./shared.js";

const AGENT_CUSTOM_ID_PREFIX = "agent";
const AGENT_PANEL_COLOR = 0x3498db;

const AgentOperation = {
  BATTLE_DECLARE: "battle",
  CARRYOVER_DECLARE: "carryover",
  DAMAGE_INPUT: "damage",
  FINISH: "finish",
  DEFEAT: "defeat",
  UNDO: "undo",
} as const;

type AgentOperation = (typeof AgentOperation)[keyof typeof AgentOperation];

export interface AgentCommandHandlersOptions {
  attackService: Pick<
    AttackService,
    "declare" | "finish" | "defeatBoss" | "setPendingDamage" | "undo"
  >;
  runtimeStateService: Pick<
    RuntimeStateService,
    "get" | "getOperationLogs" | "getPlayerResourceState"
  >;
}

interface AgentPanelSelection {
  memberId?: string;
  bossIndex?: number;
  lap?: number;
}

interface AgentPanelRenderInput {
  clanData: ClanData;
  displayNamesByUserId: ReadonlyMap<string, string>;
  operationLogs: readonly OperationLog[];
  playerResourceState?: PlayerResourceState;
  selection?: AgentPanelSelection;
}

type AgentPanelPayload = Pick<
  InteractionReplyOptions,
  "embeds" | "components"
> & {
  content?: string | null;
};

interface ParsedRefreshCustomId {
  categoryId: string;
  selection: AgentPanelSelection;
}

interface ParsedBossSelectCustomId {
  categoryId: string;
  memberId: string;
}

interface ParsedLapSelectCustomId {
  categoryId: string;
  memberId: string;
  bossIndex: number;
}

interface ParsedActionCustomId {
  categoryId: string;
  memberId: string;
  bossIndex: number;
  lap: number;
  operation: AgentOperation;
}

function createAgentMemberSelectCustomId(categoryId: string): string {
  return `${AGENT_CUSTOM_ID_PREFIX}:member:${categoryId}`;
}

function createAgentDeleteCustomId(): string {
  return `${AGENT_CUSTOM_ID_PREFIX}:delete`;
}

function createAgentBossSelectCustomId(categoryId: string, memberId: string): string {
  return `${AGENT_CUSTOM_ID_PREFIX}:boss:${categoryId}:${memberId}`;
}

function createAgentLapSelectCustomId(
  categoryId: string,
  memberId: string,
  bossIndex: number,
): string {
  return `${AGENT_CUSTOM_ID_PREFIX}:lap:${categoryId}:${memberId}:${bossIndex}`;
}

function createAgentDamageModalCustomId(input: Omit<ParsedActionCustomId, "operation">): string {
  return [
    AGENT_CUSTOM_ID_PREFIX,
    "damage",
    input.categoryId,
    input.memberId,
    input.bossIndex.toString(),
    input.lap.toString(),
  ].join(":");
}

function createAgentRefreshCustomId(
  categoryId: string,
  selection: AgentPanelSelection = {},
): string {
  return [
    AGENT_CUSTOM_ID_PREFIX,
    "refresh",
    categoryId,
    selection.memberId ?? "none",
    selection.bossIndex?.toString() ?? "none",
    selection.lap?.toString() ?? "none",
  ].join(":");
}

export function createAgentActionButtonCustomId(input: ParsedActionCustomId): string {
  return [
    AGENT_CUSTOM_ID_PREFIX,
    "act",
    input.categoryId,
    input.memberId,
    input.bossIndex.toString(),
    input.lap.toString(),
    input.operation,
  ].join(":");
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value || value === "none") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseAgentMemberSelectCustomId(customId: string): string | null {
  const [prefix, kind, categoryId] = customId.split(":");
  if (prefix !== AGENT_CUSTOM_ID_PREFIX || kind !== "member" || !categoryId) {
    return null;
  }

  return categoryId;
}

function isAgentDeleteCustomId(customId: string): boolean {
  return customId === createAgentDeleteCustomId();
}

function parseAgentBossSelectCustomId(customId: string): ParsedBossSelectCustomId | null {
  const [prefix, kind, categoryId, memberId] = customId.split(":");
  if (prefix !== AGENT_CUSTOM_ID_PREFIX || kind !== "boss" || !categoryId || !memberId) {
    return null;
  }

  return { categoryId, memberId };
}

function parseAgentLapSelectCustomId(customId: string): ParsedLapSelectCustomId | null {
  const [prefix, kind, categoryId, memberId, bossIndexText] = customId.split(":");
  const bossIndex = Number.parseInt(bossIndexText ?? "", 10);
  if (
    prefix !== AGENT_CUSTOM_ID_PREFIX ||
    kind !== "lap" ||
    !categoryId ||
    !memberId ||
    !Number.isInteger(bossIndex)
  ) {
    return null;
  }

  return { categoryId, memberId, bossIndex };
}

function parseAgentDamageModalCustomId(
  customId: string,
): Omit<ParsedActionCustomId, "operation"> | null {
  const [prefix, kind, categoryId, memberId, bossIndexText, lapText] = customId.split(":");
  const bossIndex = Number.parseInt(bossIndexText ?? "", 10);
  const lap = Number.parseInt(lapText ?? "", 10);
  if (
    prefix !== AGENT_CUSTOM_ID_PREFIX ||
    kind !== "damage" ||
    !categoryId ||
    !memberId ||
    !Number.isInteger(bossIndex) ||
    !Number.isInteger(lap)
  ) {
    return null;
  }

  return {
    categoryId,
    memberId,
    bossIndex,
    lap,
  };
}

function parseAgentRefreshCustomId(customId: string): ParsedRefreshCustomId | null {
  const [prefix, kind, categoryId, memberId, bossIndex, lap] = customId.split(":");
  if (prefix !== AGENT_CUSTOM_ID_PREFIX || kind !== "refresh" || !categoryId) {
    return null;
  }

  const parsedBossIndex = parseOptionalNumber(bossIndex);
  const parsedLap = parseOptionalNumber(lap);
  const selection: AgentPanelSelection = {};
  if (memberId && memberId !== "none") {
    selection.memberId = memberId;
  }
  if (parsedBossIndex !== undefined) {
    selection.bossIndex = parsedBossIndex;
  }
  if (parsedLap !== undefined) {
    selection.lap = parsedLap;
  }

  return {
    categoryId,
    selection,
  };
}

export function parseAgentActionButtonCustomId(customId: string): ParsedActionCustomId | null {
  const [prefix, kind, categoryId, memberId, bossIndexText, lapText, operation] =
    customId.split(":");
  const bossIndex = Number.parseInt(bossIndexText ?? "", 10);
  const lap = Number.parseInt(lapText ?? "", 10);

  if (
    prefix !== AGENT_CUSTOM_ID_PREFIX ||
    kind !== "act" ||
    !categoryId ||
    !memberId ||
    !Number.isInteger(bossIndex) ||
    !Number.isInteger(lap) ||
    !isAgentOperation(operation)
  ) {
    return null;
  }

  return {
    categoryId,
    memberId,
    bossIndex,
    lap,
    operation,
  };
}

function isAgentOperation(value: string | undefined): value is AgentOperation {
  return (
    value === AgentOperation.BATTLE_DECLARE ||
    value === AgentOperation.CARRYOVER_DECLARE ||
    value === AgentOperation.DAMAGE_INPUT ||
    value === AgentOperation.FINISH ||
    value === AgentOperation.DEFEAT ||
    value === AgentOperation.UNDO
  );
}

function formatDamage(value: number): string {
  return value.toLocaleString("en-US");
}

function resolveBossLatestLap(clanData: ClanData, bossIndex: number): number {
  const progressLaps = [...clanData.progressMessageIdsByLap.keys()].sort((left, right) => right - left);
  for (const lap of progressLaps) {
    if (clanData.progressMessageIdsByLap.get(lap)?.[bossIndex]) {
      return lap;
    }
  }

  const bossStatusLaps = [...clanData.bossStatusByLap.keys()].sort((left, right) => right - left);
  for (const lap of bossStatusLaps) {
    if (clanData.bossStatusByLap.get(lap)?.[bossIndex]) {
      return lap;
    }
  }

  return 1;
}

function resolveBossStatusData(
  clanData: ClanData,
  bossIndex: number,
  lap = resolveBossLatestLap(clanData, bossIndex),
): BossStatusData | undefined {
  return clanData.bossStatusByLap.get(lap)?.[bossIndex];
}

function resolveCurrentBossHp(bossStatusData: BossStatusData): number {
  if (bossStatusData.beated) {
    return 0;
  }

  const attackedDamage = bossStatusData.attackPlayers.reduce((sum, attackStatus) => {
    return attackStatus.attacked ? sum + attackStatus.damage : sum;
  }, 0);

  return Math.max(0, bossStatusData.maxHp - attackedDamage);
}

function formatNextPhaseText(clanData: ClanData, lap: number): string {
  const phaseProgress = ClanBattleData.getPhaseProgress(lap, clanData.guildId);
  return phaseProgress.lapsUntilNextPhase === null
    ? ""
    : ` 次段階まで${phaseProgress.lapsUntilNextPhase}周`;
}

function formatProgressLine(
  clanData: ClanData,
  bossIndex: number,
  displayNamesByUserId: ReadonlyMap<string, string>,
): string {
  const lap = resolveBossLatestLap(clanData, bossIndex);
  const bossStatusData = resolveBossStatusData(clanData, bossIndex, lap);
  if (!bossStatusData) {
    return `${bossIndex + 1}ボス（${lap}周）\nHP データなし\n宣言: -`;
  }

  const currentHp = resolveCurrentBossHp(bossStatusData);
  const pendingNames = bossStatusData.attackPlayers
    .filter((attackStatus) => !attackStatus.attacked)
    .map(
      (attackStatus) =>
        displayNamesByUserId.get(attackStatus.playerData.userId) ??
        attackStatus.playerData.userId,
    );
  const pendingText = pendingNames.length === 0 ? "宣言: なし" : `宣言: ${pendingNames.join(", ")}`;
  const beatedText = bossStatusData.beated ? " 討伐済み" : "";

  return `${bossIndex + 1}ボス（${lap}周）${formatNextPhaseText(clanData, lap)}\nHP ${formatDamage(currentHp)}/${formatDamage(bossStatusData.maxHp)}万${beatedText}\n${pendingText}`;
}

function resolveSelectedBoss(
  clanData: ClanData,
  selection: AgentPanelSelection,
): { bossIndex: number; lap: number } {
  const bossIndex =
    selection.bossIndex !== undefined &&
    selection.bossIndex >= 0 &&
    selection.bossIndex < clanData.bossChannelIds.length
      ? selection.bossIndex
      : 0;
  const currentLap = resolveBossLatestLap(clanData, bossIndex);
  const lap = Math.min(Math.max(selection.lap ?? currentLap, 1), currentLap);

  return { bossIndex, lap };
}

function findPendingMemberAttacks(clanData: ClanData, memberId: string): string[] {
  const pendingLines: string[] = [];

  for (const [lap, bossStatusList] of [...clanData.bossStatusByLap.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    bossStatusList.forEach((bossStatusData, bossIndex) => {
      const pendingAttack = bossStatusData.attackPlayers.find(
        (attackStatus) =>
          attackStatus.playerData.userId === memberId && !attackStatus.attacked,
      );
      if (pendingAttack) {
        pendingLines.push(`${lap}周 ${bossIndex + 1}ボス ${pendingAttack.attackType}`);
      }
    });
  }

  return pendingLines;
}

function countPendingMemberAttacks(
  clanData: ClanData,
  memberId: string,
  carryOver: boolean,
): number {
  let count = 0;

  for (const bossStatusList of clanData.bossStatusByLap.values()) {
    for (const bossStatusData of bossStatusList) {
      count += bossStatusData.attackPlayers.filter(
        (attackStatus) =>
          attackStatus.playerData.userId === memberId &&
          !attackStatus.attacked &&
          attackStatus.carryOver === carryOver,
      ).length;
    }
  }

  return count;
}

function formatOperationType(operationType: OperationLogType): string {
  switch (operationType) {
    case OperationLogType.DECLARE:
      return "宣言";
    case OperationLogType.FINISH:
      return "削り";
    case OperationLogType.DEFEAT:
      return "討伐";
    case OperationLogType.UNDO:
      return "戻す";
    case OperationLogType.CORRECT_KIND:
      return "入替";
    case OperationLogType.EXPIRE:
      return "期限切れ";
  }
}

function formatMemberSection(input: AgentPanelRenderInput): string {
  const memberId = input.selection?.memberId;
  if (!memberId) {
    return "対象メンバー: 未選択\nメンバーを選択すると、その人の今日の凸情報と代理操作ボタンを表示します。";
  }

  const displayName = input.displayNamesByUserId.get(memberId) ?? memberId;
  const playerData = input.clanData.getPlayerData(memberId);
  if (!playerData) {
    return `対象メンバー: ${displayName}\n管理対象メンバーに登録されていません。`;
  }

  const battleReservedCount =
    input.playerResourceState?.battleReservedCount ??
    countPendingMemberAttacks(input.clanData, memberId, false);
  const battleConsumedCount =
    input.playerResourceState?.battleConsumedCount ?? playerData.battleAttackCount;
  const carryAvailableCount =
    input.playerResourceState?.carryAvailableCount ?? playerData.carryOverList.length;
  const carryReservedCount =
    input.playerResourceState?.carryReservedCount ??
    countPendingMemberAttacks(input.clanData, memberId, true);
  const pendingLines = findPendingMemberAttacks(input.clanData, memberId);
  const recentLogs = input.operationLogs
    .filter(
      (operationLog) =>
        operationLog.userId === memberId &&
        operationLog.dayKey === input.clanData.date &&
        operationLog.invalidatedAt === null,
    )
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .slice(0, 5)
    .map(
      (operationLog) =>
        `${operationLog.lap}周 ${operationLog.bossIndex + 1}ボス ${formatOperationType(operationLog.operationType)}`,
    );

  return [
    `対象メンバー: ${displayName}`,
    `本戦: 使用可 ${Math.max(0, playerData.battleAttackLimit - battleConsumedCount - battleReservedCount)} / 宣言中 ${battleReservedCount} / 済み ${battleConsumedCount}`,
    `持越: 使用可 ${carryAvailableCount} / 宣言中 ${carryReservedCount}`,
    `未消化宣言: ${pendingLines.length === 0 ? "なし" : pendingLines.join(" / ")}`,
    `今日の操作: ${recentLogs.length === 0 ? "なし" : recentLogs.join(" / ")}`,
  ].join("\n");
}

function buildBossSelectOptions(clanData: ClanData) {
  return clanData.bossChannelIds.map((_, bossIndex) => {
    const lap = resolveBossLatestLap(clanData, bossIndex);
    const bossStatusData = resolveBossStatusData(clanData, bossIndex, lap);
    const hpText = bossStatusData
      ? `${formatDamage(resolveCurrentBossHp(bossStatusData))}/${formatDamage(bossStatusData.maxHp)}万`
      : "データなし";

    return {
      label: `${bossIndex + 1}ボス`,
      description: `現在 ${lap}周 / HP ${hpText}`,
      value: String(bossIndex),
    };
  });
}

function buildLapSelectOptions(
  clanData: ClanData,
  bossIndex: number,
  selectedLap: number,
) {
  const currentLap = resolveBossLatestLap(clanData, bossIndex);
  const startLap = Math.max(1, currentLap - 24);

  return Array.from({ length: currentLap - startLap + 1 }, (_, index) => {
    const lap = startLap + index;
    const bossStatusData = resolveBossStatusData(clanData, bossIndex, lap);
    const hpText = bossStatusData
      ? `HP ${formatDamage(resolveCurrentBossHp(bossStatusData))}/${formatDamage(bossStatusData.maxHp)}万`
      : "データなし";

    return {
      label: `${lap}周`,
      description: hpText,
      value: String(lap),
      default: lap === selectedLap,
    };
  });
}

function createAgentPanelComponents(
  clanData: ClanData,
  selection: AgentPanelSelection,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(createAgentMemberSelectCustomId(clanData.categoryId))
        .setPlaceholder("代理操作するメンバーを選択")
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];

  if (selection.memberId) {
    const selectedBoss = resolveSelectedBoss(clanData, selection);
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(createAgentBossSelectCustomId(clanData.categoryId, selection.memberId))
          .setPlaceholder("操作対象のボス番号を選択")
          .addOptions(
            buildBossSelectOptions(clanData).map((option, bossIndex) => ({
              ...option,
              default: bossIndex === selectedBoss.bossIndex,
            })),
          ),
      ),
    );
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(
            createAgentLapSelectCustomId(
              clanData.categoryId,
              selection.memberId,
              selectedBoss.bossIndex,
            ),
          )
          .setPlaceholder("操作対象の周回を選択")
          .addOptions(buildLapSelectOptions(clanData, selectedBoss.bossIndex, selectedBoss.lap)),
      ),
    );
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        createAgentActionButton({
          categoryId: clanData.categoryId,
          memberId: selection.memberId,
          bossIndex: selectedBoss.bossIndex,
          lap: selectedBoss.lap,
          operation: AgentOperation.BATTLE_DECLARE,
          label: "本戦宣言",
          style: ButtonStyle.Primary,
        }),
        createAgentActionButton({
          categoryId: clanData.categoryId,
          memberId: selection.memberId,
          bossIndex: selectedBoss.bossIndex,
          lap: selectedBoss.lap,
          operation: AgentOperation.CARRYOVER_DECLARE,
          label: "持越宣言",
          style: ButtonStyle.Primary,
        }),
        createAgentActionButton({
          categoryId: clanData.categoryId,
          memberId: selection.memberId,
          bossIndex: selectedBoss.bossIndex,
          lap: selectedBoss.lap,
          operation: AgentOperation.DAMAGE_INPUT,
          label: "ダメ入力",
          style: ButtonStyle.Secondary,
        }),
      ),
    );
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        createAgentActionButton({
          categoryId: clanData.categoryId,
          memberId: selection.memberId,
          bossIndex: selectedBoss.bossIndex,
          lap: selectedBoss.lap,
          operation: AgentOperation.FINISH,
          label: "削り",
          style: ButtonStyle.Success,
        }),
        createAgentActionButton({
          categoryId: clanData.categoryId,
          memberId: selection.memberId,
          bossIndex: selectedBoss.bossIndex,
          lap: selectedBoss.lap,
          operation: AgentOperation.DEFEAT,
          label: "討伐",
          style: ButtonStyle.Danger,
        }),
        createAgentActionButton({
          categoryId: clanData.categoryId,
          memberId: selection.memberId,
          bossIndex: selectedBoss.bossIndex,
          lap: selectedBoss.lap,
          operation: AgentOperation.UNDO,
          label: "戻す",
          style: ButtonStyle.Secondary,
        }),
        new ButtonBuilder()
          .setCustomId(createAgentRefreshCustomId(clanData.categoryId, selection))
          .setLabel("更新")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(createAgentDeleteCustomId())
          .setLabel("削除")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  } else {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(createAgentRefreshCustomId(clanData.categoryId, selection))
          .setLabel("更新")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(createAgentDeleteCustomId())
          .setLabel("削除")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return rows;
}

function createAgentActionButton(input: ParsedActionCustomId & {
  label: string;
  style: ButtonStyle;
}): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(createAgentActionButtonCustomId(input))
    .setLabel(input.label)
    .setStyle(input.style);
}

export function renderAgentPanel(input: AgentPanelRenderInput): AgentPanelPayload {
  const selection = input.selection ?? {};
  const selectedBoss = selection.memberId ? resolveSelectedBoss(input.clanData, selection) : null;
  const progressBlocks = input.clanData.bossChannelIds.map((_, bossIndex) =>
    formatProgressLine(input.clanData, bossIndex, input.displayNamesByUserId),
  );
  const memberSection = formatMemberSection(input);
  const targetSection = selectedBoss
    ? `操作対象: ${selectedBoss.lap}周 ${selectedBoss.bossIndex + 1}ボス`
    : "操作対象: 未選択";

  const embed = new EmbedBuilder()
    .setTitle("代理操作パネル")
    .setDescription(
      [
        "現在の進行状況",
        progressBlocks.join("\n\n"),
        "",
        memberSection,
        "",
        targetSection,
      ].join("\n"),
    )
    .setColor(AGENT_PANEL_COLOR);

  return {
    content: null,
    embeds: [embed],
    components: createAgentPanelComponents(input.clanData, selection),
  };
}

async function resolveAgentDisplayNames(
  guild: Guild,
  clanData: ClanData,
  selectedMemberId?: string,
): Promise<ReadonlyMap<string, string>> {
  const userIds = new Set<string>(clanData.playerDataMap.keys());
  if (selectedMemberId) {
    userIds.add(selectedMemberId);
  }

  for (const bossStatusList of clanData.bossStatusByLap.values()) {
    for (const bossStatusData of bossStatusList) {
      for (const attackStatus of bossStatusData.attackPlayers) {
        userIds.add(attackStatus.playerData.userId);
      }
    }
  }

  return resolveGuildDisplayNamesForUserIds(guild, userIds);
}

function createMissingCategoryPayload(): AgentPanelPayload {
  return {
    content: "管理カテゴリ内で `/agent` を実行してください。",
    embeds: [],
    components: [],
  };
}

async function buildAgentPanelPayload(
  guild: Guild,
  options: AgentCommandHandlersOptions,
  categoryId: string,
  selection: AgentPanelSelection = {},
): Promise<AgentPanelPayload> {
  const clanData = options.runtimeStateService.get(categoryId);
  if (!clanData) {
    return createMissingCategoryPayload();
  }

  const displayNamesByUserId = await resolveAgentDisplayNames(
    guild,
    clanData,
    selection.memberId,
  );
  const renderInput: AgentPanelRenderInput = {
    clanData,
    displayNamesByUserId,
    operationLogs: options.runtimeStateService.getOperationLogs(categoryId),
    selection,
  };

  if (selection.memberId) {
    const playerResourceState = options.runtimeStateService.getPlayerResourceState(
      categoryId,
      selection.memberId,
      clanData.date,
    );
    if (playerResourceState) {
      renderInput.playerResourceState = playerResourceState;
    }
  }

  return renderAgentPanel(renderInput);
}

async function updateAgentPanelInteraction(
  interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
  options: AgentCommandHandlersOptions,
  categoryId: string,
  selection: AgentPanelSelection = {},
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Guild interaction is required.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const payload = await buildAgentPanelPayload(interaction.guild, options, categoryId, selection);

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload as InteractionEditReplyOptions);
    return;
  }

  if ("update" in interaction && typeof interaction.update === "function") {
    await interaction.update(payload as InteractionEditReplyOptions);
    return;
  }

  await interaction.editReply(payload as InteractionEditReplyOptions);
}

async function resolveMemberIdentityById(
  guild: Guild,
  userId: string,
): Promise<DiscordMemberIdentity> {
  const cachedMember = guild.members.cache.get(userId);
  if (cachedMember) {
    return {
      id: userId,
      displayName: resolvePreferredGuildMemberDisplayName(cachedMember),
    };
  }

  const guildMember = await guild.members.fetch(userId).catch(() => null);
  return {
    id: userId,
    displayName: guildMember ? resolvePreferredGuildMemberDisplayName(guildMember) : userId,
  };
}

function createAgentActionResponseChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): AttackDeclareResponseChannel {
  return {
    async send(payload: { content?: string }) {
      await interaction.followUp({
        content: payload.content ?? "",
        flags: MessageFlags.Ephemeral,
      });
    },
    async sendTransient(payload: { content?: string }) {
      await interaction.followUp({
        content: payload.content ?? "",
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}

function createAgentDamageModal(action: ParsedActionCustomId): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(createAgentDamageModalCustomId(action))
    .setTitle(`${action.lap}周 ${action.bossIndex + 1}ボス ダメージ入力`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("damage")
          .setLabel("ダメージ")
          .setPlaceholder("例: 1200000")
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
}

function parseDamageInput(rawValue: string): number | null {
  const normalized = rawValue.replaceAll(",", "").trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const damage = Number.parseInt(normalized, 10);
  return damage > 0 ? damage : null;
}

async function resolveActionDisplayNames(
  guild: Guild,
  clanData: ClanData,
  memberId: string,
): Promise<ReadonlyMap<string, string>> {
  const userIds = new Set<string>(clanData.playerDataMap.keys());
  userIds.add(memberId);
  return resolveGuildDisplayNamesForUserIds(guild, userIds);
}

async function handleAgentActionButtonInteraction(
  interaction: ButtonInteraction,
  options: AgentCommandHandlersOptions,
  action: ParsedActionCustomId,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Guild interaction is required.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action.operation === AgentOperation.DAMAGE_INPUT) {
    await interaction.showModal(createAgentDamageModal(action));
    return;
  }

  await interaction.deferUpdate();

  const clanData = options.runtimeStateService.get(action.categoryId);
  if (!clanData) {
    await interaction.followUp({
      content: "管理カテゴリの状態が見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await resolveMemberIdentityById(interaction.guild, action.memberId);
  const displayNamesByUserId = await resolveActionDisplayNames(
    interaction.guild,
    clanData,
    action.memberId,
  );
  const commonRequest = {
    categoryId: action.categoryId,
    channelId: interaction.channelId,
    lap: action.lap,
    bossNumber: action.bossIndex + 1,
    member,
    responseChannel: createAgentActionResponseChannel(interaction),
    discordGateway: new DiscordGuildTextGateway(interaction.guild),
    displayNamesByUserId,
    resolveDisplayNamesByUserIds: (userIds: Iterable<string>) =>
      resolveGuildDisplayNamesForUserIds(interaction.guild!, userIds),
  };

  if (action.operation === AgentOperation.BATTLE_DECLARE) {
    await options.attackService.declare({
      ...commonRequest,
      attackType: ATTACK_TYPE_INPUTS.BATTLE,
    });
  } else if (action.operation === AgentOperation.CARRYOVER_DECLARE) {
    await options.attackService.declare({
      ...commonRequest,
      attackType: ATTACK_TYPE_INPUTS.CARRYOVER,
    });
  } else if (action.operation === AgentOperation.FINISH) {
    await options.attackService.finish(commonRequest);
  } else if (action.operation === AgentOperation.DEFEAT) {
    await options.attackService.defeatBoss(commonRequest);
  } else {
    await options.attackService.undo(commonRequest);
  }

  await updateAgentPanelInteraction(interaction, options, action.categoryId, {
    memberId: action.memberId,
    bossIndex: action.bossIndex,
    lap: action.lap,
  });
}

export async function handleAgentDamageModalSubmit(
  interaction: ModalSubmitInteraction,
  options: AgentCommandHandlersOptions,
): Promise<void> {
  const action = parseAgentDamageModalCustomId(interaction.customId);
  if (!action) {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: "Guild interaction is required.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const damage = parseDamageInput(interaction.fields.getTextInputValue("damage"));
  if (damage === null) {
    await interaction.reply({
      content: "ダメージは1以上の整数で入力してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const clanData = options.runtimeStateService.get(action.categoryId);
  if (!clanData) {
    await interaction.followUp({
      content: "管理カテゴリの状態が見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await resolveMemberIdentityById(interaction.guild, action.memberId);
  const displayNamesByUserId = await resolveActionDisplayNames(
    interaction.guild,
    clanData,
    action.memberId,
  );
  await options.attackService.setPendingDamage({
    categoryId: action.categoryId,
    channelId: interaction.channelId ?? action.categoryId,
    lap: action.lap,
    bossNumber: action.bossIndex + 1,
    damage,
    member,
    responseChannel: createAgentActionResponseChannel(interaction),
    discordGateway: new DiscordGuildTextGateway(interaction.guild),
    displayNamesByUserId,
    resolveDisplayNamesByUserIds: (userIds: Iterable<string>) =>
      resolveGuildDisplayNamesForUserIds(interaction.guild!, userIds),
  });

  await updateAgentPanelInteraction(interaction, options, action.categoryId, {
    memberId: action.memberId,
    bossIndex: action.bossIndex,
    lap: action.lap,
  });
}

export async function handleAgentCommand(
  interaction: ChatInputCommandInteraction,
  options: AgentCommandHandlersOptions,
): Promise<void> {
  if (!interaction.guild) {
    throw new Error("Guild interaction is required.");
  }

  await deferChatInputReply(interaction, true);

  const managedContext = await resolveManagedInteractionContext(interaction);
  const categoryId = managedContext.categoryId ?? interaction.channelId;
  const payload = await buildAgentPanelPayload(interaction.guild, options, categoryId);
  await interaction.editReply(payload as InteractionEditReplyOptions);
}

export async function handleAgentButtonInteraction(
  interaction: ButtonInteraction,
  options: AgentCommandHandlersOptions,
): Promise<void> {
  if (isAgentDeleteCustomId(interaction.customId)) {
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(async () => {
      await interaction.editReply({
        content: "代理操作パネルを閉じました。",
        embeds: [],
        components: [],
      });
    });
    return;
  }

  const refresh = parseAgentRefreshCustomId(interaction.customId);
  if (refresh) {
    await updateAgentPanelInteraction(interaction, options, refresh.categoryId, refresh.selection);
    return;
  }

  const action = parseAgentActionButtonCustomId(interaction.customId);
  if (!action) {
    return;
  }

  await handleAgentActionButtonInteraction(interaction, options, action);
}

export async function handleAgentSelectMenuInteraction(
  interaction: AnySelectMenuInteraction,
  options: AgentCommandHandlersOptions,
): Promise<void> {
  if (interaction.isUserSelectMenu()) {
    const categoryId = parseAgentMemberSelectCustomId(interaction.customId);
    const memberId = interaction.values[0];
    if (!categoryId || !memberId) {
      return;
    }

    await updateAgentPanelInteraction(interaction, options, categoryId, { memberId });
    return;
  }

  if (!interaction.isStringSelectMenu()) {
    return;
  }

  const bossSelect = parseAgentBossSelectCustomId(interaction.customId);
  if (bossSelect) {
    const bossIndex = Number.parseInt(interaction.values[0] ?? "", 10);
    if (!Number.isInteger(bossIndex)) {
      return;
    }

    await updateAgentPanelInteraction(interaction, options, bossSelect.categoryId, {
      memberId: bossSelect.memberId,
      bossIndex,
    });
    return;
  }

  const lapSelect = parseAgentLapSelectCustomId(interaction.customId);
  const lap = Number.parseInt(interaction.values[0] ?? "", 10);
  if (!lapSelect || !Number.isInteger(lap)) {
    return;
  }

  await updateAgentPanelInteraction(interaction, options, lapSelect.categoryId, {
    memberId: lapSelect.memberId,
    bossIndex: lapSelect.bossIndex,
    lap,
  });
}

export function registerAgentCommandHandlers(
  router: InteractionRouter,
  options: AgentCommandHandlersOptions,
): void {
  router.registerChatInputCommand("agent", async (interaction) => {
    await handleAgentCommand(interaction, options);
  });
  router.registerButtonHandler(/^agent:/u, async (interaction) => {
    await handleAgentButtonInteraction(interaction, options);
  });
  router.registerSelectMenuHandler(/^agent:/u, async (interaction) => {
    await handleAgentSelectMenuInteraction(interaction, options);
  });
  router.registerModalHandler(/^agent:/u, async (interaction) => {
    await handleAgentDamageModalSubmit(interaction, options);
  });
}
