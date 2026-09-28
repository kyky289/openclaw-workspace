import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createJournal } from '../src/journal.mjs';
import { createResearch } from '../src/research.mjs';
import { createReviewService } from '../src/review.mjs';

const owner = Object.freeze({ authenticatedOperator: true });
const regularOwner = Object.freeze({ authenticatedOperator: 'no-early' });
const otherOwner = Object.freeze({ authenticatedOperator: 'other' });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const code = (expected) => (error) => error.code === expected;
const authorize = ({ operation }, context) => context === owner ? {
  actorId: 'owner', canReview: true, canResolve: true, canRead: true, earlyResolutionConfirmed: true,
} : context === regularOwner ? { actorId: 'owner', canReview: true, canResolve: true, canRead: true }
  : context === otherOwner ? { actorId: 'other-owner', canReview: true, canResolve: true, canRead: true, earlyResolutionConfirmed: true } : null;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'research-review-test-'));
  const handles = [];
  t.after(() => { [...handles].reverse().forEach((handle) => handle.close()); rmSync(directory, { recursive: true, force: true }); });
  const open = ({ agentId = 'main', environment = 'test', journal, research, authorizeReview = authorize } = {}) => {
    journal ??= createJournal({ directory, agentId, environment }); handles.push(journal);
    research ??= createResearch({ directory, agentId, environment, journal,
      authorizeVerification: (context) => context === owner ? { actorId: 'source-verifier' } : null }); handles.push(research);
    const service = createReviewService({ directory, agentId, environment, journal, research, authorizeReview }); handles.push(service);
    return { journal, research, service };
  };
  return { directory, open };
}
function evidenceTask(research, suffix = 'one', verified = true) {
  const item = research.recordEvidence({ id: `evidence-${suffix}`, sourceFamily: 'fixture-source', kind: 'fact', source: 'Synthetic source',
    locator: `fixture:outcome-${suffix}`, publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-01T00:01:00Z',
    contentSha256: digest(suffix), idempotencyKey: `record-${suffix}` });
  if (verified) research.verifyEvidence({ evidenceId: item.id, expectedVersion: 1, status: 'verified', reason: 'Synthetic source verified', idempotencyKey: `verify-${suffix}` }, owner);
  return research.freezeTask({ id: `task-${suffix}`, title: 'Synthetic retrospective research', evidenceIds: [item.id],
    thesis: { id: 'fixture-thesis', version: '1', locator: 'fixture:thesis' },
    skill: { id: 'research-brain', version: 'fixture-2' },
    model: { provider: 'fixture', id: 'review-model', version: '2' },
    strategy: { id: 'fixture-strategy', version: 'unchanged-v1' }, idempotencyKey: `freeze-${suffix}` });
}
function target(journal, kind = 'decision', suffix = 'one') {
  const data = { title: 'Original synthetic judgment',
    evidence: [{ source: 'Original fixture', locator: 'fixture:original', observedAt: '2026-01-01T00:00:00Z' }],
    model: { provider: 'fixture', id: 'original-model', version: '1' }, strategy: { id: 'fixture-strategy', version: 'unchanged-v1' } };
  if (kind === 'decision') Object.assign(data, { action: 'hold', reason: 'Wait for evidence' });
  else Object.assign(data, { probability: 0.7, dueAt: new Date(Date.now() + 86400000).toISOString(), resolutionCriterion: 'Synthetic event occurs before the deadline' });
  return journal.append({ kind, data, idempotencyKey: `target-${suffix}` });
}
function reviewInput(record, task, extra = {}) {
  return { target: { id: record.id, version: record.version }, evidenceTaskId: task.id,
    title: 'Retrospective analysis', result: 'The evidence remains insufficient to act.', lessons: ['Keep original judgments intact.'], idempotencyKey: 'review-one', ...extra };
}
function resolveInput(record, task, extra = {}) {
  return { target: { id: record.id, version: record.version }, evidenceTaskId: task.id,
    criterionResult: 1, resolvedAt: new Date().toISOString(), reason: 'Trusted operator confirms synthetic criterion is already resolved.',
    idempotencyKey: 'resolve-one', ...extra };
}
function revoke(research, task) {
  research.verifyEvidence({ evidenceId: task.evidence[0].id, expectedVersion: 2, status: 'rejected', reason: 'Source withdrawn after inspection', idempotencyKey: 'revoke' }, owner);
}

test('default deny and forged actor/capabilities cannot publish or read', (t) => {
  const f = fixture(t); const { journal, research, service } = f.open({ authorizeReview: () => null });
  const original = target(journal); const task = evidenceTask(research); const input = reviewInput(original, task);
  assert.throws(() => service.review(input, { actorId: 'owner', canReview: true }), code('UNAUTHORIZED'));
  assert.throws(() => service.getReceipt({ idempotencyKey: input.idempotencyKey }, owner), code('UNAUTHORIZED'));
  const omitted = createReviewService({ directory: f.directory, agentId: 'main', environment: 'test', journal, research });
  t.after(() => omitted.close());
  assert.throws(() => omitted.review(input, owner), code('UNAUTHORIZED'));
  assert.equal(journal.list({ kind: 'review' }).total, 0);
});

test('denied existing and missing review/resolve targets both fail before any journal lookup', (t) => {
  const f = fixture(t); const real = f.open(); real.service.close();
  const original = target(real.journal); const prediction = target(real.journal, 'prediction', 'prediction');
  const task = evidenceTask(real.research); let reads = 0;
  const wrapper = { ...real.journal, get(...args) { reads++; return real.journal.get(...args); } };
  const phases = [];
  const service = f.open({ journal: wrapper, research: real.research, authorizeReview(request) {
    phases.push(request.phase); assert.equal(request.targetRecord, null); return null;
  } }).service;
  for (const operation of ['review', 'resolve']) {
    const input = operation === 'review' ? reviewInput(original, task) : resolveInput(prediction, task);
    assert.throws(() => service[operation](input, { actorId: 'owner', canReview: true, canResolve: true }), code('UNAUTHORIZED'));
    assert.throws(() => service[operation]({ ...input, target: { id: 'missing-target', version: 1 } }, owner), code('UNAUTHORIZED'));
  }
  assert.equal(reads, 0); assert.deepEqual(phases, ['preflight', 'preflight', 'preflight', 'preflight']);
  assert.equal(real.journal.list({ kind: 'review' }).total, 0); assert.equal(real.journal.list({ kind: 'resolution' }).total, 0);
});

test('target permission is separately checked after preflight and receives the exact record', (t) => {
  const phases = []; const f = fixture(t);
  const { journal, research, service } = f.open({ authorizeReview(request, context) {
    phases.push(request); return request.phase === 'preflight' ? authorize(request, context) : null;
  } });
  const original = target(journal); const task = evidenceTask(research);
  assert.throws(() => service.review(reviewInput(original, task), owner), code('UNAUTHORIZED'));
  assert.deepEqual(phases.map((item) => item.phase), ['preflight', 'target']);
  assert.equal(phases[0].targetRecord, null); assert.deepEqual(phases[1].targetRecord, original);
  assert.equal(journal.list({ kind: 'review' }).total, 0);
});

test('actor identity cannot change between preflight and target authorization', (t) => {
  const { journal, research, service } = fixture(t).open({ authorizeReview({ phase }) {
    return { actorId: phase === 'preflight' ? 'owner' : 'another-actor', canReview: true };
  } });
  const original = target(journal); const task = evidenceTask(research);
  assert.throws(() => service.review(reviewInput(original, task), owner), code('UNAUTHORIZED'));
  assert.equal(journal.list({ kind: 'review' }).total, 0);
});

test('review records trusted actor and frozen provenance without changing the old decision', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal); const task = evidenceTask(research);
  const input = reviewInput(original, task); const result = service.review(input, owner);
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, 'owner');
  assert.deepEqual(result.journalRecord.data.model, task.model);
  assert.deepEqual(result.journalRecord.data.strategy, task.strategy);
  assert.match(result.journalRecord.data.evidence[0].locator, /review=[a-f0-9]{48}$/);
  assert.deepEqual(journal.get(original.id), original); assert.equal(journal.history(original.id).length, 1);
  assert.equal(result.executionAuthorized, false); assert.equal(result.strategyPromotionAuthorized, false);
  assert.deepEqual(service.getReceipt({ idempotencyKey: input.idempotencyKey }, owner), result);
});

test('model, strategy, authority and target fields cannot be forged through input', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal); const task = evidenceTask(research);
  for (const extra of [{ actorId: 'owner' }, { model: task.model }, { strategy: task.strategy }, { earlyResolutionConfirmed: true }]) {
    assert.throws(() => service.review(reviewInput(original, task, extra), owner), code('VALIDATION'));
  }
  const fakeTarget = reviewInput(original, task); fakeTarget.target.scope = { agentId: 'other' };
  assert.throws(() => service.review(fakeTarget, owner), code('VALIDATION'));
  assert.equal(journal.list({ kind: 'review' }).total, 0);
});

test('review requires an exact existing historical decision/prediction version', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal); const task = evidenceTask(research);
  assert.throws(() => service.review(reviewInput(original, task, { target: { id: original.id, version: 999 } }), owner), code('TARGET_NOT_FOUND'));
  journal.append({ kind: 'decision', id: original.id, expectedVersion: 1, data: { ...original.data, reason: 'Later evidence' }, idempotencyKey: 'revision' });
  const result = service.review(reviewInput(original, task), owner);
  assert.equal(result.journalRecord.data.target.version, 1, 'historical version remains reviewable');
  assert.equal(journal.get(original.id).version, 2);
  assert.throws(() => service.review(reviewInput(result.journalRecord, task, { idempotencyKey: 'review-review' }), owner), code('TARGET_INVALID'));
});

test('pending frozen evidence never upgrades itself when later verification changes', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal); const task = evidenceTask(research, 'pending', false);
  const input = reviewInput(original, task);
  assert.throws(() => service.review(input, owner), code('UNVERIFIED_EVIDENCE'));
  research.verifyEvidence({ evidenceId: task.evidence[0].id, expectedVersion: 1, status: 'verified', reason: 'Verified later', idempotencyKey: 'later-verification' }, owner);
  assert.throws(() => service.review(input, owner), code('UNVERIFIED_EVIDENCE'));
  assert.equal(service.getReceipt({ idempotencyKey: input.idempotencyKey }, owner), null);
});

test('revoked and newly reverified snapshots cannot support first commit', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal); const task = evidenceTask(research);
  revoke(research, task);
  const input = reviewInput(original, task);
  assert.throws(() => service.review(input, owner), code('STALE_EVIDENCE'));
  research.verifyEvidence({ evidenceId: task.evidence[0].id, expectedVersion: 3, status: 'verified', reason: 'Reverified corrected attribution', idempotencyKey: 'reverify' }, owner);
  assert.throws(() => service.review(input, owner), code('STALE_EVIDENCE'));
  assert.equal(journal.list({ kind: 'review' }).total, 0);
});

test('resolution needs current prediction version and explicit trusted early confirmation', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal, 'prediction'); const task = evidenceTask(research);
  const input = resolveInput(original, task);
  assert.throws(() => service.resolve(input, regularOwner), code('EARLY_RESOLUTION_NOT_CONFIRMED'));
  const updated = journal.append({ kind: 'prediction', id: original.id, expectedVersion: 1,
    data: { ...original.data, probability: 0.6 }, idempotencyKey: 'forecast-revision' });
  assert.throws(() => service.resolve(input, owner), code('VERSION_CONFLICT'));
  const current = resolveInput(updated, task); const result = service.resolve(current, owner);
  assert.equal(result.journalRecord.kind, 'resolution'); assert.equal(result.earlyResolutionConfirmed, true);
  assert.equal(result.journalRecord.data.target.version, 2);
  assert.deepEqual(journal.get(original.id, { version: 1 }), original);
  assert.equal(journal.statistics().sampleSufficient, false);
  assert.equal(journal.statistics().investmentPerformance, false);
  assert.equal(result.strategyPromotionAuthorized, false);
});

test('resolution capability is separate from review and chronology is validated', (t) => {
  const { journal, research, service } = fixture(t).open({ authorizeReview: (_, context) => context === owner ? { actorId: 'owner', canReview: true } : null });
  const original = target(journal, 'prediction'); const task = evidenceTask(research);
  assert.throws(() => service.resolve(resolveInput(original, task), owner), code('UNAUTHORIZED'));
  assert.throws(() => service.resolve(resolveInput(original, task, { criterionResult: true }), owner), code('VALIDATION'));
  assert.throws(() => service.resolve(resolveInput(original, task, { resolvedAt: '2026-02-30T00:00:00Z' }), owner), code('VALIDATION'));
});

test('scope mismatch rejects foreign handles and foreign journal targets', (t) => {
  const f = fixture(t); const main = f.open(); const group = f.open({ agentId: 'group-tim' }); const paper = f.open({ environment: 'paper' });
  const original = target(main.journal); const task = evidenceTask(main.research);
  assert.throws(() => createReviewService({ directory: f.directory, agentId: 'group-tim', environment: 'test',
    research: main.research, journal: group.journal }), code('SCOPE_MISMATCH'));
  assert.throws(() => group.service.review(reviewInput(original, task), owner), code('TARGET_NOT_FOUND'));
  const groupTarget = target(group.journal); assert.throws(() => group.service.review(reviewInput(groupTarget, task), owner), code('TASK_NOT_FOUND'));
  assert.throws(() => paper.service.review(reviewInput(original, task), owner), code('TARGET_NOT_FOUND'));
});

test('same key and payload are idempotent; another actor or modified result conflicts', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal); const task = evidenceTask(research);
  const input = reviewInput(original, task); const result = service.review(input, owner);
  assert.deepEqual(service.review(input, owner), result);
  assert.throws(() => service.review({ ...input, result: 'Changed retrospective explanation' }, owner), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => service.review(input, otherOwner), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(journal.list({ kind: 'review' }).total, 1);
});

test('failure before journal append keeps reservation but revoked evidence prevents retry commit', (t) => {
  const f = fixture(t); const real = f.open(); real.service.close();
  const original = target(real.journal); const task = evidenceTask(real.research);
  const wrapper = { ...real.journal, append() { throw new Error('private provider failure sentinel'); } };
  const failed = f.open({ journal: wrapper, research: real.research }).service;
  const input = reviewInput(original, task);
  assert.throws(() => failed.review(input, owner), code('STORAGE_FAILURE'));
  assert.equal(failed.getReceipt({ idempotencyKey: input.idempotencyKey }, owner).status, 'reserved');
  revoke(real.research, task); failed.close();
  const recovered = f.open({ journal: real.journal, research: real.research }).service;
  assert.throws(() => recovered.review(input, owner), code('STALE_EVIDENCE'));
  assert.equal(real.journal.list({ kind: 'review' }).total, 0);
});

test('crash after review commit reconciles once even after evidence withdrawal', (t) => {
  const f = fixture(t); const real = f.open(); real.service.close();
  const original = target(real.journal); const task = evidenceTask(real.research);
  let writes = 0;
  const wrapper = { ...real.journal, append(input) { writes++; real.journal.append(input); throw new Error('Synthetic crash after journal commit'); } };
  const failed = f.open({ journal: wrapper, research: real.research }).service;
  const input = reviewInput(original, task);
  assert.throws(() => failed.review(input, owner), code('STORAGE_FAILURE'));
  const written = real.journal.list({ kind: 'review' }).records[0];
  revoke(real.research, task); failed.close();
  const recovered = f.open({ journal: real.journal, research: real.research }).service;
  const receipt = recovered.review(input, owner);
  assert.deepEqual(receipt.journalRecord, written); assert.equal(receipt.actorId, 'owner');
  assert.equal(writes, 1); assert.equal(real.journal.list({ kind: 'review' }).total, 1);
  assert.deepEqual(real.journal.get(original.id), original);
});

test('crash after resolution commit recovers random journal id without re-resolving', (t) => {
  const f = fixture(t); const real = f.open(); real.service.close();
  const original = target(real.journal, 'prediction'); const task = evidenceTask(real.research);
  let writes = 0;
  const wrapper = { ...real.journal, resolvePrediction(input) { writes++; real.journal.resolvePrediction(input); throw new Error('Synthetic after-commit crash'); } };
  const failed = f.open({ journal: wrapper, research: real.research }).service;
  const input = resolveInput(original, task);
  assert.throws(() => failed.resolve(input, owner), code('STORAGE_FAILURE'));
  const written = real.journal.list({ kind: 'resolution' }).records[0]; revoke(real.research, task); failed.close();
  const recovered = f.open({ journal: real.journal, research: real.research }).service;
  const receipt = recovered.resolve(input, regularOwner);
  assert.deepEqual(receipt.journalRecord, written);
  assert.equal(receipt.earlyResolutionConfirmed, true, 'historic approval is retained during receipt recovery');
  assert.equal(writes, 1); assert.equal(real.journal.statistics().resolvedCount, 1);
});

test('a different existing resolution cannot masquerade as this operation', (t) => {
  const { journal, research, service } = fixture(t).open(); const original = target(journal, 'prediction'); const task = evidenceTask(research);
  journal.resolvePrediction({ id: original.id, expectedVersion: 1, outcome: 1, resolvedAt: new Date().toISOString(),
    reason: 'Other trusted resolver', evidence: original.data.evidence, idempotencyKey: 'other-resolver' });
  assert.throws(() => service.resolve(resolveInput(original, task), owner), code('JOURNAL_CONFLICT'));
  assert.equal(journal.statistics().resolvedCount, 1);
});

test('read permission is checked on every receipt access and async authority is rejected', (t) => {
  const f = fixture(t); const { journal, research, service } = f.open(); const original = target(journal); const task = evidenceTask(research);
  service.review(reviewInput(original, task), owner);
  assert.throws(() => service.getReceipt({ idempotencyKey: 'review-one' }, { authenticatedOperator: true }), code('UNAUTHORIZED'));
  assert.throws(() => createReviewService({ directory: f.directory, agentId: 'main', environment: 'test', journal, research,
    authorizeReview: async () => ({ actorId: 'owner', canReview: true }) }), code('VALIDATION'));
});
