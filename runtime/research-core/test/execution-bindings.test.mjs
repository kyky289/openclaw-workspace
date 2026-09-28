import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createExecutionBindings } from '../src/execution-bindings.mjs';

const at = '2026-09-28T07:00:00.000Z';
const later = '2026-09-28T07:00:01.000Z';
const final = '2026-09-28T07:00:02.000Z';
const uuid = '11111111-2222-4333-a444-555555555555';
const anotherUuid = '11111111-2222-4333-a444-666666666666';
const digest = n => n.toString(16).padStart(64, '0');
const fixture = (patch = {}) => ({ toolName: 'research_task_submit', taskId: `wt-${digest(1)}`,
  proposalId: null, actorId: `tg-${digest(2)}`, createdAt: at, sessionKey: 'agent:main:main', sessionId: 'trusted-session-id',
  nativeSessionId: null, requestSha256: digest(3), resultSha256: digest(4),
  requestedModel: { provider: 'claude-cli', id: 'requested-model' }, ...patch });
function setup(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'execution-bindings-'));
  const options = { directory, agentId: 'main', environment: 'test' };
  const handles = [];
  const open = (patch = {}) => { const handle = createExecutionBindings({ ...options, ...patch }); handles.push(handle); return handle; };
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, options, open, file: path.join(directory, 'main', 'test', 'execution-bindings.sqlite') };
}
const rejects = (operation, code = 'VALIDATION') => assert.throws(operation, error => error.code === code && error.message === code);

test('successful binding capture is durable, strictly idempotent, private and immutable', t => {
  const { open, file } = setup(t);
  let store = open();
  const input = fixture(), original = store.capture(input);
  assert.match(original.id, /^eb-[a-f0-9]{64}$/);
  assert.deepEqual(original.scope, { agentId: 'main', environment: 'test' });
  assert.equal(original.status, 'pending'); assert.equal(original.reasonCode, 'PENDING_NATIVE_RESULT');
  assert.equal(original.observedAt, null);
  assert.deepEqual(store.capture(fixture()), original);
  for (const patch of [{ actorId: 'another-actor' }, { sessionId: 'another-session' }, { sessionKey: 'another-key' },
    { resultSha256: digest(5) }, { requestSha256: digest(6) }, { nativeSessionId: uuid },
    { requestedModel: null }, { createdAt: later }]) rejects(() => store.capture(fixture(patch)), 'BINDING_CONFLICT');
  input.requestedModel.id = 'mutated-input'; original.requestedModel.id = 'mutated-return';
  assert.equal(store.get({ id: original.id }).requestedModel.id, 'requested-model');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  store.close(); rejects(() => store.get({ id: original.id }), 'STORE_CLOSED');
  store = open(); assert.equal(store.get({ id: original.id }).requestSha256, digest(3));
  const raw = new DatabaseSync(file);
  try {
    assert.throws(() => raw.prepare('UPDATE execution_bindings SET task_id = ?').run('replacement'), /immutable/);
    assert.throws(() => raw.exec('DELETE FROM execution_bindings'), /immutable/);
  } finally { raw.close(); }
});

test('native session pin survives resets, rejects rebinds and preserves original capture replay', t => {
  const { open } = setup(t); let store = open();
  const binding = store.capture(fixture());
  const pinned = store.bindNativeSession({ id: binding.id, nativeSessionId: uuid });
  assert.equal(pinned.nativeSessionId, uuid);
  assert.deepEqual(store.bindNativeSession({ id: binding.id, nativeSessionId: uuid }), pinned);
  assert.equal(store.capture(fixture()).nativeSessionId, uuid);
  rejects(() => store.bindNativeSession({ id: binding.id, nativeSessionId: anotherUuid }), 'NATIVE_SESSION_CONFLICT');
  rejects(() => store.capture(fixture({ nativeSessionId: uuid })), 'BINDING_CONFLICT');
  store.close(); store = open(); assert.equal(store.get({ id: binding.id }).nativeSessionId, uuid);
  const initiallyPinned = store.capture(fixture({ taskId: `wt-${digest(7)}`, nativeSessionId: anotherUuid }));
  assert.equal(store.bindNativeSession({ id: initiallyPinned.id, nativeSessionId: anotherUuid }).nativeSessionId, anotherUuid);
  rejects(() => store.bindNativeSession({ id: initiallyPinned.id, nativeSessionId: uuid }), 'NATIVE_SESSION_CONFLICT');
  rejects(() => store.bindNativeSession({ id: `eb-${digest(9)}`, nativeSessionId: uuid }), 'NOT_FOUND');
});

test('status history supports retries and terminal observed state without rewriting bindings', t => {
  const { open, file } = setup(t); const store = open(); const binding = store.capture(fixture());
  const missing = { id: binding.id, status: 'unavailable', reasonCode: 'NATIVE_SOURCE_UNAVAILABLE', observedAt: at };
  assert.equal(store.updateStatus(missing).status, 'unavailable');
  assert.deepEqual(store.updateStatus(missing), store.get({ id: binding.id }));
  assert.equal(store.list().bindings[0].status, 'unavailable');
  assert.equal(store.updateStatus({ ...missing, status: 'pending', reasonCode: 'PENDING_NATIVE_RESULT', observedAt: later }).status, 'pending');
  rejects(() => store.updateStatus(missing), 'CLOCK');
  const success = { id: binding.id, status: 'observed', reasonCode: null, observedAt: final };
  const observed = store.updateStatus(success);
  assert.equal(observed.status, 'observed');
  assert.deepEqual(store.updateStatus(success), observed);
  rejects(() => store.updateStatus({ ...missing, observedAt: final }), 'STATUS_TERMINAL');
  assert.equal(store.list().total, 0); assert.equal(store.list({ pendingOnly: false }).total, 1);
  assert.equal(store.capture(fixture()).status, 'observed');
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM execution_binding_status_events').get().n, 3);
    assert.throws(() => raw.exec('DELETE FROM execution_binding_status_events'), /immutable/);
    const original = JSON.parse(raw.prepare('SELECT record_json FROM execution_bindings').get().record_json);
    assert.equal(original.nativeSessionId, null); assert.equal(Object.hasOwn(original, 'status'), false);
  } finally { raw.close(); }
});

test('scope, task filters and bounded pagination keep independent queues distinct', t => {
  const { open } = setup(t); const store = open(); const group = open({ agentId: `tg-group-${digest(5)}` });
  const original = store.capture(fixture()), other = group.capture(fixture());
  assert.notEqual(original.id, other.id); assert.equal(group.get({ id: original.id }), null);
  const proposal = store.capture(fixture({ toolName: 'research_task_propose', proposalId: `wp-${digest(8)}` }));
  const extra = store.capture(fixture({ taskId: `wt-${digest(10)}` }));
  const first = store.list({ limit: 1 });
  assert.equal(first.total, 3); assert.equal(first.limit, 1); assert.equal(first.offset, 0);
  assert.deepEqual(first.bindings.map(x => x.id), [original.id]);
  assert.deepEqual(store.list({ limit: 1, offset: 1 }).bindings.map(x => x.id), [proposal.id]);
  assert.deepEqual(store.list({ limit: 1, offset: 2 }).bindings.map(x => x.id), [extra.id]);
  assert.equal(store.list({ offset: 99 }).bindings.length, 0);
  assert.equal(store.list({ taskId: original.taskId }).total, 2);
  assert.equal(store.list({ taskId: `wt-${digest(99)}` }).total, 0);
});

test('copied database scope signature is rejected before data can be read', t => {
  const { open, directory, file } = setup(t); const a = open(); a.capture(fixture()); a.close();
  const b = open({ agentId: 'second' }); b.close();
  const destination = path.join(directory, 'second', 'test', 'execution-bindings.sqlite');
  copyFileSync(file, destination); chmodSync(destination, 0o600);
  rejects(() => open({ agentId: 'second' }), 'STORE_SCOPE_MISMATCH');
});

test('strict inputs reject unsafe types, symbols, accessors, hidden fields and oversized bytes', t => {
  const { open } = setup(t); const store = open();
  let accessorRan = false;
  const accessor = fixture(); Object.defineProperty(accessor, 'sessionId', { enumerable: true, get() { accessorRan = true; return 'x'; } });
  const hidden = fixture(); Object.defineProperty(hidden, 'extra', { value: 'secret', enumerable: false });
  for (const input of [null, [], new Date(), { ...fixture(), [Symbol('invisible')]: 'x' }, hidden, accessor,
    fixture({ sessionId: undefined }), fixture({ sessionId: 'a\0b' }), fixture({ sessionKey: '中'.repeat(1000) }),
    fixture({ nativeSessionId: '../native' }), fixture({ nativeSessionId: NaN }), fixture({ actorId: Symbol('actor') }),
    fixture({ taskId: 'wt-invalid' }), fixture({ proposalId: `wp-${digest(1)}` }), fixture({ toolName: 'research_task_get' }),
    fixture({ toolName: 'research_task_propose' }), fixture({ createdAt: '2026-02-30T07:00:00.000Z' }),
    fixture({ requestSha256: digest(1).toUpperCase().replace(/0/, 'G') }), fixture({ resultSha256: Infinity }),
    fixture({ requestedModel: { provider: 'provider', id: 'id', cost: 0 } }),
    fixture({ requestedModel: { provider: 'provider', id: '中'.repeat(100) } }),
    fixture({ requestedModel: { provider: 'provider', id: Symbol('id') } })]) rejects(() => store.capture(input));
  assert.equal(accessorRan, false); assert.equal(store.list().total, 0);
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: NaN }, { limit: undefined }, { offset: -1 },
    { offset: Infinity }, { pendingOnly: 'true' }, { pendingOnly: undefined }, { taskId: undefined }, { extra: 1 }]) rejects(() => store.list(input));
  const binding = store.capture(fixture());
  for (const patch of [{ reasonCode: '/private/path with raw error' }, { status: 'observed', reasonCode: 'PENDING_NATIVE_RESULT' },
    { status: 'pending', reasonCode: null }, { observedAt: null }, { status: 'unavailable', reasonCode: 'PENDING_NATIVE_RESULT' }]) {
    rejects(() => store.updateStatus({ id: binding.id, status: 'pending', reasonCode: 'PENDING_NATIVE_RESULT', observedAt: later, ...patch }));
  }
  rejects(() => store.updateStatus({ id: binding.id, status: 'pending', reasonCode: 'PENDING_NATIVE_RESULT', observedAt: '2026-09-27T00:00:00.000Z' }), 'CLOCK');
  assert.equal(store.get({ id: binding.id }).observedAt, null);
});

test('digest damage and history damage fail closed with fixed errors', t => {
  const { open, file } = setup(t); const store = open(); const binding = store.capture(fixture());
  store.updateStatus({ id: binding.id, status: 'unavailable', reasonCode: 'NATIVE_COLLECTION_FAILED', observedAt: later });
  const raw = new DatabaseSync(file);
  try {
    raw.exec('DROP TRIGGER execution_binding_status_events_no_update');
    raw.prepare('UPDATE execution_binding_status_events SET digest = ?').run(digest(99));
  } finally { raw.close(); }
  rejects(() => store.get({ id: binding.id }), 'CORRUPT_STORE');
  rejects(() => store.list(), 'CORRUPT_STORE');
  rejects(() => store.capture(fixture()), 'CORRUPT_STORE');
});
