// Monaco, bundled locally (no CDN), trimmed to what the judge needs:
// the editor core, C++ and Python syntax support, and the base editor worker.
// No TypeScript/JSON/CSS/HTML language services are pulled in.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/python/register";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

loader.config({ monaco });

export { monaco };
