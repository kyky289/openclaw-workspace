import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePerformance, assessPaperReadiness } from '../src/performance.mjs';

const trade = (id, grossPnl, costs = 0) => ({ id, grossPnl, costs });
const curve = values => values.map((equity, index) => ({ timestamp: `2030-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`, equity }));
const day = 86400000;
const thresholds = { minTrades: 2, minDurationMs: day, minNetPnl: 1, minTotalReturn: 0.01, maxDrawdown: 0.2 };
const invalid = error => error.code === 'VALIDATION';
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('high win rate can still lose money and fail the net-profit gate', () => {
  const trades = [...Array.from({ length: 9 }, (_, index) => trade(`win-${index}`, 1)), trade('large-loss', -20)];
  const metrics = calculatePerformance({ closedTrades: trades, equityCurve: curve([100, 89]) });
  assert.equal(metrics.winRate, 0.9); assert.equal(metrics.netPnl, -11);
  assert.equal(metrics.avgWin, 1); assert.equal(metrics.avgLoss, 20);
  assert.equal(metrics.payoffRatio, .05); assert.equal(metrics.profitFactor, .45);
  assert.equal(metrics.expectancy, -1.1);
  assert.equal(assessPaperReadiness(metrics, thresholds).status, 'fail');
});

test('low win rate can be profitable with larger net winners', () => {
  const trades = [trade('win-1', 100), trade('win-2', 100), ...Array.from({ length: 8 }, (_, index) => trade(`loss-${index}`, -10))];
  const metrics = calculatePerformance({ closedTrades: trades, equityCurve: curve([1000, 960, 1120]) });
  assert.equal(metrics.netPnl, 120); assert.equal(metrics.winRate, .2);
  assert.equal(metrics.payoffRatio, 10); assert.equal(metrics.profitFactor, 2.5);
  assert.equal(metrics.expectancy, 12); assert.equal(metrics.totalReturn, .12);
  const gate = assessPaperReadiness(metrics, { ...thresholds, minTrades: 10, minProfitFactor: 2 });
  assert.equal(gate.status, 'pass'); assert.equal(gate.automaticTradingAuthorized, false);
});

test('transaction costs can reverse a gross winner, and curve costs are not subtracted twice', () => {
  const metrics = calculatePerformance({ closedTrades: [trade('a', 1, 2)], equityCurve: curve([100, 99]) });
  assert.equal(metrics.grossPnl, 1); assert.equal(metrics.totalCosts, 2); assert.equal(metrics.netPnl, -1);
  assert.equal(metrics.winRate, 0); assert.equal(metrics.avgLoss, 1); assert.equal(metrics.avgWin, null);
  assert.equal(metrics.profitFactor, 0); assert.equal(metrics.totalReturn, -.01);
});

test('zero-PnL trades are in the denominator and neither winners nor losers', () => {
  const metrics = calculatePerformance({ closedTrades: [trade('a', 10), trade('b', -5), trade('c', 2, 2)] });
  assert.equal(metrics.tradeCount, 3); assert.equal(metrics.winCount, 1); assert.equal(metrics.lossCount, 1); assert.equal(metrics.flatCount, 1);
  assert.equal(metrics.winRate, 1 / 3); assert.equal(metrics.expectancy, 5 / 3);
  assert.equal(metrics.avgWin, 10); assert.equal(metrics.avgLoss, 5);
});

test('all-winning and all-flat samples keep zero-loss ratios explicit rather than numeric infinity', () => {
  const winners = calculatePerformance({ closedTrades: [trade('a', 3), trade('b', 1)] });
  assert.equal(winners.avgWin, 2); assert.equal(winners.avgLoss, null); assert.equal(winners.payoffRatio, null);
  assert.equal(winners.profitFactor, null); assert.equal(winners.profitFactorStatus, 'no-losses');
  assert.equal(winners.profitFactorUnbounded, true);
  const flat = calculatePerformance({ closedTrades: [trade('a', 1, 1)] });
  assert.equal(flat.winRate, 0); assert.equal(flat.netPnl, 0); assert.equal(flat.profitFactor, null);
  assert.equal(flat.profitFactorUnbounded, false);
});

test('no trades and insufficient curves produce null measurements rather than fake success', () => {
  const empty = calculatePerformance({});
  for (const key of ['netPnl', 'winRate', 'avgWin', 'avgLoss', 'payoffRatio', 'profitFactor', 'expectancy', 'totalReturn', 'maxDrawdown', 'benchmarkReturn', 'excessReturn', 'durationMs']) assert.equal(empty[key], null, key);
  assert.equal(empty.profitFactorStatus, 'no-trades');
  assert.equal(assessPaperReadiness(empty, thresholds).status, 'insufficient');
  const onePoint = calculatePerformance({ equityCurve: curve([100]) });
  assert.equal(onePoint.equityPointCount, 1); assert.equal(onePoint.totalReturn, null); assert.equal(onePoint.maxDrawdown, null);
});

test('micro-unit aggregation avoids familiar decimal addition errors and rejects precision loss', () => {
  const metrics = calculatePerformance({ closedTrades: [trade('a', .1), trade('b', .2), trade('c', .000001)] });
  assert.equal(metrics.netPnl, .300001);
  assert.throws(() => calculatePerformance({ closedTrades: [trade('a', .0000001)] }), invalid);
  assert.throws(() => calculatePerformance({ closedTrades: [trade('a', 1e20)] }), invalid);
  assert.throws(() => calculatePerformance({ closedTrades: [trade('a', 9e9), trade('b', 9e9)] }), invalid);
});

test('maximum drawdown tracks the latest running peak, including recovered troughs', () => {
  const metrics = calculatePerformance({ equityCurve: curve([100, 120, 90, 130, 104, 150]) });
  assert.equal(metrics.maxDrawdown, .25); assert.equal(metrics.totalReturn, .5);
  assert.equal(metrics.durationMs, 5 * day);
  const monotonic = calculatePerformance({ equityCurve: curve([100, 110, 120]) });
  assert.equal(monotonic.maxDrawdown, 0);
});

test('zero or negative later equity preserves catastrophic losses and fails the paper gate', () => {
  const closedTrades = [trade('loss-1', -50), trade('loss-2', -50)];
  const wipedOut = calculatePerformance({ closedTrades, equityCurve: curve([100, 0]) });
  assert.equal(wipedOut.totalReturn, -1); assert.equal(wipedOut.maxDrawdown, 1);
  const negative = calculatePerformance({ closedTrades: [trade('loss-1', -50), trade('loss-2', -60)], equityCurve: curve([100, -10]) });
  assert.equal(negative.totalReturn, -1.1); assert.equal(negative.maxDrawdown, 1.1);
  for (const metrics of [wipedOut, negative]) {
    const gate = assessPaperReadiness(metrics, thresholds);
    assert.equal(gate.status, 'fail');
    assert.equal(gate.checks.find(check => check.metric === 'maxDrawdown').outcome, 'fail');
    assert.equal(gate.automaticTradingAuthorized, false);
  }
  assert.throws(() => calculatePerformance({ equityCurve: [{ ...curve([100])[0], benchmarkEquity: 100 },
    { ...curve([100, 0])[1], benchmarkEquity: 0 }] }), invalid);
});

test('benchmark return is aligned and excess return is the arithmetic difference', () => {
  const equityCurve = curve([100, 90, 120]).map((point, index) => ({ ...point, benchmarkEquity: [200, 190, 220][index] }));
  const metrics = calculatePerformance({ equityCurve });
  assert.equal(metrics.totalReturn, .2); assert.equal(metrics.benchmarkReturn, .1); close(metrics.excessReturn, .1);
  assert.throws(() => calculatePerformance({ equityCurve: [equityCurve[0], curve([100, 120])[1]] }), invalid);
  assert.throws(() => calculatePerformance({ equityCurve: [{ ...curve([100])[0], benchmarkEquity: 0 }] }), invalid);
});

test('unordered/equal/invalid timestamps and nonpositive initial or nonfinite equity are rejected', () => {
  const data = curve([100, 110]);
  for (const equityCurve of [[data[1], data[0]], [data[0], data[0]], [{ ...data[0], timestamp: '2030-02-30T00:00:00Z' }],
    [{ ...data[0], timestamp: '2030-01-01' }], [{ ...data[0], equity: 0 }], [{ ...data[0], equity: -1 }], [{ ...data[0], equity: NaN }]]) {
    assert.throws(() => calculatePerformance({ equityCurve }), invalid);
  }
});

test('duplicate ids, invalid trades, external flows and unknown fields are rejected', () => {
  for (const closedTrades of [[trade('same', 1), trade('same', 2)], [trade('a', Infinity)], [trade('a', 1, -1)],
    [trade('a', 1, NaN)], [trade('', 1)], [trade('a', '1')], new Array(2)]) assert.throws(() => calculatePerformance({ closedTrades }), invalid);
  assert.throws(() => calculatePerformance({ cashFlows: [{ amount: 1 }] }), invalid);
  assert.throws(() => calculatePerformance({ equityCurve: [{ ...curve([100])[0], deposit: 1 }] }), invalid);
  assert.throws(() => calculatePerformance({ closedTrades: null }), invalid);
  assert.throws(() => calculatePerformance({ cashFlows: null }), invalid);
  assert.equal(calculatePerformance({ cashFlows: [] }).tradeCount, 0);
});

test('readiness requires explicit thresholds and sufficient sample plus observation duration', () => {
  const metrics = calculatePerformance({ closedTrades: [trade('a', 10), trade('b', -1)], equityCurve: curve([100, 109]) });
  assert.throws(() => assessPaperReadiness(metrics, {}), invalid);
  assert.throws(() => assessPaperReadiness(metrics, { ...thresholds, minTrades: 0 }), invalid);
  assert.throws(() => assessPaperReadiness(metrics, { ...thresholds, minDurationMs: 0 }), invalid);
  assert.throws(() => assessPaperReadiness(metrics, { ...thresholds, maxDrawdown: NaN }), invalid);
  assert.equal(assessPaperReadiness(metrics, { ...thresholds, minTrades: 3 }).status, 'insufficient');
  assert.equal(assessPaperReadiness(metrics, { ...thresholds, minDurationMs: 2 * day }).status, 'insufficient');
  const passed = assessPaperReadiness(metrics, thresholds);
  assert.equal(passed.status, 'pass'); assert.equal(passed.automaticTradingAuthorized, false);
});

test('requiring absent benchmarks or undefined zero-loss profit factor is insufficient', () => {
  const metrics = calculatePerformance({ closedTrades: [trade('a', 5), trade('b', 4)], equityCurve: curve([100, 109]) });
  assert.equal(assessPaperReadiness(metrics, { ...thresholds, minProfitFactor: 1 }).status, 'insufficient');
  assert.equal(assessPaperReadiness(metrics, { ...thresholds, minExcessReturn: 0 }).status, 'insufficient');
  assert.equal(assessPaperReadiness(metrics, thresholds).status, 'pass');
});

test('drawdown and benchmark gates can fail despite positive closed net PnL', () => {
  const metrics = calculatePerformance({ closedTrades: [trade('a', 10), trade('b', -1)],
    equityCurve: curve([100, 60, 109]).map((point, index) => ({ ...point, benchmarkEquity: [100, 110, 120][index] })) });
  const gate = assessPaperReadiness(metrics, { ...thresholds, minExcessReturn: 0 });
  assert.equal(gate.status, 'fail');
  assert.equal(gate.checks.find(check => check.metric === 'maxDrawdown').outcome, 'fail');
  assert.equal(gate.checks.find(check => check.metric === 'excessReturn').outcome, 'fail');
  assert.equal(gate.automaticTradingAuthorized, false);
});

test('readiness rejects malformed or inconsistent metrics instead of accepting NaN comparisons', () => {
  const metrics = calculatePerformance({ closedTrades: [trade('a', 10), trade('b', -1)], equityCurve: curve([100, 109]) });
  for (const patch of [{ netPnl: NaN }, { profitFactor: Infinity }, { durationMs: null }, { tradeCount: 0 }, { maxDrawdown: -1 }]) {
    assert.throws(() => assessPaperReadiness({ ...metrics, ...patch }, thresholds), invalid);
  }
});
