import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const rawHash = value => createHash('sha256').update(value).digest('hex');
const outcome = (status, code) => ({ status, reasonCodes: [code] });
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;

function safePath(value, regular = true, ownerGroupDirectory = false) {
  if (realpathSync(value) !== value) throw new Error('UNSAFE_PATH');
  const stat = lstatSync(value);
  // Existing native CLI directories are 0775 under the service user's home.
  // Accept that user's own primary group for directories only; evidence files
  // remain non-group-writable. This is local-host evidence, not a user sandbox.
  const allowedGroup = !regular && ownerGroupDirectory && typeof process.getgid === 'function' && stat.gid === process.getgid();
  if (stat.isSymbolicLink() || (regular ? !stat.isFile() : !stat.isDirectory())
    || (stat.mode & (allowedGroup ? 0o002 : 0o022)) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('UNSAFE_PATH');
  return stat;
}

/** Resolve and pin only a host-authorized exact main session; no native log is opened. */
export function resolveNativeExecutionSession({ binding, homeDirectory, stateDirectory, workspaceDirectory } = {}) {
  let db;
  try {
    if (!binding || typeof binding !== 'object' || !UUID.test(binding.sessionId ?? '')
      || typeof binding.sessionKey !== 'string' || !binding.sessionKey.startsWith('agent:main:')
      || (binding.nativeSessionId !== null && !UUID.test(binding.nativeSessionId ?? ''))
      || !absolute(homeDirectory) || !absolute(stateDirectory) || !absolute(workspaceDirectory)
      || stateDirectory !== path.join(homeDirectory, '.openclaw') || workspaceDirectory !== path.join(stateDirectory, 'workspace')
      || typeof binding.createdAt !== 'string' || !Number.isFinite(Date.parse(binding.createdAt))) return outcome('rejected', 'NATIVE_SOURCE_OPTIONS_INVALID');
    const dbPath = path.join(stateDirectory, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    for (const directory of [homeDirectory, stateDirectory, workspaceDirectory]) safePath(directory, false);
    for (const directory of [path.join(stateDirectory, 'agents'), path.join(stateDirectory, 'agents', 'main'), path.dirname(dbPath)]) safePath(directory, false, true);
    safePath(dbPath);
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; BEGIN');
    const window = db.prepare('SELECT session_key FROM session_windows WHERE session_id=?').get(binding.sessionId);
    if (!window || window.session_key !== binding.sessionKey) return outcome('rejected', 'NATIVE_SESSION_SCOPE_MISMATCH');
    let nativeSessionId = binding.nativeSessionId;
    if (nativeSessionId === null) {
      const node = db.prepare('SELECT current_session_id, entry_json FROM session_nodes WHERE session_key=?').get(binding.sessionKey);
      if (!node || node.current_session_id !== binding.sessionId) return outcome('pending', 'NATIVE_HISTORICAL_BINDING_UNAVAILABLE');
      const entry = JSON.parse(node.entry_json), cli = entry.cliSessionBindings?.['claude-cli'];
      if (entry.sessionId !== binding.sessionId || !cli || cli.cwdHash !== rawHash(workspaceDirectory)
        || !UUID.test(cli.sessionId ?? '') || entry.cliSessionIds?.['claude-cli'] !== cli.sessionId) return outcome('pending', 'NATIVE_BINDING_UNAVAILABLE');
      nativeSessionId = cli.sessionId;
    }
    db.exec('COMMIT');
    return { status: 'ready', nativeSessionId };
  } catch (error) {
    if (error?.code === 'ENOENT') return outcome('pending', 'NATIVE_SOURCE_UNAVAILABLE');
    return outcome('rejected', 'NATIVE_SOURCE_UNSAFE_OR_UNREADABLE');
  } finally { if (db) try { db.close(); } catch {} }
}

/** Fixed main-agent DB and exact project/native UUID path only. No glob, directory search, config or credentials access. */
export function readNativeExecutionSource(options = {}) {
  let fd;
  try {
    const { binding, homeDirectory, workspaceDirectory, maxBytes = 64 * 1024 * 1024 } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) return outcome('rejected', 'NATIVE_SOURCE_OPTIONS_INVALID');
    const resolved = resolveNativeExecutionSession(options);
    if (resolved.status !== 'ready') return resolved;
    const { nativeSessionId } = resolved;
    const projectDirectory = path.join(homeDirectory, '.claude', 'projects', workspaceDirectory.replace(/[^a-zA-Z0-9]/g, '-'));
    const filename = path.join(projectDirectory, `${nativeSessionId}.jsonl`);
    for (const directory of [path.join(homeDirectory, '.claude'), path.join(homeDirectory, '.claude', 'projects'), projectDirectory]) safePath(directory, false, true);
    const before = safePath(filename);
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.uid !== before.uid
      || (stat.mode & 0o022) !== 0) return outcome('rejected', 'NATIVE_SOURCE_UNSAFE_OR_UNREADABLE');
    if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) return outcome('rejected', 'NATIVE_SOURCE_TOO_LARGE');
    // Read only this bounded snapshot. Concurrent appends cannot enlarge the allocation or this read.
    const buffer = Buffer.alloc(stat.size); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) return outcome('pending', 'NATIVE_SOURCE_CHANGED');
    const after = fstatSync(fd);
    if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) return outcome('pending', 'NATIVE_SOURCE_CHANGED');
    const raw = buffer.toString('utf8');
    // JSONL may be appended concurrently; an unfinished tail is retried later.
    const lines = raw.split('\n'); if (lines.at(-1) !== '') lines.pop();
    const at = Date.parse(binding.createdAt), records = [];
    for (const line of lines) {
      if (!line) continue;
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) return outcome('rejected', 'NATIVE_SOURCE_LINE_TOO_LARGE');
      let row; try { row = JSON.parse(line); } catch { return outcome('rejected', 'NATIVE_SOURCE_INVALID_JSONL'); }
      if (!row || typeof row !== 'object' || row.sessionId !== nativeSessionId || row.cwd !== workspaceDirectory
        || !['assistant', 'user'].includes(row.type) || !Number.isFinite(Date.parse(row.timestamp))) continue;
      if (Math.abs(Date.parse(row.timestamp) - at) <= 10 * 60_000) records.push(row);
      if (records.length > 200_000) return outcome('rejected', 'NATIVE_SOURCE_TOO_LARGE');
    }
    return { status: 'ready', nativeSessionId, records };
  } catch (error) {
    if (error?.code === 'ENOENT') return outcome('pending', 'NATIVE_SOURCE_UNAVAILABLE');
    return outcome('rejected', 'NATIVE_SOURCE_UNSAFE_OR_UNREADABLE');
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}
