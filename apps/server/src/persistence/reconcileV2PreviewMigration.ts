import ForkBranchPullRequest from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import ForkActiveOrder from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import ForkPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import ForkMessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import ForkTitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

type MigrationRow = { readonly id: number; readonly name: string };

// Previews used V2 ids 53/54; preserve their schema and import progress while reserving main's ids.
function v2PreviewId(history: ReadonlyArray<MigrationRow>): number | "invalid" | undefined {
  const later = history.filter((row) => row.id >= 53);
  const legacy = later.find(
    (row) => row.name === "OrchestrationV2" && (row.id === 53 || row.id === 54),
  );
  if (!legacy) return undefined;
  const valid = later.every(
    (row) =>
      row === legacy ||
      (legacy.id === 54 &&
        ((row.id === 53 && row.name === "PullRequestFilesViewed") ||
          (row.id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
  );
  return valid ? legacy.id : "invalid";
}

/** The history as startup's preview reconciliation leaves it, or null when startup rejects it. */
export function reconciledV2PreviewHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> | null {
  const previewId = v2PreviewId(history);
  if (previewId === undefined) return history;
  if (previewId === "invalid") return null;
  return [
    ...history.filter((row) => row.id < 53),
    { id: 53, name: "PullRequestFilesViewed" },
    { id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
    { id: 55, name: "OrchestrationV2" },
    ...(history.some((row) => row.id === 55)
      ? [{ id: 56, name: "RemoveRedundantProjectionIndexes" }]
      : []),
  ];
}

export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 41
      `;
      if (history.some((row) => row.migration_id === 41 && row.name === "OrchestrationV2")) {
        const forkNames = [
          "OrchestrationV2",
          "OrchestrationV2Subagents",
          "OrchestrationV2Foundation",
          "OrchestrationV2ProviderSessionBindings",
          "OrchestrationV2ThreadLaunchWorkflows",
          "ApplicationEventSource",
          "OrchestrationV2EffectCancellation",
          "ScheduledTasks",
          "LegacyV1ImportState",
          "AuthSessionClientConnection",
          "ProjectionThreadLinkedPullRequest",
          "ProjectionThreadsUnsettledAt",
          "ClearAutomaticProjectModelDefaults",
          "ProjectionProjectsAutoPull",
          "RepairAutomaticSettlementTimestamps",
          "ProjectionProjectIcon",
          "ApplicationEventSequenceIndexes",
          "OrchestrationV2RecoveryIndexes",
          "OrchestrationV2ShellIndexes",
        ];
        if (
          history.length !== forkNames.length ||
          history.some((row) => forkNames[row.migration_id - 41] !== row.name)
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade an unrecognized custom V2 migration history.",
          });
        }
        // The fork shipped the same V2 schema as twelve steps. Archive its ledger
        // before adopting the consolidated upstream ids; never replay those steps.
        yield* sql`CREATE TABLE t3_fork_migration_history AS SELECT * FROM effect_sql_migrations`;
        const additions = [
          [48, "ProjectionThreadBranchPullRequest", ForkBranchPullRequest],
          [49, "ProjectionThreadsActiveOrderKey", ForkActiveOrder],
          [50, "ProjectionThreadPullRequests", ForkPullRequests],
          [51, "ProjectionThreadMessageContext", ForkMessageContext],
          [52, "ProjectionThreadTitleState", ForkTitleState],
          [53, "PullRequestFilesViewed", PullRequestFilesViewed],
          [54, "ProjectionThreadsAutoSettleDisabledAt", AutoSettleDisabledAt],
        ] as const;
        for (const [, , migration] of additions) yield* migration;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 41`;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          SELECT migration_id - 9, name, created_at FROM t3_fork_migration_history
          WHERE migration_id BETWEEN 50 AND 56
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          SELECT 55, name, created_at FROM t3_fork_migration_history WHERE migration_id = 41
        `;
        for (const [id, name] of additions) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
        return additions.map(([id, name]) => [id, name] as const);
      }
      const previewId = v2PreviewId(
        history.map((row) => ({ id: row.migration_id, name: row.name })),
      );
      if (previewId === undefined) return [];
      if (previewId === "invalid") {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (previewId === 53) {
        yield* PullRequestFilesViewed;
        executed.push([53, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([54, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 56 WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 55 WHERE migration_id = ${previewId} AND name = 'OrchestrationV2'`;
      if (previewId === 53) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});
