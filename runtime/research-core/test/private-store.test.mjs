import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openPrivateStore } from '../src/private-store.mjs';
const options = directory => ({directory,agentId:'main',environment:'test',name:'fixture',initialize(db){db.exec('CREATE TABLE values_log (value TEXT) STRICT;');}});
test('private store preserves committed state and rolls back interrupted operations', () => {
 const directory=mkdtempSync(path.join(tmpdir(),'integration-store-'));
 let s;
 try {
  s=openPrivateStore(options(directory));
  s.transaction(true,()=>s.db.prepare('INSERT INTO values_log VALUES(?)').run('first'));
  assert.throws(()=>s.transaction(true,()=>{s.db.prepare('INSERT INTO values_log VALUES(?)').run('second');throw new Error('untrusted error text');}),/STORAGE_FAILURE/);
  assert.equal(s.transaction(false,()=>s.db.prepare('SELECT count(*) AS n FROM values_log').get().n),1);
  s.close();s=openPrivateStore(options(directory));
  assert.equal(s.transaction(false,()=>s.db.prepare('SELECT value FROM values_log').get().value),'first');
  assert.throws(()=>openPrivateStore({...options(directory),version:2}),/STORE_SCOPE_MISMATCH/);
 } finally {s?.close();rmSync(directory,{recursive:true,force:true});}
});
test('private store rejects symlinks and never reinitializes truncated data', () => {
 const directory=mkdtempSync(path.join(tmpdir(),'integration-store-'));
 try {
  const s=openPrivateStore(options(directory));s.close();
  const file=path.join(directory,'main/test/fixture.sqlite');writeFileSync(file,'');
  assert.throws(()=>openPrivateStore(options(directory)),/STORAGE_FAILURE/);
  symlinkSync(path.join(directory,'main'),path.join(directory,'alias'));
  assert.throws(()=>openPrivateStore(options(path.join(directory,'alias/child'))),/UNSAFE_STORAGE/);
 } finally {rmSync(directory,{recursive:true,force:true});}
});
test('declared asynchronous callbacks are rejected before their body runs', () => {
 const directory=mkdtempSync(path.join(tmpdir(),'integration-store-'));
 let s, ran=false;
 try {
  assert.throws(()=>openPrivateStore({...options(directory),initialize:async()=>{ran=true;}}),/STORE_OPTIONS_INVALID/);
  assert.equal(ran,false);
  s=openPrivateStore(options(directory));
  assert.throws(()=>s.transaction(true,async()=>{ran=true;}),/ASYNC_TRANSACTION_FORBIDDEN/);
  assert.equal(ran,false);
 } finally {s?.close();rmSync(directory,{recursive:true,force:true});}
});
