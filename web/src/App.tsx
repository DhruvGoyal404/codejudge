import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { Route, Routes } from "react-router";

const CodeEditor = lazy(() => import("./editor/CodeEditor.tsx"));

// 4a scaffold: proves routing, TanStack Query and the /api proxy work.
// The real pages arrive in 4c.
export function App() {
  const [code, setCode] = useState("int main() {}\n");
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
            <div className="mt-4 h-80 border">
              <Suspense fallback={<div>Loading editor…</div>}>
                <CodeEditor language="cpp" value={code} onChange={setCode} onSubmit={() => {}} dark={false} />
              </Suspense>
            </div>
          </main>
        }
      />
    </Routes>
  );
}
