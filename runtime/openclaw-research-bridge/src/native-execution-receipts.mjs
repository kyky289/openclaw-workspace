import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOOLS = new Set(['research_task_submit', 'research_task_propose']);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const rawHash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const utc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const outcome = (status, code) => ({ status, reasonCodes: [code] });
const blocks = row => Array.isArray(row.message?.content) ? row.message.content : [];
const clone = value => JSON.parse(JSON.stringify(value));

function envelope(block) {
  if (block.is_error === true) return null;
  const content = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
    || typeof content[0].text !== 'string' || Buffer.byteLength(content[0].text) > 512 * 1024) return null;
  try {
    const value = JSON.parse(content[0].text);
    return plain(value) && value.ok === true && value.automaticTradingAuthorized === false && plain(value.result) ? value : null;
  } catch { return null; }
}

function expectedResult(binding, value) {
  if (hash(value) !== binding.resultSha256 || !utc(value.createdAt)
    || Date.parse(value.createdAt) !== Date.parse(binding.createdAt)) return false;
  if (binding.toolName === 'research_task_submit') return value.id === binding.taskId
    && value.submittedBy === binding.actorId && binding.proposalId === null;
  return value.id === binding.proposalId && value.taskId === binding.taskId && value.proposedBy === binding.actorId
    && value.status === 'candidate';
}

function messageUsage(rows, nativeSessionId, messageId) {
  const mapping = { inputTokens: 'input_tokens', outputTokens: 'output_tokens',
    cacheReadInputTokens: 'cache_read_input_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens' };
  const tokens = {};
  for (const [target, field] of Object.entries(mapping)) {
    const values = rows.map(row => row.message.usage?.[field]).filter(value => value !== undefined && value !== null);
    if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)
      || new Set(values).size > 1) return null;
    tokens[target] = values[0] ?? null;
  }
  const measured = Object.values(tokens).some(value => value !== null);
  return { granularity: measured ? 'message' : 'unknown',
    accountingKey: measured ? hash(['claude-cli-message-usage-v1', nativeSessionId, messageId]) : null, ...tokens };
}

/** Pure correlation only. The caller must supply a host-captured binding and an exact, trusted native session source. */
export function collectNativeExecution({ binding, source } = {}) {
  try {
    if (!plain(binding) || !plain(source) || !TOOLS.has(binding.toolName) || !UUID.test(source.nativeSessionId ?? '')
      || (binding.nativeSessionId !== null && binding.nativeSessionId !== source.nativeSessionId)
      || !SHA.test(binding.requestSha256 ?? '') || !SHA.test(binding.resultSha256 ?? '') || !utc(binding.createdAt)
      || typeof binding.actorId !== 'string' || typeof binding.taskId !== 'string'
      || !Array.isArray(source.records) || source.records.length > 200_000) return outcome('rejected', 'NATIVE_BINDING_INVALID');
    if (binding.requestedModel !== null && (!plain(binding.requestedModel)
      || !['provider', 'id'].every(key => typeof binding.requestedModel[key] === 'string'
        && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(binding.requestedModel[key])))) return outcome('rejected', 'NATIVE_BINDING_INVALID');

    const records = new Map();
    for (const row of source.records) {
      if (!plain(row) || row.sessionId !== source.nativeSessionId || row.isSidechain !== false
        || !['assistant', 'user'].includes(row.type) || !utc(row.timestamp) || typeof row.uuid !== 'string') continue;
      const previous = records.get(row.uuid);
      if (previous && canonical(previous) !== canonical(row)) return outcome('rejected', 'NATIVE_RECORD_CONFLICT');
      records.set(row.uuid, row);
    }
    const rows = [...records.values()];
    const calls = [];
    for (const row of rows) {
      if (row.type !== 'assistant' || row.message?.role !== 'assistant' || typeof row.message?.id !== 'string') continue;
      for (const block of blocks(row)) {
        if (block?.type !== 'tool_use' || block.name !== `mcp__openclaw__${binding.toolName}`
          || typeof block.id !== 'string' || !plain(block.input) || hash(block.input) !== binding.requestSha256) continue;
        // Bridge's MCP execution ID is independently generated; never compare it to native tool_use.id.
        const results = rows.flatMap(resultRow => {
          if (resultRow.type !== 'user' || resultRow.message?.role !== 'user'
            || resultRow.sourceToolAssistantUUID !== row.uuid || Date.parse(resultRow.timestamp) < Date.parse(row.timestamp)) return [];
          return blocks(resultRow).flatMap(resultBlock => {
            if (resultBlock?.type !== 'tool_result' || resultBlock.tool_use_id !== block.id) return [];
            const value = envelope(resultBlock);
            return value && expectedResult(binding, value.result) ? [{ row: resultRow, block: resultBlock }] : [];
          });
        });
        // A replay of an older idempotent write cannot be re-attributed to the later model call.
        for (const result of results) if (Date.parse(row.timestamp) <= Date.parse(binding.createdAt)
          && Date.parse(binding.createdAt) <= Date.parse(result.row.timestamp)) calls.push({ row, block, result });
      }
    }
    if (!calls.length) return outcome('pending', 'NATIVE_MATCH_PENDING');
    if (calls.length !== 1) return outcome('rejected', 'NATIVE_MATCH_AMBIGUOUS');
    const { row, block, result } = calls[0];
    const messageRows = rows.filter(item => item.type === 'assistant' && item.message?.id === row.message.id);
    const models = new Set(messageRows.map(item => item.message.model));
    const requestIds = new Set(messageRows.map(item => item.requestId).filter(value => value !== undefined));
    if (models.size !== 1 || requestIds.size > 1 || typeof row.message.model !== 'string'
      || !/^claude-[a-zA-Z0-9._-]{1,120}$/.test(row.message.model)) return outcome('rejected', 'NATIVE_MODEL_CONFLICT');
    const usage = messageUsage(messageRows, source.nativeSessionId, row.message.id);
    if (!usage) return outcome('rejected', 'NATIVE_USAGE_CONFLICT');
    // Hash only the relevant message records and successful paired result. No private text/IDs are returned.
    const relevant = [...messageRows, result.row].sort((a, b) => a.uuid.localeCompare(b.uuid));
    return { status: 'observed', nativeSessionId: source.nativeSessionId, observation: {
      source: { kind: 'native-runtime-log', adapterId: 'claude-cli-jsonl', adapterVersion: '1', recordSha256: hash(relevant) },
      correlation: { nativeSessionSha256: rawHash(source.nativeSessionId), nativeRunSha256: null,
        messageSha256: rawHash(row.message.id), toolCallSha256: rawHash(block.id),
        requestSha256: binding.requestSha256, resultSha256: binding.resultSha256, toolName: binding.toolName },
      requestedModel: clone(binding.requestedModel), observedModel: { provider: 'anthropic', id: row.message.model }, usage,
      cost: { status: 'unknown', currency: 'USD', amountUsd: null, basis: 'unknown', granularity: 'unknown', accountingKey: null },
      startedAt: new Date(row.timestamp).toISOString(), endedAt: new Date(result.row.timestamp).toISOString(), outcome: 'tool-succeeded',
    } };
  } catch { return outcome('rejected', 'NATIVE_RECORD_INVALID'); }
}
