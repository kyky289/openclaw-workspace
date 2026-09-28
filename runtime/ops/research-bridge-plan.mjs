import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const RESEARCH_BRIDGE_PLUGIN_ID = 'openclaw-research-bridge';
export const RESEARCH_BRIDGE_TOOL_NAMES = Object.freeze([
  'research_task_submit', 'research_task_get', 'research_task_list', 'research_task_propose',
]);
const own = (value, key) => Object.hasOwn(value, key);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
function json(value, seen = new Set(), depth = 0) {
  if (depth > 64) fail('CONFIG_INVALID');
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!Array.isArray(value) && !plain(value)) fail('CONFIG_INVALID');
  if (seen.has(value) || Object.getOwnPropertySymbols(value).length) fail('CONFIG_INVALID');
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length + (Array.isArray(value) ? 1 : 0)) fail('CONFIG_INVALID');
  seen.add(value);
  if (Array.isArray(value) && (Object.keys(value).length !== value.length
    || Array.from({ length: value.length }, (_, index) => index).some((index) => !own(value, index)))) fail('CONFIG_INVALID');
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value')) fail('CONFIG_INVALID');
    json(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}
function objectOrAbsent(parent, key, code) {
  if (!own(parent, key)) return {};
  if (!plain(parent[key])) fail(code);
  return parent[key];
}
function stringArray(parent, key, code) {
  if (!own(parent, key)) return undefined;
  const values = parent[key];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim() || value.includes('\0'))
    || new Set(values).size !== values.length) fail(code);
  return values;
}
function normalizedAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
    && value !== path.parse(value).root && !value.endsWith(path.sep) && value === path.normalize(value)
    && !value.split(path.sep).some((part) => part === '.' || part === '..');
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function matches(pattern, value) {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${expression}$`, 'i').test(value);
}
const pluginAliases = [RESEARCH_BRIDGE_PLUGIN_ID, `group:${RESEARCH_BRIDGE_PLUGIN_ID}`, 'group:plugins'];
function coversTool(patterns, name) { return patterns.some((pattern) => [name, ...pluginAliases].some((value) => matches(pattern, value))); }
function checkTools(tools) {
  if (own(tools, 'allow') && own(tools, 'alsoAllow')) fail('TOOL_ALLOW_POLICY_CONFLICT');
  stringArray(tools, 'allow', 'TOOL_POLICY_INVALID');
  stringArray(tools, 'alsoAllow', 'TOOL_POLICY_INVALID');
  const deny = stringArray(tools, 'deny', 'TOOL_POLICY_INVALID') ?? [];
  if (RESEARCH_BRIDGE_TOOL_NAMES.some((tool) => coversTool(deny, tool))) fail('TOOL_DENY_CONFLICT');
  if (own(tools, 'byProvider')) {
    if (!plain(tools.byProvider)) fail('TOOL_POLICY_INVALID');
    for (const rule of Object.values(tools.byProvider)) {
      if (!plain(rule)) fail('TOOL_POLICY_INVALID');
      checkTools(rule);
      if (rule.allow && RESEARCH_BRIDGE_TOOL_NAMES.some((name) => !coversTool(rule.allow, name))) fail('PROVIDER_TOOL_ALLOW_CONFLICT');
    }
  }
}
function contexts(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) fail('CONTEXT_INVALID');
  const results = input.map((item) => {
    if (!plain(item) || !isDeepStrictEqual(Object.keys(item).sort(), ['nativeChannelId', 'requesterSenderId', 'sessionKey'])
      || typeof item.nativeChannelId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(item.nativeChannelId)
      || item.nativeChannelId !== item.requesterSenderId || typeof item.sessionKey !== 'string') fail('CONTEXT_INVALID');
    // The default main DM session is still constrained by the exact Telegram
    // channel/chat/sender checks in the bridge. Scoped DM forms also pin peer ID.
    const scoped = item.sessionKey.match(/^agent:main:telegram:(?:[a-zA-Z0-9_-]{1,64}:)?(?:direct|dm):([1-9][0-9]{0,19})$/);
    if (/(^|:)(group|channel|topic|thread|subagent|cron)(:|$)/i.test(item.sessionKey)
      || (item.sessionKey !== 'agent:main:main' && (!scoped || scoped[1] !== item.nativeChannelId))) fail('CONTEXT_INVALID');
    return { sessionKey: item.sessionKey, nativeChannelId: item.nativeChannelId, requesterSenderId: item.requesterSenderId };
  });
  if (new Set(results.map(canonical)).size !== results.length) fail('CONTEXT_INVALID');
  return results;
}

/** Pure proposal: no filesystem reads, production writes, registration or service actions. */
export function prepareResearchBridgePlan(config, options) {
  json(config);
  if (!plain(config) || !plain(options) || Object.keys(options).some((key) => !['pluginPath', 'stateDirectory', 'allowedContexts', 'sourceSha256'].includes(key))) fail('PLAN_INPUT_INVALID');
  if (Object.getOwnPropertySymbols(options).length || Object.getOwnPropertyNames(options).length !== Object.keys(options).length
    || Object.keys(options).some((key) => !own(Object.getOwnPropertyDescriptor(options, key), 'value'))) fail('PLAN_INPUT_INVALID');
  const { pluginPath, stateDirectory, sourceSha256 } = options;
  if (!normalizedAbsolute(pluginPath) || !normalizedAbsolute(stateDirectory)
    || path.basename(stateDirectory) !== 'research-bridge-test'
    || stateDirectory.split(path.sep).some((part) => ['memory', 'skills', 'stable-skills', 'workshop-skills'].includes(part.toLowerCase()))
    || contains(pluginPath, stateDirectory) || contains(stateDirectory, pluginPath)) fail('PLAN_PATH_INVALID');
  if (sourceSha256 !== undefined && (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256))) fail('SOURCE_DIGEST_INVALID');
  if (options.allowedContexts !== undefined) json(options.allowedContexts);
  const allowedContexts = contexts(options.allowedContexts);
  if (!plain(config.agents) || !plain(config.agents.entries) || !plain(config.agents.entries.main)
    || own(config.agents, 'list')) fail('MAIN_AGENT_REQUIRED');
  const defaults = objectOrAbsent(config.agents, 'defaults', 'AGENT_CONFIG_INVALID');
  if (typeof defaults.workspace === 'string' && path.isAbsolute(defaults.workspace)
    && contains(stateDirectory, path.resolve(defaults.workspace))) fail('STATE_WORKSPACE_CONFLICT');
  for (const agent of Object.values(config.agents.entries)) {
    if (!plain(agent)) fail('AGENT_CONFIG_INVALID');
    if (typeof agent.workspace === 'string' && path.isAbsolute(agent.workspace) && contains(stateDirectory, path.resolve(agent.workspace))) fail('STATE_WORKSPACE_CONFLICT');
  }
  const main = config.agents.entries.main;
  const plugins = objectOrAbsent(config, 'plugins', 'PLUGIN_POLICY_INVALID');
  if (own(plugins, 'enabled') && plugins.enabled !== true) fail('PLUGINS_DISABLED');
  const load = objectOrAbsent(plugins, 'load', 'PLUGIN_POLICY_INVALID');
  const entries = objectOrAbsent(plugins, 'entries', 'PLUGIN_POLICY_INVALID');
  const paths = stringArray(load, 'paths', 'PLUGIN_PATH_CONFLICT') ?? [];
  const pluginAllow = stringArray(plugins, 'allow', 'PLUGIN_POLICY_INVALID');
  const pluginDeny = stringArray(plugins, 'deny', 'PLUGIN_POLICY_INVALID') ?? [];
  if (pluginDeny.some((pattern) => matches(pattern, RESEARCH_BRIDGE_PLUGIN_ID))) fail('PLUGIN_DENY_CONFLICT');
  const tools = objectOrAbsent(main, 'tools', 'TOOL_POLICY_INVALID');
  const globalTools = objectOrAbsent(config, 'tools', 'TOOL_POLICY_INVALID');
  checkTools(tools); checkTools(globalTools);
  // Main additions must not pretend to override a restrictive global allowlist.
  if (globalTools.allow && RESEARCH_BRIDGE_TOOL_NAMES.some((name) => !coversTool(globalTools.allow, name))) fail('GLOBAL_TOOL_ALLOW_CONFLICT');
  const entry = { enabled: true, config: { enabled: true, environment: 'test', stateDirectory, allowedContexts } };
  if (own(entries, RESEARCH_BRIDGE_PLUGIN_ID) && !isDeepStrictEqual(entries[RESEARCH_BRIDGE_PLUGIN_ID], entry)) fail('PLUGIN_ENTRY_CONFLICT');
  for (const existing of paths) {
    if (!normalizedAbsolute(existing)) fail('PLUGIN_PATH_CONFLICT');
    if (existing === pluginPath) continue;
    if (path.isAbsolute(existing) && (path.resolve(existing) === pluginPath
      || path.basename(path.resolve(existing)) === path.basename(pluginPath)
      || contains(path.resolve(existing), pluginPath) || contains(pluginPath, path.resolve(existing)))) fail('PLUGIN_PATH_CONFLICT');
  }
  const alreadyEntry = own(entries, RESEARCH_BRIDGE_PLUGIN_ID);
  const alreadyPath = paths.includes(pluginPath);
  if (alreadyEntry !== alreadyPath) fail('PARTIAL_PLUGIN_CONFIGURATION');
  const patch = [];
  const add = (pointer, value) => patch.push({ op: 'add', path: pointer, value: structuredClone(value) });
  if (!own(config, 'plugins')) {
    add('/plugins', { load: { paths: [pluginPath] }, entries: { [RESEARCH_BRIDGE_PLUGIN_ID]: entry } });
  } else {
    if (!alreadyPath) {
      if (!own(plugins, 'load')) add('/plugins/load', { paths: [pluginPath] });
      else if (!own(load, 'paths')) add('/plugins/load/paths', [pluginPath]);
      else add('/plugins/load/paths/-', pluginPath);
    }
    if (!alreadyEntry) {
      if (!own(plugins, 'entries')) add('/plugins/entries', { [RESEARCH_BRIDGE_PLUGIN_ID]: entry });
      else add(`/plugins/entries/${RESEARCH_BRIDGE_PLUGIN_ID}`, entry);
    }
    if (pluginAllow && !pluginAllow.includes(RESEARCH_BRIDGE_PLUGIN_ID)) add('/plugins/allow/-', RESEARCH_BRIDGE_PLUGIN_ID);
  }
  const toolKey = own(tools, 'allow') ? 'allow' : 'alsoAllow';
  const existingTools = tools[toolKey] ?? [];
  const addedTools = RESEARCH_BRIDGE_TOOL_NAMES.filter((name) => !existingTools.includes(name));
  if (addedTools.length) {
    if (!own(main, 'tools')) add('/agents/entries/main/tools', { [toolKey]: [...RESEARCH_BRIDGE_TOOL_NAMES] });
    else if (!own(tools, toolKey)) add(`/agents/entries/main/tools/${toolKey}`, [...RESEARCH_BRIDGE_TOOL_NAMES]);
    else addedTools.forEach((name) => add(`/agents/entries/main/tools/${toolKey}/-`, name));
  }
  const body = {
    schemaVersion: 1, kind: 'research-bridge-enablement',
    status: patch.length ? 'pending-approval' : 'already-configured', requiresApproval: patch.length > 0,
    sourceConfigSha256: hash(config), ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
    target: { pluginId: RESEARCH_BRIDGE_PLUGIN_ID, agentId: 'main', environment: 'test', pluginPath, stateDirectory, allowedContexts },
    toolNames: [...RESEARCH_BRIDGE_TOOL_NAMES], patch,
    expectedBehavior: { changesModelConfiguration: false, changesCredentialConfiguration: false,
      changesGlobalToolPolicy: false, changesOtherAgents: false, changesBindings: false,
      automaticVerification: false, automaticReview: false, automaticTrading: false, sendsTelegramMessages: false },
    runtimeReadiness: { status: 'blocked-until-context-propagation-verified', productionReady: false,
      requiredFactoryContext: ['agentId', 'messageChannel', 'senderIsOwner', 'sessionKey', 'sessionId', 'nativeChannelId', 'requesterSenderId'] },
    preconditions: ['Recheck canonical source digest and optional raw-file digest before any separately approved apply.',
      'Validate candidate with the installed OpenClaw schema and test plugin registration without starting a duplicate service.',
      'Verify plugin artifact path and digest on the runtime host; reject symlink aliases and duplicate plugin identities.',
      'Verify dedicated state directory has private ownership/mode and does not alias existing workspace, memory, skills or state.',
      'Confirm all exact private Telegram context values from authenticated runtime metadata; do not infer identity from message text.',
      'Preserve original configuration and obtain approval before production configuration or gateway changes.'],
    limitation: 'Offline in-memory plan only; no plugin installation, production enablement, service action or Telegram message is performed. Configuration alone cannot repair missing authenticated factory context fields.',
  };
  return { ...body, planSha256: hash(body) };
}

/** Revalidate every plan field and apply only recomputed minimal additions in memory. */
export function previewResearchBridgePlan(config, plan) {
  json(plan);
  if (!plain(plan) || !plain(plan.target)) fail('PLAN_INVALID');
  const expected = prepareResearchBridgePlan(config, {
    pluginPath: plan.target.pluginPath, stateDirectory: plan.target.stateDirectory,
    allowedContexts: plan.target.allowedContexts, ...(plan.sourceSha256 === undefined ? {} : { sourceSha256: plan.sourceSha256 }),
  });
  if (!isDeepStrictEqual(plan, expected)) fail('PLAN_MISMATCH');
  const candidate = structuredClone(config);
  for (const operation of expected.patch) {
    const parts = operation.path.slice(1).split('/');
    let parent = candidate;
    for (const part of parts.slice(0, -1)) parent = parent[part];
    const key = parts.at(-1);
    if (key === '-') parent.push(structuredClone(operation.value));
    else parent[key] = structuredClone(operation.value);
  }
  return candidate;
}
