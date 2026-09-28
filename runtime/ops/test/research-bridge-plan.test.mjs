import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareResearchBridgePlan, previewResearchBridgePlan, RESEARCH_BRIDGE_PLUGIN_ID as pluginId,
  RESEARCH_BRIDGE_TOOL_NAMES as toolNames } from '../research-bridge-plan.mjs';
import { TOOL_DEFINITIONS } from '../../openclaw-research-bridge/src/schema.mjs';

const fixtureOptions = () => ({ pluginPath: '/srv/plugins/openclaw-research-bridge', stateDirectory: '/srv/private/research-bridge-test',
  allowedContexts: [{ sessionKey: 'agent:main:main', nativeChannelId: '12345', requesterSenderId: '12345' }] });
const source = () => ({
  models: { providers: { anthropic: { apiKey: 'SENSITIVE_MODEL_FIXTURE' } } },
  agents: { ownership: 'explicit', defaults: { model: 'anthropic/claude-opus-5', workspace: '/private/default' },
    entries: { main: { workspace: '/private/main', tools: {}, model: 'anthropic/claude-opus-5', skills: ['research-brain'] },
      'group-tim': { workspace: '/private/group', model: 'anthropic/claude-sonnet-5', tools: { deny: ['exec'] }, skills: ['governance'] } } },
  plugins: { load: { paths: ['/srv/plugins/telegram-active-window'] }, entries: { 'telegram-active-window': { enabled: true } } },
  tools: { profile: 'coding', exec: { host: 'sandbox' } },
  bindings: [{ agentId: 'main', match: { channel: 'telegram', accountId: '*' } }],
  gateway: { auth: { token: 'SENSITIVE_GATEWAY_FIXTURE' } },
  channels: { telegram: { botToken: 'SENSITIVE_TELEGRAM_FIXTURE', allowFrom: ['12345'] } },
});
const errorCode = (code) => (error) => error.code === code;

test('minimal plan changes only plugin loading/config and four main tool grants', () => {
  const before = source(); const original = structuredClone(before);
  const plan = prepareResearchBridgePlan(before, fixtureOptions());
  const after = previewResearchBridgePlan(before, plan);
  assert.equal(plan.status, 'pending-approval'); assert.equal(plan.requiresApproval, true);
  assert.deepEqual(plan.toolNames, TOOL_DEFINITIONS.map((item) => item.name));
  assert.equal(JSON.stringify(plan).includes('SENSITIVE_'), false);
  assert.deepEqual(before, original);
  assert.deepEqual(after.models, original.models); assert.deepEqual(after.gateway, original.gateway);
  assert.deepEqual(after.channels, original.channels); assert.deepEqual(after.bindings, original.bindings);
  assert.deepEqual(after.agents.defaults, original.agents.defaults);
  assert.deepEqual(after.agents.entries['group-tim'], original.agents.entries['group-tim']);
  assert.deepEqual(after.tools, original.tools); assert.equal(after.agents.entries.main.model, original.agents.entries.main.model);
  assert.deepEqual(after.agents.entries.main.skills, original.agents.entries.main.skills);
  assert.deepEqual(after.agents.entries.main.tools.alsoAllow, [...toolNames]);
  assert.equal(after.plugins.allow, undefined, 'no global plugin allowlist is introduced');
  assert.equal(after.plugins.entries[pluginId].config.environment, 'test');
  assert.deepEqual(after.plugins.load.paths, ['/srv/plugins/telegram-active-window', fixtureOptions().pluginPath]);
  assert.deepEqual(plan.patch.map((patch) => patch.path), ['/plugins/load/paths/-', `/plugins/entries/${pluginId}`, '/agents/entries/main/tools/alsoAllow']);
});

test('already-configured replay is empty but does not assert runtime readiness', () => {
  const first = prepareResearchBridgePlan(source(), fixtureOptions());
  const candidate = previewResearchBridgePlan(source(), first);
  const repeated = prepareResearchBridgePlan(candidate, fixtureOptions());
  assert.equal(repeated.status, 'already-configured'); assert.equal(repeated.requiresApproval, false);
  assert.deepEqual(repeated.patch, []); assert.deepEqual(previewResearchBridgePlan(candidate, repeated), candidate);
  assert.equal(repeated.runtimeReadiness.productionReady, false);
  assert.ok(repeated.runtimeReadiness.requiredFactoryContext.includes('nativeChannelId'));
  assert.ok(repeated.runtimeReadiness.requiredFactoryContext.includes('requesterSenderId'));
});

test('existing main allowlist gets additions without alsoAllow or permission removal', () => {
  const config = source(); config.agents.entries.main.tools = { allow: ['read', 'research_task_get'], deny: ['browser'] };
  const candidate = previewResearchBridgePlan(config, prepareResearchBridgePlan(config, fixtureOptions()));
  assert.deepEqual(candidate.agents.entries.main.tools.allow, ['read', 'research_task_get', 'research_task_submit', 'research_task_list', 'research_task_propose']);
  assert.equal(candidate.agents.entries.main.tools.alsoAllow, undefined);
  assert.deepEqual(candidate.agents.entries.main.tools.deny, ['browser']);
});

test('existing alsoAllow and plugin allowlist are appended without replacing entries', () => {
  const config = source(); config.plugins.allow = ['telegram-active-window'];
  config.agents.entries.main.tools.alsoAllow = ['read', 'research_task_get'];
  const plan = prepareResearchBridgePlan(config, fixtureOptions()); const candidate = previewResearchBridgePlan(config, plan);
  assert.deepEqual(candidate.plugins.allow, ['telegram-active-window', pluginId]);
  assert.deepEqual(candidate.agents.entries.main.tools.alsoAllow, ['read', 'research_task_get', 'research_task_submit', 'research_task_list', 'research_task_propose']);
  assert.ok(plan.patch.some((item) => item.path === '/plugins/allow/-'));
});

test('missing plugin/tool containers are created minimally', () => {
  const config = source(); delete config.plugins; delete config.agents.entries.main.tools;
  const candidate = previewResearchBridgePlan(config, prepareResearchBridgePlan(config, fixtureOptions()));
  assert.deepEqual(candidate.plugins.load.paths, [fixtureOptions().pluginPath]);
  assert.deepEqual(candidate.agents.entries.main.tools, { alsoAllow: [...toolNames] });
  assert.deepEqual(candidate.tools, config.tools);
});

test('plugin deny exact or wildcard conflict is never relaxed', () => {
  for (const deny of [[pluginId], ['*'], ['openclaw-research-*']]) {
    const config = source(); config.plugins.deny = deny;
    assert.throws(() => prepareResearchBridgePlan(config, fixtureOptions()), errorCode('PLUGIN_DENY_CONFLICT'));
    assert.deepEqual(config.plugins.deny, deny);
  }
  const unrelated = source(); unrelated.plugins.deny = ['other-plugin'];
  assert.deepEqual(previewResearchBridgePlan(unrelated, prepareResearchBridgePlan(unrelated, fixtureOptions())).plugins.deny, ['other-plugin']);
});

test('global and main tool denies including groups and wildcards block the plan', () => {
  for (const deny of [['research_task_get'], ['research_*'], ['*'], [pluginId], ['group:plugins'], [`group:${pluginId}`]]) {
    for (const location of ['global', 'main', 'provider']) {
      const config = source();
      if (location === 'global') config.tools.deny = deny;
      else if (location === 'main') config.agents.entries.main.tools.deny = deny;
      else config.tools.byProvider = { anthropic: { deny } };
      assert.throws(() => prepareResearchBridgePlan(config, fixtureOptions()), errorCode('TOOL_DENY_CONFLICT'));
    }
  }
});

test('allow and alsoAllow cannot coexist in a scope and global allow is not widened', () => {
  for (const location of ['global', 'main']) {
    const config = source(); const tools = location === 'global' ? config.tools : config.agents.entries.main.tools;
    tools.allow = []; tools.alsoAllow = [];
    assert.throws(() => prepareResearchBridgePlan(config, fixtureOptions()), errorCode('TOOL_ALLOW_POLICY_CONFLICT'));
  }
  const restrictive = source(); restrictive.tools.allow = ['read'];
  assert.throws(() => prepareResearchBridgePlan(restrictive, fixtureOptions()), errorCode('GLOBAL_TOOL_ALLOW_CONFLICT'));
  const covered = source(); covered.tools.allow = ['read', 'research_task_*'];
  const after = previewResearchBridgePlan(covered, prepareResearchBridgePlan(covered, fixtureOptions()));
  assert.deepEqual(after.tools, covered.tools);
});

test('provider-specific restrictive allowlists are rejected without widening their policy', () => {
  for (const location of ['global', 'main']) {
    const config = source(); const tools = location === 'global' ? config.tools : config.agents.entries.main.tools;
    tools.byProvider = { anthropic: { allow: ['read'] } };
    assert.throws(() => prepareResearchBridgePlan(config, fixtureOptions()), errorCode('PROVIDER_TOOL_ALLOW_CONFLICT'));
    assert.deepEqual(tools.byProvider.anthropic.allow, ['read']);
    tools.byProvider.anthropic.allow.push('research_task_*');
    const after = previewResearchBridgePlan(config, prepareResearchBridgePlan(config, fixtureOptions()));
    assert.deepEqual(after.tools, config.tools);
    assert.deepEqual(after.agents.entries.main.tools.byProvider, config.agents.entries.main.tools.byProvider);
  }
});

test('existing differing plugin entry or partial loading is a conflict', () => {
  const differing = source(); differing.plugins.entries[pluginId] = { enabled: false };
  assert.throws(() => prepareResearchBridgePlan(differing, fixtureOptions()), errorCode('PLUGIN_ENTRY_CONFLICT'));
  const pathOnly = source(); pathOnly.plugins.load.paths.push(fixtureOptions().pluginPath);
  assert.throws(() => prepareResearchBridgePlan(pathOnly, fixtureOptions()), errorCode('PARTIAL_PLUGIN_CONFIGURATION'));
  const configured = previewResearchBridgePlan(source(), prepareResearchBridgePlan(source(), fixtureOptions()));
  configured.plugins.load.paths.pop();
  assert.throws(() => prepareResearchBridgePlan(configured, fixtureOptions()), errorCode('PARTIAL_PLUGIN_CONFIGURATION'));
});

test('same-name, duplicate, relative, alias and overlapping plugin paths require review', () => {
  for (const paths of [
    ['/other/openclaw-research-bridge'], ['/srv/plugins'], ['/srv/plugins/openclaw-research-bridge/subdir'],
    ['/srv/plugins/./openclaw-research-bridge'], ['./openclaw-research-bridge'],
    ['/srv/plugins/telegram-active-window', '/srv/plugins/telegram-active-window'],
  ]) {
    const config = source(); config.plugins.load.paths = paths;
    assert.throws(() => prepareResearchBridgePlan(config, fixtureOptions()), errorCode('PLUGIN_PATH_CONFLICT'));
  }
});

test('state path is dedicated and cannot reuse memory/skills/workspace or plugin trees', () => {
  for (const stateDirectory of ['/srv/private/other-state', '/srv/memory/research-bridge-test', '/srv/skills/research-bridge-test',
    '/srv/Memory/research-bridge-test', '/srv/stable-skills/research-bridge-test', '/srv/workshop-skills/research-bridge-test',
    '/srv/private/../private/research-bridge-test', '/srv/private/research-bridge-test/', 'relative/research-bridge-test',
    '/srv/plugins/openclaw-research-bridge/research-bridge-test']) {
    assert.throws(() => prepareResearchBridgePlan(source(), { ...fixtureOptions(), stateDirectory }), errorCode('PLAN_PATH_INVALID'));
  }
  const config = source(); config.agents.entries.main.workspace = fixtureOptions().stateDirectory;
  assert.throws(() => prepareResearchBridgePlan(config, fixtureOptions()), errorCode('STATE_WORKSPACE_CONFLICT'));
  const inherited = source(); delete inherited.agents.entries.main.workspace;
  for (const workspace of [fixtureOptions().stateDirectory, `${fixtureOptions().stateDirectory}/nested-workspace`]) {
    inherited.agents.defaults.workspace = workspace;
    assert.throws(() => prepareResearchBridgePlan(inherited, fixtureOptions()), errorCode('STATE_WORKSPACE_CONFLICT'));
  }
});

test('only exact main Telegram private context triples with positive equal chat/sender IDs pass', () => {
  for (const sessionKey of ['agent:main:main', 'agent:main:telegram:direct:12345', 'agent:main:telegram:dm:12345', 'agent:main:telegram:default:direct:12345']) {
    const options = fixtureOptions(); options.allowedContexts[0].sessionKey = sessionKey;
    assert.equal(prepareResearchBridgePlan(source(), options).target.allowedContexts[0].sessionKey, sessionKey);
  }
  for (const change of [
    { sessionKey: 'agent:group-tim:main' }, { sessionKey: 'agent:main:telegram:group:12345' },
    { sessionKey: 'agent:main:telegram:direct:12345:topic:1' }, { sessionKey: 'agent:main:telegram:direct:67890' },
    { sessionKey: 'agent:main:telegram:group:direct:12345' }, { sessionKey: 'agent:main:telegram:CRON:direct:12345' },
    { sessionKey: 'agent:main:cron:job' }, { sessionKey: 'agent:main:*' }, { sessionKey: 'agent:main:discord:direct:12345' },
    { sessionKey: ' agent:main:main' }, { requesterSenderId: '67890' }, { nativeChannelId: '-12345', requesterSenderId: '-12345' },
    { nativeChannelId: 12345 }, { nativeChannelId: '012345', requesterSenderId: '012345' }, { isOwner: true },
  ]) {
    const options = fixtureOptions(); Object.assign(options.allowedContexts[0], change);
    assert.throws(() => prepareResearchBridgePlan(source(), options), errorCode('CONTEXT_INVALID'));
  }
  const duplicate = fixtureOptions(); duplicate.allowedContexts.push({ ...duplicate.allowedContexts[0] });
  assert.throws(() => prepareResearchBridgePlan(source(), duplicate), errorCode('CONTEXT_INVALID'));
});

test('plan tampering cannot alter models, credentials, targets, approval flags or readiness', () => {
  const config = source(); const original = prepareResearchBridgePlan(config, fixtureOptions());
  const mutate = [
    (plan) => plan.patch.push({ op: 'add', path: '/models/provider', value: 'other' }),
    (plan) => { plan.patch[0].value = '/unreviewed'; },
    (plan) => { plan.requiresApproval = false; },
    (plan) => { plan.target.agentId = 'group-tim'; },
    (plan) => { plan.target.environment = 'live'; },
    (plan) => { plan.runtimeReadiness.productionReady = true; },
    (plan) => { plan.planSha256 = '0'.repeat(64); },
    (plan) => { plan.sourceSha256 = '0'.repeat(64); },
    (plan) => { plan.extra = true; },
  ];
  for (const change of mutate) { const plan = structuredClone(original); change(plan); assert.throws(() => previewResearchBridgePlan(config, plan)); }
});

test('source digests detect drift anywhere including unrelated credentials without printing them', () => {
  const config = source(); const options = { ...fixtureOptions(), sourceSha256: 'a'.repeat(64) };
  const plan = prepareResearchBridgePlan(config, options);
  assert.equal(plan.sourceSha256, options.sourceSha256); assert.match(plan.sourceConfigSha256, /^[a-f0-9]{64}$/);
  config.gateway.auth.token = 'CHANGED_SENSITIVE_FIXTURE';
  assert.throws(() => previewResearchBridgePlan(config, plan), errorCode('PLAN_MISMATCH'));
  assert.equal(JSON.stringify(plan).includes('SENSITIVE'), false);
  assert.throws(() => prepareResearchBridgePlan(source(), { ...options, sourceSha256: 'not-a-digest' }), errorCode('SOURCE_DIGEST_INVALID'));
});

test('missing main, malformed source and accessors fail without inspecting dynamic values', () => {
  const noMain = source(); delete noMain.agents.entries.main;
  assert.throws(() => prepareResearchBridgePlan(noMain, fixtureOptions()), errorCode('MAIN_AGENT_REQUIRED'));
  const list = source(); list.agents.list = [{ id: 'main' }];
  assert.throws(() => prepareResearchBridgePlan(list, fixtureOptions()), errorCode('MAIN_AGENT_REQUIRED'));
  let accessed = false; const getter = source();
  Object.defineProperty(getter, 'secret', { enumerable: true, get() { accessed = true; return 'private'; } });
  assert.throws(() => prepareResearchBridgePlan(getter, fixtureOptions()), errorCode('CONFIG_INVALID')); assert.equal(accessed, false);
  const options = fixtureOptions(); Object.defineProperty(options, 'pluginPath', { enumerable: true, get() { accessed = true; return '/untrusted'; } });
  assert.throws(() => prepareResearchBridgePlan(source(), options), errorCode('PLAN_INPUT_INVALID')); assert.equal(accessed, false);
  const hidden = source(); Object.defineProperty(hidden, 'agents', { enumerable: false, get() { accessed = true; return {}; } });
  assert.throws(() => prepareResearchBridgePlan(hidden, fixtureOptions()), errorCode('CONFIG_INVALID')); assert.equal(accessed, false);
  const plan = {}; Object.defineProperty(plan, 'target', { enumerable: true, get() { accessed = true; return {}; } });
  assert.throws(() => previewResearchBridgePlan(source(), plan), errorCode('CONFIG_INVALID')); assert.equal(accessed, false);
});
