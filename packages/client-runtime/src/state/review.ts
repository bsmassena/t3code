import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
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
