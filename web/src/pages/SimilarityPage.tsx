import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { api, ApiError, type SimilaritySide } from "../api.ts";
import { ErrorBanner } from "../components/Layout.tsx";
import { useTitle } from "../lib/useTitle.ts";

/** One program with the lines that match the other one highlighted. */
function Side({ s }: { s: SimilaritySide }) {
  const inRegion = (n: number) => s.regions.some(([a, b]) => n >= a && n <= b);
  return (
    <figure className="m-0 min-w-0">
      <figcaption className="mb-1 text-sm">
        <span className="font-semibold">{s.login}</span> · {s.language} · {s.verdict} · {new Date(s.created_at).toLocaleString()}
      </figcaption>
      <ol className="max-h-[32rem] overflow-auto rounded border border-line font-mono text-xs" aria-label={`Code by ${s.login}`}>
        {s.source.replace(/\r\n?/g, "\n").split("\n").map((text, i) => (
          <li key={i} className={`flex gap-2 px-2 ${inRegion(i + 1) ? "bg-medium-bg text-medium-fg" : ""}`}>
            <span className="w-8 shrink-0 select-none text-right opacity-60">{i + 1}</span>
            <span className="whitespace-pre">{text || " "}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function Pair({ a, b }: { a: string; b: string }) {
  const q = useQuery({ queryKey: ["similarity-pair", a, b], queryFn: () => api.similarityPair(a, b) });
  if (q.isPending) return <p className="text-sm text-muted">Loading the pair…</p>;
  if (q.isError) return <ErrorBanner>{q.error.message}</ErrorBanner>;
  return (
    <section aria-label="Pair" className="space-y-2">
      <p className="text-sm">
        {Math.round(q.data.similarity * 100)}% of the smaller program's fingerprints also appear in the other (starter code and idioms most users share are ignored).
        Highlighted lines match.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <Side s={q.data.a} />
        <Side s={q.data.b} />
      </div>
    </section>
  );
}

/** Admin-only (the API answers 404 to everyone else): leads for a human to review, never verdicts. */
export function SimilarityPage() {
  useTitle("Similarity", "Similar submissions, for review.");
  const [params, setParams] = useSearchParams();
  const problem = params.get("problem") ?? "";
  const [open, setOpen] = useState<[string, string] | null>(null);
  const problems = useQuery({ queryKey: ["problems"], queryFn: api.problems });
  const q = useQuery({ queryKey: ["similarity", problem], queryFn: () => api.similarity(problem), enabled: !!problem, retry: false });

  if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 401)) {
    return <main className="p-4"><p>Page not found.</p></main>;
  }
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">Similar submissions</h1>
      <p className="text-sm text-muted">
        Pairs of submissions by different users whose code shares at least {q.data ? Math.round(q.data.threshold * 100) : 66}% of its
        fingerprints, after renaming, reformatting and comments are factored out. A high score is a reason to look, not proof of copying:
        short problems have few natural solutions. Nothing here is shown to the users.
      </p>
      <label className="flex items-center gap-2 text-sm">
        Problem
        <select className="rounded border border-line bg-canvas px-2 py-1" value={problem}
          onChange={(e) => { setOpen(null); setParams(e.target.value ? { problem: e.target.value } : {}); }}>
          <option value="">Choose…</option>
          {problems.data?.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
        </select>
      </label>
      {q.isError && <ErrorBanner>{q.error.message}</ErrorBanner>}
      {q.data && (
        q.data.pairs.length === 0 ? (
          <p className="text-sm">No pairs above the threshold among {q.data.submitters} users.</p>
        ) : (
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="text-muted"><tr><th className="font-normal">Similarity</th><th className="font-normal">Shared</th><th className="font-normal">Submissions</th><th /></tr></thead>
            <tbody>
              {q.data.pairs.map((p) => (
                <tr key={`${p.a}-${p.b}`} className="border-t border-line">
                  <td>{Math.round(p.similarity * 100)}%</td>
                  <td>{p.shared}</td>
                  <td className="font-mono text-xs">{p.a.slice(0, 8)} · {p.b.slice(0, 8)}</td>
                  <td><button type="button" className="text-accent underline" onClick={() => setOpen([p.a, p.b])}>Compare</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {open && <Pair a={open[0]} b={open[1]} />}
    </main>
  );
}
