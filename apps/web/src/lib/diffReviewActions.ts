import type { FileDiffMetadata } from "@pierre/diffs";

export type DiffFileAction = "stage" | "unstage" | "revert";

// Keep successful file actions attached to the cached response, including across panel remounts.
const completedFiles = new WeakMap<object, Map<string, Set<string>>>();

export function recordCompletedDiffFileAction(
  preview: object,
  action: DiffFileAction | "revert-staged",
  filePath: string,
  previousFilePath?: string,
) {
  const scope = action === "stage" || action === "revert" ? "unstaged" : "staged";
  const scopes = completedFiles.get(preview) ?? new Map<string, Set<string>>();
  const paths = scopes.get(scope) ?? new Set<string>();
  paths.add(filePath);
  if (previousFilePath) paths.add(previousFilePath);
  scopes.set(scope, paths);
  completedFiles.set(preview, scopes);
}

export function getCompletedDiffFiles(preview: object | null, scope: string) {
  return preview ? completedFiles.get(preview)?.get(scope) : undefined;
}

export function needsDiffActionRefresh(preview: object | null, scope: string) {
  return preview !== null && completedFiles.has(preview) && !getCompletedDiffFiles(preview, scope);
}

export function resolveDiffFileActions(input: {
  readonly scope: "branch" | "working-tree" | "unstaged" | "staged";
  readonly changeType: FileDiffMetadata["type"];
  readonly isCheckpoint: boolean;
}): ReadonlyArray<DiffFileAction> {
  if (input.isCheckpoint || input.scope === "branch" || input.scope === "working-tree") return [];
  if (input.scope === "staged") return ["revert", "unstage"];
  return input.changeType === "change" ||
    input.changeType === "deleted" ||
    input.changeType === "new"
    ? ["revert", "stage"]
    : ["stage"];
}
