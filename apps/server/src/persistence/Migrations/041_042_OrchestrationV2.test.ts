import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_042_OrchestrationV2", (it) => {
  it.effect("keeps released and private migration ids contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 59 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("installs the orchestration v2 and subagent schemas", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id IN (41, 42)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 41,
          name: "OrchestrationV2",
        },
        {
          migration_id: 42,
          name: "OrchestrationV2Subagents",
        },
      ]);

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_events)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;

      assert.ok(eventColumns.some((column) => column.name === "event_id"));
      assert.ok(subagentColumns.some((column) => column.name === "child_thread_id"));
    }),
  );

  it.effect("backfills provider-session thread bindings in migration 044", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_sessions (
          provider_session_id,
          thread_id,
          provider,
          driver,
          provider_instance_id,
          status,
          model,
          updated_at,
          payload_json
        ) VALUES (
          'provider-session:shared',
          'thread:existing',
          'codex',
          'codex',
          'codex',
          'ready',
          'gpt-5.4',
          '2026-01-01T00:00:00.000Z',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const bindings = yield* sql<{
        readonly provider_session_id: string;
        readonly thread_id: string;
      }>`
        SELECT provider_session_id, thread_id
        FROM orchestration_v2_projection_provider_session_bindings
      `;
      assert.deepStrictEqual(bindings, [
        {
          provider_session_id: "provider-session:shared",
          thread_id: "thread:existing",
        },
      ]);
    }),
  );

  it.effect("preserves turn items with colliding ordinals in migration 043", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id,
          thread_id,
          ordinal,
          provider,
          status,
          requested_at,
          payload_json
        ) VALUES (
          'run:one',
          'thread:one',
          1,
          'codex',
          'completed',
          '2026-01-01T00:00:00.000Z',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id,
          thread_id,
          run_id,
          ordinal,
          type,
          status,
          updated_at,
          payload_json
        ) VALUES
          ('turn-item:b', 'thread:one', 'run:one', 7, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}'),
          ('turn-item:a', 'thread:one', 'run:one', 7, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}'),
          ('turn-item:c', 'thread:one', 'run:one', 9, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}'),
          ('turn-item:d', 'thread:two', NULL, 42, 'assistant_message', 'completed', '2026-01-01T00:00:00.000Z', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const positions = yield* sql<{
        readonly thread_id: string;
        readonly turn_item_id: string;
        readonly ordinal: number;
      }>`
        SELECT thread_id, turn_item_id, ordinal
        FROM orchestration_v2_turn_item_positions
        ORDER BY thread_id, ordinal
      `;
      assert.deepStrictEqual(positions, [
        { thread_id: "thread:one", turn_item_id: "turn-item:a", ordinal: 1_000_001 },
        { thread_id: "thread:one", turn_item_id: "turn-item:b", ordinal: 1_000_002 },
        { thread_id: "thread:one", turn_item_id: "turn-item:c", ordinal: 1_000_003 },
        { thread_id: "thread:two", turn_item_id: "turn-item:d", ordinal: 1 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});

it.effect("upgrades a database already at the deployed fork migration 053", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* runMigrations({ toMigrationInclusive: 53 });
    const snoozeColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_threads)
    `;
    assert.ok(snoozeColumns.some((column) => column.name === "snoozed_until"));
    assert.ok(snoozeColumns.some((column) => column.name === "snoozed_at"));

    yield* runMigrations({ toMigrationInclusive: 59 });

    const migrations = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`
      SELECT migration_id, name
      FROM effect_sql_migrations
      WHERE migration_id BETWEEN 39 AND 59
      ORDER BY migration_id
    `;
    assert.deepStrictEqual(
      migrations.map(({ migration_id, name }) => [migration_id, name]),
      [
        [39, "ProjectionProjectsDefaultThreadEnvMode"],
        [40, "ProjectionProjectFaviconPath"],
        [41, "OrchestrationV2"],
        [42, "OrchestrationV2Subagents"],
        [43, "OrchestrationV2Foundation"],
        [44, "OrchestrationV2ProviderSessionBindings"],
        [45, "OrchestrationV2ThreadLaunchWorkflows"],
        [46, "ApplicationEventSource"],
        [47, "OrchestrationV2EffectCancellation"],
        [48, "ScheduledTasks"],
        [49, "LegacyV1ImportState"],
        [50, "AuthSessionClientConnection"],
        [51, "ProjectionThreadLinkedPullRequest"],
        [52, "ProjectionThreadsUnsettledAt"],
        [53, "ClearAutomaticProjectModelDefaults"],
        [54, "ProjectionProjectsAutoPull"],
        [55, "RepairAutomaticSettlementTimestamps"],
        [56, "ProjectionProjectIcon"],
        [57, "ApplicationEventSequenceIndexes"],
        [58, "OrchestrationV2RecoveryIndexes"],
        [59, "OrchestrationV2ShellIndexes"],
      ],
    );

    const v2Tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
    `;
    assert.strictEqual(v2Tables.length, 1);

    const legacyImportTables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_legacy_imports'
    `;
    assert.strictEqual(legacyImportTables.length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
