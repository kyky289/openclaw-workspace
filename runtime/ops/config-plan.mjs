#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = isDeepStrictEqual;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : isObject(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const within = (parent, child) => { const rel = relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

function validateIsolation(config, group, main, agentId) {
  if (![group.workspace, main.workspace].every(value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0'))) throw new Error('Distinct explicit absolute agent workspaces required');
  const groupPath = resolve(group.workspace), mainPath = resolve(main.workspace);
  if (within(groupPath, mainPath) || within(mainPath, groupPath)) throw new Error('Agent workspaces must not coincide or contain one another');
  const defaults = config.agents?.defaults ?? {};
  const defaultSandbox = defaults.sandbox ?? {};
  const ownSandbox = group.sandbox ?? {};
  const sandbox = { ...defaultSandbox, ...ownSandbox, docker: { ...defaultSandbox.docker, ...ownSandbox.docker } };
  if (sandbox.mode !== 'all' || sandbox.scope !== 'agent' || sandbox.backend !== 'podman' || sandbox.docker.network !== 'none'
    || sandbox.docker.readOnlyRoot !== true || !Array.isArray(sandbox.docker.capDrop) || !sandbox.docker.capDrop.includes('ALL')) {
    throw new Error('Target agent isolation policy is incomplete; no routing plan produced');
  }
  for (const settings of [defaultSandbox, ownSandbox]) {
    if (settings.sessionToolsVisibility === 'all' || settings.workspaceRoot !== undefined
      || settings.browser?.enabled === true || settings.browser?.allowHostControl === true) throw new Error('Additional sandbox access requires manual review');
    const docker = settings.docker ?? {};
    if ((docker.binds !== undefined && (!Array.isArray(docker.binds) || docker.binds.length > 0))
      || Object.entries(docker).some(([key, value]) => key.startsWith('dangerouslyAllow') && value !== false)
      || docker.seccompProfile === 'unconfined' || docker.apparmorProfile === 'unconfined') throw new Error('Host mounts or sandbox overrides require manual review');
  }
  for (const settings of [defaults, group]) {
    if (settings.cwd !== undefined && (typeof settings.cwd !== 'string' || !isAbsolute(settings.cwd) || !within(groupPath, resolve(settings.cwd)))) throw new Error('Agent working directory requires manual isolation review');
    const allowedAgents=settings.subagents?.allowAgents;
    if (allowedAgents !== undefined && (!Array.isArray(allowedAgents) || allowedAgents.some(target => target !== agentId))) throw new Error('Cross-agent spawning requires manual review');
  }
  for (const settings of [config.tools, group.tools]) {
    if (settings?.elevated?.enabled === true || ['gateway', 'node'].includes(settings?.exec?.host)
      || settings?.sessions?.visibility === 'all') throw new Error('Host execution or broad session access requires manual review');
  }
  if (config.tools?.agentToAgent?.enabled !== false) throw new Error('Explicit agent-to-agent disable required for this migration');
}

/** Produce a narrowly scoped, reviewable plan. Never write a live configuration. */
export function prepareGroupRoutingPlan(config, { groupId, agentId = 'group-tim', expectedCurrentAgent = 'main', sourceSha256 } = {}) {
  if (!isObject(config) || !/^-[1-9]\d{0,19}$/.test(groupId ?? '') || !/^[a-z][a-z0-9-]{0,63}$/.test(agentId)) {
    throw new Error('Invalid configuration or target identifiers');
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(expectedCurrentAgent) || agentId === expectedCurrentAgent) throw new Error('Invalid source/target agent relationship');
  if (sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Invalid source digest');
  const agents = config.agents?.entries;
  const group = agents?.[agentId];
  const main = agents?.[expectedCurrentAgent];
  if (!isObject(group) || !isObject(main)) throw new Error('Distinct existing agent workspaces required');
  if (!Array.isArray(config.bindings)) throw new Error('Expected explicit bindings array');
  validateIsolation(config, group, main, agentId);
  const sourceConfigSha256 = hash(canonical(config));
  const desired = { agentId, match: { channel: 'telegram', accountId: '*', peer: { kind: 'group', id: groupId } } };
  const matches = config.bindings.filter((b) => b?.match?.channel === 'telegram' && b?.match?.peer?.kind === 'group' && b?.match?.peer?.id === groupId);
  if (matches.length) {
    if (matches.length !== 1 || !same(matches[0], desired)) throw new Error('Existing group binding conflicts or has extra policy; manual review required');
  }
  // Do not assume a current route if more specific or cross-account rules exist.
  const telegramBindings = config.bindings.filter((b) => b?.match?.channel === 'telegram' && !matches.includes(b));
  if (telegramBindings.length !== 1 || !same(telegramBindings[0], { agentId: expectedCurrentAgent, match: { channel: 'telegram', accountId: '*' } })) {
    throw new Error('Telegram routing differs from the audited baseline; review actual precedence first');
  }
  if (matches.length) return { schemaVersion: 1, status: 'already-configured', sourceSha256, sourceConfigSha256, expectedCurrentAgent, patch: [], target: { agentId, groupId }, requiresApproval: false };
  return {
    schemaVersion: 1,
    status: 'pending-approval',
    sourceSha256,
    sourceConfigSha256,
    expectedCurrentAgent,
    target: { agentId, groupId },
    patch: [{ op: 'add', path: '/bindings/0', value: desired }],
    requiresApproval: true,
    preconditions: ['Recheck configuration digest immediately before applying', 'Resolve workspace paths on the runtime host and reject symlink aliases or overlaps', 'Verify target model runtime and authentication path; an unmapped model may use auto selection and cannot be assumed to use the current Claude CLI account', 'Verify there is no live conversation-binding override', 'Validate candidate with installed OpenClaw schema', 'Preserve existing sessions and archives', 'Confirm authenticated group cannot read private workspace or private sessions'],
    expectedBehavior: { groupAgent: agentId, otherTelegramAgent: expectedCurrentAgent, changesModelConfiguration: false, changesCredentialConfiguration: false, effectiveAgentModelChanges: true, runtimeAndBillingVerified: false, migratesHistory: false },
    rollback: 'Remove only the exact newly inserted binding after rechecking current state; do not overwrite a newer entire configuration.',
    limitation: 'Offline route selection is not a live sandbox or channel end-to-end test.'
  };
}

/** Apply a plan to an in-memory object for validation, never to a file. */
export function previewRoutingPlan(config, plan) {
  if (!isObject(plan) || !['pending-approval', 'already-configured'].includes(plan.status)) throw new Error('Invalid plan');
  const expected = prepareGroupRoutingPlan(config, { ...plan.target, expectedCurrentAgent: plan.expectedCurrentAgent, sourceSha256: plan.sourceSha256 });
  if (plan.sourceConfigSha256 !== expected.sourceConfigSha256 || plan.status !== expected.status || !same(plan.patch, expected.patch)) throw new Error('Plan does not match configuration and target');
  const next = structuredClone(config);
  if (plan.patch.length) next.bindings.unshift(structuredClone(plan.patch[0].value));
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, groupId, ...extra] = process.argv.slice(2);
    if (!file || !groupId || extra.length) throw new Error('Usage: node ops/config-plan.mjs CONFIG_JSON GROUP_ID (read-only)');
    const bytes = readFileSync(file);
    console.log(JSON.stringify(prepareGroupRoutingPlan(JSON.parse(bytes), { groupId, sourceSha256: hash(bytes) }), null, 2));
  } catch (error) {
    // JSON parser messages can include snippets of secrets from invalid input.
    console.error(error instanceof SyntaxError ? 'Invalid JSON; input content suppressed' : error.message);
    process.exitCode = 1;
  }
}
