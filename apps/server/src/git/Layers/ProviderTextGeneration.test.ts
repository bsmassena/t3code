import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EventId,
  TextGenerationError,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import { beforeEach, expect } from "vitest";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ProviderTextGenerationLive } from "./ProviderTextGeneration.ts";

const providerState = {
  startSessionCalls: [] as Array<{
    threadId: string;
    provider: string | undefined;
    cwd: string | undefined;
    runtimeMode: string;
    model: string | undefined;
  }>,
  sendTurnCalls: [] as Array<{
    threadId: string;
    input: string | undefined;
    attachmentCount: number;
  }>,
  stopSessionCalls: [] as string[],
  eventFactory: null as ((threadId: string) => ProviderRuntimeEvent[]) | null,
};

function resetProviderState(): void {
  providerState.startSessionCalls.length = 0;
  providerState.sendTurnCalls.length = 0;
  providerState.stopSessionCalls.length = 0;
  providerState.eventFactory = null;
}

beforeEach(() => {
  resetProviderState();
});

const FakeProviderServiceLayer = Layer.effect(
  ProviderService,
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const service: ProviderServiceShape = {
      startSession: (_threadId, input) =>
        Effect.sync(() => {
          providerState.startSessionCalls.push({
            threadId: input.threadId,
            provider: input.provider,
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            model: input.modelSelection?.model,
          });
          return {
            provider: input.provider ?? "codex",
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            createdAt: "2026-04-21T12:00:00.000Z",
            updatedAt: "2026-04-21T12:00:00.000Z",
          };
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          providerState.sendTurnCalls.push({
            threadId: input.threadId,
            input: input.input,
            attachmentCount: input.attachments?.length ?? 0,
          });

          const turnId = TurnId.make(`turn:${input.threadId}`);
          for (const event of providerState.eventFactory?.(input.threadId) ?? []) {
            yield* Queue.offer(events, event);
          }

          return {
            threadId: input.threadId,
            turnId,
          };
        }),
      stopSession: (input) =>
        Effect.sync(() => {
          providerState.stopSessionCalls.push(input.threadId);
        }),
      interruptTurn: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session" as const,
        }),
      rollbackConversation: () => Effect.void,
      streamEvents: Stream.fromQueue(events),
    };

    return service;
  }),
);

const ProviderTextGenerationTestLayer = ProviderTextGenerationLive.pipe(
  Layer.provide(FakeProviderServiceLayer),
);

function providerEvent(
  threadId: string,
  event:
    | {
        type: "content.delta";
        delta: string;
      }
    | {
        type: "turn.completed";
        state?: "completed" | "failed";
        errorMessage?: string;
      }
    | {
        type: "request.opened";
      },
): ProviderRuntimeEvent {
  const base = {
    eventId: EventId.make(`event:${randomUUID()}`),
    provider: "codex" as const,
    threadId: ThreadId.make(threadId),
    turnId: TurnId.make(`turn:${threadId}`),
    createdAt: "2026-04-21T12:00:00.000Z",
    providerRefs: {},
  };

  switch (event.type) {
    case "content.delta":
      return {
        ...base,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: event.delta,
        },
      };
    case "request.opened":
      return {
        ...base,
        type: "request.opened",
        payload: {
          requestType: "exec_command_approval",
        },
      };
    case "turn.completed":
      return {
        ...base,
        type: "turn.completed",
        payload: {
          state: event.state ?? "completed",
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        },
      };
  }
}

it.layer(NodeServices.layer)("ProviderTextGenerationLive", (it) => {
  it.effect("generates commit messages through an ephemeral provider session", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      providerState.eventFactory = (threadId) => [
        providerEvent(threadId, {
          type: "content.delta",
          delta: JSON.stringify({
            subject: "Add remote git generation.",
            body: "- route through provider session",
          }),
        }),
        providerEvent(threadId, { type: "turn.completed" }),
      ];

      const commitResult = yield* textGeneration.generateCommitMessage({
        cwd: "/remote/repo",
        branch: "main",
        stagedSummary: "M src/index.ts",
        stagedPatch: "diff --git a/src/index.ts b/src/index.ts",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
      });

      const ephemeralThreadId = providerState.startSessionCalls[0]?.threadId;
      expect(commitResult).toEqual({
        subject: "Add remote git generation",
        body: "- route through provider session",
      });
      expect(providerState.startSessionCalls).toEqual([
        {
          threadId: ephemeralThreadId,
          provider: "codex",
          cwd: "/remote/repo",
          runtimeMode: "approval-required",
          model: "gpt-5.4",
        },
      ]);
      expect(providerState.sendTurnCalls).toHaveLength(1);
      expect(providerState.sendTurnCalls[0]?.input).toContain(
        "Do not use tools, commands, file reads, web access, or repository inspection.",
      );
      expect(providerState.stopSessionCalls).toContain(ephemeralThreadId);
    }).pipe(Effect.provide(ProviderTextGenerationTestLayer)),
  );

  it.effect("fails with TextGenerationError when the provider returns invalid JSON", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      providerState.eventFactory = (threadId) => [
        providerEvent(threadId, { type: "content.delta", delta: "not-json" }),
        providerEvent(threadId, { type: "turn.completed" }),
      ];

      const attempt = yield* Effect.exit(
        textGeneration.generateThreadTitle({
          cwd: "/remote/repo",
          message: "Fix the sidebar layout",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-5",
          },
        }),
      );

      expect(Exit.isFailure(attempt)).toBe(true);
      if (Exit.isFailure(attempt)) {
        const failure = attempt.cause.reasons.find(Cause.isFailReason)?.error;
        expect(failure).toBeInstanceOf(TextGenerationError);
        if (Schema.is(TextGenerationError)(failure)) {
          expect(failure.detail).toContain("invalid structured output");
        }
      }
    }).pipe(Effect.provide(ProviderTextGenerationTestLayer)),
  );

  it.effect("fails fast when the provider tries to open a tool approval request", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      providerState.eventFactory = (threadId) => [
        providerEvent(threadId, { type: "request.opened" }),
      ];

      const attempt = yield* Effect.exit(
        textGeneration.generateBranchName({
          cwd: "/remote/repo",
          message: "Rename the broken feature branch",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 1024,
            },
          ],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5",
          },
        }),
      );

      expect(Exit.isFailure(attempt)).toBe(true);
      if (Exit.isFailure(attempt)) {
        const failure = attempt.cause.reasons.find(Cause.isFailReason)?.error;
        expect(failure).toBeInstanceOf(TextGenerationError);
        if (Schema.is(TextGenerationError)(failure)) {
          expect(failure.detail).toContain("attempted to use tools");
        }
      }
      expect(providerState.sendTurnCalls[0]?.attachmentCount).toBe(1);
    }).pipe(Effect.provide(ProviderTextGenerationTestLayer)),
  );
});
