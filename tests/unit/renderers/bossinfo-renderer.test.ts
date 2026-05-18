import { describe, expect, it } from "vitest";

import { ClanBattleData } from "../../../src/domain/clan-battle-data.js";
import { renderBossInfoBoundaryPrompt, renderBossInfoConfirmText, renderBossInfoHpPrompt, renderBossInfoIntroText, renderBossInfoSavedText, renderBossInfoShowMessage } from "../../../src/renderers/bossinfo-renderer.js";

describe("bossinfo renderer", () => {
  it("renders the intro, prompt, preview, and saved texts", () => {
    const config = ClanBattleData.validateConfig(
      [
        [1200, 1500, 2000, 2300, 3000],
        [5000, 5600, 6400, 7000, 8500],
      ],
      [
        [1, 6],
        [7, -1],
      ],
    );

    expect(renderBossInfoIntroText(config)).toMatchInlineSnapshot(`
      "bossinfo 編集ウィザードを開始します。
      この設定は guild 単位で保存され、SQLite を正本として管理されます。
      
      入力ルール:
      - 空欄で送信した場合は、既存値を維持します（新しく増やしたフェーズは空欄不可）
      - 境界の入力形式: \`開始周 終了周\`（例: \`7 22\` / 最終段階は \`23 -1\`）
      - HP は正の整数で入力します
      - 現在のフェーズ数: 2
      
      まずフェーズ数を確認/変更します。"
    `);

    expect(renderBossInfoBoundaryPrompt(config, 0)).toBe(
      "境界入力 1/1\n入力形式: `開始周 終了周`\n記入例: `7 22` / 最終段階は `23 -1`\n空欄: 既存値維持（新規フェーズは空欄不可）\n対象: 1段階目〜2段階目",
    );
    expect(renderBossInfoHpPrompt(config, 1, 0)).toBe(
      "2ボス HP入力 1/1\n入力形式: 各段階ごとに正の整数\n記入例: `5600`\n空欄: 既存値維持（新規フェーズは空欄不可）\n対象: 1段階目〜2段階目",
    );
    expect(renderBossInfoConfirmText(config, "default")).toContain("入力が完了しました。保存前プレビュー:");
    expect(renderBossInfoSavedText(config, 3)).toContain("備考: この guild の管理カテゴリ数=3。");
  });

  it("renders bossinfo_show text with json preview", () => {
    const message = renderBossInfoShowMessage(ClanBattleData.getDefaultConfig(), "default");

    expect(message).toContain("現在の bossinfo 設定 (default)");
    expect(message).toContain("```json");
    expect(message).toContain("\"phaseCount\": 3");
  });
});
