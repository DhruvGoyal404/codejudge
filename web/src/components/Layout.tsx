import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { theme } from "../lib/storage.ts";

function initialDark(): boolean {
  const saved = theme.get();
  if (saved) return saved === "dark";
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

export function useDarkMode() {
  const [dark, setDark] = useState(initialDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggle = () =>
    setDark((d) => {
      theme.set(d ? "light" : "dark");
      return !d;
    });
  return { dark, toggle };
}

export function Layout({ children, dark, onToggleDark }: { children: ReactNode; dark: boolean; onToggleDark: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <Link to="/" className="font-semibold tracking-tight">
          CodeJudge
        </Link>
        <button
          type="button"
          onClick={onToggleDark}
          className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {dark ? "☀ Light" : "☾ Dark"}
        </button>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      {children}
    </div>
  );
}
