import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createJournal } from '../src/journal.mjs';
import { createResearch } from '../src/research.mjs';
import { createMonitorQueue } from '../src/monitor-queue.mjs';
import { createResearchWorkflow } from '../src/workflow.mjs';
import { createResearchHost } from '../src/host.mjs';

const owner = Object.freeze({ fixture: 'host-boundaries-owner' });
const receipt = { provider: 'fixture', id: 'synthetic-model', version: '1' };
const nonFixtureReceipt = { provider: 'non-fixture-provider', id: 'synthetic-untrusted-receipt', version: '1' };
const hasCode = code => error => error?.code === code;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const bounded = value => { assert.ok(bytes(value) <= 400 * 1024, 'public task response must fit 400 KiB'); return value; };
const context = { thesis: { id: 'synthetic-thesis', version: '1', locator: 'fixture:thesis' },
  skill: { id: 'research-brain', version: 'synthetic-revision' }, strategy: { id: 'synthetic-strategy', version: '1' } };
const source = (key, large = false) => ({ sourceKey: key, sourceFamily: `original-${key}`, kind: 'fact',
  source: large ? 'S'.repeat(512) : 'Synthetic source', locator: large ? `fixture:${'l'.repeat(504)}` : `fixture:${key}`,
  publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-01T00:01:00Z',
  content: large ? 'RETAINED_SYNTHETIC_CONTENT_'.padEnd(512, 'c') : 'Synthetic source only' });
const submission = (key, large = false) => ({ title: 'Synthetic host boundary task', question: 'Inspect synthetic retained evidence only.',
  sources: Array.from({ length: large ? 20 : 1 }, (_, i) => source(`source-${i}`, large)), context, idempotencyKey: `submit-${key}` });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'host-boundaries-test-')), handles = [];
  const scope = { directory, agentId: 'main', environment: 'test' };
  const journal = createJournal(scope), queue = createMonitorQueue(scope); handles.push(journal, queue);
  const research = createResearch({ ...scope, journal, authorizeVerification: ctx => ctx === owner ? { actorId: 'fixture-reviewer' } : null }); handles.push(research);
  const openWorkflow = (overrides = {}) => {
    const value = createResearchWorkflow({ ...scope, journal, queue, research,
      authorize: (_, ctx) => ctx === owner ? { actorId: 'fixture-owner' } : null, ...overrides });
    handles.push(value); return value;
  };
  const workflow = openWorkflow();
  const host = (mode = 'agent') => { const value = createResearchHost({ ...scope, actorId: 'fixture-local-operator', mode }); handles.push(value); return value; };
  t.after(() => { for (const handle of handles.reverse()) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { scope, journal, queue, research, workflow, openWorkflow, host };
}

test('legal task over 512 KiB projects get, submission retry, commit and reconciliation without hiding successful writes', t => {
  const f = fixture(t), agent = f.host(), operator = f.host('operator-test'), input = submission('large', true);
  const initial = bounded(agent.execute('task-submit', input));
  const proposals = [];
  for (let i = 0; i < 20; i++) proposals.push(bounded(agent.execute('task-propose', {
    taskId: initial.id, analysis: { kind: 'decision', data: {
      title: `SYNTHETIC_PROPOSAL_${i}_`.padEnd(1024, 't'), action: 'hold', reason: `SYNTHETIC_REASON_${i}_`.padEnd(16384, 'r'),
    } }, idempotencyKey: `large-proposal-${i}`,
  })));
  for (const [i, item] of initial.sources.entries()) operator.execute('evidence-verify', {
    evidenceId: item.evidenceId, expectedVersion: 1, status: 'verified',
    reason: `SYNTHETIC_VERIFICATION_${i}_`.padEnd(8192, 'v'), idempotencyKey: `large-verify-${i}`,
  });
  const full = f.workflow.get({ taskId: initial.id }, owner);
  assert.ok(bytes(full) > 512 * 1024, 'fixture must exercise the former post-write rejection');
  const assertSummary = result => {
    bounded(result); assert.equal(result.projection, 'summary'); assert.equal(result.id, initial.id);
    assert.equal(result.proposals.length, 20); assert.equal(result.evidence.length, 20); assert.equal(result.sources.length, 20);
    assert.deepEqual(result.proposals.map(item => ({ id: item.id, kind: item.kind, title: item.title })),
      proposals.map(item => ({ id: item.id, kind: item.analysis.kind, title: item.analysis.data.title })));
    assert.equal(result.sources.some(item => Object.hasOwn(item, 'content')), false);
    assert.ok(result.evidence.every(item => item.id && item.contentSha256));
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_VERIFICATION_'), false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_REASON_'), false);
    return result;
  };
  assertSummary(agent.execute('task-get', { taskId: initial.id }));
  assertSummary(agent.execute('task-submit', input));
  const committed = assertSummary(operator.execute('task-commit', { taskId: initial.id, proposalId: proposals[0].id,
    modelReceipt: receipt, idempotencyKey: 'large-commit' }));
  assert.equal(committed.phase, 'completed'); assert.equal(committed.status, 'completed');
  assert.equal(assertSummary(operator.execute('task-reconcile', { taskId: initial.id })).status, 'completed');
  assert.equal(f.queue.get({ id: initial.queueTaskId }).status, 'completed');
  assert.equal(f.journal.list().total, 1); assert.equal(f.queue.list().total, 1);

  const persisted = f.workflow.get({ taskId: initial.id }, owner);
  assert.equal(bytes(persisted) > 512 * 1024, true, 'projection must not trim persisted originals');
  const requests = [
    [{ detail: 'source', itemId: full.sources[0].evidenceId }, persisted.sources[0]],
    [{ detail: 'evidence', itemId: full.evidence[0].id }, persisted.evidence[0]],
    [{ detail: 'proposal', itemId: proposals[0].id }, persisted.proposals[0]],
    [{ detail: 'publication' }, persisted.publication],
  ];
  for (const [selector, original] of requests) assert.deepEqual(bounded(agent.execute('task-get', { taskId: initial.id, ...selector })), original);
  assert.equal(persisted.sources[0].content, input.sources[0].content);
  assert.equal(persisted.evidence[0].verification.reason.length, 8192);
  assert.equal(persisted.proposals[0].analysis.data.reason.length, 16384);
});

test('detail reads stay within the selected task and cannot add identity or approval fields', t => {
  const f = fixture(t), host = f.host();
  const first = host.execute('task-submit', submission('one')), second = host.execute('task-submit', submission('two'));
  const proposal = host.execute('task-propose', { taskId: second.id,
    analysis: { kind: 'decision', data: { title: 'Synthetic candidate', action: 'hold', reason: 'No execution' } }, idempotencyKey: 'second-proposal' });
  for (const request of [
    { taskId: first.id, detail: 'source', itemId: second.sources[0].evidenceId },
    { taskId: first.id, detail: 'evidence', itemId: second.sources[0].evidenceId },
    { taskId: first.id, detail: 'proposal', itemId: proposal.id },
    { taskId: first.id, detail: 'source' },
    { taskId: first.id, detail: 'publication', itemId: first.sources[0].evidenceId },
    { taskId: first.id, detail: 'source', itemId: first.sources[0].evidenceId, actorId: 'owner' },
    { taskId: first.id, detail: 'source', itemId: first.sources[0].evidenceId, scope: { agentId: 'group-tim' } },
  ]) assert.throws(() => host.execute('task-get', request));
  assert.equal(f.journal.list().total, 0);
  for (const command of ['task-reconcile', 'review-create', 'prediction-resolve'])
    assert.throws(() => host.execute(command, {}), hasCode('HOST_OPERATION_FORBIDDEN'));
});

test('operator-test cannot resume an existing non-fixture model intent even before its snapshot exists', t => {
  const f = fixture(t), task = f.workflow.submit(submission('foreign-intent'), owner);
  f.research.verifyEvidence({ evidenceId: task.sources[0].evidenceId, expectedVersion: 1, status: 'verified',
    reason: 'Synthetic fixture checked', idempotencyKey: 'verify-intent' }, owner);
  const proposal = f.workflow.propose({ taskId: task.id,
    analysis: { kind: 'decision', data: { title: 'Synthetic candidate', action: 'hold', reason: 'Synthetic boundary exercise' } },
    idempotencyKey: 'intent-proposal' }, owner);
  const interrupted = f.openWorkflow({ research: { ...f.research, freezeTask() { throw new Error('Synthetic pre-freeze interruption'); } } });
  const pending = interrupted.commit({ taskId: task.id, proposalId: proposal.id, modelReceipt: nonFixtureReceipt, idempotencyKey: 'foreign-model-intent' }, owner);
  assert.equal(pending.phase, 'committing'); assert.equal(pending.publication, null); assert.deepEqual(pending.modelReceipt, nonFixtureReceipt);
  const operator = f.host('operator-test');
  assert.throws(() => operator.execute('task-reconcile', { taskId: task.id }), hasCode('HOST_FIXTURE_RECEIPT_REQUIRED'));
  assert.equal(f.journal.list().total, 0); assert.equal(f.queue.get({ id: task.queueTaskId }).attempts, 0);
  assert.deepEqual(f.workflow.get({ taskId: task.id }, owner).modelReceipt, nonFixtureReceipt);
});

function frozenEvidence(f, modelReceipt) {
  const evidence = f.research.recordEvidence({ sourceFamily: 'fixture-origin', kind: 'fact', source: 'Synthetic source', locator: 'fixture:outcome',
    publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-01T00:01:00Z',
    contentSha256: createHash('sha256').update('synthetic').digest('hex'), idempotencyKey: 'record-outcome' });
  f.research.verifyEvidence({ evidenceId: evidence.id, expectedVersion: 1, status: 'verified', reason: 'Synthetic source checked', idempotencyKey: 'verify-outcome' }, owner);
  return f.research.freezeTask({ title: 'Synthetic outcome snapshot', evidenceIds: [evidence.id], ...context,
    model: modelReceipt, idempotencyKey: 'freeze-outcome' });
}
function prediction(f, modelReceipt) {
  return f.journal.append({ kind: 'prediction', data: { title: 'Synthetic event only', probability: 0.6,
    dueAt: new Date(Date.now() + 86400000).toISOString(), resolutionCriterion: 'Synthetic fixture observed as one',
    evidence: [{ source: 'Synthetic original', locator: 'fixture:original', observedAt: '2026-01-01T00:00:00Z' }],
    model: modelReceipt, strategy: context.strategy }, idempotencyKey: 'original-prediction' });
}
for (const command of ['review-create', 'prediction-resolve']) for (const foreign of ['evidence', 'target']) {
  test(`operator-test rejects ${command} when the ${foreign} frozen model provider is non-fixture`, t => {
    const f = fixture(t), frozen = frozenEvidence(f, foreign === 'evidence' ? nonFixtureReceipt : receipt);
    const original = prediction(f, foreign === 'target' ? nonFixtureReceipt : receipt), operator = f.host('operator-test');
    const common = { target: { id: original.id, version: original.version }, evidenceTaskId: frozen.id, idempotencyKey: `blocked-${foreign}` };
    const request = command === 'review-create' ? { ...common, title: 'Synthetic retrospective', result: 'No live model was called.', lessons: ['Synthetic boundary exercise.'] }
      : { ...common, criterionResult: 1, resolvedAt: new Date().toISOString(), reason: 'Synthetic outcome only' };
    assert.throws(() => operator.execute(command, request), hasCode('HOST_FIXTURE_RECEIPT_REQUIRED'));
    assert.equal(f.journal.list().total, 1); assert.deepEqual(f.journal.get(original.id), original);
    assert.equal(f.journal.list({ kind: 'review' }).total, 0); assert.equal(f.journal.list({ kind: 'resolution' }).total, 0);
  });
}
