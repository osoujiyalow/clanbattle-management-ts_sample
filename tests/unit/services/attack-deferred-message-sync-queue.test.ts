import { describe, expect, it, vi } from "vitest";

import {
  AttackDeferredMessageSyncQueue,
  type DeferredNonProgressSyncJob,
} from "../../../src/services/attack-deferred-message-sync-queue.js";
import type { Logger } from "../../../src/shared/logger.js";

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("AttackDeferredMessageSyncQueue", () => {
  it("keeps only the latest pending request while preserving required surface updates", async () => {
    vi.useFakeTimers();

    let releaseFirstRun: (() => void) | null = null;
    const executedJobs: Array<DeferredNonProgressSyncJob<{ label: string }>> = [];
    const queue = new AttackDeferredMessageSyncQueue({
      logger: NOOP_LOGGER,
      run: async (_categoryId, job) => {
        executedJobs.push(job);

        if (job.request.label === "first") {
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
        }
      },
    });

    queue.schedule("category-1", {
      request: { label: "first" },
      updateSummary: true,
      updateRemainAttack: false,
    });
    await vi.runOnlyPendingTimersAsync();

    queue.schedule("category-1", {
      request: { label: "second" },
      updateSummary: true,
      updateRemainAttack: true,
    });
    queue.schedule("category-1", {
      request: { label: "third" },
      updateSummary: true,
      updateRemainAttack: false,
    });

    expect(executedJobs).toHaveLength(1);
    expect(executedJobs[0]?.request.label).toBe("first");

    releaseFirstRun?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(executedJobs).toHaveLength(2);
    expect(executedJobs[1]).toEqual({
      request: { label: "third" },
      updateSummary: true,
      updateRemainAttack: true,
    });

    vi.useRealTimers();
  });
});
