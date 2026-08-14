import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { DiffFileNavigator } from "./DiffFileNavigator";

describe("DiffFileNavigator", () => {
  it("groups diff files by directory and shows per-file stats", () => {
    const patch = [
      "diff --git a/src/components/App.tsx b/src/components/App.tsx",
      "--- a/src/components/App.tsx",
      "+++ b/src/components/App.tsx",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/lib/value.ts b/src/lib/value.ts",
      "--- a/src/lib/value.ts",
      "+++ b/src/lib/value.ts",
      "@@ -1 +1,2 @@",
      " export const first = 1;",
      "+export const second = 2;",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "navigator-test");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const markup = renderToStaticMarkup(
      <DiffFileNavigator
        files={parsed.files.map((fileDiff, index) => ({
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey: `file-${index}`,
        }))}
        selectedFileKey="file-0"
        theme="dark"
        onSelectFile={() => undefined}
      />,
    );

    expect(markup).toContain("src");
    expect(markup).toContain("components");
    expect(markup).toContain("App.tsx");
    expect(markup).toContain("value.ts");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).toContain("bg-accent");
    expect(markup).toContain("data-diff-tree-guide");
    expect(markup).not.toContain("Changed file");
  });
});
