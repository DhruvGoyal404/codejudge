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
    let lastId = "$"; // only events after startup; SSE handlers read current state from the DB
    while (!this.stopped) {
      try {
        const res = await this.redis.xread("BLOCK", this.blockMs, "STREAMS", this.stream, lastId);
        for (const [, entries] of res ?? []) {
          for (const [entryId, fields] of entries) {
            lastId = entryId;
            const i = fields.indexOf("id");
            const id = i >= 0 ? fields[i + 1] : undefined;
            if (id) this.hub.publish(id);
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
