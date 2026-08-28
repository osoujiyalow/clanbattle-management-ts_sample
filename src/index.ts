import { pathToFileURL } from "node:url";

import { createRuntimeConfig } from "./config/runtime.js";
import { ActiveAttackerRoleSyncService } from "./discord/active-attacker-role-sync.js";
import { registerAgentCommandHandlers } from "./discord/command-handlers/agent.js";
import { registerAttackCommandHandlers } from "./discord/command-handlers/attack.js";
import { registerBossInfoCommandHandlers } from "./discord/command-handlers/bossinfo.js";
import { registerHpChangeCommandHandlers } from "./discord/command-handlers/hp-change.js";
import { registerMemberCommandHandlers } from "./discord/command-handlers/member.js";
import { registerQueryCommandHandlers } from "./discord/command-handlers/query.js";
import { registerSetupCommandHandlers } from "./discord/command-handlers/setup.js";
import { registerTlCommandHandlers } from "./discord/command-handlers/tl.js";
import { createMessageCreateHandler } from "./discord/event-handlers/message-create.js";
import { createReactionAddHandler } from "./discord/event-handlers/reaction-add.js";
import { createReactionRemoveHandler } from "./discord/event-handlers/reaction-remove.js";
import {
  bootstrapDiscordRuntime,
  createDiscordOrphanedCategoryScanClassifier,
} from "./discord/client.js";
import { InteractionRouter } from "./discord/interaction-router.js";
import { resyncStartupMessageSurfaces } from "./discord/startup-message-surface-resync.js";
import { ensureCoreSchema } from "./repositories/sqlite/core-schema.js";
import { openSqliteDatabase } from "./repositories/sqlite/db.js";
import { GuildBossInfoRepository } from "./repositories/sqlite/guild-bossinfo-repository.js";
import { AttackService } from "./services/attack-service.js";
import { BossInfoService } from "./services/bossinfo-service.js";
import { ClanQueryService } from "./services/clan-query-service.js";
import { ClanSetupService } from "./services/clan-setup-service.js";
import { HpChangeService } from "./services/hp-change-service.js";
import { MemberService } from "./services/member-service.js";
import { ProgressMessageService } from "./services/progress-message-service.js";
import { RuntimeStateService } from "./services/runtime-state-service.js";
import { TlConversionService } from "./services/tl-conversion-service.js";
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
  const activeAttackerRoleSyncService = new ActiveAttackerRoleSyncService({
    database,
    runtimeStateService,
    logger,
  });

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
  const hpChangeService = new HpChangeService({
    database,
    runtimeStateService,
    logger,
  });
  const tlConversionService = new TlConversionService();

  registerSetupCommandHandlers(router, { clanSetupService });
  registerMemberCommandHandlers(router, {
    memberService,
    runtimeStateService,
  });
  registerQueryCommandHandlers(router, {
    clanQueryService,
    memberService,
    runtimeStateService,
  });
  registerAgentCommandHandlers(router, {
    attackService,
    runtimeStateService,
  });
  registerAttackCommandHandlers(router, {
    attackService,
    progressMessageService,
    runtimeStateService,
    memberService,
  });
  registerBossInfoCommandHandlers(router, { bossInfoService });
  registerHpChangeCommandHandlers(router, {
    hpChangeService,
    runtimeStateService,
  });
  registerTlCommandHandlers(router, { tlConversionService });

  await bootstrapDiscordRuntime({
    runtimeConfig,
    logger,
    router,
    onReady: async (client) => {
      activeAttackerRoleSyncService.bindClient(client);
      const scanReport = await runtimeStateService.scanOrphanedCategories(
        createDiscordOrphanedCategoryScanClassifier(client),
      );
      await resyncStartupMessageSurfaces({
        client,
        logger,
        runtimeStateService,
        memberService,
        scanReport,
      });
    },
    onMessageCreate: createMessageCreateHandler({
      attackService,
      memberService,
      runtimeStateService,
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
