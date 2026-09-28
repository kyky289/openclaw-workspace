import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createExecutionReceipts } from '../src/execution-receipts.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hostContext = Object.freeze({ trusted: true });
const scope = { agentId: 'main', environment: 'test' };
const hasCode = code => error => error?.code === code;
const copy = value => JSON.parse(JSON.stringify(value));
function observation(overrides = {}) {
  return { source: { kind: 'native-runtime-log', adapterId: 'fixture-native-parser', adapterVersion: '1.0.0', recordSha256: digest('redacted fixture events') },
    correlation: { nativeSessionSha256: digest('native-session'), nativeRunSha256: null, messageSha256: digest('native-message'),
      toolCallSha256: digest('native-tool-call'), requestSha256: digest('tool-request'), resultSha256: digest('tool-result'), toolName: 'research_task_propose' },
    requestedModel: { provider: 'fixture', id: 'requested-alias' }, observedModel: { provider: 'fixture', id: 'observed-version-1' },
    usage: { granularity: 'message', accountingKey: digest('message-usage'), inputTokens: 40, outputTokens: 30,
      cacheReadInputTokens: null, cacheCreationInputTokens: 0 },
    cost: { status: 'unknown', currency: 'USD', amountUsd: null, basis: 'unknown', granularity: 'unknown', accountingKey: null },
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', outcome: 'tool-succeeded', ...overrides };
}
function request(overrides = {}) {
  return { idempotencyKey: 'receipt-first', executionId: 'execution-first', expectedVersion: 0,
    taskId: 'task-one', proposalId: 'proposal-one', observation: observation(), ...overrides };
}
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'execution-receipt-test-')), handles = [];
  const open = (overrides = {}) => {
    const handle = createExecutionReceipts({ directory, ...scope,
      authorizeWrite: (_request, context) => context === hostContext ? { actorId: 'trusted-host-fixture' } : null,
      resolveTarget: ({ taskId, proposalId }) => ['task-one', 'task-two'].includes(taskId)
        && (proposalId === null || (taskId === 'task-one' && ['proposal-one', 'proposal-two'].includes(proposalId)))
        ? { scope, taskId, proposalId } : null,
      ...overrides });
    handles.push(handle); return handle;
  };
  t.after(() => { handles.reverse().forEach(handle => handle.close()); rmSync(directory, { recursive: true, force: true }); });
  return { directory, open, filename: path.join(directory, scope.agentId, scope.environment, 'execution-receipts.sqlite') };
}

test('records observed and requested models separately without claiming provider attestation or a bill', t => {
  const f = fixture(t), receipts = f.open(), original = request();
  const result = receipts.append(original, hostContext);
  assert.equal(result.version, 1); assert.equal(result.schemaVersion, 1);
  assert.equal(result.verification, 'host-observed-not-provider-signed');
  assert.equal(result.observation.requestedModel.id, 'requested-alias');
  assert.equal(result.observation.observedModel.id, 'observed-version-1');
  assert.equal(result.observation.cost.amountUsd, null); assert.equal(result.observation.cost.status, 'unknown');
  assert.equal(result.observation.usage.cacheReadInputTokens, null);
  assert.equal(result.observation.usage.cacheCreationInputTokens, 0);
  assert.equal(result.observation.correlation.nativeRunSha256, null);
  assert.equal(result.observation.outcome, 'tool-succeeded');
  assert.equal(result.recordedBy, 'trusted-host-fixture'); assert.equal(result.previousDigest, null);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  original.observation.observedModel.id = 'mutated-input'; result.observation.observedModel.id = 'mutated-return';
  assert.equal(receipts.get({ executionId: original.executionId }).observation.observedModel.id, 'observed-version-1');
});

test('exact retries survive reopen and return their original version after later amendments', t => {
  const f = fixture(t), receipts = f.open(), original = request();
  const first = receipts.append(original, hostContext);
  const changed = copy(original); changed.expectedVersion = 1; changed.idempotencyKey = 'receipt-estimated';
  changed.observation.cost = { status: 'estimate', currency: 'USD', amountUsd: 0.0021, basis: 'native-runtime-estimate',
    granularity: 'run', accountingKey: digest('run-cost') };
  changed.observation.source.recordSha256 = digest('later estimate event');
  const second = receipts.append(changed, hostContext);
  assert.equal(second.version, 2); assert.equal(second.previousDigest, first.digest);
  receipts.close(); const reopened = f.open();
  assert.deepEqual(reopened.append(original, hostContext), first);
  assert.deepEqual(reopened.get({ executionId: original.executionId }), second);
  assert.deepEqual(reopened.get({ executionId: original.executionId, version: 1 }), first);
  assert.equal(reopened.history({ executionId: original.executionId }).total, 2);
  assert.throws(() => reopened.append({ ...original, observation: observation({ observedModel: null }) }, hostContext), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => reopened.append({ ...original, idempotencyKey: 'stale-revision' }, hostContext), hasCode('VERSION_CONFLICT'));
});

test('write capability is denied without an exact trusted context and cannot be forged with input fields', t => {
  const f = fixture(t), receipts = f.open();
  for (const forged of [undefined, { trusted: true }, { actorId: 'trusted-host-fixture' }]) {
    assert.throws(() => receipts.append(request(), forged), hasCode('UNAUTHORIZED'));
  }
  const disabled = f.open({ authorizeWrite: undefined });
  assert.throws(() => disabled.append(request(), hostContext), hasCode('UNAUTHORIZED'));
  const asynchronous = f.open({ authorizeWrite: async () => ({ actorId: 'trusted-host-fixture' }) });
  assert.throws(() => asynchronous.append(request(), hostContext), hasCode('UNAUTHORIZED'));
  for (const field of ['recordedBy', 'verification', 'scope', 'modelReceipt']) {
    assert.throws(() => receipts.append({ ...request(), [field]: 'forged' }, hostContext), hasCode('VALIDATION'));
  }
  assert.equal(receipts.list({ taskId: 'task-one' }).total, 0);
});

test('only a real task/proposal relationship in the trusted scope can receive a receipt', t => {
  const f = fixture(t), receipts = f.open();
  assert.throws(() => receipts.append(request({ taskId: 'missing-task' }), hostContext), hasCode('TARGET_NOT_FOUND'));
  assert.throws(() => receipts.append(request({ taskId: 'task-two' }), hostContext), hasCode('TARGET_NOT_FOUND'));
  assert.throws(() => f.open({ resolveTarget: undefined }).append(request(), hostContext), hasCode('TARGET_NOT_FOUND'));
  assert.throws(() => f.open({ resolveTarget: () => ({ scope: { ...scope, agentId: 'group' }, taskId: 'task-one', proposalId: 'proposal-one' }) })
    .append(request(), hostContext), hasCode('SCOPE_MISMATCH'));
  assert.throws(() => f.open({ resolveTarget: () => ({ scope, taskId: 'task-two', proposalId: 'proposal-one' }) })
    .append(request(), hostContext), hasCode('TARGET_MISMATCH'));
  assert.equal(receipts.list({ taskId: 'task-one' }).total, 0);
});

test('a native tool invocation cannot be remapped or duplicated by changing receipt IDs', t => {
  const receipts = fixture(t).open(), original = request(); receipts.append(original, hostContext);
  assert.throws(() => receipts.append({ ...original, idempotencyKey: 'other-id', executionId: 'another-receipt' }, hostContext), hasCode('BINDING_CONFLICT'));
  assert.throws(() => receipts.append({ ...original, idempotencyKey: 'other-target', executionId: 'another-receipt', proposalId: 'proposal-two' }, hostContext), hasCode('BINDING_CONFLICT'));
  assert.throws(() => receipts.append({ ...original, idempotencyKey: 'wrong-proposal', expectedVersion: 1, proposalId: 'proposal-two' }, hostContext), hasCode('BINDING_CONFLICT'));
  for (const field of ['nativeSessionSha256', 'toolCallSha256', 'requestSha256', 'resultSha256', 'messageSha256']) {
    const changed = copy(original); changed.idempotencyKey = `alter-${field}`; changed.expectedVersion = 1;
    changed.observation.correlation[field] = digest('other');
    assert.throws(() => receipts.append(changed, hostContext), hasCode('BINDING_CONFLICT'));
  }
  assert.equal(receipts.history({ executionId: original.executionId }).total, 1);
});

test('unknown values stay null and raw content, secrets fields, invalid numbers and forged bills are rejected', t => {
  const receipts = fixture(t).open();
  const invalid = [
    value => { value.cost.amountUsd = 0; },
    value => { value.cost.status = 'estimate'; },
    value => { value.cost = { ...value.cost, status: 'reported', basis: 'provider-reported', amountUsd: 1 }; },
    value => { value.cost = { status: 'reconciled', basis: 'billing-reconciled', amountUsd: 1, currency: 'USD', granularity: 'run', accountingKey: digest('cost') }; },
    value => { value.usage.accountingKey = null; },
    value => { value.usage.inputTokens = -1; },
    value => { value.usage.outputTokens = Infinity; },
    value => { value.usage.inputTokens = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.source.rawLog = 'sensitive content'; },
    value => { value.source.path = '/private/log'; },
    value => { value.correlation.nativeSessionId = 'raw-session-id'; },
    value => { value.observedModel.apiKey = 'sensitive credential'; },
    value => { value.observedModel.id = 'x'.repeat(257); },
    value => { value.source.adapterVersion = 'contains spaces and text'; },
    value => { value.outcome = 'model-turn-completed'; },
    value => { value.startedAt = '2026-02-30T00:00:00Z'; },
    value => { value.endedAt = '2025-12-31T00:00:00Z'; },
  ];
  for (const [index, alter] of invalid.entries()) {
    const input = request({ idempotencyKey: `invalid-${index}` }); alter(input.observation);
    assert.throws(() => receipts.append(input, hostContext), hasCode('VALIDATION'));
  }
  assert.equal(receipts.list({ taskId: 'task-one' }).total, 0);
});

test('multiple tools from one model message preserve a common accounting identity without adding totals', t => {
  const receipts = fixture(t).open(), first = request(); receipts.append(first, hostContext);
  const second = copy(first); second.idempotencyKey = 'second-tool'; second.executionId = 'second-receipt'; second.proposalId = 'proposal-two';
  second.observation.correlation.toolCallSha256 = digest('second-tool-call');
  second.observation.correlation.requestSha256 = digest('second-request'); second.observation.correlation.resultSha256 = digest('second-result');
  receipts.append(second, hostContext);
  const page = receipts.list({ taskId: 'task-one' });
  assert.equal(page.total, 2); assert.equal(page.receipts.length, 2);
  assert.equal(new Set(page.receipts.map(record => record.observation.usage.accountingKey)).size, 1);
  assert.equal(page.receipts[0].observation.usage.granularity, 'message');
  assert.equal('totalTokens' in page, false); assert.equal('totalCostUsd' in page, false);
});

test('submission receipts have no proposal; incomplete observations remain explicitly unknown', t => {
  const receipts = fixture(t).open(), input = request({ proposalId: null });
  input.observation.correlation.toolName = 'research_task_submit'; input.observation.correlation.messageSha256 = null;
  input.observation.requestedModel = null; input.observation.observedModel = null; input.observation.endedAt = null;
  input.observation.usage = { granularity: 'unknown', accountingKey: null, inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null };
  const result = receipts.append(input, hostContext);
  assert.equal(result.proposalId, null); assert.equal(result.observation.endedAt, null);
  assert.equal(receipts.list({ taskId: 'task-one', proposalId: null }).total, 1);
  assert.equal(receipts.list({ taskId: 'task-one', proposalId: 'proposal-one' }).total, 0);
  assert.throws(() => receipts.append({ ...request(), proposalId: null }, hostContext), hasCode('VALIDATION'));
});

test('receipt reads are scoped and bounded; replacing a scope database is rejected', t => {
  const f = fixture(t), receipts = f.open(); receipts.append(request(), hostContext);
  const other = f.open({ agentId: 'group', resolveTarget: () => null });
  assert.equal(other.get({ executionId: 'execution-first' }), null);
  assert.equal(other.list({ taskId: 'task-one' }).total, 0);
  assert.throws(() => receipts.list({ taskId: 'task-one', scope: { ...scope, agentId: 'group' } }), hasCode('VALIDATION'));
  assert.throws(() => receipts.list({ taskId: 'task-one', limit: 101 }), hasCode('VALIDATION'));
  assert.throws(() => receipts.history({ executionId: 'execution-first', offset: -1 }), hasCode('VALIDATION'));
  assert.equal(receipts.list({ taskId: 'task-one', limit: 1, offset: 1 }).receipts.length, 0);
  assert.deepEqual(receipts.list({ taskId: 'task-one', proposalId: undefined }), receipts.list({ taskId: 'task-one' }));
  other.close(); const otherFilename = path.join(f.directory, 'group', 'test', 'execution-receipts.sqlite');
  copyFileSync(f.filename, otherFilename); chmodSync(otherFilename, 0o600);
  assert.throws(() => f.open({ agentId: 'group' }), hasCode('STORE_SCOPE_MISMATCH'));
});

test('SQLite triggers reject mutation; digest validation detects bypassed modifications without leaking content', t => {
  const f = fixture(t), receipts = f.open(); receipts.append(request(), hostContext);
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  assert.throws(() => db.exec('DELETE FROM execution_receipt_revisions'));
  assert.throws(() => db.exec("UPDATE execution_receipt_targets SET task_id='changed'"));
  db.exec('DROP TRIGGER execution_receipt_revisions_no_update');
  const row = db.prepare('SELECT record_json FROM execution_receipt_revisions').get();
  const value = JSON.parse(row.record_json); value.observation.observedModel.id = 'secret-raw-value';
  db.prepare('UPDATE execution_receipt_revisions SET record_json=?').run(JSON.stringify(value));
  assert.throws(() => receipts.get({ executionId: 'execution-first' }), error => error.code === 'CORRUPT_STORE' && !error.message.includes('secret-raw-value'));
  assert.throws(() => receipts.append(request(), hostContext), hasCode('CORRUPT_STORE'));
});

test('unknown billing metadata cannot accidentally become zero, while a reconciled amendment preserves history', t => {
  const receipts = fixture(t).open(), input = request(), original = receipts.append(input, hostContext);
  const update = copy(input); update.expectedVersion = 1; update.idempotencyKey = 'billing-reconciliation';
  update.observation.source = { ...update.observation.source, kind: 'billing-reconciliation', recordSha256: digest('fixture billing event') };
  update.observation.cost = { status: 'reconciled', currency: 'USD', amountUsd: 0, basis: 'billing-reconciled',
    granularity: 'run', accountingKey: digest('fixture billed run') };
  const reconciled = receipts.append(update, hostContext);
  assert.equal(reconciled.observation.cost.amountUsd, 0); assert.equal(reconciled.observation.cost.status, 'reconciled');
  assert.deepEqual(receipts.get({ executionId: input.executionId, version: 1 }), original);
  assert.equal(receipts.history({ executionId: input.executionId, limit: 1, offset: 1 }).receipts[0].version, 2);
});

test('sensitive parser diagnostics do not escape target or authorization callbacks', t => {
  const f = fixture(t), secret = 'sensitive host diagnostic';
  const deny = f.open({ authorizeWrite() { throw new Error(secret); } });
  assert.throws(() => deny.append(request(), hostContext), error => error.code === 'UNAUTHORIZED' && !error.message.includes(secret));
  const unresolved = f.open({ resolveTarget() { throw new Error(secret); } });
  assert.throws(() => unresolved.append(request(), hostContext), error => error.code === 'TARGET_NOT_FOUND' && !error.message.includes(secret));
  assert.equal(readFileSync(f.filename).includes(Buffer.from(secret)), false);
});

test('symbols, hidden fields and getters are rejected without executing accessors', t => {
  const receipts = fixture(t).open(); let getterCalls = 0;
  const inputs = [request(), request(), request(), request(), request()];
  inputs[0][Symbol('hidden-authority')] = true;
  Object.defineProperty(inputs[1], 'secret', { value: 'hidden', enumerable: false });
  Object.defineProperty(inputs[2], 'taskId', { get() { getterCalls++; throw new Error('secret getter diagnostic'); }, enumerable: true });
  Object.defineProperty(inputs[3].observation.cost, 'amountUsd', { value: null, enumerable: false });
  Object.defineProperty(inputs[4].observation.source, 'recordSha256', { get() { getterCalls++; return digest('getter'); }, enumerable: true });
  for (const input of inputs) assert.throws(() => receipts.append(input, hostContext), hasCode('VALIDATION'));
  const read = { executionId: 'execution-first' }; Object.defineProperty(read, 'version', { get() { getterCalls++; return 1; }, enumerable: true });
  assert.throws(() => receipts.get(read), hasCode('VALIDATION'));
  assert.equal(getterCalls, 0); assert.equal(receipts.list({ taskId: 'task-one' }).total, 0);
});
