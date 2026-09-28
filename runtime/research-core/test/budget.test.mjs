import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createBudgetLedger } from '../src/budget.mjs';

const moduleUrl = new URL('../src/budget.mjs', import.meta.url).href;
const errorCode = (code) => (error) => error.code === code;
function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'research-budget-test-'));
  const options = { directory, accountId: 'shared-fixture', limitUnits: 100, ...extra };
  const handles = [];
  t.after(() => { handles.forEach((ledger) => ledger.close()); rmSync(directory, { recursive: true, force: true }); });
  const open = (overrides = {}) => { const ledger = createBudgetLedger({ ...options, ...overrides }); handles.push(ledger); return ledger; };
  return { options, open, file: join(directory, `billing-${options.accountId}`, options.environment ?? 'test', 'budget.sqlite') };
}
function request(extra = {}) { return { agentId: 'main', taskId: 'synthetic-task', amountUnits: 40, idempotencyKey: 'reserve-1', ...extra }; }
function reserve(ledger, extra = {}) { return ledger.reserve(request(extra)).reservation; }
function start(ledger, reservation, key = 'start-1') { return ledger.start({ reservationId: reservation.id, idempotencyKey: key }); }
function child(options, operation, payload = {}) {
  const script = `
    import { createBudgetLedger } from ${JSON.stringify(moduleUrl)};
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    const { options, operation, payload } = JSON.parse(process.argv[1]);
    let ledger;
    try {
      if (operation === 'crash-uncommitted') {
        const db = new DatabaseSync(join(options.directory, 'billing-' + options.accountId, options.environment ?? 'test', 'budget.sqlite'));
        db.exec("BEGIN IMMEDIATE; INSERT INTO budget_events(operation,reservation_id,idempotency_key,request_json,request_hash,snapshot_json,created_at,previous_hash,record_hash) VALUES('reserve','uncommitted','uncommitted','{}','x','{}','2000-01-01T00:00:00.000Z','','x')");
        console.log(JSON.stringify({ aborted: true }));
        process.exit(0);
      }
      ledger = createBudgetLedger(options);
      if (operation === 'start-and-exit') {
        const result = ledger.start(payload);
        console.log(JSON.stringify({ result }));
        process.exit(0);
      }
      console.log(JSON.stringify({ result: ledger[operation](payload) }));
    } catch (error) { console.log(JSON.stringify({ code: error.code ?? 'UNKNOWN' })); }
    finally { ledger?.close(); }
  `;
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const processHandle = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ options, operation, payload })], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
    processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
    processHandle.once('error', reject);
    processHandle.once('close', (code) => {
      if (code !== 0) reject(new Error(`Synthetic child exited ${code}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Synthetic child returned no valid result')); } }
    });
  });
}

test('reserve, start and settle preserve integer accounting across restart', (t) => {
  const { open } = fixture(t);
  const ledger = open();
  const reservation = reserve(ledger, { modelRef: 'fixture/standard' });
  assert.equal(reservation.state, 'reserved');
  assert.equal(reservation.environment, 'test');
  assert.equal(ledger.summary().availableUnits, 60);
  const begun = start(ledger, reservation);
  assert.equal(begun.dispatchAllowed, true);
  assert.equal(begun.replayed, false);
  const settled = ledger.settle({ reservationId: reservation.id, actualUnits: 25, idempotencyKey: 'settle-1' });
  assert.equal(settled.reservation.state, 'settled');
  assert.equal(settled.dispatchAllowed, false);
  assert.equal(ledger.summary().spentUnits, 25);
  assert.equal(ledger.summary().heldUnits, 0);
  ledger.close();
  const recovered = open();
  assert.equal(recovered.summary().availableUnits, 75);
  assert.equal(recovered.get(reservation.id).modelRef, 'fixture/standard');
  assert.equal(recovered.summary().providerHardCap, false);
});

test('different task agents share one account cap rather than separate allowances', (t) => {
  const { open } = fixture(t); const ledger = open();
  reserve(ledger, { agentId: 'main', amountUnits: 60 });
  reserve(ledger, { agentId: 'group-tim', amountUnits: 40, idempotencyKey: 'other-agent' });
  assert.equal(ledger.summary().availableUnits, 0);
  assert.throws(() => reserve(ledger, { agentId: 'third-agent', amountUnits: 1, idempotencyKey: 'over-cap' }), errorCode('BUDGET_EXCEEDED'));
  assert.equal(ledger.summary().reservationCount, 2);
});

test('idempotent retries do not duplicate holds, charges or permission to send', (t) => {
  const { open } = fixture(t); const ledger = open();
  const first = ledger.reserve(request()); const reservation = first.reservation;
  const retried = ledger.reserve(request());
  assert.deepEqual(retried.reservation, reservation);
  assert.equal(retried.replayed, true);
  assert.equal(retried.dispatchAllowed, false);
  assert.throws(() => ledger.reserve(request({ amountUnits: 41 })), errorCode('IDEMPOTENCY_CONFLICT'));
  start(ledger, reservation);
  assert.equal(start(ledger, reservation).dispatchAllowed, false);
  assert.throws(() => start(ledger, reservation, 'another-start'), errorCode('INVALID_TRANSITION'));
  const settlement = { reservationId: reservation.id, actualUnits: 30, idempotencyKey: 'settle' };
  ledger.settle(settlement);
  assert.equal(ledger.settle(settlement).replayed, true);
  assert.equal(ledger.summary().spentUnits, 30);
  assert.equal(start(ledger, reservation).dispatchAllowed, false);
  assert.equal(start(ledger, reservation).reservation.state, 'started', 'retry returns original snapshot, not a new authorization');
  assert.throws(() => ledger.settle({ ...settlement, actualUnits: 31 }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => ledger.markUnknown({ reservationId: reservation.id, idempotencyKey: 'settle' }), errorCode('IDEMPOTENCY_CONFLICT'));
});

test('unknown cost holds original amount and freezes all agents until known settlement', (t) => {
  const { open } = fixture(t); const ledger = open();
  const first = reserve(ledger);
  const second = reserve(ledger, { idempotencyKey: 'second', amountUnits: 10, agentId: 'group-tim' });
  start(ledger, first);
  const unknown = ledger.markUnknown({ reservationId: first.id, idempotencyKey: 'unknown' });
  assert.equal(unknown.reservation.state, 'unknown');
  assert.equal(ledger.summary().heldUnits, 50);
  assert.equal(ledger.summary().frozen, true);
  assert.deepEqual(ledger.summary().freezeReasons, ['unknown-cost']);
  assert.throws(() => start(ledger, second, 'second-start'), errorCode('ACCOUNT_FROZEN'));
  assert.throws(() => reserve(ledger, { idempotencyKey: 'third' }), errorCode('ACCOUNT_FROZEN'));
  assert.throws(() => ledger.cancel({ reservationId: first.id, confirmedNotSent: true, idempotencyKey: 'cancel-unknown' }), errorCode('CANNOT_CANCEL_STARTED'));
  ledger.close();
  const reopened = open(); assert.equal(reopened.summary().frozen, true);
  reopened.settle({ reservationId: first.id, actualUnits: 35, idempotencyKey: 'known-cost' });
  assert.equal(reopened.summary().frozen, false);
  assert.equal(reopened.summary().availableUnits, 55);
  assert.equal(start(reopened, second, 'second-start').dispatchAllowed, true);
});

test('unknown zero-cost reservation freezes account instead of assuming free service', (t) => {
  const { open } = fixture(t); const ledger = open();
  const item = reserve(ledger, { amountUnits: 0 }); start(ledger, item);
  ledger.markUnknown({ reservationId: item.id, idempotencyKey: 'unknown' });
  assert.equal(ledger.summary().availableUnits, 100);
  assert.equal(ledger.summary().frozen, true);
});

test('only explicitly confirmed unsent reservations may be cancelled', (t) => {
  const { open } = fixture(t); const ledger = open(); const item = reserve(ledger);
  for (const extra of [{}, { confirmedNotSent: false }, { confirmedNotSent: 'true' }]) {
    assert.throws(() => ledger.cancel({ reservationId: item.id, idempotencyKey: 'cancel', ...extra }), errorCode('VALIDATION'));
  }
  const request = { reservationId: item.id, confirmedNotSent: true, idempotencyKey: 'cancel' };
  assert.equal(ledger.cancel(request).reservation.state, 'cancelled');
  assert.equal(ledger.cancel(request).replayed, true);
  assert.equal(ledger.summary().availableUnits, 100);
  assert.throws(() => start(ledger, item), errorCode('INVALID_TRANSITION'));
  const started = reserve(ledger, { idempotencyKey: 'second' }); start(ledger, started, 'second-start');
  assert.throws(() => ledger.cancel({ ...request, reservationId: started.id, idempotencyKey: 'started-cancel' }), errorCode('CANNOT_CANCEL_STARTED'));
  assert.equal(ledger.summary().heldUnits, 40);
});

test('actual cost over reservation is recorded fully and latches freeze below account cap', (t) => {
  const { open } = fixture(t); const ledger = open(); const item = reserve(ledger, { amountUnits: 20 }); start(ledger, item);
  ledger.settle({ reservationId: item.id, actualUnits: 21, idempotencyKey: 'settle' });
  assert.equal(ledger.summary().spentUnits, 21);
  assert.equal(ledger.summary().availableUnits, 79);
  assert.deepEqual(ledger.summary().freezeReasons, ['reservation-overrun']);
  assert.throws(() => reserve(ledger, { amountUnits: 1, idempotencyKey: 'after-overrun' }), errorCode('ACCOUNT_FROZEN'));
  ledger.close(); assert.equal(open().summary().frozen, true);
});

test('actual cost exceeding whole limit is not clipped or falsified', (t) => {
  const { open } = fixture(t); const ledger = open(); const item = reserve(ledger); start(ledger, item);
  ledger.settle({ reservationId: item.id, actualUnits: 150, idempotencyKey: 'settle' });
  assert.equal(ledger.get(item.id).actualUnits, 150);
  assert.equal(ledger.summary().spentUnits, 150);
  assert.equal(ledger.summary().availableUnits, 0);
  assert.ok(ledger.summary().freezeReasons.includes('account-limit-exceeded'));
});

test('even overflowing aggregate costs remain exact decimal values and freeze consumption', (t) => {
  const { open } = fixture(t, { limitUnits: Number.MAX_SAFE_INTEGER }); const ledger = open();
  const a = reserve(ledger, { amountUnits: 0 }); const b = reserve(ledger, { amountUnits: 0, idempotencyKey: 'b' });
  start(ledger, a); start(ledger, b, 'b-start');
  ledger.settle({ reservationId: a.id, actualUnits: Number.MAX_SAFE_INTEGER, idempotencyKey: 'a-settle' });
  ledger.settle({ reservationId: b.id, actualUnits: Number.MAX_SAFE_INTEGER, idempotencyKey: 'b-settle' });
  assert.equal(ledger.summary().spentUnits, (2n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
  assert.equal(ledger.summary().availableUnits, 0);
  assert.ok(ledger.summary().freezeReasons.includes('accounting-overflow'));
});

test('fixed account configuration cannot silently reset or expand budget', (t) => {
  const { open, options } = fixture(t); const ledger = open(); reserve(ledger); ledger.close();
  assert.throws(() => open({ limitUnits: 1000 }), errorCode('CONFIG_MISMATCH'));
  assert.throws(() => open({ unit: 'other-unit' }), errorCode('CONFIG_MISMATCH'));
  assert.equal(open().summary().heldUnits, 40);
  const isolated = open({ accountId: 'separate-fixture' }); assert.equal(isolated.summary().availableUnits, 100);
  const otherEnvironment = open({ environment: 'paper' }); assert.equal(otherEnvironment.summary().availableUnits, 100);
  assert.throws(() => createBudgetLedger({ ...options, accountId: 'a'.repeat(73) }), errorCode('VALIDATION'));
});

test('malformed amounts, scope, unknown fields and illegal transitions fail without writes', (t) => {
  const { open, options } = fixture(t); const ledger = open();
  for (const amountUnits of [undefined, null, -1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '5']) {
    assert.throws(() => reserve(ledger, { amountUnits }), errorCode('VALIDATION'));
  }
  for (const extra of [{ agentId: '../main' }, { taskId: '' }, { modelRef: 'bad' }, { accountId: 'injected-account' }]) {
    assert.throws(() => reserve(ledger, extra), errorCode('VALIDATION'));
  }
  for (const override of [{ unit: null }, { environment: null }, { limitUnits: 1.5 }]) {
    assert.throws(() => createBudgetLedger({ ...options, ...override }), errorCode('VALIDATION'));
  }
  assert.equal(ledger.summary().eventCount, 0);
  const item = reserve(ledger);
  assert.throws(() => ledger.settle({ reservationId: item.id, actualUnits: 1, idempotencyKey: 'no-start' }), errorCode('INVALID_TRANSITION'));
  assert.throws(() => ledger.markUnknown({ reservationId: item.id, idempotencyKey: 'no-start' }), errorCode('INVALID_TRANSITION'));
  assert.throws(() => ledger.start({ reservationId: 'missing', idempotencyKey: 'missing' }), errorCode('NOT_FOUND'));
  assert.equal(ledger.summary().eventCount, 1);
});

test('returned snapshots and caller option mutation cannot change persisted accounting', (t) => {
  const { options } = fixture(t); const mutable = { ...options }; const ledger = createBudgetLedger(mutable);
  t.after(() => ledger.close()); mutable.limitUnits = 9999;
  const result = ledger.reserve(request()); result.reservation.amountUnits = 1;
  assert.equal(ledger.get(result.reservation.id).amountUnits, 40);
  assert.equal(ledger.summary().limitUnits, 100);
  assert.equal(ledger.summary().availableUnits, 60);
});

test('append-only events and hash checks reject logical corruption without repair', (t) => {
  const { open, file } = fixture(t); const ledger = open(); reserve(ledger);
  const direct = new DatabaseSync(file); t.after(() => direct.close());
  assert.throws(() => direct.exec('UPDATE budget_events SET request_hash = \'x\''), /immutable/);
  direct.exec('DROP TRIGGER budget_events_no_update; UPDATE budget_events SET request_hash = \'x\'');
  assert.throws(() => ledger.summary(), errorCode('CORRUPT_STORE'));
  assert.throws(() => reserve(ledger, { idempotencyKey: 'after-corruption' }), errorCode('CORRUPT_STORE'));
  assert.equal(direct.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n, 1);
});

test('truncated database is retained and never reset to a fresh allowance', (t) => {
  const { open, file } = fixture(t); const ledger = open(); reserve(ledger); ledger.close();
  writeFileSync(file, ''); assert.throws(() => open()); assert.equal(readFileSync(file).length, 0);
});

test('concurrent reservations by different agents cannot oversubscribe account', async (t) => {
  const { options, open } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => child(options, 'reserve', request({
    agentId: i % 2 ? 'group-tim' : 'main', taskId: `task-${i}`, amountUnits: 30, idempotencyKey: `concurrent-${i}`,
  }))));
  assert.equal(results.filter((r) => r.result).length, 3);
  assert.equal(results.filter((r) => r.code === 'BUDGET_EXCEEDED').length, 5);
  assert.equal(open().summary().heldUnits, 90);
});

test('concurrent duplicate reserves and starts commit once and authorize one send', async (t) => {
  const { options, open } = fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => child(options, 'reserve', request())));
  assert.ok(results.every((r) => r.result));
  assert.equal(results.filter((r) => !r.result.replayed).length, 1);
  assert.equal(new Set(results.map((r) => r.result.reservation.id)).size, 1);
  const payload = { reservationId: results[0].result.reservation.id, idempotencyKey: 'start' };
  const starts = await Promise.all(Array.from({ length: 6 }, () => child(options, 'start', payload)));
  assert.equal(starts.filter((r) => r.result?.dispatchAllowed).length, 1);
  assert.equal(starts.filter((r) => r.result?.replayed).length, 5);
  assert.equal(open().summary().heldUnits, 40);
});

test('process exit after start preserves hold and never reauthorizes automatic send', async (t) => {
  const { options, open } = fixture(t); const ledger = open(); const item = reserve(ledger); ledger.close();
  const payload = { reservationId: item.id, idempotencyKey: 'start' };
  assert.equal((await child(options, 'start-and-exit', payload)).result.dispatchAllowed, true);
  const recovered = open();
  assert.equal(recovered.summary().heldUnits, 40);
  assert.equal(recovered.summary().requiresReconciliation, true);
  assert.equal(recovered.summary().frozen, false, 'started hold alone pins the cap without blocking unrelated reserved capacity');
  assert.equal(recovered.start(payload).dispatchAllowed, false);
  assert.throws(() => recovered.cancel({ ...payload, confirmedNotSent: true, idempotencyKey: 'cancel' }), errorCode('CANNOT_CANCEL_STARTED'));
});

test('SQLite recovers an interrupted uncommitted event without releasing prior hold', async (t) => {
  const { options, open } = fixture(t); const ledger = open(); reserve(ledger); ledger.close();
  assert.equal((await child(options, 'crash-uncommitted')).aborted, true);
  const recovered = open();
  assert.equal(recovered.summary().eventCount, 1);
  assert.equal(recovered.summary().heldUnits, 40);
});
