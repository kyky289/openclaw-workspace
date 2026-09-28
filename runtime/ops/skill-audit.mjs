#!/usr/bin/env node
import { readdirSync, readFileSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function tree(root) {
  const files = new Map(); const warnings=[];
  const actual=realpathSync(root);
  if(actual!==resolve(root)||!lstatSync(actual).isDirectory())throw new Error('Skill roots must be real directories without symlink aliases');
  function safeTemplateReference(dir,reference) {
    const parts=reference.replace(/^\.\//,'').split('/');
    if(parts[0]!=='templates'||parts.some(part=>!part||part==='.'||part==='..'))return false;
    let target=dir;
    try {
      for(let index=0;index<parts.length;index++) {
        target=resolve(target,parts[index]);
        const stat=lstatSync(target);
        if(stat.isSymbolicLink()||(index<parts.length-1?!stat.isDirectory():!stat.isFile()))return false;
      }
      return realpathSync(target)===target;
    } catch { return false; }
  }
  function visit(dir) {
    if(realpathSync(dir)!==dir||!lstatSync(dir).isDirectory())throw new Error('Skill directory changed during audit');
    for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path=resolve(dir,entry.name);const key=relative(actual,path).split(sep).join('/');
      if(entry.isSymbolicLink()) { warnings.push({path:key,code:'SYMLINK_NOT_FOLLOWED'}); continue; }
      if(entry.isDirectory())visit(path);
      else if(entry.isFile()) {
        const descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        let bytes;
        try {
          if(!fstatSync(descriptor).isFile())throw new Error('Skill tree changed during audit');
          bytes=readFileSync(descriptor);
        } finally { closeSync(descriptor); }
        files.set(key,{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
        if(entry.name==='SKILL.md') {
          const text=bytes.toString('utf8');
          const references=new Set([...text.matchAll(/(?:`|\]\()(\.?\/?templates\/[a-zA-Z0-9_./-]+\.md)(?:`|\))/g)].map(match=>match[1]));
          for(const reference of references) {
            if(!safeTemplateReference(dir,reference))warnings.push({path:key,reference,code:'INVALID_TEMPLATE_REFERENCE'});
          }
        }
      } else warnings.push({path:key,code:'NONREGULAR_FILE_NOT_READ'});
    }
  }
  visit(actual);return {files,warnings};
}
export function auditSkillTrees(stableRoot,runtimeRoot) {
  const stable=tree(stableRoot);const runtime=tree(runtimeRoot);
  const entries=[...new Set([...stable.files.keys(),...runtime.files.keys()])].sort().map(path=>{
    const a=stable.files.get(path);const b=runtime.files.get(path);
    return {path,status:!a?'runtime-only':!b?'stable-only':a.sha256===b.sha256?'identical':'changed',stable:a??null,runtime:b??null};
  });
  return {schemaVersion:1,readOnly:true,entries,warnings:[...stable.warnings.map(x=>({side:'stable',...x})),...runtime.warnings.map(x=>({side:'runtime',...x}))],hasDrift:entries.some(x=>x.status!=='identical')};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [stable,runtime,...extra]=process.argv.slice(2);
    if(!stable||!runtime||extra.length)throw new Error('Usage: node ops/skill-audit.mjs STABLE_DIRECTORY RUNTIME_DIRECTORY');
    console.log(JSON.stringify(auditSkillTrees(stable,runtime),null,2));
  } catch { console.error('Skill audit failed; check directory access and arguments (file contents suppressed)');process.exitCode=1; }
}
