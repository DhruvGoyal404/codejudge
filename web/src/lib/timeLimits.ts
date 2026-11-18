import type { Language } from "../api.ts";

const SHORT: [Language, string][] = [["c", "C"], ["cpp", "C++"], ["go", "Go"], ["java", "Java"], ["javascript", "JS"], ["python", "Python"]];

/** "C/C++ 1 s · Go/Java/JS/Python 2 s": the judge's per-language limits, grouped by value, smallest first. */
export function limitsByLanguage(limits: Partial<Record<Language, number>> | null | undefined): string | null {
  if (!limits) return null;
  const groups = new Map<number, string[]>();
  for (const [id, name] of SHORT) {
    const ms = limits[id];
    if (ms !== undefined) groups.set(ms, [...(groups.get(ms) ?? []), name]);
  }
  if (groups.size === 0) return null;
  return [...groups]
    .sort(([a], [b]) => a - b)
    .map(([ms, names]) => `${names.join("/")} ${+(ms / 1000).toFixed(2)} s`)
    .join(" · ");
}
