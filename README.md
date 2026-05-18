# clanbattle-management-ts-sample

Discord のクランバトル管理 Bot 用 TypeScript サンプルです。
移植元で動いている実装を、公開 GitHub に載せられる形へ整えたものです。

このプロジェクトでは次を使用しています。

- TypeScript
- discord.js
- SQLite via `better-sqlite3`

## 公開前の注意

- `.env`、Discord Bot token、実運用の SQLite DB、`logs/`、`node_modules/`、`dist/` はコミットしないでください。
- `.env.example` にはダミー値だけを置いています。実際の token や guild id は `.env` にだけ入れてください。
- GitHub Actions などの本番デプロイ設定は、この公開サンプルには含めない方針です。

## できること

- Discord のスラッシュコマンドを登録する
- 実行時データを SQLite に保存する
- クラン設定、メンバー、凸状況、ボス情報を管理する
- ログをローカルの `logs/` ディレクトリに出力する
- 移植元と同じテストを実行して、主要動作を確認する

## 動作要件

- Node.js `24.14.0`
- npm `11.9.0`
- Discord Bot のトークン
- テスト用の Discord サーバー

## セットアップ

1. 依存関係をインストールします。

```bash
npm install
```

2. ローカル用の `.env` を作成します。

```bash
cp .env.example .env
```

Windows PowerShell の場合:

```powershell
Copy-Item .env.example .env
```

3. `.env` を編集し、最低限次を設定します。

- `DISCORD_TOKEN`
- `GUILD_IDS`

開発用の例:

```env
DISCORD_TOKEN=replace-me
DB_PATH=./staging.sqlite3
GUILD_IDS=123456789012345678
LOG_DIR=logs
LOG_LEVEL=info
DEBUG=false
NODE_ENV=development
```

## 実行方法

開発実行:

```bash
npm run dev
```

型チェック:

```bash
npm run typecheck
```

テスト:

```bash
npm test
```

ビルド:

```bash
npm run build
```

ビルド後の実行:

```bash
node dist/index.js
```

## 主なコマンド

- `/setup`
- `/add`
- `/remove`
- `/lap`
- `/attack_declare`
- `/attack_fin`
- `/defeat_boss`
- `/undo`
- `/resend`
- `/bossinfo_show`
- `/bossinfo_export_json`
- `/bossinfo_edit`
- `/calc_cot`

## 補足

- `.env`、`logs/`、`node_modules/`、`dist/`、ローカルの SQLite ファイルは `.gitignore` で除外されています。
- `GUILD_IDS` を設定すると、そのギルド向けにコマンド登録されるため、開発時の反映が速くなります。
- `GUILD_IDS` を空にするとグローバルコマンド登録になり、反映まで時間がかかることがあります。
- この Bot はメッセージイベントとリアクションイベントを使うため、Discord Developer Portal 側で必要な Intent を有効化してください。
