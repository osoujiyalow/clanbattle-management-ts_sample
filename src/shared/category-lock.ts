type AsyncOperation<TResult> = () => TResult | Promise<TResult>;

export class CategoryLock {
  private readonly queueByCategory = new Map<string, Promise<void>>();

  get pendingCategoryCount(): number {
    return this.queueByCategory.size;
  }

  async run<TResult>(categoryId: string, operation: AsyncOperation<TResult>): Promise<TResult> {
    const previous = this.queueByCategory.get(categoryId) ?? Promise.resolve();
    const waitForTurn = previous.catch(() => undefined);

    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = waitForTurn.then(() => current);

    this.queueByCategory.set(categoryId, queued);

    await waitForTurn;

    try {
      return await operation();
    } finally {
      releaseCurrent?.();

      if (this.queueByCategory.get(categoryId) === queued) {
        this.queueByCategory.delete(categoryId);
      }
    }
  }
}
