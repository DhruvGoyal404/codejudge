import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router";

import { loginUrl } from "../api.ts";
import { theme } from "../lib/storage.ts";
import { loginErrorMessage, useLogout, useMe } from "../lib/useMe.ts";

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

const buttonClass = "rounded border border-line px-2 py-1 text-sm whitespace-nowrap hover:bg-surface";

/** "Log in with GitHub": a full navigation to the API (not a client-side route). */
export function LoginLink({ children = "Log in with GitHub", className = buttonClass }: { children?: ReactNode; className?: string }) {
  const loc = useLocation();
  return (
    <a href={loginUrl(loc.pathname + loc.search)} className={className}>
      {children}
    </a>
  );
}

function Account() {
  const me = useMe();
  const logout = useLogout();
  if (me.isPending) return <span className="text-sm text-muted">…</span>;
  if (!me.data) return <LoginLink />;
  return (
    <div className="flex items-center gap-2">
      <Link to="/profile" className="flex items-center gap-2 text-sm hover:underline" data-testid="account">
        {me.data.avatar_url && <img src={me.data.avatar_url} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />}
        <span className="sr-only sm:not-sr-only">{me.data.login}</span>
      </Link>
      <button type="button" className={buttonClass} onClick={() => logout.mutate()} disabled={logout.isPending}>
        Log out
      </button>
    </div>
  );
}

function LoginErrorBanner() {
  const [params, setParams] = useSearchParams();
  const message = loginErrorMessage(params.get("login_error"));
  if (!message) return null;
  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete("login_error");
    setParams(next, { replace: true });
  };
  return (
    <div className="px-4 pt-2">
      <ErrorBanner>
        {message}{" "}
        <button type="button" className="underline" onClick={dismiss}>
          Dismiss
        </button>
      </ErrorBanner>
    </div>
  );
}

export function Layout({ children, dark, onToggleDark }: { children: ReactNode; dark: boolean; onToggleDark: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <nav aria-label="Main" className="flex items-center gap-4">
          <Link to="/" className="font-semibold tracking-tight">
            CodeJudge
          </Link>
          <NavLink
            to="/problems"
            end
            className={({ isActive }) => `text-sm hover:underline ${isActive ? "font-medium text-fg" : "text-muted"}`}
          >
            Problems
          </NavLink>
        </nav>
        <div className="flex items-center gap-2">
          <Account />
          <button
            type="button"
            onClick={onToggleDark}
            className={buttonClass}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            <span aria-hidden="true">{dark ? "☀" : "☾"}</span>
            <span className="sr-only sm:not-sr-only sm:ml-1">{dark ? "Light" : "Dark"}</span>
          </button>
        </div>
      </header>
      <LoginErrorBanner />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded border border-hard-fg/40 bg-hard-bg px-3 py-2 text-sm text-hard-fg">
      {children}
    </div>
  );
}
