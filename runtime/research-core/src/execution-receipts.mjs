import { createHash } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_VERSIONS = 1000;
const VERIFICATION = 'host-observed-not-provider-signed';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(canonical(value));
const equal = (left, right) => canonical(left) === canonical(right);

export class ExecutionReceiptError extends Error {
  constructor(code) { super(code); this.name = 'ExecutionReceiptError'; this.code = code; }
}
const fail = code => { throw new ExecutionReceiptError(code); };
const requireValue = value => { if (!value) fail('VALIDATION'); };
function object(value, allowed, required = allowed) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  requireValue(keys.every(key => typeof key === 'string' && allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key)));
  // Inputs may also come from internal JavaScript callers. Reject hidden fields
  // and accessors before reading values, rather than silently dropping them in
  // JSON serialization or invoking a getter containing arbitrary diagnostics.
  requireValue(keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  }));
}
const identifier = value => requireValue(typeof value === 'string' && ID.test(value));
const label = value => requireValue(typeof value === 'string' && LABEL.test(value));
const sha = value => requireValue(typeof value === 'string' && SHA.test(value));
const nullableSha = value => { if (value !== null) sha(value); };
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
function time(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value));
  const parsed = new Date(value), normalized = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  requireValue(Number.isFinite(parsed.valueOf()) && parsed.toISOString() === normalized);
  return parsed.valueOf();
}
function scopeValid(scope) {
  object(scope, ['agentId', 'environment']); identifier(scope.agentId);
  requireValue(['test', 'paper', 'live'].includes(scope.environment));
}
function model(value) {
  if (value === null) return;
  object(value, ['provider', 'id']); label(value.provider); label(value.id);
}
function granularity(value) {
  requireValue(['message', 'run', 'unknown'].includes(value.granularity));
  nullableSha(value.accountingKey);
  // Shared measurement identifiers are mandatory before any measured value is
  // accepted. Consumers group by this key; per-proposal summation is incorrect.
  requireValue(value.granularity === 'unknown' ? value.accountingKey === null : value.accountingKey !== null);
}
function observation(value) {
  object(value, ['source', 'correlation', 'requestedModel', 'observedModel', 'usage', 'cost', 'startedAt', 'endedAt', 'outcome']);
  object(value.source, ['kind', 'adapterId', 'adapterVersion', 'recordSha256']);
  requireValue(['native-runtime-log', 'native-runtime-hook', 'provider-response', 'billing-reconciliation'].includes(value.source.kind));
  label(value.source.adapterId); label(value.source.adapterVersion); sha(value.source.recordSha256);
  object(value.correlation, ['nativeSessionSha256', 'nativeRunSha256', 'messageSha256', 'toolCallSha256', 'requestSha256', 'resultSha256', 'toolName']);
  for (const name of ['nativeSessionSha256', 'toolCallSha256', 'requestSha256', 'resultSha256']) sha(value.correlation[name]);
  nullableSha(value.correlation.nativeRunSha256); nullableSha(value.correlation.messageSha256);
  requireValue(['research_task_submit', 'research_task_propose'].includes(value.correlation.toolName));
  model(value.requestedModel); model(value.observedModel);
  object(value.usage, ['granularity', 'accountingKey', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']);
  granularity(value.usage);
  const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
  for (const field of tokenFields) if (value.usage[field] !== null) integer(value.usage[field], 0, 1_000_000_000_000);
  const hasUsage = tokenFields.some(field => value.usage[field] !== null);
  requireValue(hasUsage ? value.usage.granularity !== 'unknown' : value.usage.granularity === 'unknown');
  object(value.cost, ['status', 'currency', 'amountUsd', 'basis', 'granularity', 'accountingKey']);
  requireValue(value.cost.currency === 'USD'); granularity(value.cost);
  const bases = { unknown: 'unknown', estimate: 'native-runtime-estimate', reported: 'provider-reported', reconciled: 'billing-reconciled' };
  requireValue(Object.hasOwn(bases, value.cost.status) && value.cost.basis === bases[value.cost.status]);
  if (value.cost.status === 'unknown') requireValue(value.cost.amountUsd === null && value.cost.granularity === 'unknown');
  else requireValue(typeof value.cost.amountUsd === 'number' && Number.isFinite(value.cost.amountUsd)
    && value.cost.amountUsd >= 0 && value.cost.amountUsd <= 1_000_000_000 && value.cost.granularity !== 'unknown');
  if (value.cost.status === 'reconciled') requireValue(value.source.kind === 'billing-reconciliation');
  requireValue(['tool-succeeded', 'tool-failed', 'unknown'].includes(value.outcome));
  const startedAt = time(value.startedAt);
  if (value.endedAt !== null) requireValue(time(value.endedAt) >= startedAt);
}
function requestValid(input) {
  object(input, ['idempotencyKey', 'executionId', 'expectedVersion', 'taskId', 'proposalId', 'observation']);
  identifier(input.idempotencyKey); identifier(input.executionId); identifier(input.taskId);
  if (input.proposalId !== null) identifier(input.proposalId);
  integer(input.expectedVersion, 0, MAX_VERSIONS - 1); observation(input.observation);
  requireValue(input.observation.correlation.toolName === 'research_task_propose' ? input.proposalId !== null : input.proposalId === null);
  requireValue(Buffer.byteLength(canonical(input)) <= MAX_RECORD_BYTES);
}
function binding(scope, input) {
  const { nativeSessionSha256, toolCallSha256 } = input.observation.correlation;
  // One native invocation has one target even if a caller changes receipt ID,
  // task, proposal, or tool name. Target metadata is checked separately below.
  return hash([scope, nativeSessionSha256, toolCallSha256]);
}
function page(input, keys) {
  object(input, [...keys, 'limit', 'offset'], keys.filter(key => key !== 'proposalId'));
  const limit = input.limit ?? 20, offset = input.offset ?? 0;
  integer(limit, 1, 100); integer(offset, 0);
  return { limit, offset };
}

/** Internal host capability. No model-facing write operation or provider-signature claim. */
export function createExecutionReceipts(options) {
  object(options, ['directory', 'agentId', 'environment', 'authorizeWrite', 'resolveTarget'], ['directory', 'agentId', 'environment']);
  const scope = Object.freeze({ agentId: options.agentId, environment: options.environment }); scopeValid(scope);
  const authorizeWrite = options.authorizeWrite ?? (() => null), resolveTarget = options.resolveTarget ?? (() => null);
  requireValue(typeof authorizeWrite === 'function' && typeof resolveTarget === 'function');
  const store = openPrivateStore({ directory: options.directory, ...scope, name: 'execution-receipts', version: 1, initialize(db) {
    db.exec(`
      CREATE TABLE execution_receipt_targets (
        execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, proposal_id TEXT,
        binding_hash TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE execution_receipt_revisions (
        execution_id TEXT NOT NULL REFERENCES execution_receipt_targets(execution_id),
        version INTEGER NOT NULL CHECK(version > 0 AND version <= 1000),
        request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        record_json TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(execution_id, version)
      ) STRICT;
      CREATE INDEX execution_receipt_task_lookup ON execution_receipt_targets(task_id, proposal_id);
    `);
    for (const table of ['execution_receipt_targets', 'execution_receipt_revisions']) db.exec(`
      CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;
    `);
  } });
  const { db } = store;
  function authority(input, context) {
    try {
      if (authorizeWrite.constructor?.name === 'AsyncFunction') fail('UNAUTHORIZED');
      const actor = authorizeWrite({ action: 'append', scope: { ...scope }, request: clone(input) }, context);
      object(actor, ['actorId']); identifier(actor.actorId); return actor.actorId;
    } catch { fail('UNAUTHORIZED'); }
  }
  function target(input) {
    let resolved;
    try {
      if (resolveTarget.constructor?.name === 'AsyncFunction') fail('TARGET_NOT_FOUND');
      resolved = resolveTarget({ taskId: input.taskId, proposalId: input.proposalId });
      object(resolved, ['scope', 'taskId', 'proposalId']); scopeValid(resolved.scope);
      identifier(resolved.taskId); if (resolved.proposalId !== null) identifier(resolved.proposalId);
    } catch { fail('TARGET_NOT_FOUND'); }
    if (!equal(resolved.scope, scope)) fail('SCOPE_MISMATCH');
    if (resolved.taskId !== input.taskId || resolved.proposalId !== input.proposalId) fail('TARGET_MISMATCH');
  }
  function requestFrom(record) {
    return { idempotencyKey: record.idempotencyKey, executionId: record.executionId, expectedVersion: record.version - 1,
      taskId: record.taskId, proposalId: record.proposalId, observation: record.observation };
  }
  function validateContinuity(previous, next) {
    if (!previous) return;
    requireValue(previous.executionId === next.executionId && previous.taskId === next.taskId && previous.proposalId === next.proposalId);
    const before = previous.observation.correlation, after = next.observation.correlation;
    for (const field of ['nativeSessionSha256', 'toolCallSha256', 'toolName', 'requestSha256', 'resultSha256']) requireValue(before[field] === after[field]);
    for (const field of ['nativeRunSha256', 'messageSha256']) if (before[field] !== null) requireValue(before[field] === after[field]);
  }
  function readHistory(executionId) {
    const storedTarget = db.prepare('SELECT * FROM execution_receipt_targets WHERE execution_id=?').get(executionId);
    const rows = db.prepare('SELECT * FROM execution_receipt_revisions WHERE execution_id=? ORDER BY version LIMIT 1001').all(executionId);
    if (!storedTarget && !rows.length) return [];
    try {
      requireValue(storedTarget && rows.length >= 1 && rows.length <= MAX_VERSIONS);
      let previous = null;
      return rows.map((row, index) => {
        const value = JSON.parse(row.record_json);
        object(value, ['schemaVersion', 'executionId', 'version', 'scope', 'taskId', 'proposalId', 'observation',
          'recordedAt', 'recordedBy', 'verification', 'previousDigest', 'idempotencyKey']);
        requireValue(value.schemaVersion === 1 && value.verification === VERIFICATION && value.executionId === executionId
          && row.execution_id === executionId && row.version === index + 1 && value.version === row.version
          && value.taskId === storedTarget.task_id && value.proposalId === storedTarget.proposal_id
          && equal(value.scope, scope) && canonical(value) === row.record_json && hash(value) === row.digest
          && value.idempotencyKey === row.request_key && value.previousDigest === (previous?.digest ?? null));
        identifier(value.recordedBy); scopeValid(value.scope);
        const request = requestFrom(value); requestValid(request);
        requireValue(hash(request) === row.request_hash && binding(scope, request) === storedTarget.binding_hash);
        requireValue(time(value.recordedAt) >= time(value.observation.endedAt ?? value.observation.startedAt)
          && (!previous || time(value.recordedAt) >= time(previous.recordedAt)));
        validateContinuity(previous, value);
        previous = { ...value, digest: row.digest }; return previous;
      });
    } catch { fail('CORRUPT_STORE'); }
  }
  function append(input, context) {
    requestValid(input); input = clone(input);
    const actorId = authority(input, context); target(input);
    return store.transaction(true, () => {
      const old = db.prepare('SELECT execution_id, version, request_hash FROM execution_receipt_revisions WHERE request_key=?').get(input.idempotencyKey);
      if (old) {
        if (old.request_hash !== hash(input)) fail('IDEMPOTENCY_CONFLICT');
        return clone(readHistory(old.execution_id)[old.version - 1]);
      }
      const history = readHistory(input.executionId), previous = history.at(-1) ?? null;
      if (input.expectedVersion !== history.length) fail('VERSION_CONFLICT');
      const bindingHash = binding(scope, input);
      const bound = db.prepare('SELECT execution_id FROM execution_receipt_targets WHERE binding_hash=?').get(bindingHash);
      if (bound && bound.execution_id !== input.executionId) fail('BINDING_CONFLICT');
      if (previous) {
        try { validateContinuity(previous, { ...input }); } catch { fail('BINDING_CONFLICT'); }
      }
      const recordedAt = new Date().toISOString();
      if (time(recordedAt) < time(input.observation.endedAt ?? input.observation.startedAt)
        || (previous && time(recordedAt) < time(previous.recordedAt))) fail('CLOCK');
      const record = { schemaVersion: 1, executionId: input.executionId, version: history.length + 1, scope: { ...scope },
        taskId: input.taskId, proposalId: input.proposalId, observation: input.observation,
        recordedAt, recordedBy: actorId, verification: VERIFICATION, previousDigest: previous?.digest ?? null, idempotencyKey: input.idempotencyKey };
      const digest = hash(record), encoded = canonical(record);
      requireValue(Buffer.byteLength(encoded) <= MAX_RECORD_BYTES);
      if (!previous) db.prepare('INSERT INTO execution_receipt_targets VALUES(?,?,?,?)').run(input.executionId, input.taskId, input.proposalId, bindingHash);
      db.prepare('INSERT INTO execution_receipt_revisions VALUES(?,?,?,?,?,?)').run(input.executionId, record.version, input.idempotencyKey, hash(input), encoded, digest);
      return clone({ ...record, digest });
    });
  }
  function get(input) {
    object(input, ['executionId', 'version'], ['executionId']); identifier(input.executionId);
    if (input.version !== undefined) integer(input.version, 1, MAX_VERSIONS);
    return store.transaction(false, () => {
      const history = readHistory(input.executionId);
      return clone((input.version === undefined ? history.at(-1) : history[input.version - 1]) ?? null);
    });
  }
  function list(input) {
    const { limit, offset } = page(input, ['taskId', 'proposalId']); identifier(input.taskId);
    if (input.proposalId !== undefined && input.proposalId !== null) identifier(input.proposalId);
    const hasProposal = input.proposalId !== undefined;
    const filter = hasProposal ? 'task_id=? AND proposal_id IS ?' : 'task_id=?';
    const parameters = hasProposal ? [input.taskId, input.proposalId] : [input.taskId];
    return store.transaction(false, () => ({ scope: { ...scope }, total: db.prepare(`SELECT COUNT(*) AS n FROM execution_receipt_targets WHERE ${filter}`).get(...parameters).n,
      limit, offset, receipts: db.prepare(`SELECT execution_id FROM execution_receipt_targets WHERE ${filter} ORDER BY rowid LIMIT ? OFFSET ?`).all(...parameters, limit, offset)
        .map(row => clone(readHistory(row.execution_id).at(-1))) }));
  }
  function history(input) {
    const { limit, offset } = page(input, ['executionId']); identifier(input.executionId);
    return store.transaction(false, () => {
      const receipts = readHistory(input.executionId);
      return { scope: { ...scope }, total: receipts.length, limit, offset, receipts: clone(receipts.slice(offset, offset + limit)) };
    });
  }
  return Object.freeze({ scope, append, get, list, history, close: () => store.close() });
}
