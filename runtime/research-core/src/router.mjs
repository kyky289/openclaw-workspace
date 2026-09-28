/** Offline, deterministic request-boundary policy. This module never calls a model. */
export const POLICY_VERSION = 'research-router/1';
const ROLES = ['fast', 'standard', 'deep'];
const CAPABILITIES = ['text', 'tools', 'vision', 'structured-output'];
const MODEL_REF = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9._-]{1,99}$/;
const isRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (object, name) => Object.hasOwn(object, name);
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const maxRole = (a, b) => ROLES[Math.max(ROLES.indexOf(a), ROLES.indexOf(b))];
const extras = (object, keys) => Object.keys(object).some((key) => !keys.includes(key));

/** Candidate labels are configuration, not assertions of availability or quality. */
export function createDefaultPolicy() {
  const candidate = (modelRef) => ({ modelRef, approved: false, ready: false,
    capabilities: [], estimatedUnits: null });
  return {
    version: POLICY_VERSION,
    models: {
      fast: candidate('anthropic/claude-haiku-4-5'),
      standard: candidate('anthropic/claude-sonnet-5'),
      deep: candidate('anthropic/claude-opus-5-5'),
    },
    budget: { unit: 'budget-unit', maxUpgrades: 2, maxRetries: 1 },
  };
}

/** Validation returns fixed error codes; caller data and credentials are never echoed. */
export function validatePolicy(policy) {
  const errors = [];
  if (!isRecord(policy) || extras(policy, ['version', 'models', 'budget'])) {
    return { valid: false, errors: ['POLICY_INVALID'] };
  }
  if (policy.version !== POLICY_VERSION) errors.push('POLICY_VERSION_UNSUPPORTED');
  if (!isRecord(policy.models) || extras(policy.models, ROLES)) errors.push('POLICY_MODELS_INVALID');
  else for (const role of ROLES) {
    const model = policy.models[role];
    if (!isRecord(model) || extras(model, ['modelRef', 'approved', 'ready', 'capabilities', 'estimatedUnits'])
      || typeof model.modelRef !== 'string' || !MODEL_REF.test(model.modelRef)
      || typeof model.approved !== 'boolean' || typeof model.ready !== 'boolean'
      || !Array.isArray(model.capabilities) || model.capabilities.some((item) => !CAPABILITIES.includes(item))
      || new Set(model.capabilities).size !== model.capabilities.length
      || !(model.estimatedUnits === null || finite(model.estimatedUnits))) errors.push('POLICY_MODEL_INVALID');
  }
  const budget = policy.budget;
  if (!isRecord(budget) || extras(budget, ['unit', 'maxUpgrades', 'maxRetries'])
    || typeof budget.unit !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(budget.unit)
    || !counter(budget.maxUpgrades) || !counter(budget.maxRetries)) errors.push('POLICY_BUDGET_INVALID');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateInput(input) {
  const errors = [];
  if (!isRecord(input) || extras(input, ['metadata', 'prompt', 'manualRole', 'signals', 'requiredCapabilities', 'dryRun', 'budget', 'execution'])) {
    return ['INPUT_INVALID'];
  }
  const metadata = input.metadata;
  if (!isRecord(metadata) || extras(metadata, ['risk', 'impact', 'complexity'])
    || !['low', 'high'].includes(metadata.risk)
    || !['ephemeral', 'durable', 'financial'].includes(metadata.impact)
    || !['low', 'medium', 'high'].includes(metadata.complexity)) errors.push('METADATA_INVALID');
  if (own(input, 'prompt') && (typeof input.prompt !== 'string' || input.prompt.length > 100_000)) errors.push('PROMPT_INVALID');
  if (own(input, 'manualRole') && !ROLES.includes(input.manualRole)) errors.push('MANUAL_ROLE_INVALID');
  if (own(input, 'dryRun') && typeof input.dryRun !== 'boolean') errors.push('DRY_RUN_INVALID');
  if (own(input, 'signals') && (!isRecord(input.signals)
    || extras(input.signals, ['evidenceConflict', 'thesisUpdate', 'policyChange'])
    || Object.values(input.signals).some((value) => typeof value !== 'boolean'))) errors.push('SIGNALS_INVALID');
  if (own(input, 'requiredCapabilities') && (!Array.isArray(input.requiredCapabilities)
    || input.requiredCapabilities.some((item) => !CAPABILITIES.includes(item))
    || new Set(input.requiredCapabilities).size !== input.requiredCapabilities.length)) errors.push('CAPABILITIES_INVALID');
  if (own(input, 'budget') && (!isRecord(input.budget)
    || extras(input.budget, ['unit', 'remainingUnits']) || typeof input.budget.unit !== 'string'
    || !(input.budget.remainingUnits === null || finite(input.budget.remainingUnits)))) errors.push('BUDGET_INVALID');
  if (own(input, 'execution')) {
    const execution = input.execution;
    if (!isRecord(execution) || extras(execution, ['boundary', 'previousRole', 'upgradesUsed', 'retriesUsed'])
      || (own(execution, 'boundary') && !['request', 'inflight'].includes(execution.boundary))
      || (own(execution, 'previousRole') && !ROLES.includes(execution.previousRole))
      || (own(execution, 'upgradesUsed') && !counter(execution.upgradesUsed))
      || (own(execution, 'retriesUsed') && !counter(execution.retriesUsed))
      || (own(execution, 'previousRole') && (!own(execution, 'upgradesUsed') || !own(execution, 'retriesUsed')))) errors.push('EXECUTION_INVALID');
  }
  return errors;
}

const PROMPT_RULES = [
  // Conservative secondary signals can raise the trusted metadata floor, never lower it.
  ['deep', 'PROMPT_FINANCIAL_ACTION', /\b(buy|sell|short|trade|invest|rebalance|liquidate|transfer|withdraw|leverage|compre|comprar|vender|invertir|acheter|vendre|investir|kaufen|verkaufen)\b|买|買|卖|賣|下单|下單|建仓|建倉|平仓|平倉|加仓|加倉|开仓|開倉|杠杆|槓桿|转账|轉帳|钱包签名|錢包簽名|合约授权|合約授權|全仓|全倉|半仓|半倉|投资建议|投資建議|梭哈|매수|매도|매매|매입|매각|注文|購入|売却|投資判断|شراء|بيع|تداول/iu],
  ['deep', 'PROMPT_THESIS_OR_CONFLICT', /\b(thesis|contradict(?:ion|ory|ing)?|conflict(?:ing)? evidence|revise (?:the )?strategy)\b|反证|反證|证据冲突|證據衝突|推翻|修订策略|修訂策略|修改策略|更新策略|变更规则|變更規則/iu],
  ['deep', 'PROMPT_SECURITY_CHANGE', /\b(bypass|disable safeguards|ignore (?:all )?(?:previous|safety)|change permissions|system prompt|api.?key|credentials?)\b|绕过|繞過|忽略.*(?:规则|規則|限制|指令)|放宽.*(?:权限|權限|风险|風險)|密钥|密鑰|凭据|憑據|修改权限|修改權限/iu],
  ['standard', 'PROMPT_DURABLE_MEMORY', /\b(memory|remember|persist|knowledge base)\b|记住|記住|记忆|記憶|知识库|知識庫/iu],
  ['standard', 'PROMPT_RESEARCH', /\b(research|analy[sz]e|financial statement|earnings|stocks?|bonds?|treasur(?:y|ies)|portfolio)\b|研究|分析|财报|財報|美股|美债|美債|国债|國債|股票|持仓|持倉|polymarket|web3/iu],
];

/**
 * Trusted caller metadata is required. Prompt text is untrusted secondary evidence.
 * A 'ready' result grants no trading permission and performs no execution.
 */
export function resolveRoute(input, policy = createDefaultPolicy()) {
  const validation = validatePolicy(policy);
  const inputErrors = validateInput(input);
  const invalid = [...validation.errors, ...inputErrors];
  const dryRun = isRecord(input) && input.dryRun === false ? false : true;
  const base = {
    status: 'blocked', proposedRole: null, selectedRole: null,
    candidateModelRef: null, modelRef: null, reasonCodes: invalid,
    policyVersion: POLICY_VERSION, requiresReview: true, dryRun,
    requestBoundaryOnly: true, executionAuthorized: false,
    spend: { unit: null, estimate: null, remaining: null },
  };
  if (invalid.length) return base;

  const reasons = [];
  const metadata = input.metadata;
  let role = { low: 'fast', medium: 'standard', high: 'deep' }[metadata.complexity];
  reasons.push(`COMPLEXITY_${metadata.complexity.toUpperCase()}`);
  const raise = (floor, reason) => { role = maxRole(role, floor); reasons.push(reason); };
  if (metadata.risk === 'high') raise('deep', 'HIGH_RISK');
  if (metadata.impact === 'financial') raise('deep', 'FINANCIAL_IMPACT');
  if (metadata.impact === 'durable') raise('standard', 'DURABLE_IMPACT');
  for (const [key, value] of Object.entries(input.signals ?? {})) {
    if (value) raise('deep', { evidenceConflict: 'EVIDENCE_CONFLICT', thesisUpdate: 'THESIS_UPDATE', policyChange: 'POLICY_CHANGE' }[key]);
  }
  // NFKC handles full-width characters; invisible separators must not hide risk cues.
  const prompt = (input.prompt ?? '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  for (const [floor, reason, pattern] of PROMPT_RULES) if (pattern.test(prompt)) raise(floor, reason);
  if (input.manualRole) {
    if (ROLES.indexOf(input.manualRole) < ROLES.indexOf(role)) reasons.push('MANUAL_BELOW_FLOOR_IGNORED');
    else { role = input.manualRole; reasons.push('MANUAL_ROLE_REQUESTED'); }
  }

  const model = policy.models[role];
  const blockers = [];
  const execution = input.execution ?? {};
  if (execution.boundary === 'inflight') blockers.push('REQUEST_BOUNDARY_REQUIRED');
  const upgrading = execution.previousRole && ROLES.indexOf(role) > ROLES.indexOf(execution.previousRole);
  if ((execution.upgradesUsed ?? 0) + (upgrading ? 1 : 0) > policy.budget.maxUpgrades) blockers.push('UPGRADE_LIMIT');
  if ((execution.retriesUsed ?? 0) > policy.budget.maxRetries) blockers.push('RETRY_LIMIT');
  // Once a task requires a higher tier it cannot silently downgrade on subsequent attempts.
  if (execution.previousRole && ROLES.indexOf(role) < ROLES.indexOf(execution.previousRole)) blockers.push('DOWNGRADE_REQUIRES_NEW_TASK');
  if (!model.approved) blockers.push('MODEL_NOT_APPROVED');
  if (!model.ready) blockers.push('MODEL_NOT_READY');
  const capabilities = [...new Set(['text', ...(input.requiredCapabilities ?? [])])];
  if (capabilities.some((capability) => !model.capabilities.includes(capability))) blockers.push('MODEL_CAPABILITY_MISSING');
  const remaining = input.budget?.remainingUnits ?? null;
  if (model.estimatedUnits === null) blockers.push('COST_ESTIMATE_UNKNOWN');
  if (!input.budget || remaining === null) blockers.push('BUDGET_UNKNOWN');
  if (input.budget && input.budget.unit !== policy.budget.unit) blockers.push('BUDGET_UNIT_MISMATCH');
  if (remaining !== null && model.estimatedUnits !== null && model.estimatedUnits > remaining) blockers.push('BUDGET_EXCEEDED');
  const ready = blockers.length === 0;
  return {
    ...base,
    status: dryRun ? 'proposed' : ready ? 'ready' : 'blocked',
    proposedRole: role,
    selectedRole: !dryRun && ready ? role : null,
    candidateModelRef: model.modelRef,
    modelRef: !dryRun && ready ? model.modelRef : null,
    reasonCodes: [...reasons, ...blockers, ...(dryRun ? ['DRY_RUN_ONLY'] : [])],
    requiresReview: !ready,
    spend: { unit: policy.budget.unit, estimate: model.estimatedUnits, remaining },
  };
}
