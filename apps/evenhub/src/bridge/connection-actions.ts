/** Deliberate connection edits finish in order; a failed edit never blocks the next one. */
export class ConnectionActions {
  private tail: Promise<void> = Promise.resolve();
  run<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
