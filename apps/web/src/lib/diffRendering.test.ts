import { hydratePartialDiff } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";
import {
  buildFileDiffRenderKey,
  buildFileDiffUiStateKey,
  buildPatchCacheKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
} from "./diffRendering";

describe("resolveDiffThemeName", () => {
  it("keeps the T3 Code palette as the default", () => {
    expect(resolveDiffThemeName("light")).toBe("pierre-light");
    expect(resolveDiffThemeName("dark")).toBe("pierre-dark");
  });

  it("selects the matching VS Code palette for each appearance", () => {
    expect(resolveDiffThemeName("light", "vs-code")).toBe("light-plus");
    expect(resolveDiffThemeName("dark", "vs-code")).toBe("dark-plus");
  });
});

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getRenderablePatch", () => {
  it("compacts partial hunk render offsets for virtualized review diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,4 +48,4 @@",
      " context",
      "-before",
      "+after",
      " context",
      " context",
      "@@ -80,3 +80,4 @@",
      " context",
      "+added",
      " context",
      " context",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review", {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it("retains source-file offsets for checkpoint diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,1 +48,1 @@",
      "-before",
      "+after",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "checkpoint");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });
});

describe("buildFileDiffRenderKey", () => {
  it("keeps file identity stable when Pierre hydrates a partial diff", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "hydrated-key");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;
    const key = buildFileDiffRenderKey(file);
    file.cacheKey = `${file.cacheKey}:hydrated`;

    expect(buildFileDiffRenderKey(file)).toBe(key);
  });
});

describe("buildFileDiffUiStateKey", () => {
  const patch = (otherFileValue: string, exampleFileValue = "after") =>
    [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-before",
      `+${exampleFileValue}`,
      "diff --git a/other.ts b/other.ts",
      "--- a/other.ts",
      "+++ b/other.ts",
      "@@ -1 +1 @@",
      "-old",
      `+${otherFileValue}`,
    ].join("\n");

  const files = (value: string, exampleFileValue?: string) => {
    const parsed = getRenderablePatch(patch(value, exampleFileValue), "diff-panel:dark");
    expect(parsed?.kind).toBe("files");
    return parsed?.kind === "files" ? parsed.files : [];
  };

  it("keeps an unchanged file viewed when another file changes", () => {
    const before = files("first")[0];
    const after = files("second")[0];

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(buildFileDiffUiStateKey(before!)).toBe(buildFileDiffUiStateKey(after!));
  });

  it("changes when that file's own diff changes", () => {
    const before = files("first", "after")[0];
    const after = files("first", "changed again")[0];

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(buildFileDiffUiStateKey(before!)).not.toBe(buildFileDiffUiStateKey(after!));
  });

  it("does not depend on Pierre's global or hydrated cache key", () => {
    const file = files("first")[0];
    expect(file).toBeDefined();
    if (!file) return;
    const key = buildFileDiffUiStateKey(file);
    file.cacheKey = "different-theme-and-patch-key:hydrated";

    expect(buildFileDiffUiStateKey(file)).toBe(key);
  });

  it("stays stable when Pierre hydrates the diff with full file contents", () => {
    const parsed = getRenderablePatch(
      [
        "diff --git a/example.ts b/example.ts",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -3 +3 @@",
        "-before",
        "+after",
      ].join("\n"),
      "diff-panel:dark",
    );
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;
    const key = buildFileDiffUiStateKey(file);

    hydratePartialDiff("merge", file, {
      oldFile: { name: "example.ts", contents: "one\ntwo\nbefore\nfour\n" },
      newFile: { name: "example.ts", contents: "one\ntwo\nafter\nfour\n" },
    });

    expect(buildFileDiffUiStateKey(file)).toBe(key);
  });
});

describe("getDiffLineStat", () => {
  it("totals additions and deletions across every file and hunk", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-before",
      "+after",
      "+added",
      " context",
      "@@ -10,2 +11,1 @@",
      "-removed",
      " context",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " title",
      "+description",
    ].join("\n");

    const parsed = getRenderablePatch(patch);
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    expect(getDiffLineStat(parsed.files)).toEqual({ additions: 3, deletions: 2 });
  });
});
