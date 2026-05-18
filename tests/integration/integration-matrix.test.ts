import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FakeDiscordGateway,
  FakeResponseChannel,
  FakeServiceMessage,
  FakeServiceTextChannel,
  createSnowflakeFactory,
} from "../helpers/fake-discord/service-gateway.js";
import { withIntegrationSqliteHarness } from "../helpers/temp-db/integration-sqlite.js";

type IntegrationScenario = {
  id: string;
  testFile: string;
  covers: string[];
};

type IntegrationMatrix = {
  schemaVersion: number;
  serviceScenarios: IntegrationScenario[];
  discordScenarios: IntegrationScenario[];
};

function readJson<T>(targetPath: string): T {
  return JSON.parse(readFileSync(targetPath, "utf8")) as T;
}

const integrationDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(integrationDir, "..", "..");
const matrixPath = path.join(repoRoot, "tests", "integration", "matrix.json");

describe("integration matrix", () => {
  const matrix = readJson<IntegrationMatrix>(matrixPath);

  it("keeps the integration coverage manifest aligned with existing test files", () => {
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.serviceScenarios.length).toBeGreaterThan(0);
    expect(matrix.discordScenarios.length).toBeGreaterThan(0);

    for (const scenario of [
      ...matrix.serviceScenarios,
      ...matrix.discordScenarios,
    ]) {
      expect(scenario.id.length).toBeGreaterThan(0);
      expect(scenario.covers.length).toBeGreaterThan(0);
      expect(existsSync(path.join(repoRoot, scenario.testFile))).toBe(true);
    }
  });

  it("exposes the required command, message, reaction, and bossinfo categories", () => {
    const ids = new Set(
      [...matrix.serviceScenarios, ...matrix.discordScenarios].map(
        (scenario) => scenario.id,
      ),
    );

    expect(ids.has("slash-basic")).toBe(true);
    expect(ids.has("slash-battle")).toBe(true);
    expect(ids.has("message-create")).toBe(true);
    expect(ids.has("reaction-handlers")).toBe(true);
    expect(ids.has("bossinfo-service")).toBe(true);
    expect(ids.has("bossinfo-wizard")).toBe(true);
  });

  it("provides a reusable temp sqlite harness with the core schema", async () => {
    await withIntegrationSqliteHarness(async (harness) => {
      const tables = harness.database
        .prepare<[], { name: string }>(
          "select name from sqlite_master where type = 'table' order by name",
        )
        .all()
        .map((row) => row.name);

      expect(harness.filePath.endsWith("test.sqlite3")).toBe(true);
      expect(tables).toEqual(
        expect.arrayContaining([
          "AttackStatus",
          "BossStatusData",
          "CarryOver",
          "ClanData",
          "PlayerData",
          "ProgressMessageIdData",
          "SummaryMessageIdData",
        ]),
      );
    });
  });

  it("provides a reusable fake Discord gateway for service-level integration tests", async () => {
    const nextId = createSnowflakeFactory();
    const gateway = new FakeDiscordGateway();
    const channel = new FakeServiceTextChannel("boss-1", nextId);
    const responseChannel = new FakeResponseChannel();

    gateway.registerChannel(channel);

    const sent = await channel.sendMessage({
      content: "progress",
      embeds: [{ toJSON: () => ({ title: "progress" }) }],
    });

    await sent.addReaction("⚔️");
    await sent.edit({
      embeds: [{ toJSON: () => ({ title: "updated" }) }],
    });
    await sent.delete();

    responseChannel.send({ content: "ok" });

    const fetched = await gateway.getTextChannel("boss-1");
    const fetchedMessage = await fetched.fetchMessage(sent.id);

    expect(fetched).toBe(channel);
    expect(fetchedMessage).toBe(sent);
    expect(sent.reactions).toEqual(["⚔️"]);
    expect(sent.edits).toEqual([{ embeds: [{ title: "updated" }] }]);
    expect(sent.deleted).toBe(true);
    expect(responseChannel.sentPayloads).toEqual([{ content: "ok" }]);
  });

  it("allows pre-seeded messages to be attached to fake channels", async () => {
    const channel = new FakeServiceTextChannel("summary");
    const seeded = new FakeServiceMessage("seeded");

    channel.attachMessage(seeded);

    await expect(channel.fetchMessage("seeded")).resolves.toBe(seeded);
  });
});
