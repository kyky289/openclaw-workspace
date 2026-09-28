import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createDefaultPolicy } from '../src/router.mjs';
import { createBudgetLedger } from '../src/budget.mjs';
import { createModelDispatcher } from '../src/dispatcher.mjs';

const dispatcherModule = new URL('../src/dispatcher.mjs', import.meta.url).href;
const budgetModule = new URL('../src/budget.mjs', import.meta.url).href;
const code = (expected) => (error) => error.code === expected;
function policy() {
  const value = createDefaultPolicy(); value.budget.unit = 'usd-micro';
  for (const role of ['fast', 'standard', 'deep']) value.models[role] = {
    modelRef: `fixture/${role}`, approved: true, ready: true, capabilities: ['text'], estimatedUnits: 20,
  };
  return value;
}
function request(extra = {}) {
  return { taskId: 'synthetic-task', idempotencyKey: 'dispatch-1', request: {
    metadata: { risk: 'low', impact: 'ephemeral', complexity: 'low' }, prompt: 'Format this list.', dryRun: false,
  }, ...extra };
}
function receipt(extra = {}) { return { provider: 'fixture', model: 'fast', costUnits: 10, output: 'Synthetic output only.', ...extra }; }
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'research-dispatch-test-'));
  const handles = [];
  const ledgerOptions = { directory, accountId: 'fixture-account', limitUnits: 100 };
  const ledger = createBudgetLedger(ledgerOptions); handles.push(ledger);
  const open = (extra = {}) => {
    const dispatcher = createModelDispatcher({ directory, agentId: 'main', environment: 'test', ledger,
      policy: policy(), invoke: async () => receipt(), ...extra });
    handles.push(dispatcher); return dispatcher;
  };
  t.after(() => { [...handles].reverse().forEach((handle) => handle.close()); rmSync(directory, { recursive: true, force: true }); });
  return { directory, ledger, ledgerOptions, open };
}
function child(directory, mode = 'normal') {
  const script = `
    import { createModelDispatcher } from ${JSON.stringify(dispatcherModule)};
    import { createBudgetLedger } from ${JSON.stringify(budgetModule)};
    import { appendFileSync } from 'node:fs'; import {join} from 'node:path';
    const { directory, mode, policy, request } = JSON.parse(process.argv[1]);
    const ledger = createBudgetLedger({ directory, accountId:'fixture-account', limitUnits:100 });
    let dispatcher;
    const invoke = async () => {
      appendFileSync(join(directory,'synthetic-invocations.log'),'called\\n');
      if(mode==='crash-invoke') { console.log(JSON.stringify({crashed:true})); process.exit(0); }
      await new Promise(resolve=>setTimeout(resolve,80));
      return {provider:'fixture',model:'fast',costUnits:10,output:'Synthetic output only.'};
    };
    if(mode==='crash-after-settle') {
      const real=ledger.settle;
      const injected={scope:ledger.scope,...Object.fromEntries(['summary','reserve','start','markUnknown','cancel','get'].map(k=>[k,ledger[k]])),
        settle(input){ const result=real(input); console.log(JSON.stringify({crashed:true})); process.exit(0); }};
      dispatcher=createModelDispatcher({directory,agentId:'main',environment:'test',ledger:injected,policy,invoke});
    } else dispatcher=createModelDispatcher({directory,agentId:'main',environment:'test',ledger,policy,invoke});
    try { console.log(JSON.stringify({result:await dispatcher.dispatch(request)})); }
    catch(error){ console.log(JSON.stringify({code:error.code??'UNKNOWN'})); }
    finally {dispatcher.close();ledger.close();}
  `;
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const processHandle = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ directory, mode, policy: policy(), request: request() })],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
    processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
    processHandle.once('error', reject);
    processHandle.once('close', (exitCode) => {
      if (exitCode !== 0) reject(new Error(`Synthetic child exited ${exitCode}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Synthetic child returned no valid result')); } }
    });
  });
}

test('durable completed result replays without another invocation or charge', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0;
  const dispatcher = open({ invoke: async (payload) => {
    calls++; assert.deepEqual(payload.modelOverride, { providerOverride: 'fixture', modelOverride: 'fast' });
    assert.equal(payload.request.budget, undefined); assert.ok(payload.signal instanceof AbortSignal);
    return receipt();
  } });
  const result = await dispatcher.dispatch(request());
  assert.equal(result.status, 'completed'); assert.equal(result.output, receipt().output);
  assert.equal(result.replayed, false); assert.equal(result.executionAuthorized, false);
  assert.equal(ledger.summary().spentUnits, 10);
  dispatcher.close();
  const reopened = open({ invoke: async () => { calls++; throw new Error('Must never run'); } });
  assert.deepEqual(await reopened.dispatch(request()), { ...result, replayed: true });
  assert.equal(calls, 1); assert.equal(ledger.summary().spentUnits, 10);
});

test('same key with changed task or prompt is rejected without another call', async (t) => {
  const { open } = fixture(t); let calls = 0;
  const dispatcher = open({ invoke: async () => { calls++; return receipt(); } });
  await dispatcher.dispatch(request());
  await assert.rejects(dispatcher.dispatch(request({ taskId: 'other-task' })), code('DISPATCH_CONFLICT'));
  const changed = request(); changed.request.prompt = 'Different material';
  await assert.rejects(dispatcher.dispatch(changed), code('DISPATCH_CONFLICT'));
  assert.equal(calls, 1);
});

test('host ledger budget cannot be overridden and dry runs cannot invoke', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0;
  const dispatcher = open({ invoke: async () => { calls++; return receipt(); } });
  const injected = request(); injected.request.budget = { unit: 'usd-micro', remainingUnits: 9999 };
  await assert.rejects(dispatcher.dispatch(injected), code('INPUT_INVALID'));
  const dry = request(); dry.request.dryRun = true;
  assert.equal((await dispatcher.dispatch(dry)).status, 'proposed');
  assert.equal(calls, 0); assert.equal(ledger.summary().reservationCount, 0);
});

test('unapproved or unaffordable routes cannot reserve or invoke', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0;
  const inactive = policy(); inactive.models.fast.approved = false;
  const first = open({ policy: inactive, invoke: async () => { calls++; return receipt(); } });
  assert.equal((await first.dispatch(request())).status, 'blocked'); first.close();
  const expensive = policy(); expensive.models.fast.estimatedUnits = 101;
  const second = open({ policy: expensive, invoke: async () => { calls++; return receipt(); } });
  assert.equal((await second.dispatch(request())).status, 'blocked');
  assert.equal(calls, 0); assert.equal(ledger.summary().reservationCount, 0);
});

test('scope, unit and integer cost estimates must match the injected account', (t) => {
  const { open } = fixture(t);
  assert.throws(() => open({ environment: 'live' }), code('DISPATCH_OPTIONS_INVALID'));
  const otherUnit = policy(); otherUnit.budget.unit = 'usd';
  assert.throws(() => open({ policy: otherUnit }), code('DISPATCH_OPTIONS_INVALID'));
  const fractional = policy(); fractional.models.fast.estimatedUnits = 0.5;
  assert.throws(() => open({ policy: fractional }), code('DISPATCH_OPTIONS_INVALID'));
});

test('known costs settle even when provider or model silently changes; output withheld', async (t) => {
  const { open, ledger } = fixture(t);
  const dispatcher = open({ invoke: async () => receipt({ provider: 'other-provider', output: 'Do not expose' }) });
  const result = await dispatcher.dispatch(request());
  assert.equal(result.status, 'needs-review'); assert.equal(result.output, undefined);
  assert.ok(result.reasonCodes.includes('RESOLVED_PROVIDER_MISMATCH'));
  assert.equal(ledger.summary().spentUnits, 10); assert.equal(ledger.summary().heldUnits, 0);
});

test('malformed and oversized results are charged when known, never accepted as output', async (t) => {
  const { open, ledger } = fixture(t);
  const dispatcher = open({ invoke: async ({ taskId }) => taskId === 'extra-field'
    ? { ...receipt(), unexpected: 'private-sentinel' } : receipt({ output: 'x'.repeat(65537) }) });
  const extra = await dispatcher.dispatch(request({ taskId: 'extra-field' }));
  assert.ok(extra.reasonCodes.includes('INVALID_RECEIPT')); assert.equal(extra.output, undefined);
  const oversized = await dispatcher.dispatch(request({ idempotencyKey: 'second' }));
  assert.ok(oversized.reasonCodes.includes('INVALID_OUTPUT')); assert.equal(oversized.output, undefined);
  assert.equal(ledger.summary().spentUnits, 20);
  assert.equal(JSON.stringify(extra).includes('private-sentinel'), false);
});

test('cost over reservation is recorded in full and future spending stops', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0;
  const dispatcher = open({ invoke: async () => { calls++; return receipt({ costUnits: 30 }); } });
  const first = await dispatcher.dispatch(request());
  assert.ok(first.reasonCodes.includes('ACTUAL_COST_EXCEEDED_RESERVATION'));
  assert.equal(first.output, undefined); assert.equal(ledger.summary().spentUnits, 30);
  assert.equal(ledger.summary().frozen, true);
  assert.equal((await dispatcher.dispatch(request({ idempotencyKey: 'second' }))).status, 'blocked');
  assert.equal(calls, 1);
});

test('missing cost freezes account, preserves hold, and replay never retries', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0;
  const dispatcher = open({ invoke: async () => { calls++; return receipt({ costUnits: null }); } });
  const result = await dispatcher.dispatch(request());
  assert.deepEqual(result.reasonCodes, ['COST_UNKNOWN']); assert.equal(result.output, undefined);
  assert.equal(ledger.summary().frozen, true); assert.equal(ledger.summary().heldUnits, 20);
  assert.equal((await dispatcher.dispatch(request())).replayed, true);
  assert.equal(calls, 1);
});

test('thrown provider errors become fixed diagnostics, retain hold and freeze account', async (t) => {
  const { open, ledger } = fixture(t);
  const dispatcher = open({ invoke: async () => { throw new Error('private-credential-sentinel'); } });
  const result = await dispatcher.dispatch(request());
  assert.deepEqual(result.reasonCodes, ['INVOKE_FAILED', 'COST_UNKNOWN']);
  assert.equal(JSON.stringify(result).includes('private-credential-sentinel'), false);
  assert.equal(ledger.summary().frozen, true); assert.equal(ledger.summary().heldUnits, 20);
});

test('timeout signals abort and preserves unknown-cost hold instead of assuming cancellation', async (t) => {
  const { open, ledger } = fixture(t); let signal;
  const dispatcher = open({ timeoutMs: 10, invoke: async (payload) => { signal = payload.signal; return new Promise(() => {}); } });
  const result = await dispatcher.dispatch(request());
  assert.ok(result.reasonCodes.includes('INVOKE_TIMEOUT')); assert.equal(signal.aborted, true);
  assert.equal(ledger.summary().frozen, true); assert.equal(ledger.summary().heldUnits, 20);
});

test('concurrent callers in one process receive one invocation and a pending review response', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0; let release;
  const dispatcher = open({ invoke: async () => { calls++; return new Promise((resolve) => { release = () => resolve(receipt()); }); } });
  const first = dispatcher.dispatch(request());
  await Promise.resolve();
  const second = await dispatcher.dispatch(request());
  assert.equal(second.status, 'needs-review'); assert.equal(second.replayed, true);
  assert.ok(second.reasonCodes.includes('PENDING_DISPATCH_REQUIRES_RECONCILIATION'));
  assert.throws(() => dispatcher.close(), code('IN_FLIGHT'));
  release(); assert.equal((await first).status, 'completed');
  assert.equal(calls, 1); assert.equal(ledger.summary().spentUnits, 10);
});

test('policy is pinned for pending work and completed replay across new policy versions', async (t) => {
  const { open } = fixture(t); const supplied = policy(); let resolveCall;
  const dispatcher = open({ policy: supplied, invoke: async (payload) => {
    assert.equal(payload.modelOverride.modelOverride, 'fast');
    return new Promise((resolve) => { resolveCall = resolve; });
  } });
  supplied.models.fast.modelRef = 'fixture/changed';
  const pending = dispatcher.dispatch(request()); await Promise.resolve();
  resolveCall(receipt()); const result = await pending; dispatcher.close();
  const replacement = policy(); replacement.models.fast.modelRef = 'fixture/other';
  const reopened = open({ policy: replacement, invoke: async () => { throw new Error('Must not retry'); } });
  assert.deepEqual(await reopened.dispatch(request()), { ...result, replayed: true });
});

test('failure before model start cancels only a confirmed still-unsent reservation', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0;
  const injected = { ...ledger, start() { const error = new Error('synthetic failure'); error.code = 'BUSY'; throw error; } };
  const dispatcher = open({ ledger: injected, invoke: async () => { calls++; return receipt(); } });
  const result = await dispatcher.dispatch(request());
  assert.deepEqual(result.reasonCodes, ['BUSY']); assert.equal(calls, 0);
  assert.equal(ledger.summary().heldUnits, 0); assert.equal(ledger.summary().counts.cancelled, 1);
});

test('failure after durable start retains the hold even if no output was obtained', async (t) => {
  const { open, ledger } = fixture(t); let calls = 0;
  const injected = { ...ledger, start(input) { ledger.start(input); throw new Error('Synthetic ambiguous acknowledgement'); } };
  const dispatcher = open({ ledger: injected, invoke: async () => { calls++; return receipt(); } });
  const result = await dispatcher.dispatch(request());
  assert.equal(result.status, 'needs-review'); assert.equal(calls, 0);
  assert.equal(ledger.summary().heldUnits, 20); assert.equal(ledger.summary().frozen, true);
});

test('six independent processes persist one intent and perform one synthetic invocation', async (t) => {
  const { directory, ledger } = fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => child(directory)));
  assert.ok(results.every((item) => item.result));
  assert.equal(results.filter((item) => item.result.status === 'completed' && !item.result.replayed).length, 1);
  assert.equal(readFileSync(join(directory, 'synthetic-invocations.log'), 'utf8'), 'called\n');
  assert.equal(ledger.summary().spentUnits, 10);
});

test('crash during invocation leaves a started hold and never redispatches on restart', async (t) => {
  const { directory, ledger, open } = fixture(t);
  assert.equal((await child(directory, 'crash-invoke')).crashed, true);
  const dispatcher = open({ invoke: async () => { throw new Error('Must not run'); } });
  const result = await dispatcher.dispatch(request());
  assert.equal(result.status, 'needs-review');
  assert.ok(result.reasonCodes.includes('PENDING_DISPATCH_REQUIRES_RECONCILIATION'));
  assert.equal(ledger.summary().heldUnits, 20); assert.equal(ledger.summary().counts.started, 1);
  assert.equal(readFileSync(join(directory, 'synthetic-invocations.log'), 'utf8'), 'called\n');
});

test('crash after cost settlement but before result cache never invokes or charges again', async (t) => {
  const { directory, ledger, open } = fixture(t);
  assert.equal((await child(directory, 'crash-after-settle')).crashed, true);
  const dispatcher = open({ invoke: async () => { throw new Error('Must not run'); } });
  const result = await dispatcher.dispatch(request());
  assert.equal(result.status, 'needs-review'); assert.equal(result.output, undefined);
  assert.equal(ledger.summary().spentUnits, 10); assert.equal(ledger.summary().heldUnits, 0);
  assert.equal(readFileSync(join(directory, 'synthetic-invocations.log'), 'utf8'), 'called\n');
});
