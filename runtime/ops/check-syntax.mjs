import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const files = ['ops','research-core/src','openclaw-research-bridge','openclaw-research-bridge/src'].flatMap(dir => readdirSync(new URL(`${dir}/`, root))
  .filter(name => name.endsWith('.mjs')).map(name => fileURLToPath(new URL(`${dir}/${name}`, root))));
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
console.log(JSON.stringify({ checkedModules: files.length, syntax: 'passed' }));
