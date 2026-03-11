import { pathToFileURL } from "node:url";

import { createRuntimeConfig } from "./config/runtime.js";
import { registerAttackCommandHandlers } from "./discord/command-handlers/attack.js";
import { registerBossInfoCommandHandlers } from "./discord/command-handlers/bossinfo.js";
import { registerMemberCommandHandlers } from "./discord/command-handlers/member.js";
import { registerQueryCommandHandlers } from "./discord/command-handlers/query.js";
import { registerSetupCommandHandlers } from "./discord/command-handlers/setup.js";
import { createMessageCreateHandler } from "./discord/event-handlers/message-create.js";
import { createReactionAddHandler } from "./discord/event-handlers/reaction-add.js";
import { createReactionRemoveHandler } from "./discord/event-handlers/reaction-remove.js";
import { bootstrapDiscordRuntime } from "./discord/client.js";
import { InteractionRouter } from "./discord/interaction-router.js";
import { ensureCoreSchema } from "./repositories/sqlite/core-schema.js";
import { openSqliteDatabase } from "./repositories/sqlite/db.js";
import { GuildBossInfoRepository } from "./repositories/sqlite/guild-bossinfo-repository.js";
import { AttackService } from "./services/attack-service.js";
import { BossInfoService } from "./services/bossinfo-service.js";
import { ClanQueryService } from "./services/clan-query-service.js";
import { ClanSetupService } from "./services/clan-setup-service.js";
import { MemberService } from "./services/member-service.js";
import { ProgressMessageService } from "./services/progress-message-service.js";
import { RuntimeStateService } from "./services/runtime-state-service.js";
import { createLogger } from "./shared/logger.js";

function hasCoreSchema(database: ReturnType<typeof openSqliteDatabase>): boolean {
  const row = database
    .prepare<[], { count: bigint }>(
      "select count(*) as count from sqlite_master where type='table' and name='ClanData'",
    )
    .get();
  return (row?.count ?? 0n) > 0n;
}

export async function bootstrap(): Promise<void> {
  const runtimeConfig = createRuntimeConfig();
  const logger = createLogger({
    scope: "app",
    logDir: runtimeConfig.paths.logDir,
    minLevel: runtimeConfig.logging.level,
  });
  const database = openSqliteDatabase({
    filePath: runtimeConfig.paths.dbPath,
  });
  const runtimeStateService = new RuntimeStateService({
    database,
    logger,
  });

  if (!hasCoreSchema(database)) {
    ensureCoreSchema(database);
    logger.info("SQLite core schema was created.", {
      dbPath: runtimeConfig.paths.dbPath,
    });
  }

  runtimeStateService.restoreFromDatabase();

  const router = new InteractionRouter({
    logger,
  });
  const clanSetupService = new ClanSetupService({
    database,
    runtimeStateService,
  });
  const memberService = new MemberService({
    database,
    runtimeStateService,
  });
  const attackService = new AttackService({
    database,
    runtimeStateService,
    logger,
  });
  const progressMessageService = new ProgressMessageService({
    database,
    runtimeStateService,
    logger,
  });
  const clanQueryService = new ClanQueryService({
    database,
    runtimeStateService,
    logger,
  });
  const bossInfoService = new BossInfoService({
    runtimeStateService,
    guildBossInfoRepository: new GuildBossInfoRepository(database),
  });

  registerSetupCommandHandlers(router, { clanSetupService });
  registerMemberCommandHandlers(router, { memberService });
  registerQueryCommandHandlers(router, { clanQueryService });
  registerAttackCommandHandlers(router, { attackService, progressMessageService });
  registerBossInfoCommandHandlers(router, { bossInfoService });

  await bootstrapDiscordRuntime({
    runtimeConfig,
    logger,
    router,
    onMessageCreate: createMessageCreateHandler({
      attackService,
    }),
    onReactionAdd: createReactionAddHandler({
      runtimeStateService,
      attackService,
      memberService,
    }),
    onReactionRemove: createReactionRemoveHandler({
      runtimeStateService,
      memberService,
    }),
  });
}

const entry = process.argv[1];

if (entry && import.meta.url === pathToFileURL(entry).href) {
  void bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
