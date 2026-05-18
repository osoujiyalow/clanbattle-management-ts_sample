# Operations

This public sample is intended for local development and Discord test servers.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Set `DISCORD_TOKEN` to a test bot token.
3. Set `GUILD_IDS` to a test server id for fast slash command registration.
4. Run `npm run dev`.

Do not commit `.env`, local SQLite files, logs, `dist/`, or `node_modules/`.

## Discord Developer Portal

Enable the privileged intents required by the bot:

- `GuildMembers`
- `MessageContent`

The bot also uses reaction and message events, so verify the application settings before testing in a server.

## Database

The bot stores runtime state in SQLite through `better-sqlite3`.

For development, keep `DB_PATH` pointed at a disposable local database such as `./staging.sqlite3`.
