import { createHash } from 'node:crypto';

const sha256 = source => createHash('sha256').update(source, 'utf8').digest('hex');
const oldGrantHelper = `function buildCliMcpChannelContext(channelContext, senderId) {
\tconst resolvedSenderId = normalizeOptionalMcpContextValue(senderId ?? void 0) ?? normalizeOptionalMcpContextValue(channelContext?.sender?.id);
\tconst chatId = normalizeOptionalMcpContextValue(channelContext?.chat?.id);
\tif (!resolvedSenderId && !chatId) return;
\treturn {
\t\t...resolvedSenderId ? { sender: { id: resolvedSenderId } } : {},
\t\t...chatId ? { chat: { id: chatId } } : {}
\t};
}`;
const newGrantHelper = `function buildCliMcpChannelContext(channelContext, senderId, runChatId) {
\tconst contextSenderId = normalizeOptionalMcpContextValue(channelContext?.sender?.id);
\tconst contextChatId = normalizeOptionalMcpContextValue(channelContext?.chat?.id);
\tconst normalizedSenderId = normalizeOptionalMcpContextValue(senderId ?? void 0);
\tconst normalizedChatId = normalizeOptionalMcpContextValue(runChatId ?? void 0);
\tif (contextSenderId && normalizedSenderId && contextSenderId !== normalizedSenderId || contextChatId && normalizedChatId && contextChatId !== normalizedChatId) throw new Error("MCP_CHANNEL_CONTEXT_CONFLICT");
\tconst resolvedSenderId = contextSenderId ?? normalizedSenderId;
\tconst chatId = contextChatId ?? normalizedChatId;
\tif (!resolvedSenderId && !chatId) return;
\treturn {
\t\t...resolvedSenderId ? { sender: { id: resolvedSenderId } } : {},
\t\t...chatId ? { chat: { id: chatId } } : {}
\t};
}`;
const oldGrantCall = 'const channelContext = buildCliMcpChannelContext(params.run.channelContext, params.run.senderId);';
const newGrantCall = 'const channelContext = buildCliMcpChannelContext(params.run.channelContext, params.run.senderId, params.run.chatId);';
const oldOptions = '\tconst openClawTools = createOpenClawTools({\n\t\tagentSessionKey: params.sessionKey,';
const newOptions = '\tconst openClawTools = createOpenClawTools({\n\t\tnativeChannelId: params.channelContext?.chat?.id,\n\t\trequesterSenderId: params.channelContext?.sender?.id,\n\t\tagentSessionKey: params.sessionKey,';

function replaceExactlyOnce(source, before, after) {
  if (typeof source !== 'string' || source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)
    || source.includes(after)) throw Object.assign(new Error('RUNTIME_PATCH_ANCHOR_MISMATCH'), { code: 'RUNTIME_PATCH_ANCHOR_MISMATCH' });
  return source.replace(before, after);
}
function smallDiff(file, changes) {
  return `--- a/${file}\n+++ b/${file}\n${changes.map(({ before, after }) =>
    `@@ REVIEW EXCERPT (not an apply command) @@\n${before.split('\n').map(line => `-${line}`).join('\n')}\n${after.split('\n').map(line => `+${line}`).join('\n')}`).join('\n')}\n`;
}

/** Pure review generator. No file reads/writes, processes, network or installed-runtime mutation. */
export function createRuntimeContextPatch({ grantSource, resolutionSource }) {
  const grantPatched = replaceExactlyOnce(replaceExactlyOnce(grantSource, oldGrantHelper, newGrantHelper), oldGrantCall, newGrantCall);
  const resolutionPatched = replaceExactlyOnce(resolutionSource, oldOptions, newOptions);
  return { status: 'candidate-not-applied', compatibleRuntimeVerified: false,
    files: [
      { path: 'dist/mcp-grant-context-Cevi5zD3.mjs', beforeSha256: sha256(grantSource), afterSha256: sha256(grantPatched),
        source: grantPatched, reviewDiff: smallDiff('dist/mcp-grant-context-Cevi5zD3.mjs', [
          { before: oldGrantHelper, after: newGrantHelper }, { before: oldGrantCall, after: newGrantCall } ]) },
      { path: 'dist/tool-resolution-BgF9x3jL.mjs', beforeSha256: sha256(resolutionSource), afterSha256: sha256(resolutionPatched),
        source: resolutionPatched, reviewDiff: smallDiff('dist/tool-resolution-BgF9x3jL.mjs', [{ before: oldOptions, after: newOptions }]) },
    ] };
}
