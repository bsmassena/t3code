import { describe, expect, it } from "vite-plus/test";

import { areAllDiffFilesCollapsed, toggleAllDiffFileExpansion } from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set())).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("collapses all files when any rendered file is expanded", () => {
    expect(toggleAllDiffFileExpansion(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toEqual(new Set());
  });

  it("expands all files when every rendered file is collapsed", () => {
    expect(toggleAllDiffFileExpansion(FILE_KEYS, new Set())).toEqual(new Set(FILE_KEYS));
  });
});
