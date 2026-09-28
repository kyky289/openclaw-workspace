#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResearchHost } from './host.mjs';

const usage = `research-runtime COMMAND --state /absolute/private-state --agent main --environment test [--operator-test]
JSON request on stdin; host scope comes from explicit CLI options, never request fields.
Default: task-submit, task-get, task-list, task-propose.
--operator-test adds evidence verification, task commit/reconcile and review/resolution for synthetic test data only.
No model/provider, broker or Telegram calls. This local CLI trusts the OS caller and is not an owner-authentication service.`;
const failure = code => Object.assign(new Error(code), { code });
export function parseRuntimeArguments(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return null;
  const [command, ...rest] = args;
  const parsed = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!['--state','--agent','--environment','--operator-test'].includes(key) || Object.hasOwn(parsed, key)) throw failure('ARGUMENTS_INVALID');
    if (key === '--operator-test') parsed[key] = true;
    else { if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw failure('ARGUMENTS_INVALID'); parsed[key] = rest[++i]; }
  }
  if (!parsed['--state'] || !parsed['--agent'] || !parsed['--environment'] || command.startsWith('--')) throw failure('ARGUMENTS_INVALID');
  return { command, options: { directory: parsed['--state'], agentId: parsed['--agent'], environment: parsed['--environment'],
    mode: parsed['--operator-test'] ? 'operator-test' : 'agent', actorId: `local-${process.getuid?.() ?? 'operator'}` } };
}
async function stdinJson() {
  const parts = []; let bytes = 0;
  for await (const part of process.stdin) {
    bytes += part.length;
    if (bytes > 256 * 1024) throw failure('INPUT_TOO_LARGE');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw failure('JSON_INVALID'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let host;
  try {
    const parsed = parseRuntimeArguments(process.argv.slice(2));
    if (!parsed) console.log(usage);
    else {
      const request = await stdinJson();
      host = createResearchHost(parsed.options);
      console.log(JSON.stringify({ scope: host.scope, result: host.execute(parsed.command, request),
        externalCalls: 0, tradingAuthorized: false }, null, 2));
    }
  } catch (error) {
    const knownNames = ['HostError','WorkflowError','ResearchError','ReviewError','JournalError','MonitorQueueError','StoreError','Error'];
    const code = knownNames.includes(error?.name) && typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)
      ? error.code : 'OPERATION_FAILED';
    console.error(JSON.stringify({ error: code })); process.exitCode = 1;
  } finally { host?.close(); }
}
