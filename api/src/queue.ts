import { Redis } from "ioredis";

/** Valkey Streams producer for judge work. */
export class Queue {
  constructor(
    readonly redis: Redis,
    readonly submissionsStream: string,
    readonly runsStream = "judge:runs",
  ) {}

  static connect(url: string, submissionsStream: string, runsStream?: string): Queue {
    const redis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
    return new Queue(redis, submissionsStream, runsStream);
  }

  /** XADD {id} to the custom-run stream. */
  async enqueueRun(id: string): Promise<void> {
    await this.redis.xadd(this.runsStream, "MAXLEN", "~", "10000", "*", "id", id);
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  /** XADD {id} to the submissions stream (approximately capped). */
  async enqueue(id: string): Promise<string> {
    const entry = await this.redis.xadd(this.submissionsStream, "MAXLEN", "~", "100000", "*", "id", id);
    if (!entry) throw new Error("XADD returned no id");
    return entry;
  }

  /** Whether the stream still holds this entry (it may have been trimmed or the stream lost). */
  async hasEntry(entryId: string): Promise<boolean> {
    return (await this.redis.xrange(this.submissionsStream, entryId, entryId)).length > 0;
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
