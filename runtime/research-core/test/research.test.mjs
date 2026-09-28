import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createResearch, ResearchError } from '../src/research.mjs';
import { createJournal } from '../src/journal.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const owner = Object.freeze({ testActor: 'owner' });
const authority = context => context === owner ? { actorId: 'owner-fixture' } : null;
const evidence = (overrides = {}) => ({ sourceFamily: 'original-source-a', kind: 'fact', source: 'Synthetic source', locator: 'fixture:release-1',
  publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-01T00:01:00Z', contentSha256: digest('synthetic artifact only'), ...overrides });
const task = (evidenceIds, overrides = {}) => ({ title: 'Synthetic research', evidenceIds,
  thesis: { id: 'fixture-thesis', version: '1', locator: 'fixture:thesis#v1' }, skill: { id: 'research-brain', version: 'fixture-1' },
  model: { provider: 'fixture', id: 'fixture-model', version: '1' }, strategy: { id: 'fixture-strategy', version: '1' }, ...overrides });
const decision = { title: 'Synthetic non-action', action: 'hold', reason: 'Wait for more evidence' };
const hasCode = code => error => error?.code === code;

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'research-adapter-test-'));
  const handles = [];
  t.after(() => { for (const handle of handles.reverse()) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = ({ agentId = 'main', environment = 'test', journal, authorizeVerification = authority } = {}) => {
    journal ??= createJournal({ directory, agentId, environment });
    if (!handles.includes(journal)) handles.push(journal);
    const research = createResearch({ directory, agentId, environment, journal, authorizeVerification });
    handles.push(research);
    return { research, journal };
  };
  return { directory, open };
}
function reviewed(research, id = 'evidence-a', sourceFamily = 'original-source-a', overrides = {}) {
  const initial = research.recordEvidence({ ...evidence({ id, sourceFamily, ...overrides }), idempotencyKey: `record-${id}` });
  return research.verifyEvidence({ evidenceId: id, expectedVersion: initial.version, status: 'verified', reason: 'Checked original synthetic artifact', idempotencyKey: `verify-${id}` }, owner);
}

test('immutable evidence has an explicit pending state and exact retries preserve original content', t => {
  const { open } = fixture(t);
  const { research } = open();
  const request = { ...evidence(), idempotencyKey: 'record-one' };
  const first = research.recordEvidence(request);
  assert.equal(first.version, 1);
  assert.equal(first.verification.status, 'pending');
  assert.deepEqual(research.recordEvidence(request), first);
  assert.throws(() => research.recordEvidence({ ...request, contentSha256: digest('different') }), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => research.recordEvidence({ ...request, id: first.id, idempotencyKey: 'replace-one' }), hasCode('ID_CONFLICT'));
  first.source = 'mutated return';
  assert.equal(research.getEvidence(first.id).source, 'Synthetic source');
});

test('verification is default-denied and cannot be forged through model payload fields', t => {
  const { directory, open } = fixture(t);
  const { research, journal } = open({ authorizeVerification: undefined });
  const pending = research.recordEvidence({ ...evidence(), idempotencyKey: 'record' });
  const request = { evidenceId: pending.id, expectedVersion: 1, status: 'verified', reason: 'Synthetic review', idempotencyKey: 'verify' };
  assert.throws(() => research.verifyEvidence(request, { approved: true, actorId: 'owner-fixture' }), hasCode('UNAUTHORIZED'));
  const denied = createResearch({ directory, agentId: 'main', environment: 'test', journal });
  t.after(() => denied.close());
  assert.throws(() => denied.verifyEvidence(request, owner), hasCode('UNAUTHORIZED'));
  assert.throws(() => research.recordEvidence({ ...evidence(), verification: { status: 'verified' }, idempotencyKey: 'forged' }), hasCode('VALIDATION'));
  assert.throws(() => research.verifyEvidence({ ...request, verifiedBy: 'owner-fixture' }, owner), hasCode('VALIDATION'));
  assert.equal(research.getEvidence(pending.id).verification.status, 'pending');
});

test('verification has optimistic versions and audited trusted identity', t => {
  const { open } = fixture(t); const { research } = open();
  const initial = research.recordEvidence({ ...evidence({ id: 'first' }), idempotencyKey: 'record' });
  const request = { evidenceId: initial.id, expectedVersion: 1, status: 'verified', reason: 'Verified source and attribution', idempotencyKey: 'verify' };
  const verified = research.verifyEvidence(request, owner);
  assert.equal(verified.version, 2);
  assert.equal(verified.verification.verifiedBy, 'owner-fixture');
  assert.deepEqual(research.verifyEvidence(request, owner), verified);
  assert.throws(() => research.verifyEvidence({ ...request, status: 'rejected', idempotencyKey: 'stale' }, owner), hasCode('VERSION_CONFLICT'));
  const rejected = research.verifyEvidence({ ...request, expectedVersion: 2, status: 'rejected', reason: 'New counter-evidence', idempotencyKey: 'reject' }, owner);
  assert.equal(rejected.version, 3);
  assert.equal(rejected.contentSha256, initial.contentSha256);
});

test('evidence times and provenance are validated before storage', t => {
  const { open } = fixture(t); const { research } = open();
  const invalid = [
    { observedAt: new Date(Date.now() + 86400000).toISOString() },
    { publishedAt: '2026-01-01T01:00:00Z' }, { publishedAt: '2026-02-30T00:00:00Z' },
    { observedAt: '2026-01-01' }, { contentSha256: 'not-a-hash' }, { kind: 'verified-fact' },
    { sourceFamily: '../source' }, { source: '' },
  ];
  invalid.forEach((overrides, index) => assert.throws(() => research.recordEvidence({ ...evidence(overrides), idempotencyKey: `invalid-${index}` }), hasCode('VALIDATION')));
  assert.throws(() => research.recordEvidence({ ...evidence(), recordedAt: '2025-01-01T00:00:00Z', idempotencyKey: 'backdate' }), hasCode('VALIDATION'));
});

test('task freezes evidence classification, source grouping and thesis/skill/model/strategy references', t => {
  const { open } = fixture(t); const { research } = open();
  const a = reviewed(research, 'a', 'original-source-a');
  const b = reviewed(research, 'b', 'original-source-a', { locator: 'fixture:syndicated-copy' });
  const c = reviewed(research, 'c', 'original-source-b', { kind: 'inference', contentSha256: digest('reasoned interpretation') });
  const pending = research.recordEvidence({ ...evidence({ id: 'pending', sourceFamily: 'source-c' }), idempotencyKey: 'pending' });
  const frozen = research.freezeTask({ ...task([a.id, b.id, c.id, pending.id]), idempotencyKey: 'freeze' });
  assert.equal(frozen.independentSourceCount, 2);
  assert.equal(frozen.evidence[2].kind, 'inference');
  assert.equal(frozen.evidence[3].verification.status, 'pending');
  assert.equal(frozen.thesis.version, '1');
  assert.equal(frozen.skill.id, 'research-brain');
  assert.match(frozen.snapshotSha256, /^[a-f0-9]{64}$/);
  research.verifyEvidence({ evidenceId: a.id, expectedVersion: 2, status: 'rejected', reason: 'New evidence invalidates attribution', idempotencyKey: 'reject-a' }, owner);
  assert.equal(research.getTask(frozen.id).evidence[0].verification.status, 'verified');
  assert.equal(research.getTask(frozen.id).snapshotSha256, frozen.snapshotSha256);
});

test('candidate snapshots cannot become verified by later state changes; a new snapshot is required', t => {
  const { open } = fixture(t); const { research, journal } = open();
  const pending = research.recordEvidence({ ...evidence(), idempotencyKey: 'pending' });
  const frozen = research.freezeTask({ ...task([pending.id]), idempotencyKey: 'freeze' });
  const publication = { taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'publish' };
  assert.throws(() => research.publish(publication), hasCode('UNVERIFIED_EVIDENCE'));
  research.verifyEvidence({ evidenceId: pending.id, expectedVersion: 1, status: 'verified', reason: 'Now reviewed', idempotencyKey: 'verify' }, owner);
  assert.throws(() => research.publish(publication), hasCode('UNVERIFIED_EVIDENCE'));
  assert.equal(journal.list().total, 0);
  const current = research.freezeTask({ ...task([pending.id]), idempotencyKey: 'freeze-current' });
  assert.equal(research.publish({ ...publication, taskId: current.id }).status, 'committed');
});

test('journal publication preserves correlation and provenance without changing journal schema', t => {
  const { open } = fixture(t); const { research, journal } = open();
  const e = reviewed(research);
  const frozen = research.freezeTask({ ...task([e.id]), idempotencyKey: 'freeze' });
  const request = { taskId: frozen.id, kind: 'prediction', data: { title: 'Synthetic event', probability: 0.6,
    dueAt: new Date(Date.now() + 86400000).toISOString(), resolutionCriterion: 'Fixture equals one' }, idempotencyKey: 'publish' };
  const result = research.publish(request);
  assert.equal(result.status, 'committed');
  assert.equal(result.taskId, frozen.id);
  assert.equal(result.taskSnapshotSha256, frozen.snapshotSha256);
  assert.equal(result.journalRecord.kind, 'prediction');
  assert.deepEqual(result.journalRecord.data.model, frozen.model);
  assert.deepEqual(result.journalRecord.data.strategy, frozen.strategy);
  assert.ok(result.journalRecord.data.evidence[0].locator.includes(`/tasks/${frozen.id}/evidence/${e.id}#sha256=${frozen.snapshotSha256}`));
  assert.deepEqual(research.publish(request), result);
  assert.equal(journal.history(result.journalRecord.id).length, 1);
  assert.deepEqual(research.getPublication('publish'), result);
  assert.throws(() => research.publish({ ...request, data: { ...request.data, probability: 0.1 } }), hasCode('IDEMPOTENCY_CONFLICT'));
});

test('revoked or newly reverified evidence invalidates an old snapshot before first publication', t => {
  const { open } = fixture(t); const { research, journal } = open();
  const e = reviewed(research);
  const frozen = research.freezeTask({ ...task([e.id]), idempotencyKey: 'freeze' });
  research.verifyEvidence({ evidenceId: e.id, expectedVersion: 2, status: 'rejected', reason: 'Withdrawn source', idempotencyKey: 'revoke' }, owner);
  assert.throws(() => research.publish({ taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'publish' }), hasCode('STALE_EVIDENCE'));
  assert.equal(journal.list().total, 0);
});

test('failure before journal commit leaves a durable reservation and exact retry creates one record', t => {
  const f = fixture(t);
  const actual = f.open(); actual.research.close();
  let failOnce = true;
  const wrapper = { ...actual.journal, append(request) { if (failOnce) { failOnce = false; throw new Error('simulated before journal'); } return actual.journal.append(request); } };
  const { research } = f.open({ journal: wrapper });
  const e = reviewed(research);
  const frozen = research.freezeTask({ ...task([e.id]), idempotencyKey: 'freeze' });
  const request = { taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'publish' };
  assert.throws(() => research.publish(request), hasCode('STORAGE_FAILURE'));
  assert.equal(research.getPublication('publish').status, 'reserved');
  assert.equal(actual.journal.list().total, 0);
  research.close();
  const reopened = f.open({ journal: actual.journal }).research;
  const result = reopened.publish(request);
  assert.equal(result.status, 'committed');
  assert.equal(actual.journal.list().total, 1);
  assert.deepEqual(reopened.publish(request), result);
});

test('failure after journal commit reconciles original row after reopening without duplicate writes', t => {
  const f = fixture(t);
  const actual = f.open(); actual.research.close();
  let appendCount = 0;
  const wrapper = { ...actual.journal, append(request) { appendCount++; actual.journal.append(request); throw new Error('simulated after journal'); } };
  const { research } = f.open({ journal: wrapper });
  const e = reviewed(research);
  const frozen = research.freezeTask({ ...task([e.id]), idempotencyKey: 'freeze' });
  const request = { taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'publish' };
  assert.throws(() => research.publish(request), hasCode('STORAGE_FAILURE'));
  const original = actual.journal.list().records[0];
  assert.equal(research.getPublication('publish').status, 'reserved');
  research.close();
  const reopened = f.open({ journal: actual.journal }).research;
  const result = reopened.publish(request);
  assert.deepEqual(result.journalRecord, original);
  assert.equal(actual.journal.list().total, 1);
  assert.equal(appendCount, 1);
});

test('revocation after a journal commit does not erase history or prevent receipt recovery', t => {
  const f = fixture(t); const actual = f.open(); actual.research.close();
  const wrapper = { ...actual.journal, append(request) { actual.journal.append(request); throw new Error('simulated crash'); } };
  const { research } = f.open({ journal: wrapper });
  const e = reviewed(research);
  const frozen = research.freezeTask({ ...task([e.id]), idempotencyKey: 'freeze' });
  const request = { taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'publish' };
  assert.throws(() => research.publish(request));
  research.verifyEvidence({ evidenceId: e.id, expectedVersion: 2, status: 'rejected', reason: 'Later correction', idempotencyKey: 'reject' }, owner);
  assert.equal(research.publish(request).status, 'committed');
  assert.equal(actual.journal.list().total, 1);
  assert.equal(research.getEvidence(e.id).verification.status, 'rejected');
});

test('agent/environment namespaces and supplied journal handle must match', t => {
  const f = fixture(t); const main = f.open(); const group = f.open({ agentId: 'group-tim' }); const paper = f.open({ environment: 'paper' });
  const e = reviewed(main.research);
  const frozen = main.research.freezeTask({ ...task([e.id]), idempotencyKey: 'freeze' });
  assert.equal(group.research.getEvidence(e.id), null);
  assert.equal(paper.research.getTask(frozen.id), null);
  assert.throws(() => group.research.freezeTask({ ...task([e.id]), idempotencyKey: 'foreign' }), hasCode('NOT_FOUND'));
  assert.throws(() => paper.research.publish({ taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'foreign' }), hasCode('NOT_FOUND'));
  assert.throws(() => createResearch({ directory: f.directory, agentId: 'group-tim', environment: 'test', journal: main.journal }), hasCode('SCOPE_MISMATCH'));
});

test('task schema prevents forged scope, status, snapshot timestamps and missing provenance', t => {
  const { open } = fixture(t); const { research } = open(); const e = reviewed(research);
  const base = { ...task([e.id]), idempotencyKey: 'freeze' };
  for (const extra of [{ scope: { agentId: 'other' } }, { frozenAt: '2020-01-01T00:00:00Z' }, { independentSourceCount: 99 }]) {
    assert.throws(() => research.freezeTask({ ...base, ...extra }), hasCode('VALIDATION'));
  }
  assert.throws(() => research.freezeTask({ ...base, skill: { id: 'research-brain' } }), hasCode('VALIDATION'));
  assert.throws(() => research.freezeTask({ ...base, evidenceIds: [e.id, e.id] }), hasCode('VALIDATION'));
  const frozen = research.freezeTask(base);
  assert.throws(() => research.publish({ taskId: frozen.id, kind: 'decision', data: { ...decision, model: { id: 'forged' } }, idempotencyKey: 'publish' }), hasCode('VALIDATION'));
});

test('stored evidence and frozen snapshots detect accidental corruption', t => {
  const { directory, open } = fixture(t); const { research } = open(); const e = reviewed(research);
  const frozen = research.freezeTask({ ...task([e.id]), idempotencyKey: 'freeze' });
  const db = new DatabaseSync(path.join(directory, 'main/test/research.sqlite'));
  try {
    assert.throws(() => db.prepare('UPDATE research_tasks SET digest = ? WHERE id = ?').run('0'.repeat(64), frozen.id), /immutable/);
    db.exec('DROP TRIGGER research_tasks_no_update');
    db.prepare('UPDATE research_tasks SET digest = ? WHERE id = ?').run('0'.repeat(64), frozen.id);
    assert.throws(() => research.getTask(frozen.id), hasCode('CORRUPT_STORE'));
    assert.throws(() => research.publish({ taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'publish' }), hasCode('CORRUPT_STORE'));
  } finally { db.close(); }
});

test('a claimed verified inference retains its kind and never becomes a fact by publication', t => {
  const { open } = fixture(t); const { research, journal } = open();
  const inference = reviewed(research, 'inference', 'analysis-original', { kind: 'inference' });
  const frozen = research.freezeTask({ ...task([inference.id]), idempotencyKey: 'freeze' });
  const result = research.publish({ taskId: frozen.id, kind: 'decision', data: decision, idempotencyKey: 'publish' });
  assert.equal(research.getTask(result.taskId).evidence[0].kind, 'inference');
  assert.equal(journal.get(result.journalRecord.id).data.action, 'hold');
  assert.equal(journal.statistics().investmentPerformance, false);
});
