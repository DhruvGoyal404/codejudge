/**
 * Evaluates similarity detection (docs/INSIGHTS.md, M2) on programs from the
 * PRIVATE problems repo: obfuscated copies (positives) and independently
 * written programs for the same problem (negatives), then picks the
 * threshold from the data, weighting precision over recall (F0.5).
 *
 * Usage: CODEJUDGE_PROBLEMS_TESTS_DIR=<private repo> npx tsx scripts/similarity-eval.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { compare, fingerprints, type Fingerprint } from "../src/similarity/fingerprint.ts";
import type { Lang } from "../src/similarity/lexer.ts";

const root = process.env.CODEJUDGE_PROBLEMS_TESTS_DIR;
if (!root) throw new Error("CODEJUDGE_PROBLEMS_TESTS_DIR is required");
const LANG: Record<string, Lang> = { ".c": "c", ".cpp": "cpp", ".go": "go", ".py": "python", ".java": "java", ".js": "javascript" };
const family = (l: Lang) => (l === "c" ? "cpp" : l); // C and C++ are compared with each other

interface Prog { slug: string; name: string; lang: Lang; src: string }
const progs: Prog[] = [];
for (const slug of readdirSync(root)) {
  const dir = join(root, slug, "solutions");
  if (!statSync(join(root, slug)).isDirectory() || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    const lang = LANG[extname(f)];
    if (lang) progs.push({ slug, name: f, lang, src: readFileSync(join(dir, f), "utf8") });
  }
}

// --- obfuscations (what a copier does to hide a copy) ---
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const KEEP = /^(int|long|char|bool|void|double|float|return|if|else|for|while|do|const|static|struct|class|public|private|def|in|range|len|print|import|from|include|using|namespace|std|main|sys|stdin|stdout|true|false|True|False|None|new|this|var|let|function|package|func|fmt|String|System|out|println|printf|scanf|cin|cout|endl|vector|size|push_back|append|sort|min|max|read|split|int64|nullptr|NULL|auto|unsigned|break|continue|switch|case|default|and|or|not|is|lambda|pass|elif|while|try|except|finally|with|as|yield|global|nonlocal|assert|del|raise|throws|Exception|IOException|Math|Arrays|Integer|Long|java|util|io|BufferedReader|InputStreamReader|StreamTokenizer|nval|nextToken|readFileSync|require|console|log|parseInt|Number|map|filter|join|length|math|bufio|os|strconv|Fscan|Println|Scanner|make|copy|string|sizeof|malloc|free|qsort|memset|define|ios|sync_with_stdio|tie|getline|substr|first|second|pair|begin|end|insert|erase|find|count|top|pop|push|front|back|empty|clear|reserve|resize|swap|abs|sqrt|pow)$/;
function rename(p: Prog): string {
  const names = new Map<string, string>();
  return p.src.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (w) => {
    if (KEEP.test(w)) return w;
    if (!names.has(w)) names.set(w, `x${names.size}_${Math.floor(rnd() * 1e4)}`);
    return names.get(w)!;
  });
}
// Python's indentation is syntax: only spacing inside lines and blank lines change.
const reformat = (p: Prog) =>
  p.src
    .split("\n")
    .map((l) => {
      const ind = l.match(/^\s*/)![0];
      const body = l.slice(ind.length).replace(/ +/g, rnd() < 0.5 ? " " : "   "); // token-preserving
      return p.lang === "python" ? ind + body : rnd() < 0.5 ? body : "        " + body;
    })
    .join(rnd() < 0.5 ? "\n" : "\n\n");
const comment: Record<Lang, string> = { c: "// note\n", cpp: "// note\n", java: "// note\n", javascript: "// note\n", go: "// note\n", python: "# note\n" };
function addComments(p: Prog): string {
  return p.src.split("\n").map((l) => (rnd() < 0.3 ? comment[p.lang] + l : l)).join("\n");
}
const dead: Record<Lang, string> = {
  c: "int unused_q = 0; unused_q += 1;",
  cpp: "int unused_q = 0; unused_q += 1;",
  java: "int unusedQ = 0; unusedQ += 1;",
  javascript: "let unusedQ = 0; unusedQ += 1;",
  go: "unusedQ := 0; _ = unusedQ",
  python: "unused_q = 0",
};
function deadCode(p: Prog): string {
  const lines = p.src.split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    const l = lines[i]!;
    const ind = l.length - l.trimStart().length;
    // Only after statement lines inside a body, at the same indentation.
    if (ind > 0 && rnd() < 0.15 && (p.lang === "python" ? /^[a-z_].*[^:,\\(]$/.test(l.trim()) : /;\s*$/.test(l))) {
      lines.splice(i + 1, 0, " ".repeat(ind) + dead[p.lang]);
    }
  }
  return lines.join("\n");
}
function reorder(p: Prog): string {
  // Swap adjacent simple declaration/assignment lines at the same indentation.
  const lines = p.src.split("\n");
  const simple = p.lang === "python" ? /^\s+[a-z_]\w* = [^=]+$/ : /^\s+(int|long long|long|double|auto|var|let|const)\s+\w+\s*=[^;]*;\s*$/;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (simple.test(lines[i]!) && simple.test(lines[i + 1]!)) {
      const a = lines[i]!.match(/^\s*/)![0], b = lines[i + 1]!.match(/^\s*/)![0];
      const lhs = lines[i]!.trim().split(/\s*=/)[0]!.split(/\s+/).at(-1)!;
      if (a === b && !lines[i + 1]!.includes(lhs)) [lines[i], lines[i + 1]] = [lines[i + 1]!, lines[i]!];
    }
  }
  return lines.join("\n");
}
const TRANSFORMS: Record<string, (p: Prog) => string> = {
  rename: rename,
  reformat: reformat,
  comments: addComments,
  "dead code": deadCode,
  reorder: reorder,
  "all of them": (p) => reformat({ ...p, src: addComments({ ...p, src: deadCode({ ...p, src: reorder({ ...p, src: rename(p) }) }) }) }),
};

// --- pairs ---
interface Pair { kind: string; positive: boolean; sim: number }
const pairs: Pair[] = [];
const fp = new Map<Prog, Fingerprint[]>(progs.map((p) => [p, fingerprints(p.lang, p.src)]));
const sized = progs.filter((p) => fp.get(p)!.length >= 3); // too short to say anything
for (const p of sized) {
  for (const [kind, t] of Object.entries(TRANSFORMS)) {
    pairs.push({ kind: `copy: ${kind}`, positive: true, sim: compare(fp.get(p)!, fingerprints(p.lang, t(p))).similarity });
  }
}
// C <-> C++ translations of the same solution (written as ports).
for (const p of sized.filter((q) => q.lang === "c")) {
  const cpp = sized.find((q) => q.slug === p.slug && q.lang === "cpp" && basename(q.name, ".cpp") === basename(p.name, ".c"));
  if (cpp) pairs.push({ kind: "copy: C <-> C++ translation", positive: true, sim: compare(fp.get(p)!, fp.get(cpp)!).similarity });
}
// Negatives: different programs for the same problem in the same language
// family (independently written; short problems naturally look alike).
for (let i = 0; i < sized.length; i++) {
  for (let j = i + 1; j < sized.length; j++) {
    const a = sized[i]!, b = sized[j]!;
    if (a.slug !== b.slug || family(a.lang) !== family(b.lang)) continue;
    if (basename(a.name).split(".")[0] === basename(b.name).split(".")[0]) continue; // ports of one solution
    // wrong* fixtures are the reference with a planted bug: derived, not independent.
    if (/^wrong/.test(a.name) || /^wrong/.test(b.name)) continue;
    const sim = compare(fp.get(a)!, fp.get(b)!).similarity;
    if (process.env.SHOW_NEG && sim >= 0.5) console.log(`  negative ${a.slug}: ${a.name} vs ${b.name} ${sim.toFixed(2)}`);
    pairs.push({ kind: "independent, same problem", positive: false, sim });
  }
}

// --- threshold from the data: maximize F0.5 (precision counts double) ---
let best = { t: 1, f: -1, p: 0, r: 0 };
for (let t = 0.05; t <= 0.951; t += 0.01) {
  const tp = pairs.filter((x) => x.positive && x.sim >= t).length;
  const fpn = pairs.filter((x) => !x.positive && x.sim >= t).length;
  const fn = pairs.filter((x) => x.positive && x.sim < t).length;
  const p = tp / (tp + fpn || 1), r = tp / (tp + fn || 1);
  const f = (1.25 * p * r) / (0.25 * p + r || 1);
  if (f > best.f) best = { t: Math.round(t * 100) / 100, f, p, r };
}
const pct = (k: number, n: number) => `${k}/${n} (${((100 * k) / (n || 1)).toFixed(1)}%)`;
console.log(`programs: ${progs.length} (${sized.length} long enough), pairs: ${pairs.length}`);
console.log(`threshold (max F0.5): ${best.t}  precision ${(best.p * 100).toFixed(1)}%  recall ${(best.r * 100).toFixed(1)}%`);
for (const kind of [...new Set(pairs.map((x) => x.kind))]) {
  const xs = pairs.filter((x) => x.kind === kind);
  const flagged = xs.filter((x) => x.sim >= best.t).length;
  const sims = xs.map((x) => x.sim).sort((a, b) => a - b);
  console.log(`  ${kind.padEnd(32)} ${xs[0]!.positive ? "detected" : "flagged "} ${pct(flagged, xs.length)}  median similarity ${sims[sims.length >> 1]!.toFixed(2)}`);
}
