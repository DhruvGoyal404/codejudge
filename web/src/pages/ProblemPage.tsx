import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useReducer, useState } from "react";
import Markdown from "react-markdown";
import { Link, useParams } from "react-router";

import { api, ApiError, LANGUAGES, MAX_SOURCE_BYTES, NetworkError, submitErrorMessage, type Language, type Problem } from "../api.ts";
import { ErrorBanner, LoginLink } from "../components/Layout.tsx";
import { ResultPanel } from "../components/ResultPanel.tsx";
import { VerdictBadge } from "../components/VerdictBadge.tsx";
import { judgeReducer, type JudgeEvent } from "../lib/judgeState.ts";
import { drafts } from "../lib/storage.ts";
import { useMe } from "../lib/useMe.ts";
import { useSubmissionStream } from "../lib/useSubmissionStream.ts";

const CodeEditor = lazy(() => import("../editor/CodeEditor.tsx"));

const TEMPLATES: Record<Language, string> = {
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    return 0;\n}\n",
  python: "import sys\n\ndef main():\n    data = sys.stdin.read().split()\n\nmain()\n",
};

export function ProblemPage({ dark }: { dark: boolean }) {
  const { slug = "" } = useParams();
  const q = useQuery({ queryKey: ["problem", slug], queryFn: () => api.problem(slug) });
  if (q.isPending) return <p className="p-4 text-sm text-zinc-500">Loading…</p>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="p-4">
        <ErrorBanner>
          {notFound ? "Problem not found." : q.error instanceof NetworkError ? q.error.message : q.error.message}{" "}
          {!notFound && (
            <button className="underline" onClick={() => q.refetch()}>
              Retry
            </button>
          )}
        </ErrorBanner>
      </div>
    );
  }
  return <Workspace key={slug} problem={q.data} dark={dark} />;
}

function Workspace({ problem, dark }: { problem: Problem; dark: boolean }) {
  const [lang, setLang] = useState<Language>("cpp");
  const [code, setCode] = useState(() => drafts.get(problem.slug, "cpp") ?? TEMPLATES.cpp);
  const [state, dispatch] = useReducer(judgeReducer, { phase: "idle" });
  const me = useMe();
  const loggedOut = me.data === null;
  const stableDispatch = useCallback((e: JudgeEvent) => dispatch(e), []);
  const activeId = "id" in state ? state.id : null;
  useSubmissionStream(state.phase === "done" ? null : activeId, stableDispatch);
  const qc = useQueryClient();
  // A new verdict changes the history and the solved/attempted badges.
  const finished = state.phase === "done" ? state.submission.id + state.submission.status : null;
  useEffect(() => {
    if (finished) {
      void qc.invalidateQueries({ queryKey: ["history"] });
      void qc.invalidateQueries({ queryKey: ["problems"] });
    }
  }, [finished, qc]);

  // Drafts: per problem and language, saved on every change (storage failures are ignored).
  useEffect(() => {
    drafts.set(problem.slug, lang, code);
  }, [problem.slug, lang, code]);
  const switchLang = (next: Language) => {
    drafts.set(problem.slug, lang, code);
    setLang(next);
    setCode(drafts.get(problem.slug, next) ?? TEMPLATES[next]);
  };

  const submit = useMutation({
    mutationFn: () => api.submit(problem.slug, lang, code),
    onMutate: () => dispatch({ type: "SUBMIT" }),
    onSuccess: ({ id }) => {
      dispatch({ type: "SUBMITTED", id });
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
    onError: (err) => dispatch({ type: "SUBMIT_FAILED", message: submitErrorMessage(err) }),
  });
  const tooBig = new TextEncoder().encode(code).length > MAX_SOURCE_BYTES;
  const busy = state.phase === "submitting" || state.phase === "queued" || state.phase === "running";
  const canSubmit = !loggedOut && !busy && !tooBig && code.trim().length > 0;
  const doSubmit = useCallback(() => {
    if (canSubmit) submit.mutate();
  }, [canSubmit, submit]);

  // Ctrl/Cmd+Enter anywhere on the page submits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        doSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSubmit]);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <section className="overflow-y-auto border-zinc-200 p-4 lg:w-[45%] lg:border-r dark:border-zinc-800" aria-label="Problem statement">
        <div className="mb-2 flex flex-wrap gap-3 text-xs text-zinc-500">
          <span>Time limit: {problem.time_limit_ms / 1000} s (Python ×2)</span>
          <span>Memory limit: {problem.memory_limit_mb} MB</span>
        </div>
        <article className="prose-sm max-w-none space-y-3 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 dark:[&_code]:bg-zinc-800 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-zinc-100 [&_pre]:p-2 dark:[&_pre]:bg-zinc-900">
          {/* skipHtml: raw HTML in statements is dropped, never rendered. */}
          <Markdown skipHtml>{problem.statement_md}</Markdown>
        </article>
        <h2 className="mt-6 mb-2 font-semibold">Samples</h2>
        {problem.samples.map((s) => (
          <div key={s.name} className="mb-3 grid gap-2 md:grid-cols-2">
            <div>
              <div className="text-xs text-zinc-500">Sample {s.name} input</div>
              <pre className="overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">{s.input}</pre>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Sample {s.name} output</div>
              <pre className="overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">{s.output}</pre>
            </div>
          </div>
        ))}
      </section>

      <section className="flex min-h-0 flex-1 flex-col" aria-label="Editor and results">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <label className="text-sm">
            Language{" "}
            <select
              value={lang}
              onChange={(e) => switchLang(e.target.value as Language)}
              className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
              aria-label="Language"
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id} className="text-zinc-900">
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {loggedOut ? (
            <LoginLink className="ml-auto rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
              Log in to submit
            </LoginLink>
          ) : (
            <button
              type="button"
              onClick={doSubmit}
              disabled={!canSubmit}
              className="ml-auto rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Submit (Ctrl+Enter)"
            >
              {busy ? "Judging…" : "Submit"}
            </button>
          )}
        </div>
        {tooBig && (
          <div className="px-3 pt-2">
            <ErrorBanner>Your code is larger than 64 KB and cannot be submitted.</ErrorBanner>
          </div>
        )}
        <div className="min-h-[18rem] flex-1">
          <Suspense fallback={<div className="p-4 text-sm text-zinc-500">Loading editor…</div>}>
            <CodeEditor language={lang} value={code} onChange={setCode} onSubmit={doSubmit} dark={dark} />
          </Suspense>
        </div>
        <div className="max-h-[50%] overflow-y-auto border-t border-zinc-200 p-3 dark:border-zinc-800">
          <ResultPanel state={state} samples={problem.samples} />
          <MySubmissions slug={problem.slug} activeId={activeId} onOpen={(id) => dispatch({ type: "SHOW", id })} />
        </div>
      </section>
    </div>
  );
}

/** The logged-in user's latest submissions to this problem (from the API). */
function MySubmissions({ slug, activeId, onOpen }: { slug: string; activeId: string | null; onOpen: (id: string) => void }) {
  const me = useMe();
  const q = useQuery({
    queryKey: ["history", { problem: slug, limit: 10 }],
    queryFn: () => api.history({ problem: slug, limit: 10 }),
    enabled: !!me.data,
    // Keep pending rows fresh until they have a verdict.
    refetchInterval: (query) => (query.state.data?.submissions.some((s) => s.status !== "done") ? 3000 : false),
  });
  const rows = q.data?.submissions ?? [];
  if (!me.data || rows.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="text-sm font-medium">My submissions</h3>
        <Link to={`/profile?problem=${encodeURIComponent(slug)}`} className="text-xs text-blue-700 hover:underline dark:text-blue-400">
          View all
        </Link>
      </div>
      <ul className="space-y-1 text-sm" data-testid="my-submissions">
        {rows.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <button type="button" onClick={() => onOpen(s.id)} className={`font-mono text-xs hover:underline ${s.id === activeId ? "font-bold" : ""}`} title="Show the result here">
              {s.id.slice(0, 8)}
            </button>
            {s.verdict ? <VerdictBadge verdict={s.verdict} /> : <span className="text-xs text-zinc-500">{s.status}</span>}
            <span className="text-xs text-zinc-500">
              {s.language} · {new Date(s.created_at).toLocaleTimeString()}
            </span>
            <Link to={`/submissions/${s.id}`} className="text-xs text-blue-700 hover:underline dark:text-blue-400">
              Details
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
