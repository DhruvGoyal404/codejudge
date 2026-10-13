/** Fields of one judge:events entry (all strings, as stored in the stream). */
export type EventPayload = Record<string, string>;

/**
 * In-process fan-out of judge:events entries to open SSE connections.
 * Status changes are nudges (listeners re-read Postgres); progress entries
 * (with a `stage`) are forwarded as-is.
 */
export class Hub {
  private listeners = new Map<string, Set<(e?: EventPayload) => void>>();

  subscribe(id: string, fn: (e?: EventPayload) => void): () => void {
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

  // Latest progress event per submission (progress is not stored in
  // Postgres), replayed to late SSE subscribers. Dropped when the submission
  // finishes; bounded so a lost "done" event can't grow it forever.
  private lastProgress = new Map<string, EventPayload>();
  private static readonly MAX_TRACKED = 10_000;

  publish(id: string, e?: EventPayload): void {
    if (e?.stage) {
      this.lastProgress.delete(id);
      this.lastProgress.set(id, e);
      if (this.lastProgress.size > Hub.MAX_TRACKED) {
        this.lastProgress.delete(this.lastProgress.keys().next().value!);
      }
    } else if (e?.status === "done") {
      this.lastProgress.delete(id);
    }
    for (const fn of this.listeners.get(id) ?? []) fn(e);
  }

  latestProgress(id: string): EventPayload | undefined {
    return this.lastProgress.get(id);
  }

  get size(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
