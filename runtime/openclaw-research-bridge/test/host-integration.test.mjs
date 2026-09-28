import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchHost } from '../lib/host.mjs';
import { createResearchHost as createBundledResearchHost } from '../lib/host.mjs';
import { registerResearchBridge } from '../src/register.mjs';

test('real local host durably submits, gets, lists and proposes, without verifying or committing', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = { agentId: 'main', messageChannel: 'telegram', senderIsOwner: true, sessionKey: 'agent:main:main',
    sessionId: 'fixture-session', nativeChannelId: '123456', requesterSenderId: '123456' };
  let factory;
  registerResearchBridge({ pluginConfig: { enabled: true, environment: 'test', stateDirectory: path.join(root, 'research-bridge-test'),
    allowedContexts: [{ sessionKey: ctx.sessionKey, nativeChannelId: ctx.nativeChannelId, requesterSenderId: ctx.requesterSenderId }] },
  registerTool(value) { factory = value; } }, { createHost: createResearchHost });
  const tools = factory(ctx);
  const invoke = async (name, request) => {
    const response = await tools.find(item => item.name === `research_task_${name}`).execute('fixture', request);
    const decoded = JSON.parse(response.content[0].text); assert.equal(decoded.ok, true, decoded.code);
    assert.equal(decoded.automaticTradingAuthorized, false); assert.equal(decoded.provenance.actualModelReceipt, null);
    return decoded.result;
  };
  const input = { title: 'Synthetic task', question: 'Review this fictional claim', idempotencyKey: 'submit-synthetic',
    sources: [{ sourceKey: 'report', sourceFamily: 'example', kind: 'fact', source: 'Synthetic source', locator: 'https://example.invalid',
      publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-02T00:00:00Z', content: 'Unverified synthetic data' }],
    context: { thesis: { id: 'test', version: '1', locator: 'test/synthetic' }, skill: { id: 'research-brain', version: '3' },
      strategy: { id: 'test', version: '1' } } };
  const first = await invoke('submit', input);
  assert.equal(first.status, 'needs-review'); assert.equal(first.modelReceipt, null); assert.equal(first.publication, null);
  assert.equal(first.evidence[0].verification.status, 'pending');
  assert.equal((await invoke('submit', input)).id, first.id);
  const candidate = await invoke('propose', { taskId: first.id, idempotencyKey: 'proposal-synthetic',
    analysis: { kind: 'prediction', data: { title: 'Fictional prediction', probability: 0.5,
      dueAt: '2030-01-01T00:00:00Z', resolutionCriterion: 'Synthetic-only evaluation' } } });
  assert.equal(candidate.status, 'candidate');
  const retrieved = await invoke('get', { taskId: first.id });
  assert.equal(retrieved.proposals.length, 1); assert.equal(retrieved.publication, null);
  assert.equal(retrieved.evidence[0].verification.status, 'pending');
  const source = await invoke('get', { taskId: first.id, detail: 'source', itemId: first.sources[0].evidenceId });
  assert.equal(source.content, input.sources[0].content);
  const evidence = await invoke('get', { taskId: first.id, detail: 'evidence', itemId: first.evidence[0].id });
  assert.equal(evidence.verification.status, 'pending');
  assert.deepEqual(await invoke('get', { taskId: first.id, detail: 'proposal', itemId: candidate.id }), candidate);
  assert.equal(await invoke('get', { taskId: first.id, detail: 'publication' }), null);
  assert.equal((await invoke('list', { limit: 10, offset: 0 })).total, 1);
  assert.equal(tools.some(item => /commit|verify|review|resolve/.test(item.name)), false);
});

test('real packaged host isolates private and each explicit group across restart, including shared idempotency keys', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-group-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = '123456';
  const privateTuple = { sessionKey: 'agent:main:main', nativeChannelId: owner, requesterSenderId: owner };
  const groupTuples = ['-100123', '-100456'].map(nativeChannelId => ({ nativeChannelId, requesterSenderId: owner,
    sessionKey: `agent:main:telegram:group:${nativeChannelId}` }));
  const config = { enabled: true, environment: 'test', stateDirectory: path.join(root, 'research-bridge-test'),
    allowedContexts: [privateTuple], allowedGroupContexts: groupTuples };
  const makeFactory = () => {
    let factory;
    registerResearchBridge({ pluginConfig: config, registerTool(value) { factory = value; } }, { createHost: createBundledResearchHost });
    return factory;
  };
  let factory = makeFactory();
  const contexts = [privateTuple, ...groupTuples].map(tuple => ({ ...tuple, agentId: 'main', messageChannel: 'telegram',
    senderIsOwner: true, sessionId: 'first-session' }));
  const invoke = async (ctx, name, request, expected = true) => {
    const result = await factory(ctx).find(tool => tool.name === `research_task_${name}`).execute('synthetic', request);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, expected, envelope.code);
    if (!expected) { assert.equal(envelope.code, 'NOT_FOUND'); return; }
    assert.equal(envelope.provenance.actualModelReceipt, null); assert.equal(envelope.automaticTradingAuthorized, false);
    return envelope.result;
  };
  const request = { title: 'Scope isolation fixture', question: 'Keep synthetic evidence within the authorized conversation', idempotencyKey: 'same-submit',
    sources: [{ sourceKey: 'fiction', sourceFamily: 'example', kind: 'fact', source: 'Synthetic source', locator: 'https://example.invalid',
      publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-02T00:00:00Z', content: 'Unverified synthetic data only' }],
    context: { thesis: { id: 'fixture', version: '1', locator: 'test/fixture' }, skill: { id: 'research-brain', version: '3' },
      strategy: { id: 'test', version: '1' } } };
  const tasks = [];
  for (const ctx of contexts) tasks.push(await invoke(ctx, 'submit', request));
  assert.equal(new Set(tasks.map(task => task.id)).size, 3);
  assert.equal(new Set(tasks.map(task => task.scope.agentId)).size, 3);
  assert.deepEqual(tasks[0].scope, { agentId: 'main', environment: 'test' });
  for (const task of tasks.slice(1)) {
    assert.match(task.scope.agentId, /^tg-group-[a-f0-9]{64}$/); assert(task.scope.agentId.length <= 80);
    assert.equal(task.scope.environment, 'test'); assert.equal(task.status, 'needs-review');
    assert.equal(task.evidence[0].verification.status, 'pending');
  }
  for (let i = 0; i < contexts.length; i++) {
    assert.equal((await invoke(contexts[i], 'list', {})).total, 1);
    for (let j = 0; j < tasks.length; j++) if (i !== j) {
      await invoke(contexts[i], 'get', { taskId: tasks[j].id }, false);
      await invoke(contexts[i], 'propose', { taskId: tasks[j].id, idempotencyKey: 'cross-scope-proposal',
        analysis: { kind: 'decision', data: { title: 'Forbidden', action: 'research', reason: 'Cross-scope fixture' } } }, false);
    }
    const proposal = await invoke(contexts[i], 'propose', { taskId: tasks[i].id, idempotencyKey: 'same-proposal',
      analysis: { kind: 'decision', data: { title: 'Fixture', action: 'research', reason: 'Synthetic only' } } });
    assert.equal(proposal.status, 'candidate');
  }
  factory = makeFactory();
  for (let i = 0; i < contexts.length; i++) {
    const ctx = { ...contexts[i], sessionId: 'reset-session' };
    assert.equal((await invoke(ctx, 'submit', request)).id, tasks[i].id);
    const retrieved = await invoke(ctx, 'get', { taskId: tasks[i].id });
    assert.deepEqual(retrieved.scope, tasks[i].scope); assert.equal(retrieved.proposals.length, 1);
    assert.equal(retrieved.publication, null); assert.equal(retrieved.modelReceipt, null);
  }
});

test('packaged collaborator persists shared group candidates without access to private or another group records', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-collaborator-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateTuple = { sessionKey: 'agent:main:main', nativeChannelId: '123456', requesterSenderId: '123456' };
  const group = { sessionKey: 'agent:main:telegram:group:-100123', nativeChannelId: '-100123', requesterSenderId: '123456' };
  const other = { sessionKey: 'agent:main:telegram:group:-100456', nativeChannelId: '-100456', requesterSenderId: '123456' };
  const collaborator = { ...group, requesterSenderId: '789' };
  let factory;
  registerResearchBridge({ pluginConfig: { enabled: true, environment: 'test', stateDirectory: path.join(root, 'research-bridge-test'),
    allowedContexts: [privateTuple], allowedGroupContexts: [group, other], allowedGroupCollaboratorContexts: [collaborator] },
    registerTool(value) { factory = value; } }, { createHost: createBundledResearchHost });
  const context = (tuple, senderIsOwner = true) => ({ ...tuple, agentId: 'main', messageChannel: 'telegram', senderIsOwner, sessionId: 'same-session' });
  const invoke = async (ctx, name, request) => JSON.parse((await factory(ctx).find(tool => tool.name === `research_task_${name}`)
    .execute('synthetic', request)).content[0].text);
  const request = { title: 'Shared group fixture', question: 'Share candidates without adding owner privileges', idempotencyKey: 'shared-submit',
    sources: [{ sourceKey: 'fiction', sourceFamily: 'example', kind: 'fact', source: 'Synthetic source', locator: 'https://example.invalid',
      publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-02T00:00:00Z', content: 'Unverified synthetic data' }],
    context: { thesis: { id: 'fixture', version: '1', locator: 'test/fixture' }, skill: { id: 'research-brain', version: '3' },
      strategy: { id: 'test', version: '1' } } };
  const ownerTask = (await invoke(context(group), 'submit', request)).result;
  const collaboratorContext = context(collaborator, false);
  assert.equal((await invoke(collaboratorContext, 'get', { taskId: ownerTask.id })).result.id, ownerTask.id);
  assert.equal((await invoke(collaboratorContext, 'submit', request)).result.id, ownerTask.id, 'The group idempotency namespace is shared.');
  const collaboratorTask = (await invoke(collaboratorContext, 'submit', { ...request, idempotencyKey: 'collaborator-submit' })).result;
  assert.deepEqual(collaboratorTask.scope, ownerTask.scope); assert.notEqual(collaboratorTask.submittedBy, ownerTask.submittedBy);
  const proposalRequest = { taskId: ownerTask.id, idempotencyKey: 'collaborator-proposal',
    analysis: { kind: 'decision', data: { title: 'Candidate only', action: 'research', reason: 'Synthetic shared research' } } };
  const proposal = (await invoke(collaboratorContext, 'propose', proposalRequest)).result;
  assert.equal(proposal.status, 'candidate'); assert.equal(proposal.proposedBy, collaboratorTask.submittedBy);
  const readByOwner = (await invoke(context(group), 'get', { taskId: ownerTask.id })).result;
  assert.deepEqual(readByOwner.proposals, [proposal]); assert.equal(readByOwner.publication, null); assert.equal(readByOwner.modelReceipt, null);
  assert.equal((await invoke(context(group), 'get', { taskId: collaboratorTask.id })).result.id, collaboratorTask.id);
  for (const isolated of [privateTuple, other]) {
    const isolatedTask = (await invoke(context(isolated), 'submit', request)).result;
    for (const [name, payload] of [['get', { taskId: isolatedTask.id }], ['propose', { ...proposalRequest, taskId: isolatedTask.id }]]) {
      const denied = await invoke(collaboratorContext, name, payload);
      assert.equal(denied.ok, false); assert.equal(denied.code, 'NOT_FOUND');
    }
  }
  assert.equal((await invoke({ ...collaboratorContext, sessionId: 'reset-session' }, 'get', { taskId: ownerTask.id })).result.id, ownerTask.id);
  assert.equal((await invoke(collaboratorContext, 'list', {})).result.total, 2);
});
