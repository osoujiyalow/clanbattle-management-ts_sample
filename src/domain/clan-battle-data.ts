import {
  DEFAULT_BOSSINFO_CONFIG,
  DEFAULT_BOSS_NAMES,
  MAX_PHASE_COUNT,
} from "../constants/bossinfo-defaults.js";
import { GuildBossInfoConfig } from "./guild-bossinfo-config.js";

export interface GuildBossInfoConfigRecord {
  phaseCount: number;
  boundaries: number[][];
  hp: number[][];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumberMatrix(value: unknown): number[][] {
  if (!Array.isArray(value)) {
    throw new ValueError("JSONには `hp` と `boundaries` が必要です。");
  }

  return value.map((row) => {
    if (!Array.isArray(row)) {
      throw new ValueError("JSONには `hp` と `boundaries` が必要です。");
    }

    return row.map((cell) => Number.parseInt(String(cell), 10));
  });
}

function toBoundaryMatrix(value: unknown): [number, number][] {
  if (!Array.isArray(value)) {
    throw new ValueError("JSONには `hp` と `boundaries` が必要です。");
  }

  return value.map((row) => {
    if (!Array.isArray(row) || row.length < 2) {
      throw new ValueError("JSONには `hp` と `boundaries` が必要です。");
    }

    return [Number.parseInt(String(row[0]), 10), Number.parseInt(String(row[1]), 10)];
  });
}

class ValueError extends Error {}

export class ClanBattleData {
  static readonly MAX_PHASE_COUNT = MAX_PHASE_COUNT;
  static readonly bossNames = [...DEFAULT_BOSS_NAMES];

  private static guildBossInfoConfig = new Map<string, GuildBossInfoConfig>();

  static getDefaultConfig(): GuildBossInfoConfig {
    return new GuildBossInfoConfig(DEFAULT_BOSSINFO_CONFIG);
  }

  static getGuildConfig(guildId?: string | null): GuildBossInfoConfig {
    if (!guildId) {
      return this.getDefaultConfig();
    }

    const config = this.guildBossInfoConfig.get(guildId);
    return config ? config.copy() : this.getDefaultConfig();
  }

  static hasGuildConfig(guildId: string): boolean {
    return this.guildBossInfoConfig.has(guildId);
  }

  static setGuildConfig(guildId: string, config: GuildBossInfoConfig): void {
    this.guildBossInfoConfig.set(guildId, config.copy());
  }

  static deleteGuildConfig(guildId: string): void {
    this.guildBossInfoConfig.delete(guildId);
  }

  static loadGuildConfigMap(
    configMap: ReadonlyMap<string, GuildBossInfoConfig> | Readonly<Record<string, GuildBossInfoConfig>>,
  ): void {
    const nextMap = new Map<string, GuildBossInfoConfig>();

    if (configMap instanceof Map) {
      for (const [guildId, config] of configMap.entries()) {
        nextMap.set(guildId, config.copy());
      }
    } else {
      for (const [guildId, config] of Object.entries(configMap)) {
        nextMap.set(guildId, config.copy());
      }
    }

    this.guildBossInfoConfig = nextMap;
  }

  static getHp(lap: number, bossIndex: number, guildId?: string | null): number {
    const config = this.getGuildConfig(guildId);

    for (let phaseIndex = 0; phaseIndex < config.boundaries.length; phaseIndex += 1) {
      const [lapFrom, lapTo] = config.boundaries[phaseIndex]!;
      if ((lapFrom <= lap && lap <= lapTo) || (lapFrom <= lap && lapTo === -1)) {
        return config.hp[phaseIndex]![bossIndex]!;
      }
    }

    return config.hp[config.hp.length - 1]![bossIndex]!;
  }

  static validateConfig(
    hp: readonly (readonly number[])[],
    boundaries: readonly (readonly [number, number])[],
  ): GuildBossInfoConfig {
    if (boundaries.length === 0) {
      throw new Error("フェーズは1つ以上必要です。");
    }

    if (boundaries.length > this.MAX_PHASE_COUNT) {
      throw new Error(`フェーズ数は${this.MAX_PHASE_COUNT}以下にしてください。`);
    }

    if (hp.length !== boundaries.length) {
      throw new Error("HP段階数と境界段階数が一致していません。");
    }

    const normalizedHp = hp.map((phaseHp, phaseIndex) => {
      if (phaseHp.length !== 5) {
        throw new Error(`${phaseIndex + 1}段階目のHPは5ボス分必要です。`);
      }

      return phaseHp.map((value, bossIndex) => {
        const intValue = Number.parseInt(String(value), 10);
        if (intValue <= 0) {
          throw new Error(
            `${phaseIndex + 1}段階目 ${bossIndex + 1}ボスHPは正の整数で入力してください。`,
          );
        }
        return intValue;
      });
    });

    let previousEnd: number | null = null;
    const normalizedBoundaries = boundaries.map((boundary, phaseIndex) => {
      const [start, end] = boundary;
      const startValue = Number.parseInt(String(start), 10);
      const endValue = Number.parseInt(String(end), 10);

      if (startValue <= 0) {
        throw new Error(`${phaseIndex + 1}段階目の開始周は1以上で入力してください。`);
      }

      if (endValue !== -1 && endValue < startValue) {
        throw new Error(`${phaseIndex + 1}段階目の終了周は開始周以上、または -1 です。`);
      }

      if (previousEnd !== null) {
        if (previousEnd === -1) {
          throw new Error("最終段階(-1)の後ろに段階を追加できません。");
        }

        if (startValue !== previousEnd + 1) {
          throw new Error(
            `${phaseIndex + 1}段階目の開始周は前段階の終了周+1 (${previousEnd + 1}) にしてください。`,
          );
        }
      }

      if (phaseIndex < boundaries.length - 1 && endValue === -1) {
        throw new Error("途中段階の終了周に -1 は使えません。");
      }

      previousEnd = endValue;
      return [startValue, endValue] as [number, number];
    });

    return new GuildBossInfoConfig({
      hp: normalizedHp,
      boundaries: normalizedBoundaries,
    });
  }

  static configToDict(config: GuildBossInfoConfig): GuildBossInfoConfigRecord {
    return {
      phaseCount: config.boundaries.length,
      boundaries: config.boundaries.map(([start, end]) => [start, end]),
      hp: config.hp.map((row) => [...row]),
    };
  }

  static configToJson(config: GuildBossInfoConfig): string {
    return JSON.stringify(this.configToDict(config), null, 2);
  }

  static configFromJsonText(jsonText: string): GuildBossInfoConfig {
    let payload: unknown;

    try {
      payload = JSON.parse(jsonText);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`JSONの解析に失敗しました: ${error.message}`);
      }

      throw error;
    }

    if (!isObjectRecord(payload)) {
      throw new Error("JSONのトップレベルはオブジェクト形式にしてください。");
    }

    if (!("hp" in payload) || !("boundaries" in payload)) {
      throw new Error("JSONには `hp` と `boundaries` が必要です。");
    }

    try {
      return this.validateConfig(toNumberMatrix(payload.hp), toBoundaryMatrix(payload.boundaries));
    } catch (error) {
      if (error instanceof ValueError) {
        throw new Error(error.message);
      }

      throw error;
    }
  }
}
