import { tokenize, type Lang } from "./lexer.ts";

/**
 * Winnowing (Schleimer, Wilkerson, Aiken 2003, the algorithm behind MOSS):
 * hash every k-gram of normalized tokens, then keep the minimum hash of every
 * window of W consecutive k-grams. Any match of at least W + K - 1 tokens is
 * guaranteed to share a fingerprint; matches shorter than K are ignored.
 */
export const K = 12;
export const W = 8;

export interface Fingerprint {
  hash: number; // 32-bit FNV-1a of the k-gram, as a signed int (fits Postgres integer)
  from: number; // first source line of the k-gram
  to: number; // last source line
}

function fnv(tokens: string[]): number {
  let h = 0x811c9dc5;
  for (const t of tokens) {
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f; // token separator
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export function fingerprints(lang: Lang, src: string): Fingerprint[] {
  const toks = tokenize(lang, src);
  if (toks.length < K) return [];
  const grams: Fingerprint[] = [];
  for (let i = 0; i + K <= toks.length; i++) {
    grams.push({ hash: fnv(toks.slice(i, i + K).map((t) => t.k)), from: toks[i]!.line, to: toks[i + K - 1]!.line });
  }
  // Keep the rightmost minimum of each window, once per position.
  const picked = new Map<number, Fingerprint>();
  for (let i = 0; i <= Math.max(0, grams.length - W); i++) {
    let best = i;
    for (let j = i + 1; j < Math.min(i + W, grams.length); j++) if (grams[j]!.hash <= grams[best]!.hash) best = j;
    picked.set(best, grams[best]!);
  }
  return [...picked.values()];
}

export interface Comparison {
  similarity: number; // shared fingerprints / fingerprints of the smaller program (base excluded)
  shared: number;
  regionsA: [number, number][]; // merged line ranges in A that match B
  regionsB: [number, number][];
}

function merge(ranges: [number, number][]): [number, number][] {
  const s = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of s) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Compares two programs' fingerprints, ignoring every hash in base. */
export function compare(a: Fingerprint[], b: Fingerprint[], base: Set<number> = new Set()): Comparison {
  const fa = a.filter((f) => !base.has(f.hash));
  const fb = b.filter((f) => !base.has(f.hash));
  const hb = new Set(fb.map((f) => f.hash));
  const ha = new Set(fa.map((f) => f.hash));
  const sharedA = fa.filter((f) => hb.has(f.hash));
  const sharedB = fb.filter((f) => ha.has(f.hash));
  const shared = new Set(sharedA.map((f) => f.hash)).size;
  const denom = Math.min(ha.size, hb.size);
  return {
    similarity: denom ? shared / denom : 0,
    shared,
    regionsA: merge(sharedA.map((f) => [f.from, f.to])),
    regionsB: merge(sharedB.map((f) => [f.from, f.to])),
  };
}
