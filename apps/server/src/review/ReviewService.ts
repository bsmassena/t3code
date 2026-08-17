import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewCommitDiffInput,
  type ReviewCommitDiffResult,
  type ReviewCommitListInput,
  type ReviewCommitListResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffFileActionInput,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly listCommits: (
      input: ReviewCommitListInput,
    ) => Effect.Effect<ReviewCommitListResult, ReviewDiffPreviewError>;
    readonly getCommitDiff: (
      input: ReviewCommitDiffInput,
    ) => Effect.Effect<ReviewCommitDiffResult, ReviewDiffPreviewError>;
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
    readonly runDiffFileAction: (
      input: ReviewDiffFileActionInput,
    ) => Effect.Effect<void, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation:
      | "ReviewService.getDiffPreview"
      | "ReviewService.listCommits"
      | "ReviewService.getCommitDiff"
      | "ReviewService.getDiffFileContents"
      | "ReviewService.runDiffFileAction",
    cwd: string,
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview" || operation === "ReviewService.getCommitDiff"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : operation === "ReviewService.listCommits"
            ? "Review commit list cwd must stay within the configured workspace root."
            : operation === "ReviewService.getDiffFileContents"
              ? "Review diff file contents cwd must stay within the configured workspace root."
              : "Review diff action cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const listCommits: ReviewService["Service"]["listCommits"] = Effect.fn(
    "ReviewService.listCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.listCommits", input.cwd);
    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.listCommits",
        kind: handle?.kind ?? "unknown",
        detail: "Commit history currently requires a Git repository.",
      });
    }
    return yield* git.listReviewCommits(input);
  });

  const getCommitDiff: ReviewService["Service"]["getCommitDiff"] = Effect.fn(
    "ReviewService.getCommitDiff",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getCommitDiff", input.cwd);
    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getCommitDiff",
        kind: handle?.kind ?? "unknown",
        detail: "Commit diffs currently require a Git repository.",
      });
    }
    return yield* git.getReviewCommitDiff(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  const runDiffFileAction: ReviewService["Service"]["runDiffFileAction"] = Effect.fn(
    "ReviewService.runDiffFileAction",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.runDiffFileAction", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.runDiffFileAction",
        kind: handle?.kind ?? "unknown",
        detail: "Per-file review actions currently require a Git repository.",
      });
    }

    return yield* git.runReviewDiffFileAction(input);
  });

  return ReviewService.of({
    listCommits,
    getCommitDiff,
    getDiffPreview,
    getDiffFileContents,
    runDiffFileAction,
  });
});

export const layer = Layer.effect(ReviewService, make);
