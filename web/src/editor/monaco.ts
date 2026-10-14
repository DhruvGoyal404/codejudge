// Monaco, bundled locally (no CDN), trimmed to what the judge needs:
// the editor core, C++/Python/Java/JavaScript syntax support (Monarch
// tokenizers only) and the base editor worker.
// No TypeScript/JSON/CSS/HTML language services are pulled in.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import editorWorkerUrl from "monaco-editor/editor/editor.worker?worker&url";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/javascript/register";

// The production CSP enforces Trusted Types for scripts (require-trusted-types-for
// 'script'): a Worker URL must come from a policy. This one only accepts our
// own bundled worker scripts.
type ScriptURLPolicy = { createScriptURL: (url: string) => string };
const tt = (globalThis as { trustedTypes?: { createPolicy: (name: string, rules: { createScriptURL: (u: string) => string }) => ScriptURLPolicy } }).trustedTypes;
const workerPolicy: ScriptURLPolicy = tt
  ? tt.createPolicy("codejudge-worker", {
      createScriptURL: (url) => {
        const u = new URL(url, location.href);
        if (u.origin !== location.origin || !/^\/assets\/[\w.-]+\.js$|^\/node_modules\/|^\/@fs\//.test(u.pathname)) {
          throw new TypeError(`refusing worker script ${u.href}`);
        }
        return u.href;
      },
    })
  : { createScriptURL: (url) => url };

self.MonacoEnvironment = {
  // Vite serves ES-module workers in dev and emits a classic (IIFE) worker in builds.
  getWorker: () =>
    new Worker(workerPolicy.createScriptURL(editorWorkerUrl) as unknown as string, { type: import.meta.env.DEV ? "module" : "classic" }),
};

loader.config({ monaco });

export { monaco };
