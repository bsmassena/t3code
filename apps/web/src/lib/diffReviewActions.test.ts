import { describe, expect, it } from "vite-plus/test";

import { resolveDiffFileActions } from "./diffReviewActions";

describe("resolveDiffFileActions", () => {
  it.each([
    ["unstaged", "change", ["revert", "stage"]],
    ["unstaged", "new", ["revert", "stage"]],
    ["unstaged", "deleted", ["revert", "stage"]],
    ["unstaged", "rename-changed", ["stage"]],
    ["staged", "deleted", ["revert-staged", "unstage"]],
    ["staged", "rename-pure", ["revert-staged", "unstage"]],
  ] as const)("offers %s %s files %j", (source, changeType, actions) => {
    expect(resolveDiffFileActions(source, changeType)).toEqual(actions);
  });
});
