import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  includeLocalSources: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewLocalDiffPreviewSourceKind = Schema.Literals(["unstaged", "staged"]);
export type ReviewLocalDiffPreviewSourceKind = typeof ReviewLocalDiffPreviewSourceKind.Type;

export const ReviewDiffFileSourceKind = Schema.Literals([
  "working-tree",
  "unstaged",
  "staged",
  "branch-range",
  "commit",
]);
export type ReviewDiffFileSourceKind = typeof ReviewDiffFileSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewCommitDiffSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literal("commit"),
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: TrimmedNonEmptyString,
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewCommitDiffSource = typeof ReviewCommitDiffSource.Type;

export const ReviewLocalDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewLocalDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewLocalDiffPreviewSource = typeof ReviewLocalDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffFileSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffFileActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  previousFilePath: Schema.optional(TrimmedNonEmptyString),
  action: Schema.Literals(["stage", "unstage", "revert", "revert-staged"]),
});
export type ReviewDiffFileActionInput = typeof ReviewDiffFileActionInput.Type;

export const ReviewCommitListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type ReviewCommitListInput = typeof ReviewCommitListInput.Type;

export const ReviewCommitSummary = Schema.Struct({
  sha: TrimmedNonEmptyString,
  subject: TrimmedNonEmptyString,
  committedAt: TrimmedNonEmptyString,
});
export type ReviewCommitSummary = typeof ReviewCommitSummary.Type;

export const ReviewCommitListResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  commits: Schema.Array(ReviewCommitSummary),
});
export type ReviewCommitListResult = typeof ReviewCommitListResult.Type;

export const ReviewCommitDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  commitSha: TrimmedNonEmptyString.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewCommitDiffInput = typeof ReviewCommitDiffInput.Type;

export const ReviewCommitDiffResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  source: ReviewCommitDiffSource,
});
export type ReviewCommitDiffResult = typeof ReviewCommitDiffResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
  localSources: Schema.optional(Schema.Array(ReviewLocalDiffPreviewSource)),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
