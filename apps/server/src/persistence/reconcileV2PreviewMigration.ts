import ForkBranchPullRequest from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import ForkActiveOrder from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import ForkPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import ForkMessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import ForkTitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

// Published previews assigned V2 to 53, then 54. Keep their schema and import
// progress intact while reserving main's migration ids for upgrades from main.
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
      const legacy = history.find(
        (row) =>
          row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
      );
      if (!legacy) return [];
      const valid = history
        .filter((row) => row.migration_id >= 53)
        .every(
          (row) =>
            row === legacy ||
            (legacy.migration_id === 54 &&
              ((row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
                (row.migration_id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
        );
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (legacy.migration_id === 53) {
        yield* PullRequestFilesViewed;
        executed.push([53, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([54, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 56 WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 55 WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;
      if (legacy.migration_id === 53) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});
