import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultPolicy } from '../src/router.mjs';
import { prepareTurn, validateResolvedModel } from '../src/adapter.mjs';

const metadata = { risk: 'low', impact: 'ephemeral', complexity: 'low' };
const input = () => ({ metadata, dryRun: false, budget: { unit: 'test-unit', remainingUnits: 10 } });
const approvedFixture = () => {
  const policy = createDefaultPolicy();
  policy.budget.unit = 'test-unit';
  for (const role of ['fast', 'standard', 'deep']) policy.models[role] = {
    modelRef: `fixture/${role}`, approved: true, ready: true, capabilities: ['text'], estimatedUnits: 1,
  };
  return policy;
};

test('default candidates never yield a gateway override', () => {
  const result = prepareTurn(input());
  assert.equal(result.route.status, 'blocked');
  assert.equal(result.modelOverride, null);
  assert.equal(result.verificationContext, null);
  assert.equal(result.executionAuthorized, false);
});

test('dry-run approved candidate remains a proposal without an override', () => {
  const result = prepareTurn({ ...input(), dryRun: true }, approvedFixture());
  assert.equal(result.route.status, 'proposed');
  assert.equal(result.modelOverride, null);
  assert.equal(result.verificationContext, null);
});

test('ready fixture has explicit provider and model override with verification context', () => {
  const result = prepareTurn(input(), approvedFixture());
  assert.deepEqual(result.modelOverride, { providerOverride: 'fixture', modelOverride: 'fast' });
  assert.deepEqual(result.verificationContext, {
    provider: 'fixture', model: 'fast', policyVersion: 'research-router/1', role: 'fast',
  });
  assert.equal(result.executionAuthorized, false);
  assert.deepEqual(validateResolvedModel({ provider: 'fixture', model: 'fast' }, result.verificationContext), {
    valid: true, reasonCodes: ['RESOLVED_MODEL_MATCH'], executionAuthorized: false,
  });
});

test('financial floor persists into the prepared override', () => {
  const result = prepareTurn({ ...input(), prompt: '买入半仓', manualRole: 'fast' }, approvedFixture());
  assert.equal(result.modelOverride.modelOverride, 'deep');
  assert.equal(result.verificationContext.role, 'deep');
});

test('budget and request boundary gates prevent overrides', () => {
  for (const extra of [
    { budget: { unit: 'test-unit', remainingUnits: null } },
    { budget: { unit: 'test-unit', remainingUnits: 0 } },
    { execution: { boundary: 'inflight' } },
    { requiredCapabilities: ['tools'] },
  ]) {
    const result = prepareTurn({ ...input(), ...extra }, approvedFixture());
    assert.equal(result.modelOverride, null);
    assert.equal(result.verificationContext, null);
  }
});

test('a missing cost estimate prevents overrides despite approval and readiness', () => {
  const policy = approvedFixture(); policy.models.fast.estimatedUnits = null;
  assert.equal(prepareTurn(input(), policy).modelOverride, null);
});

test('provider fallback, model fallback and aliases fail exact receipt verification', () => {
  const { verificationContext } = prepareTurn(input(), approvedFixture());
  for (const [receipt, expected] of [
    [{ provider: 'other', model: 'fast' }, 'RESOLVED_PROVIDER_MISMATCH'],
    [{ provider: 'fixture', model: 'standard' }, 'RESOLVED_MODEL_MISMATCH'],
    [{ provider: 'fixture', model: 'fast-latest' }, 'RESOLVED_MODEL_MISMATCH'],
  ]) {
    const result = validateResolvedModel(receipt, verificationContext);
    assert.equal(result.valid, false);
    assert.ok(result.reasonCodes.includes(expected));
    assert.equal(result.executionAuthorized, false);
  }
});

test('invalid or absent receipts fail closed without echoing arbitrary data', () => {
  const { verificationContext } = prepareTurn(input(), approvedFixture());
  const placeholder = 'never-print-this-placeholder';
  for (const receipt of [undefined, null, [], {}, { provider: 'fixture' },
    { provider: 'fixture', model: 'fixture/fast' }, { provider: 'Fixture', model: 'fast' },
    { provider: 'fixture', model: 'fast', secret: placeholder },
    { provider: 'fixture', model: null }, { provider: 42, model: 'fast' }]) {
    const result = validateResolvedModel(receipt, verificationContext);
    assert.equal(result.valid, false);
    assert.ok(result.reasonCodes.includes('RESOLVED_MODEL_RECEIPT_INVALID'));
    assert.equal(JSON.stringify(result).includes(placeholder), false);
  }
});

test('absent or modified verification context cannot validate a receipt', () => {
  const { verificationContext } = prepareTurn(input(), approvedFixture());
  for (const context of [undefined, null, [], {},
    { ...verificationContext, policyVersion: 'old' }, { ...verificationContext, role: 'unknown' },
    { ...verificationContext, approved: true }, { ...verificationContext, model: '' }]) {
    const result = validateResolvedModel({ provider: 'fixture', model: 'fast' }, context);
    assert.equal(result.valid, false);
    assert.ok(result.reasonCodes.includes('VERIFICATION_CONTEXT_INVALID'));
  }
});

test('preparation and verification are deterministic and do not mutate callers', () => {
  const request = input(); const policy = approvedFixture();
  const before = structuredClone({ request, policy });
  const prepared = prepareTurn(request, policy);
  assert.deepEqual(prepareTurn(request, policy), prepared);
  const receipt = Object.freeze({ provider: 'fixture', model: 'fast' });
  Object.freeze(prepared.verificationContext);
  assert.equal(validateResolvedModel(receipt, prepared.verificationContext).valid, true);
  assert.deepEqual({ request, policy }, before);
});
