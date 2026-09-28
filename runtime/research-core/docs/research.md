# Research evidence and journal adapter

`src/research.mjs` provides a synchronous local API for candidate evidence,
trusted verification, immutable research-task snapshots and publication to the
existing decision journal. It does not run Research Brain, call models, fetch
URLs, change a thesis, promote memory, approve trading or send messages.

The larger project's objective is eventual investment performance after costs.
This module provides traceable inputs and decisions, not evidence of net profit.
Paper records, successful publication and Brier statistics are engineering or
forecast checks; none establishes a profitable investment strategy.

## Creation and authority

```js
import { createJournal } from './src/journal.mjs';
import { createResearch } from './src/research.mjs';

const scope = {
  directory: '/absolute/private/research-data',
  agentId: 'main',
  environment: 'paper', // test | paper | live
};
const journal = createJournal(scope);
const research = createResearch({
  ...scope,
  journal,
  authorizeVerification(trustedContext) {
    // Application-owned authentication, not fields copied from model JSON.
    return trustedContext === authenticatedOwnerContext
      ? { actorId: 'owner-account-id' }
      : null;
  },
});
```

The host selects scope after authenticating/authorizing the caller. The supplied
journal must report the same agent/environment through `statistics().scope`.
Different scopes are rejected. The optional verification callback is synchronous,
returns `{actorId}` when authorized, and otherwise denies the operation. Without
the callback, verification is disabled. `true`, promises and a model-supplied
`approved` flag are not accepted as authority. The host must not expose a generic
"choose actor/scope" model tool or accept a model-supplied authenticated context.

Storage is `<directory>/<agentId>/<environment>/research.sqlite`, using the shared
private SQLite store, separate from the existing journal. The module changes no
existing journal schema. Both handles are owned by the caller: `research.close()`
closes research storage only; close `journal` separately after use.

## Immutable evidence

```js
const candidate = research.recordEvidence({
  id: 'evidence-fixture-1', // optional; UUID generated if absent
  sourceFamily: 'original-report-fixture-1',
  kind: 'fact', // fact | inference; a claimed fact is not automatically true
  source: 'Synthetic source report',
  locator: 'fixture:report-1#paragraph-2',
  publishedAt: '2026-01-01T00:00:00Z',
  observedAt: '2026-01-01T00:01:00Z',
  contentSha256: '<64 lowercase hexadecimal characters>',
  idempotencyKey: 'evidence-create-1',
});
```

Return shape:

```js
{
  id, scope: {agentId, environment}, sourceFamily, kind, source, locator,
  publishedAt, observedAt, contentSha256,
  recordedAt: '<server timestamp>',
  version: 1,
  verification: {
    status: 'pending', recordedAt: '<server timestamp>',
    verifiedBy: null, reason: null,
  },
}
```

Required chronology is `publishedAt <= observedAt <= recordedAt`. Only UTC ISO
timestamps with seconds and optional 1–3 fractional digits are accepted. Invalid
calendar dates, missing provenance, future observations, unknown fields and
client-supplied `recordedAt`/verification state are rejected.

`sourceFamily` is the original source/production chain, not merely the website
that republishes it. Two articles copying the same report should use the same
family. IDs, source families and idempotency keys match
`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$`; the ingestion policy should choose canonical
family IDs consistently. The program cannot discover hidden common sources or
prove independence from these strings.

The host computes `contentSha256` from the retained source artifact or explicitly
chosen excerpt and preserves that artifact separately. This module validates the
hash format and freezes the supplied hash/metadata; it does **not** fetch the
locator, compute a hash of remote content, retain original bytes or verify that
the claimed digest matches them. Do not advertise a metadata snapshot as an
archival copy of the original document. Source changes require a new evidence ID
and artifact, preserving the old record.

## Trusted verification events

```js
const checked = research.verifyEvidence({
  evidenceId: candidate.id,
  expectedVersion: candidate.version,
  status: 'verified', // verified | rejected
  reason: 'The trusted reviewer checked the retained artifact and attribution.',
  idempotencyKey: 'evidence-review-1',
}, authenticatedOwnerContext);
```

The return has the same evidence fields, `version: 2` and
`verification: {status, recordedAt, verifiedBy, reason}`. `verifiedBy` comes only
from the authority callback. Each state transition is a new immutable event;
source contents, timestamps, kind and digest remain unchanged. Use the latest
version for subsequent corrections/rejections. Stale versions fail with
`VERSION_CONFLICT`. Exact authorized retries return the original result.

`verified` means **an authorized reviewer recorded successful verification**, not
that software proved the content true. An inference remains `kind: 'inference'`
after review and publication. Evidence review is separate from governance rule
approval, investment authorization and independent risk checks.

## Frozen research task

```js
const frozen = research.freezeTask({
  id: 'research-task-fixture-1', // optional
  title: 'Synthetic research question',
  evidenceIds: [checked.id],
  thesis: { id: 'fixture-thesis', version: 'v1', locator: 'fixture:thesis#v1' },
  skill: { id: 'research-brain', version: 'approved-skill-revision' },
  model: { provider: 'fixture', id: 'fixture-model', version: '1' },
  strategy: { id: 'fixture-strategy', version: '1' },
  idempotencyKey: 'research-freeze-1',
});
```

Return:

```js
{
  id, scope, title, frozenAt: '<server timestamp>',
  evidence: [/* complete evidence metadata + exact verification state/version */],
  thesis, skill, model, strategy,
  independentSourceCount: 1,
  snapshotSha256: '<hash of the immutable task snapshot>',
}
```

Choose 1–50 unique evidence IDs within the same scope. The task freezes each
record's kind, original locator, source family, timestamps, content hash and
verification state. Later verification changes do not rewrite this snapshot.
`independentSourceCount` counts distinct source-family IDs with verified status;
it is a grouping count, not an independent audit or a universal two-source rule.
Governance policies requiring two new independent sources remain separate.

Pending/rejected evidence may be retained in candidate tasks. Such tasks cannot
be published into the journal. Verify the evidence first, then freeze a new task;
the old candidate is never silently upgraded. The thesis, skill, model and
strategy references are stored associations, not proof that those files or
versions exist. The trusted runner must supply versions from the actual run.

## Publish a conceptual decision or prediction

```js
const publication = research.publish({
  taskId: frozen.id,
  kind: 'decision',
  data: { title: 'Wait for evidence', action: 'hold', reason: 'Insufficient margin.' },
  idempotencyKey: 'research-publish-1',
});
// Alternatively:
const forecast = research.publish({
  taskId: frozen.id,
  kind: 'prediction',
  data: {
    title: 'Synthetic binary event',
    probability: 0.6,
    dueAt: new Date(Date.now() + 86400000).toISOString(),
    resolutionCriterion: 'Fixture event equals one by the deadline.',
  },
  idempotencyKey: 'research-publish-2',
});
```

Decision actions are conceptual `hold|buy|sell|research`, with no order execution.
Prediction data uses the existing journal's probability/deadline/criterion
contract. Clients cannot inject model, strategy or evidence fields at publication:
those come from the frozen task.

Return:

```js
{
  status: 'committed', scope, taskId, taskSnapshotSha256,
  recordedAt: '<receipt timestamp>',
  journalRecord: {/* existing journal record: id, version:1, kind, createdAt, data */},
}
```

Every frozen reference must be verified, and its current verification version
must still match the snapshot before the first journal write. Newly rejected or
even newly reverified evidence requires a new snapshot. No minimum source-family
count beyond the nonempty verified snapshot is universally imposed.

Journal evidence locators are internal references:

```text
research://<agent>/<environment>/tasks/<taskId>/evidence/<evidenceId>#sha256=<snapshot hash>
```

They preserve linkage without adding fields to the existing journal schema or
exceeding its 50-reference limit. Resolve them through an authorized research
handle, never a generic network fetch. The snapshot contains the original source
URL, fact/inference label, source grouping, verification metadata and thesis/skill
versions. A reader must follow that linkage rather than treating a plain source
name as proof of factual correctness.

## Two-store recovery and idempotency

Publication proceeds as follows:

1. Validate the frozen task and commit a research-side reservation containing a
   deterministic journal ID/key and the exact journal payload.
2. Hold the research write transaction while checking current verification and
   appending to the independent journal. This prevents a concurrent verification
   change between the eligibility check and journal write.
3. Commit an immutable research-side receipt referencing the journal's version 1.

If interrupted before the journal commit, the reservation survives; an identical
retry writes once. If interrupted after journal commit but before receipt commit,
retry finds and verifies the existing journal row, then records the missing
receipt. It does not rewrite evidence or create a duplicate decision. Recovery
can finalize an already-committed record even if evidence was subsequently
rejected: later knowledge does not erase the original history. A first write still
waiting on a reservation must pass current verification checks.

After a task/journal commit, repeat the same `idempotencyKey` and **identical
payload**, including unchanged prediction deadline. Changed requests with the
same key fail `IDEMPOTENCY_CONFLICT`. A new key deliberately represents a new
publication. Keys are scoped and shared across evidence/review/freeze/publish
operations, preventing accidental reuse across operations. Retries of earlier
evidence operations return their original historical result, not today's latest
verification state.

If a prediction's deadline passes before its first journal commit, recovery does
not backdate the forecast; the existing journal rejects it. The reservation stays
visible for inspection. There is no automatic reservation deletion, scheduler or
background retry. A trusted orchestrator must retain keys and retry/alert.

These are two databases, not a distributed atomic transaction. An interruption
can temporarily leave `status: 'reserved'` after the journal has committed. Backup
and restore procedures must preserve both databases and inspect reservations;
restoring only one can produce `JOURNAL_CONFLICT`. Exact ID, version, scope and
payload are checked before accepting an existing journal record.

## Queries, errors and validation

```js
research.getEvidence(evidenceId);   // latest verification, or null
research.getTask(taskId);           // original frozen snapshot, or null
research.getPublication(key);       // null, reserved object, or committed receipt
research.close();                   // leaves caller-owned journal open
```

A reserved object includes `status`, `scope`, `taskId`, `taskSnapshotSha256`,
`reservedAt` and the internal `journalRequest`. It is an operational state, not
proof of publication. A committed receipt from `getPublication` is stored state;
an exact `publish` retry also checks that the journal row still exists unchanged.

No method accepts another scope, and returned objects are detached copies.
Snapshots/results are bounded to 512 KiB. Database tables are append-only through
SQL triggers. Rows read by the API are checked against their digests and schemas;
malformed accessed records fail closed. Hashes detect accidental corruption, not
malicious rewriting by the OS owner. Trusted host code and private local
filesystem assumptions are the same as the journal. Do not expose the SQLite
connection, verification callback, scope or source-family assignments as writable
model-controlled authority.

`ResearchError.code` includes `VALIDATION`, `UNAUTHORIZED`, `NOT_FOUND`,
`ID_CONFLICT`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `SCOPE_MISMATCH`,
`UNVERIFIED_EVIDENCE`, `STALE_EVIDENCE`, `CORRUPT_STORE`, `JOURNAL_CONFLICT`,
`CLOCK`, and `STORAGE`. Fixed-code store and journal errors are preserved.

Run `node --test test/research.test.mjs` (or `--test-isolation=none` in a restricted
process environment). Tests use temporary synthetic records, no production data
or model calls. They cover chronology, trusted verification, frozen source groups,
classification, provenance, cross-scope rejection, corruption, version conflicts,
and interruption/reopen/retry on either side of journal commit.
