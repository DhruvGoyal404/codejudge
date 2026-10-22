import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import Markdown from "react-markdown";
import { Link, useParams } from "react-router";

import { api, ApiError, LANGUAGES, MAX_RUN_INPUT_BYTES, MAX_SOURCE_BYTES, NetworkError, submitErrorMessage, type Language, type Problem } from "../api.ts";
import { DifficultyBadge, TagChip } from "../components/DifficultyBadge.tsx";
import { ErrorBanner, LoginLink } from "../components/Layout.tsx";
import { ResultPanel } from "../components/ResultPanel.tsx";
import { RunPanel } from "../components/RunPanel.tsx";
import { Splitter } from "../components/Splitter.tsx";
import { VerdictBadge } from "../components/VerdictBadge.tsx";
import { judgeReducer, type JudgeEvent } from "../lib/judgeState.ts";
import { drafts, load, prefs as savedPrefs, save, type Prefs } from "../lib/storage.ts";
import { useMe } from "../lib/useMe.ts";
import { TEMPLATES } from "../lib/templates.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useRun } from "../lib/useRun.ts";
import { useTitle } from "../lib/useTitle.ts";
import { useSubmissionStream } from "../lib/useSubmissionStream.ts";

const CodeEditor = lazy(() => import("../editor/CodeEditor.tsx"));


export function ProblemPage({ dark }: { dark: boolean }) {
  const { slug = "" } = useParams();
  const narrow = useMediaQuery("(max-width: 767px)");
  const q = useQuery({ queryKey: ["problem", slug], queryFn: () => api.problem(slug) });
  useTitle(
    q.data?.title ?? null,
    q.data
      ? `${q.data.title}: a ${q.data.difficulty} problem on CodeJudge (${q.data.tags.join(", ")}). Solve it in C, C++, Go, Python, Java or JavaScript.`
      : undefined,
  );
  if (q.isPending)
    return (
      <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading problem">
        <div className="h-7 w-64 animate-pulse rounded bg-surface" />
        <div className="h-4 w-full max-w-xl animate-pulse rounded bg-surface" />
        <div className="h-4 w-full max-w-lg animate-pulse rounded bg-surface" />
      </div>
    );
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
  return narrow ? <MobileProblem problem={q.data} /> : <Workspace key={slug} problem={q.data} dark={dark} />;
}

function Workspace({ problem, dark }: { problem: Problem; dark: boolean }) {
  const [prefs, setPrefs] = useState<Prefs>(savedPrefs.get);
  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savedPrefs.set(next);
      return next;
    });
  }, []);
  const [lang, setLang] = useState<Language>(() => (LANGUAGES.some((l) => l.id === prefs.language) ? (prefs.language as Language) : "cpp"));
  const [code, setCode] = useState(() => drafts.get(problem.slug, lang) ?? TEMPLATES[lang]);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLElement>(null);
  const run = useRun();
  const inputKey = `codejudge:input:${problem.slug}`;
  const [input, setInput] = useState(() => load(inputKey) ?? problem.samples[0]?.input ?? "");
  useEffect(() => {
    save(inputKey, input);
  }, [inputKey, input]);
  const [tab, setTab] = useState<"run" | "result">("run");
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
    updatePrefs({ language: next });
    setConfirmReset(false);
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
    if (!canSubmit) return;
    setTab("result");
    submit.mutate();
  }, [canSubmit, submit]);
  const inputTooBig = new TextEncoder().encode(input).length > MAX_RUN_INPUT_BYTES;
  const canRun = !loggedOut && !run.busy && !tooBig && !inputTooBig && code.trim().length > 0;
  const doRun = useCallback(() => {
    if (!canRun) return;
    setTab("run");
    void run.start(problem.slug, lang, code, input);
  }, [canRun, run, problem.slug, lang, code, input]);

  // Ctrl/Cmd+Enter anywhere on the page submits; Ctrl/Cmd+' runs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        doSubmit();
      } else if (e.key === "'") {
        e.preventDefault();
        doRun();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSubmit, doRun]);

  const vars = { "--statement": `${prefs.layout.statement}%`, "--editor": `${prefs.layout.editor}%` } as CSSProperties;
  const toolbarButton = "rounded border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50";

  return (
    <div ref={row} style={vars} className="flex h-full flex-col lg:flex-row">
      <section className="overflow-y-auto p-4 lg:shrink-0 lg:grow-0 lg:basis-[var(--statement)]" aria-labelledby="problem-title" data-testid="statement-pane" tabIndex={0}>
        <StatementBody problem={problem} />
      </section>

      <div className="hidden lg:contents">
        <Splitter
          orientation="vertical"
          label="Resize statement and editor"
          value={prefs.layout.statement}
          min={20}
          max={75}
          container={row}
          onChange={(v) => updatePrefs({ layout: { ...prefs.layout, statement: v } })}
        />
      </div>

      <section ref={column} className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-line lg:border-t-0" aria-label="Editor and results">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <label className="text-sm">
            Language{" "}
            <select value={lang} onChange={(e) => switchLang(e.target.value as Language)} className="rounded border border-line bg-canvas px-1 py-0.5" aria-label="Language">
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={toolbarButton} aria-expanded={showSettings} aria-controls="editor-settings" onClick={() => setShowSettings((v) => !v)}>
            Settings
          </button>
          {confirmReset ? (
            <span className="flex items-center gap-1 text-sm" role="group" aria-label="Confirm reset">
              Replace your code with the starter code?
              <button
                type="button"
                className={toolbarButton}
                onClick={() => {
                  setCode(TEMPLATES[lang]);
                  setConfirmReset(false);
                }}
              >
                Reset
              </button>
              <button type="button" className={toolbarButton} onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className={toolbarButton} onClick={() => setConfirmReset(true)} disabled={code === TEMPLATES[lang]}>
              Reset code
            </button>
          )}
          {loggedOut ? (
            <LoginLink className="ml-auto rounded bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-hover">Log in to run and submit</LoginLink>
          ) : (
            <>
            <button
              type="button"
              onClick={doRun}
              disabled={!canRun}
              className="ml-auto rounded border border-accent px-3 py-1 text-sm font-medium text-accent hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
              title="Run on your input (Ctrl+')"
            >
              {run.busy ? "Running…" : "Run"}
            </button>
            <button
              type="button"
              onClick={doSubmit}
              disabled={!canSubmit}
              className="rounded bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              title="Submit (Ctrl+Enter)"
            >
              {busy ? "Judging…" : "Submit"}
            </button>
            </>
          )}
        </div>
        {showSettings && (
          <div id="editor-settings" className="flex flex-wrap items-center gap-4 border-b border-line bg-surface px-3 py-2 text-sm" role="group" aria-label="Editor settings">
            <label>
              Font size{" "}
              <select
                value={prefs.editor.fontSize}
                onChange={(e) => updatePrefs({ editor: { ...prefs.editor, fontSize: Number(e.target.value) } })}
                className="rounded border border-line bg-canvas px-1 py-0.5"
              >
                {[12, 13, 14, 16, 18, 20].map((n) => (
                  <option key={n} value={n}>
                    {n}px
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tab size{" "}
              <select
                value={prefs.editor.tabSize}
                onChange={(e) => updatePrefs({ editor: { ...prefs.editor, tabSize: Number(e.target.value) } })}
                className="rounded border border-line bg-canvas px-1 py-0.5"
              >
                {[2, 4, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={prefs.editor.wordWrap} onChange={(e) => updatePrefs({ editor: { ...prefs.editor, wordWrap: e.target.checked } })} />
              Word wrap
            </label>
            <span className="text-xs text-muted">In the editor, Ctrl+M makes Tab move focus out instead of indenting.</span>
          </div>
        )}
        {tooBig && (
          <div className="px-3 pt-2">
            <ErrorBanner>Your code is larger than 64 KB and cannot be submitted.</ErrorBanner>
          </div>
        )}
        <div className="min-h-[12rem] shrink-0 grow-0 basis-[var(--editor)]" data-testid="editor-pane">
          <Suspense fallback={<div className="p-4 text-sm text-muted">Loading editor…</div>}>
            <CodeEditor language={lang} value={code} onChange={setCode} onSubmit={doSubmit} onRun={doRun} dark={dark} settings={prefs.editor} />
          </Suspense>
        </div>
        <Splitter
          orientation="horizontal"
          label="Resize editor and results"
          value={prefs.layout.editor}
          min={25}
          max={85}
          container={column}
          onChange={(v) => updatePrefs({ layout: { ...prefs.layout, editor: v } })}
        />
        <div className="flex min-h-0 flex-1 flex-col" data-testid="results-pane">
          <div
            role="tablist"
            aria-label="Run and submission results"
            className="flex shrink-0 gap-1 border-b border-line px-3"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const next = tab === "run" ? "result" : "run";
                setTab(next);
                document.getElementById(`tab-${next}`)?.focus();
              }
            }}
          >
            {(["run", "result"] as const).map((t) => (
              <button
                key={t}
                id={`tab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls={`panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
              >
                {t === "run" ? "Run" : "Submission"}
              </button>
            ))}
          </div>
          <div id="panel-run" role="tabpanel" aria-labelledby="tab-run" hidden={tab !== "run"} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-3">
            <RunPanel samples={problem.samples} input={input} onInput={setInput} run={run.state} />
          </div>
          <div id="panel-result" role="tabpanel" aria-labelledby="tab-result" hidden={tab !== "result"} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-3">
            <ResultPanel state={state} samples={problem.samples} />
            <MySubmissions slug={problem.slug} activeId={activeId} onOpen={(id) => dispatch({ type: "SHOW", id })} />
          </div>
        </div>
      </section>
    </div>
  );
}

/** Title, difficulty, tags, limits, statement and samples (shared by the desktop and mobile layouts). */
function StatementBody({ problem }: { problem: Problem }) {
  const statementMd = problem.statement_md.replace(/^# .*\n+/, ""); // the title is shown in the header
  return (
    <>
    <header className="mb-3 space-y-2">
      <h1 id="problem-title" className="text-xl font-semibold">
        {problem.title}
      </h1>
      <div className="flex flex-wrap items-center gap-2">
        <DifficultyBadge difficulty={problem.difficulty} />
        {problem.tags.map((t) => (
          <TagChip key={t} tag={t} />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted">
        <span>Time limit: {problem.time_limit_ms / 1000} s per test</span>
        <span>At most 60 s CPU per submission in total</span>
        <span>Memory limit: {problem.memory_limit_mb} MB</span>
      </div>
    </header>
    <article className="max-w-none space-y-3 text-sm leading-relaxed [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-surface [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
      {/* skipHtml: raw HTML in statements is dropped, never rendered. */}
      <Markdown skipHtml>{statementMd}</Markdown>
    </article>
    <h2 className="mt-6 mb-2 text-base font-semibold">Samples</h2>
    {problem.samples.map((s) => (
      <div key={s.name} className="mb-3 grid gap-2 md:grid-cols-2">
        <div>
          <div className="text-xs text-muted">Sample {s.name} input</div>
          <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-xs">{s.input}</pre>
        </div>
        <div>
          <div className="text-xs text-muted">Sample {s.name} output</div>
          <pre className="overflow-x-auto rounded bg-surface p-2 font-mono text-xs">{s.output}</pre>
        </div>
      </div>
    ))}
    </>
  );
}

/** Phones: read-only. The statement and samples, no editor (Monaco is not even loaded). */
function MobileProblem({ problem }: { problem: Problem }) {
  return (
    <main className="p-4" aria-labelledby="problem-title" data-testid="mobile-problem">
      <div role="note" className="mb-4 rounded-lg border border-line bg-surface p-3 text-sm" data-testid="mobile-note">
        You are on a small screen: read the problem here, and open it on a tablet or computer to write, run and submit code.
      </div>
      <StatementBody problem={problem} />
    </main>
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
        <Link to={`/profile?problem=${encodeURIComponent(slug)}`} className="text-xs text-accent hover:underline">
          View all
        </Link>
      </div>
      <ul className="space-y-1 text-sm" data-testid="my-submissions">
        {rows.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <button type="button" onClick={() => onOpen(s.id)} className={`font-mono text-xs hover:underline ${s.id === activeId ? "font-bold" : ""}`} title="Show the result here">
              {s.id.slice(0, 8)}
            </button>
            {s.verdict ? <VerdictBadge verdict={s.verdict} /> : <span className="text-xs text-muted">{s.status}</span>}
            <span className="text-xs text-muted">
              {s.language} · {new Date(s.created_at).toLocaleTimeString()}
            </span>
            <Link to={`/submissions/${s.id}`} className="text-xs text-accent hover:underline">
              Details
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
