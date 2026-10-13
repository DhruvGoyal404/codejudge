/**
 * In-process fan-out of "submission changed" notifications to open SSE
 * connections. The payload is only a nudge: listeners re-read the
 * authoritative state from Postgres.
 */
export class Hub {
  private listeners = new Map<string, Set<() => void>>();

  subscribe(id: string, fn: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  publish(id: string): void {
    for (const fn of this.listeners.get(id) ?? []) fn();
  }

  get size(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
