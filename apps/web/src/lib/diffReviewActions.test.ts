import { describe, expect, it } from "vite-plus/test";

import {
  resolveDiffFileActions,
  recordCompletedDiffFileAction,
  getCompletedDiffFiles,
  needsDiffActionRefresh,
} from "./diffReviewActions";

describe("confirmed diff actions", () => {
  it("removes multiple confirmed files only from their scope and cached response", () => {
    const preview = {};
    recordCompletedDiffFileAction(preview, "revert", "new [1].ts");
    recordCompletedDiffFileAction(preview, "revert", "deleted.ts");
    const paths = ["new [1].ts", "new 1.ts", "deleted.ts", "modified.ts"];
    expect(paths.filter((path) => !getCompletedDiffFiles(preview, "unstaged")?.has(path))).toEqual([
      "new 1.ts",
      "modified.ts",
    ]);
    expect(getCompletedDiffFiles(preview, "staged")).toBeUndefined();
    expect(needsDiffActionRefresh(preview, "unstaged")).toBe(false);
    expect(needsDiffActionRefresh(preview, "working-tree")).toBe(true);
    expect(needsDiffActionRefresh(preview, "staged")).toBe(true);
    const refreshedPreview = {};
    expect(getCompletedDiffFiles(refreshedPreview, "unstaged")).toBeUndefined();
    expect(needsDiffActionRefresh(refreshedPreview, "unstaged")).toBe(false);
  });
  it.each(["stage", "unstage"] as const)(
    "removes both rename paths after %s and refreshes the destination on demand",
    (action) => {
      const preview = {};
      const source = action === "stage" ? "unstaged" : "staged";
      const destination = action === "stage" ? "staged" : "unstaged";
      recordCompletedDiffFileAction(preview, action, "new.ts", "old.ts");
      expect(getCompletedDiffFiles(preview, source)).toEqual(new Set(["new.ts", "old.ts"]));
      expect(needsDiffActionRefresh(preview, source)).toBe(false);
      expect(getCompletedDiffFiles(preview, destination)).toBeUndefined();
      expect(needsDiffActionRefresh(preview, destination)).toBe(true);
    },
  );
});

describe("resolveDiffFileActions", () => {
  it("offers stage and revert for tracked unstaged changes", () => {
    expect(
      resolveDiffFileActions({ scope: "unstaged", changeType: "change", isCheckpoint: false }),
    ).toEqual(["revert", "stage"]);
  });

  it("offers revert for a new file but not a rename", () => {
    expect(
      resolveDiffFileActions({ scope: "unstaged", changeType: "new", isCheckpoint: false }),
    ).toEqual(["revert", "stage"]);
    expect(
      resolveDiffFileActions({
        scope: "unstaged",
        changeType: "rename-changed",
        isCheckpoint: false,
      }),
    ).toEqual(["stage"]);
  });

  it("offers revert and unstage for staged files", () => {
    expect(
      resolveDiffFileActions({ scope: "staged", changeType: "deleted", isCheckpoint: false }),
    ).toEqual(["revert", "unstage"]);
  });

  it("keeps branch and checkpoint diffs read-only", () => {
    expect(
      resolveDiffFileActions({ scope: "branch", changeType: "change", isCheckpoint: false }),
    ).toEqual([]);
    expect(
      resolveDiffFileActions({ scope: "unstaged", changeType: "change", isCheckpoint: true }),
    ).toEqual([]);
    expect(
      resolveDiffFileActions({ scope: "working-tree", changeType: "change", isCheckpoint: false }),
    ).toEqual([]);
  });
});
