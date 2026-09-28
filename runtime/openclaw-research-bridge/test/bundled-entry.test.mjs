import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installedRoot = process.env.OPENCLAW_RUNTIME_ROOT;
const available = installedRoot ? {} : { skip: 'Set OPENCLAW_RUNTIME_ROOT to use the actual installed SDK with the packaged entry and lib.' };
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));

test('real installed SDK + actual default entry + bundled lib persist synthetic submit/get without gateway startup', available, async t => {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'build-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'local-core-bundle');
  assert.equal(manifest.installed, false); assert.equal(manifest.activated, false);
  assert(manifest.files.some(file => file.path === 'lib/host.mjs'));
  for (const file of manifest.files) {
    assert.match(file.path, /^lib\/[a-z][a-z0-9-]*\.mjs$/);
    const content = readFileSync(path.join(pluginRoot, file.path));
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, file.path);
    assert(!content.toString('utf8').includes('research-core/src'), 'Bundle must not reach back into development source.');
  }
  const runtimePackage = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(runtimePackage.version, '2026.9.4');
  const sdkExport = runtimePackage.exports['./plugin-sdk/core'].default;
  assert.equal(sdkExport, './dist/plugin-sdk/core.js');
  const sdkUrl = pathToFileURL(path.join(installedRoot, sdkExport)).href;

  // The production loader installs its own native SDK aliases. This temporary
  // test-only alias resolves the same public SDK without importing that loader,
  // creating a gateway, changing NODE_PATH, installing dependencies or symlinks.
  let sdkResolutions = 0;
  const aliases = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'openclaw/plugin-sdk/core') {
      sdkResolutions++;
      return { shortCircuit: true, url: sdkUrl };
    }
    return nextResolve(specifier, context);
  } });
  let entry;
  try { entry = (await import(pathToFileURL(path.join(pluginRoot, 'index.mjs')).href)).default; }
  finally { aliases.deregister(); }
  assert(sdkResolutions >= 1, 'Entry must resolve the real installed SDK.');
  assert.equal(entry.id, 'openclaw-research-bridge'); assert.equal(typeof entry.register, 'function');

  let disabledRegistrations = 0;
  entry.register({ pluginConfig: {}, registerTool() { disabledRegistrations++; } });
  assert.equal(disabledRegistrations, 0);

  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'research-bridge-test');
  const context = { agentId: 'main', messageChannel: 'telegram', senderIsOwner: true,
    sessionKey: 'agent:main:main', sessionId: 'bundled-entry-fixture', nativeChannelId: '123456', requesterSenderId: '123456',
    activeModel: { provider: 'anthropic', modelId: 'synthetic-selection-unverified' } };
  const group = { sessionKey: 'agent:main:telegram:group:-100123', nativeChannelId: '-100123', requesterSenderId: '123456' };
  const collaborator = { ...group, requesterSenderId: '789' };
  let factory, options;
  entry.register({ pluginConfig: { enabled: true, environment: 'test', stateDirectory: directory,
    allowedContexts: [{ sessionKey: context.sessionKey, nativeChannelId: context.nativeChannelId, requesterSenderId: context.requesterSenderId }],
    allowedGroupContexts: [group], allowedGroupCollaboratorContexts: [collaborator] },
  registerTool(fn, registeredOptions) { assert.equal(factory, undefined); factory = fn; options = registeredOptions; } });
  assert.equal(typeof factory, 'function'); assert.equal(options.optional, true);
  assert.deepEqual(options.names, ['research_task_submit', 'research_task_get', 'research_task_list', 'research_task_propose']);
  assert.equal(factory({ ...context, nativeChannelId: undefined }), null);
  assert.equal(factory({ ...context, nativeChannelId: '-100123' }), null);
  const tools = factory(context); assert.equal(tools.length, 4);
  const invoke = async (name, request, scopedTools = tools) => {
    const result = await scopedTools.find(tool => tool.name === name).execute('synthetic-call', request);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true, envelope.code);
    assert.equal(envelope.provenance.actualModelReceipt, null); assert.equal(envelope.automaticTradingAuthorized, false);
    return envelope.result;
  };
  const request = { title: 'Packaged entry fixture', question: 'Persist fictional source without verifying it', idempotencyKey: 'entry-submit-1',
    sources: [{ sourceKey: 'fiction', sourceFamily: 'example', kind: 'fact', source: 'Synthetic source', locator: 'https://example.invalid/fixture',
      publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-02T00:00:00Z', content: 'This fixture is not market evidence.' }],
    context: { thesis: { id: 'fiction', version: '1', locator: 'test/fiction' }, skill: { id: 'research-brain', version: '3' },
      strategy: { id: 'test', version: '1' } } };
  const submitted = await invoke('research_task_submit', request);
  assert.equal(submitted.status, 'needs-review'); assert.equal(submitted.evidence[0].verification.status, 'pending');
  const retrieved = await invoke('research_task_get', { taskId: submitted.id });
  assert.equal(retrieved.id, submitted.id); assert.equal(retrieved.sources[0].content, request.sources[0].content);
  assert.equal(retrieved.publication, null); assert.equal(retrieved.modelReceipt, null);
  const groupTools = factory({ ...context, ...group });
  assert.equal(groupTools.length, 4);
  assert.equal(factory({ ...context, ...group, senderIsOwner: false }), null);
  const groupSubmitted = await invoke('research_task_submit', request, groupTools);
  assert.notEqual(groupSubmitted.id, submitted.id);
  assert.equal(submitted.scope.agentId, 'main');
  assert.match(groupSubmitted.scope.agentId, /^tg-group-[a-f0-9]{64}$/);
  const groupRetrieved = await invoke('research_task_get', { taskId: groupSubmitted.id }, groupTools);
  assert.equal(groupRetrieved.id, groupSubmitted.id); assert.equal(groupRetrieved.publication, null);
  const collaboratorTools = factory({ ...context, ...collaborator, senderIsOwner: false });
  assert.equal(collaboratorTools.length, 4);
  assert.equal(factory({ ...context, ...collaborator, senderIsOwner: true }), null);
  assert.equal((await invoke('research_task_get', { taskId: groupSubmitted.id }, collaboratorTools)).id, groupSubmitted.id);
  const collaboratorTask = await invoke('research_task_submit', { ...request, idempotencyKey: 'collaborator-submit' }, collaboratorTools);
  assert.deepEqual(collaboratorTask.scope, groupSubmitted.scope); assert.notEqual(collaboratorTask.submittedBy, groupSubmitted.submittedBy);
  const collaboratorProposal = await invoke('research_task_propose', { taskId: groupSubmitted.id, idempotencyKey: 'collaborator-proposal',
    analysis: { kind: 'decision', data: { title: 'Synthetic candidate', action: 'research', reason: 'No verification or trading' } } }, collaboratorTools);
  assert.equal(collaboratorProposal.proposedBy, collaboratorTask.submittedBy); assert.equal(collaboratorProposal.status, 'candidate');
  const ownerView = await invoke('research_task_get', { taskId: groupSubmitted.id }, groupTools);
  assert.deepEqual(ownerView.proposals, [collaboratorProposal]); assert.equal(ownerView.publication, null);
  for (const [scopedTools, foreignTask] of [[groupTools, submitted.id], [tools, groupSubmitted.id]]) {
    const result = await scopedTools.find(tool => tool.name === 'research_task_get').execute('synthetic-cross-scope', { taskId: foreignTask });
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, code: 'NOT_FOUND', automaticTradingAuthorized: false });
  }
  assert.equal((await invoke('research_task_list', {}, tools)).total, 1);
  assert.equal((await invoke('research_task_list', {}, groupTools)).total, 2);
  const privateDenied = await collaboratorTools.find(tool => tool.name === 'research_task_get').execute('private-denied', { taskId: submitted.id });
  assert.equal(JSON.parse(privateDenied.content[0].text).code, 'NOT_FOUND');
  assert(readdirSync(path.join(directory, 'main', 'test')).some(name => name.endsWith('.sqlite')));
  if (process.platform === 'linux') {
    const retained = readdirSync('/proc/self/fd').some(fd => {
      try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${directory}/`); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    assert.equal(retained, false, 'Every packaged host database handle must be closed after each call.');
  }
});
