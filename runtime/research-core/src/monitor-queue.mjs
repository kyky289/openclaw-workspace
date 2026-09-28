import { createHash, randomUUID } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';

const STATUSES = ['pending', 'leased', 'completed', 'retry', 'dead-letter'];
const FAILURE_REASONS = ['PROCESSING_FAILED', 'PROVIDER_UNAVAILABLE', 'INVALID_RESULT', 'RATE_LIMITED'];
const STORED_REASONS = [...FAILURE_REASONS, 'LEASE_EXPIRED'];
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 8 * 1024;
const MAX_LEASE_MS = 60 * 60 * 1000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export class MonitorQueueError extends Error {
  constructor(code, message) { super(message); this.name = 'MonitorQueueError'; this.code = code; }
}
function fail(code, message) { throw new MonitorQueueError(code, message); }
function requireValue(condition, message) { if (!condition) fail('VALIDATION', message); }
function object(value, keys, required = keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Expected a plain object');
  requireValue(Object.keys(value).every((key) => keys.includes(key)), 'Unknown field');
  requireValue(required.every((key) => Object.hasOwn(value, key)), 'Missing required field');
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Invalid ${label}`);
}
function text(value, label, maximum) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
    && Buffer.byteLength(value) <= maximum, `Invalid ${label}`);
}
function identifier(value, label) { requireValue(typeof value === 'string' && ID.test(value), `Invalid ${label}`); }
function jsonObject(value, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `Invalid ${label}`);
  let nodes = 0;
  const walk = (entry, depth) => {
    requireValue(++nodes <= 1000 && depth <= 8, `${label} is too complex`);
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return;
    if (typeof entry === 'number') { requireValue(Number.isFinite(entry), `Invalid ${label} number`); return; }
    requireValue(entry && typeof entry === 'object' && (Array.isArray(entry)
      || [Object.prototype, null].includes(Object.getPrototypeOf(entry))), `${label} must contain JSON values`);
    if (Array.isArray(entry)) {
      requireValue(entry.length <= 1000, `${label} array is too large`);
      requireValue(Array.from({ length: entry.length }, (_, index) => Object.hasOwn(entry, index)).every(Boolean), `${label} arrays must not contain holes`);
    }
    for (const item of Object.values(entry)) walk(item, depth + 1);
  };
  walk(value, 0);
  const encoded = canonical(value);
  requireValue(Buffer.byteLength(encoded) <= MAX_JSON_BYTES, `${label} exceeds byte limit`);
  return encoded;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function contentHash(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function backoff(attempts) { return Math.min(60_000, 1000 * (2 ** (attempts - 1))); }
function task(row, includeToken = false) {
  return {
    id: row.id, sourceKey: row.source_key, contentHash: row.content_hash,
    content: row.content, metadata: JSON.parse(row.metadata_json), status: row.status,
    attempts: row.attempts, maxAttempts: row.max_attempts, createdAt: row.created_at,
    updatedAt: row.updated_at, availableAt: row.available_at, leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at, completedAt: row.completed_at,
    result: row.result_json === null ? null : JSON.parse(row.result_json), lastError: row.last_error,
    ...(includeToken ? { leaseToken: row.lease_token } : {}),
  };
}

/** Durable queue only. The trusted host schedules workers and owns authorization. */
export function createMonitorQueue(options) {
  object(options, ['directory', 'agentId', 'environment', 'clock'], ['directory', 'agentId', 'environment']);
  if (options.clock !== undefined) requireValue(typeof options.clock === 'function', 'clock must be a trusted host function');
  const clock = options.clock ?? Date.now;
  const store = openPrivateStore({
    directory: options.directory, agentId: options.agentId, environment: options.environment,
    name: 'monitor-queue', version: 1,
    initialize(db) {
      db.exec(`
        CREATE TABLE monitor_tasks (
          id TEXT PRIMARY KEY, source_key TEXT NOT NULL, content_hash TEXT NOT NULL,
          content TEXT NOT NULL, metadata_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','leased','completed','retry','dead-letter')),
          attempts INTEGER NOT NULL CHECK(attempts >= 0),
          max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, available_at INTEGER NOT NULL,
          lease_token TEXT, lease_owner TEXT, lease_expires_at INTEGER,
          completion_token TEXT, completed_at INTEGER, result_json TEXT, last_error TEXT,
          UNIQUE(source_key, content_hash), CHECK(attempts <= max_attempts)
        ) STRICT;
        CREATE INDEX monitor_claim ON monitor_tasks(status, available_at, created_at);
        CREATE TABLE monitor_clock (id INTEGER PRIMARY KEY CHECK(id = 1), last_seen INTEGER NOT NULL) STRICT;
        INSERT INTO monitor_clock(id, last_seen) VALUES(1, 0);
        CREATE TRIGGER monitor_no_delete BEFORE DELETE ON monitor_tasks BEGIN SELECT RAISE(ABORT, 'immutable'); END;
        CREATE TRIGGER monitor_content_immutable BEFORE UPDATE OF id, source_key, content_hash, content, metadata_json, max_attempts, created_at ON monitor_tasks
          BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      `);
    },
  });
  const { db, scope } = store;

  function readState() {
    try {
      const clockRows = db.prepare('SELECT * FROM monitor_clock').all();
      requireValue(clockRows.length === 1 && clockRows[0].id === 1, 'Invalid stored clock');
      const lastSeen = clockRows[0].last_seen;
      integer(lastSeen, 'stored clock');
      const rows = db.prepare('SELECT * FROM monitor_tasks ORDER BY created_at, rowid').all();
      for (const row of rows) {
        identifier(row.id, 'stored id'); text(row.source_key, 'source key', 2048);
        text(row.content, 'content', MAX_CONTENT_BYTES);
        requireValue(row.content_hash === contentHash(row.content), 'Invalid content digest');
        requireValue(jsonObject(JSON.parse(row.metadata_json), 'metadata') === row.metadata_json, 'Invalid metadata encoding');
        requireValue(STATUSES.includes(row.status), 'Invalid status');
        integer(row.max_attempts, 'maxAttempts', 1, 10); integer(row.attempts, 'attempts', 0, row.max_attempts);
        for (const key of ['created_at', 'updated_at', 'available_at']) integer(row[key], key);
        requireValue(row.created_at <= row.updated_at && row.updated_at <= lastSeen && row.available_at >= row.created_at, 'Invalid chronology');
        requireValue(row.last_error === null || STORED_REASONS.includes(row.last_error), 'Invalid failure reason');
        if (row.status === 'leased') {
          identifier(row.lease_token, 'lease token'); identifier(row.lease_owner, 'lease owner');
          integer(row.lease_expires_at, 'lease expiry');
          requireValue(row.attempts > 0 && row.lease_expires_at > row.updated_at, 'Invalid lease');
        } else requireValue(row.lease_token === null && row.lease_owner === null && row.lease_expires_at === null, 'Unexpected lease');
        if (row.status === 'completed') {
          identifier(row.completion_token, 'completion token'); integer(row.completed_at, 'completion time');
          requireValue(row.completed_at === row.updated_at && row.attempts > 0, 'Invalid completion');
          requireValue(jsonObject(JSON.parse(row.result_json), 'result') === row.result_json, 'Invalid result encoding');
        } else requireValue(row.completion_token === null && row.completed_at === null && row.result_json === null, 'Unexpected completion');
        if (row.status === 'pending') requireValue(row.attempts === 0 && row.last_error === null, 'Invalid pending task');
        if (row.status === 'retry') requireValue(row.attempts > 0 && row.attempts < row.max_attempts && STORED_REASONS.includes(row.last_error), 'Invalid retry');
        if (row.status === 'dead-letter') requireValue(row.attempts === row.max_attempts && STORED_REASONS.includes(row.last_error), 'Invalid dead letter');
      }
      return { rows, lastSeen };
    } catch { fail('CORRUPT_STORE', 'Monitor queue contains invalid data; no task was changed'); }
  }
  function now(lastSeen) {
    const value = clock();
    integer(value, 'clock', 0, Number.MAX_SAFE_INTEGER - MAX_LEASE_MS);
    if (value < lastSeen) fail('CLOCK', 'System clock moved backwards; no task was changed');
    db.prepare('UPDATE monitor_clock SET last_seen = ? WHERE id = 1').run(value);
    return value;
  }
  function getRow(id) { return db.prepare('SELECT * FROM monitor_tasks WHERE id = ?').get(id); }
  function recoverExpired(rows, time) {
    for (const row of rows) {
      if (row.status !== 'leased' || row.lease_expires_at > time) continue;
      const status = row.attempts >= row.max_attempts ? 'dead-letter' : 'retry';
      const availableAt = row.lease_expires_at + backoff(row.attempts);
      db.prepare(`UPDATE monitor_tasks SET status = ?, updated_at = ?, available_at = ?,
        lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, last_error = 'LEASE_EXPIRED' WHERE id = ?`)
        .run(status, time, availableAt, row.id);
    }
  }
  function requireLease(row, leaseToken, time) {
    if (!row) fail('NOT_FOUND', 'Task was not found in this scope');
    if (row.status !== 'leased' || row.lease_token !== leaseToken) fail('LEASE_CONFLICT', 'Task lease is no longer owned by this worker');
    if (row.lease_expires_at <= time) fail('LEASE_EXPIRED', 'Task lease expired; the result was not acknowledged');
  }

  try { store.transaction(false, readState); } catch (error) { store.close(); throw error; }

  function enqueue(input) {
    object(input, ['sourceKey', 'content', 'metadata', 'maxAttempts'], ['sourceKey', 'content']);
    text(input.sourceKey, 'sourceKey', 2048); text(input.content, 'content', MAX_CONTENT_BYTES);
    const metadata = jsonObject(input.metadata === undefined ? {} : input.metadata, 'metadata');
    const maxAttempts = input.maxAttempts === undefined ? 5 : input.maxAttempts;
    integer(maxAttempts, 'maxAttempts', 1, 10);
    const digest = contentHash(input.content);
    return store.transaction(true, () => {
      const state = readState();
      const duplicate = state.rows.find((row) => row.source_key === input.sourceKey && row.content_hash === digest);
      if (duplicate) return { created: false, task: task(duplicate) };
      const time = now(state.lastSeen);
      const id = randomUUID();
      db.prepare(`INSERT INTO monitor_tasks(id, source_key, content_hash, content, metadata_json, status,
        attempts, max_attempts, created_at, updated_at, available_at) VALUES(?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`)
        .run(id, input.sourceKey, digest, input.content, metadata, maxAttempts, time, time, time);
      return { created: true, task: task(getRow(id)) };
    });
  }
  function claim(input) {
    object(input, ['workerId', 'leaseMs', 'id'], ['workerId']);
    identifier(input.workerId, 'workerId');
    if (input.id !== undefined) identifier(input.id, 'id');
    const leaseMs = input.leaseMs === undefined ? 300_000 : input.leaseMs;
    integer(leaseMs, 'leaseMs', 1000, MAX_LEASE_MS);
    return store.transaction(true, () => {
      const state = readState();
      const time = now(state.lastSeen);
      recoverExpired(state.rows, time);
      const row = input.id === undefined
        ? db.prepare(`SELECT * FROM monitor_tasks WHERE status IN ('pending', 'retry')
          AND available_at <= ? ORDER BY available_at, created_at, rowid LIMIT 1`).get(time)
        : db.prepare(`SELECT * FROM monitor_tasks WHERE id = ? AND status IN ('pending', 'retry')
          AND available_at <= ?`).get(input.id, time);
      if (!row) return null;
      const token = randomUUID();
      db.prepare(`UPDATE monitor_tasks SET status = 'leased', attempts = attempts + 1,
        updated_at = ?, lease_token = ?, lease_owner = ?, lease_expires_at = ? WHERE id = ?`)
        .run(time, token, input.workerId, time + leaseMs, row.id);
      return task(getRow(row.id), true);
    });
  }
  function ack(input) {
    object(input, ['id', 'leaseToken', 'result'], ['id', 'leaseToken']);
    identifier(input.id, 'id'); identifier(input.leaseToken, 'leaseToken');
    const result = jsonObject(input.result === undefined ? {} : input.result, 'result');
    return store.transaction(true, () => {
      const state = readState();
      const row = state.rows.find((candidate) => candidate.id === input.id);
      if (row?.status === 'completed' && row.completion_token === input.leaseToken) {
        if (row.result_json !== result) fail('ACK_CONFLICT', 'Completed task acknowledgement has a different result');
        return task(row);
      }
      const time = now(state.lastSeen);
      requireLease(row, input.leaseToken, time);
      db.prepare(`UPDATE monitor_tasks SET status = 'completed', updated_at = ?, completed_at = ?,
        completion_token = ?, result_json = ?, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`)
        .run(time, time, input.leaseToken, result, input.id);
      return task(getRow(input.id));
    });
  }
  function failTask(input) {
    object(input, ['id', 'leaseToken', 'reason'], ['id', 'leaseToken']);
    identifier(input.id, 'id'); identifier(input.leaseToken, 'leaseToken');
    const reason = input.reason === undefined ? 'PROCESSING_FAILED' : input.reason;
    requireValue(FAILURE_REASONS.includes(reason), 'Use an allowed failure reason code; do not pass raw diagnostics');
    return store.transaction(true, () => {
      const state = readState();
      const row = state.rows.find((candidate) => candidate.id === input.id);
      const time = now(state.lastSeen);
      requireLease(row, input.leaseToken, time);
      const status = row.attempts >= row.max_attempts ? 'dead-letter' : 'retry';
      db.prepare(`UPDATE monitor_tasks SET status = ?, updated_at = ?, available_at = ?, last_error = ?,
        lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`)
        .run(status, time, time + backoff(row.attempts), reason, input.id);
      return task(getRow(input.id));
    });
  }
  function get(input) {
    object(input, ['id']); identifier(input.id, 'id');
    return store.transaction(false, () => {
      const row = readState().rows.find(candidate => candidate.id === input.id);
      return row ? task(row) : null;
    });
  }
  function list(input = {}) {
    object(input, ['status', 'limit', 'offset'], []);
    if (input.status !== undefined) requireValue(STATUSES.includes(input.status), 'Invalid status');
    const limit = input.limit === undefined ? 100 : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    integer(limit, 'limit', 1, 500); integer(offset, 'offset');
    return store.transaction(false, () => {
      const rows = readState().rows.filter((row) => input.status === undefined || row.status === input.status);
      return { scope: { ...scope }, total: rows.length, offset, limit, tasks: rows.slice(offset, offset + limit).map((row) => task(row)) };
    });
  }
  return Object.freeze({ scope, enqueue, claim, ack, fail: failTask, get, list, close: () => store.close() });
}
