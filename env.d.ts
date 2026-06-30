/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

// Optional dependencies — dynamic imports that may fail at runtime
declare module 'tree-sitter' {
  export default class Parser {
    setLanguage(lang: unknown): void;
    parse(source: string): { rootNode: unknown };
  }
}

declare module 'tree-sitter-bash' {
  const language: unknown;
  export default language;
}

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
