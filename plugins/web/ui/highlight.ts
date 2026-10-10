// Code highlighting with highlight.js core and only the grammars workers actually print.
// The full highlight.js build (≈190 grammars) was most of the page's JavaScript.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const GRAMMARS = { bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar);

/** The fence language from a `language-xyz` class, if any. */
export const fenceLanguage = (className?: string) => className?.match(/(?:^|\s)language-([\w+#.-]+)/)?.[1]?.toLowerCase() ?? null;

/**
 * Highlighted HTML for a fenced block, or null when the language is unknown or missing (render plain text then).
 * highlight.js escapes the source; the result holds only its own <span class="hljs-…"> tags.
 */
export function highlight(code: string, language: string | null): string | null {
  if (!language || !hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
