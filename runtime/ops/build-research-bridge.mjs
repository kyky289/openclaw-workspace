import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Bundle the exact local dependency closure. Does not install or enable the plugin. */
export function buildResearchBridge() {
  const src = new URL('../research-core/src/', import.meta.url);
  const plugin = new URL('../openclaw-research-bridge/', import.meta.url);
  const library = new URL('lib/', plugin);
  mkdirSync(library, { recursive: true });
  if (lstatSync(library).isSymbolicLink()) throw new Error('BUILD_TARGET_UNSAFE');
  const pending = ['host.mjs'], seen = new Set(), manifest = [];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    if (!/^[a-z][a-z0-9-]*\.mjs$/.test(name)) throw new Error('BUILD_IMPORT_UNSUPPORTED');
    seen.add(name);
    const content = readFileSync(new URL(name, src));
    for (const match of content.toString('utf8').matchAll(/(?:from\s*|import\s*\()\s*['"]\.\/([^'"]+)['"]/g)) pending.push(match[1]);
    const target = new URL(name, library);
    try { if (lstatSync(target).isSymbolicLink()) throw new Error('BUILD_TARGET_UNSAFE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    writeFileSync(target, content, { mode: 0o644 });
    manifest.push({ path: `lib/${name}`, source: `research-core/src/${name}`, sha256: createHash('sha256').update(content).digest('hex') });
  }
  manifest.sort((a,b) => a.path.localeCompare(b.path));
  const record = { kind: 'local-core-bundle', installed: false, activated: false, files: manifest };
  writeFileSync(new URL('build-manifest.json', plugin), JSON.stringify(record, null, 2) + '\n');
  return { modules: manifest.length, installed: false, activated: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildResearchBridge()));
