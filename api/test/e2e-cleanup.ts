// Used by web/e2e global teardown: deletes the users created through the
// test-only auth shortcut (POST /test/login gives them a negative github_id,
// which real GitHub accounts never have) together with their submissions.
import { Db } from "../src/db.ts";
import { devEnv } from "./helpers.ts";

const db = Db.connect(devEnv().CODEJUDGE_DATABASE_URL!, 1);
try {
  await db.pool.query(`DELETE FROM submissions WHERE user_id IN (SELECT id FROM users WHERE github_id < 0)`);
  const r = await db.pool.query(`DELETE FROM users WHERE github_id < 0`);
  process.stdout.write(`removed ${r.rowCount} test-shortcut users\n`);
} finally {
  await db.close();
}
