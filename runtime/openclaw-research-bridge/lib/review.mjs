import { createHash } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
export class ReviewError extends Error {
  constructor(code) { super(`Review service: ${code}`); this.name = 'ReviewError'; this.code = code; }
}
const fail = (code) => { throw new ReviewError(code); };
const equal = (a, b) => canonical(a) === canonical(b);
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) fail('VALIDATION');
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('VALIDATION'); }
function text(value, max) { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('VALIDATION'); }
function time(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) fail('VALIDATION');
  const canonicalTime = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== canonicalTime) fail('VALIDATION');
  return Date.parse(value);
}
function target(value) {
  object(value, ['id', 'version']); id(value.id);
  if (!Number.isSafeInteger(value.version) || value.version < 1) fail('VALIDATION');
}

/** Host-only publication of reviewed outcomes; no model authority or strategy mutation. */
export function createReviewService(options) {
  object(options, ['directory', 'agentId', 'environment', 'research', 'journal', 'authorizeReview'],
    ['directory', 'agentId', 'environment', 'research', 'journal']);
  const { directory, agentId, environment, research, journal } = options;
  id(agentId); if (!['test', 'paper', 'live'].includes(environment)) fail('VALIDATION');
  const scope = Object.freeze({ agentId, environment });
  const authorizeReview = options.authorizeReview ?? (() => null);
  if (typeof authorizeReview !== 'function' || authorizeReview.constructor?.name === 'AsyncFunction'
    || !research || !['getTask', 'getEvidence'].every((method) => typeof research[method] === 'function')
    || !journal || !['get', 'append', 'resolvePrediction', 'list'].every((method) => typeof journal[method] === 'function')) fail('VALIDATION');
  if (!equal(research.scope, scope) || !equal(journal.scope, scope)) fail('SCOPE_MISMATCH');

  // Separate connection takes the research writer lock during the cross-database
  // commit, so another process cannot revoke evidence after the final check.
  // The existing research schema is neither initialized nor changed here.
  const researchGuard = openPrivateStore({ directory, ...scope, name: 'research', version: 1,
    initialize() { fail('RESEARCH_STORE_REQUIRED'); } });
  let store;
  try {
    store = openPrivateStore({ directory, ...scope, name: 'review', version: 1, initialize(db) {
      db.exec(`
        CREATE TABLE review_reservations (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
        CREATE TABLE review_receipts (key TEXT PRIMARY KEY, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      `);
      for (const table of ['review_reservations', 'review_receipts']) db.exec(`
        CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;
      `);
    } });
  } catch (error) { researchGuard.close(); throw error; }
  const db = store.db;
  let closed = false;

  function transaction(write, operation) {
    if (closed) fail('CLOSED');
    try { return store.transaction(write, operation); }
    catch (error) {
      if (error instanceof ReviewError) throw error;
      if (['JournalError', 'ResearchError', 'StoreError'].includes(error?.name)) throw error;
      fail('STORAGE_FAILURE');
    }
  }
  function authority(operation, input, trustedContext, record = null, phase = 'preflight') {
    let authorized;
    try { authorized = authorizeReview({ operation, phase, scope, request: clone(input), targetRecord: clone(record) }, trustedContext); }
    catch { fail('UNAUTHORIZED'); }
    if (authorized && typeof authorized.then === 'function') {
      Promise.resolve(authorized).catch(() => {}); fail('UNAUTHORIZED');
    }
    if (!authorized || typeof authorized !== 'object' || typeof authorized.actorId !== 'string' || !ID.test(authorized.actorId)
      || authorized[{ review: 'canReview', resolve: 'canResolve', read: 'canRead' }[operation]] !== true) fail('UNAUTHORIZED');
    return { actorId: authorized.actorId, earlyResolutionConfirmed: authorized.earlyResolutionConfirmed === true };
  }
  function readRecord(row) {
    if (!row) return null;
    try {
      const value = JSON.parse(row.record_json);
      if (canonical(value) !== row.record_json || hash(value) !== row.digest || !equal(value.scope, scope)) fail('CORRUPT_STORE');
      return value;
    } catch { fail('CORRUPT_STORE'); }
  }
  function getTarget(reference, operation) {
    const record = journal.get(reference.id, { version: reference.version });
    if (!record) fail('TARGET_NOT_FOUND');
    if (!equal(record.scope, scope)) fail('SCOPE_MISMATCH');
    if (record.id !== reference.id || record.version !== reference.version
      || !(operation === 'resolve' ? ['prediction'] : ['prediction', 'decision']).includes(record.kind)) fail('TARGET_INVALID');
    return record;
  }
  function taskSnapshot(taskId, expectedHash = null) {
    const task = research.getTask(taskId);
    if (!task) fail('TASK_NOT_FOUND');
    if (!equal(task.scope, scope)) fail('SCOPE_MISMATCH');
    if (typeof task.snapshotSha256 !== 'string' || !SHA.test(task.snapshotSha256)
      || (expectedHash && task.snapshotSha256 !== expectedHash)) fail('TASK_CHANGED');
    const local = researchGuard.db.prepare('SELECT digest FROM research_tasks WHERE id=?').get(taskId);
    if (!local || local.digest !== task.snapshotSha256) fail('RESEARCH_STORE_MISMATCH');
    return task;
  }
  function eligibleTask(task) {
    if (!Array.isArray(task.evidence) || !task.evidence.length) fail('UNVERIFIED_EVIDENCE');
    for (const snapshot of task.evidence) {
      if (!equal(snapshot.scope, scope)) fail('SCOPE_MISMATCH');
      if (snapshot.verification.status !== 'verified') fail('UNVERIFIED_EVIDENCE');
      const current = research.getEvidence(snapshot.id);
      if (!current || !equal(current.scope, scope)) fail('SCOPE_MISMATCH');
      if (current.version !== snapshot.version || current.verification.status !== 'verified') fail('STALE_EVIDENCE');
      const local = researchGuard.db.prepare('SELECT version,record_json,digest FROM research_verifications WHERE evidence_id=? ORDER BY version DESC LIMIT 1').get(snapshot.id);
      if (!local || local.version !== current.version) fail('RESEARCH_STORE_MISMATCH');
      const verified = JSON.parse(local.record_json);
      if (hash(verified) !== local.digest || verified.status !== 'verified' || verified.version !== current.version) fail('RESEARCH_STORE_MISMATCH');
    }
  }
  function expectedData(reservation) {
    const request = reservation.journalRequest;
    return reservation.operation === 'review' ? request.data : {
      target: { id: request.id, version: request.expectedVersion }, outcome: request.outcome,
      resolvedAt: request.resolvedAt, reason: request.reason, evidence: request.evidence,
    };
  }
  function verifyCommit(record, reservation) {
    if (!record || !equal(record.scope, scope) || record.version !== 1
      || record.kind !== (reservation.operation === 'review' ? 'review' : 'resolution')
      || (reservation.operation === 'review' && record.id !== reservation.journalRequest.id)
      || !equal(record.data, expectedData(reservation))) fail('JOURNAL_CONFLICT');
    if (time(record.createdAt) < time(reservation.reservedAt)) fail('JOURNAL_CONFLICT');
  }
  function findCommit(reservation) {
    if (reservation.operation === 'review') return journal.get(reservation.journalRequest.id, { version: 1 });
    // Journal chooses resolution IDs. The target is unique, and operation-marked
    // frozen-evidence locators distinguish this reservation from another resolver.
    for (let offset = 0; ; offset += 1000) {
      const page = journal.list({ kind: 'resolution', limit: 1000, offset });
      if (!equal(page.scope, scope)) fail('SCOPE_MISMATCH');
      const record = page.records.find((item) => item.data.target.id === reservation.target.id);
      if (record) return record;
      if (offset + page.records.length >= page.total) return null;
      if (!page.records.length) fail('JOURNAL_CONFLICT');
    }
  }
  function checkFirstCommit(operation, input, authorization, targetRecord, task) {
    eligibleTask(task);
    if (operation === 'resolve') {
      const current = journal.get(input.target.id);
      if (!current || current.version !== input.target.version) fail('VERSION_CONFLICT');
      if (time(input.resolvedAt) < time(targetRecord.createdAt) || time(input.resolvedAt) > Date.now()) fail('RESOLUTION_TIME_INVALID');
      if (time(input.resolvedAt) < time(targetRecord.data.dueAt) && !authorization.earlyResolutionConfirmed) fail('EARLY_RESOLUTION_NOT_CONFIRMED');
    }
  }

  function commit(operation, input, trustedContext) {
    const fields = operation === 'review' ? ['target', 'evidenceTaskId', 'title', 'result', 'lessons', 'idempotencyKey']
      : ['target', 'criterionResult', 'resolvedAt', 'reason', 'evidenceTaskId', 'idempotencyKey'];
    object(input, fields); target(input.target); id(input.evidenceTaskId); id(input.idempotencyKey);
    if (operation === 'review') {
      text(input.title, 1024); text(input.result, 16384);
      if (!Array.isArray(input.lessons) || input.lessons.length > 50) fail('VALIDATION');
      input.lessons.forEach((lesson) => text(lesson, 4096));
    } else {
      if (input.criterionResult !== 0 && input.criterionResult !== 1) fail('VALIDATION');
      time(input.resolvedAt); text(input.reason, 8192);
    }
    // Check identity and action permission before a target lookup can reveal
    // existence, kind or version; then authorize the actual record separately.
    const preflight = authority(operation, input, trustedContext);
    const targetRecord = getTarget(input.target, operation);
    const authorized = authority(operation, input, trustedContext, targetRecord, 'target');
    if (authorized.actorId !== preflight.actorId) fail('UNAUTHORIZED');
    const requestHash = hash({ operation, input, actorId: authorized.actorId });
    const reservation = transaction(true, () => {
      const old = db.prepare('SELECT * FROM review_reservations WHERE key=?').get(input.idempotencyKey);
      if (old) {
        if (old.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        return readRecord(old);
      }
      return researchGuard.transaction(true, () => {
        const task = taskSnapshot(input.evidenceTaskId);
        checkFirstCommit(operation, input, authorized, targetRecord, task);
        const reservedAt = new Date().toISOString();
        if (time(task.frozenAt) > time(reservedAt)) fail('CLOCK');
        const suffix = hash({ scope, key: input.idempotencyKey }).slice(0, 48);
        const evidence = task.evidence.map((item) => ({ source: item.source, observedAt: item.observedAt,
          locator: `research://${agentId}/${environment}/tasks/${task.id}/evidence/${item.id}#sha256=${task.snapshotSha256}&review=${suffix}` }));
        const journalRequest = operation === 'review' ? {
          id: `review-${suffix}`, kind: 'review', expectedVersion: 0, idempotencyKey: `review-append-${suffix}`,
          data: { title: input.title, target: clone(input.target), result: input.result, lessons: clone(input.lessons),
            evidence, model: clone(task.model), strategy: clone(task.strategy) },
        } : { id: input.target.id, expectedVersion: input.target.version, outcome: input.criterionResult,
          resolvedAt: input.resolvedAt, reason: input.reason, evidence, idempotencyKey: `review-resolve-${suffix}` };
        const value = { status: 'reserved', scope, operation, actorId: authorized.actorId, reservedAt,
          earlyResolutionConfirmed: operation === 'resolve' && authorized.earlyResolutionConfirmed,
          target: clone(input.target), targetSha256: hash(targetRecord), evidenceTaskId: task.id,
          taskSnapshotSha256: task.snapshotSha256, model: clone(task.model), strategy: clone(task.strategy), journalRequest };
        if (Buffer.byteLength(canonical(expectedData(value))) > 64 * 1024) fail('PAYLOAD_TOO_LARGE');
        db.prepare('INSERT INTO review_reservations(key,request_hash,record_json,digest) VALUES(?,?,?,?)')
          .run(input.idempotencyKey, requestHash, canonical(value), hash(value));
        return clone(value);
      });
    });
    return transaction(true, () => researchGuard.transaction(true, () => {
      const task = taskSnapshot(reservation.evidenceTaskId, reservation.taskSnapshotSha256);
      const targetNow = getTarget(reservation.target, operation);
      if (hash(targetNow) !== reservation.targetSha256) fail('TARGET_CHANGED');
      const saved = readRecord(db.prepare('SELECT * FROM review_receipts WHERE key=?').get(input.idempotencyKey));
      let record = findCommit(reservation);
      if (saved) {
        verifyCommit(record, reservation);
        if (!equal(record, saved.journalRecord)) fail('JOURNAL_CONFLICT');
        return clone(saved);
      }
      // Check an already committed journal record before requiring still-current
      // evidence. Withdrawal cannot retroactively erase a valid earlier commit.
      if (!record) {
        checkFirstCommit(operation, input, authorized, targetNow, task);
        record = operation === 'review' ? journal.append(clone(reservation.journalRequest))
          : journal.resolvePrediction(clone(reservation.journalRequest));
      }
      verifyCommit(record, reservation);
      const recordedAt = new Date().toISOString();
      if (time(recordedAt) < time(record.createdAt)) fail('CLOCK');
      const receipt = { status: 'committed', scope, operation, actorId: reservation.actorId,
        earlyResolutionConfirmed: reservation.earlyResolutionConfirmed, target: clone(reservation.target),
        evidenceTaskId: task.id, taskSnapshotSha256: task.snapshotSha256, recordedAt,
        model: clone(reservation.model), strategy: clone(reservation.strategy), journalRecord: clone(record),
        strategyPromotionAuthorized: false, executionAuthorized: false };
      db.prepare('INSERT INTO review_receipts(key,record_json,digest) VALUES(?,?,?)')
        .run(input.idempotencyKey, canonical(receipt), hash(receipt));
      return clone(receipt);
    }));
  }

  return Object.freeze({ scope,
    review: (input, trustedContext) => commit('review', input, trustedContext),
    resolve: (input, trustedContext) => commit('resolve', input, trustedContext),
    getReceipt(input, trustedContext) {
      object(input, ['idempotencyKey']); id(input.idempotencyKey);
      authority('read', input, trustedContext);
      return transaction(false, () => clone(readRecord(db.prepare('SELECT * FROM review_receipts WHERE key=?').get(input.idempotencyKey))
        ?? readRecord(db.prepare('SELECT * FROM review_reservations WHERE key=?').get(input.idempotencyKey))));
    },
    close() { if (!closed) { store.close(); researchGuard.close(); closed = true; } },
  });
}
