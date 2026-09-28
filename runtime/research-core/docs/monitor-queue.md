# Durable evidence monitoring queue

The queue separates discovering evidence from successfully processing it. It
does not start a worker, timer, model request, automation or Telegram send.
Existing monitoring skills and production state are not changed by importing it.
The trusted host controls scheduling, identity, authorization and scope.

Previously, marking a source as "Seen" before research completed could lose work
after a model failure or process exit. Here discovery commits a durable pending
task. Only a successful acknowledgement of its current lease marks it completed.
Failures remain retryable or visible in the dead-letter queue.

## Open and enqueue

```js
import { createMonitorQueue } from './src/monitor-queue.mjs';

const queue = createMonitorQueue({
  directory: '/absolute/private/research-data',
  agentId: 'main',
  environment: 'paper', // 'test', 'paper', or 'live'; no trading permissions
});
try {
  const discovered = queue.enqueue({
    sourceKey: 'fixture:filing-1',
    content: 'Synthetic evidence text, not an instruction to execute.',
    metadata: { source: 'fixture', verified: false },
    maxAttempts: 5,
  });
  // { created: true, task: { id, contentHash, status: 'pending', ... } }
} finally {
  queue.close();
}
```

The trusted application chooses `agentId` and `environment`, never a model,
source document or Telegram message. Files live in
`<directory>/<agentId>/<environment>/monitor-queue.sqlite` using the shared
private SQLite store. Scope names are not authentication: the same trusted OS
account can read all of its files. Separate accounts/containers are required
for stronger isolation.

`sourceKey` is a stable source identity (nonempty, at most 2048 UTF-8 bytes).
`content` is nonempty text, at most 64 KiB. Both reject NUL. The library computes
SHA-256 over the exact UTF-8 content and deduplicates `(sourceKey, contentHash)`
within one scope. The same body from another source is a separate task. Changed
body text creates a new version; reverting to a previously processed body is
the same old version. Choose stable body extraction upstream: timestamps or
other changing boilerplate in the body intentionally change its hash.

Repeated discovery returns `{created:false, task:<original>}` in every state,
including completed and dead-letter. It never overwrites original content,
metadata or retry limits, steals a lease, or revives an exhausted task. The
host must surface dead letters for review; v1 deliberately has no implicit
reset, deletion or replay operation.

Optional `metadata` is a plain JSON object limited to 8 KiB, eight nested levels
and 1000 values; nonfinite numbers, sparse arrays and non-JSON values fail
validation. It defaults to `{}`. `maxAttempts` defaults to 5 and accepts 1–10.
Input text and metadata are stored as untrusted data, never evaluated, fetched
or promoted to authoritative memory. Never put credentials in them.

## Claim, process, acknowledge

```js
const lease = queue.claim({ workerId: 'research-worker-1', leaseMs: 300_000 });
if (lease) {
  // A separate trusted worker validates/researches lease.content.
  // Persist its result using lease.id as the downstream idempotency key.
  queue.ack({
    id: lease.id,
    leaseToken: lease.leaseToken,
    result: { journalId: 'synthetic-durable-record-id' },
  });
}
```

`claim` returns a task plus its secret-to-the-worker `leaseToken`, or `null` if
nothing is eligible. Claims are serialized in a SQLite write transaction and
increment `attempts`. `workerId` is 1–128 characters matching
`[a-zA-Z0-9][a-zA-Z0-9_-]*`. The lease defaults to five minutes and accepts one
second through one hour. The host should choose enough time for its bounded
work; v1 has no lease renewal operation.

An optional `id` on `claim` selects exactly that task and never falls back to
another eligible task. The research workflow uses it only after publication
has committed. `get({id})` returns a detached task or null, without its lease
token; like `list`, it does not recover expired leases.

The current token and an unexpired lease are required for `ack` and `fail`.
An old worker cannot commit after another worker reclaims the task. At the
exact expiry timestamp the lease is expired. `ack` atomically stores its result
and marks completion. A repeated acknowledgement with the same completion token
and identical JSON result returns the original completion, even after restart;
a changed result raises `ACK_CONFLICT`. Completion cannot be rewritten.

`result` is optional and uses the same bounded JSON-object rules as metadata.
Prefer a durable result reference or digest, not raw research or diagnostics.
The queue cannot independently prove that research was performed: the trusted
worker is responsible for acknowledging only after validated work has been
persisted successfully.

Delivery to workers is **at least once**. If research commits to a separate
journal and the worker dies before queue acknowledgement, it can run again.
Using the queue task ID as that journal's idempotency key prevents duplicate
result commits. This module does not provide a distributed transaction or
exactly-once network side effects. A scanner may advance its durable discovery
cursor only after `enqueue` commits; marking a source seen is never a substitute
for task completion.

## Failure and crash recovery

```js
queue.fail({
  id: lease.id,
  leaseToken: lease.leaseToken,
  reason: 'PROVIDER_UNAVAILABLE',
});
```

Allowed caller reason codes are `PROCESSING_FAILED` (default),
`PROVIDER_UNAVAILABLE`, `INVALID_RESULT` and `RATE_LIMITED`. Raw exception text
is rejected to avoid persisting secrets from provider diagnostics. Lease expiry
uses the internal code `LEASE_EXPIRED`.

Transitions:

- `pending → leased`: a worker successfully claims the task.
- `leased → completed`: the current worker successfully acknowledges it.
- `leased → retry`: failure or expiry while attempts remain.
- `leased → dead-letter`: failure or expiry after the final allowed attempt.
- `retry → leased`: backoff has elapsed and another claim succeeds.

Backoff is `min(60000, 1000 × 2^(attempts−1))` milliseconds. Explicit failures
count from failure time; expiry recovery counts from the expired lease's
deadline. `availableAt` reports when the next attempt can begin. Another pending
task can be claimed while this task waits.

Expired leases are recovered transactionally when any worker calls `claim`.
Closing or crashing the process does not delete its tasks. After reopening,
the next claim recovers expired work or moves exhausted work to dead-letter.
There is no hidden timer: a read-only `list` may still show an expired task as
leased until the next claim performs recovery. Inspect `leaseExpiresAt` when
displaying it.

## Listing and task fields

```js
queue.list({ status: 'dead-letter', limit: 100, offset: 0 });
// { scope, total, offset, limit, tasks: [...] }
```

Omit `status` for every state. Pagination defaults to 100, maximum 500. Tasks
are ordered by creation/insertion; claims select eligible tasks by availability
then creation/insertion. Results are detached values; changing them does not
change storage.

Task fields: `id`, `sourceKey`, `contentHash`, `content`, `metadata`, `status`,
`attempts`, `maxAttempts`, `createdAt`, `updatedAt`, `availableAt`, `leaseOwner`,
`leaseExpiresAt`, `completedAt`, `result`, `lastError`. All timestamps are integer
Unix milliseconds; absent lease/completion/result/error fields are `null`.
Only `claim` returns `leaseToken`; lists, enqueue results and acknowledgements
do not disclose worker tokens. The completion token is never listed.

## Clock, integrity and limits

By default the host clock is `Date.now`. Tests can inject `clock: () => number`;
never accept this function or arbitrary timestamps from task payloads. A
persisted last-seen clock prevents backwards time from silently shortening
leases. A backwards clock raises `CLOCK`; read-only inspection still works.

Writes use the shared private store's transactions and durability settings.
Every operation validates status/lease/completion invariants, content hashes,
JSON structure and timestamp relationships. Invalid stored data blocks further
reads and writes with `CORRUPT_STORE`; no task is silently dropped or repaired.
Database triggers reject deletion and changes to original evidence or retry
limits. This detects accidental corruption, not a hostile database owner; it
does not replace protected backups.

The implementation reads the full queue for validation. It suits a modest
personal research queue, not an unbounded feed or high-frequency execution
system. Before larger use, add reviewed retention/index/checkpoint policies
without losing completed-version deduplication and dead-letter visibility.

Domain errors include `VALIDATION`, `CLOCK`, `NOT_FOUND`, `LEASE_CONFLICT`,
`LEASE_EXPIRED`, `ACK_CONFLICT`, `CORRUPT_STORE`. Shared storage errors can also
occur, including `STORAGE_BUSY`, `UNSAFE_STORAGE`, `STORE_CLOSED`; retry a busy
operation without changing its source identity or lease token.

## Offline validation

Run `node --test test/monitor-queue.test.mjs`. Tests use temporary synthetic
stores, controlled clocks and independent worker processes. They cover source
version deduplication, durable crash recovery, token fencing, idempotent ack,
bounded retry/dead-letter, namespace separation, malformed data, corruption,
and concurrent discovery/claim. No test sends messages, calls models or creates
schedulers. In restricted environments child-process tests may need approved
process execution; do not weaken concurrency assertions to bypass it.
