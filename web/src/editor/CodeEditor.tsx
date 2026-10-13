// Lazy-loaded (React.lazy) so Monaco lives in its own chunk.
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";

import { monaco } from "./monaco.ts";

export interface CodeEditorProps {
  language: "cpp" | "python";
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  dark: boolean;
}

export default function CodeEditor({ language, value, onChange, onSubmit, dark }: CodeEditorProps) {
  // Keep the latest callback without re-registering the Monaco command.
  const submit = useRef(onSubmit);
  useEffect(() => {
    submit.current = onSubmit;
  }, [onSubmit]);

  const onMount: OnMount = (editor) => {
    // Ctrl/Cmd+Enter inside the editor submits (the page also handles it globally).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submit.current());
    editor.focus();
  };

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={onMount}
      theme={dark ? "vs-dark" : "vs"}
      loading={<div className="p-4 text-sm text-zinc-500">Loading editor…</div>}
      options={{
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 4,
        automaticLayout: true,
        ariaLabel: "Code editor",
      }}
    />
  );
}
