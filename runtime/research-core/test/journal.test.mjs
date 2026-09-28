import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createJournal, JournalError } from '../src/journal.mjs';

const moduleUrl = new URL('../src/journal.mjs', import.meta.url).href;
const evidence = [{ source: 'Synthetic test fixture', locator: 'fixture:release-1', observedAt: '2026-01-01T00:00:00Z' }];
const common = { title: 'Synthetic forecast', evidence, model: { provider: 'fixture', id: 'fixture-model', version: '1' }, strategy: { id: 'fixture-strategy', version: '1' } };
const prediction = (overrides = {}) => ({ ...common, probability: 0.7, dueAt: new Date(Date.now() + 86400000).toISOString(), resolutionCriterion: 'Fixture event equals one by the deadline', ...overrides });
const decision = (overrides = {}) => ({ ...common, title: 'Synthetic decision', action: 'hold', reason: 'Insufficient synthetic evidence', ...overrides });
const hasCode = (code) => (error) => error instanceof JournalError && error.code === code;

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'research-journal-test-'));
  const handles = [];
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = (agentId = 'main', environment = 'test') => {
    const journal = createJournal({ directory, agentId, environment });
    handles.push(journal);
    return journal;
  };
  return { directory, open, filename: path.join(directory, 'main/test/journal.sqlite') };
}

function child(input, operation = 'append') {
  const script = `
    import { createJournal } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.argv[1]);
    const journal = createJournal(input.options);
    try { console.log(JSON.stringify({ record: journal[${JSON.stringify(operation)}](input.request) })); }
    catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
    finally { journal.close(); }
  `;
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const processHandle = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment });
    let stdout = '';
    let stderr = '';
    processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
    processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
    processHandle.on('error', reject);
    processHandle.on('close', (code) => {
      if (code !== 0) reject(new Error(`Fixture child failed: ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
}

test('append revisions preserve history, provenance, scope and reopen correctly', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const data = prediction();
  const first = journal.append({ kind: 'prediction', data, idempotencyKey: 'forecast-1' });
  const second = journal.append({ kind: 'prediction', id: first.id, expectedVersion: 1, data: { ...data, probability: 0.6 }, idempotencyKey: 'forecast-2' });
  data.model = { ...data.model, version: 'mutated-return-source' };
  second.data.probability = 0;
  assert.equal(journal.get(first.id).data.probability, 0.6);
  assert.equal(journal.get(first.id, { version: 1 }).data.probability, 0.7);
  assert.equal(journal.get(first.id, { version: 1 }).data.model.version, '1');
  assert.deepEqual(journal.history(first.id).map((record) => record.version), [1, 2]);
  assert.deepEqual(first.scope, { agentId: 'main', environment: 'test' });
  journal.close();
  assert.equal(open().get(first.id).version, 2);
  assert.throws(() => journal.list(), hasCode('CLOSED'));
});

test('idempotency accepts exact retries including changed key order and rejects mismatches', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const data = decision();
  const first = journal.append({ kind: 'decision', data, idempotencyKey: 'idempotent-1' });
  const reordered = Object.fromEntries(Object.entries(data).reverse());
  assert.deepEqual(journal.append({ idempotencyKey: 'idempotent-1', kind: 'decision', data: reordered, expectedVersion: 0 }), first);
  assert.throws(() => journal.append({ kind: 'decision', data: { ...data, action: 'buy' }, idempotencyKey: 'idempotent-1' }), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(journal.list().total, 1);
});

test('optimistic versions prevent overwrites and kind changes', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const initial = journal.append({ kind: 'decision', data: decision(), id: 'fixed-id', idempotencyKey: 'version-1' });
  assert.throws(() => journal.append({ kind: 'decision', data: decision(), id: initial.id, idempotencyKey: 'version-duplicate' }), hasCode('VERSION_CONFLICT'));
  assert.throws(() => journal.append({ kind: 'decision', data: decision(), id: initial.id, expectedVersion: 2, idempotencyKey: 'version-stale' }), hasCode('VERSION_CONFLICT'));
  assert.throws(() => journal.append({ kind: 'prediction', data: prediction(), id: initial.id, expectedVersion: 1, idempotencyKey: 'version-kind' }), hasCode('VALIDATION'));
  assert.deepEqual(journal.history(initial.id), [initial]);
});

test('schemas reject malformed probabilities, timestamps, actions, provenance and extra scope', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const invalid = [prediction({ probability: -0.1 }), prediction({ probability: 1.1 }), prediction({ probability: NaN }),
    prediction({ dueAt: '2030-02-30T12:00:00Z' }), prediction({ dueAt: '2030-01-01' }), prediction({ dueAt: '2000-01-01T00:00:00Z' }),
    prediction({ evidence: [] }), prediction({ resolutionCriterion: '' }), prediction({ model: { id: 'model' } }), prediction({ unexpected: true })];
  invalid.forEach((data, index) => assert.throws(() => journal.append({ kind: 'prediction', data, idempotencyKey: `invalid-${index}` }), hasCode('VALIDATION')));
  assert.throws(() => journal.append({ kind: 'decision', data: decision({ action: 'execute-transfer' }), idempotencyKey: 'invalid-action' }), hasCode('VALIDATION'));
  assert.throws(() => journal.append({ kind: 'decision', data: decision(), scope: { agentId: 'other' }, idempotencyKey: 'invalid-scope' }), hasCode('VALIDATION'));
  assert.throws(() => journal.append({ kind: 'decision', data: decision(), expectedVersion: null, idempotencyKey: 'null-version' }), hasCode('VALIDATION'));
  assert.equal(journal.list().total, 0);
});

test('agent and environment namespaces isolate queries, references and idempotency keys', (t) => {
  const { open } = fixture(t);
  const main = open();
  const group = open('group-tim');
  const paper = open('main', 'paper');
  const stored = main.append({ kind: 'decision', data: decision(), idempotencyKey: 'shared-key' });
  assert.equal(group.get(stored.id), null);
  assert.equal(paper.get(stored.id), null);
  assert.equal(JSON.parse(group.exportJson()).total, 0);
  const review = { ...common, target: { id: stored.id, version: 1 }, result: 'Synthetic result', lessons: ['Check source'], evidence };
  assert.throws(() => group.append({ kind: 'review', data: review, idempotencyKey: 'review' }), hasCode('NOT_FOUND'));
  assert.throws(() => main.list({ agentId: 'group-tim' }), hasCode('VALIDATION'));
  const independent = group.append({ kind: 'decision', data: decision(), idempotencyKey: 'shared-key' });
  assert.notEqual(stored.id, independent.id);
  assert.equal(main.list().total, 1);
});

test('reviews reference exact historical versions without changing originals', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const first = journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'decision' });
  const data = { ...common, target: { id: first.id, version: 1 }, result: 'The test decision did not execute an order', lessons: ['Record non-actions'] };
  const review = journal.append({ kind: 'review', data, idempotencyKey: 'review' });
  assert.deepEqual(journal.get(first.id), first);
  assert.equal(journal.get(review.id).data.target.id, first.id);
  assert.throws(() => journal.append({ kind: 'review', data: { ...data, target: { id: first.id, version: 10 } }, idempotencyKey: 'missing-version' }), hasCode('NOT_FOUND'));
});

test('resolution is append-only, idempotent and Brier statistics use original forecasts', (t) => {
  const { open } = fixture(t);
  const journal = open();
  assert.equal(journal.statistics().score, null);
  assert.equal(journal.statistics().sampleSufficient, false);
  const data = prediction({ probability: 0.7 });
  const first = journal.append({ kind: 'prediction', data, idempotencyKey: 'prediction' });
  const revised = journal.append({ kind: 'prediction', id: first.id, expectedVersion: 1, data: { ...data, probability: 0.99 }, idempotencyKey: 'revised-prediction' });
  const request = { id: first.id, expectedVersion: 2, outcome: 1, resolvedAt: new Date().toISOString(), reason: 'Synthetic event resolved', evidence, idempotencyKey: 'resolved' };
  const resolution = journal.resolvePrediction(request);
  assert.equal(resolution.kind, 'resolution');
  assert.notEqual(resolution.id, first.id);
  assert.deepEqual(journal.resolvePrediction(request), resolution);
  assert.deepEqual(journal.get(first.id), revised);
  assert.throws(() => journal.resolvePrediction({ ...request, idempotencyKey: 'second-resolution' }), hasCode('ALREADY_RESOLVED'));
  assert.throws(() => journal.resolvePrediction({ ...request, outcome: 0 }), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => journal.append({ kind: 'prediction', id: first.id, expectedVersion: 2, data, idempotencyKey: 'after-resolution' }), hasCode('ALREADY_RESOLVED'));
  const stats = journal.statistics();
  assert.equal(stats.resolvedCount, 1);
  assert.ok(Math.abs(stats.score - 0.09) < 1e-10);
  assert.equal(stats.sampleSufficient, false);
  assert.equal(stats.investmentPerformance, false);
  assert.equal(journal.statistics({ minSampleSize: 1 }).sampleSufficient, true);
});

test('prediction event definition cannot be revised and false chronology is rejected', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const data = prediction();
  const first = journal.append({ kind: 'prediction', data, idempotencyKey: 'prediction' });
  assert.throws(() => journal.append({ kind: 'prediction', id: first.id, expectedVersion: 1, data: { ...data, resolutionCriterion: 'Changed event' }, idempotencyKey: 'changed-definition' }), hasCode('VALIDATION'));
  const base = { id: first.id, expectedVersion: 1, outcome: 1, reason: 'Synthetic event', evidence, idempotencyKey: 'bad-resolution' };
  assert.throws(() => journal.resolvePrediction({ ...base, resolvedAt: '2000-01-01T00:00:00Z' }), hasCode('VALIDATION'));
  assert.throws(() => journal.resolvePrediction({ ...base, resolvedAt: new Date(Date.now() + 100000).toISOString() }), hasCode('VALIDATION'));
  assert.throws(() => journal.resolvePrediction({ ...base, resolvedAt: new Date().toISOString(), evidence: undefined }), hasCode('VALIDATION'));
  assert.equal(journal.list({ kind: 'resolution' }).total, 0);
});

test('every appended or revised evidence observation must precede server creation', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const { open } = fixture(t);
  const journal = open();
  const initial = journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'initial' });
  const invalidEvidence = [...evidence, { ...evidence[0], observedAt: '2030-01-01T00:00:00.001Z' }];
  for (const [kind, data] of [
    ['prediction', prediction({ evidence: invalidEvidence })],
    ['decision', decision({ evidence: invalidEvidence })],
    ['review', { ...common, evidence: invalidEvidence, target: { id: initial.id, version: 1 }, result: 'Synthetic review', lessons: [] }],
  ]) {
    assert.throws(() => journal.append({ kind, data, idempotencyKey: `future-${kind}` }), hasCode('VALIDATION'));
  }
  assert.throws(() => journal.append({ kind: 'decision', id: initial.id, expectedVersion: 1,
    data: decision({ evidence: invalidEvidence }), idempotencyKey: 'future-revision' }), hasCode('VALIDATION'));
  assert.deepEqual(journal.history(initial.id), [initial]);
  assert.equal(journal.list().total, 1);
});

test('evidence at creation time is accepted while a prediction deadline remains future', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const { open } = fixture(t);
  const journal = open();
  const data = prediction({ evidence: [{ ...evidence[0], observedAt: '2030-01-01T00:00:00Z' }] });
  const first = journal.append({ kind: 'prediction', data, idempotencyKey: 'boundary' });
  assert.equal(Date.parse(first.data.evidence[0].observedAt), Date.parse(first.createdAt));
  assert.ok(Date.parse(first.data.dueAt) > Date.parse(first.createdAt));
  assert.deepEqual(journal.get(first.id), first);
});

test('resolution rejects future evidence without settling the prediction', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const { open } = fixture(t);
  const journal = open();
  const first = journal.append({ kind: 'prediction', data: prediction(), idempotencyKey: 'prediction' });
  const request = { id: first.id, expectedVersion: 1, outcome: 1, resolvedAt: first.createdAt,
    reason: 'Synthetic event decided', evidence: [...evidence, { ...evidence[0], observedAt: '2030-01-01T00:00:00.001Z' }], idempotencyKey: 'resolution' };
  assert.throws(() => journal.resolvePrediction(request), hasCode('VALIDATION'));
  assert.equal(journal.statistics().resolvedCount, 0);
  const valid = journal.resolvePrediction({ ...request, evidence: [{ ...evidence[0], observedAt: first.createdAt }] });
  assert.equal(valid.createdAt, first.createdAt);
  assert.equal(journal.statistics().resolvedCount, 1);
});

test('rehashed future evidence is corrupt relative to original creation, even after time passes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const { open, filename } = fixture(t);
  const journal = open();
  const original = journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'initial' });
  const direct = new DatabaseSync(filename);
  t.after(() => direct.close());
  // Recompute otherwise-consistent hashes to prove the chronology check itself
  // catches invalid evidence, rather than merely detecting a changed payload.
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
  const data = { ...original.data, evidence: [{ ...evidence[0], observedAt: '2030-01-01T00:00:00.001Z' }] };
  const record = { ...original, data };
  const requestHash = hash({ operation: 'append', kind: 'decision', data, id: null, expectedVersion: 0 });
  const recordHash = hash({ record, sequence: 1, idempotencyKey: 'initial', requestHash, previousHash: '' });
  direct.exec('DROP TRIGGER events_no_update');
  direct.prepare('UPDATE events SET data_json = ?, request_hash = ?, record_hash = ? WHERE id = ?')
    .run(canonical(data), requestHash, recordHash, original.id);
  t.mock.timers.tick(1000);
  assert.throws(() => journal.list(), hasCode('CORRUPT_STORE'));
  assert.throws(() => journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'next' }), hasCode('CORRUPT_STORE'));
  assert.equal(direct.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
  journal.close();
  assert.throws(() => open(), hasCode('CORRUPT_STORE'));
});

test('list returns current versions while paginated export includes every revision', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const first = journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'first' });
  journal.append({ kind: 'decision', id: first.id, expectedVersion: 1, data: decision({ reason: 'New evidence' }), idempotencyKey: 'revision' });
  journal.append({ kind: 'prediction', data: prediction(), idempotencyKey: 'other' });
  assert.equal(journal.list().total, 2);
  assert.equal(journal.list({ kind: 'decision' }).records[0].version, 2);
  const page = JSON.parse(journal.exportJson({ limit: 2 }));
  assert.equal(page.total, 3);
  assert.equal(page.nextOffset, 2);
  assert.equal(page.records[0].version, 1);
  assert.equal(JSON.parse(journal.exportJson({ offset: 2 })).nextOffset, null);
  assert.throws(() => journal.list({ limit: 1001 }), hasCode('VALIDATION'));
  assert.throws(() => journal.exportJson({ limit: null }), hasCode('VALIDATION'));
});

test('export has a byte cap and records have a bounded payload', (t) => {
  const { open } = fixture(t);
  const journal = open();
  const longEvidence = Array.from({ length: 24 }, (_, index) => ({ ...evidence[0], source: `source-${index}`, locator: 'x'.repeat(1800) }));
  for (let index = 0; index < 45; index++) journal.append({ kind: 'decision', data: decision({ evidence: longEvidence, reason: 'r'.repeat(14000) }), idempotencyKey: `large-${index}` });
  const exported = journal.exportJson({ limit: 1000 });
  assert.ok(Buffer.byteLength(exported) <= 2 * 1024 * 1024);
  const page = JSON.parse(exported);
  assert.ok(page.records.length < 45 && page.records.length > 0);
  assert.equal(page.nextOffset, page.records.length);
  assert.throws(() => journal.append({ kind: 'decision', data: decision({ evidence: [...longEvidence, ...longEvidence], reason: 'r'.repeat(14000) }), idempotencyKey: 'oversized' }), hasCode('VALIDATION'));
});

test('storage rejects traversal, symlinks and permissive modes; created paths are private', (t) => {
  const { directory, open, filename } = fixture(t);
  const journal = open();
  assert.equal(lstatSync(filename).mode & 0o777, 0o600);
  assert.equal(lstatSync(path.dirname(filename)).mode & 0o777, 0o700);
  assert.throws(() => createJournal({ directory, agentId: '../main', environment: 'test' }), hasCode('VALIDATION'));
  assert.throws(() => createJournal({ directory: `${directory}/../escape`, agentId: 'main', environment: 'test' }), hasCode('VALIDATION'));
  symlinkSync(path.join(directory, 'main'), path.join(directory, 'linked-agent'));
  assert.throws(() => createJournal({ directory, agentId: 'linked-agent', environment: 'test' }), hasCode('UNSAFE_STORAGE'));
  symlinkSync(directory, path.join(directory, 'linked-root'));
  assert.throws(() => createJournal({ directory: path.join(directory, 'linked-root'), agentId: 'main', environment: 'test' }), hasCode('UNSAFE_STORAGE'));
  chmodSync(filename, 0o644);
  assert.throws(() => journal.list(), hasCode('UNSAFE_STORAGE'));
  chmodSync(filename, 0o600);
  journal.close();
  rmSync(filename);
  const target = path.join(directory, 'outside');
  writeFileSync(target, 'unchanged', { mode: 0o600 });
  symlinkSync(target, filename);
  assert.throws(() => open(), hasCode('UNSAFE_STORAGE'));
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
});

test('physical corruption fails closed and is not repaired or overwritten', (t) => {
  const { open, filename } = fixture(t);
  const journal = open();
  journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'first' });
  journal.close();
  const corrupt = Buffer.from('corrupt journal fixture');
  writeFileSync(filename, corrupt);
  assert.throws(() => open(), hasCode('STORAGE'));
  assert.deepEqual(readFileSync(filename), corrupt);
});

test('an existing truncated zero-byte journal is never silently reinitialized', (t) => {
  const { open, filename } = fixture(t);
  const journal = open();
  journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'first' });
  journal.close();
  writeFileSync(filename, '');
  assert.throws(() => open(), hasCode('STORAGE'));
  assert.equal(readFileSync(filename).length, 0);
});

test('logical corruption fails closed and append-only triggers block direct overwrites', (t) => {
  const { open, filename } = fixture(t);
  const journal = open();
  const first = journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'first' });
  const direct = new DatabaseSync(filename);
  t.after(() => direct.close());
  assert.throws(() => direct.prepare('UPDATE events SET version = 99 WHERE id = ?').run(first.id), /immutable/);
  direct.exec('DROP TRIGGER events_no_update');
  direct.prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(decision({ action: 'buy' })), first.id);
  assert.throws(() => journal.list(), hasCode('CORRUPT_STORE'));
  assert.throws(() => journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'next' }), hasCode('CORRUPT_STORE'));
  assert.equal(direct.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('concurrent processes with one idempotency key commit exactly once', async (t) => {
  const { directory, open } = fixture(t);
  const request = { kind: 'decision', data: decision(), idempotencyKey: 'concurrent-one' };
  const results = await Promise.all(Array.from({ length: 6 }, () => child({ options: { directory, agentId: 'main', environment: 'test' }, request })));
  assert.ok(results.every((result) => result.record?.id === results[0].record?.id));
  assert.equal(open().list().total, 1);
});

test('concurrent optimistic revisions allow one writer and reject stale writers', async (t) => {
  const { directory, open } = fixture(t);
  const journal = open();
  const first = journal.append({ kind: 'decision', data: decision(), idempotencyKey: 'initial' });
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => child({ options: { directory, agentId: 'main', environment: 'test' },
    request: { kind: 'decision', id: first.id, expectedVersion: 1, data: decision({ reason: `Writer ${index}` }), idempotencyKey: `writer-${index}` } })));
  assert.equal(results.filter((result) => result.record).length, 1);
  assert.equal(results.filter((result) => result.code === 'VERSION_CONFLICT').length, 5);
  assert.equal(journal.history(first.id).length, 2);
});

test('concurrent distinct writers preserve every event and unique id', async (t) => {
  const { directory, open } = fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => child({ options: { directory, agentId: 'main', environment: 'test' },
    request: { kind: 'decision', data: decision({ reason: `Writer ${index}` }), idempotencyKey: `writer-${index}` } })));
  assert.ok(results.every((result) => result.record));
  assert.equal(new Set(results.map((result) => result.record.id)).size, 6);
  assert.equal(open().list().total, 6);
});
