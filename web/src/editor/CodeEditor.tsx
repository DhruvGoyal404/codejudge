// Lazy-loaded (React.lazy) so Monaco lives in its own chunk.
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";

import type { Language } from "../api.ts";
import { DEFAULT_PREFS, type EditorSettings } from "../lib/storage.ts";
import { monaco } from "./monaco.ts";

export interface CodeEditorProps {
  language: Language;
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  dark: boolean;
  /** View-only (submission detail): no editing, no submit shortcut, no autofocus. */
  readOnly?: boolean;
  settings?: EditorSettings;
}

export default function CodeEditor({ language, value, onChange, onSubmit, dark, readOnly = false, settings = DEFAULT_PREFS.editor }: CodeEditorProps) {
  // Keep the latest callback without re-registering the Monaco command.
  const submit = useRef(onSubmit);
  useEffect(() => {
    submit.current = onSubmit;
  }, [onSubmit]);

  const onMount: OnMount = (editor) => {
    if (readOnly) return;
    // Ctrl/Cmd+Enter inside the editor submits (the page also handles it globally).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submit.current?.());
    editor.focus();
  };

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      onChange={(v) => onChange?.(v ?? "")}
      onMount={onMount}
      theme={dark ? "vs-dark" : "vs"}
      loading={<div className="p-4 text-sm text-zinc-500">Loading editor…</div>}
      options={{
        fontSize: settings.fontSize,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: settings.tabSize,
        wordWrap: settings.wordWrap ? "on" : "off",
        automaticLayout: true,
        ariaLabel: readOnly ? "Submitted code (read-only)" : "Code editor",
        readOnly,
        domReadOnly: readOnly,
      }}
    />
  );
}
