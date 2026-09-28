import { createHash } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FIELDS = ['toolName', 'taskId', 'proposalId', 'actorId', 'createdAt', 'sessionKey', 'sessionId',
  'nativeSessionId', 'requestSha256', 'resultSha256', 'requestedModel'];
const UNAVAILABLE = ['NATIVE_SOURCE_UNAVAILABLE', 'NATIVE_BINDING_AMBIGUOUS', 'NATIVE_RECORD_INVALID', 'NATIVE_COLLECTION_FAILED'];
const MAX_BYTES = 16 * 1024;

export class ExecutionBindingError extends Error {
  constructor(code) { super(code); this.name = 'ExecutionBindingError'; this.code = code; }
}
const fail = code => { throw new ExecutionBindingError(code); };
const requireValue = condition => { if (!condition) fail('VALIDATION'); };
const canonical = value => value !== null && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function object(value, keys, required = keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const names = Reflect.ownKeys(value);
  requireValue(names.every(key => typeof key === 'string' && keys.includes(key))
    && required.every(key => Object.hasOwn(value, key)));
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor.enumerable === true && Object.hasOwn(descriptor, 'value'));
  }
}
function text(value, maximum) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= maximum);
}
function time(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
function scoped(value, scope) {
  object(value, ['agentId', 'environment']);
  requireValue(value.agentId === scope.agentId && value.environment === scope.environment);
}
function binding(value) {
  object(value, FIELDS);
  requireValue(['research_task_submit', 'research_task_propose'].includes(value.toolName));
  requireValue(typeof value.taskId === 'string' && /^wt-[a-f0-9]{64}$/.test(value.taskId));
  requireValue(value.toolName === 'research_task_submit' ? value.proposalId === null
    : typeof value.proposalId === 'string' && /^wp-[a-f0-9]{64}$/.test(value.proposalId));
  requireValue(typeof value.actorId === 'string' && ID.test(value.actorId));
  time(value.createdAt); text(value.sessionKey, 2048); text(value.sessionId, 256);
  requireValue(value.nativeSessionId === null || typeof value.nativeSessionId === 'string' && UUID.test(value.nativeSessionId));
  for (const key of ['requestSha256', 'resultSha256']) requireValue(typeof value[key] === 'string' && SHA256.test(value[key]));
  if (value.requestedModel !== null) {
    object(value.requestedModel, ['provider', 'id']);
    text(value.requestedModel.provider, 256); text(value.requestedModel.id, 256);
  }
  requireValue(Buffer.byteLength(canonical(value), 'utf8') <= MAX_BYTES);
}
function statusFields(value) {
  requireValue(['pending', 'observed', 'unavailable'].includes(value.status));
  requireValue(value.status === 'observed' ? value.reasonCode === null
    : value.status === 'pending' ? value.reasonCode === 'PENDING_NATIVE_RESULT' : UNAVAILABLE.includes(value.reasonCode));
  time(value.observedAt);
}
function bindingId(scope, input) {
  return `eb-${hash({ scope, toolName: input.toolName, taskId: input.taskId, proposalId: input.proposalId })}`;
}
function validateId(value) { requireValue(typeof value === 'string' && /^eb-[a-f0-9]{64}$/.test(value)); }

/**
 * Private append-only correlation ledger for trusted host JavaScript capabilities.
 * The host selects the authorized scope and captures successful native tool calls;
 * this module does not authenticate callers or constitute an OS security boundary.
 * Returned session identifiers are private host data and MUST NOT enter model-tool
 * responses. A requested model and an observed status do not attest a model receipt.
 */
export function createExecutionBindings(options) {
  object(options, ['directory', 'agentId', 'environment']);
  requireValue(typeof options.agentId === 'string' && ID.test(options.agentId)
    && ['test', 'paper', 'live'].includes(options.environment));
  const scope = Object.freeze({ agentId: options.agentId, environment: options.environment });
  const store = openPrivateStore({ directory: options.directory, ...scope, name: 'execution-bindings', initialize(db) {
    db.exec(`
      CREATE TABLE execution_bindings (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE INDEX execution_bindings_task ON execution_bindings(task_id, id);
      CREATE TABLE execution_binding_native_sessions (binding_id TEXT PRIMARY KEY REFERENCES execution_bindings(id), record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE execution_binding_status_events (binding_id TEXT NOT NULL REFERENCES execution_bindings(id), sequence INTEGER NOT NULL CHECK(sequence > 0), record_json TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(binding_id, sequence)) STRICT;
    `);
    for (const table of ['execution_bindings', 'execution_binding_native_sessions', 'execution_binding_status_events']) {
      db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;`);
    }
  } });
  const { db } = store;
  function parse(row, validate) {
    try {
      const value = JSON.parse(row.record_json);
      requireValue(Buffer.byteLength(row.record_json, 'utf8') <= MAX_BYTES
        && canonical(value) === row.record_json && hash(value) === row.digest);
      validate(value);
      return value;
    } catch { fail('CORRUPT_STORE'); }
  }
  function read(id) {
    const row = db.prepare('SELECT * FROM execution_bindings WHERE id = ?').get(id);
    if (!row) return null;
    const original = parse(row, value => {
      object(value, ['id', 'scope', ...FIELDS]);
      const { id: recordId, scope: recordScope, ...input } = value;
      binding(input); scoped(recordScope, scope);
      requireValue(recordId === id && bindingId(scope, input) === id && row.task_id === input.taskId);
    });
    let nativeSessionId = original.nativeSessionId;
    const nativeRow = db.prepare('SELECT * FROM execution_binding_native_sessions WHERE binding_id = ?').get(id);
    if (nativeRow) {
      const native = parse(nativeRow, value => {
        object(value, ['bindingId', 'scope', 'nativeSessionId']);
        scoped(value.scope, scope);
        requireValue(value.bindingId === id && original.nativeSessionId === null
          && typeof value.nativeSessionId === 'string' && UUID.test(value.nativeSessionId));
      });
      nativeSessionId = native.nativeSessionId;
    }
    let latest = { status: 'pending', reasonCode: 'PENDING_NATIVE_RESULT', observedAt: null };
    let sequence = 0, digest = row.digest;
    for (const eventRow of db.prepare('SELECT * FROM execution_binding_status_events WHERE binding_id = ? ORDER BY sequence').all(id)) {
      const event = parse(eventRow, value => {
        object(value, ['bindingId', 'scope', 'sequence', 'status', 'reasonCode', 'observedAt', 'previousDigest']);
        scoped(value.scope, scope); statusFields(value);
        requireValue(value.bindingId === id && value.sequence === sequence + 1 && value.sequence === eventRow.sequence
          && value.previousDigest === digest && value.observedAt >= (latest.observedAt ?? original.createdAt)
          && latest.status !== 'observed');
      });
      latest = { status: event.status, reasonCode: event.reasonCode, observedAt: event.observedAt };
      sequence = event.sequence; digest = eventRow.digest;
    }
    return { original, sequence, digest, value: { ...original, nativeSessionId, ...latest } };
  }
  function get(input) {
    object(input, ['id']); validateId(input.id);
    return store.transaction(false, () => copy(read(input.id)?.value ?? null));
  }
  function find(input) {
    object(input, ['toolName', 'taskId', 'proposalId']);
    requireValue(['research_task_submit', 'research_task_propose'].includes(input.toolName)
      && typeof input.taskId === 'string' && /^wt-[a-f0-9]{64}$/.test(input.taskId)
      && (input.toolName === 'research_task_submit' ? input.proposalId === null
        : typeof input.proposalId === 'string' && /^wp-[a-f0-9]{64}$/.test(input.proposalId)));
    return get({ id: bindingId(scope, input) });
  }
  function capture(input) {
    binding(input);
    const original = { id: bindingId(scope, input), scope, ...copy(input) };
    return store.transaction(true, () => {
      const previous = read(original.id);
      if (previous) {
        if (canonical(previous.original) !== canonical(original)) fail('BINDING_CONFLICT');
        return copy(previous.value);
      }
      const encoded = canonical(original);
      requireValue(Buffer.byteLength(encoded, 'utf8') <= MAX_BYTES);
      db.prepare('INSERT INTO execution_bindings VALUES(?, ?, ?, ?)').run(original.id, original.taskId, encoded, hash(original));
      return copy(read(original.id).value);
    });
  }
  function bindNativeSession(input) {
    object(input, ['id', 'nativeSessionId']); validateId(input.id);
    requireValue(typeof input.nativeSessionId === 'string' && UUID.test(input.nativeSessionId));
    return store.transaction(true, () => {
      const current = read(input.id);
      if (!current) fail('NOT_FOUND');
      if (current.value.nativeSessionId !== null) {
        if (current.value.nativeSessionId !== input.nativeSessionId) fail('NATIVE_SESSION_CONFLICT');
        return copy(current.value);
      }
      const record = { bindingId: input.id, scope, nativeSessionId: input.nativeSessionId };
      db.prepare('INSERT INTO execution_binding_native_sessions VALUES(?, ?, ?)').run(input.id, canonical(record), hash(record));
      return copy(read(input.id).value);
    });
  }
  function updateStatus(input) {
    object(input, ['id', 'status', 'reasonCode', 'observedAt']); validateId(input.id); statusFields(input);
    return store.transaction(true, () => {
      const current = read(input.id);
      if (!current) fail('NOT_FOUND');
      if (['status', 'reasonCode', 'observedAt'].every(key => current.value[key] === input[key])) return copy(current.value);
      // Polling unchanged native state must not append a heartbeat every 30 seconds.
      if (current.value.observedAt !== null && current.value.status === input.status && current.value.reasonCode === input.reasonCode) return copy(current.value);
      if (current.value.status === 'observed') fail('STATUS_TERMINAL');
      if (input.observedAt < (current.value.observedAt ?? current.value.createdAt)) fail('CLOCK');
      const record = { bindingId: input.id, scope, sequence: current.sequence + 1,
        status: input.status, reasonCode: input.reasonCode, observedAt: input.observedAt, previousDigest: current.digest };
      db.prepare('INSERT INTO execution_binding_status_events VALUES(?, ?, ?, ?)').run(input.id, record.sequence, canonical(record), hash(record));
      return copy(read(input.id).value);
    });
  }
  function list(input = {}) {
    object(input, ['limit', 'offset', 'pendingOnly', 'taskId'], []);
    const { limit = 20, offset = 0, pendingOnly = true, taskId } = input;
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
      && Number.isSafeInteger(offset) && offset >= 0 && typeof pendingOnly === 'boolean');
    if (Object.hasOwn(input, 'taskId')) requireValue(typeof taskId === 'string' && /^wt-[a-f0-9]{64}$/.test(taskId));
    for (const key of ['limit', 'offset', 'pendingOnly']) if (Object.hasOwn(input, key)) requireValue(input[key] !== undefined);
    return store.transaction(false, () => {
      // Status selects work, never authority. Validate the full private record and
      // event chain for each returned row, without loading every historical task.
      const where = [taskId === undefined ? '1=1' : 'b.task_id=?'];
      const args = taskId === undefined ? [] : [taskId];
      if (pendingOnly) where.push(`COALESCE((SELECT json_extract(e.record_json, '$.status')
        FROM execution_binding_status_events e WHERE e.binding_id=b.id ORDER BY e.sequence DESC LIMIT 1), 'pending') <> 'observed'`);
      const filter = where.join(' AND ');
      const total = db.prepare(`SELECT COUNT(*) AS n FROM execution_bindings b WHERE ${filter}`).get(...args).n;
      const rows = db.prepare(`SELECT b.id FROM execution_bindings b WHERE ${filter} ORDER BY b.rowid LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return { bindings: copy(rows.map(row => read(row.id).value)), total, limit, offset };
    });
  }
  return Object.freeze({ scope, capture, get, find, list, updateStatus, bindNativeSession, close: () => store.close() });
}
