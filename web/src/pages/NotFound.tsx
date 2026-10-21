import { Link } from "react-router";

import { useTitle } from "../lib/useTitle.ts";

export function NotFound() {
  useTitle("Page not found", "This page does not exist on CodeJudge.");
  return (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted">There is nothing at this address. It may have moved, or the link may be mistyped.</p>
      <div className="mt-6 flex justify-center gap-3">
        <Link to="/problems" className="rounded bg-accent px-4 py-2 font-medium text-on-accent hover:bg-accent-hover">
          Browse problems
        </Link>
        <Link to="/" className="rounded border border-line px-4 py-2 font-medium hover:bg-surface">
          Home
        </Link>
      </div>
    </main>
  );
}
