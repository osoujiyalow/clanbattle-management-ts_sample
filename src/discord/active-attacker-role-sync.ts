import { DiscordAPIError, type Client, type Guild, type Role } from "discord.js";

import { ActiveAttackerRoleRepository } from "../repositories/sqlite/active-attacker-role-repository.js";
import type { SqliteDatabase } from "../repositories/sqlite/db.js";
import type { Logger } from "../shared/logger.js";
import { type Clock, now, systemClock } from "../shared/time.js";
import type { RuntimeStateService } from "../services/runtime-state-service.js";

export const ACTIVE_ATTACKER_ROLE_NAME = "残凸・持越あり";
const DEFAULT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const ROLE_REASON = "ハンナボットの残凸・持越メンション管理";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface ActiveAttackerRoleSnapshot {
  roleId: string;
  memberIds: ReadonlySet<string>;
}

export type ActiveAttackerRoleMemberUpdateResult = "updated" | "member-missing";

export interface ActiveAttackerRoleGateway {
  ensureRole(
    guildId: string,
    configuredRoleId: string | null,
  ): Promise<ActiveAttackerRoleSnapshot>;
  updateMemberRole(
    guildId: string,
    roleId: string,
    userId: string,
    assigned: boolean,
  ): Promise<ActiveAttackerRoleMemberUpdateResult>;
}

function isUnknownMemberError(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10_007;
}

export class DiscordActiveAttackerRoleGateway implements ActiveAttackerRoleGateway {
  constructor(private readonly client: Client) {}

  private async resolveGuild(guildId: string): Promise<Guild> {
    return this.client.guilds.cache.get(guildId) ?? this.client.guilds.fetch(guildId);
  }

  private async resolveConfiguredRole(
    guild: Guild,
    configuredRoleId: string | null,
  ): Promise<Role | null> {
    if (!configuredRoleId) {
      return null;
    }

    return guild.roles.fetch(configuredRoleId);
  }

  async ensureRole(
    guildId: string,
    configuredRoleId: string | null,
  ): Promise<ActiveAttackerRoleSnapshot> {
    const guild = await this.resolveGuild(guildId);
    const configuredRole = await this.resolveConfiguredRole(guild, configuredRoleId);
    const role =
      configuredRole ??
      (await guild.roles.create({
        name: ACTIVE_ATTACKER_ROLE_NAME,
        mentionable: true,
        reason: ROLE_REASON,
      }));
    const members = await guild.members.fetch();

    return {
      roleId: role.id,
      memberIds: new Set(
        members
          .filter((member) => member.roles.cache.has(role.id))
          .map((member) => member.id),
      ),
    };
  }

  async updateMemberRole(
    guildId: string,
    roleId: string,
    userId: string,
    assigned: boolean,
  ): Promise<ActiveAttackerRoleMemberUpdateResult> {
    const guild = await this.resolveGuild(guildId);
    let member;
    try {
      member = await guild.members.fetch(userId);
    } catch (error) {
      if (isUnknownMemberError(error)) {
        return "member-missing";
      }
      throw error;
    }

    if (assigned) {
      await member.roles.add(roleId, ROLE_REASON);
    } else {
      await member.roles.remove(roleId, ROLE_REASON);
    }
    return "updated";
  }
}

export interface ActiveAttackerRoleSyncServiceOptions {
  database: SqliteDatabase;
  runtimeStateService: RuntimeStateService;
  roleRepository?: ActiveAttackerRoleRepository;
  gateway?: ActiveAttackerRoleGateway;
  logger?: Logger;
  clock?: Clock;
  retryCooldownMs?: number;
}

export class ActiveAttackerRoleSyncService {
  private gateway: ActiveAttackerRoleGateway | null;
  private readonly roleRepository: ActiveAttackerRoleRepository;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly retryCooldownMs: number;
  private readonly queuedCategories = new Set<string>();
  private readonly runningByCategory = new Map<string, Promise<void>>();
  private readonly appliedEligibilityByCategory = new Map<string, Map<string, boolean>>();
  private readonly syncedDayByCategory = new Map<string, string>();
  private readonly retryAfterByCategory = new Map<string, number>();

  constructor(private readonly options: ActiveAttackerRoleSyncServiceOptions) {
    this.gateway = options.gateway ?? null;
    this.roleRepository =
      options.roleRepository ?? new ActiveAttackerRoleRepository(options.database);
    this.logger = options.logger ?? NOOP_LOGGER;
    this.clock = options.clock ?? systemClock;
    this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
    options.runtimeStateService.subscribeCategoryStateChanges((categoryId) => {
      this.schedule(categoryId);
    });
  }

  bindClient(client: Client): void {
    this.gateway = new DiscordActiveAttackerRoleGateway(client);
  }

  schedule(categoryId: string): void {
    if (!this.gateway) {
      return;
    }

    this.queuedCategories.add(categoryId);
    if (this.runningByCategory.has(categoryId)) {
      return;
    }

    const run = Promise.resolve()
      .then(async () => {
        while (this.queuedCategories.delete(categoryId)) {
          await this.syncSafely(categoryId);
        }
      })
      .finally(() => {
        this.runningByCategory.delete(categoryId);
      });
    this.runningByCategory.set(categoryId, run);
  }

  async waitForIdle(categoryId: string): Promise<void> {
    await this.runningByCategory.get(categoryId);
  }

  private buildDesiredEligibility(categoryId: string): Map<string, boolean> {
    const clanData = this.options.runtimeStateService.get(categoryId);
    const desired = new Map<string, boolean>();
    if (!clanData) {
      return desired;
    }

    for (const playerData of clanData.playerDataMap.values()) {
      const resourceState = this.options.runtimeStateService.getPlayerResourceState(
        categoryId,
        playerData.userId,
        clanData.date,
      );
      const battleConsumedCount =
        resourceState?.battleConsumedCount ?? playerData.battleAttackCount;
      const remainingBattleCount = Math.max(
        0,
        playerData.battleAttackLimit - battleConsumedCount,
      );
      const remainingCarryCount = resourceState
        ? resourceState.carryAvailableCount + resourceState.carryReservedCount
        : playerData.carryOverList.length;
      desired.set(
        playerData.userId,
        remainingBattleCount > 0 || remainingCarryCount > 0,
      );
    }

    return desired;
  }

  private async syncSafely(categoryId: string): Promise<void> {
    const currentTime = now(this.clock).getTime();
    if ((this.retryAfterByCategory.get(categoryId) ?? 0) > currentTime) {
      return;
    }

    try {
      await this.syncCategory(categoryId);
      this.retryAfterByCategory.delete(categoryId);
    } catch (error) {
      this.appliedEligibilityByCategory.delete(categoryId);
      this.syncedDayByCategory.delete(categoryId);
      this.retryAfterByCategory.set(categoryId, currentTime + this.retryCooldownMs);
      this.logger.warn("Active attacker role sync failed; primary operation was preserved", {
        categoryId,
        retryCooldownMs: this.retryCooldownMs,
        error,
      });
    }
  }

  private async syncCategory(categoryId: string): Promise<void> {
    const gateway = this.gateway;
    const clanData = this.options.runtimeStateService.get(categoryId);
    if (!gateway || !clanData) {
      return;
    }

    const configuredRoleId = this.roleRepository.findRoleId(categoryId);
    const desired = this.buildDesiredEligibility(categoryId);
    if (!configuredRoleId && desired.size === 0) {
      return;
    }

    const requiresFullSync =
      !this.appliedEligibilityByCategory.has(categoryId) ||
      this.syncedDayByCategory.get(categoryId) !== clanData.date;
    let roleId = configuredRoleId;
    let applied = this.appliedEligibilityByCategory.get(categoryId);

    if (requiresFullSync) {
      const snapshot = await gateway.ensureRole(clanData.guildId, configuredRoleId);
      roleId = snapshot.roleId;
      if (roleId !== configuredRoleId) {
        this.roleRepository.upsert(categoryId, roleId);
      }
      applied = new Map(
        [...snapshot.memberIds].map((userId) => [userId, true] as const),
      );
      this.appliedEligibilityByCategory.set(categoryId, applied);
    }

    if (!roleId || !applied) {
      return;
    }

    const userIds = new Set([...desired.keys(), ...applied.keys()]);
    for (const userId of userIds) {
      const shouldHaveRole = desired.get(userId) ?? false;
      const hasRole = applied.get(userId) ?? false;
      if (shouldHaveRole === hasRole) {
        continue;
      }

      const result = await gateway.updateMemberRole(
        clanData.guildId,
        roleId,
        userId,
        shouldHaveRole,
      );
      if (result === "member-missing") {
        applied.delete(userId);
        this.logger.debug("Skipped active attacker role update for departed member", {
          categoryId,
          userId,
        });
        continue;
      }

      if (shouldHaveRole) {
        applied.set(userId, true);
      } else {
        applied.delete(userId);
      }
    }

    this.syncedDayByCategory.set(categoryId, clanData.date);
  }
}
