/* Fine-grained Shiki: the core, the JavaScript regex engine (no WASM), six grammars (each loaded on demand) and one theme.
 * This module is only ever reached through a dynamic import from CodeBlock, so it lands in its own chunk. */
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export const CODE_LANGS = ["typescript", "tsx", "javascript", "jsx", "sql", "json"] as const;
export type CodeLang = (typeof CODE_LANGS)[number];

export const THEME_NAME = "codeloom-gallery";

/* Gallery Guide colours. Every foreground is ≥ 4.5:1 on the code ground (#F3F4F1).
 * Oxblood is kept out on purpose: it means "error / broken hop" everywhere else. */
const C = {
  ink: "#1A1D1C",
  quiet: "#5C6661",
  punct: "#4A524E",
  viridian: "#1F4D45",
  blue: "#2F5E9E",
  umber: "#8A5A2B",
  ochre: "#8F6410",
};

export const galleryTheme: ThemeRegistration = {
  name: THEME_NAME,
  type: "light",
  colors: { "editor.background": "#F3F4F1", "editor.foreground": C.ink },
  tokenColors: [
    { settings: { foreground: C.ink } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: C.quiet, fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.operator.new", "keyword.operator.expression"], settings: { foreground: C.viridian } },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: C.punct } },
    { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: C.umber } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant"], settings: { foreground: C.ochre } },
    { scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function"], settings: { foreground: C.blue } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"], settings: { foreground: C.blue, fontStyle: "italic" } },
    { scope: ["entity.name.tag", "support.class.component"], settings: { foreground: C.viridian } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: C.blue } },
    { scope: ["support.type.property-name.json", "meta.object-literal.key"], settings: { foreground: C.viridian } },
    { scope: ["variable", "variable.other", "meta.definition.variable"], settings: { foreground: C.ink } },
  ],
};

/* Each grammar is its own lazy chunk, loaded the first time a block in that language is shown. */
const GRAMMARS: Record<CodeLang, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  json: () => import("shiki/langs/json.mjs"),
};

let pending: Promise<HighlighterCore> | undefined;
const loading = new Map<CodeLang, Promise<void>>();

/** One shared highlighter (theme only), created on first use. */
export function getHighlighter(): Promise<HighlighterCore> {
  pending ??= createHighlighterCore({ themes: [galleryTheme], langs: [], engine: createJavaScriptRegexEngine() });
  return pending;
}

/** The highlighter with `lang`'s grammar loaded. */
export async function getHighlighterFor(lang: CodeLang): Promise<HighlighterCore> {
  const hl = await getHighlighter();
  let p = loading.get(lang);
  if (!p) {
    p = GRAMMARS[lang]().then((m) => hl.loadLanguage(m.default));
    loading.set(lang, p);
  }
  await p;
  return hl;
}

export interface Token {
  content: string;
  color?: string;
  italic: boolean;
  bold: boolean;
}

/** Code → one array of coloured tokens per line. */
export async function highlightLines(code: string, lang: CodeLang): Promise<Token[][]> {
  const hl = await getHighlighterFor(lang);
  const { tokens } = hl.codeToTokens(code, { lang, theme: THEME_NAME });
  return tokens.map((line) =>
    line.map((t) => ({ content: t.content, color: t.color, italic: ((t.fontStyle ?? 0) & 1) !== 0, bold: ((t.fontStyle ?? 0) & 2) !== 0 })),
  );
}
