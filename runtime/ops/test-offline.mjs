import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const core = readdirSync(new URL('../research-core/test/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs')).sort()
  .map(name => `research-core/test/${name}`);
const bridge = [
  'register', 'host-integration', 'native-execution-receipts',
  'native-execution-source', 'execution-integration',
].map(name => `openclaw-research-bridge/test/${name}.test.mjs`);
const ops = ['config-plan', 'skill-audit', 'research-bridge-plan']
  .map(name => `ops/test/${name}.test.mjs`);
// The checked-in gate build uses synthetic identities. Building TypeScript or
// exercising an installed OpenClaw SDK is a separate, optional integration step.
const gate = ['gate', 'register']
  .map(name => `telegram-active-window/test/${name}.test.mjs`);
const result = spawnSync(process.execPath,
  ['--test', ...core, ...bridge, ...ops, ...gate],
  { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error('Could not start the offline test process. Use a normal Linux/WSL shell with child processes allowed.');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
