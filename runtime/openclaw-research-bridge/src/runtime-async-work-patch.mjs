import { createHash } from 'node:crypto';

const sha256 = source => createHash('sha256').update(source, 'utf8').digest('hex');
const sources = Object.freeze({
  asyncWorkSource: { path: 'dist/async-work-scope-DeWEUzMu.mjs', sha256: 'fedbdb715de6561d5052c3790e3a31745d19277256115a1acb16679e978c4748' },
  mcpSource: { path: 'dist/mcp-http-DFannafQ.mjs', sha256: 'fce181ee1f42ef3df96c043baf76bd639dc8cb7a875acc74c17d49783dd4054f' },
  gatewayAdmissionSource: { path: 'dist/gateway-work-admission-DaOR_dL4.mjs', sha256: '994c35f528557082fd158524008c1616db1757602c54bb55328b35621d32bcff' },
});
const helperAnchor = 'function getAsyncWorkSignal() {';
const helperReplacement = `/** Starts process-lifetime work without inheriting the request work scope that created it. */
function runOutsideAsyncWorkScope(run) {
\treturn currentWorkScope.exit(run);
}
${helperAnchor}`;
const exportAnchor = 'export { trackAsyncWork as a, runWithTrackedCancellation as i, captureAsyncWorkTracker as n, getAsyncWorkSignal as r, AsyncWorkScope as t };';
const exportReplacement = 'export { trackAsyncWork as a, runWithTrackedCancellation as i, captureAsyncWorkTracker as n, runOutsideAsyncWorkScope as o, getAsyncWorkSignal as r, AsyncWorkScope as t };';
const importAnchor = 'import { c as isRecord } from "./record-coerce-DItp3I4t.mjs";';
const importReplacement = `${importAnchor}
import { o as runOutsideAsyncWorkScope } from "./async-work-scope-DeWEUzMu.mjs";
import { y as runOutsideGatewayRootWorkAdmission } from "./gateway-work-admission-DaOR_dL4.mjs";`;
const startAnchor = '\tif (!activeMcpLoopbackServerPromise) activeMcpLoopbackServerPromise = startMcpLoopbackServer(port).then((close) => {';
const startReplacement = '\tif (!activeMcpLoopbackServerPromise) activeMcpLoopbackServerPromise = runOutsideGatewayRootWorkAdmission(() => runOutsideAsyncWorkScope(() => startMcpLoopbackServer(port))).then((close) => {';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before) || source.includes(after)) {
    fail('RUNTIME_ASYNC_WORK_PATCH_ANCHOR_MISMATCH');
  }
  return source.replace(before, after);
}
function candidate(input, key, changes) {
  const original = input[key];
  const source = changes.reduce((text, { before, after }) => replaceOnce(text, before, after), original);
  const path = sources[key].path;
  return { path, beforeSha256: sha256(original), afterSha256: sha256(source), source,
    reviewDiff: `--- a/${path}\n+++ b/${path}\n${changes.map(({ before, after }) =>
      `@@ REVIEW EXCERPT (not an apply command) @@\n${before.split('\n').map(line => `-${line}`).join('\n')}\n${after.split('\n').map(line => `+${line}`).join('\n')}`).join('\n')}\n` };
}

/** Pure review generator for the audited 2026.9.4 build; never reads or changes the installation.
 * Only listener startup exits its caller's two lifetime scopes. Per-request authentication,
 * plugin lifecycle authority, cancellation, and the closed-scope guards remain unchanged.
 */
export function createRuntimeAsyncWorkPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('RUNTIME_ASYNC_WORK_PATCH_SOURCE_MISMATCH');
  for (const [key, expected] of Object.entries(sources)) {
    if (typeof input[key] !== 'string' || sha256(input[key]) !== expected.sha256) fail('RUNTIME_ASYNC_WORK_PATCH_SOURCE_MISMATCH');
  }
  if (!input.gatewayAdmissionSource.includes('function runOutsideGatewayRootWorkAdmission(run) {\n\treturn GATEWAY_WORK_ADMISSION_STATE.currentRootWork.exit(run);\n}')
    || !input.gatewayAdmissionSource.includes('runOutsideGatewayRootWorkAdmission as y')) fail('RUNTIME_ASYNC_WORK_PATCH_ANCHOR_MISMATCH');
  return { status: 'candidate-not-applied', compatibleRuntimeVerified: false, runtimeVersion: '2026.9.4',
    dependencies: [{ ...sources.gatewayAdmissionSource }],
    files: [
      candidate(input, 'asyncWorkSource', [{ before: helperAnchor, after: helperReplacement }, { before: exportAnchor, after: exportReplacement }]),
      candidate(input, 'mcpSource', [{ before: importAnchor, after: importReplacement }, { before: startAnchor, after: startReplacement }]),
    ] };
}
