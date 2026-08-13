import { describe, expect, it } from "vite-plus/test";

import { resolveDiffFileActions } from "./diffReviewActions";

describe("resolveDiffFileActions", () => {
  it("offers stage and revert for tracked unstaged changes", () => {
    expect(
      resolveDiffFileActions({ scope: "unstaged", changeType: "change", isCheckpoint: false }),
    ).toEqual(["revert", "stage"]);
  });

  it("does not offer destructive revert for an untracked file", () => {
    expect(
      resolveDiffFileActions({ scope: "unstaged", changeType: "new", isCheckpoint: false }),
    ).toEqual(["stage"]);
    expect(
      resolveDiffFileActions({
        scope: "unstaged",
        changeType: "rename-changed",
        isCheckpoint: false,
      }),
    ).toEqual(["stage"]);
  });

  it("offers only unstage for staged files", () => {
    expect(
      resolveDiffFileActions({ scope: "staged", changeType: "deleted", isCheckpoint: false }),
    ).toEqual(["unstage"]);
  });

  it("keeps branch and checkpoint diffs read-only", () => {
    expect(
      resolveDiffFileActions({ scope: "branch", changeType: "change", isCheckpoint: false }),
    ).toEqual([]);
    expect(
      resolveDiffFileActions({ scope: "unstaged", changeType: "change", isCheckpoint: true }),
    ).toEqual([]);
  });
});
