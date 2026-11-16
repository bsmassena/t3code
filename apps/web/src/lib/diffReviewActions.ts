import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  ReviewDiffFileActionInput,
  ReviewLocalDiffPreviewSourceKind,
} from "@t3tools/contracts";

export type DiffFileAction = ReviewDiffFileActionInput["action"];

export function resolveDiffFileActions(
  source: ReviewLocalDiffPreviewSourceKind,
  changeType: FileDiffMetadata["type"],
): ReadonlyArray<DiffFileAction> {
  if (source === "staged") return ["revert-staged", "unstage"];
  // Reverting a rename would need both paths restored; staging it is still safe.
  return changeType === "rename-pure" || changeType === "rename-changed"
    ? ["stage"]
    : ["revert", "stage"];
}
