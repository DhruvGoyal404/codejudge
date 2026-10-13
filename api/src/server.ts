import { pino } from "pino";

import { createApp, sweepOnce } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Hub } from "./hub.ts";
import { Queue } from "./queue.ts";

const config = loadConfig(); // fails fast with a readable message on bad env
const log = pino({ level: config.LOG_LEVEL });
const db = Db.connect(config.CODEJUDGE_DATABASE_URL, config.PG_POOL_MAX);
const queue = Queue.connect(config.CODEJUDGE_VALKEY_URL, config.SUBMISSIONS_STREAM);
const hub = new Hub();

await db.ping();
await queue.ping();

const app = createApp({ db, queue, hub, config, log });
const server = app.listen(config.PORT, config.HOST, () => {
  log.info({ host: config.HOST, port: config.PORT }, "api listening");
});

const sweeper = setInterval(() => {
  sweepOnce({ db, queue, config, log }).catch((err) => log.error({ err }, "sweep failed"));
}, config.SWEEP_INTERVAL_MS);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  clearInterval(sweeper);
  server.close();
  server.closeAllConnections(); // ends open SSE streams
  await Promise.allSettled([db.close(), queue.close()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
