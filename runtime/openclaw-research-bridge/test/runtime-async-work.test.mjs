import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import { createRuntimeAsyncWorkPatch } from '../src/runtime-async-work-patch.mjs';

// Read source only. Evaluate isolated functions with fixture dependencies; never import the
// gateway entrypoint, open a listener, read config/credentials, run a model, or send messages.
const directory = process.env.OPENCLAW_ASYNC_WORK_SOURCE_DIR
  ?? (process.env.OPENCLAW_RUNTIME_ROOT ? path.join(process.env.OPENCLAW_RUNTIME_ROOT, 'dist') : null);
const available = directory ? {} : { skip: 'Set OPENCLAW_ASYNC_WORK_SOURCE_DIR to an audited source snapshot, or OPENCLAW_RUNTIME_ROOT to the package.' };
const hash = source => createHash('sha256').update(source, 'utf8').digest('hex');
function readSources() {
  const read = name => readFileSync(path.join(directory, name), 'utf8');
  return {
    asyncWorkSource: read('async-work-scope-DeWEUzMu.mjs'), mcpSource: read('mcp-http-DFannafQ.mjs'),
    gatewayAdmissionSource: read('gateway-work-admission-DaOR_dL4.mjs'), toolSource: read('tools-CulcXFDi.mjs'),
  };
}
function extract(source, name) {
  const marker = `function ${name}(`;
  const at = source.indexOf(marker);
  assert(at >= 0 && at === source.lastIndexOf(marker), `Unique real function required: ${name}`);
  const start = source.slice(at - 6, at) === 'async ' ? at - 6 : at;
  const end = source.indexOf('\n}', at);
  assert(end > at, `Top-level end required: ${name}`);
  return source.slice(start, end + 2);
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ patched = true, startGate, failures = 0 } = {}) {
  const input = readSources();
  const patch = createRuntimeAsyncWorkPatch(input);
  const workSource = patched ? patch.files[0].source : input.asyncWorkSource;
  const mcpSource = patched ? patch.files[1].source : input.mcpSource;
  const singleton = new Map();
  const work = vm.runInNewContext(`${workSource.slice(workSource.indexOf('//#region'), workSource.indexOf('\nexport {'))}
    ({AsyncWorkScope, runWithTrackedCancellation, getAsyncWorkSignal, trackAsyncWork,
      runOutsideAsyncWorkScope: typeof runOutsideAsyncWorkScope === 'undefined' ? undefined : runOutsideAsyncWorkScope})`, {
    AsyncLocalStorage, AbortController, createDeferredCore: deferred,
    resolveGlobalSingleton: (key, make) => { if (!singleton.has(key)) singleton.set(key, make()); return singleton.get(key); },
  }, { timeout: 1000 });
  const rootScope = new AsyncLocalStorage();
  const traceScope = new AsyncLocalStorage();
  const identityScope = new AsyncLocalStorage();
  const registryScope = new AsyncLocalStorage();
  const pluginScope = new AsyncLocalStorage();
  const admissionState = { currentRootWork: rootScope, restartDraining: false, restartSignalPending: false, suspendPhase: 'accepting' };
  const admission = vm.runInNewContext(`${extract(input.gatewayAdmissionSource, 'runOutsideGatewayRootWorkAdmission')}
    ${extract(input.gatewayAdmissionSource, 'isGatewaySubordinateWorkAdmissionClosed')}
    ({runOutsideGatewayRootWorkAdmission, isGatewaySubordinateWorkAdmissionClosed})`, {
    GATEWAY_WORK_ADMISSION_STATE: admissionState,
  }, { timeout: 1000 });
  const state = { starts: 0, closes: 0, active: 0, executions: 0, registryActive: true, grantCurrent: true,
    dispatch: null, body: null, lastSignal: null };
  const registry = { plugins: [{ id: 'fixture-research' }] };
  const wrappedFactory = vm.runInNewContext(`${extract(input.toolSource, 'runWithPluginToolScope')}
    ${extract(input.toolSource, 'wrapPluginToolCallbacks')}\nwrapPluginToolCallbacks`, {
    capturePluginLifecycleAuthority: () => () => state.registryActive,
    withPluginRuntimeRegistryScope: (value, run) => registryScope.run(value, run),
    withPluginRuntimePluginScope: (value, run) => pluginScope.run(value, run),
    runWithTrackedCancellation: work.runWithTrackedCancellation, copyPluginToolMeta() {},
  }, { timeout: 1000 });
  const tool = wrappedFactory({ pluginId: 'fixture-research' }, registry, { name: 'research_task_submit',
    async execute(_id, args, signal) {
      state.executions++; state.lastSignal = signal;
      assert.equal(registryScope.getStore(), registry);
      assert.equal(pluginScope.getStore().pluginId, 'fixture-research');
      if (state.body) return state.body(signal, args);
      return { content: [{ type: 'text', text: identityScope.getStore() }] };
    },
  });
  const handler = vm.runInNewContext(`${extract(mcpSource, 'jsonRpcResult')}
    ${extract(mcpSource, 'jsonRpcError')}
    ${extract(mcpSource, 'handleMcpJsonRpc')}\nhandleMcpJsonRpc`, {
    crypto: { randomUUID }, isAutomationsToolName: () => false,
    isRecord: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    readMcpLoopbackToolName: value => value.name,
    runBeforeToolCallHook: async ({ params }) => ({ blocked: false, params }),
    resolveToolResultFailureKind: () => undefined, resolveToolExecutionErrorKind: () => 'failed',
    copyInternalToolResultState: (_value, response) => response,
    normalizeToolCallContent: value => value.content,
    formatToolExecutionErrorMessage: error => error.message,
  }, { timeout: 1000 });
  const server = vm.runInNewContext(`let closeActiveMcpLoopbackServer; let activeMcpLoopbackServerPromise = null;
    ${extract(mcpSource, 'ensureMcpLoopbackServer')}
    ${extract(mcpSource, 'closeMcpLoopbackServer')}
    ({ensure: ensureMcpLoopbackServer, close: closeMcpLoopbackServer})`, {
    runOutsideAsyncWorkScope: work.runOutsideAsyncWorkScope,
    runOutsideGatewayRootWorkAdmission: admission.runOutsideGatewayRootWorkAdmission,
    async startMcpLoopbackServer(port) {
      assert.equal(port, 0);
      state.starts++;
      if (state.starts <= failures) throw new Error('fixture-start-failed');
      // An HTTP listener is an async resource created in the startup continuation.
      // This reproduces its ALS inheritance without binding a socket or starting a service.
      const listener = new AsyncResource('fixture-MCP-listener');
      state.dispatch = run => listener.runInAsyncScope(run);
      if (startGate) await startGate.promise;
      state.active++;
      let closed = false;
      return async () => {
        assert.equal(closed, false, 'Listener closed once'); closed = true;
        state.closes++; state.active--; listener.emitDestroy();
      };
    },
  }, { timeout: 1000 });
  const abortFactory = vm.runInNewContext(`(${extract(mcpSource, 'createRequestAbortSignal')})`, { AbortController }, { timeout: 1000 });
  const request = (actor = 'owner', signal = new AbortController().signal, authorize = () => state.grantCurrent) =>
    state.dispatch(() => identityScope.run(actor, () => handler({
      message: { id: 1, method: 'tools/call', params: { name: tool.name, arguments: {} } },
      toolSchema: [{ name: tool.name }], tools: [tool], signal, authorizeToolCall: authorize,
    })));
  const begin = () => {
    const parent = new work.AsyncWorkScope();
    const root = { released: false };
    const startup = parent.run(() => rootScope.run(root, () => traceScope.run('trace-preserved', () => server.ensure())));
    return { parent, root, startup };
  };
  return { input, patch, work, state, server, request, begin, admissionState, admission, rootScope, traceScope, abortFactory, tool };
}

test('patch rejects missing, non-text and unknown sources without filesystem access', () => {
  for (const value of [null, [], {}, { asyncWorkSource: 'unknown', mcpSource: '', gatewayAdmissionSource: '' }]) {
    assert.throws(() => createRuntimeAsyncWorkPatch(value), { code: 'RUNTIME_ASYNC_WORK_PATCH_SOURCE_MISMATCH' });
  }
});

test('audited patch changes only listener startup and exports, with pinned source and dependency hashes', available, () => {
  const input = readSources(); const patch = createRuntimeAsyncWorkPatch(input);
  assert.equal(patch.status, 'candidate-not-applied'); assert.equal(patch.files.length, 2);
  assert.equal(patch.dependencies[0].sha256, hash(input.gatewayAdmissionSource));
  for (const file of patch.files) { assert.equal(file.afterSha256, hash(file.source)); assert.notEqual(file.beforeSha256, file.afterSha256); }
  const mcp = patch.files[1].source;
  for (const name of ['handleMcpJsonRpc', 'validateMcpLoopbackRequest', 'resolveMcpSender', 'resolveMcpRequestContext', 'createRequestAbortSignal', 'startMcpLoopbackServer', 'closeMcpLoopbackServer']) {
    assert.equal(extract(mcp, name), extract(input.mcpSource, name), `Preserve ${name}`);
  }
  for (const name of ['runWithTrackedCancellation', 'trackAsyncWork', 'captureAsyncWorkTracker', 'getAsyncWorkSignal']) {
    assert.equal(extract(patch.files[0].source, name), extract(input.asyncWorkSource, name), `Preserve ${name}`);
  }
  for (const key of ['asyncWorkSource', 'mcpSource', 'gatewayAdmissionSource']) {
    assert.throws(() => createRuntimeAsyncWorkPatch({ ...input, [key]: `${input[key]}\n` }), { code: 'RUNTIME_ASYNC_WORK_PATCH_SOURCE_MISMATCH' });
  }
  assert.throws(() => createRuntimeAsyncWorkPatch({ ...input, asyncWorkSource: patch.files[0].source, mcpSource: mcp }), { code: 'RUNTIME_ASYNC_WORK_PATCH_SOURCE_MISMATCH' });
});

test('unpatched actual ensure and tool wrapper reproduce success then closed scope across turns', available, async () => {
  const h = harness({ patched: false }); const first = h.begin(); await first.startup;
  assert.equal((await h.request()).result.isError, false);
  await first.parent.drain(); first.root.released = true;
  const failed = await h.request('collaborator');
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, 'Async work scope is closed');
  assert.equal(h.state.executions, 1, 'Second call fails before entering the plugin body');
  assert.equal(h.state.dispatch(() => h.admission.isGatewaySubordinateWorkAdmissionClosed()), true);
  await h.server.close();
});

test('patched listener permits repeated owner/collaborator requests using the same wrapped tool after parent closes', available, async () => {
  const h = harness(); const first = h.begin(); await first.startup;
  assert.equal(h.state.dispatch(() => h.work.getAsyncWorkSignal()), undefined);
  assert.equal(h.state.dispatch(() => h.rootScope.getStore()), undefined);
  assert.equal(h.state.dispatch(() => h.traceScope.getStore()), 'trace-preserved', 'Unrelated ALS is preserved');
  await first.parent.drain(); first.root.released = true;
  for (const actor of ['owner', 'collaborator', 'owner', 'collaborator']) {
    const response = await h.request(actor);
    assert.equal(response.result.isError, false); assert.equal(response.result.content[0].text, actor);
  }
  assert.equal(h.state.starts, 1); assert.equal(h.state.executions, 4);
  assert.equal(h.state.dispatch(() => h.admission.isGatewaySubordinateWorkAdmissionClosed()), false);
  await h.server.close();
});

test('patch preserves closed-scope rejection and global gateway suspension/restart fences', available, async () => {
  const h = harness(); const first = h.begin(); await first.startup; await first.parent.drain();
  assert.throws(() => first.parent.run(() => 'unexpected'), /Async work scope is closed/);
  await assert.rejects(first.parent.track(() => 'unexpected'), /Async work scope is closed/);
  for (const field of ['restartDraining', 'restartSignalPending']) {
    h.admissionState[field] = true;
    assert.equal(h.state.dispatch(() => h.admission.isGatewaySubordinateWorkAdmissionClosed()), true);
    h.admissionState[field] = false;
  }
  h.admissionState.suspendPhase = 'suspended';
  assert.equal(h.state.dispatch(() => h.admission.isGatewaySubordinateWorkAdmissionClosed()), true);
  await h.server.close();
});

test('client disconnect still cancels an in-flight tool and normal completion does not abort', available, async () => {
  const h = harness(); const first = h.begin(); await first.startup; await first.parent.drain();
  const req = new EventEmitter(); req.complete = true; req.destroyed = false;
  const res = new EventEmitter(); res.writableEnded = false;
  const incoming = h.abortFactory(req, res); const entered = deferred();
  h.state.body = signal => new Promise((_resolve, reject) => {
    assert.equal(signal, incoming.signal);
    signal.addEventListener('abort', () => reject(new Error('fixture-client-disconnected')), { once: true });
    entered.resolve();
  });
  const running = h.request('collaborator', incoming.signal); await entered.promise; res.emit('close');
  const response = await running;
  assert.equal(response.result.isError, true); assert.equal(response.result.content[0].text, 'fixture-client-disconnected');
  assert.equal(incoming.signal.aborted, true); incoming.cleanup();
  assert.equal(req.listenerCount('close'), 0); assert.equal(res.listenerCount('close'), 0);
  const done = new EventEmitter(); done.writableEnded = true;
  const complete = h.abortFactory(req, done); req.emit('close'); done.emit('close');
  assert.equal(complete.signal.aborted, false); complete.cleanup();
  await h.server.close();
});

test('concurrent ensure creates one listener, close is idempotent, and later ensure starts one replacement', available, async () => {
  const gate = deferred(); const h = harness({ startGate: gate });
  const first = h.begin(); const second = h.begin();
  assert.equal(h.state.starts, 1); gate.resolve(); await Promise.all([first.startup, second.startup]);
  assert.equal(h.state.active, 1); await h.server.ensure(); assert.equal(h.state.starts, 1);
  await first.parent.drain(); await second.parent.drain();
  await h.server.close(); await h.server.close(); assert.equal(h.state.closes, 1); assert.equal(h.state.active, 0);
  const third = h.begin(); await third.startup; await third.parent.drain();
  assert.equal(h.state.starts, 2); assert.equal(h.state.active, 1);
  assert.equal((await h.request('collaborator')).result.isError, false);
  await h.server.close(); assert.equal(h.state.closes, 2);
});

test('failed startup clears the cached initialization promise and next ensure retries once', available, async () => {
  const h = harness({ failures: 1 }); const first = h.begin();
  await assert.rejects(first.startup, /fixture-start-failed/); await first.parent.drain();
  assert.equal(h.state.active, 0);
  const second = h.begin(); await second.startup; await second.parent.drain();
  assert.equal(h.state.starts, 2); assert.equal(h.state.active, 1);
  assert.equal((await h.request()).result.isError, false); await h.server.close();
});

test('revoked client grant and retired plugin authority still block a cached tool after detachment', available, async () => {
  const h = harness(); const first = h.begin(); await first.startup; await first.parent.drain();
  h.state.grantCurrent = false;
  const revoked = await h.request('collaborator');
  assert.equal(revoked.result.isError, true); assert.equal(revoked.result.content[0].text, 'Tool call authorization expired');
  assert.equal(h.state.executions, 0);
  h.state.grantCurrent = true; h.state.registryActive = false;
  const retired = await h.request('owner');
  assert.equal(retired.result.isError, true); assert.match(retired.result.content[0].text, /tool runtime is no longer active/);
  assert.equal(h.state.executions, 0); await h.server.close();
});

test('unchanged HTTP admission rejects a missing or invalid grant before any request executes', available, () => {
  const { patch } = harness(); const source = patch.files[1].source;
  const validate = vm.runInNewContext(`(${extract(source, 'validateMcpLoopbackRequest')})`, {
    URL, logMcpLoopbackHttp() {}, rejectsBrowserLoopbackRequest: () => false, resolveMcpSender: () => null,
    getHeader: (req, name) => req.headers[name],
  }, { timeout: 1000 });
  let status; let body;
  const result = validate({ req: { url: '/mcp', method: 'POST', headers: { host: '127.0.0.1' } },
    res: { writeHead(value) { status = value; }, end(value) { body = value; } } });
  assert.equal(result, null); assert.equal(status, 401); assert.equal(JSON.parse(body).error, 'unauthorized');
});
