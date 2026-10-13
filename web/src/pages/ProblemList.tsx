import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api, NetworkError } from "../api.ts";
import { ErrorBanner } from "../components/Layout.tsx";
import { ProblemStatus } from "../components/ProblemStatus.tsx";

export function ProblemList() {
  const q = useQuery({ queryKey: ["problems"], queryFn: api.problems });
  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="mb-4 text-xl font-semibold">Problems</h1>
      {q.isPending && <p className="text-sm text-zinc-500">Loading…</p>}
      {q.isError && (
        <ErrorBanner>
          {q.error instanceof NetworkError ? q.error.message : `Could not load problems: ${q.error.message}`}{" "}
          <button className="underline" onClick={() => q.refetch()}>
            Retry
          </button>
        </ErrorBanner>
      )}
      {q.data && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-2">Title</th>
              <th className="py-2">Status</th>
              <th className="py-2 text-right">Time</th>
              <th className="py-2 text-right">Memory</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((p) => (
              <tr key={p.slug} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="py-2">
                  <Link to={`/problems/${p.slug}`} className="text-blue-700 hover:underline dark:text-blue-400">
                    {p.title}
                  </Link>
                </td>
                <td className="py-2">
                  <ProblemStatus status={p.my_status} />
                </td>
                <td className="py-2 text-right tabular-nums">{p.time_limit_ms / 1000} s</td>
                <td className="py-2 text-right tabular-nums">{p.memory_limit_mb} MB</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
