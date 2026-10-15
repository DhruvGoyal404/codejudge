// Fails if the main entry chunk grows more than 20% over the pre-Phase-5.5-U
// baseline (index-*.js, 445.48 kB raw), or if Monaco ends up in it.
// Run after `npm run build`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BASELINE = 445_480;
const LIMIT = Math.round(BASELINE * 1.2);
const dir = join(import.meta.dirname, "..", "dist", "assets");
const entry = readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f));
if (entry.length !== 1) throw new Error(`expected one index-*.js, found ${entry}`);
const size = statSync(join(dir, entry[0])).size;
const pct = (((size - BASELINE) / BASELINE) * 100).toFixed(1);
console.log(`main bundle ${entry[0]}: ${size} bytes (${pct}% vs baseline ${BASELINE}, limit ${LIMIT})`);
if (size > LIMIT) {
  console.error("main bundle exceeds the +20% budget");
  process.exit(1);
}
if (readFileSync(join(dir, entry[0]), "utf8").includes("monaco-editor")) {
  console.error("Monaco is in the main bundle: it must stay lazy-loaded");
  process.exit(1);
}
