import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readNativeExecutionSource, resolveNativeExecutionSession } from '../src/native-execution-source.mjs';

const session = '11111111-1111-1111-1111-111111111111', native = '22222222-2222-2222-2222-222222222222';
function fixture(t) {
  const homeDirectory = mkdtempSync(path.join(os.tmpdir(), 'native-receipt-source-'));
  t.after(() => rmSync(homeDirectory, { recursive: true, force: true }));
  const stateDirectory = path.join(homeDirectory, '.openclaw'), workspaceDirectory = path.join(stateDirectory, 'workspace');
  const dbDirectory = path.join(stateDirectory, 'agents', 'main', 'agent');
  mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 }); mkdirSync(dbDirectory, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dbDirectory, 'openclaw-agent.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_windows (session_id TEXT PRIMARY KEY,session_key TEXT); CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY,current_session_id TEXT,entry_json TEXT)');
  const entry = { sessionId: session, cliSessionIds: { 'claude-cli': native }, cliSessionBindings: { 'claude-cli': {
    sessionId: native, cwdHash: createHash('sha256').update(workspaceDirectory).digest('hex') } } };
  db.prepare('INSERT INTO session_windows VALUES(?,?)').run(session, 'agent:main:main');
  db.prepare('INSERT INTO session_nodes VALUES(?,?,?)').run('agent:main:main', session, JSON.stringify(entry)); db.close();
  const projectDirectory = path.join(homeDirectory, '.claude', 'projects', workspaceDirectory.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(projectDirectory, native + '.jsonl');
  const row = { sessionId: native, cwd: workspaceDirectory, type: 'assistant', timestamp: '2026-09-28T06:46:18.100Z', message: { role: 'assistant', content: [] } };
  writeFileSync(logPath, JSON.stringify(row) + '\n', { mode: 0o600 });
  const options = { homeDirectory, stateDirectory, workspaceDirectory, binding: { sessionKey: 'agent:main:main', sessionId: session,
    nativeSessionId: null, createdAt: '2026-09-28T06:46:18.155Z' } };
  return { options, entry, logPath, row, dbPath, updateNode(value, sessionId = session) {
    const db = new DatabaseSync(dbPath); db.prepare('UPDATE session_nodes SET current_session_id=?,entry_json=?').run(sessionId, JSON.stringify(value)); db.close();
  } };
}

test('native resolver only checks exact DB identity and does not need or create a log', t => {
  const f = fixture(t); rmSync(f.logPath);
  assert.deepEqual(resolveNativeExecutionSession(f.options), { status: 'ready', nativeSessionId: native });
  assert.deepEqual(readNativeExecutionSource(f.options).reasonCodes, ['NATIVE_SOURCE_UNAVAILABLE']);
});

test('exact current session resolves one project path and filters unrelated records', t => {
  const f = fixture(t);
  writeFileSync(f.logPath, [f.row, { ...f.row, sessionId: 'other' }, { ...f.row, cwd: '/other' },
    { ...f.row, timestamp: '2025-01-01T00:00:00Z' }].map(JSON.stringify).join('\n') + '\n');
  const value = readNativeExecutionSource(f.options); assert.equal(value.status, 'ready'); assert.deepEqual(value.records, [f.row]);
});

test('old unpinned session after reset stays unknown while saved UUID can read its own log', t => {
  const f = fixture(t), next = '33333333-3333-3333-3333-333333333333';
  f.updateNode({ ...f.entry, sessionId: next }, next);
  assert.deepEqual(readNativeExecutionSource(f.options).reasonCodes, ['NATIVE_HISTORICAL_BINDING_UNAVAILABLE']);
  const pinned = { ...f.options, binding: { ...f.options.binding, nativeSessionId: native } };
  assert.equal(readNativeExecutionSource(pinned).status, 'ready');
});

test('wrong group/session and path traversal are rejected even with a pinned native UUID', t => {
  const f = fixture(t);
  for (const update of [{ sessionKey: 'agent:main:telegram:group:-100' }, { nativeSessionId: '../other' }, { sessionId: 'other' }]) {
    assert.equal(readNativeExecutionSource({ ...f.options, binding: { ...f.options.binding, nativeSessionId: native, ...update } }).status, 'rejected');
  }
});

test('ambiguous native bindings and cwd changes do not fall back to directory search', t => {
  const f = fixture(t), entry = structuredClone(f.entry); entry.cliSessionBindings['claude-cli'].cwdHash = '0'.repeat(64); f.updateNode(entry);
  assert.deepEqual(readNativeExecutionSource(f.options).reasonCodes, ['NATIVE_BINDING_UNAVAILABLE']);
  entry.cliSessionBindings['claude-cli'].cwdHash = f.entry.cliSessionBindings['claude-cli'].cwdHash;
  entry.cliSessionIds['claude-cli'] = '33333333-3333-3333-3333-333333333333'; f.updateNode(entry);
  assert.deepEqual(readNativeExecutionSource(f.options).reasonCodes, ['NATIVE_BINDING_UNAVAILABLE']);
});

test('symlink files and writable native evidence files are rejected', t => {
  const f = fixture(t), alternate = f.logPath + '.alternate'; writeFileSync(alternate, JSON.stringify(f.row) + '\n');
  rmSync(f.logPath); symlinkSync(alternate, f.logPath);
  assert.equal(readNativeExecutionSource(f.options).status, 'rejected');
  rmSync(f.logPath); writeFileSync(f.logPath, JSON.stringify(f.row) + '\n'); chmodSync(f.logPath, 0o666);
  assert.equal(readNativeExecutionSource(f.options).status, 'rejected');
});

test('existing service-primary-group directories are supported, world-writable or symlink directories are not', t => {
  const f = fixture(t), project = path.dirname(f.logPath);
  chmodSync(project, 0o775);
  assert.equal(readNativeExecutionSource(f.options).status, 'ready');
  chmodSync(project, 0o777);
  assert.equal(readNativeExecutionSource(f.options).status, 'rejected');
  chmodSync(project, 0o700);
  const realProject = project + '-moved';
  mkdirSync(realProject); writeFileSync(path.join(realProject, native + '.jsonl'), JSON.stringify(f.row) + '\n');
  rmSync(project, { recursive: true }); symlinkSync(realProject, project);
  assert.equal(readNativeExecutionSource(f.options).status, 'rejected');
});

test('bounded log reads reject oversize and completed malformed JSONL, ignore only partial tail', t => {
  const f = fixture(t); assert.deepEqual(readNativeExecutionSource({ ...f.options, maxBytes: 1 }).reasonCodes, ['NATIVE_SOURCE_TOO_LARGE']);
  writeFileSync(f.logPath, JSON.stringify(f.row) + '\n{"incomplete":');
  assert.deepEqual(readNativeExecutionSource(f.options).records, [f.row]);
  writeFileSync(f.logPath, '{bad}\n');
  assert.deepEqual(readNativeExecutionSource(f.options).reasonCodes, ['NATIVE_SOURCE_INVALID_JSONL']);
});

test('missing databases are not created and unsafe directory options fail closed', t => {
  const f = fixture(t); rmSync(f.dbPath);
  assert.deepEqual(readNativeExecutionSource(f.options).reasonCodes, ['NATIVE_SOURCE_UNAVAILABLE']);
  assert.equal(readNativeExecutionSource({ ...f.options, workspaceDirectory: path.dirname(f.options.workspaceDirectory) }).status, 'rejected');
});
