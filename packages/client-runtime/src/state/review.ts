import {
  type ReviewDiffPreviewInput,
  VcsUnsupportedOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { request } from "../rpc/client.ts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const patchReads = Semaphore.makeUnsafe(4);
  const diffFileScheduler = createAtomCommandScheduler();
  return {
    commitList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:commit-list",
      tag: WS_METHODS.reviewListCommits,
      staleTimeMs: 5_000,
    }),
    commitDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:commit-diff",
      tag: WS_METHODS.reviewGetCommitDiff,
      staleTimeMs: 5_000,
    }),
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
    }),
    diffFilePatch: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-file-patch",
      staleTimeMs: 5 * 60_000,
      execute: (input: {
        request: ReviewDiffPreviewInput & { file: NonNullable<ReviewDiffPreviewInput["file"]> };
        cacheKey: string;
      }) =>
        request(WS_METHODS.reviewGetDiffPreview, input.request).pipe(
          patchReads.withPermit,
          Effect.flatMap((result) => {
            const source = result.sources.find(
              (source) => source.kind === input.request.file.sourceKind,
            );
            return source
              ? Effect.succeed(source)
              : Effect.fail(
                  new VcsUnsupportedOperationError({
                    operation: "review.diffFilePatch",
                    kind: "git",
                    detail: "Diff no longer available. Refresh the comparison.",
                  }),
                );
          }),
        ),
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:diff-file-contents",
      tag: WS_METHODS.reviewGetDiffFileContents,
      scheduler: diffFileScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.cwd,
            input.sourceKind,
            input.baseRef,
            input.headRef,
            input.oldPath,
            input.newPath,
            input.changeType,
          ]),
      },
    }),
    runDiffFileAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:run-diff-file-action",
      tag: WS_METHODS.reviewRunDiffFileAction,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
