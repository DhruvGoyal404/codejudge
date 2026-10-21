import { useEffect } from "react";

export const DEFAULT_DESCRIPTION =
  "Practise algorithms on CodeJudge: 100 original problems, from easy warm-ups to hard classics, judged on hidden tests in a gVisor sandbox. C, C++, Go, Python, Java and JavaScript.";

/**
 * Sets the browser tab title ("<page> · CodeJudge", or just "CodeJudge") and
 * the page's meta description (index.html has the default one).
 */
export function useTitle(page: string | null | undefined, description: string = DEFAULT_DESCRIPTION) {
  useEffect(() => {
    document.title = page ? `${page} · CodeJudge` : "CodeJudge";
    document.querySelector('meta[name="description"]')?.setAttribute("content", description);
  }, [page, description]);
}
