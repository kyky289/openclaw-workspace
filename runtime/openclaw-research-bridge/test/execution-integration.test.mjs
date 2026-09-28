import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchHost } from '../../research-core/src/host.mjs';
import { registerResearchBridge } from '../src/register.mjs';
import { createNativeReceiptService } from '../src/native-receipt-service.mjs';

const nativeSessionId = '11111111-2222-4333-a444-555555555555';
const sessionId = '22222222-3333-4444-a555-666666666666';
const owner = { sessionKey: 'agent:main:main', nativeChannelId: '123', requesterSenderId: '123' };
const group = { sessionKey: 'agent:main:telegram:group:-100123', nativeChannelId: '-100123', requesterSenderId: '123' };
const request = key => ({ title: 'Synthetic execution receipt test', question: 'Synthetic only', idempotencyKey: key,
  context: { thesis: { id: 'fixture', version: '1', locator: 'synthetic://fixture' },
    skill: { id: 'fixture', version: '1' }, strategy: { id: 'fixture', version: '1' } },
  sources: [{ sourceKey: 'fixture', sourceFamily: 'fixture', kind: 'fact', source: 'Synthetic fixture', locator: 'synthetic://fixture',
    publishedAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-01T00:00:00.000Z', content: '[SYNTHETIC TEST DATA]' }] });

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'execution-integration-')), directory = join(root, 'research-bridge-test');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { enabled: true, environment: 'test', stateDirectory: directory, allowedContexts: [owner], allowedGroupContexts: [group] };
  const records = [], services = []; let observer, factory, timers = 0, stopped = 0;
  function register() {
    registerResearchBridge({ pluginConfig: config, registerTool(value) { factory = value; }, registerService(service) { services.push(service); } },
      { createHost: createResearchHost, createNativeObserver(options) {
        observer = createNativeReceiptService({ ...options, homeDirectory: root,
          resolveSession: () => ({ status: 'ready', nativeSessionId }),
          readSource: () => ({ status: 'ready', nativeSessionId, records }),
          setTimer: () => { timers++; return { unref() {} }; }, clearTimer: () => { stopped++; }, ...overrides });
        return observer;
      } });
  }
  register();
  function tools(tuple = owner) {
    return factory({ ...tuple, agentId: 'main', messageChannel: 'telegram', senderIsOwner: true, sessionId,
      activeModel: { provider: 'claude-cli', modelId: 'selected-alias' } });
  }
  async function invoke(name, input, tuple = owner) {
    return JSON.parse((await tools(tuple).find(tool => tool.name === name).execute('mcp-unrelated-to-native-id', input)).content[0].text);
  }
  function addCall(toolName, input, result, suffix) {
    const timestamp = result.result.createdAt, uuid = `assistant-${suffix}`, toolId = `toolu-${suffix}`;
    records.push({ type: 'assistant', isSidechain: false, sessionId: nativeSessionId, uuid, timestamp,
      requestId: 'shared-provider-request', message: { id: 'shared-model-message', model: 'claude-fixture-observed', role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: toolId, name: `mcp__openclaw__${toolName}`, input }] } });
    records.push({ type: 'user', isSidechain: false, sessionId: nativeSessionId, uuid: `result-${suffix}`,
      sourceToolAssistantUUID: uuid, timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId,
        content: [{ type: 'text', text: JSON.stringify(result) }] }] } });
  }
  return { config, directory, records, services, invoke, addCall, register, get observer() { return observer; }, get timers() { return timers; }, get stopped() { return stopped; } };
}

test('real host captures and automatically correlates model records without approving the candidate', async t => {
  const f = fixture(t), input = request('receipt-submit');
  const submitted = await f.invoke('research_task_submit', input);
  assert.equal(submitted.ok, true); assert.equal(submitted.provenance.executionEvidence.status, 'pending');
  const proposedInput = { taskId: submitted.result.id, idempotencyKey: 'receipt-propose',
    analysis: { kind: 'decision', data: { title: 'Fixture candidate', action: 'research', reason: 'Synthetic only' } } };
  const proposed = await f.invoke('research_task_propose', proposedInput);
  let task = (await f.invoke('research_task_get', { taskId: submitted.result.id })).result;
  assert.equal(task.executionEvidence.pending, 2); assert.equal(task.executionEvidence.total, 0);
  f.addCall('research_task_submit', input, submitted, 'submit'); f.addCall('research_task_propose', proposedInput, proposed, 'propose');
  task = (await f.invoke('research_task_get', { taskId: submitted.result.id })).result;
  assert.equal(task.executionEvidence.status, 'recorded'); assert.equal(task.executionEvidence.total, 2);
  const [a, b] = task.executionEvidence.receipts;
  assert.equal(a.observation.usage.accountingKey, b.observation.usage.accountingKey, 'one model message shared by two tools is not double usage');
  assert.equal(a.observation.usage.inputTokens, 100); assert.equal(b.observation.usage.inputTokens, 100);
  for (const receipt of [a, b]) {
    assert.equal(receipt.observation.observedModel.id, 'claude-fixture-observed');
    assert.equal(receipt.observation.requestedModel.id, 'selected-alias');
    assert.equal(receipt.observation.cost.status, 'unknown'); assert.equal(receipt.observation.cost.amountUsd, null);
    assert.equal(receipt.verification, 'host-observed-not-provider-signed');
    const detail = (await f.invoke('research_task_get', { taskId: task.id, detail: 'execution', itemId: receipt.executionId })).result;
    assert.deepEqual(detail, receipt);
  }
  assert.equal(task.modelReceipt, null); assert.equal(task.publication, null); assert.equal(task.phase, 'needs-review');
  assert.equal(task.proposals[0].status, 'candidate'); assert.equal(task.evidence[0].verification.status, 'pending');
  const text = JSON.stringify(task.executionEvidence);
  assert.equal(text.includes(nativeSessionId), false); assert.equal(text.includes(sessionId), false); assert.equal(text.includes('toolu-submit'), false);
  f.register(); // Reopen all host handles, keeping the durable binding and receipt state.
  const again = (await f.invoke('research_task_get', { taskId: task.id })).result;
  assert.deepEqual(again.executionEvidence.receipts, task.executionEvidence.receipts);
  assert.equal((await f.invoke('research_task_submit', input)).provenance.executionEvidence.status, 'observed');
  assert.equal((await f.invoke('research_task_get', { taskId: task.id }, group)).code, 'NOT_FOUND');
  assert.equal((await f.invoke('research_task_get', { taskId: task.id, detail: 'execution', itemId: a.executionId }, group)).code, 'NOT_FOUND');
});

test('candidate persists when observation fails, and model inputs cannot write or forge receipts', async t => {
  const f = fixture(t, { resolveSession() { throw new Error('private diagnostic must not be returned'); },
    readSource() { throw new Error('private diagnostic must not be returned'); } });
  const saved = await f.invoke('research_task_submit', request('unknown-source'));
  assert.equal(saved.ok, true); assert.equal(saved.result.phase, 'needs-review');
  const found = await f.invoke('research_task_get', { taskId: saved.result.id });
  assert.equal(found.ok, true); assert.equal(found.result.executionEvidence.total, 0);
  assert.equal(found.result.executionEvidence.pending, 1); assert.equal(JSON.stringify(found).includes('private diagnostic'), false);
  const rejected = await f.invoke('research_task_propose', { taskId: saved.result.id, idempotencyKey: 'forged',
    analysis: { kind: 'decision', data: { title: 'Fake', action: 'research', reason: 'Fixture' } }, executionReceipt: { verified: true } });
  assert.equal(rejected.code, 'INVALID_REQUEST');
  const host = createResearchHost({ directory: f.directory, agentId: 'main', environment: 'test', actorId: 'fixture-owner' });
  try { assert.throws(() => host.execute('execution-receipt-append', {}), error => error.code === 'HOST_OPERATION_FORBIDDEN'); }
  finally { host.close(); }
});

test('observer reuses the existing gateway lifecycle and start/stop are idempotent', async t => {
  const f = fixture(t);
  assert.equal(f.services.length, 1); assert.equal(f.services[0].id, 'research-execution-receipts');
  f.services[0].start(); f.services[0].start(); assert.equal(f.timers, 1);
  f.services[0].stop(); f.services[0].stop(); assert.equal(f.stopped, 1);
  assert.throws(() => f.observer.reconcileScope('unapproved-group'), error => error.code === 'UNAUTHORIZED');
});

test('polling unchanged unavailable evidence does not create repeated status events', async t => {
  const f = fixture(t);
  const saved = await f.invoke('research_task_submit', request('pending-polls'));
  for (let i = 0; i < 10; i++) await f.invoke('research_task_get', { taskId: saved.result.id });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(f.directory, 'main', 'test', 'execution-bindings.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_binding_status_events').get().n, 1); }
  finally { db.close(); }
});

test('all 20 candidate receipts and the original submission remain discoverable', async t => {
  const f = fixture(t), input = request('full-task');
  const submitted = await f.invoke('research_task_submit', input);
  f.addCall('research_task_submit', input, submitted, 'full-submit');
  const proposals = [];
  for (let i = 0; i < 20; i++) {
    const payload = { taskId: submitted.result.id, idempotencyKey: `full-proposal-${i}`,
      analysis: { kind: 'decision', data: { title: `Fixture ${i}`, action: 'research', reason: 'Synthetic only' } } };
    const result = await f.invoke('research_task_propose', payload); assert.equal(result.ok, true);
    proposals.push(result.result.id); f.addCall('research_task_propose', payload, result, `full-${i}`);
  }
  let task;
  for (let i = 0; i < 3; i++) task = (await f.invoke('research_task_get', { taskId: submitted.result.id })).result;
  assert.equal(task.executionEvidence.pending, 0); assert.equal(task.executionEvidence.total, 21);
  assert.equal(task.executionEvidence.receipts.length, 21);
  assert.equal(new Set(task.executionEvidence.receipts.filter(r => r.proposalId !== null).map(r => r.proposalId)).size, 20);
  assert.ok(task.executionEvidence.receipts.some(r => r.proposalId === proposals.at(-1)));
});

test('receipt commit followed by status failure resumes without duplicate receipts or revisions', async t => {
  const f = fixture(t), input = request('interrupted-mark');
  const submitted = await f.invoke('research_task_submit', input);
  f.addCall('research_task_submit', input, submitted, 'interrupted');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(f.directory, 'main', 'test', 'execution-bindings.sqlite');
  let db = new DatabaseSync(file);
  db.exec(`CREATE TRIGGER fixture_fail_mark BEFORE INSERT ON execution_binding_status_events
    WHEN json_extract(NEW.record_json, '$.status') = 'observed' BEGIN SELECT RAISE(ABORT, 'fixture'); END;`); db.close();
  const first = (await f.invoke('research_task_get', { taskId: submitted.result.id })).result;
  assert.equal(first.executionEvidence.total, 1); assert.equal(first.executionEvidence.pending, 1);
  db = new DatabaseSync(file); db.exec('DROP TRIGGER fixture_fail_mark'); db.close();
  f.register();
  const resumed = (await f.invoke('research_task_get', { taskId: submitted.result.id })).result;
  assert.equal(resumed.executionEvidence.total, 1); assert.equal(resumed.executionEvidence.pending, 0);
  assert.deepEqual(resumed.executionEvidence.receipts, first.executionEvidence.receipts);
  assert.equal(resumed.executionEvidence.receipts[0].version, 1);
});
