import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorQueue } from './monitor-queue.mjs';
import { createJournal } from './journal.mjs';
import { createResearch } from './research.mjs';
import { createBudgetLedger } from './budget.mjs';
import { createModelDispatcher } from './dispatcher.mjs';
import { createDefaultPolicy } from './router.mjs';
import { calculatePerformance, assessPaperReadiness } from './performance.mjs';

/** Synthetic end-to-end rehearsal; owns only its temporary directory and calls no external service. */
export async function runPipelineDemo() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-pipeline-demo-'));
  const scope = { directory, agentId: 'demo', environment: 'test' };
  const handles = [];
  try {
    let now = Date.now();
    const queue = createMonitorQueue({ ...scope, clock: () => now }); handles.push(queue);
    const journal = createJournal(scope); handles.push(journal);
    const identity = Object.freeze({ fixtureOnly: true });
    const research = createResearch({ ...scope, journal,
      authorizeVerification: context => context === identity ? { actorId: 'demo-reviewer' } : null }); handles.push(research);
    const ledger = createBudgetLedger({ directory, accountId: 'demo', environment: 'test', unit: 'test-unit', limitUnits: 100 }); handles.push(ledger);
    const policy = createDefaultPolicy(); policy.budget.unit = 'test-unit';
    for (const role of ['fast','standard','deep']) policy.models[role] = {
      modelRef: `fixture/${role}`, approved: true, ready: true, capabilities: ['text'], estimatedUnits: 10 };
    let syntheticInvocations = 0;
    const dispatcher = createModelDispatcher({ ...scope, ledger, policy, invoke: async ({ modelOverride }) => {
      syntheticInvocations++;
      return { provider: modelOverride.providerOverride, model: modelOverride.modelOverride, costUnits: 4,
        output: 'Synthetic material is insufficient for a trade; wait for further evidence.' };
    } }); handles.push(dispatcher);
    const event = { sourceKey: 'fixture-release', content: 'SYNTHETIC: no real company or market data.', metadata: { synthetic: true } };
    const queued = queue.enqueue(event);
    const duplicateEvent = queue.enqueue(event);
    const firstLease = queue.claim({ workerId: 'worker-first', leaseMs: 1000 });
    const evidence = research.recordEvidence({ sourceFamily: 'synthetic-primary-source', kind: 'fact',
      source: 'Synthetic fixture', locator: `queue:${queued.task.id}`, contentSha256: queued.task.contentHash,
      publishedAt: '2026-01-01T00:00:00Z', observedAt: '2026-01-01T00:01:00Z', idempotencyKey: `evidence-${queued.task.id}` });
    research.verifyEvidence({ evidenceId: evidence.id, expectedVersion: 1, status: 'verified',
      reason: 'Fixture bytes and hash inspected by test host, not a financial claim.', idempotencyKey: 'demo-verify' }, identity);
    const request = { taskId: queued.task.id, idempotencyKey: queued.task.id,
      request: { metadata: { risk: 'high', impact: 'financial', complexity: 'high' }, prompt: 'Review the synthetic evidence.', dryRun: false } };
    const dispatched = await dispatcher.dispatch(request);
    if (dispatched.status !== 'completed') throw new Error('DEMO_DISPATCH_FAILED');
    const frozen = research.freezeTask({ title: 'Synthetic research task', evidenceIds: [evidence.id],
      thesis: { id: 'synthetic', version: '1', locator: 'fixture:thesis-v1' },
      skill: { id: 'research-brain', version: 'integration-candidate' },
      model: { provider: 'fixture', id: 'deep', version: '1' }, strategy: { id: 'synthetic', version: '1' }, idempotencyKey: 'demo-freeze' });
    const publishInput = { taskId: frozen.id, kind: 'decision', data: { title: 'Synthetic hold decision',
      action: 'hold', reason: dispatched.output }, idempotencyKey: queued.task.id };
    const committed = research.publish(publishInput);
    // Reproduce the crash window after durable publication but before queue acknowledgement.
    now += 2100;
    const recovered = queue.claim({ workerId: 'worker-recovery', leaseMs: 1000 });
    const replay = research.publish(publishInput);
    const dispatchReplay = await dispatcher.dispatch(request);
    const ack = queue.ack({ id: recovered.id, leaseToken: recovered.leaseToken,
      result: { journalId: replay.journalRecord.id, taskSnapshotSha256: replay.taskSnapshotSha256 } });
    const metrics = calculatePerformance({ closedTrades: [
      { id: 'a', grossPnl: 12, costs: 2 }, { id: 'b', grossPnl: 12, costs: 2 },
      { id: 'c', grossPnl: 12, costs: 2 }, { id: 'd', grossPnl: -48, costs: 2 },
    ], equityCurve: [
      { timestamp: '2026-01-01T00:00:00Z', equity: 1000, benchmarkEquity: 1000 },
      { timestamp: '2026-01-02T00:00:00Z', equity: 1030, benchmarkEquity: 1002 },
      { timestamp: '2026-01-03T00:00:00Z', equity: 980, benchmarkEquity: 1005 },
    ] });
    const paperGate = assessPaperReadiness(metrics, { minTrades: 4, minDurationMs: 2 * 86400000,
      minNetPnl: 0, minTotalReturn: 0, maxDrawdown: 0.1 });
    return { kind: 'synthetic-integration-rehearsal', externalModelCalls: 0, telegramMessages: 0, realOrders: 0,
      eventDeduplicated: duplicateEvent.created === false, recoveredSameTask: firstLease.id === recovered.id,
      publicationDeduplicated: committed.journalRecord.id === replay.journalRecord.id,
      journalRecordCount: journal.list().total, queueStatus: ack.status,
      syntheticInvocations, dispatchReplayed: dispatchReplay.replayed, budget: ledger.summary(),
      syntheticPerformance: metrics, illustrativePaperGate: paperGate,
      realTradingAuthorized: false, note: 'All data and thresholds are synthetic; these are not approved live trading limits.' };
  } finally { for (const handle of handles.reverse()) handle.close(); rmSync(directory, { recursive: true, force: true }); }
}
