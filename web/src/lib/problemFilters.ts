import type { Difficulty, ProblemSummary } from "../api.ts";

export type StatusFilter = "solved" | "attempted" | "todo";
export type SortKey = "title" | "difficulty" | "time";

export interface ListFilter {
  q: string;
  difficulty: Difficulty | null;
  tag: string | null;
  status: StatusFilter | null;
  sort: SortKey;
}

export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };

/** Reads the filter from URL search params (unknown values fall back to "any"). */
export function parseFilter(p: URLSearchParams): ListFilter {
  const d = p.get("difficulty");
  const s = p.get("status");
  const sort = p.get("sort");
  return {
    q: p.get("q") ?? "",
    difficulty: d === "easy" || d === "medium" || d === "hard" ? d : null,
    tag: p.get("tag") || null,
    status: s === "solved" || s === "attempted" || s === "todo" ? s : null,
    sort: sort === "title" || sort === "time" ? sort : "difficulty",
  };
}

/** The filter as URL search params; defaults are left out to keep URLs short. */
export function filterParams(f: ListFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.difficulty) p.set("difficulty", f.difficulty);
  if (f.tag) p.set("tag", f.tag);
  if (f.status) p.set("status", f.status);
  if (f.sort !== "difficulty") p.set("sort", f.sort);
  return p;
}

/** All tags used by the problems, sorted. */
export function allTags(problems: ProblemSummary[]): string[] {
  return [...new Set(problems.flatMap((p) => p.tags))].sort();
}

export function applyFilter(problems: ProblemSummary[], f: ListFilter): ProblemSummary[] {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out = problems.filter((p) => {
    if (f.difficulty && p.difficulty !== f.difficulty) return false;
    if (f.tag && !p.tags.includes(f.tag)) return false;
    if (f.status === "solved" && p.my_status !== "solved") return false;
    if (f.status === "attempted" && p.my_status !== "attempted") return false;
    if (f.status === "todo" && p.my_status === "solved") return false;
    const hay = `${p.title} ${p.slug} ${p.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const byTitle = (a: ProblemSummary, b: ProblemSummary) => a.title.localeCompare(b.title);
  out.sort((a, b) => {
    if (f.sort === "difficulty") return RANK[a.difficulty] - RANK[b.difficulty] || byTitle(a, b);
    if (f.sort === "time") return a.time_limit_ms - b.time_limit_ms || byTitle(a, b);
    return byTitle(a, b);
  });
  return out;
}
