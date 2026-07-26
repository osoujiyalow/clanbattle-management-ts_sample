import { ClanBattleData } from "../domain/clan-battle-data.js";
import type { GuildBossInfoConfig } from "../domain/guild-bossinfo-config.js";

export type BossInfoSource = "custom(SQLite)" | "default";

export function formatBossInfoSummary(config: GuildBossInfoConfig): string {
  const lines = [`フェーズ数: ${config.boundaries.length}`, "段階別設定 (HPは1〜5ボス順):"];

  config.boundaries.forEach(([start, end], phaseIndex) => {
    const phaseHp = config.hp[phaseIndex] ?? [];
    lines.push(`  ${phaseIndex + 1}段階 ${start}〜${end}: ${phaseHp.join(" / ")}`);
  });

  return lines.join("\n");
}

export function getBossInfoTotalPhaseChunks(config: GuildBossInfoConfig): number {
  return Math.max(1, Math.ceil(config.boundaries.length / 5));
}

export function getBossInfoChunkRange(
  chunkIndex: number,
  phaseCount: number,
): readonly [number, number] {
  const startIndex = chunkIndex * 5;
  const endIndex = Math.min(startIndex + 4, phaseCount - 1);
  return [startIndex, endIndex];
}

export function renderBossInfoIntroText(
  config: GuildBossInfoConfig,
  notice = "bossinfo 編集メニューを開きました。",
): string {
  return [
    notice,
    "この設定は guild 単位で保存され、SQLite を正本として管理されます。",
    "保存確認を押すまでは、このサーバーの設定には反映されません。",
    "",
    "必要な項目だけ編集できます。",
    "- 段階数: 段階を増減します",
    "- 境界: `開始周 終了周` 形式で編集します（最終段階は `23 -1`）",
    "- HP: 各段階の `1ボス 2ボス 3ボス 4ボス 5ボス` をまとめて編集します",
    "",
    formatBossInfoSummary(config),
  ].join("\n");
}

export function renderBossInfoShowMessage(
  config: GuildBossInfoConfig,
  source: BossInfoSource,
): string {
  const summary = formatBossInfoSummary(config);
  const jsonText = ClanBattleData.configToJson(config);
  const previewLimit = Math.max(300, 1700 - summary.length);
  const preview =
    jsonText.length <= previewLimit ? jsonText : jsonText.slice(0, previewLimit) + "\n... (truncated)";

  let message = `現在の bossinfo 設定 (${source})\n\n${summary}\n\n\`\`\`json\n${preview}\n\`\`\``;

  if (message.length > 1900) {
    message =
      `現在の bossinfo 設定 (${source})\n\n${summary}\n\n` +
      "JSON 全文は `/bossinfo_export_json` を使ってください。";
  }

  return message;
}

export function renderBossInfoBoundaryPrompt(
  config: GuildBossInfoConfig,
  chunkIndex: number,
): string {
  const totalChunks = getBossInfoTotalPhaseChunks(config);
  const [startIndex, endIndex] = getBossInfoChunkRange(chunkIndex, config.boundaries.length);

  return [
    `境界入力 ${chunkIndex + 1}/${totalChunks}`,
    "入力形式: `開始周 終了周`",
    "記入例: `7 22` / 最終段階は `23 -1`",
    "空欄: 既存値維持（新規フェーズは空欄不可）",
    `対象: ${startIndex + 1}段階目〜${endIndex + 1}段階目`,
  ].join("\n");
}

export function renderBossInfoHpPrompt(
  config: GuildBossInfoConfig,
  _bossIndex: number,
  chunkIndex: number,
): string {
  const totalChunks = getBossInfoTotalPhaseChunks(config);
  const [startIndex, endIndex] = getBossInfoChunkRange(chunkIndex, config.boundaries.length);

  return [
    `HP入力 ${chunkIndex + 1}/${totalChunks}`,
    "入力形式: 各段階ごとに `1ボス 2ボス 3ボス 4ボス 5ボス` の順で正の整数",
    "記入例: `1200 1500 2000 2300 3000`",
    "空欄: 既存値維持（新規フェーズは空欄不可）",
    `対象: ${startIndex + 1}段階目〜${endIndex + 1}段階目`,
  ].join("\n");
}

export function renderBossInfoConfirmText(
  config: GuildBossInfoConfig,
  source: BossInfoSource,
): string {
  return [
    "入力が完了しました。保存前プレビュー:",
    `(現在の参照元: ${source})`,
    "",
    formatBossInfoSummary(config),
    "",
    "保存すると以後に生成される周のボスHPへ反映されます。",
    "進行中の周に対しては表示/整合性が変わる可能性があるため、リセット前の変更を推奨します。",
  ].join("\n");
}

export function renderBossInfoSavedText(
  config: GuildBossInfoConfig,
  activeClanCount: number,
): string {
  return (
    "bossinfo 設定を保存しました (SQLite)。\n" +
    `${formatBossInfoSummary(config)}\n\n` +
    `備考: この guild の管理カテゴリ数=${activeClanCount}。\n` +
    "新しく生成される BossStatusData から新設定が使われます。"
  );
}
