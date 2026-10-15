import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";

import { api, NetworkError, type Difficulty } from "../api.ts";
import { DifficultyBadge, TagChip } from "../components/DifficultyBadge.tsx";
import { ErrorBanner } from "../components/Layout.tsx";
import { ProblemStatus } from "../components/ProblemStatus.tsx";
import { allTags, applyFilter, DIFFICULTIES, filterParams, parseFilter, type ListFilter, type SortKey, type StatusFilter } from "../lib/problemFilters.ts";
import { useMe } from "../lib/useMe.ts";

const control = "rounded border border-line bg-canvas px-2 py-1 text-sm";

export function ProblemList() {
  const q = useQuery({ queryKey: ["problems"], queryFn: api.problems });
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const urlFilter = parseFilter(params);
  // The search box keeps its own text (typing must never lose keystrokes to a
  // URL round-trip); the URL follows after a short pause.
  const [text, setText] = useState(urlFilter.q);
  useEffect(() => setText(urlFilter.q), [urlFilter.q]);
  const filter: ListFilter = { ...urlFilter, q: text };
  const textNow = useRef(text);
  textNow.current = text;
  // Router updates land asynchronously (even setParams(fn) sees this render's
  // params), so two quick changes could overwrite each other: keep the latest
  // params written in a ref and always build on that.
  const latest = useRef(params);
  const seen = useRef(params.toString());
  useEffect(() => {
    // Adopt the URL only when it really changed (our own write landing, Back,
    // a link); a re-render that still shows older params must not undo a write.
    const s = params.toString();
    if (s !== seen.current) {
      seen.current = s;
      latest.current = params;
    }
  }, [params]);
  const write = useCallback(
    (patch: Partial<ListFilter>) => {
      const next = filterParams({ ...parseFilter(latest.current), ...patch });
      latest.current = next;
      setParams(next, { replace: true });
    },
    [setParams],
  );
  const set = (patch: Partial<ListFilter>) => write({ q: textNow.current, ...patch });
  const urlQ = urlFilter.q;
  useEffect(() => {
    if (text === urlQ) return;
    const t = setTimeout(() => write({ q: text }), 250);
    return () => clearTimeout(t);
  }, [text, urlQ, write]);
  const tags = useMemo(() => allTags(q.data ?? []), [q.data]);
  const shown = applyFilter(q.data ?? [], filter); // 60 problems: cheap enough on every render
  const filtered = text !== "" || urlFilter.difficulty !== null || urlFilter.tag !== null || urlFilter.status !== null;

  // "/" jumps to the search box (unless already typing somewhere).
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Arrow keys move between the problem links of the table.
  const onTableKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-row-link]")];
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = links[e.key === "ArrowDown" ? Math.min(links.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <main className="mx-auto max-w-5xl p-4">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-xl font-semibold">Problems</h1>
        {q.data && (
          <p className="text-sm text-muted" aria-live="polite" data-testid="problem-count">
            {shown.length === q.data.length ? `${q.data.length} problems` : `${shown.length} of ${q.data.length} problems`}
          </p>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3" role="search">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted">
          Search
          <input
            ref={search}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Title or tag (press / to focus)"
            className={`${control} text-fg`}
          />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs text-muted">Difficulty</legend>
          <div className="flex overflow-hidden rounded border border-line text-sm">
            {[null, ...DIFFICULTIES].map((d) => (
              <button
                key={d ?? "all"}
                type="button"
                aria-pressed={filter.difficulty === d}
                onClick={() => set({ difficulty: d as Difficulty | null })}
                className={`px-2.5 py-1 capitalize ${filter.difficulty === d ? "bg-accent text-on-accent" : "hover:bg-surface"}`}
              >
                {d ?? "All"}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Tag
          <select value={filter.tag ?? ""} onChange={(e) => set({ tag: e.target.value || null })} className={`${control} text-fg`}>
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {me.data && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            Status
            <select value={filter.status ?? ""} onChange={(e) => set({ status: (e.target.value || null) as StatusFilter | null })} className={`${control} text-fg`}>
              <option value="">Any status</option>
              <option value="todo">Not solved</option>
              <option value="attempted">Attempted</option>
              <option value="solved">Solved</option>
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs text-muted">
          Sort by
          <select value={filter.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} className={`${control} text-fg`}>
            <option value="difficulty">Difficulty</option>
            <option value="title">Title</option>
            <option value="time">Time limit</option>
          </select>
        </label>
        {filtered && (
          <button type="button" onClick={() => {
            setText("");
            write({ q: "", difficulty: null, tag: null, status: null });
          }} className="py-1 text-sm text-accent underline">
            Clear filters
          </button>
        )}
      </div>

      {q.isError && (
        <ErrorBanner>
          {q.error instanceof NetworkError ? q.error.message : `Could not load problems: ${q.error.message}`}{" "}
          <button className="underline" onClick={() => q.refetch()}>
            Retry
          </button>
        </ErrorBanner>
      )}

      {q.isPending && (
        <div aria-busy="true" aria-label="Loading problems" className="space-y-2" data-testid="list-loading">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-surface" />
          ))}
        </div>
      )}

      {q.data && shown.length === 0 && (
        <div className="rounded border border-dashed border-line p-8 text-center" data-testid="list-empty">
          <p className="font-medium">No problems match these filters.</p>
          <button type="button" onClick={() => {
            setText("");
            write({ q: "", difficulty: null, tag: null, status: null });
          }} className="mt-2 text-sm text-accent underline">
            Clear filters
          </button>
        </div>
      )}

      {q.data && shown.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Problems. Use the arrow keys to move between rows.</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="w-24 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 font-medium">
                Title
              </th>
              <th scope="col" className="py-2 font-medium">
                Difficulty
              </th>
              <th scope="col" className="hidden py-2 font-medium md:table-cell">
                Tags
              </th>
              <th scope="col" className="hidden py-2 text-right font-medium sm:table-cell">
                Limits
              </th>
            </tr>
          </thead>
          <tbody onKeyDown={onTableKey} data-testid="problem-rows">
            {shown.map((p) => (
              <tr key={p.slug} className="border-t border-line hover:bg-surface">
                <td className="py-2">
                  <ProblemStatus status={p.my_status} />
                </td>
                <td className="py-2">
                  <Link to={`/problems/${p.slug}`} data-row-link className="font-medium text-accent hover:underline">
                    {p.title}
                  </Link>
                </td>
                <td className="py-2">
                  <DifficultyBadge difficulty={p.difficulty} />
                </td>
                <td className="hidden py-2 md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {p.tags.map((t) => (
                      <TagChip key={t} tag={t} active={filter.tag === t} onClick={() => set({ tag: filter.tag === t ? null : t })} />
                    ))}
                  </div>
                </td>
                <td className="hidden py-2 text-right whitespace-nowrap text-muted tabular-nums sm:table-cell">
                  {p.time_limit_ms / 1000} s · {p.memory_limit_mb} MB
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
