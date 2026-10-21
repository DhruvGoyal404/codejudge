import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { api, LANGUAGES, type Difficulty, type ProblemSummary } from "../api.ts";
import { DifficultyBadge } from "../components/DifficultyBadge.tsx";
import { LoginLink } from "../components/Layout.tsx";
import { DIFFICULTIES } from "../lib/problemFilters.ts";
import { useMe } from "../lib/useMe.ts";
import { useTitle } from "../lib/useTitle.ts";

const FEATURES = [
  {
    title: "Run before you submit",
    body: "Try your code on the samples or on your own input, under the problem's real limits. Runs never count against you.",
  },
  {
    title: "Judged in a sandbox",
    body: "Every submission runs in an isolated, network-less container against hidden tests, with exact time and memory verdicts.",
  },
  {
    title: "Four languages",
    body: `${LANGUAGES.map((l) => l.label).join(", ")}, with starter code, fair per-language time limits and live judging progress.`,
  },
];

/** One problem per difficulty to start with: the first the user has not solved yet. */
function picks(problems: ProblemSummary[]): ProblemSummary[] {
  return DIFFICULTIES.map((d) => problems.find((p) => p.difficulty === d && p.my_status !== "solved") ?? problems.find((p) => p.difficulty === d)).filter(
    (p): p is ProblemSummary => !!p,
  );
}

export function Landing() {
  useTitle(null);
  const me = useMe();
  const q = useQuery({ queryKey: ["problems"], queryFn: api.problems });
  const count = (d: Difficulty) => q.data?.filter((p) => p.difficulty === d).length ?? 0;
  const solved = q.data?.filter((p) => p.my_status === "solved").length ?? 0;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <section className="space-y-4" aria-labelledby="landing-title">
        <img src="/logo-64.png" alt="" width={64} height={64} className="size-16" />
        <h1 id="landing-title" className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Practise algorithms on a judge you can trust.
        </h1>
        <p className="max-w-2xl text-lg text-muted">
          Original problems from easy warm-ups to hard classics, judged on hidden tests in a locked-down sandbox.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/problems" className="rounded bg-accent px-4 py-2 font-medium text-on-accent hover:bg-accent-hover">
            Browse problems
          </Link>
          {me.data === null && (
            <LoginLink className="rounded border border-line px-4 py-2 font-medium hover:bg-surface">Log in with GitHub</LoginLink>
          )}
          {me.data && (
            <Link to="/profile" className="rounded border border-line px-4 py-2 font-medium hover:bg-surface">
              Your progress
            </Link>
          )}
        </div>
      </section>

      <section aria-label="Catalogue" className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="landing-stats">
        {q.isPending ? (
          Array.from({ length: 4 }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-surface" />)
        ) : (
          <>
            <Stat label="problems" value={q.data?.length ?? 0} />
            {DIFFICULTIES.map((d) => (
              <Stat key={d} label={<DifficultyBadge difficulty={d} />} value={count(d)} />
            ))}
          </>
        )}
      </section>
      {me.data && q.data && (
        <p className="mt-3 text-sm text-muted" data-testid="landing-progress">
          You have solved {solved} of {q.data.length}.
        </p>
      )}

      <section aria-labelledby="features-title" className="mt-12">
        <h2 id="features-title" className="sr-only">
          Features
        </h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.title} className="rounded-lg border border-line p-4">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted">{f.body}</p>
            </li>
          ))}
        </ul>
      </section>

      {q.data && q.data.length > 0 && (
        <section aria-labelledby="start-title" className="mt-12">
          <h2 id="start-title" className="mb-3 text-lg font-semibold">
            {me.data ? "Up next" : "Start here"}
          </h2>
          <ul className="grid gap-3 md:grid-cols-3" data-testid="landing-picks">
            {picks(q.data).map((p) => (
              <li key={p.slug}>
                <Link to={`/problems/${p.slug}`} className="block h-full rounded-lg border border-line p-4 hover:bg-surface">
                  <div className="mb-2">
                    <DifficultyBadge difficulty={p.difficulty} />
                  </div>
                  <div className="font-medium text-accent">{p.title}</div>
                  <div className="mt-1 text-xs text-muted">{p.tags.join(" · ")}</div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: ReactNode; value: number }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-sm text-muted">{label}</div>
    </div>
  );
}
