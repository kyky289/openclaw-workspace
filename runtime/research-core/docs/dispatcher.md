# 持久模型请求调度器

`createModelDispatcher` 将路由、账户预算和可信宿主提供的异步模型调用函数连接起来。本模块没有默认模型客户端、登录逻辑、凭据、网络地址或网关插件；测试只注入虚构回调，没有调用真实模型。

```js
const dispatcher = createModelDispatcher({
  directory: '/absolute/private/development-data',
  agentId: 'main', environment: 'test',
  ledger, policy, invoke: trustedHostInvoke,
  timeoutMs: 30_000, // 可省略；整数 1–120000 毫秒
});

const result = await dispatcher.dispatch({
  taskId: 'research-001', idempotencyKey: 'research-001-attempt-1',
  request: {
    metadata: { risk: 'high', impact: 'financial', complexity: 'high' },
    prompt: 'Synthetic fixture only.',
    dryRun: false,
  },
});
```

不设置 `dryRun: false` 时沿用路由的演练模式，不预留费用或调用模型。调用方不能传 `request.budget`；预算来自宿主账本的 `summary().availableUnits`。账户的 environment 必须与调度器一致，政策单位必须与账本单位一致，已知预计费用必须为非负安全整数。账户冻结或路由不满足批准/可用性/能力/费用条件时不调用。

`policy` 在创建调度器时复制并固定。每个准备执行的请求先保存请求摘要、选定型号、政策快照和预留键，再预留账户额度、持久化开始，最后调用宿主函数。提示文本不保存在意图表中，仅用于计算摘要和发送给已注入的回调。

## 宿主回调

```js
async function trustedHostInvoke({
  taskId, request, modelOverride, verificationContext, signal,
}) {
  // 宿主自行实现已批准的 SDK 接入和账单单位换算。
  // modelOverride 为 {providerOverride, modelOverride}。
  // signal 请求取消，但取消不等于供应商一定没有计费。
  return { provider: 'provider', model: 'exact-approved-model',
    costUnits: 123, output: 'Bounded response text' };
}
```

回执必须恰有 `provider`、`model`、`costUnits`、`output`。提供商和具体型号必须与原选择精确一致；文本最多 64 KiB。出现静默回退、额外字段、缺失字段或过大输出时不接受结果。费用是已确认的整数账单单位，不能把估算、未知或缺失费用换成零。

已知费用即使对应错误型号或无效输出也会入账；实际费用超过预留时记录真实费用、冻结账户，并返回需要复核。异常、超时或未知费用会保留原预留并将账户标记为费用未知，阻止进一步消费。底层若不响应 signal，远端仍可能继续执行和计费；本模块不会在后台自动重试，也不会把超时当作未发送。

`invoke` 是可信代码，不是安全沙箱。宿主必须禁止其私自回退、内部自动重试、调用未批准模型或使用未批准工具；如一次宿主调用会产生多笔请求，必须由单独评审的计费适配器逐笔覆盖预算。路由的风险/复杂度元数据同样由可信任务分类器提供，不能直接由附件或模型自己填写来降低等级。

## 返回与重放

主要状态为 `completed`、`blocked`、`proposed`、`needs-review`。执行结果包含任务、预留、具体模型、政策版本、固定原因代码和 `replayed`，成功时另有 output、costUnits。任何结果的 `executionAuthorized` 均为 false：模型文本不授予下单、转账、放宽风控或发布权限。

同一代理/环境中的幂等键绑定到完全相同的 taskId 和请求摘要。再次提交相同已完成请求返回私有缓存，并标记 `replayed: true`，不重新调用或计费；同键不同请求失败。失败结果也持久化，不能靠重复原请求自动重试。需要新的收费尝试时，必须由宿主按批准范围建立新的尝试并使用新键。

已经持久化意图但尚无最终结果时，重复请求返回 `PENDING_DISPATCH_REQUIRES_RECONCILIATION`，不自动再次发送。这包括另一个进程仍在处理、进程在开始后崩溃，以及已经结算却来不及保存结果的情况。started 状态保留额度，但单凭 pending 不能区分正在工作还是已崩溃，所以不会贸然冻结一个正常的并行调用；宿主恢复流程必须核实并对确实未知的费用冻结处理。

SQLite 缓存和预算账本是两个数据库，不宣称与外部供应商实现分布式“恰好一次”事务。它们保证调度器在不确定状态下停止并保留记录，而不自动重发。若进程在预留成功、尚未把 reservationId 写回意图之间退出，可通过意图内确定的预留幂等键核对账本；不得删除意图或账本来重新获得调用资格。

当可信流程确认调用尚未开始，而且账本仍为 reserved，调度器可以用 `confirmedNotSent: true` 取消预留。已经开始或处于费用未知的记录不会自动取消。已完成结算但结果持久化失败时仍保留真实费用，返回需要复核，不重发。

缓存包括模型生成文本，位于私有存储目录；不会记录原始异常或供应商诊断。调用方仍需认证、授权、数据域隔离及输出分发控制。不要向公众暴露这些文件。账户限额是本地控制，并不是供应商端硬费用上限。

## 验证

`node test/dispatcher.test.mjs` 包含 18 项测试：实际成本入账、错型号、不明成本/异常/超时、冻结、幂等缓存、原子开始、多进程只调用一次、开始后崩溃、结算后缓存前崩溃，以及未发出预留的取消。所有回调均为本地虚构函数，没有真实模型或 Telegram 请求。
