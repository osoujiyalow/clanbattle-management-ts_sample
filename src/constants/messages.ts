export const COMMAND_DESCRIPTIONS = {
  add: "凸管理するメンバーを追加します。オプションがない場合、コマンドを実行した人が追加されます。",
  remove:
    "凸管理するメンバーを削除します。オプションがない場合、コマンドを実行した人が削除されます。",
  setup: "凸管理のセットアップを実施します。",
  bossinfoShow: "サーバーごとのボスHP/段階設定を表示します。",
  bossinfoExportJson: "このサーバーのボスHP/段階設定をJSONで出力します。",
  bossinfoEdit: "サーバーごとのボスHP/段階設定をウィザードで編集します。",
  lap: "周回数を変更します",
  attackDeclare: "ボスに凸宣言した時の処理を実施します",
  attackFin: "ボスに凸した時の処理を実施します。",
  defeatBoss: "ボスを討伐した時の処理を実施します。",
  undo: "元に戻す処理を実施します。",
  resendProgressMessage: "進行用のメッセージを再送します。",
  calcCot: "オーバーキルでの持越し時間を計算します",
} as const;

export const OPTION_DESCRIPTIONS = {
  calcCot: {
    values:
      "先頭にボスHP、その後にダメージを半角スペース区切りで入力 例: 1200000 300000 450000 600000",
  },
} as const;

export const USER_MESSAGES = {
  errors: {
    commandExecutionFailed: "コマンド実行中にエラーが発生しました。",
    categoryRequired: "凸管理を行うカテゴリーチャンネル内で実行してください",
    bossNumberRequired: "ボス番号を指定してください",
    invalidBossNumber: "ボス番号が不適です。1から5までの整数を指定してください。",
    invalidLap: "不正な周回数です",
    invalidAttackType: "攻撃種別が不正です。物理・魔法・持ち越しから選択してください。",
  },
  setup: {
    started: "チャンネルのセットアップを実施します",
    completed: "セットアップが完了しました",
    missingPermission: "チャンネル作成の権限を付与してください。",
  },
  bossinfo: {
    exportJsonCompleted: "現在の guild bossinfo 設定を JSON で出力しました。",
    sessionMissing:
      "編集セッションが見つかりません。もう一度 `/bossinfo_edit` から開始してください。",
    cancelled: "bossinfo 編集ウィザードをキャンセルしました。",
    savedPrefix: "bossinfo 設定を保存しました (SQLite)。",
  },
  calcCot: {
    invalidFormat:
      "入力形式が不正です。\n先頭にボスHP、その後にダメージを半角スペース区切りで入力してください。\n例: `1200000 300000 450000 600000`",
    nonNumeric: "数値以外が含まれています。半角数字をスペース区切りで入力してください。",
    nonPositive:
      "すべて 1 以上の整数で入力してください（ボスHP/ダメージともに正の整数）。",
    notKilledPrefix: "入力されたダメージ合計ではボスを倒しきれていません。",
    successHeader: "オーバーキル持越し時間を計算しました。",
  },
} as const;
