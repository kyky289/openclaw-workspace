import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectNativeExecution } from '../src/native-execution-receipts.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const uuid = '11111111-1111-1111-1111-111111111111';
const clone = value => structuredClone(value);
function fixture(toolName = 'research_task_propose') {
  const input = toolName === 'research_task_propose' ? { taskId: 'task-1', idempotencyKey: 'proposal-1', analysis: { kind: 'decision', data: { title: 'TEST', action: 'research', reason: 'Synthetic only' } } }
    : { title: 'TEST', question: 'Synthetic only', idempotencyKey: 'submit-1', sources: [] };
  const at = '2026-09-28T06:46:18.155Z';
  const result = toolName === 'research_task_propose' ? { id: 'proposal-1', taskId: 'task-1', status: 'candidate', proposedBy: 'tg-test', createdAt: at, analysis: input.analysis }
    : { id: 'task-1', submittedBy: 'tg-test', createdAt: at, scope: { agentId: 'main', environment: 'test' } };
  const binding = { toolName, taskId: 'task-1', proposalId: toolName === 'research_task_propose' ? 'proposal-1' : null,
    actorId: 'tg-test', createdAt: at, sessionKey: 'agent:main:main', sessionId: '22222222-2222-2222-2222-222222222222',
    nativeSessionId: uuid, requestSha256: hash(input), resultSha256: hash(result), requestedModel: { provider: 'claude-cli', id: 'requested-selection' } };
  const assistant = { type: 'assistant', uuid: 'assistant-row', parentUuid: 'previous-row', sessionId: uuid, isSidechain: false,
    requestId: 'native-request', timestamp: '2026-09-28T06:46:18.100Z', message: { role: 'assistant', id: 'native-message',
      model: 'claude-test-v1', usage: { input_tokens: 2, output_tokens: 80, cache_creation_input_tokens: 100, cache_read_input_tokens: 400 },
      content: [{ type: 'tool_use', id: 'toolu-native-1', name: `mcp__openclaw__${toolName}`, input }] } };
  const returned = { type: 'user', uuid: 'result-row', parentUuid: 'assistant-row', sourceToolAssistantUUID: 'assistant-row', sessionId: uuid,
    isSidechain: false, timestamp: '2026-09-28T06:46:18.200Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-native-1',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, result, provenance: { actualModelReceipt: null }, automaticTradingAuthorized: false }) }] }] } };
  return { binding, source: { nativeSessionId: uuid, records: [assistant, returned] }, assistant, returned, result };
}

test('native submit/propose observations use actual log fields and preserve unknown cost', () => {
  for (const tool of ['research_task_submit', 'research_task_propose']) {
    const f = fixture(tool), value = collectNativeExecution(f);
    assert.equal(value.status, 'observed');
    assert.deepEqual(value.observation.requestedModel, f.binding.requestedModel);
    assert.deepEqual(value.observation.observedModel, { provider: 'anthropic', id: 'claude-test-v1' });
    assert.equal(value.observation.usage.outputTokens, 80);
    assert.equal(value.observation.usage.granularity, 'message');
    assert.equal(value.observation.cost.status, 'unknown'); assert.equal(value.observation.cost.amountUsd, null);
    assert.equal(value.observation.correlation.nativeRunSha256, null);
    assert.equal(value.observation.outcome, 'tool-succeeded');
    assert(!JSON.stringify(value.observation).includes('Synthetic only'));
    assert(!JSON.stringify(value.observation).includes('toolu-native-1'));
    assert(!JSON.stringify(value.observation).includes('native-request'));
  }
});

test('repeated message blocks and duplicated identical JSONL rows do not multiply usage', () => {
  const f = fixture(), original = collectNativeExecution(f);
  const thinking = clone(f.assistant); thinking.uuid = 'thinking-row'; thinking.message.content = [{ type: 'thinking', thinking: 'private hidden content' }];
  f.source.records.unshift(thinking); f.source.records.push(clone(f.assistant));
  const value = collectNativeExecution(f);
  assert.equal(value.status, 'observed'); assert.deepEqual(value.observation.usage, original.observation.usage);
  assert.equal(value.observation.usage.inputTokens, 2);
});

test('two proposals emitted in one native message share an accounting key', () => {
  const a = fixture(), b = fixture(); b.binding.proposalId = 'proposal-2'; b.assistant.message.content[0].input.idempotencyKey = 'proposal-2';
  b.result.id = 'proposal-2'; b.binding.resultSha256 = hash(b.result);
  b.binding.requestSha256 = hash(b.assistant.message.content[0].input);
  b.assistant.message.content[0].id = 'toolu-native-2'; b.returned.message.content[0].tool_use_id = 'toolu-native-2';
  b.returned.message.content[0].content[0].text = JSON.stringify({ ok: true, result: b.result, automaticTradingAuthorized: false });
  const av = collectNativeExecution(a), bv = collectNativeExecution(b);
  assert.equal(av.status, 'observed'); assert.equal(bv.status, 'observed');
  assert.equal(av.observation.usage.accountingKey, bv.observation.usage.accountingKey);
  assert.notEqual(av.observation.correlation.toolCallSha256, bv.observation.correlation.toolCallSha256);
});

test('missing usage stays unknown, never zero', () => {
  const f = fixture(); delete f.assistant.message.usage;
  const value = collectNativeExecution(f); assert.equal(value.status, 'observed');
  assert.equal(value.observation.usage.granularity, 'unknown'); assert.equal(value.observation.usage.accountingKey, null);
  assert.equal(value.observation.usage.inputTokens, null);
});

test('cost-like native fields cannot silently become a bill or estimate', () => {
  const f = fixture(); f.assistant.total_cost_usd = 1; f.assistant.costUSD = 2; f.assistant.message.usage.cost = 3;
  const value = collectNativeExecution(f); assert.equal(value.status, 'observed'); assert.equal(value.observation.cost.amountUsd, null);
});

test('full canonical request and result hashes are required', () => {
  for (const change of [f => { f.assistant.message.content[0].input.analysis.data.reason = 'changed'; },
    f => { f.result.proposedBy = 'someone-else'; f.returned.message.content[0].content[0].text = JSON.stringify({ ok: true, result: f.result, automaticTradingAuthorized: false }); }]) {
    const f = fixture(); change(f); assert.equal(collectNativeExecution(f).status, 'pending');
  }
});

test('other sessions, sidechains, spoofed tool names and mismatched assistant sources cannot attest', () => {
  for (const change of [f => { f.assistant.sessionId = '33333333-3333-3333-3333-333333333333'; },
    f => { f.assistant.isSidechain = true; }, f => { f.returned.isSidechain = true; },
    f => { f.assistant.message.content[0].name = 'mcp__untrusted__research_task_propose'; },
    f => { f.returned.sourceToolAssistantUUID = 'other-assistant'; },
    f => { f.returned.message.content[0].tool_use_id = 'other-tool'; }]) {
    const f = fixture(); change(f); assert.equal(collectNativeExecution(f).status, 'pending');
  }
});

test('JSON in ordinary user text and unsuccessful tool results cannot attest', () => {
  for (const change of [f => { f.returned.message.content[0].type = 'text'; },
    f => { f.returned.message.content[0].is_error = true; }, f => { f.returned.message.role = 'assistant'; },
    f => { f.returned.message.content[0].content[0].text = '{"ok":false}'; }]) {
    const f = fixture(); change(f); assert.equal(collectNativeExecution(f).status, 'pending');
  }
});

test('idempotent later replay is not attributed as original generating model', () => {
  const f = fixture(); f.assistant.timestamp = '2026-09-28T06:47:00.000Z'; f.returned.timestamp = '2026-09-28T06:47:01.000Z';
  assert.equal(collectNativeExecution(f).status, 'pending');
});

test('inverted time and a createdAt mismatch cannot attest', () => {
  const f = fixture(); f.returned.timestamp = '2026-09-28T06:46:18.000Z'; assert.equal(collectNativeExecution(f).status, 'pending');
  const other = fixture(); other.binding.createdAt = '2026-09-28T06:46:18.156Z'; assert.equal(collectNativeExecution(other).status, 'pending');
});

test('ambiguous matching executions require review', () => {
  const f = fixture(), other = clone(f.source.records); other[0].uuid = 'second-assistant'; other[0].message.content[0].id = 'second-tool';
  other[1].uuid = 'second-result'; other[1].sourceToolAssistantUUID = 'second-assistant'; other[1].message.content[0].tool_use_id = 'second-tool';
  f.source.records.push(...other); assert.deepEqual(collectNativeExecution(f).reasonCodes, ['NATIVE_MATCH_AMBIGUOUS']);
});

test('conflicting repeated message usage/model/request identifiers fail closed', () => {
  for (const change of [r => { r.message.usage.input_tokens = 999; }, r => { r.message.model = 'claude-other'; }, r => { r.requestId = 'other-request'; }]) {
    const f = fixture(), extra = clone(f.assistant); extra.uuid = 'extra-message-row'; extra.message.content = [{ type: 'text', text: 'not retained' }]; change(extra);
    f.source.records.push(extra); assert.equal(collectNativeExecution(f).status, 'rejected');
  }
});

test('invalid token values and changed UUID records fail closed', () => {
  for (const value of [-1, 1.5, NaN, 1_000_000_000_001, '12']) {
    const f = fixture(); f.assistant.message.usage.input_tokens = value; assert.equal(collectNativeExecution(f).status, 'rejected');
  }
  const f = fixture(), extra = clone(f.assistant); extra.message.model = 'claude-other'; f.source.records.push(extra);
  assert.deepEqual(collectNativeExecution(f).reasonCodes, ['NATIVE_RECORD_CONFLICT']);
});

test('source UUID mismatch and invalid bindings fail without leaking content', () => {
  const f = fixture(); f.binding.nativeSessionId = '33333333-3333-3333-3333-333333333333'; assert.equal(collectNativeExecution(f).status, 'rejected');
  assert.equal(collectNativeExecution().status, 'rejected');
  const cycle = fixture(); cycle.assistant.message.content[0].input.cycle = cycle.assistant;
  assert.deepEqual(collectNativeExecution(cycle).reasonCodes, ['NATIVE_RECORD_INVALID']);
});
