// Dependency audit gate: `npm audit` in each package must report nothing
// beyond security/audit-exceptions.json, and no exception may be expired.
// Usage: node scripts/audit-check.mjs [today=YYYY-MM-DD]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { exceptions } = JSON.parse(readFileSync(join(root, "security/audit-exceptions.json"), "utf8"));
const today = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const problems = [];
const used = new Set();

for (const e of exceptions) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.until) || !e.reason || !e.advisory) problems.push(`malformed exception: ${JSON.stringify(e)}`);
  else if (e.until < today) problems.push(`EXPIRED exception ${e.advisory} (${e.package} in ${e.dir}) on ${e.until}: fix it or renew it with a reason`);
}

for (const dir of ["api", "web", "infra"]) {
  let out;
  try {
    out = execFileSync("npm", ["audit", "--json"], { cwd: join(root, dir), encoding: "utf8", shell: process.platform === "win32" });
  } catch (err) {
    out = err.stdout; // npm audit exits non-zero when it finds anything
  }
  const report = JSON.parse(out);
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (typeof via !== "object") continue; // "via: <package>" just points at the advisory's own entry
      const id = via.url?.split("/").pop();
      const ex = exceptions.find((e) => e.advisory === id && e.dir === dir && e.package === name);
      if (ex) used.add(ex);
      else problems.push(`${dir}: ${name} ${id} (${via.severity}): ${via.title}`);
    }
  }
}
for (const e of exceptions) if (!used.has(e)) console.log(`note: exception ${e.advisory} (${e.package} in ${e.dir}) is no longer needed; remove it`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`audit ok: ${used.size} accepted exception(s), none expired (today ${today})`);
