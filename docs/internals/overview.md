# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
coordinates domain services without performing provider or filesystem work inside the database
transaction. Events, persisted projections, and the accepted command receipt commit
in one database transaction. The in-memory state changes and subscribers receive events after that
commit. This keeps command retries idempotent and prevents a persisted projection from getting
ahead of the event log.

Reactors perform side effects after intent has been recorded, then feed results back through
commands. A command acknowledgement therefore means the intent committed, not that the provider,
checkpoint, or other follow-up work finished. Keep external I/O out of the decider and the database
transaction.

Persisted events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A turn ending and its follow-up work settling are separate milestones. The
[run finalizer](../../apps/server/src/orchestration-v2/RunFinalizationService.ts) records the run's
terminal state independently from late checkpoint or diff work, which must not extend the recorded
turn duration or keep the client showing provider work as active.

[Checkpoints](../../apps/server/src/orchestration-v2/CheckpointService.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

## Waiting for asynchronous work

Tests wait on the scoped [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) and
observable state transitions rather than sleeps. Durable
[command receipts](../../apps/server/src/orchestration-v2/CommandReceiptStore.ts) make dispatch
idempotent; an empty queue alone does not prove side effects have finished.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
