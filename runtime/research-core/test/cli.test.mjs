import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function call(command, input) {
  const result = spawnSync(process.execPath, [cli, command], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}
test('CLI exposes offline evaluation and keeps real model candidates inactive', () => {
  const evaluation = call('eval-offline', '');
  assert.equal(evaluation.status, 0);
  const report = JSON.parse(evaluation.stdout);
  assert.equal(report.total, 46); assert.equal(report.passed, report.total); assert.equal(report.modelCalls, 0);
  const route = call('route', { request: { metadata: { risk: 'high', impact: 'financial', complexity: 'high' }, dryRun: false } });
  assert.equal(route.status, 2);
  assert.equal(JSON.parse(route.stdout).modelRef, null);
});
test('CLI rejects malformed input without copying its content to errors', () => {
  const result = call('route', '{"private-placeholder":');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'JSON_INVALID' });
});
test('journal CLI persists a decision across processes and retries without duplicate records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-cli-'));
  const scope = { directory, agentId: 'main', environment: 'test' };
  const request = { kind: 'decision', idempotencyKey: 'fixture-1', data: { title: 'Wait for primary evidence',
    action: 'hold', reason: 'Synthetic integration fixture', evidence: [{ source: 'fixture', locator: 'fixture:1', observedAt: '2026-01-01T00:00:00Z' }],
    model: { provider: 'fixture', id: 'none', version: '1' }, strategy: { id: 'fixture', version: '1' } } };
  try {
    const first = call('journal-append', { scope, request }); assert.equal(first.status, 0, first.stderr);
    const duplicate = call('journal-append', { scope, request }); assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.deepEqual(JSON.parse(duplicate.stdout), JSON.parse(first.stdout));
    const list = call('journal-list', { scope, request: {} }); assert.equal(list.status, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).total, 1);
    const exported = call('journal-export', { scope, request: {} }); assert.equal(exported.status, 0, exported.stderr);
    assert.equal(JSON.parse(exported.stdout).records.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
