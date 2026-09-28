# 模型执行观察凭证

`createExecutionReceipts` 保存可信宿主从原生运行记录取得的执行观察。它与研究任务、候选分析及某次工具调用绑定，独立于 `workflow.modelReceipt`：后者仍是采纳候选时绑定的模型信息。新增凭证不会核验证据、采纳分析、发布研究或授权交易。

凭证的 `verification` 固定为 `host-observed-not-provider-signed`。日志中的型号字符串是宿主观察到的型号，不是提供商签名；本地摘要链只能检查记录一致性，不提供供应商证明，也不能防止拥有同一操作系统账号权限的人重建整个数据库。

## 宿主接口

```js
import { createExecutionReceipts } from '../src/execution-receipts.mjs';

const trustedContext = Object.freeze({});
const receipts = createExecutionReceipts({
  directory: '/absolute/private/research-state',
  agentId: 'main', environment: 'test',
  authorizeWrite: (_request, context) => context === trustedContext
    ? { actorId: 'trusted-native-observer' } : null,
  resolveTarget({ taskId, proposalId }) {
    // 从此范围的真实 workflow 查询；确认 proposal 属于 task 后返回。
    // 不接收模型声明的 scope、actor、来源核验或执行授权。
    return { scope: { agentId: 'main', environment: 'test' }, taskId, proposalId };
  },
});
```

示例中的 `resolveTarget` 必须由宿主实现实际查询，不能照抄为无条件返回。缺少写入授权、缺少目标解析器、异步回调或未知身份时，写入默认拒绝。跨范围返回值、不存在的目标和不属于任务的候选也拒绝。授权只由宿主注入的函数决定，输入中的 `verified`、`recordedBy`、`scope`、`modelReceipt` 等额外字段不能授予权限。

此模块是内部能力句柄，不提供登录、网络 API 或操作系统沙箱。读取函数受句柄固定范围限制；宿主仍须先做会话授权，才可向模型或用户返回凭证。模型工具不应暴露 `append`。

```js
const record = receipts.append({
  executionId: 'er-stable-host-generated-id',
  idempotencyKey: 'er-stable-observation-version-key',
  expectedVersion: 0,
  taskId: 'wt-existing-task',
  proposalId: 'wp-existing-proposal', // submit 调用用 null
  observation: trustedAdapterObservation,
}, trustedContext);

receipts.get({ executionId: record.executionId }); // 最新版；不存在为 null
receipts.get({ executionId: record.executionId, version: 1 });
receipts.list({ taskId: record.taskId, limit: 20, offset: 0 });
receipts.list({ taskId: record.taskId, proposalId: record.proposalId });
receipts.history({ executionId: record.executionId, limit: 20, offset: 0 });
receipts.close();
```

`list` 和 `history` 返回 `{scope,total,limit,offset,receipts}`，每页最多 100 条。`list` 每次执行只返回最新版；`history` 保留所有版本。单条凭证最多 1,000 个版本，单次记录最多 16 KiB。没有删除或覆盖 API。

首条写入要求 `expectedVersion: 0`，后续追加要求等于最新版本。相同幂等键、相同输入返回原版本，即使已有新版；相同键不同输入拒绝。数据库事务、唯一约束、摘要链和禁止更新/删除的触发器保护本地追加过程。原生 session 与 tool call 的组合在同一 scope 中只能绑定一个 execution/task/proposal，不能改 ID 重复入库，也不能改到另一条真实候选。

## 观察字段

`observation` 只接受以下字段，任何额外字段都拒绝。

| 字段 | 内容 |
| --- | --- |
| `source` | `{kind,adapterId,adapterVersion,recordSha256}`；kind 为 `native-runtime-log`、`native-runtime-hook`、`provider-response` 或 `billing-reconciliation` |
| `correlation` | `nativeSessionSha256`、`toolCallSha256`、`requestSha256`、`resultSha256` 必须为 64 位小写 SHA256；`nativeRunSha256`、`messageSha256` 可为 null；`toolName` 只允许 `research_task_submit`、`research_task_propose` |
| `requestedModel` | `{provider,id}` 或 null；表示宿主请求的型号或别名 |
| `observedModel` | `{provider,id}` 或 null；表示原生记录观察到的型号，不自动从请求型号补齐 |
| `usage` | `{granularity,accountingKey,inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens}` |
| `cost` | `{status,currency,amountUsd,basis,granularity,accountingKey}` |
| `startedAt`、`endedAt` | 原生工具调用起止 UTC 时间，endedAt 可为 null；不代表整个模型 turn 起止 |
| `outcome` | `tool-succeeded`、`tool-failed` 或 `unknown`；不声称模型整轮完成 |

`recordSha256` 应只涵盖精确匹配的原生事件。不要对不断追加的整份 JSONL 计算这个摘要，以免不相干对话导致重复修订。`requestSha256`、`resultSha256` 分别绑定规范化工具输入和实际工具结果。原始会话 ID、工具 ID、日志路径、聊天内容、提示词、诊断文本和凭据不属于凭证字段。

原生会话、工具 ID、请求/结果摘要及工具名称在追加版本时不可更换。开始时未知的 run/message 摘要可随后补齐，已知后不可更换或清空。金额等新观察通过追加版本保留完整历史，不能改写旧版。

## 用量和费用

每个 token 数量独立允许 null，缺失不能填成零。用量全部未知时 `granularity: 'unknown'`、`accountingKey: null`；有数值时计量范围必须为 `message` 或 `run`，并带共享计量的稳定 SHA256 标识。

同一模型消息可能包含多次研究工具调用；每条凭证会关联同一条消息的用量。这些凭证必须保留同一个 `accountingKey`，不能逐 proposal 相加。后续统计应按范围和计量键去重，并只使用每条执行记录的最新版本；同一计量键的数值冲突时，应保留未知/待核对状态，不能任意选取或累加。本模块不返回 `totalTokens` 或 `totalCostUsd`，也不向预算账本自动记账。

| cost.status | cost.basis | amountUsd 语义 |
| --- | --- | --- |
| `unknown` | `unknown` | 必须为 null；granularity unknown、accountingKey null |
| `estimate` | `native-runtime-estimate` | 原生运行器的估算，不是账单 |
| `reported` | `provider-reported` | 上游报告的金额，尚未做账单核对 |
| `reconciled` | `billing-reconciled` | 可信账单核对；source.kind 必须为 billing-reconciliation |

币种目前只接受 USD；已知金额必须为有限非负数，并带 `message`/`run` 范围及计量键。已知零与未知严格区分。即使原生 CLI 提供费用估算，也不能将订阅消耗等同新增现金支出。账单核对真实性仍由可信适配器负责，不能仅凭设置 `reconciled` 字符串声称已完成核对。

## 验证

执行 `node research-core/test/execution-receipts.test.mjs`。测试仅使用临时 SQLite 与合成观察，覆盖授权、真实关系/跨范围校验、重启后幂等、版本冲突、调用重复绑定、共享用量标识、未知与零费用区分、追加账单核对、SQLite 变更拒绝及摘要损坏检测。没有模型、网络、Telegram 或交易调用。
