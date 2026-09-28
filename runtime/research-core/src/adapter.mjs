import { POLICY_VERSION, resolveRoute } from './router.mjs';

const isRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => isRecord(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validProvider = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const validModel = (value) => typeof value === 'string' && /^[a-z][a-z0-9._-]{1,99}$/.test(value);

/** Prepare an override only; this neither registers a hook nor initiates a request. */
export function prepareTurn(input, policy) {
  const route = resolveRoute(input, policy);
  if (route.status !== 'ready' || route.dryRun || route.requiresReview || !route.modelRef) {
    return { route, modelOverride: null, verificationContext: null, executionAuthorized: false };
  }
  const [provider, model] = route.modelRef.split('/');
  return {
    route,
    modelOverride: { providerOverride: provider, modelOverride: model },
    verificationContext: { provider, model, policyVersion: route.policyVersion, role: route.selectedRole },
    executionAuthorized: false,
  };
}

/**
 * Compare trusted resolved SDK metadata with this turn's prepared selection.
 * Receipt/context must be extracted by trusted code, never supplied by a prompt.
 */
export function validateResolvedModel(receipt, context) {
  const reasons = [];
  if (!exactKeys(context, ['provider', 'model', 'policyVersion', 'role'])
    || !validProvider(context.provider) || !validModel(context.model)
    || context.policyVersion !== POLICY_VERSION || !['fast', 'standard', 'deep'].includes(context.role)) {
    reasons.push('VERIFICATION_CONTEXT_INVALID');
  }
  if (!exactKeys(receipt, ['provider', 'model']) || !validProvider(receipt.provider) || !validModel(receipt.model)) {
    reasons.push('RESOLVED_MODEL_RECEIPT_INVALID');
  }
  if (reasons.length) return { valid: false, reasonCodes: reasons, executionAuthorized: false };
  if (receipt.provider !== context.provider) reasons.push('RESOLVED_PROVIDER_MISMATCH');
  if (receipt.model !== context.model) reasons.push('RESOLVED_MODEL_MISMATCH');
  return { valid: reasons.length === 0, reasonCodes: reasons.length ? reasons : ['RESOLVED_MODEL_MATCH'], executionAuthorized: false };
}
