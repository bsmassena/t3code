import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import { DIFF_THEME_NAME_VALUES } from "./diffRendering";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [...DIFF_THEME_NAME_VALUES],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(language);
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw error;
    }
    // Language not supported by Shiki — fall back to "text"
    return getSyntaxHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}
