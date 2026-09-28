# Durable research workflow

`src/workflow.mjs` coordinates retained text artifacts, candidate evidence,
owner-reviewed research publication and queue acknowledgement. It is a local,
synchronous API for a CLI or a host-owned OpenClaw adapter. It does not fetch a
source, run a model, schedule a worker, place trades, send messages, edit a
thesis or promote anything into memory. A completed workflow means that a
conceptual journal record and its queue receipt were persisted. It does not
establish investment quality, verified truth, simulated returns or net profit.

## Host setup and authority

```js
import { createJournal } from './src/journal.mjs';
import { createResearch } from './src/research.mjs';
import { createMonitorQueue } from './src/monitor-queue.mjs';
import { createResearchWorkflow } from './src/workflow.mjs';

const scope = {
  directory: '/absolute/private/research-data',
  agentId: 'main',
  environment: 'paper', // test | paper | live: a namespace, not trading permission
};
const ownerSession = Object.freeze({ authenticatedSession: 'host-owned' });
const modelToolSession = Object.freeze({ authenticatedTool: 'host-owned' });
const journal = createJournal(scope);
const queue = createMonitorQueue(scope);
const research = createResearch({
  ...scope, journal,
  authorizeVerification(context) {
    return context === ownerSession ? { actorId: 'owner' } : null;
  },
});
const workflow = createResearchWorkflow({
  ...scope, queue, research, journal,
  authorize({ action, scope, request }, context) {
    // These contexts are application-owned capabilities; do not build them from
    // a model/tool JSON object or a user-supplied "owner"/"approved" field.
    if (context === ownerSession) return { actorId: 'owner' };
    if (context === modelToolSession && ['submit', 'read', 'propose'].includes(action)) {
      return { actorId: 'research-model-tool' };
    }
    return null;
  },
});
```

All three supplied handles must report exactly the host-selected agent and
environment. `queue` must implement the targeted `claim({id,...})` and `get({id})`
API. Handles and their authority are trusted host dependencies, never values
accepted from a model. Missing authorization defaults to deny. Authorization is
synchronous and must return the exact object shape `{actorId}`; booleans,
promises, thrown callbacks and model-supplied flags do not grant authority.

Actions are `submit`, `read` (both get and list), `propose`, `commit`, and
`reconcile`. `commit` and `reconcile` are privileged host operations; do not
register them as model tools. Evidence verification stays in the separately
authorized research API. Model-facing tools can submit and read candidates,
but cannot supply a verified evidence state or a model receipt.

The host must derive `modelReceipt` from its trusted execution receipt/version
registry, bind it to the chosen proposal, and authorize that precise commit.
The library validates and preserves its structure, but cannot prove a caller's
claim that a model was actually used. Missing or unverifiable execution metadata
must stay a candidate; never fabricate a model/version just to pass the API.

`workflow.close()` closes only its own store. Close the caller-owned research,
queue and journal handles separately. Storage is
`<directory>/<agentId>/<environment>/workflow.sqlite`, using the existing private
store, restrictive permissions, synchronous durable writes and append-only
tables. No existing journal, research or queue schema is changed by workflow.

## Submit retained sources

```js
const task = workflow.submit({
  title: 'Synthetic research task',
  question: 'What does the retained synthetic evidence imply?',
  sources: [{
    sourceKey: 'source-a',
    sourceFamily: 'original-report-a',
    kind: 'fact', // fact | inference; neither label means verified
    source: 'Synthetic original report',
    locator: 'fixture:report-a#paragraph-1',
    publishedAt: '2026-01-01T00:00:00Z',
    observedAt: '2026-01-01T00:01:00Z',
    content: 'Exact retained synthetic text excerpt.',
  }],
  context: {
    thesis: { id: 'fixture-thesis', version: '1', locator: 'fixture:thesis#1' },
    skill: { id: 'research-brain', version: 'reviewed-revision' },
    strategy: { id: 'fixture-strategy', version: '1' },
  },
  idempotencyKey: 'submit-fixture-1',
}, modelToolSession);
```

Every object has a strict schema; unknown fields are rejected. Scope,
`recordedAt`, verification/approval fields, content hashes and model identity
cannot be injected through this submission. Limits are UTF-8 byte counts:

| Field | Limit |
| --- | --- |
| title | 1–1,024 bytes |
| question | 1–8,192 bytes |
| sources | 1–20, unique sourceKey within a task |
| each source content | 1–16,384 bytes |
| complete canonical submission | 60 KiB |
| source, locator | 512 and 2,048 bytes |
| thesis locator | 2,048 bytes |
| provenance id/version strings | 256 bytes; thesis id uses ID syntax |
| identifiers / idempotency keys / source-family keys | `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$` |

Text must contain something other than whitespace and must not contain NUL.
Dates use UTC ISO seconds with optional 1–3 fractional digits. Require
`publishedAt <= observedAt <= server-createdAt`; invalid calendar dates and
future source observations are rejected before ingestion. Prediction deadlines
are different: they are forecast parameters checked again by the journal when
publication first commits.

The workflow retains the supplied **text** immutably and computes SHA-256 over
its exact UTF-8 bytes. This closes the earlier gap where research stored only a
caller-supplied digest. It is an archive of the supplied excerpt, not proof of
the remote page's authenticity, completeness, current content or truth. URLs
are locators only and are never fetched. Binary media artifacts use their own
reviewed ingestion path. Source-family grouping remains a trusted ingestion
policy and does not automatically prove independence.

Submission first persists an immutable intent. It then idempotently creates
pending research evidence and enqueues exactly the canonical original submission
under `sourceKey = task.id`. Stable evidence IDs, stage keys and queue-content
hashes let retry recover a partial ingestion without creating another task or
rewriting original evidence. Source edits require a new task/idempotency key.
Exact submit retries can finish ingestion, but cannot resume privileged commits.

## Candidate, separate evidence review, owner commit

```js
const proposal = workflow.propose({
  taskId: task.id,
  analysis: {
    kind: 'decision',
    data: { title: 'Wait for evidence', action: 'hold', reason: 'Synthetic example.' },
  },
  idempotencyKey: 'proposal-fixture-1',
}, modelToolSession);

// Review retained task.sources independently; do not auto-approve their contents.
for (const source of task.sources) {
  const evidence = research.getEvidence(source.evidenceId);
  research.verifyEvidence({
    evidenceId: evidence.id,
    expectedVersion: evidence.version,
    status: 'verified',
    reason: 'Owner checked the retained artifact and source attribution.',
    idempotencyKey: `verify-${source.sourceKey}-1`,
  }, ownerSession);
}

const completed = workflow.commit({
  taskId: task.id,
  proposalId: proposal.id,
  modelReceipt: { provider: 'fixture', id: 'fixture-model', version: '1' },
  idempotencyKey: 'commit-fixture-1',
}, ownerSession);
```

Verification in the example is a separate owner action **after actual review**,
not a recommended automatic loop. Verification means an authorized reviewer
recorded a finding; the software cannot establish factual truth. Pending or
rejected evidence blocks commit with `UNVERIFIED_EVIDENCE`. It does not create
a commit intent, so the same request can be retried after independent review.
Waiting for an owner never occupies a queue lease.

Only `decision` and `prediction` proposals are accepted:

```js
const prediction = {
  kind: 'prediction',
  data: {
    title: 'Synthetic binary event',
    probability: 0.6,
    dueAt: new Date(Date.now() + 86400000).toISOString(),
    resolutionCriterion: 'Fixture outcome equals one before this deadline.',
  },
};
```

Decision actions are conceptual `hold|buy|sell|research`; no action creates an
order. Title is at most 1,024 bytes, reason 16,384, resolution criterion 8,192,
and probability is a finite number in `[0,1]`. A task accepts at most 20 immutable
proposals. A proposal contains no evidence/model/approval overrides. Proposing
alone never freezes verified research or publishes anything.

Commit durably locks one proposal and the approved model receipt, freezes the
original thesis/skill/strategy associations and verified evidence snapshot,
then calls the existing research→journal publication adapter. Later commits
cannot select another proposal or model. Changed evidence versions before first
publication produce `STALE_EVIDENCE`; do not silently re-freeze them under the
old approval. In this version an owner must inspect that task and create a new
reviewed task if a new snapshot/approval is required. Old intents and evidence
are preserved. Once a journal write is durable, subsequent evidence rejection
does not erase that historical decision or prevent receipt reconciliation.

## State, return shapes and recovery

Normal phases:

```text
ingest-pending → needs-review → committing → published → completed
```

`phase` records durable progress. `status` becomes `needs-review` when an
operation encountered an error, while preserving its phase and fixed
`reasonCodes`. `published` means the journal succeeded but queue completion is
still pending; it must not be presented as a completed workflow. There are no
background retries, loops, sleeps or timers.

`submit`, `get`, `commit` and `reconcile` return:

```js
{
  id, scope: {agentId, environment}, title, createdAt,
  status, phase, reasonCodes: [], queueTaskId,
  selectedProposalId, journalRecordId,
  question, context, submittedBy,
  sources: [/* original source fields + contentSha256 + evidenceId */],
  evidence: [/* latest research evidence, or null while ingestion is partial */],
  proposals: [/* immutable candidate objects */],
  modelReceipt: null, // selected trusted receipt once a commit intent exists
  publication: null, // existing research committed receipt after publication
}
```

`propose` returns
`{id,taskId,status:'candidate',analysis,idempotencyKey,createdAt,proposedBy}`.
Copies returned to callers cannot modify storage. Retained private sources are
only exposed after successful authorization; no API returns queue lease tokens.

```js
workflow.get({ taskId: task.id }, ownerSession);
workflow.list({ limit: 20, offset: 0 }, ownerSession);
// {scope,total,limit,offset,tasks:[{id,scope,title,createdAt,status,phase,
//   reasonCodes,queueTaskId,selectedProposalId,journalRecordId}]}
// Default limit 20, maximum 100; list omits bodies, evidence and proposals.

workflow.reconcile({ taskId: task.id }, ownerSession);
// Resume only a persisted intent; never invent verification, analysis or model.
```

After journal publication, the workflow acquires only its own queue task using
a 30-second targeted lease and acknowledges a stable result containing workflow,
proposal and journal ID/version. An unrelated pending task is never claimed.
An unexpired foreign lease remains owned by its worker; the workflow reports
pending acknowledgement and leaves another explicit recovery attempt to the
trusted host. Expired tasks remain subject to the queue's backoff/dead-letter
rules; workflow does not reset retry counts or revive dead letters.

These stores are coordinated through persisted intents and idempotency, **not**
a distributed atomic transaction:

- Lost evidence/enqueue acknowledgement reuses the original deterministic keys.
- Lost freeze acknowledgement reuses the same immutable snapshot.
- Journal success before workflow receipt/ack is recovered by the existing
  publication key; the journal record is checked at its original version 1.
- If queue claim succeeded but its token was lost, recovery waits for the queue
  lease's expiry/backoff. It never guesses the token or steals another lease.
- If queue ack committed but its response was lost, the exact durable result is
  checked through `queue.get`; no second claim or publication is required.
- A completed queue record with a different result yields
  `QUEUE_RESULT_CONFLICT`; no successful completion is fabricated.

Keep all four stores together in backups. Restoring only one may require manual
reconciliation and must not cause a new publication. Authorize and retry with
the same keys and payload; changing a key is a new operation, not crash recovery.
The workflow permits only one commit intent per task. Submission/proposal/commit
idempotency keys share a namespace and reject reuse for another operation.

Raw downstream exceptions are not persisted or returned as diagnostics.
Unknown failures become `WORKFLOW_INTERRUPTED`; reviewed domain failures retain
fixed codes. Common additional errors include `UNAUTHORIZED`, `VALIDATION`,
`SCOPE_MISMATCH`, `NOT_FOUND`, `WORKFLOW_NOT_READY`, `IDEMPOTENCY_CONFLICT`,
`COMMIT_CONFLICT`, `PROPOSAL_LIMIT`, `CORRUPT_STORE`, `JOURNAL_CONFLICT`,
`DEPENDENCY_CONFLICT`, `QUEUE_ACK_PENDING`, and `QUEUE_DEAD_LETTER`.
Accessed records are validated against canonical encoding and stored digests.
Hashes detect accidental corruption; they are not protection against a hostile
OS owner who can rewrite both data and hashes. This is a bounded personal
research coordinator, not a high-throughput execution platform.

Run the offline fixtures with:

```sh
node --test --test-isolation=none test/workflow.test.mjs
```

Tests use temporary synthetic stores, injected failure wrappers and controlled
queue clocks. They never access production state, fetch a source, call a model,
send a Telegram message or execute a trade.
