import { Redis } from "ioredis";
import type { Logger } from "pino";

import type { Hub } from "./hub.ts";

/**
 * Tails the judge:events stream (XREAD from "$", no consumer group: every API
 * instance must see every event to fan it out to its own SSE connections) and
 * nudges the hub. Events are hints; SSE handlers re-read Postgres.
 */
export class EventConsumer {
  private stopped = false;
  private running: Promise<void> | null = null;
  private readonly redis: Redis;
  private markReady!: () => void;
  /** Resolves once the consumer has a position in the stream: every later event is delivered. */
  readonly ready = new Promise<void>((r) => (this.markReady = r));

  constructor(
    url: string,
    private readonly stream: string,
    private readonly hub: Hub,
    private readonly log: Logger,
    private readonly blockMs = 5_000,
  ) {
    // Dedicated connection: XREAD BLOCK would stall every other command on a shared one.
    this.redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  start(): void {
    this.running ??= this.loop();
  }

  private async loop(): Promise<void> {
    // Only events after startup (SSE handlers read the current state from the
    // DB), but as a concrete id: re-issuing XREAD with "$" after each BLOCK
    // timeout would skip entries added between two reads.
    let lastId = "";
    while (!lastId && !this.stopped) {
      try {
        const tip = await this.redis.xrevrange(this.stream, "+", "-", "COUNT", 1);
        lastId = tip[0]?.[0] ?? "0-0";
      } catch (err) {
        if (this.stopped) return;
        this.log.warn({ err }, "event stream position failed; retrying");
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    this.markReady();
    while (!this.stopped) {
      try {
        const res = await this.redis.xread("BLOCK", this.blockMs, "STREAMS", this.stream, lastId);
        for (const [, entries] of res ?? []) {
          for (const [entryId, fields] of entries) {
            lastId = entryId;
            const e: Record<string, string> = {};
            for (let k = 0; k + 1 < fields.length; k += 2) e[fields[k]!] = fields[k + 1]!;
            if (e.id) this.hub.publish(e.id, e);
          }
        }
      } catch (err) {
        if (this.stopped) break;
        this.log.warn({ err }, "event stream read failed; retrying");
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.redis.disconnect(); // unblocks a pending XREAD
    await this.running?.catch(() => {});
  }
}
