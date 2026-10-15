import { describe, expect, it } from "vitest";

import type { ProblemSummary } from "../api.ts";
import { allTags, applyFilter, filterParams, parseFilter, type ListFilter } from "./problemFilters.ts";

const P = (slug: string, title: string, difficulty: ProblemSummary["difficulty"], tags: string[], my_status: ProblemSummary["my_status"] = null, time = 1000): ProblemSummary => ({
  slug,
  title,
  difficulty,
  tags,
  my_status,
  time_limit_ms: time,
  memory_limit_mb: 256,
});

const list = [
  P("reef-islands", "Reef Islands", "medium", ["bfs", "matrix"], "solved", 2000),
  P("tide-gauge", "Tide Gauge", "easy", ["arrays"], "attempted"),
  P("team-draft", "Team Draft", "hard", ["dynamic-programming", "bit-manipulation"]),
  P("badge-codes", "Badge Codes", "easy", ["strings", "hashing"]),
];
const none: ListFilter = { q: "", difficulty: null, tag: null, status: null, sort: "difficulty" };
const slugs = (f: Partial<ListFilter>) => applyFilter(list, { ...none, ...f }).map((p) => p.slug);

describe("problem list filters", () => {
  it("sorts by difficulty, then title, by default", () => {
    expect(slugs({})).toEqual(["badge-codes", "tide-gauge", "reef-islands", "team-draft"]);
  });
  it("sorts by title and by time limit", () => {
    expect(slugs({ sort: "title" })).toEqual(["badge-codes", "reef-islands", "team-draft", "tide-gauge"]);
    expect(slugs({ sort: "time" })[3]).toBe("reef-islands");
  });
  it("searches title, slug and tags; every word must match", () => {
    expect(slugs({ q: "tide" })).toEqual(["tide-gauge"]);
    expect(slugs({ q: "  MATRIX " })).toEqual(["reef-islands"]);
    expect(slugs({ q: "team bit" })).toEqual(["team-draft"]);
    expect(slugs({ q: "team strings" })).toEqual([]);
  });
  it("filters by difficulty, tag and status", () => {
    expect(slugs({ difficulty: "easy" })).toEqual(["badge-codes", "tide-gauge"]);
    expect(slugs({ tag: "hashing" })).toEqual(["badge-codes"]);
    expect(slugs({ status: "solved" })).toEqual(["reef-islands"]);
    expect(slugs({ status: "attempted" })).toEqual(["tide-gauge"]);
    expect(slugs({ status: "todo" })).toEqual(["badge-codes", "tide-gauge", "team-draft"]);
  });
  it("round-trips through URL params and ignores unknown values", () => {
    const f: ListFilter = { q: "reef", difficulty: "medium", tag: "bfs", status: "solved", sort: "title" };
    expect(parseFilter(filterParams(f))).toEqual(f);
    expect(filterParams(none).toString()).toBe("");
    expect(parseFilter(new URLSearchParams("difficulty=insane&status=x&sort=y"))).toEqual(none);
  });
  it("collects the tags in use", () => {
    expect(allTags(list)).toEqual(["arrays", "bfs", "bit-manipulation", "dynamic-programming", "hashing", "matrix", "strings"]);
  });
});
