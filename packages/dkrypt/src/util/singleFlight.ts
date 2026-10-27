export class SingleFlight<K, V> {
  private readonly pending = new Map<K, Promise<V>>();

  run(key: K, operation: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(operation);
    this.pending.set(key, pending);
    void pending.finally(() => {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }).catch(() => {});
    return pending;
  }

  get size(): number {
    return this.pending.size;
  }
}
