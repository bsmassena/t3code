import type { FileDiffMetadata } from "@pierre/diffs";

export type DiffFileAction = "stage" | "unstage" | "revert";

export function resolveDiffFileActions(input: {
  readonly scope: "branch" | "unstaged" | "staged";
  readonly changeType: FileDiffMetadata["type"];
  readonly isCheckpoint: boolean;
}): ReadonlyArray<DiffFileAction> {
  if (input.isCheckpoint || input.scope === "branch") return [];
  if (input.scope === "staged") return ["unstage"];
  return input.changeType === "change" || input.changeType === "deleted"
    ? ["revert", "stage"]
    : ["stage"];
}
