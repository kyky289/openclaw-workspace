import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerResearchBridge, RESPONSE_LIMIT_BYTES } from '../src/register.mjs';

const context = () => ({ agentId: 'main', messageChannel: 'telegram', senderIsOwner: true,
  sessionKey: 'agent:main:telegram:direct:123456', sessionId: 'session-123', nativeChannelId: '123456', requesterSenderId: '123456',
  activeModel: { provider: 'anthropic', modelId: 'claude-example' } });
const input = () => ({ title: 'Example only', question: 'Is evidence sufficient?', sources: [{
  sourceKey: 'report-1', sourceFamily: 'issuer', kind: 'fact', source: 'Synthetic issuer', locator: 'https://example.invalid/report',
  publishedAt: '2026-09-01T00:00:00Z', observedAt: '2026-09-02T00:00:00Z', content: 'Untrusted quoted content',
}], context: { thesis: { id: 'demo', version: '1', locator: 'test/demo' }, skill: { id: 'research-brain', version: '3' },
  strategy: { id: 'paper', version: '1' } }, idempotencyKey: 'submit-1' });
const decoded = result => JSON.parse(result.content[0].text);
const groupTuple = (id = '-100123') => ({ sessionKey: `agent:main:telegram:group:${id}`, nativeChannelId: id, requesterSenderId: '123456' });
function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = context();
  const config = { enabled: true, environment: 'test', stateDirectory: path.join(directory, 'research-bridge-test'),
    allowedContexts: [{ sessionKey: ctx.sessionKey, nativeChannelId: ctx.nativeChannelId, requesterSenderId: ctx.requesterSenderId }], ...options.config };
  const calls = [], closes = [], logs = [];
  let factory, registration, opened = 0;
  const api = { pluginConfig: config, logger: { warn: message => logs.push(message) }, registerTool(fn, opts) { factory = fn; registration = opts; } };
  const createHost = options.createHost ?? (hostOptions => { opened++; calls.push({ hostOptions }); return {
    execute(command, request) { calls.push({ command, request }); return { status: 'candidate', id: 'task-1' }; },
    close() { closes.push(true); },
  }; });
  const outcome = registerResearchBridge(api, { createHost });
  return { directory, config, ctx, calls, closes, logs, outcome, factory, registration,
    get opened() { return opened; }, tool(name = 'research_task_submit', override) { return factory(override ?? ctx).find(item => item.name === name); } };
}

test('default and explicitly disabled plugin register no tools or host state', t => {
  for (const pluginConfig of [undefined, {}, { enabled: false }]) {
    let calls = 0;
    assert.deepEqual(registerResearchBridge({ pluginConfig, registerTool() { calls++; } }, { createHost() { calls++; } }),
      { enabled: false, registered: 0 });
    assert.equal(calls, 0);
  }
});

test('only four optional tools registered, with strict schemas', t => {
  const f = fixture(t);
  assert.deepEqual(f.outcome, { enabled: true, registered: 4 });
  assert.equal(f.registration.optional, true);
  assert.deepEqual(f.registration.names, ['research_task_submit', 'research_task_get', 'research_task_list', 'research_task_propose']);
  for (const tool of f.factory(f.ctx)) assert.equal(tool.parameters.additionalProperties, false);
});

test('missing trusted context fields fail closed, without fallback to tool args', t => {
  const f = fixture(t);
  assert.equal(f.factory(undefined), null);
  for (const key of ['agentId', 'messageChannel', 'senderIsOwner', 'sessionKey', 'sessionId', 'nativeChannelId', 'requesterSenderId']) {
    const ctx = context(); delete ctx[key]; assert.equal(f.factory(ctx), null, key);
  }
  assert.equal(f.opened, 0);
});

test('owner in group routed to main, wrong identities and session prefix collisions are denied', t => {
  const f = fixture(t);
  for (const changed of [{ agentId: 'group-tim' }, { messageChannel: 'discord' }, { senderIsOwner: false },
    { senderIsOwner: 'true' }, { sessionKey: `${f.ctx.sessionKey}0` }, { sessionKey: 'agent:main:telegram:group:-100123' },
    { nativeChannelId: '-100123' }, { nativeChannelId: 'telegram:123456' }, { requesterSenderId: '999' },
    { nativeChannelId: '999', requesterSenderId: '999' }, { sessionId: '' }]) {
    assert.equal(f.factory({ ...f.ctx, ...changed }), null, JSON.stringify(changed));
  }
});

test('invalid policies never register a factory and log only a fixed code', t => {
  const cases = [{ environment: 'live' }, { environment: 'paper' }, { allowedContexts: [] }, { allowedSessionKeys: ['*'] },
    { stateDirectory: '/tmp/memory' }, { stateDirectory: 'research-bridge-test' }, { stateDirectory: '/tmp/../research-bridge-test' },
    { allowedContexts: [{ sessionKey: 'agent:main:*', nativeChannelId: '123456', requesterSenderId: '123456' }] },
    { allowedContexts: [{ sessionKey: 'agent:main:telegram:group:-100123', nativeChannelId: '-100123', requesterSenderId: '123456' }] },
    { allowedContexts: [{ sessionKey: 'agent:main:main', nativeChannelId: '123456', requesterSenderId: '456' }] }];
  for (const config of cases) {
    const f = fixture(t, { config }); assert.equal(f.factory, undefined);
    assert.equal(f.outcome.code, 'INVALID_POLICY');
    assert.deepEqual(f.logs, ['[research-bridge] disabled: INVALID_POLICY']);
  }
});

test('allowed contexts are tuples, never a cross product', t => {
  const f = fixture(t, { config: { allowedContexts: [
    { sessionKey: 'agent:main:telegram:direct:123456', nativeChannelId: '123456', requesterSenderId: '123456' },
    { sessionKey: 'agent:main:telegram:direct:789', nativeChannelId: '789', requesterSenderId: '789' },
  ] } });
  assert.equal(f.factory({ ...f.ctx, nativeChannelId: '789', requesterSenderId: '789' }), null);
});

test('valid call uses fixed scope, hashed actor, synchronous host and closes once', async t => {
  const f = fixture(t), request = input();
  const response = decoded(await f.tool().execute('call-1', request));
  assert.equal(response.ok, true); assert.equal(f.closes.length, 1);
  assert.equal(f.calls[0].hostOptions.directory, f.config.stateDirectory);
  assert.equal(f.calls[0].hostOptions.agentId, 'main'); assert.equal(f.calls[0].hostOptions.environment, 'test');
  assert.equal(f.calls[0].hostOptions.mode, 'agent');
  assert.match(f.calls[0].hostOptions.actorId, /^tg-[a-f0-9]{64}$/);
  assert(!f.calls[0].hostOptions.actorId.includes(f.ctx.requesterSenderId));
  assert.deepEqual(f.calls[1], { command: 'task-submit', request });
  assert.notEqual(f.calls[1].request, request);
  assert.equal(response.automaticTradingAuthorized, false);
});

test('selected model metadata does not attest actual model, usage or spend', async t => {
  const f = fixture(t);
  const response = decoded(await f.tool('research_task_get').execute('get-1', { taskId: 'task-1' }));
  assert.deepEqual(response.provenance, { selectedModelUnverified: { provider: 'anthropic', modelId: 'claude-example' },
    actualModelReceipt: null, usage: null, costUsd: null, verification: 'not-attested-by-bridge' });
  delete f.ctx.activeModel;
  assert.equal(decoded(await f.tool('research_task_list').execute('list', {})).provenance.selectedModelUnverified, null);
});

test('privileged fields are rejected at every nested boundary before opening host', async t => {
  const f = fixture(t);
  for (const key of ['scope', 'agentId', 'environment', 'actorId', 'owner', 'verified', 'modelReceipt', 'costUsd', 'command']) {
    const request = input(); request[key] = 'forged';
    assert.equal(decoded(await f.tool().execute('bad', request)).code, 'INVALID_REQUEST');
  }
  for (const mutate of [x => { x.sources[0].verified = true; }, x => { x.context.thesis.owner = true; },
    x => { x.context.scope = 'live'; }, x => { x.context.skill.verified = true; }]) {
    const request = input(); mutate(request);
    assert.equal(decoded(await f.tool().execute('bad', request)).code, 'INVALID_REQUEST');
  }
  const p = { taskId: 'task-1', idempotencyKey: 'proposal-1', analysis: { kind: 'decision', data: { title: 'x', action: 'buy', reason: 'synthetic', verified: true } } };
  assert.equal(decoded(await f.tool('research_task_propose').execute('bad', p)).code, 'INVALID_REQUEST');
  assert.equal(f.opened, 0);
});

test('invalid inputs including UTF8 byte limit, nonfinite probability and blank values fail before host', async t => {
  const f = fixture(t);
  for (const patch of [{ title: ' ' }, { title: '\0' }, { title: '中'.repeat(400) }, { sources: [] }, { idempotencyKey: '../live' }]) {
    assert.equal(decoded(await f.tool().execute('bad', { ...input(), ...patch })).code, 'INVALID_REQUEST');
  }
  assert.equal(decoded(await f.tool('research_task_list').execute('bad', { offset: NaN })).code, 'INVALID_REQUEST');
  assert.equal(decoded(await f.tool('research_task_list').execute('bad', { limit: 101 })).code, 'INVALID_REQUEST');
  for (const probability of [Infinity, NaN, -0.1, 1.1]) {
    assert.equal(decoded(await f.tool('research_task_propose').execute('bad', { taskId: 'task-1', idempotencyKey: 'prop-1',
      analysis: { kind: 'prediction', data: { title: 'x', probability, dueAt: '2027-01-01T00:00:00Z', resolutionCriterion: 'test only' } } })).code, 'INVALID_REQUEST');
  }
  const request = input(); request.sources = Array.from({ length: 5 }, (_, i) => ({ ...request.sources[0], sourceKey: `src-${i}`, content: 'x'.repeat(16384) }));
  assert.equal(decoded(await f.tool().execute('bad', request)).code, 'INVALID_REQUEST');
  assert.equal(f.opened, 0);
});

test('aborted call never opens state', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  assert.equal(decoded(await f.tool().execute('cancelled', input(), controller.signal)).code, 'ABORTED');
  assert.equal(f.opened, 0);
});

test('host errors and close failures are redacted, cleanup still executes', async t => {
  for (const closeFails of [false, true]) {
    let closed = 0;
    const f = fixture(t, { createHost: () => ({ execute() { throw new Error('SECRET_DO_NOT_EXPOSE'); },
      close() { closed++; if (closeFails) throw new Error('SECOND_SECRET'); } }) });
    const response = await f.tool().execute('error', input());
    assert.equal(closed, 1); assert(!JSON.stringify(response).includes('SECRET'));
    assert.equal(decoded(response).code, closeFails ? 'HOST_CLOSE_FAILED' : 'HOST_OPERATION_FAILED');
  }
});

test('host exception codes are allowlisted instead of reflected verbatim', async t => {
  for (const code of ['NOT_FOUND', 'SECRET_TOKEN_VALUE']) {
    const f = fixture(t, { createHost: () => ({ execute() { throw Object.assign(new Error('private path'), { code }); }, close() {} }) });
    const response = await f.tool('research_task_get').execute('get', { taskId: 'task-1' });
    assert.equal(decoded(response).code, code === 'NOT_FOUND' ? code : 'HOST_OPERATION_FAILED');
    assert(!JSON.stringify(response).includes('private path'));
  }
});

test('response size is bounded after host closes; no partial content is returned', async t => {
  let closed = 0;
  const f = fixture(t, { createHost: () => ({ execute() { return { content: 'x'.repeat(RESPONSE_LIMIT_BYTES) }; }, close() { closed++; } }) });
  const response = await f.tool('research_task_get').execute('huge', { taskId: 'task-1' });
  assert.equal(decoded(response).code, 'RESPONSE_TOO_LARGE'); assert.equal(closed, 1);
  assert(Buffer.byteLength(JSON.stringify(response)) < RESPONSE_LIMIT_BYTES);
});

test('state directory permission changes and symlink replacement fail before opening host', async t => {
  const f = fixture(t); mkdirSync(f.config.stateDirectory, { mode: 0o700 });
  chmodSync(f.config.stateDirectory, 0o755);
  assert.equal(decoded(await f.tool().execute('unsafe', input())).code, 'UNSAFE_STORAGE');
  rmSync(f.config.stateDirectory, { recursive: true }); symlinkSync(f.directory, f.config.stateDirectory);
  assert.equal(decoded(await f.tool().execute('link', input())).code, 'UNSAFE_STORAGE');
  assert.equal(f.opened, 0);
});

test('configuration and context mutations after factory creation cannot elevate scope or forge model receipt', async t => {
  const f = fixture(t), tool = f.tool();
  f.ctx.activeModel.modelId = 'forged'; f.ctx.agentId = 'other'; f.config.environment = 'live';
  const response = decoded(await tool.execute('snapshot', input()));
  assert.equal(f.calls[0].hostOptions.agentId, 'main'); assert.equal(f.calls[0].hostOptions.environment, 'test');
  assert.equal(response.provenance.selectedModelUnverified.modelId, 'claude-example');
  assert.equal(response.provenance.actualModelReceipt, null);
});

test('actual requested command mapping is fixed for each tool', async t => {
  const f = fixture(t);
  const requests = [{ taskId: 'task-1' }, {}, { taskId: 'task-1', idempotencyKey: 'proposal-1',
    analysis: { kind: 'decision', data: { title: 'Example', action: 'research', reason: 'Need evidence' } } }];
  for (let i = 0; i < requests.length; i++) await f.tool(f.registration.names[i + 1]).execute(`call-${i}`, requests[i]);
  assert.deepEqual(f.calls.filter(call => call.command).map(call => call.command), ['task-get', 'task-list', 'task-propose']);
  assert.equal(f.closes.length, 3);
});

test('get detail requests enforce item IDs and forbid source/evidence/proposal/publication ambiguity', async t => {
  const f = fixture(t), tool = f.tool('research_task_get');
  for (const request of [{ taskId: 'task-1', itemId: 'item-1' }, { taskId: 'task-1', detail: 'source' },
    { taskId: 'task-1', detail: 'evidence' }, { taskId: 'task-1', detail: 'proposal' },
    { taskId: 'task-1', detail: 'publication', itemId: 'item-1' }, { taskId: 'task-1', detail: 'raw' },
    { taskId: 'task-1', detail: 'source', itemId: 'item-1', verified: true }]) {
    assert.equal(decoded(await tool.execute('bad', request)).code, 'INVALID_REQUEST');
  }
  assert.equal(f.opened, 0);
  for (const detail of ['source', 'evidence', 'proposal', 'publication']) {
    const request = { taskId: 'task-1', detail, ...(detail === 'publication' ? {} : { itemId: 'item-1' }) };
    assert.equal(decoded(await tool.execute('detail', request)).ok, true);
    assert.deepEqual(f.calls.at(-1), { command: 'task-get', request });
  }
  assert.equal(f.closes.length, 4);
});

test('explicit group owner gets four tools in a stable hashed group scope while private scope stays main', async t => {
  const first = groupTuple(), second = groupTuple('-100456');
  const f = fixture(t, { config: { allowedGroupContexts: [first, second] } });
  for (const tuple of [first, first, second]) {
    const ctx = { ...f.ctx, ...tuple, sessionId: `session-${f.opened}` };
    const tools = f.factory(ctx); assert.equal(tools.length, 4);
    assert.equal(decoded(await tools[0].execute('group-submit', input())).ok, true);
  }
  const scopes = f.calls.filter(call => call.hostOptions).map(call => call.hostOptions.agentId);
  assert.match(scopes[0], /^tg-group-[a-f0-9]{64}$/);
  assert.equal(scopes[0].length, 73); assert.equal(scopes[0], scopes[1]); assert.notEqual(scopes[0], scopes[2]);
  assert(!scopes[0].includes(first.nativeChannelId));
  await f.tool().execute('private-submit', input());
  assert.equal(f.calls.filter(call => call.hostOptions).at(-1).hostOptions.agentId, 'main');
  assert(f.calls.filter(call => call.hostOptions).every(call => call.hostOptions.environment === 'test' && call.hostOptions.mode === 'agent'));
});

test('configured group still denies missing identities, other owners/groups, aliases, topics and threads', t => {
  const tuple = groupTuple(), f = fixture(t, { config: { allowedGroupContexts: [tuple] } });
  const ctx = { ...f.ctx, ...tuple };
  for (const key of ['agentId', 'messageChannel', 'senderIsOwner', 'sessionKey', 'sessionId', 'nativeChannelId', 'requesterSenderId']) {
    const incomplete = { ...ctx }; delete incomplete[key]; assert.equal(f.factory(incomplete), null, key);
  }
  for (const patch of [{ senderIsOwner: false }, { senderIsOwner: 'true' }, { requesterSenderId: '999' },
    groupTuple('-100456'), { nativeChannelId: '-1001230' }, { nativeChannelId: -100123 }, { agentId: 'group-tim' },
    { messageChannel: 'discord' }, { sessionKey: 'agent:main:main' }, { sessionKey: `${tuple.sessionKey}:topic:1` },
    { sessionKey: `${tuple.sessionKey}:thread:1` }, { sessionKey: 'agent:main:telegram:default:group:-100123' },
    { deliveryContext: { threadId: '1' } }, { deliveryContext: { threadId: 1 } }, { deliveryContext: { threadId: '' } }]) {
    assert.equal(f.factory({ ...ctx, ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(f.opened, 0);
});

test('group policy rejects unapproved owners, mismatched IDs, wildcard/session aliases and duplicate tuples', t => {
  const tuple = groupTuple();
  const invalid = [[], null, {}, [tuple, { requesterSenderId: tuple.requesterSenderId, nativeChannelId: tuple.nativeChannelId, sessionKey: tuple.sessionKey }],
    [{ ...tuple, requesterSenderId: '999' }], [{ ...tuple, senderIsOwner: true }],
    [{ ...tuple, nativeChannelId: '-100456' }], [{ ...tuple, nativeChannelId: '-0' }],
    [{ ...tuple, sessionKey: `${tuple.sessionKey}:topic:1` }], [{ ...tuple, sessionKey: 'agent:main:telegram:group:*' }],
    [{ ...tuple, sessionKey: 'agent:main:telegram:channel:-100123' }], [{ ...tuple, nativeChannelId: '123456' }],
    Array.from({ length: 21 }, (_, i) => groupTuple(`-${1000 + i}`))];
  for (const allowedGroupContexts of invalid) {
    const f = fixture(t, { config: { allowedGroupContexts } });
    assert.equal(f.factory, undefined); assert.equal(f.outcome.code, 'INVALID_POLICY');
  }
});

test('group authorization remains exact across multiple owner tuples, never their cross product', t => {
  const first = groupTuple(), second = { ...groupTuple('-100456'), requesterSenderId: '789' };
  const f = fixture(t, { config: { allowedContexts: [
    { sessionKey: 'agent:main:telegram:direct:123456', nativeChannelId: '123456', requesterSenderId: '123456' },
    { sessionKey: 'agent:main:telegram:direct:789', nativeChannelId: '789', requesterSenderId: '789' },
  ], allowedGroupContexts: [first, second] } });
  assert.equal(f.factory({ ...f.ctx, ...first }).length, 4);
  assert.equal(f.factory({ ...f.ctx, ...first, requesterSenderId: '789' }), null);
  assert.equal(f.factory({ ...f.ctx, ...second, requesterSenderId: '123456' }), null);
});

test('group tools snapshot derived scope and reject payload permission fields before host creation', async t => {
  const tuple = groupTuple(), f = fixture(t, { config: { allowedGroupContexts: [tuple] } });
  const ctx = { ...f.ctx, ...tuple }, tool = f.tool('research_task_submit', ctx);
  for (const key of ['scope', 'agentId', 'environment', 'owner', 'nativeChannelId', 'requesterSenderId', 'allowedGroupContexts']) {
    assert.equal(decoded(await tool.execute('forged', { ...input(), [key]: 'main' })).code, 'INVALID_REQUEST');
  }
  assert.equal(f.opened, 0);
  ctx.nativeChannelId = '123456'; ctx.sessionKey = f.ctx.sessionKey;
  f.config.allowedGroupContexts[0].nativeChannelId = '-999';
  assert.equal(decoded(await tool.execute('snapshot', input())).ok, true);
  assert.match(f.calls[0].hostOptions.agentId, /^tg-group-[a-f0-9]{64}$/);
  assert.equal(f.factory({ ...f.ctx, ...groupTuple() }).length, 4, 'Policy is copied at registration.');
});

test('explicit non-owner collaborator shares only the approved group namespace and has distinct actor attribution', async t => {
  const owner = groupTuple(), collaborator = { ...owner, requesterSenderId: '789' };
  const f = fixture(t, { config: { allowedGroupContexts: [owner], allowedGroupCollaboratorContexts: [collaborator] } });
  for (const ctx of [{ ...f.ctx, ...owner }, { ...f.ctx, ...collaborator, senderIsOwner: false }]) {
    const tools = f.factory(ctx); assert.equal(tools.length, 4);
    assert.equal(decoded(await tools[0].execute('submit', input())).ok, true);
  }
  const [ownerHost, collaboratorHost] = f.calls.filter(call => call.hostOptions).map(call => call.hostOptions);
  assert.equal(ownerHost.agentId, collaboratorHost.agentId); assert.match(collaboratorHost.agentId, /^tg-group-[a-f0-9]{64}$/);
  assert.notEqual(ownerHost.actorId, collaboratorHost.actorId);
  assert.equal(collaboratorHost.mode, 'agent'); assert.equal(collaboratorHost.environment, 'test');
  assert(!f.registration.names.some(name => /commit|verify|review|resolve|trade/.test(name)));
  assert.equal(f.factory(f.ctx).length, 4, 'Existing private owner remains authorized.');
});

test('collaborator identity never grants private access, another group, a topic or a fabricated owner flag', t => {
  const owner = groupTuple(), collaborator = { ...owner, requesterSenderId: '789' };
  const f = fixture(t, { config: { allowedGroupContexts: [owner, groupTuple('-100456')], allowedGroupCollaboratorContexts: [collaborator] } });
  const ctx = { ...f.ctx, ...collaborator, senderIsOwner: false };
  for (const key of ['agentId', 'messageChannel', 'senderIsOwner', 'sessionKey', 'sessionId', 'nativeChannelId', 'requesterSenderId']) {
    const incomplete = { ...ctx }; delete incomplete[key]; assert.equal(f.factory(incomplete), null, key);
  }
  for (const patch of [{ senderIsOwner: true }, { senderIsOwner: 'false' }, { senderIsOwner: 0 },
    { requesterSenderId: '999' }, { requesterSenderId: '123456' }, { agentId: 'other' }, { messageChannel: 'discord' },
    { sessionKey: 'agent:main:telegram:group:-100456', nativeChannelId: '-100456' },
    { sessionKey: 'agent:main:main', nativeChannelId: '789' },
    { sessionKey: 'agent:main:telegram:direct:789', nativeChannelId: '789' },
    { sessionKey: `${collaborator.sessionKey}:topic:1` }, { deliveryContext: { threadId: '1' } }]) {
    assert.equal(f.factory({ ...ctx, ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(f.opened, 0);
});

test('collaborator policy requires an existing approved group and separate valid non-owner identities', t => {
  const owner = groupTuple(), collaborator = { ...owner, requesterSenderId: '789' };
  for (const allowedGroupCollaboratorContexts of [[], null, {}, [owner],
    [{ ...collaborator, requesterSenderId: '0' }], [{ ...collaborator, requesterSenderId: 789 }],
    [{ ...collaborator, owner: true }], [{ ...collaborator, nativeChannelId: '-100456' }],
    [{ ...groupTuple('-100456'), requesterSenderId: '789' }],
    [{ ...collaborator, sessionKey: `${collaborator.sessionKey}:topic:1` }],
    [collaborator, { requesterSenderId: '789', nativeChannelId: owner.nativeChannelId, sessionKey: owner.sessionKey }],
    Array.from({ length: 21 }, (_, i) => ({ ...collaborator, requesterSenderId: `${1000 + i}` }))]) {
    const f = fixture(t, { config: { allowedGroupContexts: [owner], allowedGroupCollaboratorContexts } });
    assert.equal(f.factory, undefined); assert.equal(f.outcome.code, 'INVALID_POLICY');
  }
  assert.equal(fixture(t, { config: { allowedGroupCollaboratorContexts: [collaborator] } }).outcome.code, 'INVALID_POLICY');
});

test('collaborator policy and context are snapshotted and tool payload cannot request owner or scope permissions', async t => {
  const owner = groupTuple(), collaborator = { ...owner, requesterSenderId: '789' };
  const f = fixture(t, { config: { allowedGroupContexts: [owner], allowedGroupCollaboratorContexts: [collaborator] } });
  const ctx = { ...f.ctx, ...collaborator, senderIsOwner: false }, tool = f.tool('research_task_submit', ctx);
  for (const key of ['scope', 'agentId', 'owner', 'senderIsOwner', 'allowedGroupCollaboratorContexts', 'verified', 'modelReceipt']) {
    assert.equal(decoded(await tool.execute('forged', { ...input(), [key]: true })).code, 'INVALID_REQUEST');
  }
  assert.equal(f.opened, 0);
  ctx.senderIsOwner = true; ctx.requesterSenderId = '123456';
  f.config.allowedGroupCollaboratorContexts[0].requesterSenderId = '999';
  assert.equal(decoded(await tool.execute('snapshot', input())).ok, true);
  assert.match(f.calls[0].hostOptions.agentId, /^tg-group-[a-f0-9]{64}$/);
  assert.equal(f.factory({ ...f.ctx, ...owner, requesterSenderId: '789', senderIsOwner: false }).length, 4);
  assert.equal(f.factory({ ...f.ctx, ...owner, requesterSenderId: '999', senderIsOwner: false }), null);
});
