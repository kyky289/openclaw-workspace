const MICRO = 1_000_000n;
const MAX_SAFE_MICRO = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAMPLES = 100_000;

export class PerformanceError extends Error {
  constructor(code, message) { super(message); this.name = 'PerformanceError'; this.code = code; }
}
function requireValue(condition, message) { if (!condition) throw new PerformanceError('VALIDATION', message); }
function object(value, keys, required = keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Expected a plain object');
  requireValue(Object.keys(value).every(key => keys.includes(key)), 'Unknown field');
  requireValue(required.every(key => Object.hasOwn(value, key)), 'Missing required field');
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${label}`);
}
function finite(value, label) { requireValue(typeof value === 'number' && Number.isFinite(value), `Invalid ${label}`); }
function money(value, label) {
  finite(value, label);
  // Parse the number's decimal spelling instead of multiplying binary floats
  // and silently rounding. All monetary arithmetic below uses integer micros.
  const [coefficient, exponent = '0'] = value.toString().toLowerCase().split('e');
  const fractionDigits = coefficient.includes('.') ? coefficient.split('.')[1].length : 0;
  const digits = BigInt(coefficient.replace('.', ''));
  const power = 6 + Number(exponent) - fractionDigits;
  let units;
  if (power >= 0) units = digits * (10n ** BigInt(power));
  else {
    const divisor = 10n ** BigInt(-power);
    requireValue(digits % divisor === 0n, `${label} requires more than six decimal places`);
    units = digits / divisor;
  }
  requireValue(units >= -MAX_SAFE_MICRO && units <= MAX_SAFE_MICRO, `${label} exceeds the safe monetary range`);
  return units;
}
function fromMoney(units, label) {
  requireValue(units >= -MAX_SAFE_MICRO && units <= MAX_SAFE_MICRO, `${label} exceeds the safe monetary range`);
  const value = Number(units) / Number(MICRO);
  requireValue(money(value, label) === units, `${label} cannot be exported without losing monetary precision`);
  return value;
}
function timestamp(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value), 'Use ISO UTC equity timestamps');
  const time = Date.parse(value);
  const normalized = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  requireValue(Number.isFinite(time) && new Date(time).toISOString() === normalized, 'Invalid equity timestamp');
  return time;
}
function samples(value, label) {
  requireValue(Array.isArray(value) && value.length <= MAX_SAMPLES, `Invalid ${label}`);
  requireValue(Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean), `${label} must not contain holes`);
}

/** Historical offline statistics, with no broker, model, execution or network. */
export function calculatePerformance(input) {
  object(input, ['closedTrades', 'equityCurve', 'cashFlows'], []);
  const trades = input.closedTrades === undefined ? [] : input.closedTrades;
  const curve = input.equityCurve === undefined ? [] : input.equityCurve;
  samples(trades, 'closedTrades'); samples(curve, 'equityCurve');
  if (input.cashFlows !== undefined) requireValue(Array.isArray(input.cashFlows) && input.cashFlows.length === 0,
    'External cash flows are unsupported; use an explicitly cash-flow-adjusted method');

  const ids = new Set();
  let gross = 0n, costs = 0n, winning = 0n, losing = 0n;
  let wins = 0, losses = 0, flat = 0;
  for (const trade of trades) {
    object(trade, ['id', 'grossPnl', 'costs']);
    requireValue(typeof trade.id === 'string' && trade.id.trim() === trade.id && trade.id.length > 0
      && trade.id.length <= 128 && !trade.id.includes('\0') && !ids.has(trade.id), 'Trade IDs must be nonempty and unique');
    ids.add(trade.id);
    const tradeGross = money(trade.grossPnl, 'grossPnl');
    const tradeCosts = money(trade.costs, 'costs');
    requireValue(tradeCosts >= 0n, 'costs must be nonnegative');
    const net = tradeGross - tradeCosts;
    fromMoney(net, 'trade net PnL');
    gross += tradeGross; costs += tradeCosts;
    if (net > 0n) { wins++; winning += net; }
    else if (net < 0n) { losses++; losing -= net; }
    else flat++;
  }
  const grossPnl = fromMoney(gross, 'aggregate gross PnL');
  const totalCosts = fromMoney(costs, 'aggregate costs');
  const netPnl = fromMoney(gross - costs, 'aggregate net PnL');
  const winningPnl = fromMoney(winning, 'aggregate winning PnL');
  const losingPnl = fromMoney(losing, 'aggregate losing PnL');

  const hasBenchmark = curve.some(point => point && Object.hasOwn(point, 'benchmarkEquity'));
  let previousTime = null;
  const points = curve.map((point, index) => {
    object(point, ['timestamp', 'equity', 'benchmarkEquity'], ['timestamp', 'equity']);
    const time = timestamp(point.timestamp);
    requireValue(previousTime === null || time > previousTime, 'Equity timestamps must be strictly increasing');
    previousTime = time;
    const equity = money(point.equity, 'equity');
    requireValue(index !== 0 || equity > 0n, 'Initial equity must be positive');
    requireValue(Object.hasOwn(point, 'benchmarkEquity') === hasBenchmark, 'Benchmark values must be supplied for every point or none');
    const benchmark = hasBenchmark ? money(point.benchmarkEquity, 'benchmarkEquity') : null;
    if (hasBenchmark) requireValue(benchmark > 0n, 'benchmarkEquity must be positive');
    return { time, equity, benchmark };
  });
  let totalReturn = null, maxDrawdown = null, benchmarkReturn = null;
  if (points.length >= 2) {
    totalReturn = Number(points.at(-1).equity - points[0].equity) / Number(points[0].equity);
    if (hasBenchmark) benchmarkReturn = Number(points.at(-1).benchmark - points[0].benchmark) / Number(points[0].benchmark);
    let peak = points[0].equity;
    maxDrawdown = 0;
    for (const point of points) {
      if (point.equity > peak) peak = point.equity;
      maxDrawdown = Math.max(maxDrawdown, Number(peak - point.equity) / Number(peak));
    }
  }
  const count = trades.length;
  const avgWin = wins ? winningPnl / wins : null;
  const avgLoss = losses ? losingPnl / losses : null;
  return {
    schemaVersion: 1, kind: 'investment-performance',
    tradeCount: count, winCount: wins, lossCount: losses, flatCount: flat,
    grossPnl: count ? grossPnl : null, totalCosts: count ? totalCosts : null,
    netPnl: count ? netPnl : null, winningPnl: count ? winningPnl : null, losingPnl: count ? losingPnl : null,
    winRate: count ? wins / count : null, avgWin, avgLoss,
    payoffRatio: avgWin !== null && avgLoss !== null ? avgWin / avgLoss : null,
    profitFactor: losses ? winningPnl / losingPnl : null,
    profitFactorStatus: !count ? 'no-trades' : !losses ? 'no-losses' : 'defined',
    profitFactorUnbounded: wins > 0 && losses === 0,
    expectancy: count ? netPnl / count : null,
    equityPointCount: points.length,
    startAt: points.length ? new Date(points[0].time).toISOString() : null,
    endAt: points.length ? new Date(points.at(-1).time).toISOString() : null,
    durationMs: points.length >= 2 ? points.at(-1).time - points[0].time : null,
    totalReturn, maxDrawdown, benchmarkReturn,
    excessReturn: benchmarkReturn !== null ? totalReturn - benchmarkReturn : null,
    basis: { costs: 'included-in-trade-net-pnl-and-equity', cashFlows: 'none',
      currency: 'single-consistent-input-currency', monetaryPrecision: 'integer-micro-units',
      equityCurve: 'caller-supplied-mark-to-market-net-equity' },
  };
}

/** Compare explicit paper gates only. Never grants real trading authorization. */
export function assessPaperReadiness(metrics, thresholds) {
  object(thresholds, ['minTrades', 'minDurationMs', 'minNetPnl', 'minTotalReturn', 'maxDrawdown', 'minProfitFactor', 'minExcessReturn'],
    ['minTrades', 'minDurationMs', 'minNetPnl', 'minTotalReturn', 'maxDrawdown']);
  integer(thresholds.minTrades, 'minTrades', 1, MAX_SAMPLES);
  integer(thresholds.minDurationMs, 'minDurationMs', 1);
  money(thresholds.minNetPnl, 'minNetPnl'); finite(thresholds.minTotalReturn, 'minTotalReturn');
  finite(thresholds.maxDrawdown, 'maxDrawdown');
  requireValue(thresholds.maxDrawdown >= 0 && thresholds.maxDrawdown <= 1, 'maxDrawdown must be a fraction from 0 to 1');
  if (thresholds.minProfitFactor !== undefined) {
    finite(thresholds.minProfitFactor, 'minProfitFactor'); requireValue(thresholds.minProfitFactor >= 0, 'minProfitFactor must be nonnegative');
  }
  if (thresholds.minExcessReturn !== undefined) finite(thresholds.minExcessReturn, 'minExcessReturn');
  requireValue(metrics && typeof metrics === 'object' && !Array.isArray(metrics)
    && metrics.schemaVersion === 1 && metrics.kind === 'investment-performance', 'Use calculated performance metrics');
  integer(metrics.tradeCount, 'tradeCount', 0, MAX_SAMPLES); integer(metrics.equityPointCount, 'equityPointCount', 0, MAX_SAMPLES);
  if (metrics.durationMs !== null) integer(metrics.durationMs, 'durationMs', 1);
  for (const key of ['netPnl', 'totalReturn', 'maxDrawdown', 'profitFactor', 'excessReturn']) {
    if (metrics[key] !== null) finite(metrics[key], key);
  }
  if (metrics.netPnl !== null) money(metrics.netPnl, 'netPnl');
  requireValue(metrics.maxDrawdown === null || metrics.maxDrawdown >= 0, 'Invalid drawdown');
  requireValue(metrics.profitFactor === null || metrics.profitFactor >= 0, 'Invalid profit factor');
  requireValue((metrics.tradeCount === 0) === (metrics.netPnl === null), 'Inconsistent trade metrics');
  requireValue(metrics.equityPointCount >= 2
    ? metrics.durationMs !== null && metrics.totalReturn !== null && metrics.maxDrawdown !== null
    : metrics.durationMs === null && metrics.totalReturn === null && metrics.maxDrawdown === null, 'Inconsistent equity metrics');

  const checks = [];
  function check(metric, actual, operator, threshold, sample = false) {
    const passed = actual !== null && (operator === '>=' ? actual >= threshold : actual <= threshold);
    checks.push({ metric, actual, operator, threshold,
      outcome: actual === null || (sample && !passed) ? 'insufficient' : passed ? 'pass' : 'fail' });
  }
  check('tradeCount', metrics.tradeCount, '>=', thresholds.minTrades, true);
  check('durationMs', metrics.durationMs, '>=', thresholds.minDurationMs, true);
  check('netPnl', metrics.netPnl, '>=', thresholds.minNetPnl);
  check('totalReturn', metrics.totalReturn, '>=', thresholds.minTotalReturn);
  check('maxDrawdown', metrics.maxDrawdown, '<=', thresholds.maxDrawdown);
  if (thresholds.minProfitFactor !== undefined) check('profitFactor', metrics.profitFactor, '>=', thresholds.minProfitFactor);
  if (thresholds.minExcessReturn !== undefined) check('excessReturn', metrics.excessReturn, '>=', thresholds.minExcessReturn);
  return {
    status: checks.some(item => item.outcome === 'insufficient') ? 'insufficient'
      : checks.some(item => item.outcome === 'fail') ? 'fail' : 'pass',
    checks, automaticTradingAuthorized: false,
    interpretation: 'Historical paper gate only; passing does not guarantee future net profit or authorize real trading.',
  };
}
