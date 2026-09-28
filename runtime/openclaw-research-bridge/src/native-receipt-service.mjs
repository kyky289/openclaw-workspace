import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { lstatSync } from 'node:fs';
import { readNativeExecutionSource, resolveNativeExecutionSession } from './native-execution-source.mjs';
import { collectNativeExecution } from './native-execution-receipts.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const failureCode = outcome => outcome?.reasonCodes?.some(code => /AMBIGUOUS/.test(code))
  ? 'NATIVE_BINDING_AMBIGUOUS' : outcome?.status === 'pending' ? 'PENDING_NATIVE_RESULT' : 'NATIVE_RECORD_INVALID';

/** An in-process observer in the existing gateway; no sockets, models or outbound requests. */
export function createNativeReceiptService({ config, scopes, createHost, logger,
  homeDirectory = homedir(), readSource = readNativeExecutionSource, resolveSession = resolveNativeExecutionSession,
  collect = collectNativeExecution, intervalMs = 30_000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (config?.enabled !== true || config.environment !== 'test' || typeof createHost !== 'function'
    || !Array.isArray(scopes) || scopes.length < 1 || scopes.length > 21
    || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300_000) fail('INVALID_POLICY');
  const options = Object.freeze({ homeDirectory, stateDirectory: dirname(config.stateDirectory),
    workspaceDirectory: join(dirname(config.stateDirectory), 'workspace') });
  const allowed = new Set(scopes.map(scope => scope.agentId));
  const cursors = new Map();
  let timer = null, nextScope = 0, sweeping = false;
  const warn = () => logger?.warn?.('[research-bridge] native execution observation unavailable; research candidates remain unapproved');
  function existingBindings(agentId) {
    try {
      const stat = lstatSync(join(config.stateDirectory, agentId, 'test', 'execution-bindings.sqlite'));
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  function reconcileScope(agentId, { taskId, limit = 8 } = {}) {
    if (!allowed.has(agentId)) fail('UNAUTHORIZED');
    if (!existingBindings(agentId)) return { processed: 0, observed: 0, pending: 0 };
    let host;
    try {
      host = createHost({ directory: config.stateDirectory, agentId, environment: 'test', actorId: 'native-execution-observer', mode: 'agent' });
      const offset = taskId ? 0 : cursors.get(agentId) ?? 0;
      let page = host.executions.pending({ ...(taskId ? { taskId } : {}), pendingOnly: true, limit, offset });
      if (!page.bindings.length && page.total && offset) page = host.executions.pending({ pendingOnly: true, limit, offset: 0 });
      let observed = 0;
      const cache = new Map();
      for (let binding of page.bindings) {
        try {
          const key = JSON.stringify([binding.sessionKey, binding.sessionId, binding.nativeSessionId, binding.createdAt]);
          let source = cache.get(key);
          if (!source) {
            source = readSource({ ...options, binding });
            // Bound retained raw source data to two precise sessions per sweep.
            if (cache.size >= 2) cache.delete(cache.keys().next().value);
            cache.set(key, source);
          }
          if (source.status === 'ready' && binding.nativeSessionId === null) {
            host.executions.pin({ id: binding.id, nativeSessionId: source.nativeSessionId });
            binding = { ...binding, nativeSessionId: source.nativeSessionId };
          }
          const outcome = source.status === 'ready' ? collect({ binding, source }) : source;
          if (outcome.status === 'observed') {
            host.executions.record({ bindingId: binding.id, observation: outcome.observation }); observed++;
          } else {
            const reasonCode = failureCode(outcome);
            host.executions.mark({ id: binding.id, status: reasonCode === 'PENDING_NATIVE_RESULT' ? 'pending' : 'unavailable',
              reasonCode, observedAt: new Date().toISOString() });
          }
        } catch {
          host.executions.mark({ id: binding.id, status: 'unavailable', reasonCode: 'NATIVE_COLLECTION_FAILED', observedAt: new Date().toISOString() });
        }
      }
      const remaining = host.executions.pending({ ...(taskId ? { taskId } : {}), pendingOnly: true, limit: 1, offset: 0 }).total;
      if (!taskId) cursors.set(agentId, remaining ? ((page.offset ?? 0) + page.bindings.length - observed) % remaining : 0);
      return { processed: page.bindings.length, observed, pending: remaining };
    } finally { host?.close(); }
  }
  function sweep() {
    if (sweeping) return;
    sweeping = true;
    try { const scope = scopes[nextScope++ % scopes.length]; return reconcileScope(scope.agentId); }
    catch { warn(); }
    finally { sweeping = false; }
  }
  function capture({ host, authorized, ctx, toolName, input, value, startedAt }) {
    if (!allowed.has(authorized.agentId)) fail('UNAUTHORIZED');
    const binding = { sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, nativeSessionId: null, createdAt: value.createdAt };
    let nativeSessionId = null;
    try {
      const resolved = resolveSession({ ...options, binding });
      if (resolved.status === 'ready') nativeSessionId = resolved.nativeSessionId;
    } catch { /* Missing native state is pending, never permission to guess an identity. */ }
    const recorded = host.executions.capture({ toolName, input, result: value, startedAt,
      runtime: { ...binding, nativeSessionId, requestedModel: authorized.selectedModelUnverified
        ? { provider: authorized.selectedModelUnverified.provider, id: authorized.selectedModelUnverified.modelId } : null } });
    return { status: recorded.status, ...(recorded.reasonCode ? { reasonCode: recorded.reasonCode } : {}) };
  }
  return Object.freeze({ capture, reconcileScope, sweep,
    service: Object.freeze({ id: 'research-execution-receipts',
      start() { if (timer !== null) return; timer = setTimer(sweep, intervalMs); timer?.unref?.(); sweep(); },
      stop() { if (timer !== null) clearTimer(timer); timer = null; },
    }),
  });
}
