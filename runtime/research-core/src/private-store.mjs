import { DatabaseSync } from 'node:sqlite';
import { constants as C, lstatSync, mkdirSync, openSync, closeSync, linkSync, unlinkSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class StoreError extends Error {
  constructor(code) { super(code); this.name = 'StoreError'; this.code = code; }
}
const fail = code => { throw new StoreError(code); };
const id = x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x);
const exists = p => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function directory(p, privateMode = true) {
  const s = lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink() || (privateMode && ((s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())))) fail('UNSAFE_STORAGE');
  return s;
}
function regular(p, optional = false) {
  let s = exists(p);
  if (!s && optional) return null;
  if (!s) fail('STORAGE_MISSING');
  for (let i = 0; s.isFile() && s.nlink > 1 && i < 50; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); s = lstatSync(p);
  }
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o077)
    || (process.getuid && s.uid !== process.getuid())) fail('UNSAFE_STORAGE');
  return s;
}
function rootDirectory(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0') || p.split(path.sep).includes('..')) fail('INVALID_STORAGE_PATH');
  p = path.normalize(p);
  if (p === path.parse(p).root) fail('INVALID_STORAGE_PATH');
  let current = path.parse(p).root;
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    directory(current, current === p);
  }
  return p;
}
function child(parent, name) {
  const p = path.join(parent, name);
  try { mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  directory(p); return p;
}
function safe(e) {
  if (e instanceof StoreError) return e;
  if (e?.code === 'ERR_SQLITE_ERROR') return new StoreError(/locked|busy/i.test(e.message) ? 'STORAGE_BUSY' : 'STORAGE_FAILURE');
  // Domain errors are already fixed-code errors. Never expose native filesystem paths.
  if (e && typeof e.code === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(e.code) && !['ENOENT','EACCES','EPERM','EEXIST','EISDIR','ENOTDIR'].includes(e.code)) return e;
  return new StoreError('STORAGE_FAILURE');
}

/** Private local SQLite store. Host identity is trusted; no authentication supplied here. */
export function openPrivateStore({ directory: root, agentId, environment, name, version = 1, initialize }) {
  if (!id(agentId) || !id(name) || !['test','paper','live'].includes(environment)
    || !Number.isSafeInteger(version) || version < 1 || typeof initialize !== 'function'
    || initialize.constructor?.name === 'AsyncFunction') fail('STORE_OPTIONS_INVALID');
  const scope = Object.freeze({ agentId, environment });
  let db, closed = false, running = false;
  try {
    root = rootDirectory(root);
    const agentDirectory = child(root, agentId), dir = child(agentDirectory, environment);
    const file = path.join(dir, `${name}.sqlite`);
    const signature = JSON.stringify({ name, version, scope });
    if (!regular(file, true)) {
      const temp = `${file}.initializing-${randomUUID()}`;
      let initial;
      try {
        const fd = openSync(temp, C.O_CREAT | C.O_EXCL | C.O_RDWR | C.O_NOFOLLOW, 0o600); closeSync(fd);
        initial = new DatabaseSync(temp);
        initial.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE _store_meta (id INTEGER PRIMARY KEY CHECK(id=1), signature TEXT NOT NULL) STRICT;');
        initial.prepare('INSERT INTO _store_meta VALUES(1,?)').run(signature);
        const initialized = initialize(initial);
        if (initialized && typeof initialized.then === 'function') fail('ASYNC_TRANSACTION_FORBIDDEN');
        initial.exec('COMMIT'); initial.close(); initial = null;
        try { linkSync(temp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        unlinkSync(temp);
        const fdDir = openSync(dir, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
        try { fsyncSync(fdDir); } finally { closeSync(fdDir); }
      } catch (e) { try { initial?.close(); } catch {} throw e; }
    }
    const fileIdentity = regular(file);
    const identities = [root, agentDirectory, dir].map(p => ({ path: p, stat: directory(p) }));
    const check = () => {
      for (const {path:p,stat:s} of identities) { const now = directory(p); if (s.dev !== now.dev || s.ino !== now.ino) fail('STORAGE_REPLACED'); }
      const s = regular(file);
      if (s.dev !== fileIdentity.dev || s.ino !== fileIdentity.ino) fail('STORAGE_REPLACED');
      for (const ext of ['-journal','-wal','-shm']) regular(file + ext, true);
    };
    check();
    db = new DatabaseSync(file, { timeout: 5000 });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const meta = db.prepare('SELECT * FROM _store_meta').all();
    if (meta.length !== 1 || meta[0].id !== 1 || meta[0].signature !== signature) fail('STORE_SCOPE_MISMATCH');
    const integrity = db.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') fail('CORRUPT_STORE');
    function transaction(write, fn) {
      if (closed) fail('STORE_CLOSED');
      if (running || typeof fn !== 'function' || typeof write !== 'boolean') fail('TRANSACTION_INVALID');
      if (fn.constructor?.name === 'AsyncFunction') fail('ASYNC_TRANSACTION_FORBIDDEN');
      try {
        check(); db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); running = true;
        const result = fn();
        if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION_FORBIDDEN');
        db.exec('COMMIT'); running = false; return result;
      } catch (e) {
        if (running) { try { db.exec('ROLLBACK'); } catch {} running = false; }
        throw safe(e);
      }
    }
    return { db, scope, transaction, close() { if (!closed) { db.close(); closed = true; } } };
  } catch (e) { try { db?.close(); } catch {} throw safe(e); }
}
