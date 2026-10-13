import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api.ts";

/** The logged-in user (null when logged out; undefined while loading). */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60_000 });
}

/** Logs out (deletes the server-side session) and forgets all per-user data. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      qc.setQueryData(["me"], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
  });
}

const LOGIN_ERRORS: Record<string, string> = {
  state: "Login failed: the login link expired or was already used. Please try again.",
  denied: "GitHub login was cancelled.",
  github: "GitHub login failed. Please try again.",
};

/** Message for the API's /?login_error=<code> redirect, if any. */
export function loginErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return LOGIN_ERRORS[code] ?? "Login failed. Please try again.";
}
