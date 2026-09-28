import { createHash } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';
import { prepareTurn, validateResolvedModel } from './adapter.mjs';
import { validatePolicy } from './router.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SAFE_CODES = new Set(['ACCOUNT_FROZEN', 'BUDGET_EXCEEDED', 'IDEMPOTENCY_CONFLICT', 'INVALID_TRANSITION',
  'CANNOT_CANCEL_STARTED', 'NOT_FOUND', 'CORRUPT_STORE', 'CONFIG_MISMATCH', 'BUSY', 'STORAGE', 'CLOSED',
  'UNSAFE_STORAGE', 'INVOKE_TIMEOUT', 'INPUT_INVALID', 'DISPATCH_CONFLICT']);

export class DispatcherError extends Error {
  constructor(code) { super(`Model dispatcher: ${code}`); this.name = 'DispatcherError'; this.code = code; }
}
function fail(code) { throw new DispatcherError(code); }
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) fail('INPUT_INVALID');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function safeCode(error) { return SAFE_CODES.has(error?.code) ? error.code : 'OPERATION_FAILED'; }
function knownCost(value) { return Number.isSafeInteger(value) && value >= 0; }

/** No default client: trusted host injects invoke, account ledger and approved policy. */
export function createModelDispatcher(options) {
  object(options, ['directory', 'agentId', 'environment', 'ledger', 'policy', 'invoke', 'timeoutMs'],
    ['directory', 'agentId', 'environment', 'ledger', 'policy', 'invoke']);
  const { directory, agentId, environment, ledger, invoke } = options;
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  if (typeof agentId !== 'string' || !ID.test(agentId) || !['test', 'paper', 'live'].includes(environment)
    || typeof invoke !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !ledger || !['summary', 'reserve', 'start', 'settle', 'markUnknown', 'cancel', 'get'].every((name) => typeof ledger[name] === 'function')
    || ledger.scope?.environment !== environment || typeof ledger.scope?.accountId !== 'string'
    || !validatePolicy(options.policy).valid || options.policy.budget.unit !== ledger.scope?.unit
    || Object.values(options.policy.models).some((model) => model.estimatedUnits !== null && !knownCost(model.estimatedUnits))) fail('DISPATCH_OPTIONS_INVALID');
  const policy = deepFreeze(copy(options.policy));
  const binding = Object.freeze({ agentId, environment, accountId: ledger.scope.accountId, unit: ledger.scope.unit });
  const store = openPrivateStore({ directory, agentId, environment, name: 'dispatcher', version: 1,
    initialize(db) {
      db.exec(`
        CREATE TABLE dispatcher_binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL) STRICT;
        CREATE TABLE dispatches (
          idempotency_key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          intent_json TEXT NOT NULL,
          intent_hash TEXT NOT NULL,
          reservation_id TEXT,
          result_json TEXT,
          result_hash TEXT,
          CHECK((result_json IS NULL) = (result_hash IS NULL))
        ) STRICT;
        CREATE TRIGGER dispatches_no_delete BEFORE DELETE ON dispatches BEGIN SELECT RAISE(ABORT,'immutable'); END;
        CREATE TRIGGER dispatches_protect_intent BEFORE UPDATE ON dispatches
        WHEN NEW.idempotency_key != OLD.idempotency_key OR NEW.request_hash != OLD.request_hash
          OR NEW.intent_json != OLD.intent_json OR NEW.intent_hash != OLD.intent_hash
          OR (OLD.reservation_id IS NOT NULL AND (NEW.reservation_id IS NULL OR NEW.reservation_id != OLD.reservation_id))
          OR OLD.result_json IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'immutable'); END;
      `);
      db.prepare('INSERT INTO dispatcher_binding VALUES(1,?)').run(canonical(binding));
    },
  });
  const { db } = store;
  let closed = false; let activeCalls = 0;

  function transaction(write, operation) {
    if (closed) fail('CLOSED');
    try {
      return store.transaction(write, () => {
        const bindings = db.prepare('SELECT * FROM dispatcher_binding').all();
        if (bindings.length !== 1 || bindings[0].value !== canonical(binding)) fail('CONFIG_MISMATCH');
        return operation();
      });
    } catch (error) {
      if (error instanceof DispatcherError) throw error;
      fail(safeCode(error));
    }
  }
  try { transaction(false, () => null); }
  catch (error) { store.close(); throw error; }

  function read(idempotencyKey) {
    const row = db.prepare('SELECT * FROM dispatches WHERE idempotency_key=?').get(idempotencyKey);
    if (!row) return null;
    try {
      const intent = JSON.parse(row.intent_json);
      if (canonical(intent) !== row.intent_json || hash(intent) !== row.intent_hash || !/^[a-f0-9]{64}$/.test(row.request_hash)
        || typeof intent.taskId !== 'string' || !ID.test(intent.taskId)
        || !knownCost(intent.prepared?.route?.spend?.estimate) || intent.prepared?.route?.status !== 'ready'
        || typeof intent.reservationKey !== 'string' || !ID.test(intent.reservationKey)) fail('CORRUPT_STORE');
      let result = null;
      if (row.result_json !== null) {
        result = JSON.parse(row.result_json);
        if (canonical(result) !== row.result_json || hash(result) !== row.result_hash) fail('CORRUPT_STORE');
      }
      return { ...row, intent, result };
    } catch { fail('CORRUPT_STORE'); }
  }

  function persistedResult(idempotencyKey, result) {
    return transaction(true, () => {
      const row = read(idempotencyKey);
      if (!row) fail('CORRUPT_STORE');
      if (row.result) return { ...row.result, replayed: true };
      db.prepare('UPDATE dispatches SET result_json=?, result_hash=? WHERE idempotency_key=?').run(canonical(result), hash(result), idempotencyKey);
      return copy(result);
    });
  }

  function resultBase(intent, reservationId = null) {
    return { status: 'needs-review', reasonCodes: [], replayed: false, invoked: false,
      taskId: intent.taskId, reservationId, modelRef: intent.prepared.route.modelRef,
      policyVersion: intent.prepared.route.policyVersion, executionAuthorized: false };
  }
  function replay(row, requestHash) {
    if (row.request_hash !== requestHash) fail('DISPATCH_CONFLICT');
    if (row.result) return { ...copy(row.result), replayed: true };
    return { ...resultBase(row.intent, row.reservation_id), replayed: true,
      reasonCodes: ['PENDING_DISPATCH_REQUIRES_RECONCILIATION'] };
  }

  async function boundedInvoke(payload) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(); reject(new DispatcherError('INVOKE_TIMEOUT'));
      }, timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => invoke({ ...payload, signal: controller.signal })), deadline]); }
    finally { clearTimeout(timer); }
  }

  async function dispatch(input) {
    object(input, ['taskId', 'request', 'idempotencyKey']);
    if (typeof input.taskId !== 'string' || !ID.test(input.taskId) || typeof input.idempotencyKey !== 'string' || !ID.test(input.idempotencyKey)
      || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)
      || Object.hasOwn(input.request, 'budget')) fail('INPUT_INVALID');
    // Validate original values before JSON cloning can turn nonfinite numbers into null.
    const preliminary = prepareTurn(input.request, policy);
    if (preliminary.route.proposedRole === null) return { status: 'blocked', reasonCodes: preliminary.route.reasonCodes,
      replayed: false, invoked: false, executionAuthorized: false };
    const request = copy(input.request);
    const requestHash = hash({ taskId: input.taskId, request });
    const prior = transaction(false, () => read(input.idempotencyKey));
    if (prior) return replay(prior, requestHash);
    const budget = ledger.summary();
    const prepared = prepareTurn({ ...request, budget: { unit: budget.scope.unit, remainingUnits: budget.availableUnits } }, policy);
    if (budget.frozen || prepared.route.status !== 'ready') {
      return { status: budget.frozen ? 'blocked' : prepared.route.status === 'proposed' ? 'proposed' : 'blocked',
        route: prepared.route, reasonCodes: [...prepared.route.reasonCodes, ...(budget.frozen ? ['ACCOUNT_FROZEN'] : [])],
        replayed: false, invoked: false, executionAuthorized: false };
    }
    const reservationKey = `d-${hash({ ...binding, idempotencyKey: input.idempotencyKey })}`;
    const intent = { taskId: input.taskId, reservationKey, prepared, policy: copy(policy) };
    const existing = transaction(true, () => {
      const row = read(input.idempotencyKey);
      if (row) return row;
      db.prepare('INSERT INTO dispatches(idempotency_key,request_hash,intent_json,intent_hash) VALUES(?,?,?,?)')
        .run(input.idempotencyKey, requestHash, canonical(intent), hash(intent));
      return null;
    });
    if (existing) return replay(existing, requestHash);
    activeCalls++;
    let reservationId = null; let began = false; let invoked = false;
    const base = () => ({ ...resultBase(intent, reservationId), invoked });
    try {
      const reserved = ledger.reserve({ agentId, taskId: input.taskId, amountUnits: prepared.route.spend.estimate,
        modelRef: prepared.route.modelRef, idempotencyKey: `${reservationKey}-reserve` });
      reservationId = reserved.reservation.id;
      transaction(true, () => db.prepare('UPDATE dispatches SET reservation_id=? WHERE idempotency_key=?').run(reservationId, input.idempotencyKey));
      const started = ledger.start({ reservationId, idempotencyKey: `${reservationKey}-start` });
      began = true;
      if (!started.dispatchAllowed) return persistedResult(input.idempotencyKey,
        { ...base(), reasonCodes: ['DISPATCH_ALREADY_STARTED'] });
      invoked = true;
      let receipt;
      try {
        receipt = await boundedInvoke({ taskId: input.taskId, request: copy(request),
          modelOverride: copy(prepared.modelOverride), verificationContext: copy(prepared.verificationContext) });
      } catch (error) {
        ledger.markUnknown({ reservationId, idempotencyKey: `${reservationKey}-unknown` });
        return persistedResult(input.idempotencyKey, { ...base(),
          reasonCodes: [error?.code === 'INVOKE_TIMEOUT' ? 'INVOKE_TIMEOUT' : 'INVOKE_FAILED', 'COST_UNKNOWN'] });
      }
      const validCost = receipt !== null && typeof receipt === 'object' && knownCost(receipt.costUnits);
      if (!validCost) {
        ledger.markUnknown({ reservationId, idempotencyKey: `${reservationKey}-unknown` });
        return persistedResult(input.idempotencyKey, { ...base(), reasonCodes: ['COST_UNKNOWN'] });
      }
      // Actual known costs are accounted even when the provider/model/output is wrong.
      ledger.settle({ reservationId, actualUnits: receipt.costUnits, idempotencyKey: `${reservationKey}-settle` });
      const receiptShapeValid = !Array.isArray(receipt) && ['provider', 'model', 'costUnits', 'output'].every((key) => Object.hasOwn(receipt, key))
        && Object.keys(receipt).every((key) => ['provider', 'model', 'costUnits', 'output'].includes(key));
      const verified = validateResolvedModel({ provider: receipt.provider, model: receipt.model }, prepared.verificationContext);
      const reasons = [];
      if (!receiptShapeValid) reasons.push('INVALID_RECEIPT');
      if (!verified.valid) reasons.push(...verified.reasonCodes);
      if (typeof receipt.output !== 'string' || Buffer.byteLength(receipt.output) > MAX_OUTPUT_BYTES) reasons.push('INVALID_OUTPUT');
      if (receipt.costUnits > prepared.route.spend.estimate) reasons.push('ACTUAL_COST_EXCEEDED_RESERVATION');
      if (reasons.length) return persistedResult(input.idempotencyKey, { ...base(), reasonCodes: reasons });
      return persistedResult(input.idempotencyKey, { ...base(), status: 'completed', output: receipt.output,
        costUnits: receipt.costUnits, reasonCodes: ['COMPLETED'] });
    } catch (error) {
      const reasons = [safeCode(error)];
      if (reservationId) {
        try {
          const current = ledger.get(reservationId);
          if (!began && !invoked && current?.state === 'reserved') {
            ledger.cancel({ reservationId, confirmedNotSent: true, idempotencyKey: `${reservationKey}-cancel` });
          } else if (current?.state === 'started') {
            ledger.markUnknown({ reservationId, idempotencyKey: `${reservationKey}-unknown` });
          }
        } catch { reasons.push('BUDGET_RECONCILIATION_REQUIRED'); }
      }
      const result = { ...base(), reasonCodes: reasons };
      try { return persistedResult(input.idempotencyKey, result); }
      catch { return { ...result, reasonCodes: [...reasons, 'RESULT_PERSISTENCE_FAILED'] }; }
    } finally { activeCalls--; }
  }

  return Object.freeze({ dispatch, close() {
    if (activeCalls) fail('IN_FLIGHT');
    if (!closed) { store.close(); closed = true; }
  } });
}
