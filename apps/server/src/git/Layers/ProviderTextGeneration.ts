import { randomUUID } from "node:crypto";

import { TextGenerationError, ThreadId } from "@t3tools/contracts";
import { Deferred, Duration, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationInput,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  TextGeneration,
  type ThreadTitleGenerationResult,
} from "../Services/TextGeneration.ts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

const PROVIDER_TEXT_GENERATION_TIMEOUT = Duration.seconds(180);

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function buildProviderOnlyPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Additional rules:",
    "- Do not use tools, commands, file reads, web access, or repository inspection.",
    "- Respond with exactly one JSON object and no markdown fences or extra prose.",
  ].join("\n");
}

const makeProviderTextGeneration = Effect.gen(function* () {
  const providerService = yield* ProviderService;

  const runProviderJson = Effect.fn("ProviderTextGeneration.runProviderJson")(function* <
    S extends Schema.Top,
  >({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    attachments,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: CommitMessageGenerationInput["modelSelection"];
    attachments?: BranchNameGenerationInput["attachments"];
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make(`textgen:${operation}:${randomUUID()}`);
        const responseTextRef = yield* Ref.make("");
        const responseReady = yield* Deferred.make<string, TextGenerationError>();

        const failResponse = (detail: string, cause?: unknown) =>
          Deferred.fail(
            responseReady,
            new TextGenerationError({
              operation,
              detail,
              ...(cause !== undefined ? { cause } : {}),
            }),
          ).pipe(Effect.ignore);

        const eventFiber = yield* providerService.streamEvents.pipe(
          Stream.runForEach((event) => {
            if (event.threadId !== threadId) {
              return Effect.void;
            }

            switch (event.type) {
              case "content.delta":
                if (event.payload.streamKind !== "assistant_text") {
                  return Effect.void;
                }
                return Ref.update(responseTextRef, (current) => current + event.payload.delta);
              case "request.opened":
                return failResponse(
                  "Provider text generation attempted to use tools or request approvals unexpectedly.",
                );
              case "turn.aborted":
                return failResponse(`Provider turn aborted: ${event.payload.reason}`);
              case "turn.completed":
                if (event.payload.state !== "completed") {
                  return failResponse(
                    event.payload.errorMessage
                      ? `Provider turn failed: ${event.payload.errorMessage}`
                      : `Provider turn ended with state '${event.payload.state}'.`,
                  );
                }
                return Ref.get(responseTextRef).pipe(
                  Effect.flatMap((text) =>
                    Deferred.succeed(responseReady, text.trim()).pipe(Effect.ignore),
                  ),
                );
              case "runtime.error":
                return failResponse(event.payload.message, event.payload.detail);
              case "session.exited":
                return failResponse(
                  event.payload.reason
                    ? `Provider session exited: ${event.payload.reason}`
                    : "Provider session exited before returning a response.",
                );
              default:
                return Effect.void;
            }
          }),
          Effect.forkScoped,
        );

        const awaitResponse = Deferred.await(responseReady).pipe(
          Effect.timeoutOption(PROVIDER_TEXT_GENERATION_TIMEOUT),
          Effect.flatMap((result) =>
            result._tag === "None"
              ? Effect.fail(
                  new TextGenerationError({
                    operation,
                    detail: "Provider text generation request timed out.",
                  }),
                )
              : Effect.succeed(result.value),
          ),
        );

        const parseResponse = (raw: string) =>
          Effect.succeed(extractJsonObject(raw)).pipe(
            Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))),
            Effect.catchTag("SchemaError", (cause) =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Provider returned invalid structured output.",
                  cause,
                }),
              ),
            ),
          );

        return yield* Effect.gen(function* () {
          yield* providerService.startSession(threadId, {
            threadId,
            provider: modelSelection.provider,
            cwd,
            modelSelection,
            runtimeMode: "approval-required",
          });

          yield* providerService.sendTurn({
            threadId,
            input: buildProviderOnlyPrompt(prompt),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          });

          const rawResponse = yield* awaitResponse;
          return yield* parseResponse(rawResponse);
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(TextGenerationError)(cause)
              ? cause
              : new TextGenerationError({
                  operation,
                  detail:
                    cause instanceof Error
                      ? `Provider text generation failed: ${cause.message}`
                      : "Provider text generation failed.",
                  cause,
                }),
          ),
          Effect.ensuring(Fiber.interrupt(eventFiber)),
          Effect.ensuring(
            providerService.stopSession({ threadId }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      }),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ProviderTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      recentCommits: input.recentCommits,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runProviderJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    } satisfies CommitMessageGenerationResult;
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ProviderTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runProviderJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    } satisfies PrContentGenerationResult;
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ProviderTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runProviderJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    } satisfies BranchNameGenerationResult;
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ProviderTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runProviderJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);
