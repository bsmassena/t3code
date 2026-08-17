export const SYNTAX_THEME_STORAGE_KEY = "t3code:syntax-theme";

export const SYNTAX_THEME_PREFERENCES = ["t3-code", "vs-code"] as const;
export type SyntaxThemePreference = (typeof SYNTAX_THEME_PREFERENCES)[number];

export const DEFAULT_SYNTAX_THEME_PREFERENCE: SyntaxThemePreference = "t3-code";

export function isSyntaxThemePreference(value: unknown): value is SyntaxThemePreference {
  return SYNTAX_THEME_PREFERENCES.some((preference) => preference === value);
}
