import { useEffect } from "react";

/** Sets the browser tab title ("<page> · CodeJudge", or just "CodeJudge"). */
export function useTitle(page: string | null | undefined) {
  useEffect(() => {
    document.title = page ? `${page} · CodeJudge` : "CodeJudge";
  }, [page]);
}
