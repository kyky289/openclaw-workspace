import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenClawMediaBackend, runBounded } from '../src/openclaw-media-backend.mjs';

const hasCode = code => error => error?.code === code;
const media = kind => ({ kind, extension: { image: 'png', audio: 'wav', video: 'mp4' }[kind], bytes: Buffer.from('synthetic fixture, never sent to provider') });
const pluginEnvelope = () => ({ action: 'send', channel: 'telegram', dryRun: false, handledBy: 'plugin', messageId: '7', payload: { ok: true, messageId: '7', chatId: '12345' } });
const coreEnvelope = () => ({ action: 'send', channel: 'telegram', dryRun: false, handledBy: 'core', messageId: '8',
  payload: { channel: 'telegram', to: '12345', via: 'direct', deliveryStatus: 'sent', result: { messageId: '8', chatId: '12345' } } });
const backendWith = options => createOpenClawMediaBackend({ binary: '/fixture/openclaw', telegramAccount: 'fixture-account', ...options });

test('without a trusted receipt adapter native inference never executes', async () => {
  let calls = 0;
  const backend = backendWith({ run: () => { calls++; } });
  for (const kind of ['image', 'audio', 'video']) {
    assert.equal(backend.canAnalyze(kind), false);
    await assert.rejects(backend.analyze({ media: media(kind), agentId: 'main', modelRef: 'fixture/model', prompt: 'Describe' }), hasCode('MEDIA_RECEIPT_ADAPTER_REQUIRED'));
  }
  assert.equal(calls, 0);
});

test('native inference uses argument arrays, private temporary snapshots and trusted receipt adaptation', async () => {
  const seen = []; const adapted = [];
  const prompt = 'literal $(touch NEVER) `do-not-run` ; --dangerous';
  const backend = backendWith({
    async run(binary, args) {
      const file = args[args.indexOf('--file') + 1];
      assert.equal(binary, '/fixture/openclaw'); assert.ok(Array.isArray(args));
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      assert.equal(lstatSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.deepEqual(readFileSync(file), media(args[1]).bytes);
      seen.push({ args: [...args], file });
      return { syntheticOutput: args[1] };
    },
    analyzeReceipt(envelope, context) { adapted.push(context); return { provider: 'fixture', model: 'model', costUnits: 1, output: envelope.syntheticOutput }; },
  });
  for (const kind of ['image', 'audio', 'video']) {
    const result = await backend.analyze({ media: media(kind), agentId: 'main', modelRef: 'fixture/model', prompt });
    assert.equal(result.output, kind);
    const latest = seen.at(-1); assert.equal(latest.args[0], 'infer'); assert.equal(latest.args[2], kind === 'audio' ? 'transcribe' : 'describe');
    assert.equal(latest.args[latest.args.indexOf('--agent') + 1], 'main');
    assert.equal(latest.args[latest.args.indexOf('--model') + 1], 'fixture/model');
    if (kind !== 'video') assert.equal(latest.args[latest.args.indexOf('--prompt') + 1], prompt);
    assert.equal(existsSync(latest.file), false); assert.equal(existsSync(path.dirname(latest.file)), false);
    assert.deepEqual(adapted.at(-1), { kind, agentId: 'main', requestedModel: 'fixture/model' });
  }
});

test('temporary native media files are cleaned when the subprocess or receipt adapter fails', async () => {
  for (const failureAt of ['run', 'receipt']) {
    let file;
    const backend = backendWith({ run: async (_binary, args) => { file = args[args.indexOf('--file') + 1]; if (failureAt === 'run') throw new Error('synthetic run failure'); return {}; },
      analyzeReceipt: () => { throw new Error('synthetic receipt failure'); } });
    await assert.rejects(backend.analyze({ media: media('image'), agentId: 'main', modelRef: 'fixture/model', prompt: 'describe' }));
    assert.equal(existsSync(file), false); assert.equal(existsSync(path.dirname(file)), false);
  }
});

test('native send supports exact installed plugin/core envelopes with explicit account and recipient', async () => {
  for (const [kind, envelope] of [['image', pluginEnvelope()], ['video', coreEnvelope()]]) {
    let file;
    const caption = 'literal $(do-not-execute) ; --target another';
    const backend = backendWith({ run: async (_binary, args) => {
      assert.deepEqual(args.slice(0, 6), ['message', 'send', '--channel', 'telegram', '--account', 'fixture-account']);
      assert.equal(args[args.indexOf('--target') + 1], '12345');
      assert.equal(args[args.indexOf('--message') + 1], caption);
      file = args[args.indexOf('--media') + 1]; assert.equal(lstatSync(file).mode & 0o777, 0o600);
      return envelope;
    } });
    const result = await backend.send({ media: media(kind), recipientId: '12345', caption });
    assert.equal(result.recipientId, '12345'); assert.equal(result.messageId, kind === 'image' ? '7' : '8');
    assert.equal(existsSync(file), false);
  }
});

test('native send refuses dry-run, partial failure, mismatched target or ambiguous receipts', async () => {
  const variants = [
    { ...pluginEnvelope(), dryRun: true }, { ...pluginEnvelope(), dryRun: undefined },
    { ...pluginEnvelope(), ok: false }, { ...pluginEnvelope(), sentBeforeError: true },
    { ...pluginEnvelope(), deliveryStatus: 'partial_failed' }, { ...pluginEnvelope(), messageId: '99' },
    { ...pluginEnvelope(), payload: { ok: true, messageId: '7', chatId: '99999' } },
    { ...pluginEnvelope(), payload: { ok: true, messageId: '7', chatId: '12345', sentBeforeError: true } },
    { ...coreEnvelope(), payload: { ...coreEnvelope().payload, to: '99999' } },
    { ...coreEnvelope(), payload: { ...coreEnvelope().payload, deliveryStatus: 'failed' } },
    { ...coreEnvelope(), payload: { ...coreEnvelope().payload, result: { messageId: '8', chatId: '12345', ok: false } } },
    { action: 'send', channel: 'telegram', dryRun: false, messageId: '7' },
  ];
  for (const envelope of variants) {
    const backend = backendWith({ run: async () => envelope });
    await assert.rejects(backend.send({ media: media('image'), recipientId: '12345', caption: '' }), hasCode('MEDIA_DELIVERY_UNVERIFIED'));
  }
  let called = false;
  const backend = backendWith({ run: async () => { called = true; return pluginEnvelope(); } });
  await assert.rejects(backend.send({ media: media('audio'), recipientId: '12345', caption: '' }), hasCode('MEDIA_BACKEND_INPUT_INVALID'));
  await assert.rejects(backend.send({ media: media('image'), recipientId: '-10012345', caption: '' }), hasCode('MEDIA_BACKEND_INPUT_INVALID'));
  assert.equal(called, false);
});

test('bounded subprocess passes shell metacharacters literally and suppresses stderr/errors', async () => {
  const literal = '$(touch NO_FILE) `false` ; secret-fixture';
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({argument:process.argv[1]}))', literal]);
  assert.deepEqual(result, { argument: literal });
  for (const script of [
    'process.stderr.write("SENSITIVE_FIXTURE_ERROR");process.exit(4)',
    'process.stdout.write("SENSITIVE_FIXTURE_BAD_JSON")',
  ]) {
    await assert.rejects(runBounded(process.execPath, ['-e', script]), error => {
      assert.equal(error.message.includes('SENSITIVE_FIXTURE'), false);
      return ['MEDIA_BACKEND_FAILED', 'MEDIA_BACKEND_JSON_INVALID'].includes(error.code);
    });
  }
  await assert.rejects(runBounded('/definitely-not-an-executable-media-fixture', []), hasCode('MEDIA_BACKEND_FAILED'));
});

test('bounded subprocess abort and stdout/stderr limits fail without releasing raw output', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.stdout.write("not started")'], { signal: controller.signal }), hasCode('MEDIA_BACKEND_ABORTED'));
  await assert.rejects(runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: AbortSignal.timeout(30) }), hasCode('MEDIA_BACKEND_ABORTED'));
  for (const stream of ['stdout', 'stderr']) {
    await assert.rejects(runBounded(process.execPath, ['-e', `process.${stream}.write("SENSITIVE_FIXTURE".repeat(1000));setInterval(()=>{},1000)`], { maxOutputBytes: 64, signal: AbortSignal.timeout(3000) }), error => {
      assert.equal(error.message.includes('SENSITIVE_FIXTURE'), false); return error.code === 'MEDIA_BACKEND_ABORTED';
    });
  }
});

test('aborting the runner kills an owned grandchild that ignores SIGTERM after parent exits', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'media-runner-process-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ready = path.join(directory, 'ready'), survived = path.join(directory, 'survived');
  const childFile = path.join(directory, 'grandchild.cjs');
  writeFileSync(childFile, `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(survived)},'survived'),650);setTimeout(()=>process.exit(0),1000);`);
  const parentScript = `require('node:child_process').spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = runBounded(process.execPath, ['-e', parentScript], { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
  const rejected = assert.rejects(pending, hasCode('MEDIA_BACKEND_ABORTED'));
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) await delay(10);
  assert.equal(existsSync(ready), true, 'Synthetic child did not start');
  controller.abort(); await rejected; await delay(450);
  assert.equal(existsSync(survived), false, 'SIGTERM-ignoring grandchild survived escalation');
});
