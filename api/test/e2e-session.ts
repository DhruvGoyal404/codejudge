// Used by web/e2e global setup/teardown: `tsx test/e2e-session.ts create`
// prints {"userId":..,"token":".."} for a fresh test user with a session;
// `tsx test/e2e-session.ts delete <userId>` removes it. Talks to the dev
// database directly (same access the test suites already have); it is not an
// HTTP endpoint and is never part of the server.
import { Db } from "../src/db.ts";
import { createTestUser, deleteTestUsers, devEnv } from "./helpers.ts";

const env = devEnv();
const db = Db.connect(env.CODEJUDGE_DATABASE_URL!, 1);
try {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "create") {
    const u = await createTestUser(db);
    process.stdout.write(JSON.stringify({ userId: u.userId, token: u.token }) + "\n");
  } else if (cmd === "delete" && arg && /^\d+$/.test(arg)) {
    await deleteTestUsers(db, [Number(arg)]);
  } else {
    throw new Error("usage: e2e-session.ts create | delete <userId>");
  }
} finally {
  await db.close();
}
