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

この Bot は次のスラッシュコマンドを登録します。

| Command | Description |
| --- | --- |
| `/setup` | 管理用チャンネルをセットアップします。 |
| `/add` | 凸管理対象のメンバーを追加します。 |
| `/remove` | 凸管理対象のメンバーを削除します。 |
| `/lap` | 周回数や対象ボスを変更します。 |
| `/attack_declare` | メンバーの凸宣言を登録します。 |
| `/attack_fin` | メンバーの凸完了を登録します。 |
| `/defeat_boss` | ボス討伐を登録します。 |
| `/undo` | 直近の操作を取り消します。 |
| `/resend` | 進行用メッセージを再送します。 |
| `/time` | オーバーキル時の持越し時間を計算します。 |
| `/tl` | 持越秒数に合わせてTL時刻を変換します。 |
| `/bossinfo_show` | サーバーごとのボスHP/段階設定を表示します。 |
| `/bossinfo_export_json` | ボスHP/段階設定をJSONで出力します。 |
| `/bossinfo_edit` | ボスHP/段階設定をウィザードで編集します。 |
| `/adjust_remain_attack_count` | メンバーの残凸数を直接修正します。 |
| `/correct_attack_kind` | 自分の攻撃の本戦・持越区分を入れ替えます。 |
| `/admin_correct_attack_kind` | メンバー指定で攻撃の本戦・持越区分を入れ替えます。 |

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
