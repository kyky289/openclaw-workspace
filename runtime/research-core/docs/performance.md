# Offline investment performance

The long-term objective is sustainable actual net profit within the user's
approved risk limits. Paper trading is an acceptance stage before limited live
trading, not the final objective. This module measures supplied historical
results and evaluates explicit paper gates. It does not fetch prices, connect
accounts, submit trades, change permissions, or infer future profitability.

## Calculate

```js
import { calculatePerformance, assessPaperReadiness } from './src/performance.mjs';

const metrics = calculatePerformance({
  closedTrades: [
    { id: 'synthetic-1', grossPnl: 15, costs: 2 },
    { id: 'synthetic-2', grossPnl: -4, costs: 1 },
  ],
  equityCurve: [
    { timestamp: '2030-01-01T00:00:00Z', equity: 100, benchmarkEquity: 200 },
    { timestamp: '2030-01-02T00:00:00Z', equity: 113, benchmarkEquity: 206 },
    { timestamp: '2030-01-03T00:00:00Z', equity: 108, benchmarkEquity: 208 },
  ],
  cashFlows: [],
});
```

Either sample array may be omitted. Each accepts at most 100,000 entries and
rejects sparse arrays, unknown fields and malformed values. Trade IDs must be
unique nonempty strings of at most 128 characters, without surrounding whitespace
or NUL. Every trade requires finite numeric `grossPnl` and `costs >= 0`.

All money uses the **same caller-supplied currency** and accounting period.
`costs` is the total cost allocated to the closed trade: commissions, slippage,
fees and any other applicable costs included in the chosen accounting basis.
Do not double count a cost already deducted from `grossPnl`. The function cannot
detect omitted costs, currency conversion errors, fabricated trades or selective
exclusion of losing trades. It does not decide tax/accounting treatment.

Amounts support at most six decimal places. Decimal spellings are converted
to integer micro-units and summed using `BigInt`, avoiding binary-float monetary
aggregation errors. More precise amounts are rejected, never silently rounded.
Each amount and aggregate must fit the safe integer micro-unit range and
round-trip to the exported numeric amount without losing a micro-unit. Very
large or high-precision datasets need a separately reviewed decimal/string
interface. Averages and ratios are approximate JavaScript numbers.

`equity` is **mark-to-market account equity already net of costs**, including
unrealized positions. The first point must be positive; later points may be zero
or negative so a total capital loss or negative net asset value remains visible.
A wipeout can produce 100% drawdown and negative equity can produce drawdown
greater than 100%. This only measures supplied data; it does not enable leverage,
borrowing or execution. Costs are not subtracted again from the curve.
Timestamps are valid ISO UTC strings (`YYYY-MM-DDTHH:mm:ssZ` or 1–3
fractional digits), strictly increasing with no duplicates. Provide positive
`benchmarkEquity` at every curve point or omit it everywhere; the benchmark
must use aligned observation times and an appropriate comparable return basis.

The curve assumes **no external deposits or withdrawals**. A nonempty
`cashFlows` array is explicitly rejected; omitted cash flows mean the caller
asserts there were none. Unknown per-point fields such as `deposit` are rejected.
Undeclared cash flows cannot be detected from equity alone. For portfolios with
cash flows, implement an appropriate cash-flow-adjusted method before using these
returns; this module does not compute TWR or money-weighted returns.

Closed-trade PnL and marked account equity measure different views, particularly
with open positions. Their reconciliation and date alignment are the caller's
responsibility. Do not silently use only closed positions to conceal open losses.

## Metrics and definitions

All return/drawdown/win-rate values are fractions (`0.10` means 10%).

| Field | Definition |
| --- | --- |
| `netPnl` | Sum of each closed trade's `grossPnl - costs` |
| `grossPnl`, `totalCosts` | Supplied gross PnL and cost totals |
| `winRate` | Net-positive trades / all closed trades, including zero-PnL trades |
| `avgWin` | Mean positive net PnL among winning trades |
| `avgLoss` | Absolute mean negative net PnL among losing trades |
| `payoffRatio` | `avgWin / avgLoss`; null if either category is absent |
| `winningPnl`, `losingPnl` | Sum of positive net PnL and absolute sum of negative net PnL |
| `profitFactor` | `winningPnl / losingPnl`; null if there are no losing trades |
| `expectancy` | Net PnL per closed trade, including zero-PnL trades |
| `totalReturn` | Last net equity / first net equity − 1 |
| `maxDrawdown` | Largest `(running peak - subsequent equity) / running peak` |
| `benchmarkReturn` | Last benchmark equity / first benchmark equity − 1 |
| `excessReturn` | Arithmetic difference `totalReturn - benchmarkReturn` |

The output also includes `schemaVersion`, `kind`, trade counts (`tradeCount`,
`winCount`, `lossCount`, `flatCount`), `equityPointCount`, `startAt`, `endAt`,
`durationMs` and declared accounting `basis`. Duration is the elapsed curve
coverage, not a verified trading-session count, trading exposure or evidence
that every trade belongs within that period. Drawdown is based on the supplied
sampling points; sparse data can miss intraday losses. Returns are not annualized
and excess return is not risk-adjusted alpha.

With zero closed trades, PnL, costs, win rate, averages and expectancy are `null`,
not zero. With fewer than two equity points, returns, drawdown and duration are
`null`. Missing benchmark data yields null benchmark/excess returns.

For a zero-loss sample, `profitFactorStatus` is `no-losses` and `profitFactor`
is null. `profitFactorUnbounded` is true only when at least one winning trade
exists and there are no losses; it is false for all-flat or empty samples.
This flag is not evidence of infinite future profitability. An empty trade
sample uses `profitFactorStatus: 'no-trades'`; otherwise a computable ratio uses
`defined` (including a zero ratio for an all-losing sample).

## Explicit paper acceptance gates

```js
// Values must come from a user-approved evaluation plan, not library defaults.
const assessment = assessPaperReadiness(metrics, approvedThresholds);
// {
//   status: 'pass' | 'fail' | 'insufficient',
//   checks: [{metric, actual, operator, threshold, outcome}],
//   automaticTradingAuthorized: false,
//   interpretation: 'Historical paper gate only; ...'
// }
```

Required thresholds:

- `minTrades`: positive integer minimum closed-trade count.
- `minDurationMs`: positive integer minimum equity-curve coverage.
- `minNetPnl`: minimum closed net PnL in the same input currency.
- `minTotalReturn`: minimum net account return fraction.
- `maxDrawdown`: maximum allowed drawdown fraction from 0 through 1. Observed
  drawdown may exceed 1 after negative equity and consequently fails this gate.

Optional thresholds are `minProfitFactor` (nonnegative) and `minExcessReturn`.
There are deliberately no default profit, return, sample or duration thresholds.
All supplied thresholds must be finite and structurally valid. Their suitability
for a strategy and sample remains a separate research decision.

Missing measurements or unmet minimum sample/duration produce `insufficient`.
Other failed thresholds remain visible in `checks` even when the overall status
is insufficient. When evidence is sufficient, any failed comparison produces
`fail`; otherwise the result is `pass`. Requiring a profit-factor threshold with
no observed losing trades produces `insufficient`, rather than treating null as
zero or assuming an infinite ratio passes. Requiring an absent benchmark also
produces `insufficient`.

Pass means only that the supplied historical paper measurements meet those
explicit comparisons. It **does not guarantee future net profit**, establish
statistical significance, validate strategy independence, or automatically
authorize real trading. Execution reliability, account reconciliation, data
quality, risk controls and a separately approved limited-live rollout still
require their own acceptance tests. Paper execution differs from real fills;
eventual live evaluation must use actual filled prices and complete costs.

`assessPaperReadiness` expects metrics from `calculatePerformance` and performs
basic consistency checks. It is a reporting function, not a cryptographic
attestation or authorization boundary. The trusted application must preserve
the provenance of input data and chosen thresholds.

## Offline tests

Run `node --test test/performance.test.mjs`. Tests cover high-win-rate losses,
low-win-rate profits, cost reversals, zero/all-winning/flat samples, exact
micro-unit sums, drawdown peaks/troughs, benchmark alignment, invalid timestamps,
cash-flow rejection, nonfinite inputs and explicit readiness comparisons.
No network, model, trading, filesystem storage or service is used.
