import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRuntimeContextPatch } from '../src/runtime-patch.mjs';
import { registerResearchBridge } from '../src/register.mjs';

// Opt-in source inspection only: never import the installed gateway entrypoint,
// initialize its plugin registry, read user config or contact a provider.
const root = process.env.OPENCLAW_RUNTIME_ROOT;
const available = root ? {} : { skip: 'Set OPENCLAW_RUNTIME_ROOT to the installed package directory for read-only compatibility inspection.' };
function readChunk(prefix, extension = '.mjs', marker) {
  const sources = readdirSync(path.join(root, 'dist')).filter(name => name.startsWith(prefix) && name.endsWith(extension))
    .map(name => readFileSync(path.join(root, 'dist', name), 'utf8')).filter(source => !marker || source.includes(marker));
  assert.equal(sources.length, 1, `Expected one ${prefix} implementation chunk; re-audit the changed installation.`);
  return sources[0];
}

test('installed 2026.9.4 declares trusted tool context fields and synchronous factory', available, () => {
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '2026.9.4');
  const sdk = readFileSync(path.join(root, 'dist/agent-harness-runtime-CZb40n5o.d.ts'), 'utf8');
  const context = sdk.slice(sdk.indexOf('type OpenClawPluginToolContext = {'), sdk.indexOf('type OpenClawPluginToolFactory'));
  for (const field of ['agentId', 'sessionKey', 'sessionId', 'messageChannel', 'nativeChannelId', 'requesterSenderId']) {
    assert(context.includes(`${field}?: string;`), field);
  }
  assert(context.includes('senderIsOwner?: boolean;'));
  assert(context.includes('activeModel?: OpenClawPluginActiveModelContext;'));
  assert.match(sdk, /\(ctx: OpenClawPluginToolContext\) => AnyAgentTool \| AnyAgentTool\[\] \| null \| undefined/);
});

test('installed Claude backend opts into grant-bound MCP with layered tool filtering', available, () => {
  const entries = readdirSync(path.join(root, 'dist')).filter(name => /^cli-backend-.*\.mjs$/.test(name));
  const claude = entries.map(name => readFileSync(path.join(root, 'dist', name), 'utf8')).find(text => text.includes('function buildAnthropicCliBackend('));
  assert(claude); assert.match(claude, /bundleMcp: true/); assert.match(claude, /bundleMcpMode: "claude-config-file"/);
  const mcp = readChunk('mcp-http-', '.mjs', 'function resolveMcpRequestContext(req, cfg, auth)');
  assert(mcp.includes('if (auth.boundClientGrant) return structuredClone(auth.boundClientGrant.context);'));
  assert(mcp.includes('resolveGatewayScopedTools({'));
  assert(mcp.includes('applyGrantToolsAllow(scoped.tools, toolsAllow)'));
});

test('known BLOCKER: 2026.9.4 loopback omits both private identity fields so strict bridge stays unavailable', available, () => {
  const runtime = readChunk('tool-resolution-');
  const start = runtime.indexOf('const openClawTools = createOpenClawTools({');
  assert(start > 0);
  const end = runtime.indexOf('\n\t});', start); assert(end > start);
  const argumentsSource = runtime.slice(start, end);
  assert.match(argumentsSource, /agentChannel: params\.messageProvider/);
  assert.match(argumentsSource, /senderIsOwner: params\.senderIsOwner/);
  assert.match(argumentsSource, /sessionId: params\.sessionId/);
  assert(!/\bnativeChannelId\s*:/.test(argumentsSource), 'Context forwarding changed; re-audit before enabling.');
  assert(!/\brequesterSenderId\s*:/.test(argumentsSource), 'Context forwarding changed; re-audit before enabling.');
});

test('real compiled factory-context helper preserves missing identity instead of inferring it from a delivery route', available, () => {
  const source = readChunk('openclaw-tools-', '.mjs', 'function resolveOpenClawPluginToolInputs(params) {');
  const start = source.indexOf('function resolveOpenClawPluginToolInputs(params) {');
  assert(start > 0);
  const end = source.indexOf('\n}', start) + 2;
  const helper = vm.runInNewContext(`(${source.slice(start, end)})`, {
    resolveSessionAgentIds: () => ({ sessionAgentId: 'main' }), resolveAgentWorkspaceDir: () => '/synthetic',
    resolveWorkspaceRoot: value => value, normalizeDeliveryContext: value => value,
    normalizeConversationReadInvocationOrigin: value => value, modelKey: (provider, model) => `${provider}/${model}`,
  }, { timeout: 1000 });
  const value = helper({ options: { agentSessionKey: 'agent:main:main', sessionId: 'test-session',
    agentChannel: 'telegram', currentChannelId: '123456', senderIsOwner: true,
    modelProvider: 'anthropic', modelId: 'selected-only' }, resolvedConfig: {} }).context;
  assert.equal(value.messageChannel, 'telegram'); assert.equal(value.senderIsOwner, true);
  assert.equal(value.nativeChannelId, undefined); assert.equal(value.requesterSenderId, undefined);
  assert.equal(value.activeModel.modelId, 'selected-only');
});

test('native CLI hook model fields describe selection, not an actual native receipt', available, () => {
  const source = readChunk('cli-runner-', '.mjs', 'function buildCliHookAssistantMessage(');
  const start = source.indexOf('if (assistantText.length > 0 && hasLlmOutputHooks)');
  assert(start > 0); const hook = source.slice(start, source.indexOf('\n\t\t}', start));
  assert.match(hook, /provider: params\.provider/); assert.match(hook, /model: context\.modelId/);
  assert.match(source, /isolatedCompletion \|\| controlOperation \? (?:void 0|undefined) : getGlobalHookRunner\(\)/);
  assert(source.includes('model: context.modelId'));
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`); assert(start >= 0, name);
  const end = source.indexOf('\n}', start); assert(end > start, name);
  return source.slice(start, end + 2);
}

function patchedFixture() {
  const grantSource = readChunk('mcp-grant-context-');
  const resolutionSource = readChunk('tool-resolution-');
  const patch = createRuntimeContextPatch({ grantSource, resolutionSource });
  const patchedGrant = patch.files[0].source, patchedResolution = patch.files[1].source;
  const buildGrant = vm.runInNewContext(`(() => {
    ${extractFunction(patchedGrant, 'normalizeOptionalMcpContextValue')}
    ${extractFunction(patchedGrant, 'buildCliMcpChannelContext')}
    ${extractFunction(patchedGrant, 'buildCliMcpGrantContext')}
    return buildCliMcpGrantContext;
  })()`, {
    resolveCliMcpSessionKey: run => run.sessionKey,
    uniqueStrings: values => [...new Set(values)],
    buildCliMcpExecSession: () => undefined, buildCliMcpExecOverrides: () => undefined,
    buildCliMcpBashElevated: () => undefined, resolveGatewayMessageChannel: value => value,
    readCliMcpDelegationCapability: () => undefined,
  }, { timeout: 1000 });
  const prefix = 'const openClawTools = createOpenClawTools(';
  const start = patchedResolution.indexOf(prefix) + prefix.length;
  const end = patchedResolution.indexOf('\n\t});', start) + 3;
  const optionsExpression = patchedResolution.slice(start, end);
  const contextSource = readChunk('openclaw-tools-', '.mjs', 'function resolveOpenClawPluginToolInputs(params) {');
  const buildToolContext = vm.runInNewContext(`(${extractFunction(contextSource, 'resolveOpenClawPluginToolInputs')})`, {
    resolveSessionAgentIds: () => ({ sessionAgentId: 'main' }), resolveAgentWorkspaceDir: () => '/synthetic',
    resolveWorkspaceRoot: value => value, normalizeDeliveryContext: value => value,
    normalizeConversationReadInvocationOrigin: value => value, modelKey: (provider, model) => `${provider}/${model}`,
  }, { timeout: 1000 });
  const toContext = run => {
    const params = buildGrant({ run, config: {}, agentId: 'main', modelProvider: 'anthropic', modelId: 'selection-only' });
    const scope = { params: { ...params, cfg: {} }, sessionAgentId: 'main', gatewayCaller: {}, workspaceDir: '/synthetic',
      sandboxed: false, surface: 'loopback', gatewayRequestedTools: [],
      createChannelQuestionPromptDelivery: value => value, collectExplicitAllowlist: () => [] };
    for (const name of ['sourceReplyDeliveryMode', 'profilePolicy', 'providerProfilePolicy', 'globalPolicy', 'globalProviderPolicy',
      'agentPolicy', 'agentProviderPolicy', 'groupPolicy', 'senderPolicy', 'sandboxPolicy', 'subagentPolicy', 'inheritedToolPolicy',
      'explicitDenylist', 'cronCreatorToolAllowlist', 'inheritedToolAllowlist', 'inheritedToolDenylist']) scope[name] = undefined;
    const options = vm.runInNewContext(`(${optionsExpression})`, scope, { timeout: 1000 });
    return buildToolContext({ options, resolvedConfig: {} }).context;
  };
  let factory;
  registerResearchBridge({ pluginConfig: { enabled: true, environment: 'test', stateDirectory: '/tmp/review-fixture/research-bridge-test',
    allowedContexts: [{ sessionKey: 'agent:main:main', nativeChannelId: '123456', requesterSenderId: '123456' }] },
  registerTool(value) { factory = value; } }, { createHost() { throw new Error('TEST_MUST_NOT_OPEN_HOST'); } });
  const run = { sessionKey: 'agent:main:main', sessionId: 'fixture-session', messageChannel: 'telegram',
    senderIsOwner: true, senderId: '123456', chatId: '123456' };
  return { patch, grantSource, resolutionSource, buildGrant, toContext, factory, run };
}

test('UNAPPLIED candidate executes actual grant and options expressions, enabling only a synthetic private context', available, () => {
  const f = patchedFixture(), ctx = f.toContext(f.run);
  assert.equal(ctx.nativeChannelId, '123456'); assert.equal(ctx.requesterSenderId, '123456');
  assert.equal(ctx.messageChannel, 'telegram'); assert.equal(ctx.sessionKey, 'agent:main:main');
  assert.equal(f.factory(ctx).length, 4);
  assert.equal(f.patch.status, 'candidate-not-applied'); assert.equal(f.patch.compatibleRuntimeVerified, false);
  for (const file of f.patch.files) {
    assert.match(file.beforeSha256, /^[a-f0-9]{64}$/); assert.match(file.afterSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(file.beforeSha256, file.afterSha256);
  }
});

test('UNAPPLIED candidate remains denied for missing IDs, group owner and mismatched configured route', available, () => {
  const f = patchedFixture();
  for (const changed of [{ chatId: undefined }, { senderId: undefined }, { chatId: '-100123' },
    { senderId: '999', chatId: '999' }, { sessionKey: 'agent:main:telegram:group:-100123' }, { senderIsOwner: false }]) {
    assert.equal(f.factory(f.toContext({ ...f.run, ...changed })), null, JSON.stringify(changed));
  }
});

test('UNAPPLIED candidate preserves explicit channel context and fails closed on conflicting trusted fields', available, () => {
  const f = patchedFixture();
  const explicit = { sender: { id: '123456' }, chat: { id: '123456' } };
  const ctx = f.toContext({ ...f.run, senderId: undefined, chatId: undefined, channelContext: explicit });
  assert.equal(ctx.nativeChannelId, '123456'); assert.equal(ctx.requesterSenderId, '123456');
  assert.equal(f.factory(ctx).length, 4);
  for (const channelContext of [{ ...explicit, chat: { id: '999' } }, { ...explicit, sender: { id: '999' } }]) {
    assert.throws(() => f.toContext({ ...f.run, channelContext }), /MCP_CHANNEL_CONTEXT_CONFLICT/);
  }
});

test('patch generator rejects duplicate/changed anchors and repeated application without writing files', available, () => {
  const f = patchedFixture();
  assert.throws(() => createRuntimeContextPatch({ grantSource: f.patch.files[0].source, resolutionSource: f.patch.files[1].source }), /ANCHOR_MISMATCH/);
  assert.throws(() => createRuntimeContextPatch({ grantSource: `${f.grantSource}\n${f.grantSource}`, resolutionSource: f.resolutionSource }), /ANCHOR_MISMATCH/);
  assert.throws(() => createRuntimeContextPatch({ grantSource: f.grantSource, resolutionSource: f.resolutionSource.replace('const openClawTools = createOpenClawTools({', 'changed(') }), /ANCHOR_MISMATCH/);
  assert.equal(readChunk('mcp-grant-context-'), f.grantSource);
  assert.equal(readChunk('tool-resolution-'), f.resolutionSource);
});
