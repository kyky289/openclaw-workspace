import { createJournal } from './journal.mjs';
import { createResearch } from './research.mjs';
import { createMonitorQueue } from './monitor-queue.mjs';
import { createResearchWorkflow } from './workflow.mjs';
import { createReviewService } from './review.mjs';
import { createHostExecutions } from './execution-host.mjs';

export class HostError extends Error {
  constructor(code) { super(code); this.name = 'HostError'; this.code = code; }
}
const fail = code => { throw new HostError(code); };
const id = x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x);
const agentCommands = ['task-submit','task-get','task-list','task-propose'];
const operatorCommands = ['task-commit','task-reconcile','evidence-get','evidence-verify','evidence-freeze',
  'review-create','prediction-resolve','review-receipt','journal-get','journal-list','journal-statistics'];
export const TASK_RESPONSE_LIMIT_BYTES = 400 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Never report a durable write as failed just because its accumulated task view grew.
function taskResponse(task) {
  if (bytes(task) <= TASK_RESPONSE_LIMIT_BYTES) return task;
  const { sources, evidence, proposals, publication, ...rest } = task;
  return { ...rest, projection: 'summary',
    sources: sources.map(({ content, ...metadata }) => metadata),
    evidence: evidence.map(item => item ? { ...item, verification: {
      ...item.verification, reason: undefined,
    } } : null),
    proposals: proposals.map(item => ({ id: item.id, taskId: item.taskId, status: item.status,
      kind: item.analysis.kind, title: item.analysis.data.title, createdAt: item.createdAt, proposedBy: item.proposedBy })),
    publication: publication ? { status: publication.status, taskId: publication.taskId,
      journalRecord: { id: publication.journalRecord.id, version: publication.journalRecord.version,
        kind: publication.journalRecord.kind } } : null,
    detailRetrieval: { command: 'task-get', taskId: task.id,
      details: ['proposal','evidence','source','publication'], sourceItemId: 'evidenceId',
      instruction: 'Use detail and itemId to retrieve one complete item; publication requires no itemId.' },
  };
}

function taskDetail(workflow, request, context, executions) {
  if (Object.keys(request).some(key => !['taskId','detail','itemId'].includes(key))) fail('HOST_INPUT_INVALID');
  if (request.detail === undefined) {
    if (Object.hasOwn(request, 'itemId')) fail('HOST_INPUT_INVALID');
    const task = workflow.get({ taskId: request.taskId }, context);
    return taskResponse({ ...task, executionEvidence: executions.summary(task.id) });
  }
  if (!['source','evidence','proposal','publication','execution'].includes(request.detail)
    || (request.detail === 'publication' ? Object.hasOwn(request, 'itemId') : !id(request.itemId))) fail('HOST_INPUT_INVALID');
  const task = workflow.get({ taskId: request.taskId }, context);
  if (request.detail === 'execution') return executions.detail(task.id, request.itemId);
  if (request.detail === 'publication') return task.publication;
  const item = request.detail === 'source' ? task.sources.find(item => item.evidenceId === request.itemId)
    : request.detail === 'evidence' ? task.evidence.find(item => item?.id === request.itemId)
      : task.proposals.find(item => item.id === request.itemId);
  if (!item) fail('NOT_FOUND');
  return item;
}

function taskPage(page) {
  if (bytes(page) <= TASK_RESPONSE_LIMIT_BYTES) return page;
  while (page.tasks.length && bytes(page) > TASK_RESPONSE_LIMIT_BYTES - 256) page.tasks.pop();
  return { ...page, returned: page.tasks.length, nextOffset: page.offset + page.tasks.length };
}

/** Host-owned scope and capability boundary. No authentication, network listener or background worker. */
export function createResearchHost(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(k => !['directory','agentId','environment','actorId','mode'].includes(k))) fail('HOST_OPTIONS_INVALID');
  const { directory, agentId, environment, actorId, mode = 'agent' } = options;
  if (!id(agentId) || !id(actorId) || !['test','paper','live'].includes(environment)
    || !['agent','operator-test'].includes(mode) || (mode === 'operator-test' && environment !== 'test')) fail('HOST_OPTIONS_INVALID');
  const operator = mode === 'operator-test';
  const context = Object.freeze({ actorId });
  const handles = [];
  let closed = false;
  const scope = Object.freeze({ agentId, environment });
  const close = () => {
    if (closed) return;
    closed = true;
    let failed = false;
    for (const h of [...handles].reverse()) { try { h.close(); } catch { failed = true; } }
    if (failed) fail('HOST_CLOSE_FAILED');
  };
  try {
    const journal = createJournal({ directory, ...scope }); handles.push(journal);
    const research = createResearch({ directory, ...scope, journal,
      authorizeVerification: ctx => operator && ctx === context ? { actorId } : null }); handles.push(research);
    const queue = createMonitorQueue({ directory, ...scope }); handles.push(queue);
    const workflow = createResearchWorkflow({ directory, ...scope, queue, research, journal,
      authorize: ({ action }, ctx) => ctx === context && (operator || ['submit','read','propose'].includes(action)) ? { actorId } : null }); handles.push(workflow);
    const executions = createHostExecutions({ directory, ...scope, actorId,
      getTask: taskId => workflow.get({ taskId }, context) }); handles.push(executions);
    // Production verification/resolution authority is deliberately not exposed through model tools.
    const reviews = operator ? createReviewService({ directory, ...scope, research, journal,
      authorizeReview: (_request, ctx) => ctx === context ? {
        actorId, canRead: true, canReview: true, canResolve: true,
        earlyResolutionConfirmed: true, // Only synthetic test operation; never production authority.
      } : null }) : null;
    if (reviews) handles.push(reviews);
    function requireFixtureReview(request) {
      if (!id(request.evidenceTaskId) || !request.target || !id(request.target.id)
        || !Number.isSafeInteger(request.target.version) || request.target.version < 1) fail('HOST_INPUT_INVALID');
      const evidence = research.getTask(request.evidenceTaskId);
      const target = journal.get(request.target.id, { version: request.target.version });
      if (evidence?.model?.provider !== 'fixture' || target?.data?.model?.provider !== 'fixture') fail('HOST_FIXTURE_RECEIPT_REQUIRED');
    }
    function execute(command, request) {
      if (closed) fail('HOST_CLOSED');
      if (!agentCommands.includes(command) && !(operator && operatorCommands.includes(command))) fail('HOST_OPERATION_FORBIDDEN');
      if (!request || typeof request !== 'object' || Array.isArray(request)) fail('HOST_INPUT_INVALID');
      let result;
      switch (command) {
        case 'task-submit': result = taskResponse(workflow.submit(request, context)); break;
        case 'task-get': result = taskDetail(workflow, request, context, executions); break;
        case 'task-list': result = taskPage(workflow.list(request, context)); break;
        case 'task-propose': result = workflow.propose(request, context); break;
        case 'task-commit':
          if (request.modelReceipt?.provider !== 'fixture') fail('HOST_FIXTURE_RECEIPT_REQUIRED');
          result = taskResponse(workflow.commit(request, context)); break;
        case 'task-reconcile': {
          const task = workflow.get(request, context);
          if (task.modelReceipt && task.modelReceipt.provider !== 'fixture') fail('HOST_FIXTURE_RECEIPT_REQUIRED');
          result = taskResponse(workflow.reconcile(request, context)); break;
        }
        case 'evidence-get':
          if (Object.keys(request).length !== 1 || !id(request.evidenceId)) fail('HOST_INPUT_INVALID');
          result = research.getEvidence(request.evidenceId); break;
        case 'evidence-verify': result = research.verifyEvidence(request, context); break;
        case 'evidence-freeze':
          if (request.model?.provider !== 'fixture') fail('HOST_FIXTURE_RECEIPT_REQUIRED');
          result = research.freezeTask(request); break;
        case 'review-create': requireFixtureReview(request); result = reviews.review(request, context); break;
        case 'prediction-resolve': requireFixtureReview(request); result = reviews.resolve(request, context); break;
        case 'review-receipt': result = reviews.getReceipt(request, context); break;
        case 'journal-get':
          if (!id(request.id) || Object.keys(request).some(k => !['id','version'].includes(k))) fail('HOST_INPUT_INVALID');
          result = journal.get(request.id, request.version === undefined ? {} : { version: request.version }); break;
        case 'journal-list': result = journal.list(request); break;
        case 'journal-statistics': result = journal.statistics(request); break;
      }
      if (result && typeof result.then === 'function') fail('HOST_ASYNC_OPERATION_UNSUPPORTED');
      return result;
    }
    return Object.freeze({ scope, execute, executions, close });
  } catch (error) { try { close(); } catch {} throw error; }
}
