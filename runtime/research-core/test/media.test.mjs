import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createMediaGateway, defaultMediaPolicy } from '../src/media.mjs';
import { createBudgetLedger } from '../src/budget.mjs';

const owner = Object.freeze({ actor: 'synthetic-owner' });
const auth = (_request, context) => context === owner ? { actorId: 'fixture-owner' } : null;
const hasCode = code => error => error?.code === code;
const bytesFor = kind => {
  const bytes = Buffer.alloc(64);
  if (kind === 'image') Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  if (kind === 'audio') { bytes.write('RIFF', 0); bytes.write('WAVE', 8); }
  if (kind === 'video') { bytes.writeUInt32BE(24, 0); bytes.write('ftypisom', 4); }
  bytes.write('synthetic fixture', 20);
  return bytes;
};
function enabledPolicy() {
  const policy = defaultMediaPolicy();
  for (const kind of ['image', 'audio', 'video']) policy.read[kind] = { enabled: true, modelRef: 'fixture/model-v1', estimatedUnits: 10 };
  policy.send = { image: true, video: true }; policy.recipientIds = ['12345']; policy.timeoutMs = 100;
  return policy;
}
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'media-fixture-'));
  const sources = path.join(directory, 'sources'); mkdirSync(sources);
  const handles = [];
  t.after(() => { for (const handle of handles.reverse()) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  const ledger = createBudgetLedger({ directory, accountId: 'fixture-account', environment: 'test', unit: 'usd-micro', limitUnits: 100 }); handles.push(ledger);
  const source = (kind, name = `${kind}.fixture`, bytes = bytesFor(kind)) => { const file = path.join(sources, name); writeFileSync(file, bytes); return file; };
  const open = ({ policy = enabledPolicy(), authorize = auth, backend = {}, agentId = 'main', environment = 'test', suppliedLedger = ledger, sourceRoots = [sources] } = {}) => {
    const gateway = createMediaGateway({ directory, agentId, environment, sourceRoots, policy, ledger: suppliedLedger, backend, authorize }); handles.push(gateway); return gateway;
  };
  return { directory, sources, ledger, source, open };
}

test('media read and send are default denied and payload cannot forge authorization', async t => {
  const f = fixture(t); let calls = 0;
  const backend = { canAnalyze: () => true, analyze: () => { calls++; }, send: () => { calls++; } };
  const gateway = f.open({ backend, authorize: () => null });
  const image = gateway.ingest({ path: f.source('image'), kind: 'image' });
  await assert.rejects(gateway.analyze({ mediaId: image.id, question: 'describe', idempotencyKey: 'read-1' }, { actorId: 'fixture-owner', approved: true }), hasCode('MEDIA_NOT_AUTHORIZED'));
  await assert.rejects(gateway.send({ mediaId: image.id, recipientId: '12345', caption: '', idempotencyKey: 'send-1' }, owner), hasCode('MEDIA_NOT_AUTHORIZED'));
  await assert.rejects(gateway.analyze({ mediaId: image.id, question: '', idempotencyKey: 'read-2', approved: true }, owner), hasCode('MEDIA_INPUT_INVALID'));
  const defaults = f.open({ backend, policy: defaultMediaPolicy() });
  await assert.rejects(defaults.analyze({ mediaId: image.id, question: 'describe', idempotencyKey: 'read-3' }, owner), hasCode('MEDIA_READ_NOT_READY'));
  assert.equal(calls, 0); assert.equal(f.ledger.summary().reservationCount, 0);
});

test('ingest rejects URLs, path traversal, root lookalikes, symlinks and unsupported magic', t => {
  const f = fixture(t); const gateway = f.open(); const file = f.source('image');
  for (const input of ['https://example.invalid/file.png', 'relative.png', `${f.sources}/../image.png`]) assert.throws(() => gateway.ingest({ path: input, kind: 'image' }), hasCode('MEDIA_INPUT_INVALID'));
  const sibling = `${f.sources}-other`; mkdirSync(sibling); const outside = path.join(sibling, 'file.png'); writeFileSync(outside, bytesFor('image'));
  assert.throws(() => gateway.ingest({ path: outside, kind: 'image' }), hasCode('MEDIA_PATH_OUTSIDE_ROOT'));
  symlinkSync(file, path.join(f.sources, 'linked.png'));
  assert.throws(() => gateway.ingest({ path: path.join(f.sources, 'linked.png'), kind: 'image' }), hasCode('MEDIA_PATH_UNSAFE'));
  symlinkSync(sibling, path.join(f.sources, 'linked-dir'));
  assert.throws(() => gateway.ingest({ path: path.join(f.sources, 'linked-dir/file.png'), kind: 'image' }), hasCode('MEDIA_PATH_UNSAFE'));
  assert.throws(() => f.open({ sourceRoots: [path.join(f.sources, 'linked-dir')] }), hasCode('MEDIA_PATH_UNSAFE'));
  assert.throws(() => gateway.ingest({ path: f.source('image', 'spoof.png', Buffer.alloc(64, 1)), kind: 'image' }), hasCode('MEDIA_FORMAT_UNSUPPORTED'));
});

test('size caps and kind magic are enforced before backend dispatch', t => {
  const f = fixture(t); const policy = enabledPolicy(); policy.maxBytes.image = 32;
  const small = f.open({ policy });
  assert.throws(() => small.ingest({ path: f.source('image'), kind: 'image' }), hasCode('MEDIA_SIZE_INVALID'));
  const gateway = f.open();
  assert.throws(() => gateway.ingest({ path: f.source('image', 'empty', Buffer.alloc(0)), kind: 'image' }), hasCode('MEDIA_SIZE_INVALID'));
  assert.throws(() => gateway.ingest({ path: f.source('audio'), kind: 'image' }), hasCode('MEDIA_FORMAT_UNSUPPORTED'));
  assert.throws(() => gateway.ingest({ path: f.sources, kind: 'image' }));
});

test('all three read kinds use immutable snapshots, settled real ledger and pending verification', async t => {
  const f = fixture(t); const seen = [];
  const gateway = f.open({ backend: { canAnalyze: () => true, async analyze(request) { seen.push(request);
    return { provider: 'fixture', model: 'model-v1', costUnits: 3, output: `Synthetic ${request.media.kind} interpretation` }; } } });
  for (const kind of ['image', 'audio', 'video']) {
    const original = bytesFor(kind); const file = f.source(kind); const media = gateway.ingest({ path: file, kind });
    writeFileSync(file, Buffer.alloc(64, 0xff));
    const result = await gateway.analyze({ mediaId: media.id, question: 'summarize', idempotencyKey: `read-${kind}` }, owner);
    assert.equal(result.status, 'completed'); assert.equal(result.verification, 'pending'); assert.equal(result.source.kind, kind);
    assert.deepEqual(seen.at(-1).media.bytes, original);
    assert.match(seen.at(-1).prompt, /untrusted source material/);
    assert.equal(result.source.contentSha256, createHash('sha256').update(original).digest('hex'));
  }
  assert.equal(f.ledger.summary().spentUnits, 9); assert.equal(f.ledger.summary().heldUnits, 0);
});

test('unknown cost freezes account and prevents another backend request', async t => {
  const f = fixture(t); let calls = 0;
  const gateway = f.open({ backend: { canAnalyze: () => true, async analyze() { calls++; return { provider: 'fixture', model: 'model-v1', output: 'Synthetic text' }; } } });
  const media = gateway.ingest({ path: f.source('image'), kind: 'image' });
  const first = await gateway.analyze({ mediaId: media.id, question: '', idempotencyKey: 'unknown-cost' }, owner);
  assert.equal(first.status, 'needs-review'); assert.equal(f.ledger.summary().frozen, true); assert.equal(f.ledger.summary().counts.unknown, 1);
  const second = await gateway.analyze({ mediaId: media.id, question: '', idempotencyKey: 'next-read' }, owner);
  assert.equal(second.status, 'blocked'); assert.equal(calls, 1);
});

test('a lost acknowledgement after ledger start commits freezes its actual started state without invoking backend', async t => {
  const f = fixture(t); let calls = 0;
  const suppliedLedger = { ...f.ledger, start(request) { f.ledger.start(request); throw new Error('Synthetic lost start acknowledgement'); } };
  const gateway = f.open({ suppliedLedger, backend: { canAnalyze: () => true, async analyze() { calls++; throw new Error('Must not dispatch'); } } });
  const media = gateway.ingest({ path: f.source('image'), kind: 'image' });
  const result = await gateway.analyze({ mediaId: media.id, question: '', idempotencyKey: 'start-committed-ack-lost' }, owner);
  assert.equal(result.status, 'needs-review'); assert.equal(calls, 0);
  assert.equal(f.ledger.get(result.reservationId).state, 'unknown');
  const summary = f.ledger.summary();
  assert.equal(summary.frozen, true); assert.equal(summary.heldUnits, 10); assert.equal(summary.counts.unknown, 1);
});

test('a start failure before commit cancels the still-reserved budget and releases the hold', async t => {
  const f = fixture(t); let calls = 0;
  const suppliedLedger = { ...f.ledger, start() { throw new Error('Synthetic failure before start commit'); } };
  const gateway = f.open({ suppliedLedger, backend: { canAnalyze: () => true, async analyze() { calls++; throw new Error('Must not dispatch'); } } });
  const media = gateway.ingest({ path: f.source('image'), kind: 'image' });
  const result = await gateway.analyze({ mediaId: media.id, question: '', idempotencyKey: 'start-not-committed' }, owner);
  assert.equal(result.status, 'needs-review'); assert.equal(calls, 0);
  assert.equal(f.ledger.get(result.reservationId).state, 'cancelled');
  const summary = f.ledger.summary();
  assert.equal(summary.frozen, false); assert.equal(summary.heldUnits, 0); assert.equal(summary.spentUnits, 0);
  assert.equal(summary.availableUnits, 100); assert.equal(summary.counts.cancelled, 1);
});

test('actual cost above the reservation is accounted, freezes new spending and withholds completion', async t => {
  const f = fixture(t);
  const gateway = f.open({ backend: { canAnalyze: () => true, async analyze() {
    return { provider: 'fixture', model: 'model-v1', costUnits: 15, output: 'DO_NOT_RELEASE_COST_OVERRUN' };
  } } });
  const media = gateway.ingest({ path: f.source('image'), kind: 'image' });
  const result = await gateway.analyze({ mediaId: media.id, question: '', idempotencyKey: 'actual-over-estimate' }, owner);
  assert.equal(result.status, 'needs-review'); assert.ok(result.reasonCodes.includes('MEDIA_COST_OVERRUN'));
  assert.equal(JSON.stringify(result).includes('DO_NOT_RELEASE_COST_OVERRUN'), false);
  assert.equal(f.ledger.get(result.reservationId).state, 'settled');
  const summary = f.ledger.summary();
  assert.equal(summary.spentUnits, 15); assert.equal(summary.heldUnits, 0); assert.equal(summary.frozen, true);
  assert.ok(summary.freezeReasons.includes('reservation-overrun'));
});

test('after the first read binds a budget account a different injected account is rejected', async t => {
  const f = fixture(t); let calls = 0;
  const backend = { canAnalyze: () => true, async analyze() { calls++; return { provider: 'fixture', model: 'model-v1', costUnits: 1, output: 'Synthetic' }; } };
  const first = f.open({ backend }); const media = first.ingest({ path: f.source('image'), kind: 'image' });
  assert.equal((await first.analyze({ mediaId: media.id, question: '', idempotencyKey: 'bind-first-account' }, owner)).status, 'completed');
  first.close();
  const otherLedger = createBudgetLedger({ directory: f.directory, accountId: 'other-fixture-account', environment: 'test', unit: 'usd-micro', limitUnits: 100 });
  t.after(() => otherLedger.close());
  const second = f.open({ backend, suppliedLedger: otherLedger });
  await assert.rejects(second.analyze({ mediaId: media.id, question: '', idempotencyKey: 'switch-account' }, owner), hasCode('MEDIA_LEDGER_SCOPE_MISMATCH'));
  assert.equal(calls, 1); assert.equal(otherLedger.summary().reservationCount, 0);
});

test('actual model mismatch accounts known spend but suppresses unverified output', async t => {
  const f = fixture(t);
  const gateway = f.open({ backend: { canAnalyze: () => true, async analyze() { return { provider: 'other', model: 'unexpected', output: 'DO_NOT_RELEASE', costUnits: 2 }; } } });
  const media = gateway.ingest({ path: f.source('video'), kind: 'video' });
  const result = await gateway.analyze({ mediaId: media.id, question: '', idempotencyKey: 'mismatch' }, owner);
  assert.equal(result.status, 'needs-review'); assert.ok(result.reasonCodes.includes('MEDIA_RECEIPT_UNVERIFIED'));
  assert.equal(JSON.stringify(result).includes('DO_NOT_RELEASE'), false); assert.equal(f.ledger.summary().spentUnits, 2);
});

test('read timeout signals cancellation and marks cost unknown without automatic retry', async t => {
  const f = fixture(t); const policy = enabledPolicy(); policy.timeoutMs = 15; let calls = 0, signal;
  const gateway = f.open({ policy, backend: { canAnalyze: () => true, analyze(request) { calls++; signal = request.signal; return new Promise(() => {}); } } });
  const media = gateway.ingest({ path: f.source('audio'), kind: 'audio' });
  const request = { mediaId: media.id, question: '', idempotencyKey: 'timeout' };
  const result = await gateway.analyze(request, owner);
  assert.equal(result.status, 'needs-review'); assert.equal(signal.aborted, true); assert.equal(f.ledger.summary().frozen, true);
  assert.equal((await gateway.analyze(request, owner)).replayed, true); assert.equal(calls, 1);
});

test('same read key returns exact saved result and changed question conflicts', async t => {
  const f = fixture(t); let calls = 0;
  const gateway = f.open({ backend: { canAnalyze: () => true, async analyze() { calls++; return { provider: 'fixture', model: 'model-v1', output: 'Synthetic', costUnits: 1 }; } } });
  const media = gateway.ingest({ path: f.source('image'), kind: 'image' });
  const request = { mediaId: media.id, question: 'describe', idempotencyKey: 'same-read' };
  const first = await gateway.analyze(request, owner); const second = await gateway.analyze(request, owner);
  assert.deepEqual(second, { ...first, replayed: true }); assert.equal(calls, 1);
  await assert.rejects(gateway.analyze({ ...request, question: 'different' }, owner), hasCode('MEDIA_IDEMPOTENCY_CONFLICT'));
});

test('only allowlisted private recipients may receive image/video, and audio send is disabled', async t => {
  const f = fixture(t); const sent = [];
  const gateway = f.open({ backend: { async send(request) { sent.push(request); return { recipientId: request.recipientId, messageId: `${sent.length}` }; } } });
  for (const kind of ['image', 'video']) {
    const media = gateway.ingest({ path: f.source(kind), kind });
    const result = await gateway.send({ mediaId: media.id, recipientId: '12345', caption: 'fixture only', idempotencyKey: `send-${kind}` }, owner);
    assert.equal(result.status, 'sent');
    await assert.rejects(gateway.send({ mediaId: media.id, recipientId: '-10012345', caption: '', idempotencyKey: `group-${kind}` }, owner), hasCode('MEDIA_RECIPIENT_FORBIDDEN'));
    await assert.rejects(gateway.send({ mediaId: media.id, recipientId: '54321', caption: '', idempotencyKey: `other-${kind}` }, owner), hasCode('MEDIA_RECIPIENT_FORBIDDEN'));
  }
  const audio = gateway.ingest({ path: f.source('audio'), kind: 'audio' });
  await assert.rejects(gateway.send({ mediaId: audio.id, recipientId: '12345', caption: '', idempotencyKey: 'send-audio' }, owner), hasCode('MEDIA_SEND_NOT_READY'));
  const policy = enabledPolicy(); policy.recipientIds = ['-10012345'];
  assert.throws(() => f.open({ policy }), hasCode('MEDIA_POLICY_INVALID'));
  assert.equal(sent.length, 2);
});

test('send receipt mismatch and source errors are not treated as successful delivery', async t => {
  const f = fixture(t); let calls = 0;
  const gateway = f.open({ backend: { async send() { calls++; return { recipientId: 'wrong', messageId: '1' }; } } });
  const media = gateway.ingest({ path: f.source('image'), kind: 'image' });
  const request = { mediaId: media.id, recipientId: '12345', caption: '', idempotencyKey: 'wrong-delivery' };
  assert.equal((await gateway.send(request, owner)).status, 'needs-review');
  assert.equal((await gateway.send(request, owner)).replayed, true); assert.equal(calls, 1);
});

test('concurrent duplicate sends dispatch once across separate gateway handles', async t => {
  const f = fixture(t); let release, entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const backend = { async send(request) { calls++; entered(); await new Promise(resolve => { release = resolve; }); return { recipientId: request.recipientId, messageId: '7' }; } };
  const one = f.open({ backend }), two = f.open({ backend });
  const media = one.ingest({ path: f.source('image'), kind: 'image' });
  const request = { mediaId: media.id, recipientId: '12345', caption: '', idempotencyKey: 'concurrent-send' };
  const first = one.send(request, owner); await started;
  const duplicate = await two.send(request, owner);
  assert.equal(duplicate.status, 'needs-review'); assert.ok(duplicate.reasonCodes.includes('MEDIA_OPERATION_INCOMPLETE')); assert.equal(calls, 1);
  release(); assert.equal((await first).status, 'sent');
  assert.equal((await two.send(request, owner)).replayed, true);
  await assert.rejects(two.send({ ...request, caption: 'changed' }, owner), hasCode('MEDIA_IDEMPOTENCY_CONFLICT'));
});

test('unknown delivery survives restart and never automatically resends the same operation', async t => {
  const f = fixture(t); let calls = 0;
  const backend = { async send() { calls++; throw new Error('SENSITIVE_FIXTURE_REMOTE_ERROR'); } };
  const first = f.open({ backend }); const media = first.ingest({ path: f.source('video'), kind: 'video' });
  const request = { mediaId: media.id, recipientId: '12345', caption: '', idempotencyKey: 'unknown-send' };
  const result = await first.send(request, owner); assert.equal(result.status, 'needs-review');
  assert.equal(JSON.stringify(result).includes('SENSITIVE_FIXTURE'), false); first.close();
  const second = f.open({ backend });
  assert.equal((await second.send(request, owner)).status, 'needs-review'); assert.equal(calls, 1);
});

test('media bytes and records cannot be read from a different agent namespace', t => {
  const f = fixture(t); const main = f.open(), group = f.open({ agentId: 'group-tim' });
  const media = main.ingest({ path: f.source('image'), kind: 'image' });
  assert.throws(() => group.get(media.id), hasCode('MEDIA_NOT_FOUND'));
  assert.throws(() => f.open({ environment: 'paper' }), hasCode('MEDIA_LEDGER_SCOPE_MISMATCH'));
  const db = new DatabaseSync(path.join(f.directory, 'main/test/media.sqlite'));
  try { db.prepare('UPDATE media SET bytes=? WHERE id=?').run(Buffer.alloc(64), media.id); assert.throws(() => main.get(media.id), hasCode('MEDIA_CORRUPT')); }
  finally { db.close(); }
});
