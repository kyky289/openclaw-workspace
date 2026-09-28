#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createDefaultPolicy, resolveRoute } from './router.mjs';

const methods = ['append', 'get', 'history', 'list', 'export', 'resolve', 'statistics'];
const usage = 'research-core route | eval-offline | pipeline-demo | runtime-demo | performance | paper-assess | journal-{append,get,history,list,export,resolve,statistics}\nJSON input through stdin. Offline only; no network or trading execution.';
function shape(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('INPUT_INVALID');
}

export function evaluateOffline() {
  const { cases } = JSON.parse(readFileSync(new URL('../eval/router-cases.json', import.meta.url), 'utf8'));
  const results = cases.map(item => {
    const policy = createDefaultPolicy();
    if (item.profile === 'approved-offline-fixture') {
      policy.budget.unit = 'test-unit';
      ['fast', 'standard', 'deep'].forEach((role, index) => {
        policy.models[role] = { modelRef: `fixture/${role}`, approved: true, ready: true,
          capabilities: ['text'], estimatedUnits: index + 1 };
      });
    } else if (item.profile !== 'default') throw new Error('FIXTURE_INVALID');
    const actual = resolveRoute(item.input, policy);
    const { reasonCodesInclude = [], ...expected } = item.expected;
    const passed = Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key], value))
      && reasonCodesInclude.every(code => actual.reasonCodes.includes(code)) && actual.executionAuthorized === false;
    return { id: item.id, passed };
  });
  return { kind: 'offline-policy-evaluation', modelCalls: 0, total: results.length,
    passed: results.filter(item => item.passed).length, results };
}

export async function runCommand(command, input) {
  if (command === 'performance' || command === 'paper-assess') {
    const { calculatePerformance, assessPaperReadiness } = await import('./performance.mjs');
    if (command === 'performance') return calculatePerformance(input);
    shape(input, ['sample','thresholds']);
    const metrics = calculatePerformance(input.sample);
    return { metrics, assessment: assessPaperReadiness(metrics, input.thresholds) };
  }
  if (command === 'route') {
    shape(input, ['request', 'policy'], ['request']);
    return resolveRoute(input.request, Object.hasOwn(input, 'policy') ? input.policy : createDefaultPolicy());
  }
  if (!command.startsWith('journal-') || !methods.includes(command.slice(8))) throw new Error('COMMAND_INVALID');
  shape(input, ['scope', 'request']);
  const operation = command.slice(8);
  if (operation === 'get') shape(input.request, ['id', 'version'], ['id']);
  if (operation === 'history') shape(input.request, ['id']);
  const { createJournal } = await import('./journal.mjs');
  const journal = createJournal(input.scope);
  try {
    switch (operation) {
      case 'get': return journal.get(input.request.id, input.request.version === undefined ? {} : { version: input.request.version });
      case 'history': return journal.history(input.request.id);
      case 'export': return JSON.parse(journal.exportJson(input.request));
      case 'resolve': return journal.resolvePrediction(input.request);
      default: return journal[operation](input.request);
    }
  } finally { journal.close(); }
}

async function stdinJson() {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON_INVALID'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...extra] = process.argv.slice(2);
    if (!command || command === '--help') console.log(usage);
    else {
      if (extra.length) throw new Error('ARGUMENTS_INVALID');
      if (!['route','eval-offline','pipeline-demo','runtime-demo','performance','paper-assess'].includes(command)
        && !methods.some(method => command === `journal-${method}`)) throw new Error('COMMAND_INVALID');
      const result = command === 'eval-offline' ? evaluateOffline()
        : command === 'pipeline-demo' ? await (await import('./pipeline-demo.mjs')).runPipelineDemo()
        : command === 'runtime-demo' ? (await import('./runtime-demo.mjs')).runRuntimeDemo()
        : await runCommand(command, await stdinJson());
      console.log(JSON.stringify(result, null, 2));
      if (command === 'eval-offline' && result.passed !== result.total) process.exitCode = 1;
      if (command === 'route' && result.status === 'blocked') process.exitCode = 2;
    }
  } catch (error) {
    const known = ['JSON_INVALID', 'INPUT_INVALID', 'COMMAND_INVALID', 'ARGUMENTS_INVALID', 'INPUT_TOO_LARGE', 'FIXTURE_INVALID'];
    const code = known.includes(error.message) ? error.message
      : ['JournalError','PerformanceError','StoreError'].includes(error.name) && /^[A-Z_]+$/.test(error.code) ? error.code : 'OPERATION_FAILED';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }
}
