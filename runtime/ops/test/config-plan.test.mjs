import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroupRoutingPlan, previewRoutingPlan } from '../config-plan.mjs';

function config() {
  return { agents: { defaults: { model: 'anthropic/claude-opus-5' }, entries: { main: { workspace: '/private' }, 'group-tim': { workspace: '/group', model: 'anthropic/claude-sonnet-5', sandbox: { mode: 'all', scope: 'agent', backend: 'podman', docker: { network: 'none', readOnlyRoot: true, capDrop: ['ALL'] } } } } }, tools: { agentToAgent: { enabled: false } }, bindings: [{ agentId: 'main', match: { channel: 'telegram', accountId: '*' } }], gateway: { auth: { token: 'SENSITIVE_FIXTURE_NOT_A_REAL_KEY' } } };
}
test('plan adds only exact group binding; retains models, auth, other bindings and input', () => {
  const before = config(); const original = structuredClone(before);
  const plan = prepareGroupRoutingPlan(before, { groupId: '-1234567' });
  assert.equal(plan.requiresApproval, true);
  assert.equal(JSON.stringify(plan).includes('SENSITIVE_FIXTURE'), false);
  const after = previewRoutingPlan(before, plan);
  assert.deepEqual(before, original);
  assert.equal(after.bindings.length, 2);
  assert.deepEqual(after.bindings[1], original.bindings[0]);
  assert.deepEqual(after.agents, original.agents);
  assert.deepEqual(after.gateway, original.gateway);
  assert.equal(after.bindings[0].match.peer.id, '-1234567');
  assert.equal(prepareGroupRoutingPlan(after, { groupId: '-1234567' }).status, 'already-configured');
});
test('rejects shared workspace or incomplete sandbox', () => {
  for (const mutate of [c => c.agents.entries['group-tim'].workspace='/private', c => c.agents.entries['group-tim'].sandbox.docker.network='bridge', c => c.tools.agentToAgent.enabled=true]) {
    const c=config(); mutate(c); assert.throws(() => prepareGroupRoutingPlan(c,{groupId:'-1234567'}));
  }
});
test('does not overwrite existing binding or competing routes', () => {
  const c=config();c.bindings.push({agentId:'main',match:{channel:'telegram',peer:{kind:'group',id:'-1234567'}}});
  assert.throws(()=>prepareGroupRoutingPlan(c,{groupId:'-1234567'}),/conflict/);
  c.bindings[1].match.peer.id='-7654321';
  assert.throws(()=>prepareGroupRoutingPlan(c,{groupId:'-1234567'}),/baseline/);
});
test('tampered patch cannot alter model or credentials', () => {
  const c=config();const p=prepareGroupRoutingPlan(c,{groupId:'-1234567'});p.patch.push({op:'replace',path:'/agents/defaults/model',value:'other'});
  assert.throws(()=>previewRoutingPlan(c,p),/does not match/);
});
test('rejects malformed IDs',()=>{
  for(const groupId of ['123','-123:x','-0','-01','',null]) assert.throws(()=>prepareGroupRoutingPlan(config(),{groupId}));
});
test('rejects normalized aliases, nested workspaces and unspecified workspace paths',()=>{
  for(const workspace of ['/private/../private','/private/group','/','relative',null]) {
    const c=config();c.agents.entries['group-tim'].workspace=workspace;
    assert.throws(()=>prepareGroupRoutingPlan(c,{groupId:'-1234567'}));
  }
});
test('rejects inherited host binds, bypasses and cross-agent privileges',()=>{
  const mutations=[
    c=>c.agents.defaults.sandbox={docker:{binds:['/private:/private:ro']}},
    c=>c.agents.entries['group-tim'].sandbox.docker.binds=['/private:/private:ro'],
    c=>c.agents.defaults.sandbox={docker:{dangerouslyAllowExternalBindSources:true}},
    c=>c.agents.entries['group-tim'].sandbox.docker.capDrop='ALL',
    c=>c.agents.entries['group-tim'].sandbox.docker.seccompProfile='unconfined',
    c=>c.agents.entries['group-tim'].sandbox.sessionToolsVisibility='all',
    c=>c.agents.entries['group-tim'].sandbox.browser={enabled:true},
    c=>c.agents.defaults.subagents={allowAgents:['*']},
    c=>c.agents.entries['group-tim'].subagents={allowAgents:['main']},
    c=>c.agents.entries['group-tim'].tools={elevated:{enabled:true}},
    c=>c.tools.exec={host:'gateway'},
    c=>c.agents.defaults.cwd='/private',
  ];
  for(const mutate of mutations){const c=config();mutate(c);assert.throws(()=>prepareGroupRoutingPlan(c,{groupId:'-1234567'}));}
});
test('preview retains a custom current agent and rejects stale source configurations',()=>{
  const c=config();c.agents.entries.personal=c.agents.entries.main;delete c.agents.entries.main;c.bindings[0].agentId='personal';
  const p=prepareGroupRoutingPlan(c,{groupId:'-1234567',expectedCurrentAgent:'personal'});
  assert.equal(previewRoutingPlan(c,p).bindings[1].agentId,'personal');
  const modified=structuredClone(c);modified.gateway.auth.token='NEW_SENSITIVE_FIXTURE';
  assert.throws(()=>previewRoutingPlan(modified,p),/does not match/);
  assert.equal(JSON.stringify(p).includes('SENSITIVE_FIXTURE'),false);
});
test('binding property order is irrelevant and already-configured does not skip competing route checks',()=>{
  const c=config();c.bindings[0]={match:{accountId:'*',channel:'telegram'},agentId:'main'};
  const after=previewRoutingPlan(c,prepareGroupRoutingPlan(c,{groupId:'-1234567'}));
  after.bindings.push({agentId:'main',match:{channel:'telegram',accountId:'other'}});
  assert.throws(()=>prepareGroupRoutingPlan(after,{groupId:'-1234567'}),/baseline/);
});
