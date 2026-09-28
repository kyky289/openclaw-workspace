import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { BridgeError, TOOL_DEFINITIONS, validateRequest } from './schema.mjs';

export const RESPONSE_LIMIT_BYTES = 512 * 1024;
const positiveId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const groupId = value => typeof value === 'string' && /^-[1-9][0-9]{0,19}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\0*?]/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasOnly = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const fail = code => { throw new BridgeError(code); };
const groupScopeId = sessionKey => `tg-group-${createHash('sha256').update(JSON.stringify(['research-bridge-group-v1', sessionKey,
  sessionKey.slice('agent:main:telegram:group:'.length)])).digest('hex')}`;
const SAFE_CODES = new Set(['INVALID_REQUEST', 'UNAUTHORIZED', 'INVALID_POLICY', 'UNSAFE_STORAGE', 'ABORTED',
  'HOST_OPERATION_FAILED', 'HOST_CLOSE_FAILED', 'RESPONSE_TOO_LARGE', 'VALIDATION', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT',
  'STORAGE_BUSY', 'STORAGE_FAILURE', 'STORAGE_REPLACED', 'CORRUPT_STORE', 'WORKFLOW_INTERRUPTED']);

function checkDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')
    || path.normalize(directory) !== directory || directory.split(path.sep).includes('..')
    || path.basename(directory) !== 'research-bridge-test') fail('INVALID_POLICY');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    let entry;
    try { entry = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return; fail('UNSAFE_STORAGE'); }
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail('UNSAFE_STORAGE');
    if (current === directory && ((entry.mode & 0o777) !== 0o700 || (process.getuid && entry.uid !== process.getuid()))) fail('UNSAFE_STORAGE');
  }
}

/** Validate trusted host configuration; only inspects existing directory metadata. */
export function validateBridgePolicy(config = {}) {
  if (!hasOnly(config, ['enabled', 'environment', 'stateDirectory', 'allowedContexts', 'allowedGroupContexts', 'allowedGroupCollaboratorContexts'])) fail('INVALID_POLICY');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') fail('INVALID_POLICY');
  if (config.enabled !== true) return Object.freeze({ enabled: false });
  if (config.environment !== 'test' || !Array.isArray(config.allowedContexts)
    || config.allowedContexts.length < 1 || config.allowedContexts.length > 20) fail('INVALID_POLICY');
  checkDirectory(config.stateDirectory);
  const allowedContexts = config.allowedContexts.map(item => {
    if (!hasOnly(item, ['sessionKey', 'nativeChannelId', 'requesterSenderId']) || Object.keys(item).length !== 3
      || !text(item.sessionKey) || !/^agent:main:/.test(item.sessionKey)
      || /(^|:)(group|channel|topic|thread|subagent|cron)(:|$)/.test(item.sessionKey)
      || !positiveId(item.nativeChannelId) || item.nativeChannelId !== item.requesterSenderId) fail('INVALID_POLICY');
    return Object.freeze({ sessionKey: item.sessionKey, nativeChannelId: item.nativeChannelId, requesterSenderId: item.requesterSenderId });
  });
  if (new Set(allowedContexts.map(item => JSON.stringify(item))).size !== allowedContexts.length) fail('INVALID_POLICY');
  const groupContexts = config.allowedGroupContexts ?? [];
  if (!Array.isArray(groupContexts) || groupContexts.length > 20
    || (config.allowedGroupContexts !== undefined && groupContexts.length === 0)) fail('INVALID_POLICY');
  const allowedGroupContexts = groupContexts.map(item => {
    if (!hasOnly(item, ['sessionKey', 'nativeChannelId', 'requesterSenderId']) || Object.keys(item).length !== 3
      || !groupId(item.nativeChannelId) || !positiveId(item.requesterSenderId)
      || item.sessionKey !== `agent:main:telegram:group:${item.nativeChannelId}`
      || !allowedContexts.some(owner => owner.requesterSenderId === item.requesterSenderId)) fail('INVALID_POLICY');
    return Object.freeze({ sessionKey: item.sessionKey, nativeChannelId: item.nativeChannelId, requesterSenderId: item.requesterSenderId });
  });
  if (new Set(allowedGroupContexts.map(item => JSON.stringify(item))).size !== allowedGroupContexts.length) fail('INVALID_POLICY');
  const collaboratorContexts = config.allowedGroupCollaboratorContexts ?? [];
  if (!Array.isArray(collaboratorContexts) || collaboratorContexts.length > 20
    || (config.allowedGroupCollaboratorContexts !== undefined && collaboratorContexts.length === 0)) fail('INVALID_POLICY');
  const allowedGroupCollaboratorContexts = collaboratorContexts.map(item => {
    if (!hasOnly(item, ['sessionKey', 'nativeChannelId', 'requesterSenderId']) || Object.keys(item).length !== 3
      || !groupId(item.nativeChannelId) || !positiveId(item.requesterSenderId)
      || item.sessionKey !== `agent:main:telegram:group:${item.nativeChannelId}`
      || allowedContexts.some(owner => owner.requesterSenderId === item.requesterSenderId)
      || !allowedGroupContexts.some(group => group.sessionKey === item.sessionKey && group.nativeChannelId === item.nativeChannelId)) fail('INVALID_POLICY');
    return Object.freeze({ sessionKey: item.sessionKey, nativeChannelId: item.nativeChannelId, requesterSenderId: item.requesterSenderId });
  });
  if (new Set(allowedGroupCollaboratorContexts.map(item => JSON.stringify(item))).size !== allowedGroupCollaboratorContexts.length) fail('INVALID_POLICY');
  return Object.freeze({ enabled: true, environment: 'test', stateDirectory: config.stateDirectory,
    allowedContexts: Object.freeze(allowedContexts), allowedGroupContexts: Object.freeze(allowedGroupContexts),
    allowedGroupCollaboratorContexts: Object.freeze(allowedGroupCollaboratorContexts) });
}

function authorizedContext(ctx, config) {
  if (!ctx || ctx.agentId !== 'main' || ctx.messageChannel !== 'telegram' || typeof ctx.senderIsOwner !== 'boolean'
    || !text(ctx.sessionKey) || !text(ctx.sessionId) || !positiveId(ctx.requesterSenderId)) return null;
  const matches = item => item.sessionKey === ctx.sessionKey
    && item.nativeChannelId === ctx.nativeChannelId && item.requesterSenderId === ctx.requesterSenderId;
  const privateAllowed = ctx.senderIsOwner === true && positiveId(ctx.nativeChannelId) && ctx.nativeChannelId === ctx.requesterSenderId
    && config.allowedContexts.some(matches);
  const groupAllowed = groupId(ctx.nativeChannelId)
    && (ctx.senderIsOwner === true ? config.allowedGroupContexts.some(matches) : config.allowedGroupCollaboratorContexts.some(matches))
    && ctx.deliveryContext?.threadId == null;
  if (!privateAllowed && !groupAllowed) return null;
  const agentId = groupAllowed
    ? groupScopeId(ctx.sessionKey)
    : 'main';
  const actorId = `tg-${createHash('sha256').update(JSON.stringify(['research-bridge-v1', ctx.requesterSenderId, ctx.sessionId])).digest('hex')}`;
  let selectedModelUnverified = null;
  if (ctx.activeModel && ['provider', 'modelId'].every(key => typeof ctx.activeModel[key] === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(ctx.activeModel[key]))) {
    selectedModelUnverified = Object.freeze({ provider: ctx.activeModel.provider, modelId: ctx.activeModel.modelId });
  }
  return Object.freeze({ agentId, actorId, selectedModelUnverified });
}

function result(envelope, isError = false) {
  const serialized = JSON.stringify(envelope);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > RESPONSE_LIMIT_BYTES - 256) fail('RESPONSE_TOO_LARGE');
  return { content: [{ type: 'text', text: serialized }], details: { ok: !isError }, ...(isError ? { isError: true } : {}) };
}
function errorResult(error) {
  const code = SAFE_CODES.has(error?.code) ? error.code : 'HOST_OPERATION_FAILED';
  return result({ ok: false, code, automaticTradingAuthorized: false }, true);
}

/** SDK-free adapter; the host factory is an injected capability, never a tool arg. */
export function registerResearchBridge(api, { createHost, createNativeObserver } = {}) {
  let config;
  try {
    config = validateBridgePolicy(api?.pluginConfig);
    if (!config.enabled) return { enabled: false, registered: 0 };
    if (typeof createHost !== 'function' || typeof api?.registerTool !== 'function') fail('INVALID_POLICY');
  } catch {
    api?.logger?.warn?.('[research-bridge] disabled: INVALID_POLICY');
    return { enabled: false, registered: 0, code: 'INVALID_POLICY' };
  }
  const observer = typeof createNativeObserver === 'function' ? createNativeObserver({ config, createHost, logger: api.logger,
    scopes: [...new Set(['main', ...config.allowedGroupContexts.map(item => groupScopeId(item.sessionKey))])]
      .map(agentId => ({ agentId, environment: 'test' })) }) : null;
  if (observer && typeof api.registerService === 'function') api.registerService(observer.service);
  api.registerTool(ctx => {
    const authorized = authorizedContext(ctx, config);
    if (!authorized) return null;
    const receiptContext = Object.freeze({ sessionKey: ctx.sessionKey, sessionId: ctx.sessionId });
    return TOOL_DEFINITIONS.map(definition => ({
      name: definition.name, label: definition.label, description: definition.description,
      parameters: JSON.parse(JSON.stringify(definition.parameters)),
      async execute(_toolCallId, request, signal) {
        let host;
        try {
          if (signal?.aborted) fail('ABORTED');
          const input = validateRequest(definition.parameters, request);
          if (observer && definition.command === 'task-get') {
            try { observer.reconcileScope(authorized.agentId, { taskId: input.taskId }); }
            catch { api.logger?.warn?.('[research-bridge] execution receipt reconciliation unavailable'); }
          }
          checkDirectory(config.stateDirectory);
          host = createHost({ directory: config.stateDirectory, agentId: authorized.agentId, environment: 'test', actorId: authorized.actorId, mode: 'agent' });
          if (!host || typeof host.execute !== 'function' || typeof host.close !== 'function' || typeof host.then === 'function') fail('HOST_OPERATION_FAILED');
          let value, observation;
          try {
            const startedAt = new Date().toISOString();
            value = host.execute(definition.command, input);
            if (value && typeof value.then === 'function') fail('HOST_OPERATION_FAILED');
            if (observer && ['task-submit', 'task-propose'].includes(definition.command)) {
              try { observation = observer.capture({ host, authorized, ctx: receiptContext, toolName: definition.name, input, value, startedAt }); }
              catch {
                observation = { status: 'unavailable', reasonCode: 'EXECUTION_CAPTURE_FAILED' };
                api.logger?.warn?.('[research-bridge] candidate saved; execution receipt capture unavailable');
              }
            }
          } finally {
            const closing = host; host = null;
            try { closing.close(); } catch { fail('HOST_CLOSE_FAILED'); }
          }
          return result({ ok: true, result: value, provenance: {
            selectedModelUnverified: authorized.selectedModelUnverified,
            actualModelReceipt: null, usage: null, costUsd: null, verification: 'not-attested-by-bridge',
            ...(observer ? { executionEvidence: { status: observation?.status ?? 'see-task-get',
              ...(observation?.reasonCode ? { reasonCode: observation.reasonCode } : {}),
              verification: 'host-observed-not-provider-signed' } } : {}),
          }, automaticTradingAuthorized: false });
        } catch (error) {
          try { host?.close?.(); } catch { return errorResult(new BridgeError('HOST_CLOSE_FAILED')); }
          return errorResult(error);
        }
      },
    }));
  }, { names: TOOL_DEFINITIONS.map(item => item.name), optional: true });
  return { enabled: true, registered: TOOL_DEFINITIONS.length };
}
