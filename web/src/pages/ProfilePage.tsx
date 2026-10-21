import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { api, NetworkError, VERDICTS, type Verdict } from "../api.ts";
import { ErrorBanner, LoginLink } from "../components/Layout.tsx";
import { ProblemStatus } from "../components/ProblemStatus.tsx";
import { VerdictBadge } from "../components/VerdictBadge.tsx";
import { useMe } from "../lib/useMe.ts";
import { useTitle } from "../lib/useTitle.ts";

/** The logged-in user's profile: solved/attempted problems and full submission history. */
export function ProfilePage() {
  useTitle("Profile", "Your CodeJudge progress: solved problems and recent submissions.");
  const me = useMe();
  if (me.isPending) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (me.isError) return <div className="p-4"><ErrorBanner>{me.error.message}</ErrorBanner></div>;
  if (!me.data) {
    return (
      <main className="mx-auto max-w-3xl space-y-3 p-4">
        <p>Log in to see your profile and submissions.</p>
        <LoginLink />
      </main>
    );
  }
  return <Profile login={me.data.login} avatar={me.data.avatar_url} />;
}

function Profile({ login, avatar }: { login: string; avatar: string | null }) {
  const [params, setParams] = useSearchParams();
  const problem = params.get("problem") ?? "";
  const verdict = (VERDICTS as string[]).includes(params.get("verdict") ?? "") ? (params.get("verdict") as Verdict) : undefined;
  const setFilter = (key: "problem" | "verdict", value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const problems = useQuery({ queryKey: ["problems"], queryFn: api.problems });
  const solved = problems.data?.filter((p) => p.my_status === "solved") ?? [];
  const attempted = problems.data?.filter((p) => p.my_status === "attempted") ?? [];

  const history = useInfiniteQuery({
    queryKey: ["history", "all", { problem, verdict }],
    queryFn: ({ pageParam }) => api.history({ problem: problem || undefined, verdict, limit: 20, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = history.data?.pages.flatMap((p) => p.submissions) ?? [];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4">
      <div className="flex items-center gap-3">
        {avatar && <img src={avatar} alt="" className="h-12 w-12 rounded-full" referrerPolicy="no-referrer" />}
        <div>
          <h1 className="text-xl font-semibold">{login}</h1>
          <p className="text-sm text-muted" data-testid="profile-stats">
            {problems.data ? `${solved.length} solved · ${attempted.length} attempted` : "…"}
          </p>
        </div>
      </div>

      {problems.data && (solved.length > 0 || attempted.length > 0) && (
        <ul className="flex flex-wrap gap-2 text-sm">
          {[...solved, ...attempted].map((p) => (
            <li key={p.slug} className="flex items-center gap-1">
              <Link to={`/problems/${p.slug}`} className="text-accent underline">
                {p.title}
              </Link>
              <ProblemStatus status={p.my_status} />
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Submission history" className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">Submissions</h2>
          <label className="text-sm">
            Problem{" "}
            <select value={problem} onChange={(e) => setFilter("problem", e.target.value)} className="rounded border border-line bg-canvas px-1 py-0.5" aria-label="Filter by problem">
              <option value="">All</option>
              {problems.data?.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Verdict{" "}
            <select value={verdict ?? ""} onChange={(e) => setFilter("verdict", e.target.value)} className="rounded border border-line bg-canvas px-1 py-0.5" aria-label="Filter by verdict">
              <option value="">All</option>
              {VERDICTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>

        {history.isError && (
          <ErrorBanner>{history.error instanceof NetworkError ? history.error.message : `Could not load submissions: ${history.error.message}`}</ErrorBanner>
        )}
        {history.isPending && <p className="text-sm text-muted">Loading…</p>}
        {history.isSuccess && rows.length === 0 && <p className="text-sm text-muted">No submissions yet.</p>}
        {rows.length > 0 && (
          <table className="w-full text-left text-sm" data-testid="history-table">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2">When</th>
                <th className="py-2">Problem</th>
                <th className="py-2">Language</th>
                <th className="py-2">Result</th>
                <th className="py-2 text-right">CPU</th>
                <th className="py-2 text-right">Memory</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="py-2">
                    <Link to={`/submissions/${s.id}`} className="text-accent hover:underline">
                      {new Date(s.created_at).toLocaleString()}
                    </Link>
                  </td>
                  <td className="py-2">{s.problem_title}</td>
                  <td className="py-2">{s.language}</td>
                  <td className="py-2">{s.verdict ? <VerdictBadge verdict={s.verdict} /> : <span className="text-xs text-muted">{s.status}</span>}</td>
                  <td className="py-2 text-right tabular-nums">{s.max_cpu_ms != null ? `${s.max_cpu_ms} ms` : "—"}</td>
                  <td className="py-2 text-right tabular-nums">{s.max_rss_kb != null ? `${(s.max_rss_kb / 1024).toFixed(1)} MB` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history.hasNextPage && (
          <button
            type="button"
            onClick={() => history.fetchNextPage()}
            disabled={history.isFetchingNextPage}
            className="rounded border border-line px-3 py-1 text-sm hover:bg-surface disabled:opacity-50"
          >
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </main>
  );
}
