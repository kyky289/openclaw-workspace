import { createHash } from 'node:crypto';
import { openPrivateStore } from './private-store.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const hash = value => digest(canonical(value));
const clone = value => JSON.parse(canonical(value));
const equal = (a, b) => canonical(a) === canonical(b);
export class WorkflowError extends Error {
  constructor(code) { super(code); this.name = 'WorkflowError'; this.code = code; }
}
const fail = code => { throw new WorkflowError(code); };
const requireValue = value => { if (!value) fail('VALIDATION'); };
function object(value, keys, required = keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  requireValue(Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
const identifier = value => requireValue(typeof value === 'string' && ID.test(value));
function text(value, maximum) { requireValue(typeof value === 'string' && value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= maximum); }
function time(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value));
  const parsed = new Date(value), normalized = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, x) => `.${x.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  requireValue(Number.isFinite(parsed.valueOf()) && parsed.toISOString() === normalized);
  return parsed.valueOf();
}
function provenance(context) {
  object(context, ['thesis', 'skill', 'strategy']);
  object(context.thesis, ['id', 'version', 'locator']); identifier(context.thesis.id);
  text(context.thesis.version, 256); text(context.thesis.locator, 2048);
  for (const field of ['skill', 'strategy']) { object(context[field], ['id', 'version']); text(context[field].id, 256); text(context[field].version, 256); }
}
function model(value) { object(value, ['provider', 'id', 'version']); for (const field of Object.values(value)) text(field, 256); }
function submission(input, recordedAt) {
  object(input, ['title', 'question', 'sources', 'context', 'idempotencyKey']);
  text(input.title, 1024); text(input.question, 8192); identifier(input.idempotencyKey); provenance(input.context);
  requireValue(Array.isArray(input.sources) && input.sources.length > 0 && input.sources.length <= 20);
  requireValue(new Set(input.sources.map(source => source?.sourceKey)).size === input.sources.length);
  for (const source of input.sources) {
    object(source, ['sourceKey', 'sourceFamily', 'kind', 'source', 'locator', 'publishedAt', 'observedAt', 'content']);
    identifier(source.sourceKey); identifier(source.sourceFamily); requireValue(['fact', 'inference'].includes(source.kind));
    text(source.source, 512); text(source.locator, 2048); text(source.content, 16 * 1024);
    requireValue(time(source.publishedAt) <= time(source.observedAt) && time(source.observedAt) <= recordedAt);
  }
  requireValue(Buffer.byteLength(canonical(input)) <= 60 * 1024);
}
function analysis(value) {
  object(value, ['kind', 'data']);
  if (value.kind === 'decision') {
    object(value.data, ['title', 'action', 'reason']);
    requireValue(['hold', 'buy', 'sell', 'research'].includes(value.data.action)); text(value.data.reason, 16384);
  } else if (value.kind === 'prediction') {
    object(value.data, ['title', 'probability', 'dueAt', 'resolutionCriterion']);
    requireValue(Number.isFinite(value.data.probability) && value.data.probability >= 0 && value.data.probability <= 1);
    time(value.data.dueAt); text(value.data.resolutionCriterion, 8192);
  } else fail('VALIDATION');
  text(value.data.title, 1024);
}
const safeCodes = new Set(['UNVERIFIED_EVIDENCE', 'STALE_EVIDENCE', 'JOURNAL_CONFLICT', 'CORRUPT_STORE', 'CLOCK', 'VALIDATION',
  'STORAGE_BUSY', 'STORAGE_FAILURE', 'STORAGE', 'UNSAFE_STORAGE', 'STORAGE_REPLACED', 'IDEMPOTENCY_CONFLICT',
  'QUEUE_RESULT_CONFLICT', 'QUEUE_DEAD_LETTER', 'QUEUE_ACK_PENDING', 'DEPENDENCY_CONFLICT']);
const safeCode = error => safeCodes.has(error?.code) ? error.code : 'WORKFLOW_INTERRUPTED';

/** Synchronous, local orchestration. Authorization and every dependency are trusted host capabilities. */
export function createResearchWorkflow(options) {
  object(options, ['directory', 'agentId', 'environment', 'queue', 'research', 'journal', 'authorize'],
    ['directory', 'agentId', 'environment', 'queue', 'research', 'journal']);
  const { queue, research, journal } = options;
  const scope = Object.freeze({ agentId: options.agentId, environment: options.environment });
  identifier(scope.agentId); requireValue(['test', 'paper', 'live'].includes(scope.environment));
  for (const [handle, methods] of [[queue, ['enqueue', 'get', 'claim', 'ack']],
    [research, ['recordEvidence', 'getEvidence', 'freezeTask', 'getTask', 'publish', 'getPublication']], [journal, ['statistics', 'get']]]) {
    requireValue(handle && methods.every(name => typeof handle[name] === 'function'));
  }
  if (!equal(queue.scope, scope) || !equal(research.scope, scope) || !equal(journal.statistics().scope, scope)) fail('SCOPE_MISMATCH');
  const authorize = options.authorize ?? (() => null); requireValue(typeof authorize === 'function');
  const store = openPrivateStore({ directory: options.directory, ...scope, name: 'workflow', version: 1, initialize(db) {
    db.exec(`CREATE TABLE workflow_tasks (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE workflow_proposals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE workflow_commits (task_id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE workflow_events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, record_json TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(task_id,seq)) STRICT;`);
    for (const table of ['workflow_tasks', 'workflow_proposals', 'workflow_commits', 'workflow_events']) db.exec(`
      CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
  } });
  const { db } = store;
  const stableId = (prefix, value) => `${prefix}-${hash([scope, value])}`;
  const operationKey = (taskId, stage, extra = '') => stableId('wo', [taskId, stage, extra]);
  function auth(action, request, context) {
    let receipt;
    try {
      if (authorize.constructor?.name === 'AsyncFunction') fail('UNAUTHORIZED');
      receipt = authorize({ action, scope: { ...scope }, request: clone(request) }, context);
      object(receipt, ['actorId']); identifier(receipt.actorId);
    } catch { fail('UNAUTHORIZED'); }
    return receipt.actorId;
  }
  function parse(row, validate) {
    try {
      const value = JSON.parse(row.record_json);
      requireValue(canonical(value) === row.record_json && hash(value) === row.digest);
      validate(value); return value;
    } catch { fail('CORRUPT_STORE'); }
  }
  function writtenNow(after = 0) { const value = Date.now(); if (!Number.isFinite(value) || value < after) fail('CLOCK'); return new Date(value).toISOString(); }
  function readTask(taskId) {
    const row = db.prepare('SELECT * FROM workflow_tasks WHERE id=?').get(taskId);
    if (!row) fail('NOT_FOUND');
    return parse(row, value => {
      object(value, ['id', 'scope', 'input', 'createdAt', 'submittedBy']); identifier(value.submittedBy);
      requireValue(value.id === row.id && equal(value.scope, scope) && row.request_key === value.input.idempotencyKey
        && value.id === stableId('wt', value.input.idempotencyKey));
      submission(value.input, time(value.createdAt));
    });
  }
  function proposals(taskId) {
    return db.prepare('SELECT * FROM workflow_proposals WHERE task_id=? ORDER BY rowid').all(taskId).map(row => parse(row, value => {
      object(value, ['id', 'taskId', 'status', 'analysis', 'idempotencyKey', 'createdAt', 'proposedBy']);
      requireValue(value.id === row.id && value.taskId === taskId && value.status === 'candidate' && row.request_key === value.idempotencyKey
        && value.id === stableId('wp', value.idempotencyKey));
      identifier(value.idempotencyKey); identifier(value.proposedBy); time(value.createdAt); analysis(value.analysis);
    }));
  }
  function state(taskId) {
    const task = readTask(taskId), candidates = proposals(taskId);
    const row = db.prepare('SELECT * FROM workflow_commits WHERE task_id=?').get(taskId);
    const intent = row ? parse(row, value => {
      object(value, ['taskId', 'proposalId', 'modelReceipt', 'idempotencyKey', 'createdAt', 'approvedBy']);
      requireValue(value.taskId === taskId && row.request_key === value.idempotencyKey && candidates.some(p => p.id === value.proposalId));
      identifier(value.idempotencyKey); identifier(value.approvedBy); model(value.modelReceipt); requireValue(time(value.createdAt) >= time(task.createdAt));
    }) : null;
    const result = { task, candidates, intent, queueTaskId: null, frozen: null, publication: null, lease: null, completed: false, issue: null, seq: 0, at: time(task.createdAt) };
    for (const eventRow of db.prepare('SELECT * FROM workflow_events WHERE task_id=? ORDER BY seq').all(taskId)) {
      const event = parse(eventRow, value => {
        object(value, ['taskId', 'seq', 'type', 'at', 'data']);
        requireValue(value.taskId === taskId && value.seq === result.seq + 1 && value.seq === eventRow.seq && time(value.at) >= result.at);
        const data = value.data;
        if (value.type === 'ingested') { object(data, ['queueTaskId']); identifier(data.queueTaskId); requireValue(!result.queueTaskId); }
        else if (value.type === 'frozen') {
          object(data, ['researchTaskId', 'snapshotSha256']); identifier(data.researchTaskId);
          requireValue(intent && result.queueTaskId && !result.frozen && SHA.test(data.snapshotSha256));
          requireValue(data.researchTaskId === stableId('wr', [taskId, intent.idempotencyKey]));
        } else if (value.type === 'published') {
          object(data, ['receipt']); requireValue(result.frozen && !result.publication);
          const r = data.receipt;
          requireValue(r?.status === 'committed' && equal(r.scope, scope) && r.taskId === result.frozen.researchTaskId
            && r.taskSnapshotSha256 === result.frozen.snapshotSha256 && r.journalRecord?.version === 1);
          identifier(r.journalRecord.id);
        } else if (value.type === 'leased') {
          object(data, ['queueTaskId', 'leaseToken']); identifier(data.leaseToken);
          requireValue(result.publication && !result.completed && data.queueTaskId === result.queueTaskId);
        } else if (value.type === 'completed') {
          object(data, ['queueTaskId', 'journalRecordId']);
          requireValue(result.publication && !result.completed && data.queueTaskId === result.queueTaskId && data.journalRecordId === result.publication.journalRecord.id);
        } else if (value.type === 'reconciled') { object(data, []); }
        else if (value.type === 'issue') { object(data, ['code']); requireValue(safeCodes.has(data.code) || data.code === 'WORKFLOW_INTERRUPTED'); }
        else fail('VALIDATION');
      });
      result.seq = event.seq; result.at = time(event.at); result.issue = null;
      if (event.type === 'ingested') result.queueTaskId = event.data.queueTaskId;
      if (event.type === 'frozen') result.frozen = event.data;
      if (event.type === 'published') result.publication = event.data.receipt;
      if (event.type === 'leased') result.lease = event.data;
      if (event.type === 'completed') result.completed = true;
      if (event.type === 'issue') result.issue = event.data.code;
    }
    return result;
  }
  function appendEvent(s, type, data) {
    if (type === 'issue' && s.issue === data.code) return s;
    const event = { taskId: s.task.id, seq: s.seq + 1, type, at: writtenNow(s.at), data };
    db.prepare('INSERT INTO workflow_events VALUES(?,?,?,?)').run(s.task.id, event.seq, canonical(event), hash(event));
    return state(s.task.id);
  }
  function checkKey(key, table, request) {
    for (const candidate of ['workflow_tasks', 'workflow_proposals', 'workflow_commits']) {
      const row = db.prepare(`SELECT * FROM ${candidate} WHERE request_key=?`).get(key);
      if (!row) continue;
      if (candidate !== table) fail('IDEMPOTENCY_CONFLICT');
      const stored = parse(row, () => {});
      const original = candidate === 'workflow_tasks' ? stored.input
        : candidate === 'workflow_proposals' ? { taskId: stored.taskId, analysis: stored.analysis, idempotencyKey: stored.idempotencyKey }
          : { taskId: stored.taskId, proposalId: stored.proposalId, modelReceipt: stored.modelReceipt, idempotencyKey: stored.idempotencyKey };
      if (!equal(original, request)) fail('IDEMPOTENCY_CONFLICT');
      return stored;
    }
    return null;
  }
  function sources(s) {
    return s.task.input.sources.map(source => ({ ...source, contentSha256: digest(source.content),
      evidenceId: stableId('we', [s.task.id, source.sourceKey]) }));
  }
  function view(s, summary = false) {
    const phase = s.completed ? 'completed' : s.publication ? 'published' : s.intent ? 'committing' : s.queueTaskId ? 'needs-review' : 'ingest-pending';
    const reasonCodes = s.issue ? [s.issue] : phase === 'needs-review' ? ['OWNER_REVIEW_REQUIRED']
      : phase === 'published' ? ['QUEUE_ACK_PENDING'] : phase === 'committing' ? ['COMMIT_RESUME_REQUIRED']
        : phase === 'ingest-pending' ? ['INGEST_RESUME_REQUIRED'] : [];
    const common = { id: s.task.id, scope: { ...scope }, title: s.task.input.title, createdAt: s.task.createdAt,
      status: s.issue ? 'needs-review' : phase, phase, reasonCodes,
      queueTaskId: s.queueTaskId, selectedProposalId: s.intent?.proposalId ?? null,
      journalRecordId: s.publication?.journalRecord.id ?? null };
    if (summary) return common;
    return clone({ ...common, question: s.task.input.question, context: s.task.input.context, submittedBy: s.task.submittedBy,
      sources: sources(s), evidence: sources(s).map(source => research.getEvidence(source.evidenceId)),
      proposals: s.candidates, modelReceipt: s.intent?.modelReceipt ?? null, publication: s.publication });
  }
  function queueTask(s) {
    const task = queue.get({ id: s.queueTaskId });
    if (!task || task.sourceKey !== s.task.id || task.content !== canonical(s.task.input)) fail('DEPENDENCY_CONFLICT');
    return task;
  }
  function ackResult(s) { return { workflowTaskId: s.task.id, proposalId: s.intent.proposalId,
    journalRecordId: s.publication.journalRecord.id, journalRecordVersion: s.publication.journalRecord.version }; }
  function completedQueue(s, task) {
    if (task.status !== 'completed') return null;
    if (!equal(task.result, ackResult(s))) fail('QUEUE_RESULT_CONFLICT');
    return s.completed ? s : appendEvent(s, 'completed', { queueTaskId: s.queueTaskId, journalRecordId: s.publication.journalRecord.id });
  }
  function finish(s) {
    let task = queueTask(s), completed = completedQueue(s, task);
    if (completed) return completed;
    if (task.status === 'dead-letter') fail('QUEUE_DEAD_LETTER');
    if (s.lease && task.status === 'leased') {
      try { queue.ack({ id: s.queueTaskId, leaseToken: s.lease.leaseToken, result: ackResult(s) }); }
      catch (error) {
        completed = completedQueue(s, queueTask(s)); if (completed) return completed;
        if (!['LEASE_EXPIRED', 'LEASE_CONFLICT'].includes(error?.code)) throw error;
      }
      completed = completedQueue(s, queueTask(s)); if (completed) return completed;
    }
    const lease = queue.claim({ id: s.queueTaskId, workerId: `workflow-${scope.agentId}`, leaseMs: 30_000 });
    if (!lease) fail('QUEUE_ACK_PENDING');
    if (lease.id !== s.queueTaskId || lease.sourceKey !== s.task.id) fail('DEPENDENCY_CONFLICT');
    s = appendEvent(s, 'leased', { queueTaskId: s.queueTaskId, leaseToken: lease.leaseToken });
    try { queue.ack({ id: s.queueTaskId, leaseToken: lease.leaseToken, result: ackResult(s) }); }
    catch (error) { completed = completedQueue(s, queueTask(s)); if (completed) return completed; throw error; }
    completed = completedQueue(s, queueTask(s)); if (!completed) fail('QUEUE_ACK_PENDING'); return completed;
  }
  function drive(taskId) {
    return store.transaction(true, () => {
      let s = state(taskId);
      try {
        if (!s.queueTaskId) {
          for (const source of sources(s)) {
            const { content, sourceKey, evidenceId, ...metadata } = source;
            const e = research.recordEvidence({ id: evidenceId, ...metadata, idempotencyKey: operationKey(taskId, 'evidence', sourceKey) });
            if (e.id !== evidenceId || e.contentSha256 !== source.contentSha256) fail('DEPENDENCY_CONFLICT');
          }
          const queued = queue.enqueue({ sourceKey: taskId, content: canonical(s.task.input), metadata: { workflowTaskId: taskId }, maxAttempts: 10 });
          if (queued.task?.sourceKey !== taskId || queued.task.content !== canonical(s.task.input)) fail('DEPENDENCY_CONFLICT');
          s = appendEvent(s, 'ingested', { queueTaskId: queued.task.id });
        }
        if (s.intent && !s.publication) {
          const frozenId = stableId('wr', [taskId, s.intent.idempotencyKey]);
          const frozen = research.freezeTask({ id: frozenId, title: s.task.input.title,
            evidenceIds: sources(s).map(source => source.evidenceId), ...s.task.input.context,
            model: s.intent.modelReceipt, idempotencyKey: operationKey(taskId, 'freeze', s.intent.idempotencyKey) });
          if (frozen.id !== frozenId || !equal(frozen.scope, scope) || !equal(frozen.model, s.intent.modelReceipt)) fail('DEPENDENCY_CONFLICT');
          if (!s.frozen) s = appendEvent(s, 'frozen', { researchTaskId: frozen.id, snapshotSha256: frozen.snapshotSha256 });
          if (s.frozen.snapshotSha256 !== frozen.snapshotSha256) fail('DEPENDENCY_CONFLICT');
          const proposal = s.candidates.find(candidate => candidate.id === s.intent.proposalId);
          const receipt = research.publish({ taskId: frozen.id, ...proposal.analysis, idempotencyKey: operationKey(taskId, 'publish', s.intent.idempotencyKey) });
          if (receipt.status !== 'committed' || !equal(receipt.scope, scope) || receipt.taskId !== frozen.id
            || !equal(journal.get(receipt.journalRecord.id, { version: 1 }), receipt.journalRecord)) fail('DEPENDENCY_CONFLICT');
          s = appendEvent(s, 'published', { receipt });
        }
        if (s.publication) {
          if (!equal(journal.get(s.publication.journalRecord.id, { version: 1 }), s.publication.journalRecord)) fail('JOURNAL_CONFLICT');
          s = finish(s);
        }
        if (s.issue) s = appendEvent(s, 'reconciled', {});
      } catch (error) { s = appendEvent(state(taskId), 'issue', { code: safeCode(error) }); }
      return view(s);
    });
  }
  function submit(input, context) {
    submission(input, Date.now()); input = clone(input); const actor = auth('submit', input, context);
    const taskId = store.transaction(true, () => {
      const old = checkKey(input.idempotencyKey, 'workflow_tasks', input); if (old) return state(old.id).task.id;
      const task = { id: stableId('wt', input.idempotencyKey), scope: { ...scope }, input, createdAt: writtenNow(), submittedBy: actor };
      db.prepare('INSERT INTO workflow_tasks VALUES(?,?,?,?)').run(task.id, input.idempotencyKey, canonical(task), hash(task)); return task.id;
    });
    // Submission retries only reconcile ingestion; they never exercise commit authority.
    const existing = store.transaction(false, () => state(taskId));
    return existing.queueTaskId ? store.transaction(false, () => view(state(taskId))) : drive(taskId);
  }
  function get(input, context) {
    object(input, ['taskId']); identifier(input.taskId); auth('read', input, context);
    return store.transaction(false, () => view(state(input.taskId)));
  }
  function list(input = {}, context) {
    object(input, ['limit', 'offset'], []); const limit = input.limit ?? 20, offset = input.offset ?? 0;
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(offset) && offset >= 0);
    auth('read', input, context);
    return store.transaction(false, () => ({ scope: { ...scope }, total: db.prepare('SELECT COUNT(*) AS n FROM workflow_tasks').get().n,
      limit, offset, tasks: db.prepare('SELECT id FROM workflow_tasks ORDER BY rowid LIMIT ? OFFSET ?').all(limit, offset).map(row => view(state(row.id), true)) }));
  }
  function propose(input, context) {
    object(input, ['taskId', 'analysis', 'idempotencyKey']); identifier(input.taskId); identifier(input.idempotencyKey); analysis(input.analysis);
    input = clone(input); const actor = auth('propose', input, context);
    return store.transaction(true, () => {
      const s = state(input.taskId), old = checkKey(input.idempotencyKey, 'workflow_proposals', input); if (old) return clone(old);
      if (!s.queueTaskId) fail('WORKFLOW_NOT_READY'); if (s.intent) fail('COMMIT_CONFLICT'); if (s.candidates.length >= 20) fail('PROPOSAL_LIMIT');
      const candidate = { id: stableId('wp', input.idempotencyKey), ...input, status: 'candidate', createdAt: writtenNow(s.at), proposedBy: actor };
      db.prepare('INSERT INTO workflow_proposals VALUES(?,?,?,?,?)').run(candidate.id, input.taskId, input.idempotencyKey, canonical(candidate), hash(candidate));
      return clone(candidate);
    });
  }
  function commit(input, context) {
    object(input, ['taskId', 'proposalId', 'modelReceipt', 'idempotencyKey']); identifier(input.taskId); identifier(input.proposalId);
    identifier(input.idempotencyKey); model(input.modelReceipt); input = clone(input); const actor = auth('commit', input, context);
    const ready = store.transaction(true, () => {
      const s = state(input.taskId), old = checkKey(input.idempotencyKey, 'workflow_commits', input); if (old) return true;
      if (s.intent) fail('COMMIT_CONFLICT'); if (!s.queueTaskId) fail('WORKFLOW_NOT_READY');
      if (!s.candidates.some(candidate => candidate.id === input.proposalId)) fail('NOT_FOUND');
      if (sources(s).some(source => research.getEvidence(source.evidenceId)?.verification.status !== 'verified')) {
        appendEvent(s, 'issue', { code: 'UNVERIFIED_EVIDENCE' }); return false;
      }
      const intent = { ...input, createdAt: writtenNow(s.at), approvedBy: actor };
      db.prepare('INSERT INTO workflow_commits VALUES(?,?,?,?)').run(input.taskId, input.idempotencyKey, canonical(intent), hash(intent)); return true;
    });
    return ready ? drive(input.taskId) : store.transaction(false, () => view(state(input.taskId)));
  }
  function reconcile(input, context) {
    object(input, ['taskId']); identifier(input.taskId); auth('reconcile', input, context); return drive(input.taskId);
  }
  return Object.freeze({ scope, submit, get, list, propose, commit, reconcile, close: () => store.close() });
}
