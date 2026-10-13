import { useQuery } from "@tanstack/react-query";
import { Route, Routes } from "react-router";

// 4a scaffold: proves routing, TanStack Query and the /api proxy work.
// The real pages arrive in 4c.
export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const r = await fetch("/api/health");
      return (await r.json()) as { ok: boolean; postgres: boolean; valkey: boolean };
    },
  });
  return (
    <Routes>
      <Route
        path="*"
        element={
          <main className="p-6 font-sans">
            <h1 className="text-2xl font-semibold">CodeJudge</h1>
            <p className="mt-2 text-sm text-zinc-500">
              API: {health.isPending ? "…" : health.data?.ok ? "healthy" : "unavailable"}
            </p>
          </main>
        }
      />
    </Routes>
  );
}
