import { createHash, randomUUID } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const ACCOUNT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,71}$/;
const MODEL = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9._-]{1,99}$/;
const OPERATIONS = ['reserve', 'start', 'settle', 'unknown', 'cancel'];
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class BudgetError extends Error {
  constructor(code) { super(`Budget ledger: ${code}`); this.name = 'BudgetError'; this.code = code; }
}
function fail(code) { throw new BudgetError(code); }
function requireValue(condition) { if (!condition) fail('VALIDATION'); }
function object(value, keys, required = keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).every((key) => keys.includes(key))
    && required.every((key) => Object.hasOwn(value, key)));
}
function id(value) { requireValue(typeof value === 'string' && ID.test(value)); }
function units(value) { requireValue(Number.isSafeInteger(value) && value >= 0); }
function timestamp(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function reportUnits(value) { return value <= MAX_SAFE ? Number(value) : value.toString(); }

/** Trusted host chooses account scope; this ledger never reads credentials or sends requests. */
export function createBudgetLedger(options) {
  object(options, ['directory', 'accountId', 'environment', 'unit', 'limitUnits'], ['directory', 'accountId', 'limitUnits']);
  requireValue(typeof options.accountId === 'string' && ACCOUNT_ID.test(options.accountId));
  units(options.limitUnits);
  const limitUnits = options.limitUnits;
  const environment = options.environment === undefined ? 'test' : options.environment;
  const unit = options.unit === undefined ? 'usd-micro' : options.unit;
  requireValue(['test', 'paper', 'live'].includes(environment));
  requireValue(typeof unit === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(unit));
  const scope = Object.freeze({ accountId: options.accountId, environment, unit });
  const config = { ...scope, limitUnits };
  const limit = BigInt(limitUnits);
  const storage = openPrivateStore({
    directory: options.directory, agentId: `billing-${options.accountId}`, environment,
    name: 'budget', version: 1,
    initialize(db) {
      db.exec(`
        CREATE TABLE budget_config (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL) STRICT;
        CREATE TABLE budget_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          operation TEXT NOT NULL CHECK(operation IN ('reserve','start','settle','unknown','cancel')),
          reservation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_json TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          previous_hash TEXT NOT NULL,
          record_hash TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER budget_events_no_update BEFORE UPDATE ON budget_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
        CREATE TRIGGER budget_events_no_delete BEFORE DELETE ON budget_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
        CREATE TRIGGER budget_config_no_update BEFORE UPDATE ON budget_config BEGIN SELECT RAISE(ABORT, 'immutable'); END;
        CREATE TRIGGER budget_config_no_delete BEFORE DELETE ON budget_config BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      `);
      db.prepare('INSERT INTO budget_config(id, value) VALUES(1, ?)').run(canonical(config));
    },
  });
  const { db } = storage;
  let closed = false;

  function transact(write, fn) {
    if (closed) fail('CLOSED');
    try { return storage.transaction(write, fn); }
    catch (error) {
      if (error instanceof BudgetError) throw error;
      if (error?.code === 'BUSY' || /locked|busy/i.test(String(error?.message))) fail('BUSY');
      if (error?.code === 'UNSAFE_STORAGE') fail('UNSAFE_STORAGE');
      fail('STORAGE');
    }
  }

  function summarize(state) {
    let spent = 0n; let held = 0n;
    const counts = { reserved: 0, started: 0, unknown: 0, settled: 0, cancelled: 0 };
    for (const record of state.reservations.values()) {
      counts[record.state]++;
      if (record.state === 'settled') spent += BigInt(record.actualUnits);
      else if (['reserved', 'started', 'unknown'].includes(record.state)) held += BigInt(record.amountUnits);
    }
    const total = spent + held;
    const reasons = [];
    if (counts.unknown > 0) reasons.push('unknown-cost');
    if (state.overrun) reasons.push('reservation-overrun');
    if (total > limit) reasons.push('account-limit-exceeded');
    if (total > MAX_SAFE) reasons.push('accounting-overflow');
    return { scope, limitUnits, spentUnits: reportUnits(spent), heldUnits: reportUnits(held),
      accountedUnits: reportUnits(total), availableUnits: Number(total < limit ? limit - total : 0n),
      frozen: reasons.length > 0, freezeReasons: reasons, counts,
      requiresReconciliation: counts.started > 0 || counts.unknown > 0,
      reservationCount: state.reservations.size, eventCount: state.rows.length,
      providerHardCap: false };
  }

  function validateRequest(operation, request) {
    if (operation === 'reserve') {
      object(request, ['agentId', 'taskId', 'amountUnits', 'modelRef']);
      id(request.agentId); id(request.taskId); units(request.amountUnits);
      requireValue(request.modelRef === null || (typeof request.modelRef === 'string' && MODEL.test(request.modelRef)));
    } else {
      object(request, ['reservationId', ...(operation === 'settle' ? ['actualUnits'] : operation === 'cancel' ? ['confirmedNotSent'] : [])]);
      id(request.reservationId);
      if (operation === 'settle') units(request.actualUnits);
      if (operation === 'cancel') requireValue(request.confirmedNotSent === true);
    }
  }

  function apply(state, operation, request, reservationId, at) {
    validateRequest(operation, request);
    id(reservationId); timestamp(at);
    if (state.lastCreatedAt && at < state.lastCreatedAt) fail('CLOCK');
    if (operation === 'reserve') {
      if (state.reservations.has(reservationId)) fail('RESERVATION_EXISTS');
      const budget = summarize(state);
      if (budget.frozen) fail('ACCOUNT_FROZEN');
      if (request.amountUnits > budget.availableUnits) fail('BUDGET_EXCEEDED');
      return { id: reservationId, ...scope, ...request, state: 'reserved', actualUnits: null,
        reservedAt: at, startedAt: null, updatedAt: at };
    }
    requireValue(reservationId === request.reservationId);
    const previous = state.reservations.get(reservationId);
    if (!previous) fail('NOT_FOUND');
    if (operation === 'start') {
      if (previous.state !== 'reserved') fail('INVALID_TRANSITION');
      if (summarize(state).frozen) fail('ACCOUNT_FROZEN');
      return { ...previous, state: 'started', startedAt: at, updatedAt: at };
    }
    if (operation === 'cancel') {
      if (previous.state !== 'reserved') fail('CANNOT_CANCEL_STARTED');
      return { ...previous, state: 'cancelled', updatedAt: at };
    }
    if (operation === 'unknown') {
      if (previous.state !== 'started') fail('INVALID_TRANSITION');
      return { ...previous, state: 'unknown', updatedAt: at };
    }
    if (!['started', 'unknown'].includes(previous.state)) fail('INVALID_TRANSITION');
    return { ...previous, state: 'settled', actualUnits: request.actualUnits, updatedAt: at };
  }

  function readState() {
    const settings = db.prepare('SELECT id, value FROM budget_config').all();
    if (settings.length !== 1 || settings[0].id !== 1 || settings[0].value !== canonical(config)) fail('CONFIG_MISMATCH');
    const rows = db.prepare('SELECT * FROM budget_events ORDER BY sequence').all();
    const state = { rows: [], reservations: new Map(), overrun: false, previousHash: '', lastCreatedAt: null };
    for (const row of rows) {
      try {
        requireValue(row.sequence === state.rows.length + 1 && OPERATIONS.includes(row.operation));
        id(row.idempotency_key);
        const request = JSON.parse(row.request_json);
        requireValue(canonical(request) === row.request_json && hash({ operation: row.operation, request }) === row.request_hash);
        const snapshot = apply(state, row.operation, request, row.reservation_id, row.created_at);
        requireValue(canonical(snapshot) === row.snapshot_json && row.previous_hash === state.previousHash);
        const digest = hash({ sequence: row.sequence, operation: row.operation, reservationId: row.reservation_id,
          idempotencyKey: row.idempotency_key, requestHash: row.request_hash, snapshot, previousHash: state.previousHash });
        requireValue(digest === row.record_hash);
        if (snapshot.state === 'settled' && snapshot.actualUnits > snapshot.amountUnits) state.overrun = true;
        state.reservations.set(snapshot.id, snapshot);
        state.previousHash = digest; state.lastCreatedAt = row.created_at; state.rows.push(row);
      } catch { fail('CORRUPT_STORE'); }
    }
    return state;
  }

  function mutate(operation, input) {
    const fields = operation === 'reserve' ? ['agentId', 'taskId', 'amountUnits', 'modelRef', 'idempotencyKey']
      : ['reservationId', 'idempotencyKey', ...(operation === 'settle' ? ['actualUnits'] : operation === 'cancel' ? ['confirmedNotSent'] : [])];
    object(input, fields, fields.filter((field) => field !== 'modelRef'));
    id(input.idempotencyKey);
    const { idempotencyKey, ...payload } = input;
    const request = operation === 'reserve' ? { ...payload, modelRef: payload.modelRef ?? null } : payload;
    validateRequest(operation, request);
    const requestHash = hash({ operation, request });
    return transact(true, () => {
      const state = readState();
      const existing = state.rows.find((row) => row.idempotency_key === idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        return { reservation: JSON.parse(existing.snapshot_json), replayed: true, dispatchAllowed: false };
      }
      const reservationId = operation === 'reserve' ? randomUUID() : request.reservationId;
      const at = new Date().toISOString();
      const snapshot = apply(state, operation, request, reservationId, at);
      const sequence = state.rows.length + 1;
      const digest = hash({ sequence, operation, reservationId, idempotencyKey, requestHash, snapshot, previousHash: state.previousHash });
      db.prepare(`INSERT INTO budget_events(operation,reservation_id,idempotency_key,request_json,request_hash,snapshot_json,created_at,previous_hash,record_hash)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(operation, reservationId, idempotencyKey, canonical(request), requestHash,
        canonical(snapshot), at, state.previousHash, digest);
      return { reservation: copy(snapshot), replayed: false, dispatchAllowed: operation === 'start' };
    });
  }

  try { transact(false, () => readState()); }
  catch (error) { storage.close(); throw error; }

  return Object.freeze({
    scope,
    reserve: (input) => mutate('reserve', input),
    start: (input) => mutate('start', input),
    settle: (input) => mutate('settle', input),
    markUnknown: (input) => mutate('unknown', input),
    cancel: (input) => mutate('cancel', input),
    get(reservationId) { id(reservationId); return transact(false, () => copy(readState().reservations.get(reservationId) ?? null)); },
    summary() { return transact(false, () => copy(summarize(readState()))); },
    close() { if (!closed) { storage.close(); closed = true; } },
  });
}
