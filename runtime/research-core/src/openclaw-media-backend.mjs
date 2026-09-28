import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StoreError } from './private-store.mjs';

const fail = code => { throw new StoreError(code); };
/** No shell, bounded stdout/stderr, terminate the owned process group on abort. */
export function runBounded(binary, args, { signal, maxOutputBytes = 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(new StoreError('MEDIA_BACKEND_ABORTED'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, detached: true, stdio: ['ignore','pipe','pipe'] });
    const chunks = []; let count = 0, failed = false, killTimer;
    const terminate = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        reject(new StoreError('MEDIA_BACKEND_ABORTED'));
      }, 300);
    };
    const abort = () => { if (!failed) { failed = true; terminate(); } };
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk, stdout) => {
      count += chunk.length;
      if (count > maxOutputBytes) { abort(); return; }
      if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false));
    child.once('error', () => { failed = true; signal?.removeEventListener('abort', abort); reject(new StoreError('MEDIA_BACKEND_FAILED')); });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (failed) return;
      clearTimeout(killTimer);
      if (code !== 0) { reject(new StoreError('MEDIA_BACKEND_FAILED')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new StoreError('MEDIA_BACKEND_JSON_INVALID')); }
    });
  });
}

/** Uses existing OpenClaw auth in the invoking user's environment. Never run as another user implicitly. */
export function createOpenClawMediaBackend({ binary, telegramAccount, run = runBounded, analyzeReceipt } = {}) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || binary.includes('\0') || typeof run !== 'function'
    || typeof telegramAccount !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(telegramAccount)
    || (analyzeReceipt !== undefined && typeof analyzeReceipt !== 'function')) fail('MEDIA_BACKEND_OPTIONS_INVALID');
  async function withFile(media, action) {
    if (!Buffer.isBuffer(media?.bytes) || !['png','jpg','webp','wav','mp3','ogg','mp4'].includes(media.extension)) fail('MEDIA_BACKEND_INPUT_INVALID');
    const dir = mkdtempSync(path.join(tmpdir(), 'openclaw-media-'));
    const file = path.join(dir, `attachment.${media.extension}`);
    try { writeFileSync(file, media.bytes, { mode: 0o600, flag: 'wx' }); return await action(file); }
    finally { try { unlinkSync(file); } catch {} try { rmdirSync(dir); } catch {} }
  }
  return {
    // Installed CLI does not provide a cost receipt; audio also omits actual provider/model.
    // A reviewed provider adapter must supply these fields before any real inference can run.
    canAnalyze: kind => ['image','audio','video'].includes(kind) && typeof analyzeReceipt === 'function',
    async analyze({ media, agentId, modelRef, prompt, signal }) {
      if (typeof analyzeReceipt !== 'function') fail('MEDIA_RECEIPT_ADAPTER_REQUIRED');
      if (!['image','audio','video'].includes(media.kind)) fail('MEDIA_BACKEND_INPUT_INVALID');
      return withFile(media, async file => {
        const args = ['infer', media.kind, media.kind === 'audio' ? 'transcribe' : 'describe', '--agent', agentId,
          '--model', modelRef, '--file', file, '--json'];
        if (media.kind !== 'video') args.push('--prompt', prompt);
        const envelope = await run(binary, args, { signal });
        return analyzeReceipt(envelope, { kind: media.kind, agentId, requestedModel: modelRef });
      });
    },
    async send({ media, recipientId, caption, signal }) {
      if (!['image','video'].includes(media.kind) || !/^[1-9][0-9]{0,18}$/.test(recipientId)) fail('MEDIA_BACKEND_INPUT_INVALID');
      return withFile(media, async file => {
        const args = ['message','send','--channel','telegram','--account',telegramAccount,'--target',recipientId,'--media',file,'--json'];
        if (caption) args.push('--message', caption);
        const envelope = await run(binary, args, { signal });
        // Installed OpenClaw supports both plugin and core delivery envelopes.
        const payload = envelope?.payload;
        if (envelope?.action !== 'send' || envelope?.channel !== 'telegram' || envelope?.dryRun !== false
          || envelope?.ok === false || envelope?.sentBeforeError || payload?.sentBeforeError
          || (envelope?.deliveryStatus !== undefined && envelope.deliveryStatus !== 'sent')
          || (payload?.deliveryStatus !== undefined && payload.deliveryStatus !== 'sent')) fail('MEDIA_DELIVERY_UNVERIFIED');
        let receipt;
        if (payload?.ok === true) receipt = payload;
        else if (payload?.deliveryStatus === 'sent' && payload?.channel === 'telegram'
          && String(payload?.to) === recipientId && payload?.result?.ok !== false) receipt = payload.result;
        if (!receipt || String(receipt.chatId) !== recipientId || !/^[1-9][0-9]*$/.test(String(receipt.messageId))
          || (envelope.messageId !== undefined && String(envelope.messageId) !== String(receipt.messageId))) fail('MEDIA_DELIVERY_UNVERIFIED');
        return { recipientId, messageId: String(receipt.messageId) };
      });
    },
  };
}
