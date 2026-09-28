# Decision journal v1

This is a local record library, not an investment or trading engine. It does not
call a model, connect to a broker, execute an order, start a service, register a
plugin, read production memories, or move existing thesis files. Its only storage
is the explicitly supplied directory. It uses Node's built-in `node:sqlite`; the
tested runtime is Node 24.21.0 on Linux, with no third-party dependencies.

## Trusted scope and storage

```js
import { createJournal, JournalError } from './src/journal.mjs';

const journal = createJournal({
  directory: '/absolute/private/journal-data',
  agentId: 'main',
  environment: 'paper', // exactly 'test', 'paper', or 'live'
});
// Always close the handle after use.
try {
  console.log(journal.statistics());
} finally {
  journal.close();
}
```

The trusted application supplies `agentId` and `environment` after authenticating
the caller. Never copy these fields from a model tool payload, chat message, or
document. Obtain a separate handle for each authorized scope; handles cannot
query or reference another scope. These names are a storage boundary, **not an
authentication mechanism**. The same OS account can read all files it owns. A
future HTTP/App adapter still needs authentication, authorization and audit
controls before it exposes this API. `live` labels records and does not grant
trading authority.

Storage path: `<directory>/<agentId>/<environment>/journal.sqlite`. New directories
use `0700` and files use `0600`. Existing directories in this namespace must have
no group/world permissions and must belong to the current OS account; the library
refuses unsafe permissions rather than changing them. Parent directories outside
the supplied root need not be private, but symlink components are rejected on
initialization. Agent IDs, record IDs and idempotency keys match
`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$`; scope names cannot contain path separators.

Use a local filesystem with working SQLite locks. Do not use this store on NFS or
an unverified shared filesystem. Access by another process with the same UID or
root is outside the security boundary. Symlink, file type, ownership, mode, hard
link and open-file identity checks reduce accidental unsafe storage; they cannot
defend against a hostile owner concurrently replacing arbitrary ancestor paths.
For stronger isolation, run agents under separate OS accounts/containers.

## Shared record fields

`append` accepts only the documented fields. Unknown fields, malformed types,
blank strings, nonfinite values, invalid timestamps and missing provenance fail
validation before a write. Payloads are limited to 64 KiB. UTC timestamps accept
`YYYY-MM-DDTHH:mm:ssZ` or 1–3 fractional digits before `Z`; invalid calendar dates
are rejected. Server-generated `createdAt` uses millisecond precision.

The common data fields for predictions, decisions and reviews are:

```js
const common = {
  title: 'Synthetic example only',
  evidence: [{
    source: 'Fixture release',
    locator: 'fixture:release-1#paragraph-2',
    observedAt: '2026-01-01T00:00:00Z',
  }],
  model: { provider: 'fixture', id: 'fixture-model', version: '1' },
  strategy: { id: 'fixture-strategy', version: '1' },
};
```

Supply 1–50 evidence references. Every `observedAt` must be on or before that
record's server-generated `createdAt`, including revisions, reviews and forecast
resolutions. Integrity reads recheck this against the original recorded time,
not today's clock, so future-dated evidence cannot become valid merely by waiting.
This constraint is separate from a prediction's `dueAt`, which must remain in the
future when the prediction is written. Locators are stored references, not fetched or
executed. A caller is responsible for source quality and precise provenance:
schema validation does not certify that a reference is true. Do not include API
keys, account credentials, wallet secrets or unnecessary personal data.

## Append, revise and retry

All methods are synchronous. `append` returns a detached JSON record:

```js
const forecastData = {
  ...common,
  probability: 0.7,
  dueAt: new Date(Date.now() + 86400000).toISOString(),
  resolutionCriterion: 'The synthetic fixture equals 1 by the deadline.',
};
const first = journal.append({
  kind: 'prediction',
  data: forecastData,
  idempotencyKey: 'fixture-prediction-create-1',
});
// {
//   schemaVersion: 1, scope: { agentId: 'main', environment: 'paper' },
//   id: '<generated UUID>', version: 1, kind: 'prediction',
//   createdAt: '<server timestamp>', data: { ... }
// }

const revised = journal.append({
  kind: 'prediction',
  id: first.id,
  expectedVersion: 1,
  data: { ...forecastData, probability: 0.6 },
  idempotencyKey: 'fixture-prediction-revise-1',
});
```

For a new record, `id` is optional and `expectedVersion` defaults to `0`. A caller
may supply a valid ID with expected version `0`. For a revision, supply the ID
and the exact current version. Each revision is a new immutable database row;
the original is never changed. Record kind cannot change. An outdated version
throws `VERSION_CONFLICT`.

An idempotency key is required for every write. Retrying the **same request** with
the same key returns the original result, even after later revisions; a changed
payload, ID, operation or expected version with the same key throws
`IDEMPOTENCY_CONFLICT`. Object key order does not affect the match. Preserve the
original request when retrying; do not regenerate its deadline or timestamp.
Keys are unique within an agent/environment scope across every record kind.

A prediction's title, deadline and resolution criterion define its event and are
fixed after creation. To ask a different event, create a new prediction. A
prediction must be recorded/revised before its deadline, and may not be revised
after resolution. Historical forecasts cannot be backdated/imported as if they
were recorded earlier. Any historical import needs a separately reviewed design.

Conceptual decision:

```js
const decision = journal.append({
  kind: 'decision',
  data: {
    ...common,
    action: 'hold', // only 'hold', 'buy', 'sell', 'research'
    reason: 'Wait for the missing synthetic evidence.',
  },
  idempotencyKey: 'fixture-decision-1',
});
```

These action labels cannot execute trades and have no quantity, broker or order
credentials. Investment execution requires a future, separate authorized layer.

Review:

```js
journal.append({
  kind: 'review',
  data: {
    ...common,
    target: { id: decision.id, version: decision.version },
    result: 'No order was submitted; the evidence remained insufficient.',
    lessons: ['Record meaningful non-actions.'],
  },
  idempotencyKey: 'fixture-review-1',
});
```

The review target must be an existing prediction or decision version in the same
scope. A review cannot rewrite its target. Review revisions retain the same
target. `lessons` accepts 0–50 nonempty strings. Reviews do not automatically
change strategies, skills, model settings or other memories.

## Resolve and measure forecasts

```js
const resolution = journal.resolvePrediction({
  id: revised.id,
  expectedVersion: revised.version,
  outcome: 1, // exactly 0 or 1
  resolvedAt: new Date().toISOString(),
  reason: 'Synthetic event is conclusively resolved according to its criterion.',
  evidence: common.evidence,
  idempotencyKey: 'fixture-resolution-1',
});
```

This appends a **separate** record of `kind: 'resolution'` with its own ID and
version `1`. Its data contains `target: {id, version}`, `outcome`, `resolvedAt`,
`reason` and `evidence`. It targets the latest prediction version and does not
overwrite any forecast. One resolution per prediction is permitted. Retry the
same key/request for the same result. A different second resolution throws
`ALREADY_RESOLVED`. Resolution corrections are deliberately not implemented in
v1; preserve the evidence and request a reviewed correction process.

`resolvedAt` must be on or after the referenced forecast creation time and no
later than the server's current time. Early resolution is allowed for an event
already conclusively decided before its deadline; the trusted resolver must
verify that the original criterion actually permits it. The library cannot
verify real-world outcomes, authorize a resolver, or detect fabricated evidence.

```js
journal.statistics({ minSampleSize: 30 });
// {
//   scope, metric: 'brier', basis: 'initial-recorded-forecast',
//   predictionCount, resolvedCount, unresolvedCount,
//   score: <mean (initial probability - binary outcome)^2, or null>,
//   minSampleSize: 30, sampleSufficient: <boolean>,
//   investmentPerformance: false
// }
```

Statistics use each prediction's **first recorded probability**, preventing
later revisions from making the original forecast look better. Every prediction
is counted once. The default minimum sample is 30 and is an explicit warning
threshold, not a claim of statistical significance. Zero settled forecasts
produce `score: null`, never a misleading zero. A nonempty but insufficient sample
has a descriptive score and `sampleSufficient: false`. Scores stay inside the
selected scope: test and paper outcomes never enter live statistics. Brier score
does not measure return, drawdown, trading costs, benchmark performance, strategy
profitability or sample independence. Unresolved/overdue forecasts remain visible
in counts and must not be selectively omitted from a real evaluation.

## Queries and export

```js
journal.get(first.id);                  // latest version, or null
journal.get(first.id, { version: 1 });  // exact version, or null
journal.history(first.id);             // all versions, or []
journal.list({ kind: 'prediction', limit: 100, offset: 0 });
// { scope, total, offset, limit, records: [latest version per ID] }

const page = JSON.parse(journal.exportJson({ limit: 100, offset: 0 }));
// { schemaVersion, scope, total, offset, nextOffset, records: [all versions] }
```

The optional list kind is prediction/decision/review/resolution. Lists return
latest versions ordered by first insertion; exports include all immutable rows
in insertion order. Pagination limit defaults to 100, maximum 1000. Exports are
JSON strings capped at 2 MiB; follow `nextOffset` until null. No exporter accepts
another agent/environment or writes a destination file. The application decides
who may receive an export. Exports do not carry database hash-chain metadata and
are not a replacement for a database backup. `history` is currently unpaginated;
bound external response sizes before exposing it through an App.

## Integrity, concurrency and limits

SQLite `BEGIN IMMEDIATE` serializes writes; a five-second lock timeout produces
`BUSY`, which callers may retry with the same key and payload. Commit uses
`synchronous=FULL`. Initial creation prepares a private temporary database and
publishes it atomically without overwriting an existing file. A truncated
existing file fails closed and is never treated as an empty new store. SQLite
crash recovery may legitimately use its own journal file on the next open.
Failed initialization can leave a private `.initializing-*` file; retain and
inspect it rather than treating it as a published journal. Restore operations
must not overwrite the original without an approved recovery procedure.

Database triggers reject updates/deletes. Every operation checks stored schemas,
references, version sequences and a SHA-256 chain; opening also uses SQLite
`quick_check`. Suspected corruption blocks reads/writes rather than silently
discarding records. This detects accidental corruption, not a malicious owner
who can rewrite the entire database or remove its end. External signed backups
or append-only remote storage would be needed for stronger tamper evidence.

This minimal implementation validates the whole log on each operation and stores
it in memory. It is appropriate for a modest personal journal, not an unbounded
high-frequency execution ledger. Before high-volume use, add validated
checkpoints/indexed reads, retention/backup policy, resource limits and workload
benchmarks without weakening immutable history. No timer, network listener or
background maintenance is created by this module.

Errors are `JournalError` with `code`: `VALIDATION`, `VERSION_CONFLICT`,
`IDEMPOTENCY_CONFLICT`, `NOT_FOUND`, `ALREADY_RESOLVED`, `UNSAFE_STORAGE`,
`CORRUPT_STORE`, `STORAGE`, `BUSY`, `CLOCK`, or `CLOSED`. Errors avoid disclosing
payloads, SQL contents or credentials. A corrupt SQLite file may yield the
generic `STORAGE` code when its structure cannot be inspected.

## Validation

Run `node --test test/journal.test.mjs`. Fixtures create isolated `/tmp` directories
and clean up only their own synthetic files. Coverage includes immutable history,
schema validation, permissions/symlinks, scoped references, retry collisions,
physical/logical/truncated corruption, byte-bounded exports, Brier semantics and
six-process write races. No test uses production paths, model calls or services.
Some restricted sandboxes cannot run Node child processes normally; run the
suite in an approved local process environment or CI instead of weakening the
concurrency assertions.
