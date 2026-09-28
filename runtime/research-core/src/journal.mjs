import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const KINDS = ['prediction', 'decision', 'review', 'resolution'];

export class JournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

function fail(code, message) { throw new JournalError(code, message); }
function requireValue(condition, message) { if (!condition) fail('VALIDATION', message); }
function object(value, keys, required = keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Expected a plain object');
  requireValue(Object.keys(value).every((key) => keys.includes(key)), 'Unknown field');
  requireValue(required.every((key) => Object.hasOwn(value, key)), 'Missing required field');
}
function string(value, field, max = 4096) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !value.includes('\0'), `Invalid ${field}`);
}
function identifier(value, field) { requireValue(typeof value === 'string' && ID.test(value), `Invalid ${field}`); }
function integer(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Invalid ${field}`);
}
function timestamp(value, field) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value), `Invalid ${field}: use an ISO UTC timestamp`);
  const date = new Date(value);
  const canonical = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, f) => `.${f.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  requireValue(Number.isFinite(date.valueOf()) && date.toISOString() === canonical, `Invalid ${field}`);
  return date.valueOf();
}
function evidence(value) {
  requireValue(Array.isArray(value) && value.length >= 1 && value.length <= 50, 'Provide between 1 and 50 evidence references');
  for (const reference of value) {
    object(reference, ['source', 'locator', 'observedAt']);
    string(reference.source, 'evidence source', 512);
    string(reference.locator, 'evidence locator', 2048);
    timestamp(reference.observedAt, 'evidence observedAt');
  }
}
function evidenceChronology(references, createdAt) {
  const recordedAt = timestamp(createdAt, 'createdAt');
  for (const reference of references) {
    requireValue(timestamp(reference.observedAt, 'evidence observedAt') <= recordedAt,
      'Evidence cannot be observed after the record creation time');
  }
}
function target(value) {
  object(value, ['id', 'version']);
  identifier(value.id, 'target id');
  integer(value.version, 'target version', 1);
}
function provenance(value) {
  object(value.model, ['provider', 'id', 'version']);
  for (const [key, entry] of Object.entries(value.model)) string(entry, `model ${key}`, 256);
  object(value.strategy, ['id', 'version']);
  for (const [key, entry] of Object.entries(value.strategy)) string(entry, `strategy ${key}`, 256);
  evidence(value.evidence);
}
function validateData(kind, data) {
  const common = ['title', 'evidence', 'model', 'strategy'];
  if (kind === 'prediction') {
    object(data, [...common, 'probability', 'dueAt', 'resolutionCriterion']);
    requireValue(typeof data.probability === 'number' && Number.isFinite(data.probability)
      && data.probability >= 0 && data.probability <= 1, 'Probability must be between 0 and 1');
    timestamp(data.dueAt, 'dueAt');
    string(data.resolutionCriterion, 'resolutionCriterion', 8192);
  } else if (kind === 'decision') {
    object(data, [...common, 'action', 'reason']);
    requireValue(['hold', 'buy', 'sell', 'research'].includes(data.action), 'Unsupported conceptual action');
    string(data.reason, 'reason', 16384);
  } else if (kind === 'review') {
    object(data, [...common, 'target', 'result', 'lessons']);
    target(data.target);
    string(data.result, 'result', 16384);
    requireValue(Array.isArray(data.lessons) && data.lessons.length <= 50, 'Invalid lessons');
    data.lessons.forEach((lesson) => string(lesson, 'lesson', 4096));
  } else if (kind === 'resolution') {
    object(data, ['target', 'outcome', 'resolvedAt', 'reason', 'evidence']);
    target(data.target);
    requireValue(data.outcome === 0 || data.outcome === 1, 'Outcome must be 0 or 1');
    timestamp(data.resolvedAt, 'resolvedAt');
    string(data.reason, 'reason', 8192);
    evidence(data.evidence);
    return;
  } else fail('VALIDATION', 'Unsupported record kind');
  string(data.title, 'title', 1024);
  provenance(data);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }

// This storage boundary assumes the operating-system account itself is trusted.
// Reject symlinks component by component; never repair ownership/modes implicitly.
function inspectDirectory(directory, privateDirectory = true) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE', 'Storage path must contain only real directories');
  if (privateDirectory && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
    fail('UNSAFE_STORAGE', 'Journal directories must be owned by the current account with mode 0700');
  }
  return stat;
}
function prepareRoot(directory) {
  requireValue(typeof directory === 'string' && path.isAbsolute(directory)
    && !directory.includes('\0') && !directory.split(path.sep).includes('..'), 'Directory must be an absolute path without traversal');
  const normalized = path.normalize(directory);
  requireValue(normalized !== path.parse(normalized).root, 'Root directory is not a journal storage directory');
  let current = path.parse(normalized).root;
  const parts = normalized.slice(current.length).split(path.sep).filter(Boolean);
  parts.forEach((part, index) => {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    inspectDirectory(current, index === parts.length - 1);
  });
  return normalized;
}
function privateChild(parent, name) {
  const directory = path.join(parent, name);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  inspectDirectory(directory);
  return directory;
}
function inspectFile(file, optional = false) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  // Atomic first publication briefly has a second private hard-link name.
  // Never open such a file: allow its publisher 100 ms to remove that name.
  for (let attempt = 0; stat.isFile() && stat.nlink > 1 && attempt < 50; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    stat = lstatSync(file);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_STORAGE', 'Journal files must be private regular files owned by the current account');
  return stat;
}
function safeError(error) {
  if (error instanceof JournalError) return error;
  if (error?.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(error.message)) {
    return new JournalError('BUSY', 'Journal is busy; retry the same idempotency key');
  }
  return new JournalError('STORAGE', 'Journal storage operation failed');
}

function initializeDatabase(filename, scope) {
  if (inspectFile(filename, true)) return;
  // Publish a fully initialized file atomically. Never interpret an existing
  // empty/truncated database as a new journal, including during concurrent opens.
  const temporary = `${filename}.initializing-${randomUUID()}`;
  let initialization;
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(descriptor);
    initialization = new DatabaseSync(temporary);
    initialization.exec(`
      PRAGMA synchronous = FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        kind TEXT NOT NULL CHECK(kind IN ('prediction','decision','review','resolution')),
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        previous_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        target_id TEXT,
        UNIQUE(id, version)
      ) STRICT;
      CREATE UNIQUE INDEX one_resolution ON events(target_id) WHERE kind = 'resolution';
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      CREATE TRIGGER metadata_no_update BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      CREATE TRIGGER metadata_no_delete BEFORE DELETE ON metadata BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      PRAGMA user_version = 1;
    `);
    const insert = initialization.prepare('INSERT INTO metadata(key, value) VALUES(?, ?)');
    insert.run('schemaVersion', String(SCHEMA_VERSION));
    insert.run('scope', canonical(scope));
    initialization.exec('COMMIT');
    initialization.close();
    initialization = undefined;
    try { linkSync(temporary, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Remove only this function's private temporary name before other openers
    // inspect the published file's hard-link count.
    unlinkSync(temporary);
    const directoryDescriptor = openSync(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } catch (error) {
    try { initialization?.close(); } catch { /* preserve original failure */ }
    // Retain failed initialization files for inspection; never repair a journal.
    throw safeError(error);
  }
}

export function createJournal(options) {
  object(options, ['directory', 'agentId', 'environment']);
  identifier(options.agentId, 'agentId');
  requireValue(['test', 'paper', 'live'].includes(options.environment), 'Invalid environment');
  const root = prepareRoot(options.directory);
  const agentDirectory = privateChild(root, options.agentId);
  const directory = privateChild(agentDirectory, options.environment);
  const scope = Object.freeze({ agentId: options.agentId, environment: options.environment });
  const filename = path.join(directory, 'journal.sqlite');
  initializeDatabase(filename, scope);
  const identity = inspectFile(filename);
  const directoryIdentity = inspectDirectory(directory);
  let db;
  let closed = false;

  function checkStorage() {
    inspectDirectory(root);
    inspectDirectory(agentDirectory);
    const currentDirectory = inspectDirectory(directory);
    const current = inspectFile(filename);
    if (current.dev !== identity.dev || current.ino !== identity.ino
      || currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino) {
      fail('UNSAFE_STORAGE', 'Journal storage was replaced while open');
    }
    for (const suffix of ['-journal', '-wal', '-shm']) inspectFile(`${filename}${suffix}`, true);
  }

  function transaction(write, operation) {
    if (closed) fail('CLOSED', 'Journal is closed');
    let active = false;
    try {
      checkStorage();
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      active = true;
      const result = operation();
      db.exec('COMMIT');
      active = false;
      return result;
    } catch (error) {
      if (active) { try { db.exec('ROLLBACK'); } catch { /* preserve first failure */ } }
      throw safeError(error);
    }
  }

  try {
    checkStorage();
    db = new DatabaseSync(filename, { timeout: 5000 });
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    transaction(true, () => {
      const metadata = db.prepare('SELECT key, value FROM metadata').all();
      if (metadata.length !== 2 || metadata.find((row) => row.key === 'schemaVersion')?.value !== String(SCHEMA_VERSION)
        || metadata.find((row) => row.key === 'scope')?.value !== canonical(scope)
        || db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) fail('CORRUPT_STORE', 'Journal metadata does not match its scope or schema');
      const check = db.prepare('PRAGMA quick_check').all();
      if (check.length !== 1 || check[0].quick_check !== 'ok') fail('CORRUPT_STORE', 'Journal integrity check failed');
      readAll();
    });
  } catch (error) {
    try { db?.close(); } catch { /* preserve first failure */ }
    throw safeError(error);
  }

  function readAll() {
    const rows = db.prepare('SELECT * FROM events ORDER BY sequence').all();
    const records = [];
    const histories = new Map();
    const resolutions = new Set();
    let previousHash = '';
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data_json);
        validateData(row.kind, data);
        identifier(row.id, 'stored id');
        identifier(row.idempotency_key, 'stored idempotency key');
        integer(row.version, 'stored version', 1);
        timestamp(row.created_at, 'stored createdAt');
        evidenceChronology(data.evidence, row.created_at);
        requireValue(row.sequence === records.length + 1, 'Invalid event sequence');
        requireValue(Buffer.byteLength(row.data_json) <= MAX_RECORD_BYTES && canonical(data) === row.data_json, 'Invalid stored data');
        requireValue(/^[a-f0-9]{64}$/.test(row.request_hash), 'Invalid request digest');
        const record = { schemaVersion: SCHEMA_VERSION, scope, id: row.id, version: row.version, kind: row.kind, createdAt: row.created_at, data };
        const digest = hash({ record, sequence: row.sequence, idempotencyKey: row.idempotency_key, requestHash: row.request_hash, previousHash });
        requireValue(row.previous_hash === previousHash && row.record_hash === digest, 'Invalid record digest');
        const history = histories.get(row.id) ?? [];
        requireValue(row.version === history.length + 1 && (!history.length || history[0].kind === row.kind), 'Invalid version history');
        if (history.length) {
          requireValue(timestamp(row.created_at, 'createdAt') >= timestamp(history.at(-1).createdAt, 'createdAt'), 'Invalid chronology');
          requireValue(row.kind !== 'resolution', 'Resolution cannot be revised');
        }
        if (row.kind === 'prediction') {
          requireValue(timestamp(data.dueAt, 'dueAt') > timestamp(row.created_at, 'createdAt'), 'Prediction recorded after its deadline');
          requireValue(!resolutions.has(row.id), 'Prediction revised after resolution');
          if (history.length) {
            for (const key of ['title', 'dueAt', 'resolutionCriterion']) requireValue(data[key] === history[0].data[key], 'Prediction event definition changed');
          }
        }
        if (row.kind === 'review' || row.kind === 'resolution') {
          const referenced = histories.get(data.target.id)?.find((item) => item.version === data.target.version);
          requireValue(referenced && ['prediction', 'decision'].includes(referenced.kind), 'Invalid target reference');
          if (row.kind === 'resolution') {
            requireValue(referenced.kind === 'prediction' && !resolutions.has(data.target.id), 'Invalid resolution target');
            requireValue(data.target.version === histories.get(data.target.id).length, 'Resolution must target latest prediction');
            requireValue(row.target_id === data.target.id, 'Invalid resolution index');
            requireValue(timestamp(data.resolvedAt, 'resolvedAt') >= timestamp(referenced.createdAt, 'createdAt')
              && timestamp(data.resolvedAt, 'resolvedAt') <= timestamp(row.created_at, 'createdAt'), 'Invalid resolution chronology');
            resolutions.add(data.target.id);
          }
        }
        requireValue(row.kind === 'resolution' || row.target_id === null, 'Invalid target index');
        history.push(record);
        histories.set(row.id, history);
        records.push(record);
        previousHash = digest;
      } catch { fail('CORRUPT_STORE', 'Journal contains an invalid record; no data was changed'); }
    }
    return { rows, records, histories, resolutions, previousHash };
  }

  function insert(state, request, idempotencyKey, record) {
    const previousHash = state.previousHash;
    const requestHash = hash(request);
    const sequence = state.records.length + 1;
    const recordHash = hash({ record, sequence, idempotencyKey, requestHash, previousHash });
    db.prepare(`INSERT INTO events(id, version, kind, created_at, data_json, request_hash, idempotency_key, previous_hash, record_hash, target_id)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.version, record.kind, record.createdAt, canonical(record.data), requestHash,
      idempotencyKey, previousHash, recordHash, record.kind === 'resolution' ? record.data.target.id : null);
    return copy(record);
  }

  function retry(state, request, idempotencyKey) {
    const index = state.rows.findIndex((row) => row.idempotency_key === idempotencyKey);
    if (index === -1) return null;
    if (state.rows[index].request_hash !== hash(request)) fail('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different request');
    return copy(state.records[index]);
  }

  function append(input) {
    object(input, ['kind', 'data', 'id', 'expectedVersion', 'idempotencyKey'], ['kind', 'data', 'idempotencyKey']);
    requireValue(['prediction', 'decision', 'review'].includes(input.kind), 'Unsupported append kind');
    validateData(input.kind, input.data);
    requireValue(Buffer.byteLength(canonical(input.data)) <= MAX_RECORD_BYTES, 'Record exceeds byte limit');
    identifier(input.idempotencyKey, 'idempotencyKey');
    if (input.id !== undefined) identifier(input.id, 'id');
    const expectedVersion = input.expectedVersion === undefined ? 0 : input.expectedVersion;
    integer(expectedVersion, 'expectedVersion');
    requireValue(expectedVersion === 0 || input.id !== undefined, 'An existing id is required for revisions');
    const request = { operation: 'append', kind: input.kind, data: copy(input.data), id: input.id ?? null, expectedVersion };
    return transaction(true, () => {
      const state = readAll();
      const duplicate = retry(state, request, input.idempotencyKey);
      if (duplicate) return duplicate;
      const id = input.id ?? randomUUID();
      const history = state.histories.get(id) ?? [];
      if (history.length !== expectedVersion) fail('VERSION_CONFLICT', 'Expected version does not match current version');
      if (history.length && history[0].kind !== input.kind) fail('VALIDATION', 'A revision cannot change record kind');
      const createdAt = new Date().toISOString();
      evidenceChronology(input.data.evidence, createdAt);
      if (history.length && createdAt < history.at(-1).createdAt) fail('CLOCK', 'System clock moved backwards');
      if (input.kind === 'prediction') {
        if (state.resolutions.has(id)) fail('ALREADY_RESOLVED', 'A resolved prediction cannot be revised');
        requireValue(timestamp(input.data.dueAt, 'dueAt') > timestamp(createdAt, 'createdAt'), 'Prediction deadline must be in the future');
        if (history.length) {
          for (const key of ['title', 'dueAt', 'resolutionCriterion']) requireValue(input.data[key] === history[0].data[key], 'Create a new prediction to change its event definition');
        }
      }
      if (input.kind === 'review') {
        const reference = state.histories.get(input.data.target.id)?.find((record) => record.version === input.data.target.version);
        if (!reference || !['prediction', 'decision'].includes(reference.kind)) fail('NOT_FOUND', 'Review target was not found in this scope');
        if (history.length && canonical(input.data.target) !== canonical(history[0].data.target)) fail('VALIDATION', 'A review revision cannot change its target');
      }
      return insert(state, request, input.idempotencyKey, {
        schemaVersion: SCHEMA_VERSION, scope, id, version: expectedVersion + 1, kind: input.kind, createdAt, data: copy(input.data),
      });
    });
  }

  function resolvePrediction(input) {
    object(input, ['id', 'expectedVersion', 'outcome', 'resolvedAt', 'reason', 'evidence', 'idempotencyKey']);
    identifier(input.id, 'id');
    identifier(input.idempotencyKey, 'idempotencyKey');
    integer(input.expectedVersion, 'expectedVersion', 1);
    const data = { target: { id: input.id, version: input.expectedVersion }, outcome: input.outcome,
      resolvedAt: input.resolvedAt, reason: input.reason, evidence: input.evidence };
    validateData('resolution', data);
    requireValue(Buffer.byteLength(canonical(data)) <= MAX_RECORD_BYTES, 'Record exceeds byte limit');
    const request = { operation: 'resolvePrediction', data };
    return transaction(true, () => {
      const state = readAll();
      const duplicate = retry(state, request, input.idempotencyKey);
      if (duplicate) return duplicate;
      const prediction = state.histories.get(input.id)?.at(-1);
      if (!prediction || prediction.kind !== 'prediction') fail('NOT_FOUND', 'Prediction was not found in this scope');
      if (prediction.version !== input.expectedVersion) fail('VERSION_CONFLICT', 'Expected version does not match current version');
      if (state.resolutions.has(input.id)) fail('ALREADY_RESOLVED', 'Prediction already has a resolution');
      const createdAt = new Date().toISOString();
      evidenceChronology(data.evidence, createdAt);
      requireValue(timestamp(input.resolvedAt, 'resolvedAt') >= timestamp(prediction.createdAt, 'createdAt')
        && timestamp(input.resolvedAt, 'resolvedAt') <= timestamp(createdAt, 'createdAt'), 'Resolution must be between the forecast timestamp and now');
      return insert(state, request, input.idempotencyKey, {
        schemaVersion: SCHEMA_VERSION, scope, id: randomUUID(), version: 1, kind: 'resolution', createdAt, data,
      });
    });
  }

  function get(id, options = {}) {
    identifier(id, 'id');
    object(options, ['version'], []);
    if (options.version !== undefined) integer(options.version, 'version', 1);
    return transaction(false, () => {
      const history = readAll().histories.get(id);
      return copy((options.version === undefined ? history?.at(-1) : history?.find((item) => item.version === options.version)) ?? null);
    });
  }
  function history(id) {
    identifier(id, 'id');
    return transaction(false, () => copy(readAll().histories.get(id) ?? []));
  }
  function pagination(options, includeKind = true) {
    object(options, includeKind ? ['kind', 'limit', 'offset'] : ['limit', 'offset'], []);
    if (includeKind && options.kind !== undefined) requireValue(KINDS.includes(options.kind), 'Invalid kind filter');
    const limit = options.limit === undefined ? 100 : options.limit;
    const offset = options.offset === undefined ? 0 : options.offset;
    integer(limit, 'limit', 1, 1000);
    integer(offset, 'offset');
    return { limit, offset };
  }
  function list(options = {}) {
    const { limit, offset } = pagination(options);
    return transaction(false, () => {
      const records = [...readAll().histories.values()].map((entries) => entries.at(-1))
        .filter((record) => options.kind === undefined || record.kind === options.kind);
      return copy({ scope, total: records.length, offset, limit, records: records.slice(offset, offset + limit) });
    });
  }
  function exportJson(options = {}) {
    const { limit, offset } = pagination(options, false);
    return transaction(false, () => {
      const { records } = readAll();
      const selected = [];
      let bytes = 0;
      for (const record of records.slice(offset, offset + limit)) {
        const size = Buffer.byteLength(canonical(record));
        if (bytes + size > MAX_EXPORT_BYTES - 4096) break;
        selected.push(record);
        bytes += size + 1;
      }
      const nextOffset = offset + selected.length < records.length ? offset + selected.length : null;
      return JSON.stringify({ schemaVersion: SCHEMA_VERSION, scope, total: records.length, offset, nextOffset, records: selected });
    });
  }
  function statistics(options = {}) {
    object(options, ['minSampleSize'], []);
    const minSampleSize = options.minSampleSize === undefined ? 30 : options.minSampleSize;
    integer(minSampleSize, 'minSampleSize', 1, 1000000);
    return transaction(false, () => {
      const { histories, records } = readAll();
      const predictions = [...histories.values()].filter((items) => items[0].kind === 'prediction');
      const resolutions = records.filter((record) => record.kind === 'resolution');
      const sum = resolutions.reduce((total, resolution) => total
        + (histories.get(resolution.data.target.id)[0].data.probability - resolution.data.outcome) ** 2, 0);
      return { scope, metric: 'brier', basis: 'initial-recorded-forecast', predictionCount: predictions.length,
        resolvedCount: resolutions.length, unresolvedCount: predictions.length - resolutions.length,
        score: resolutions.length ? sum / resolutions.length : null, minSampleSize,
        sampleSufficient: resolutions.length >= minSampleSize, investmentPerformance: false };
    });
  }
  function close() { if (!closed) { db.close(); closed = true; } }
  return Object.freeze({ scope, append, resolvePrediction, get, history, list, exportJson, statistics, close });
}
