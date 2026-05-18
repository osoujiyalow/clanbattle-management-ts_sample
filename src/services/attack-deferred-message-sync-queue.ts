import type { Logger } from "../shared/logger.js";

export interface DeferredNonProgressSyncJob<TRequest> {
  request: TRequest;
  updateSummary: boolean;
  updateRemainAttack: boolean;
}

interface QueueState<TRequest> {
  running: boolean;
  pending: DeferredNonProgressSyncJob<TRequest> | null;
}

export interface AttackDeferredMessageSyncQueueOptions<TRequest> {
  logger: Logger;
  run: (categoryId: string, job: DeferredNonProgressSyncJob<TRequest>) => Promise<void>;
}

function mergeJobs<TRequest>(
  current: DeferredNonProgressSyncJob<TRequest>,
  next: DeferredNonProgressSyncJob<TRequest>,
): DeferredNonProgressSyncJob<TRequest> {
  return {
    request: next.request,
    updateSummary: current.updateSummary || next.updateSummary,
    updateRemainAttack: current.updateRemainAttack || next.updateRemainAttack,
  };
}

export class AttackDeferredMessageSyncQueue<TRequest> {
  private readonly stateByCategory = new Map<string, QueueState<TRequest>>();

  constructor(private readonly options: AttackDeferredMessageSyncQueueOptions<TRequest>) {}

  schedule(categoryId: string, job: DeferredNonProgressSyncJob<TRequest>): void {
    const state = this.stateByCategory.get(categoryId) ?? {
      running: false,
      pending: null,
    };

    state.pending = state.pending ? mergeJobs(state.pending, job) : job;
    this.stateByCategory.set(categoryId, state);

    if (state.running) {
      return;
    }

    state.running = true;
    setTimeout(() => {
      void this.drain(categoryId);
    }, 0);
  }

  private async drain(categoryId: string): Promise<void> {
    const state = this.stateByCategory.get(categoryId);
    if (!state) {
      return;
    }

    while (state.pending) {
      const job = state.pending;
      state.pending = null;

      try {
        await this.options.run(categoryId, job);
      } catch (error) {
        this.options.logger.warn("Deferred non-progress message sync failed", {
          categoryId,
          updateSummary: job.updateSummary,
          updateRemainAttack: job.updateRemainAttack,
          error,
        });
      }
    }

    state.running = false;
    if (!state.pending) {
      this.stateByCategory.delete(categoryId);
    }
  }
}
