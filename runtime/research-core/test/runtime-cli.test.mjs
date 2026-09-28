import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createResearchHost } from '../src/host.mjs';
import { exerciseRuntime, syntheticTask, runRuntimeDemo } from '../src/runtime-demo.mjs';

const cli = fileURLToPath(new URL('../src/runtime-cli.mjs', import.meta.url));
function fixture(t) { const directory = mkdtempSync(join(tmpdir(), 'runtime-cli-test-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
function call(directory, command, input, operator = false, environment = 'test', extra = []) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [cli, command, '--state', directory, '--agent', 'main', '--environment', environment,
    ...(operator ? ['--operator-test'] : []), ...extra], { env, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
}
test('public runtime CLI persists a full source, forecast, resolution and review across process restarts', t => {
  const directory = fixture(t);
  const report = exerciseRuntime((command, request, operator) => {
    const result = call(directory, command, request, operator);
    assert.equal(result.status, 0, result.stderr); const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.scope, { agentId: 'main', environment: 'test' });
    assert.equal(payload.externalCalls, 0); assert.equal(payload.tradingAuthorized, false); return payload.result;
  });
  assert.equal(report.submissionDeduplicated, true); assert.equal(report.candidateInitiallyUnverified, true);
  assert.equal(report.workflowCompleted, true); assert.equal(report.publicationDeduplicated, true); assert.equal(report.reviewDeduplicated, true);
  assert.deepEqual(report.journalKinds, ['prediction','resolution','review']);
  assert.equal(report.originalProbability, 0.6); assert.equal(report.resolutionRecorded, true);
  assert.equal(report.calibration.resolvedCount, 1); assert.equal(report.calibration.sampleSufficient, false);
  assert.ok(Math.abs(report.calibration.score - 0.16) < 1e-12);
  assert.equal(report.productionTradingAuthorized, false);
});
test('model host and default CLI cannot verify, commit, resolve, review or change scope', t => {
  const directory = fixture(t);
  const host = createResearchHost({ directory, agentId: 'main', environment: 'test', actorId: 'fixture', mode: 'agent' });
  t.after(() => host.close());
  for (const command of ['evidence-verify','task-commit','task-reconcile','review-create','prediction-resolve','journal-list']) {
    assert.throws(() => host.execute(command, {}), error => error.code === 'HOST_OPERATION_FORBIDDEN');
  }
  assert.throws(() => host.execute('task-submit', { ...syntheticTask(), scope: { agentId: 'other' } }), error => error.code === 'VALIDATION');
  const result = call(directory, 'task-commit', { approved: true, actorId: 'owner' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'HOST_OPERATION_FORBIDDEN');
});
test('operator test mode cannot operate paper/live or certify a real model receipt', t => {
  const directory = fixture(t);
  for (const environment of ['paper','live']) {
    const result = call(directory, 'task-list', {}, true, environment);
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).error, 'HOST_OPTIONS_INVALID');
  }
  const host = createResearchHost({ directory, agentId: 'main', environment: 'test', actorId: 'fixture', mode: 'operator-test' });
  try { assert.throws(() => host.execute('task-commit', { modelReceipt: { provider: 'anthropic', id: 'selected-label', version: '1' } }), error => error.code === 'HOST_FIXTURE_RECEIPT_REQUIRED'); }
  finally { host.close(); }
});
test('runtime CLI rejects malformed, oversized and duplicate arguments without echoing input', t => {
  const directory = fixture(t);
  for (const [input, extras, expected] of [
    ['{"SENSITIVE_FIXTURE":', [], 'JSON_INVALID'], ['x'.repeat(300 * 1024), [], 'INPUT_TOO_LARGE'],
    [{}, ['--agent','other'], 'ARGUMENTS_INVALID'],
  ]) {
    const result = call(directory, 'task-list', input, false, 'test', extras);
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).error, expected);
    assert.equal(result.stderr.includes('SENSITIVE_FIXTURE'), false);
  }
});
test('runtime demo closes and reopens all handles between stages without external work', () => {
  const result = runRuntimeDemo(); assert.equal(result.workflowCompleted, true);
  assert.equal(result.externalModelCalls, 0); assert.equal(result.telegramMessages, 0); assert.equal(result.brokerOrders, 0);
});
