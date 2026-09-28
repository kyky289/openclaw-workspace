import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSkillTrees } from '../skill-audit.mjs';
test('reports drift, extra versions, broken references without printing file content',t=>{
  const dir=mkdtempSync(join(tmpdir(),'skill-audit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const a=join(dir,'a'),b=join(dir,'b');mkdirSync(a);mkdirSync(b);
  writeFileSync(join(a,'SKILL.md'),'private text `templates/missing.md`');writeFileSync(join(b,'SKILL.md'),'new private text');
  writeFileSync(join(b,'extra.md'),'changed');symlinkSync('/etc',join(a,'outside'));
  const result=auditSkillTrees(a,b);assert.equal(result.hasDrift,true);
  assert.equal(result.entries.find(e=>e.path==='SKILL.md').status,'changed');
  assert.equal(result.entries.find(e=>e.path==='extra.md').status,'runtime-only');
  assert.equal(result.warnings.length,2);assert.equal(JSON.stringify(result).includes('private text'),false);
});
test('template directory symlinks, traversal and directory targets are invalid',t=>{
  const dir=mkdtempSync(join(tmpdir(),'skill-reference-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const a=join(dir,'a'),b=join(dir,'b'),outside=join(dir,'outside');mkdirSync(a);mkdirSync(b);mkdirSync(outside);
  writeFileSync(join(outside,'exists.md'),'external fixture');
  symlinkSync(outside,join(a,'templates'));
  writeFileSync(join(a,'SKILL.md'),'`templates/exists.md` [link](templates/exists.md)');
  mkdirSync(join(b,'templates'));mkdirSync(join(b,'templates','directory.md'));
  writeFileSync(join(b,'escape.md'),'outside template root');
  writeFileSync(join(b,'SKILL.md'),'`templates/../escape.md` [directory](templates/directory.md)');
  const result=auditSkillTrees(a,b);
  assert.ok(result.warnings.some(w=>w.side==='stable'&&w.code==='INVALID_TEMPLATE_REFERENCE'&&w.reference==='templates/exists.md'));
  assert.equal(result.warnings.filter(w=>w.code==='INVALID_TEMPLATE_REFERENCE').length,3);
  assert.equal(result.entries.some(e=>e.path==='templates/exists.md'),false);
});
test('valid nested and markdown template references are checked without leaking contents',t=>{
  const dir=mkdtempSync(join(tmpdir(),'skill-reference-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const a=join(dir,'a'),b=join(dir,'b');mkdirSync(a);mkdirSync(b);
  for(const root of [a,b]){
    mkdirSync(join(root,'templates','nested'),{recursive:true});
    writeFileSync(join(root,'templates','nested','good.md'),'sensitive fixture text');
    writeFileSync(join(root,'SKILL.md'),'[Template](./templates/nested/good.md) and `templates/nested/good.md`');
  }
  assert.deepEqual(auditSkillTrees(a,b).warnings,[]);
  symlinkSync(a,join(dir,'alias'));
  assert.throws(()=>auditSkillTrees(join(dir,'alias'),b),/symlink/);
});
