import { createHash } from 'node:crypto';
import { createExecutionBindings } from './execution-bindings.mjs';
import { createExecutionReceipts } from './execution-receipts.mjs';

export function executionCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(executionCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${executionCanonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const executionDigest = value => createHash('sha256').update(executionCanonical(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Internal host capability. Never exposed as an agent execute command. */
export function createHostExecutions({ directory, agentId, environment, actorId, getTask }) {
  const scope = Object.freeze({ agentId, environment }), context = Object.freeze({ actorId });
  let bindings, receipts, closed = false;
  function stores() {
    if (closed) fail('HOST_CLOSED');
    bindings ??= createExecutionBindings({ directory, ...scope });
    receipts ??= createExecutionReceipts({ directory, ...scope,
      authorizeWrite: (_request, ctx) => ctx === context ? { actorId } : null,
      resolveTarget: ({ taskId, proposalId }) => {
        const task = getTask(taskId);
        if (proposalId !== null && !task.proposals.some(item => item.id === proposalId)) fail('NOT_FOUND');
        return { scope, taskId: task.id, proposalId };
      },
    });
    return { bindings, receipts };
  }
  function target(binding) {
    const task = getTask(binding.taskId);
    const item = binding.proposalId === null ? task : task.proposals.find(p => p.id === binding.proposalId);
    if (!item || (binding.proposalId === null ? item.submittedBy : item.proposedBy) !== binding.actorId
      || item.createdAt !== binding.createdAt) fail('EXECUTION_TARGET_MISMATCH');
    return item;
  }
  function capture({ toolName, input, result, runtime, startedAt }) {
    if (!['research_task_submit', 'research_task_propose'].includes(toolName)) fail('EXECUTION_TOOL_INVALID');
    const proposalId = toolName === 'research_task_propose' ? result.id : null;
    const taskId = proposalId === null ? result.id : result.taskId;
    const existing = stores().bindings.find({ taskId, toolName, proposalId });
    if (existing) return existing;
    // An idempotent replay of an old artifact is not evidence of its original authoring model.
    if (!Number.isFinite(Date.parse(startedAt)) || Date.parse(result.createdAt) < Date.parse(startedAt)) {
      return { status: 'unavailable', reasonCode: 'HISTORICAL_EXECUTION_NOT_CAPTURED' };
    }
    const binding = { toolName, taskId, proposalId, actorId, createdAt: result.createdAt,
      sessionKey: runtime.sessionKey, sessionId: runtime.sessionId, nativeSessionId: runtime.nativeSessionId ?? null,
      requestedModel: runtime.requestedModel ?? null, requestSha256: executionDigest(input), resultSha256: executionDigest(result) };
    target(binding);
    return stores().bindings.capture(binding);
  }
  function record({ bindingId, observation }) {
    const { bindings, receipts } = stores();
    const binding = bindings.get({ id: bindingId });
    if (!binding || !binding.nativeSessionId) fail('EXECUTION_BINDING_REQUIRED');
    target(binding);
    if (observation.correlation.nativeSessionSha256 !== createHash('sha256').update(binding.nativeSessionId).digest('hex')
      || observation.correlation.requestSha256 !== binding.requestSha256
      || observation.correlation.resultSha256 !== binding.resultSha256
      || observation.correlation.toolName !== binding.toolName
      || executionCanonical(observation.requestedModel) !== executionCanonical(binding.requestedModel)) fail('EXECUTION_BINDING_MISMATCH');
    const executionId = `xe-${executionDigest([scope, binding.id, observation.correlation.toolCallSha256])}`;
    const current = receipts.get({ executionId });
    const value = current && executionCanonical(current.observation) === executionCanonical(observation) ? current
      : receipts.append({ executionId, taskId: binding.taskId, proposalId: binding.proposalId,
        expectedVersion: current?.version ?? 0, idempotencyKey: `xr-${executionDigest([executionId, observation])}`, observation }, context);
    bindings.updateStatus({ id: binding.id, status: 'observed', reasonCode: null, observedAt: new Date().toISOString() });
    return value;
  }
  function summary(taskId) {
    getTask(taskId); // Authenticate the task within this host's fixed scope before any lookup.
    const { receipts, bindings } = stores();
    // The workflow permits 20 candidates plus the task's original submission.
    const page = receipts.list({ taskId, limit: 21, offset: 0 });
    const pending = bindings.list({ taskId, pendingOnly: true, limit: 1, offset: 0 });
    return { status: pending.total ? 'pending' : page.total ? 'recorded' : 'not-recorded',
      verification: 'host-observed-not-provider-signed', pending: pending.total, total: page.total,
      returned: page.receipts.length, receipts: page.receipts,
      usageAttribution: 'Shared message/run accounting keys must be deduplicated; these are not per-task totals.',
      detailRetrieval: { detail: 'execution', itemId: 'executionId' } };
  }
  function detail(taskId, executionId) {
    getTask(taskId);
    const record = stores().receipts.get({ executionId });
    if (!record || record.taskId !== taskId) fail('NOT_FOUND');
    return record;
  }
  return Object.freeze({ capture, record, summary, detail,
    pending: options => stores().bindings.list(options),
    pin: request => stores().bindings.bindNativeSession(request),
    mark: request => stores().bindings.updateStatus(request),
    close() {
      if (closed) return; closed = true;
      let error;
      for (const handle of [receipts, bindings]) try { handle?.close(); } catch (e) { error ??= e; }
      if (error) throw error;
    },
  });
}
