import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { Link, useParams } from "react-router";

import { api, ApiError, LANGUAGES, NetworkError } from "../api.ts";
import { ErrorBanner } from "../components/Layout.tsx";
import { ResultPanel } from "../components/ResultPanel.tsx";
import { useTitle } from "../lib/useTitle.ts";

const CodeEditor = lazy(() => import("../editor/CodeEditor.tsx"));

/** One submission: result details, and (for its author only) the code in a read-only editor. */
export function SubmissionPage({ dark }: { dark: boolean }) {
  useTitle("Submission", "A CodeJudge submission: its verdict, per-test results and source.");
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["submission", id, "detail"],
    queryFn: () => api.submission(id),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== "done" ? 2000 : false),
  });
  const slug = q.data?.problem_slug;
  const problem = useQuery({ queryKey: ["problem", slug], queryFn: () => api.problem(slug!), enabled: !!slug });

  if (q.isPending) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400);
    return (
      <div className="p-4">
        <ErrorBanner>{notFound ? "Submission not found." : q.error instanceof NetworkError ? q.error.message : q.error.message}</ErrorBanner>
      </div>
    );
  }
  const s = q.data;
  const lang = LANGUAGES.find((l) => l.id === s.language)?.label ?? s.language;
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">
          Submission <span className="font-mono">{s.id.slice(0, 8)}</span>
        </h1>
        <p className="text-sm text-muted">
          <Link to={`/problems/${s.problem_slug}`} className="text-accent underline">
            {problem.data?.title ?? s.problem_slug}
          </Link>{" "}
          · {lang} · submitted {new Date(s.created_at).toLocaleString()}
        </p>
      </div>

      {s.status === "done" ? (
        <ResultPanel state={{ phase: "done", id: s.id, submission: s }} samples={problem.data?.samples ?? []} />
      ) : (
        <p className="text-sm" data-testid="pending-status">
          {s.status === "queued" ? "Queued…" : "Judging…"}
        </p>
      )}

      <section aria-label="Submitted code">
        <h2 className="mb-2 font-semibold">Code</h2>
        {s.mine && s.source !== undefined ? (
          <div className="h-[28rem] overflow-hidden rounded border border-line" data-testid="source-view">
            <Suspense fallback={<div className="p-4 text-sm text-muted">Loading editor…</div>}>
              <CodeEditor language={s.language} value={s.source} dark={dark} readOnly />
            </Suspense>
          </div>
        ) : (
          <p className="text-sm text-muted" data-testid="source-hidden">
            The code is visible only to its author.
          </p>
        )}
      </section>
    </main>
  );
}
