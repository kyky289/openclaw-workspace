import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installedRoot = process.env.OPENCLAW_RUNTIME_ROOT;
const available = installedRoot ? {} : { skip: 'Set OPENCLAW_RUNTIME_ROOT to test the actual installed manifest/startup/registry contracts.' };
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const ID = 'openclaw-research-bridge';
const NAMES = ['research_task_submit', 'research_task_get', 'research_task_list', 'research_task_propose'];
let nativePromise;

function native() {
  return nativePromise ??= (async () => {
    const pkg = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '2026.9.4', 'Internal native contracts are pinned to the audited installation.');
    const load = filename => import(pathToFileURL(path.join(installedRoot, 'dist', filename)).href);
    const [manifest, startup, planner, registry] = await Promise.all([
      load('manifest-BRq2TbZH.mjs'), load('installed-plugin-index-scope-lookup-hT11eO5V.mjs'),
      load('activation-planner-wNf6GBCo.mjs'), load('loader-runtime-load-DpX1CRjH.mjs')
    ]);
    // Only the installed public SDK needs resolution. Do not invoke the gateway
    // loader, read user config, activate a registry or construct a live runtime.
    const aliases = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'openclaw/plugin-sdk/core') return { shortCircuit: true,
        url: pathToFileURL(path.join(installedRoot, pkg.exports['./plugin-sdk/core'].default)).href };
      return nextResolve(specifier, context);
    } });
    let entry;
    try { entry = (await import(pathToFileURL(path.join(pluginRoot, 'index.mjs')).href)).default; }
    finally { aliases.deregister(); }
    assert.equal(entry.id, ID);
    return { loadManifest: manifest.r, startup: startup.b, plan: planner.t, createRegistry: registry.q, entry };
  })();
}

function temporary(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-native-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function loadCandidate(api) {
  const result = api.loadManifest(pluginRoot);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, ID);
  return result.manifest;
}

function startupSelected(api, manifest) {
  return api.startup({ manifest, plugin: { pluginId: ID, startup: { memory: false } },
    contextEngineSlotStartupPluginId: undefined, memorySlotStartupPluginId: undefined,
    startupDreamingPluginIds: new Set() });
}

function plan(api, manifest) {
  return api.plan({ config: { plugins: { entries: { [ID]: { enabled: true } } } },
    trigger: { kind: 'capability', capability: 'tool' },
    manifestRecords: [{ ...manifest, origin: 'config' }] });
}

function register(api, manifest, pluginConfig) {
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(name => [name, () => {}]));
  const runtime = new Proxy({}, { get() { throw new Error('Unexpected host runtime capability access during registration.'); } });
  const builder = api.createRegistry({ runtime, logger, coreGatewayMethodNames: [], activateGlobalSideEffects: false });
  const record = { id: ID, name: manifest.name, version: manifest.version, source: path.join(pluginRoot, 'index.mjs'),
    rootDir: pluginRoot, origin: 'config', enabled: true, status: 'loaded', contracts: manifest.contracts, toolNames: [], services: [] };
  api.entry.register(builder.createApi(record, { config: {}, pluginConfig }));
  return { registry: builder.registry, record };
}

function enabledPolicy(root) {
  return { enabled: true, environment: 'test', stateDirectory: path.join(root, 'research-bridge-test'),
    allowedContexts: [{ sessionKey: 'agent:main:main', nativeChannelId: '123456', requesterSenderId: '123456' }] };
}

test('native manifest parser and startup/tool planning reproduce old omission and select the repaired manifest', available, async t => {
  const api = await native();
  const candidate = loadCandidate(api);
  assert.equal(candidate.activation.onStartup, true);
  assert.deepEqual(candidate.contracts.tools, NAMES);
  assert.equal(startupSelected(api, candidate), true);
  assert.deepEqual(plan(api, candidate).pluginIds, [ID]);
  assert.deepEqual(plan(api, candidate).entries[0].reasons, ['manifest-tool-contract']);

  const old = JSON.parse(readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
  delete old.activation; delete old.contracts;
  const oldRoot = temporary(t);
  writeFileSync(path.join(oldRoot, 'openclaw.plugin.json'), JSON.stringify(old));
  const previous = api.loadManifest(oldRoot);
  assert.equal(previous.ok, true, 'An accepted manifest alone does not establish runtime eligibility.');
  assert.equal(startupSelected(api, previous.manifest), false);
  assert.deepEqual(plan(api, previous.manifest).pluginIds, []);
});

test('actual entry and native registry accept exactly four optional tools without startup work', available, async t => {
  const api = await native();
  const candidate = loadCandidate(api);
  const config = enabledPolicy(temporary(t));
  const { registry, record } = register(api, candidate, config);
  assert.deepEqual(registry.diagnostics, []);
  assert.deepEqual(record.toolNames, NAMES);
  assert.deepEqual(record.services, ['research-execution-receipts']);
  assert.equal(registry.services.length, 1);
  assert.equal(registry.tools.length, 1, 'The entry registers one factory owning four declared tools.');
  const registration = registry.tools[0];
  assert.deepEqual(registration.names, NAMES);
  assert.deepEqual(registration.declaredNames, NAMES);
  assert.equal(registration.optional, true);
  assert.equal(registration.factory({}), null);
  const context = { agentId: 'main', messageChannel: 'telegram', senderIsOwner: true, sessionId: 'native-registry-fixture',
    ...config.allowedContexts[0] };
  assert.deepEqual(registration.factory(context).map(tool => tool.name), NAMES);
  assert.equal(registration.factory({ ...context, nativeChannelId: '-100123456' }), null);
  assert.equal(registration.factory({ ...context, requesterSenderId: undefined }), null);
  const group = { sessionKey: 'agent:main:telegram:group:-100123', nativeChannelId: '-100123', requesterSenderId: '123456' };
  const groupRegistry = register(api, candidate, { ...config, allowedGroupContexts: [group] }).registry;
  assert.deepEqual(groupRegistry.diagnostics, []);
  const groupFactory = groupRegistry.tools[0].factory;
  assert.deepEqual(groupFactory({ ...context, ...group }).map(tool => tool.name), NAMES);
  assert.equal(groupFactory({ ...context, ...group, senderIsOwner: false }), null);
  assert.equal(groupFactory({ ...context, ...group, requesterSenderId: '999' }), null);
  assert.equal(groupFactory({ ...context, ...group, sessionKey: `${group.sessionKey}:topic:1` }), null);
  assert.equal(groupFactory({ ...context, ...group, deliveryContext: { threadId: '1' } }), null);
  assert.equal(existsSync(config.stateDirectory), false, 'Registration and tool construction must not create a database.');
  for (const [name, value] of Object.entries(registry)) {
    if (!['tools', 'services'].includes(name) && Array.isArray(value)) assert.equal(value.length, 0, `Unexpected startup registration: ${name}`);
  }
  assert.deepEqual(register(api, candidate, {}).registry.tools, [], 'The plugin remains disabled by default.');
  assert.deepEqual(register(api, candidate, {}).registry.services, [], 'Disabled plugins do not register an observer.');
});

test('native registry rejects missing and incomplete contracts even when the actual entry attempts registration', available, async t => {
  const api = await native();
  const candidate = loadCandidate(api);
  const config = enabledPolicy(temporary(t));
  const previous = register(api, { ...candidate, contracts: undefined }, config);
  assert.deepEqual(previous.registry.tools, []);
  assert.deepEqual(previous.record.toolNames, []);
  assert.equal(previous.registry.diagnostics.length, 1);
  assert.equal(previous.registry.diagnostics[0].level, 'error');
  assert.equal(previous.registry.diagnostics[0].message, 'plugin must declare contracts.tools before registering agent tools');
  const incomplete = register(api, { ...candidate, contracts: { tools: NAMES.slice(0, 3) } }, config);
  assert.deepEqual(incomplete.registry.tools, []);
  assert.equal(incomplete.registry.diagnostics[0].message, 'plugin must declare contracts.tools for: research_task_propose');
  assert.equal(existsSync(config.stateDirectory), false);
});

test('native registry tools let an explicit false-owner collaborator submit and share group candidates with distinct actors', available, async t => {
  const api = await native(), candidate = loadCandidate(api), config = enabledPolicy(temporary(t));
  const group = { sessionKey: 'agent:main:telegram:group:-100123', nativeChannelId: '-100123', requesterSenderId: '123456' };
  const collaborator = { ...group, requesterSenderId: '789' };
  const { registry } = register(api, candidate, { ...config, allowedGroupContexts: [group], allowedGroupCollaboratorContexts: [collaborator] });
  assert.deepEqual(registry.diagnostics, []);
  const factory = registry.tools[0].factory;
  const base = { agentId: 'main', messageChannel: 'telegram', sessionId: 'same-session' };
  const ownerTools = factory({ ...base, ...group, senderIsOwner: true });
  const collaboratorTools = factory({ ...base, ...collaborator, senderIsOwner: false });
  assert.deepEqual(collaboratorTools.map(tool => tool.name), NAMES);
  assert.equal(factory({ ...base, ...collaborator }), null);
  assert.equal(factory({ ...base, ...collaborator, senderIsOwner: true }), null);
  assert.equal(factory({ ...base, ...collaborator, senderIsOwner: false, deliveryContext: { threadId: '1' } }), null);
  const invoke = async (tools, name, request) => {
    const response = JSON.parse((await tools.find(tool => tool.name === `research_task_${name}`).execute('synthetic', request)).content[0].text);
    assert.equal(response.ok, true, response.code); assert.equal(response.automaticTradingAuthorized, false);
    assert.equal(response.provenance.actualModelReceipt, null); return response.result;
  };
  const request = { title: 'Native collaborator fixture', question: 'Share fictional group research only', idempotencyKey: 'owner-submit',
    sources: [{ sourceKey: 'fiction', sourceFamily: 'example', kind: 'fact', source: 'Synthetic source', locator: 'https://example.invalid',
      publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-02T00:00:00Z', content: 'Unverified synthetic data' }],
    context: { thesis: { id: 'fixture', version: '1', locator: 'test/fixture' }, skill: { id: 'research-brain', version: '3' },
      strategy: { id: 'test', version: '1' } } };
  const ownerTask = await invoke(ownerTools, 'submit', request);
  assert.equal((await invoke(collaboratorTools, 'get', { taskId: ownerTask.id })).id, ownerTask.id);
  const collaboratorTask = await invoke(collaboratorTools, 'submit', { ...request, idempotencyKey: 'collaborator-submit' });
  assert.deepEqual(ownerTask.scope, collaboratorTask.scope); assert.notEqual(ownerTask.submittedBy, collaboratorTask.submittedBy);
  const proposal = await invoke(collaboratorTools, 'propose', { taskId: ownerTask.id, idempotencyKey: 'collaborator-proposal',
    analysis: { kind: 'decision', data: { title: 'Candidate', action: 'research', reason: 'Synthetic only' } } });
  assert.equal(proposal.proposedBy, collaboratorTask.submittedBy); assert.equal(proposal.status, 'candidate');
  const readByOwner = await invoke(ownerTools, 'get', { taskId: ownerTask.id });
  assert.deepEqual(readByOwner.proposals, [proposal]); assert.equal(readByOwner.publication, null);
});
