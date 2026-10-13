/// <reference types="vite/client" />

// Monaco's per-language registration modules have no type declarations;
// they are imported only for their side effects.
declare module "monaco-editor/languages/definitions/cpp/register";
declare module "monaco-editor/languages/definitions/python/register";
