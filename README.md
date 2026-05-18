# clanbattle-management-ts-sample

Discord サーバーでクランバトルの進行管理を行う TypeScript 製 Bot のサンプル実装です。
スラッシュコマンド、リアクション、メッセージイベントを使って、メンバー管理、凸状況、ボス情報、持越し、進捗表示などを扱います。

## Features

- Discord スラッシュコマンドの登録
- SQLite による実行時データの保存
- クラン設定、メンバー、凸状況、ボス情報の管理
- 進捗メッセージ、残凸メッセージ、サマリー表示の更新
- ローカルログ出力
- TypeScript / Vitest による型チェックとテスト

## Tech Stack

- TypeScript
- Node.js
- discord.js
- SQLite via `better-sqlite3`
- Vitest
- ESLint

## Requirements

- Node.js `24.14.0`
- npm `11.9.0`
- Discord Bot token
- Bot を追加できる Discord サーバー

Discord Developer Portal で、Bot に必要な Intent を有効にしてください。

- `GuildMembers`
- `MessageContent`

## Setup

依存関係をインストールします。

```bash
npm install
```

`.env.example` をコピーして `.env` を作成します。

```bash
cp .env.example .env
```

Windows PowerShell の場合:

```powershell
Copy-Item .env.example .env
```

`.env` に Discord Bot token とテスト用サーバーの guild id を設定します。

```env
DISCORD_TOKEN=replace-me
DB_PATH=./staging.sqlite3
GUILD_IDS=123456789012345678
LOG_DIR=logs
LOG_LEVEL=info
DEBUG=false
NODE_ENV=development
```

`GUILD_IDS` を設定すると、そのサーバー向けにコマンドが登録されるため、開発中の反映が速くなります。空にするとグローバルコマンド登録になります。

## Usage

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

Lint:

```bash
npm run lint
```

ビルド:

```bash
npm run build
```

ビルド後の実行:

```bash
node dist/index.js
```

## Commands

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

## Security Notes

次のファイルやディレクトリは公開リポジトリにコミットしないでください。

- `.env`
- Discord Bot token
- 実運用の SQLite database
- `logs/`
- `node_modules/`
- `dist/`

`.env.example` にはダミー値のみを置いています。実際の token や guild id は `.env` にだけ設定してください。

## Project Notes

このリポジトリは公開サンプルとして使いやすいように、本番デプロイ設定や実運用データを含めていません。必要に応じて、利用する環境に合わせたデプロイ手順や運用ドキュメントを追加してください。
