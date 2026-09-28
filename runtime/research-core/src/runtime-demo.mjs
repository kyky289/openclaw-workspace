import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchHost } from './host.mjs';

export function syntheticTask(key = 'forecast') {
  return { title: 'SYNTHETIC research acceptance task', question: 'Will the specified synthetic fixture equal one?',
    sources: [{ sourceKey: `fixture-${key}`, sourceFamily: 'fixture-primary', kind: 'fact', source: 'Synthetic acceptance fixture',
      locator: `fixture:${key}`, publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-01T00:01:00Z',
      content: `SYNTHETIC ONLY: ${key} source material. No company, security, price or investment recommendation.` }],
    context: { thesis: { id: 'synthetic-thesis', version: '1', locator: 'fixture:thesis' },
      skill: { id: 'research-brain', version: 'runtime-fixture' }, strategy: { id: 'synthetic-strategy', version: '1' } },
    idempotencyKey: `submit-${key}` };
}

/** Shared fixture exercises the public host interface, optionally through separate CLI processes. */
export function exerciseRuntime(call) {
  const task = call('task-submit', syntheticTask());
  const retried = call('task-submit', syntheticTask());
  const proposal = call('task-propose', { taskId: task.id, analysis: { kind: 'prediction', data: {
    title: 'Synthetic binary event', probability: 0.6, dueAt: new Date(Date.now() + 86400000).toISOString(),
    resolutionCriterion: 'Synthetic fixture event conclusively equals one; early resolution is allowed once observed.' } }, idempotencyKey: 'forecast-proposal' });
  const commitInput = { taskId: task.id, proposalId: proposal.id, modelReceipt: { provider: 'fixture', id: 'synthetic-model', version: '1' }, idempotencyKey: 'forecast-commit' };
  const blocked = call('task-commit', commitInput, true);
  const verify = (item, key) => call('evidence-verify', { evidenceId: item.sources[0].evidenceId,
    expectedVersion: 1, status: 'verified', reason: 'Compared the retained synthetic fixture bytes.', idempotencyKey: key }, true);
  verify(task, 'verify-forecast');
  const committed = call('task-commit', commitInput, true);
  const commitReplay = call('task-commit', commitInput, true);
  if (committed.phase !== 'completed') throw new Error('RUNTIME_DEMO_COMMIT_FAILED');
  const outcome = call('task-submit', syntheticTask('outcome'));
  verify(outcome, 'verify-outcome');
  const frozen = call('evidence-freeze', { title: 'Synthetic observed outcome', evidenceIds: [outcome.sources[0].evidenceId],
    ...outcome.context, model: { provider: 'fixture', id: 'synthetic-reviewer', version: '1' }, idempotencyKey: 'freeze-outcome' }, true);
  const target = { id: committed.publication.journalRecord.id, version: committed.publication.journalRecord.version };
  const resolution = call('prediction-resolve', { target, criterionResult: 1, resolvedAt: new Date().toISOString(),
    reason: 'Synthetic fixture was observed at the defined outcome; not a market result.', evidenceTaskId: frozen.id,
    idempotencyKey: 'resolve-forecast' }, true);
  const reviewInput = { target, evidenceTaskId: frozen.id, title: 'Synthetic retrospective',
    result: 'Fixture observed as one. No order or investment took place.',
    lessons: ['One correct forecast does not establish profitability or a stable win rate.'], idempotencyKey: 'review-forecast' };
  const review = call('review-create', reviewInput, true), reviewReplay = call('review-create', reviewInput, true);
  const original = call('journal-get', target, true);
  const records = call('journal-list', {}, true), calibration = call('journal-statistics', { minSampleSize: 30 }, true);
  const reopened = call('task-get', { taskId: task.id });
  return { kind: 'synthetic-runtime-acceptance', taskId: task.id, retainedOriginal: task.sources[0].contentSha256,
    submissionDeduplicated: task.id === retried.id, candidateInitiallyUnverified: blocked.reasonCodes.includes('UNVERIFIED_EVIDENCE'),
    workflowCompleted: reopened.phase === 'completed', publicationDeduplicated: committed.publication.journalRecord.id === commitReplay.publication.journalRecord.id,
    reviewDeduplicated: review.journalRecord.id === reviewReplay.journalRecord.id, originalProbability: original.data.probability,
    journalKinds: records.records.map(row => row.kind).sort(), resolutionRecorded: resolution.status === 'committed',
    calibration, externalModelCalls: 0, telegramMessages: 0, brokerOrders: 0, strategyPromotionAuthorized: false,
    productionTradingAuthorized: false };
}

export function runRuntimeDemo() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-runtime-demo-'));
  try {
    return exerciseRuntime((command, request, operator = false) => {
      const host = createResearchHost({ directory, agentId: 'main', environment: 'test', actorId: operator ? 'fixture-operator' : 'fixture-agent',
        mode: operator ? 'operator-test' : 'agent' });
      try { return host.execute(command, request); } finally { host.close(); }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
