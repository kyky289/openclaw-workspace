import { createHash, randomUUID } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 512 * 1024;

export class ResearchError extends Error {
  constructor(code, message) { super(message); this.name = 'ResearchError'; this.code = code; }
}
const fail = (code, message) => { throw new ResearchError(code, message); };
const requireValue = (condition, message) => { if (!condition) fail('VALIDATION', message); };
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (left, right) => canonical(left) === canonical(right);

function object(value, keys, required = keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Expected a plain object');
  requireValue(Object.keys(value).every(key => keys.includes(key)), 'Unknown field');
  requireValue(required.every(key => Object.hasOwn(value, key)), 'Missing required field');
}
function text(value, field, maximum = 4096) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0'), `Invalid ${field}`);
}
function identifier(value, field) { requireValue(typeof value === 'string' && ID.test(value), `Invalid ${field}`); }
function version(value) { requireValue(Number.isSafeInteger(value) && value >= 1, 'Invalid expected version'); }
function time(value, field) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value), `Invalid ${field}; use ISO UTC`);
  const result = new Date(value);
  const normalized = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  requireValue(Number.isFinite(result.valueOf()) && result.toISOString() === normalized, `Invalid ${field}`);
  return result.valueOf();
}
function scopeValid(scope) {
  object(scope, ['agentId', 'environment']);
  identifier(scope.agentId, 'agentId');
  requireValue(['test', 'paper', 'live'].includes(scope.environment), 'Invalid environment');
}
function evidenceFields(value) {
  identifier(value.id, 'evidence id');
  identifier(value.sourceFamily, 'sourceFamily');
  requireValue(['fact', 'inference'].includes(value.kind), 'Invalid evidence kind');
  text(value.source, 'source', 512);
  text(value.locator, 'locator', 2048);
  requireValue(typeof value.contentSha256 === 'string' && SHA256.test(value.contentSha256), 'Invalid contentSha256');
  requireValue(time(value.publishedAt, 'publishedAt') <= time(value.observedAt, 'observedAt'), 'Evidence cannot be observed before publication');
  requireValue(time(value.observedAt, 'observedAt') <= time(value.recordedAt, 'recordedAt'), 'Evidence cannot be observed in the future');
  scopeValid(value.scope);
}
function provenance(value) {
  object(value.thesis, ['id', 'version', 'locator']);
  identifier(value.thesis.id, 'thesis id');
  text(value.thesis.version, 'thesis version', 256);
  text(value.thesis.locator, 'thesis locator', 2048);
  object(value.skill, ['id', 'version']);
  object(value.strategy, ['id', 'version']);
  object(value.model, ['provider', 'id', 'version']);
  for (const name of ['skill', 'strategy', 'model']) for (const entry of Object.values(value[name])) text(entry, `${name} provenance`, 256);
}
function publicationData(kind, data) {
  if (kind === 'prediction') {
    object(data, ['title', 'probability', 'dueAt', 'resolutionCriterion']);
    requireValue(typeof data.probability === 'number' && Number.isFinite(data.probability) && data.probability >= 0 && data.probability <= 1, 'Invalid probability');
    time(data.dueAt, 'dueAt');
    text(data.resolutionCriterion, 'resolutionCriterion', 8192);
  } else if (kind === 'decision') {
    object(data, ['title', 'action', 'reason']);
    requireValue(['hold', 'buy', 'sell', 'research'].includes(data.action), 'Invalid conceptual action');
    text(data.reason, 'reason', 16384);
  } else fail('VALIDATION', 'Only prediction and decision publication is supported');
  text(data.title, 'title', 1024);
}

/** Local research adapter. Verification authority is injected by trusted host code. */
export function createResearch(options) {
  object(options, ['directory', 'agentId', 'environment', 'journal', 'authorizeVerification'], ['directory', 'agentId', 'environment', 'journal']);
  const scope = Object.freeze({ agentId: options.agentId, environment: options.environment });
  scopeValid(scope);
  requireValue(options.authorizeVerification === undefined || typeof options.authorizeVerification === 'function', 'Invalid verification authority');
  const journal = options.journal;
  requireValue(journal && ['statistics', 'append', 'get'].every(method => typeof journal[method] === 'function'), 'A journal handle is required');
  if (!equal(journal.statistics().scope, scope)) fail('SCOPE_MISMATCH', 'Research and journal must use the same trusted scope');
  const store = openPrivateStore({ directory: options.directory, ...scope, name: 'research', version: 1, initialize(db) {
    db.exec(`
      CREATE TABLE research_evidence (id TEXT PRIMARY KEY, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE research_verifications (evidence_id TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(evidence_id, version)) STRICT;
      CREATE TABLE research_tasks (id TEXT PRIMARY KEY, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE research_requests (key TEXT PRIMARY KEY, kind TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE research_publication_receipts (key TEXT PRIMARY KEY, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
    `);
    for (const table of ['research_evidence', 'research_verifications', 'research_tasks', 'research_requests', 'research_publication_receipts']) {
      db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;`);
    }
  } });
  const db = store.db;

  function transaction(write, operation) {
    try { return store.transaction(write, operation); }
    catch (error) {
      if (error instanceof ResearchError) throw error;
      if (error?.name === 'JournalError') throw error;
      if (error?.name === 'StoreError') throw error;
      fail('STORAGE', 'Research storage operation failed; retry the original idempotency key after inspection');
    }
  }
  function parse(row, field = 'record_json', validator) {
    if (!row) return null;
    try {
      const value = JSON.parse(row[field]);
      requireValue(canonical(value) === row[field] && hash(value) === row.digest, 'Invalid stored digest');
      validator?.(value);
      return value;
    } catch { fail('CORRUPT_STORE', 'Invalid research record; no data was changed'); }
  }
  function scoped(value) {
    scopeValid(value.scope);
    requireValue(equal(value.scope, scope), 'Invalid stored scope');
  }
  function readEvidence(id) {
    const row = db.prepare('SELECT * FROM research_evidence WHERE id = ?').get(id);
    if (!row) return null;
    const record = parse(row, 'record_json', value => {
      object(value, ['id', 'scope', 'sourceFamily', 'kind', 'source', 'locator', 'publishedAt', 'observedAt', 'contentSha256', 'recordedAt']);
      requireValue(value.id === id, 'Invalid evidence key');
      evidenceFields(value); scoped(value);
    });
    let latest = { status: 'pending', recordedAt: record.recordedAt, verifiedBy: null, reason: null };
    let currentVersion = 1;
    for (const verificationRow of db.prepare('SELECT * FROM research_verifications WHERE evidence_id = ? ORDER BY version').all(id)) {
      const event = parse(verificationRow, 'record_json', value => {
        object(value, ['evidenceId', 'version', 'scope', 'status', 'recordedAt', 'verifiedBy', 'reason']);
        requireValue(value.evidenceId === id && value.version === currentVersion + 1 && value.version === verificationRow.version, 'Invalid verification history');
        requireValue(['verified', 'rejected'].includes(value.status), 'Invalid verification status');
        requireValue(time(value.recordedAt, 'recordedAt') >= time(latest.recordedAt, 'recordedAt'), 'Invalid verification chronology');
        identifier(value.verifiedBy, 'verifiedBy'); text(value.reason, 'reason', 8192); scoped(value);
      });
      currentVersion = event.version;
      latest = { status: event.status, recordedAt: event.recordedAt, verifiedBy: event.verifiedBy, reason: event.reason };
    }
    return { ...record, version: currentVersion, verification: latest };
  }
  function readTask(id) {
    const row = db.prepare('SELECT * FROM research_tasks WHERE id = ?').get(id);
    if (!row) return null;
    const task = parse(row, 'record_json', value => {
      object(value, ['id', 'scope', 'title', 'frozenAt', 'evidence', 'thesis', 'skill', 'model', 'strategy', 'independentSourceCount']);
      requireValue(value.id === id, 'Invalid task key'); scoped(value); identifier(value.id, 'task id'); text(value.title, 'title', 1024);
      const frozenAt = time(value.frozenAt, 'frozenAt'); provenance(value);
      requireValue(Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.length <= 50, 'Invalid frozen evidence');
      requireValue(new Set(value.evidence.map(item => item.id)).size === value.evidence.length, 'Duplicate frozen evidence');
      for (const snapshot of value.evidence) {
        object(snapshot, ['id', 'scope', 'sourceFamily', 'kind', 'source', 'locator', 'publishedAt', 'observedAt', 'contentSha256', 'recordedAt', 'version', 'verification']);
        evidenceFields(snapshot); scoped(snapshot); version(snapshot.version);
        object(snapshot.verification, ['status', 'recordedAt', 'verifiedBy', 'reason']);
        requireValue(['pending', 'verified', 'rejected'].includes(snapshot.verification.status), 'Invalid frozen verification');
        requireValue(time(snapshot.recordedAt, 'recordedAt') <= frozenAt && time(snapshot.verification.recordedAt, 'verification time') <= frozenAt, 'Invalid freeze chronology');
        if (snapshot.verification.status === 'pending') requireValue(snapshot.version === 1 && snapshot.verification.verifiedBy === null && snapshot.verification.reason === null, 'Invalid pending snapshot');
        else { identifier(snapshot.verification.verifiedBy, 'verifiedBy'); text(snapshot.verification.reason, 'reason', 8192); }
      }
      requireValue(value.independentSourceCount === independentCount(value.evidence), 'Invalid independent source count');
    });
    return { ...task, snapshotSha256: row.digest };
  }
  function independentCount(evidence) {
    return new Set(evidence.filter(item => item.verification.status === 'verified').map(item => item.sourceFamily)).size;
  }
  function requestRow(key, kind, request) {
    const row = db.prepare('SELECT * FROM research_requests WHERE key = ?').get(key);
    if (!row) return null;
    if (row.kind !== kind || row.request_hash !== hash(request)) fail('IDEMPOTENCY_CONFLICT', 'Key was used for another research request');
    return parse(row, 'result_json');
  }
  function saveRequest(key, kind, request, result) {
    const encoded = canonical(result);
    requireValue(Buffer.byteLength(encoded) <= MAX_JSON_BYTES, 'Research result exceeds byte limit');
    db.prepare('INSERT INTO research_requests(key, kind, request_hash, result_json, digest) VALUES(?, ?, ?, ?, ?)').run(key, kind, hash(request), encoded, hash(result));
  }
  function recordEvidence(input) {
    object(input, ['id', 'sourceFamily', 'kind', 'source', 'locator', 'publishedAt', 'observedAt', 'contentSha256', 'idempotencyKey'], ['sourceFamily', 'kind', 'source', 'locator', 'publishedAt', 'observedAt', 'contentSha256', 'idempotencyKey']);
    identifier(input.idempotencyKey, 'idempotencyKey');
    const request = { ...input, id: input.id ?? null };
    const { idempotencyKey, ...fields } = input;
    if (fields.id !== undefined) identifier(fields.id, 'id');
    evidenceFields({ ...fields, id: fields.id ?? 'validation', scope, recordedAt: new Date().toISOString() });
    return transaction(true, () => {
      const prior = requestRow(idempotencyKey, 'evidence', request);
      if (prior) return prior;
      const record = { ...fields, id: fields.id ?? randomUUID(), scope, recordedAt: new Date().toISOString() };
      evidenceFields(record);
      if (db.prepare('SELECT id FROM research_evidence WHERE id = ?').get(record.id)) fail('ID_CONFLICT', 'Evidence ID already exists; original evidence cannot be changed');
      db.prepare('INSERT INTO research_evidence(id, record_json, digest) VALUES(?, ?, ?)').run(record.id, canonical(record), hash(record));
      const result = readEvidence(record.id);
      saveRequest(idempotencyKey, 'evidence', request, result);
      return clone(result);
    });
  }
  function verifyEvidence(input, trustedContext) {
    object(input, ['evidenceId', 'expectedVersion', 'status', 'reason', 'idempotencyKey']);
    identifier(input.evidenceId, 'evidenceId'); identifier(input.idempotencyKey, 'idempotencyKey'); version(input.expectedVersion);
    requireValue(['verified', 'rejected'].includes(input.status), 'Verification status must be verified or rejected'); text(input.reason, 'reason', 8192);
    let authority;
    try { authority = options.authorizeVerification?.(trustedContext); } catch { fail('UNAUTHORIZED', 'Evidence verification was not authorized'); }
    if (!authority || typeof authority !== 'object' || typeof authority.then === 'function'
      || typeof authority.actorId !== 'string' || !ID.test(authority.actorId)) fail('UNAUTHORIZED', 'Evidence verification requires a trusted authorized actor');
    const request = { ...input, verifiedBy: authority.actorId };
    return transaction(true, () => {
      const prior = requestRow(input.idempotencyKey, 'verification', request);
      if (prior) return prior;
      const current = readEvidence(input.evidenceId);
      if (!current) fail('NOT_FOUND', 'Evidence was not found in this scope');
      if (current.version !== input.expectedVersion) fail('VERSION_CONFLICT', 'Evidence version changed');
      const recordedAt = new Date().toISOString();
      if (time(recordedAt, 'recordedAt') < time(current.verification.recordedAt, 'recordedAt')) fail('CLOCK', 'Clock moved backwards');
      const event = { evidenceId: input.evidenceId, version: current.version + 1, scope, status: input.status,
        recordedAt, verifiedBy: authority.actorId, reason: input.reason };
      db.prepare('INSERT INTO research_verifications(evidence_id, version, record_json, digest) VALUES(?, ?, ?, ?)').run(input.evidenceId, event.version, canonical(event), hash(event));
      const result = readEvidence(input.evidenceId);
      saveRequest(input.idempotencyKey, 'verification', request, result);
      return clone(result);
    });
  }
  function freezeTask(input) {
    object(input, ['id', 'title', 'evidenceIds', 'thesis', 'skill', 'model', 'strategy', 'idempotencyKey'], ['title', 'evidenceIds', 'thesis', 'skill', 'model', 'strategy', 'idempotencyKey']);
    identifier(input.idempotencyKey, 'idempotencyKey'); text(input.title, 'title', 1024); provenance(input);
    if (input.id !== undefined) identifier(input.id, 'id');
    requireValue(Array.isArray(input.evidenceIds) && input.evidenceIds.length >= 1 && input.evidenceIds.length <= 50, 'Select between 1 and 50 evidence records');
    input.evidenceIds.forEach(id => identifier(id, 'evidenceId'));
    requireValue(new Set(input.evidenceIds).size === input.evidenceIds.length, 'Duplicate evidence IDs');
    const request = { ...input, id: input.id ?? null };
    return transaction(true, () => {
      const prior = requestRow(input.idempotencyKey, 'freeze', request);
      if (prior) return prior;
      const evidence = input.evidenceIds.map(id => {
        const record = readEvidence(id);
        if (!record) fail('NOT_FOUND', 'Evidence was not found in this scope');
        return record;
      });
      const frozenAt = new Date().toISOString();
      if (evidence.some(item => time(item.verification.recordedAt, 'recordedAt') > time(frozenAt, 'frozenAt'))) fail('CLOCK', 'Clock moved backwards');
      const task = { id: input.id ?? randomUUID(), scope, title: input.title, frozenAt, evidence,
        thesis: clone(input.thesis), skill: clone(input.skill), model: clone(input.model), strategy: clone(input.strategy), independentSourceCount: independentCount(evidence) };
      const encoded = canonical(task);
      requireValue(Buffer.byteLength(encoded) <= MAX_JSON_BYTES, 'Task snapshot exceeds byte limit');
      if (db.prepare('SELECT id FROM research_tasks WHERE id = ?').get(task.id)) fail('ID_CONFLICT', 'Task ID already exists; create a new task to change a snapshot');
      db.prepare('INSERT INTO research_tasks(id, record_json, digest) VALUES(?, ?, ?)').run(task.id, encoded, hash(task));
      const result = readTask(task.id);
      saveRequest(input.idempotencyKey, 'freeze', request, result);
      return clone(result);
    });
  }
  function verifiedTask(task) {
    if (task.evidence.some(item => item.verification.status !== 'verified')) fail('UNVERIFIED_EVIDENCE', 'Candidate evidence must be verified before journal publication; freeze a new task after verification');
    for (const snapshot of task.evidence) {
      const current = readEvidence(snapshot.id);
      if (!current || current.version !== snapshot.version || current.verification.status !== 'verified') fail('STALE_EVIDENCE', 'Evidence verification changed after the snapshot; freeze a new task');
    }
  }
  function reservationValid(reservation) {
    object(reservation, ['status', 'scope', 'taskId', 'taskSnapshotSha256', 'reservedAt', 'journalRequest']);
    requireValue(reservation.status === 'reserved', 'Invalid reservation status'); scoped(reservation);
    identifier(reservation.taskId, 'taskId'); requireValue(SHA256.test(reservation.taskSnapshotSha256), 'Invalid task snapshot digest');
    time(reservation.reservedAt, 'reservedAt');
    const req = reservation.journalRequest;
    object(req, ['id', 'kind', 'data', 'expectedVersion', 'idempotencyKey']);
    identifier(req.id, 'journal id'); identifier(req.idempotencyKey, 'journal idempotency key');
    requireValue(['prediction', 'decision'].includes(req.kind) && req.expectedVersion === 0, 'Invalid journal operation');
  }
  function verifyJournalRecord(record, reservation) {
    if (!record || record.id !== reservation.journalRequest.id || record.version !== 1 || record.kind !== reservation.journalRequest.kind
      || !equal(record.scope, scope) || !equal(record.data, reservation.journalRequest.data)) fail('JOURNAL_CONFLICT', 'Journal record does not match this publication');
    requireValue(time(record.createdAt, 'journal createdAt') >= time(reservation.reservedAt, 'reservedAt'), 'Journal record predates publication reservation');
  }
  function receiptFor(key, reservation) {
    return parse(db.prepare('SELECT * FROM research_publication_receipts WHERE key = ?').get(key), 'record_json', value => {
      object(value, ['status', 'scope', 'taskId', 'taskSnapshotSha256', 'recordedAt', 'journalRecord']);
      requireValue(value.status === 'committed' && value.taskId === reservation.taskId && value.taskSnapshotSha256 === reservation.taskSnapshotSha256, 'Invalid publication receipt');
      scoped(value); verifyJournalRecord(value.journalRecord, reservation);
      requireValue(time(value.recordedAt, 'receipt recordedAt') >= time(value.journalRecord.createdAt, 'journal createdAt'), 'Invalid receipt chronology');
    });
  }
  function publish(input) {
    object(input, ['taskId', 'kind', 'data', 'idempotencyKey']);
    identifier(input.taskId, 'taskId'); identifier(input.idempotencyKey, 'idempotencyKey'); publicationData(input.kind, input.data);
    const reservation = transaction(true, () => {
      const previous = requestRow(input.idempotencyKey, 'publish', input);
      if (previous) { try { reservationValid(previous); } catch { fail('CORRUPT_STORE', 'Invalid publication reservation'); } return previous; }
      const task = readTask(input.taskId);
      if (!task) fail('NOT_FOUND', 'Research task was not found in this scope');
      verifiedTask(task);
      const reservedAt = new Date().toISOString();
      if (time(reservedAt, 'reservedAt') < time(task.frozenAt, 'frozenAt')) fail('CLOCK', 'Clock moved backwards');
      if (input.kind === 'prediction') requireValue(time(input.data.dueAt, 'dueAt') > time(reservedAt, 'reservedAt'), 'Prediction deadline must be in the future');
      const suffix = hash({ scope, key: input.idempotencyKey }).slice(0, 48);
      const evidence = task.evidence.map(item => ({ source: item.source,
        locator: `research://${scope.agentId}/${scope.environment}/tasks/${task.id}/evidence/${item.id}#sha256=${task.snapshotSha256}`,
        observedAt: item.observedAt }));
      const result = { status: 'reserved', scope, taskId: task.id, taskSnapshotSha256: task.snapshotSha256, reservedAt,
        journalRequest: { id: `research-${suffix}`, kind: input.kind,
          data: { ...clone(input.data), evidence, model: clone(task.model), strategy: clone(task.strategy) },
          expectedVersion: 0, idempotencyKey: `research-publish-${suffix}` } };
      saveRequest(input.idempotencyKey, 'publish', input, result);
      return clone(result);
    });
    // Reservation is durably committed before touching the independent journal.
    // Holding the research write transaction prevents concurrent verification
    // changes between eligibility checking and the journal commit.
    return transaction(true, () => {
      const task = readTask(reservation.taskId);
      if (!task || task.snapshotSha256 !== reservation.taskSnapshotSha256) fail('CORRUPT_STORE', 'Publication task snapshot changed');
      const receipt = receiptFor(input.idempotencyKey, reservation);
      let record = journal.get(reservation.journalRequest.id, { version: 1 });
      if (receipt) {
        if (!record || !equal(record, receipt.journalRecord)) fail('JOURNAL_CONFLICT', 'Committed journal record is missing or changed');
        return clone(receipt);
      }
      if (!record) {
        verifiedTask(task);
        record = journal.append(clone(reservation.journalRequest));
      }
      // A previous journal commit can survive a research transaction rollback.
      // Reconcile it rather than writing a second prediction/decision.
      verifyJournalRecord(record, reservation);
      const recordedAt = new Date().toISOString();
      if (time(recordedAt, 'recordedAt') < time(record.createdAt, 'journal createdAt')) fail('CLOCK', 'Clock moved backwards');
      const result = { status: 'committed', scope, taskId: task.id, taskSnapshotSha256: task.snapshotSha256, recordedAt, journalRecord: clone(record) };
      db.prepare('INSERT INTO research_publication_receipts(key, record_json, digest) VALUES(?, ?, ?)').run(input.idempotencyKey, canonical(result), hash(result));
      return clone(result);
    });
  }
  function getEvidence(id) { identifier(id, 'id'); return transaction(false, () => clone(readEvidence(id))); }
  function getTask(id) { identifier(id, 'id'); return transaction(false, () => clone(readTask(id))); }
  function getPublication(key) {
    identifier(key, 'idempotencyKey');
    return transaction(false, () => {
      const row = db.prepare('SELECT * FROM research_requests WHERE key = ?').get(key);
      if (!row || row.kind !== 'publish') return null;
      const reservation = parse(row, 'result_json', reservationValid);
      const receipt = receiptFor(key, reservation);
      return clone(receipt ?? reservation);
    });
  }
  return Object.freeze({ scope, recordEvidence, verifyEvidence, freezeTask, publish, getEvidence, getTask, getPublication, close: () => store.close() });
}
