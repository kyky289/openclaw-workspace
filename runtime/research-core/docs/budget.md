# 持久账户预算账本

`createBudgetLedger` 使用 Node 24 的 SQLite 和项目内 `private-store.mjs`。没有模型客户端、凭据读取、定时任务、网关注册或交易操作。

## 范围和单位

```js
const ledger = createBudgetLedger({
  directory: '/absolute/private/development-data',
  accountId: 'approved-host-account',
  environment: 'test', // 默认 test；另可显式选择 paper 或 live
  unit: 'usd-micro',   // 默认微美元；1 美元 = 1,000,000 微美元
  limitUnits: 1_000_000,
});
```

账户由可信宿主选择，不能来自聊天内容、模型参数或附件。所有使用同一账户的代理必须共享同一个目录、accountId 和 environment；文件位于 `<directory>/billing-<accountId>/<environment>/budget.sqlite`。`accountId` 最长 72 个字符，保证 `billing-` 前缀后仍符合存储限制。每次预留另记实际 `agentId` 和 `taskId`，主代理和群聊代理共享账户总限额。

`test`、`paper`、`live` 是明确分开的记账环境，不授予任何调用或交易权限。实际发生计费的同一账户不能为了增加额度换 environment、accountId 或目录。接入方须固定映射，并把所有收费途径纳入同一账本；本模块不会发现账本之外的调用。

所有输入金额必须是非负安全整数，禁止浮点金额、NaN、Infinity 和未知值。可以显式指定其他整数单位，但同一账本的单位和限额在首次创建后固定，重新打开时不匹配会失败。没有自动重置额度、提高限额或清除超支冻结的接口。零只能表示已确认的零消耗，不能代替未知价格。

这是本地预留和停止机制，**不是供应商端的硬费用上限**。真实调用须结合价格核实、保守估计、输出限制和供应商的可用控制；供应商账单仍可能超过预留。

## 状态与 API

```js
const { reservation } = ledger.reserve({
  agentId: 'main', taskId: 'research-001',
  amountUnits: 20_000, modelRef: 'provider/approved-model',
  idempotencyKey: 'research-001-reserve',
});
const start = ledger.start({
  reservationId: reservation.id, idempotencyKey: 'research-001-start',
});
// 仅 start.dispatchAllowed === true 表示本次成功取得首次发送资格。
// 它不替代账号授权、模型批准或交易风控。
ledger.settle({
  reservationId: reservation.id, actualUnits: 17_000,
  idempotencyKey: 'research-001-settle',
});
```

- `reserve`：原子检查整个账户是否冻结及剩余额度，创建 `reserved` 记录。`modelRef` 可省略；接入真实模型的调度器应提供已验证的具体型号。
- `start`：仅允许 `reserved → started`。同一个幂等键重试返回 `dispatchAllowed: false`，不同键也不能再次启动该预留。调用方必须先持久化开始，再调用外部模型。
- `settle`：允许 `started/unknown → settled`，记录真实整数费用，释放未使用的预留。不同键不能重复结算。
- `markUnknown`：`started → unknown`，保留全部预留并冻结整个账户的新预留和新开始。即使原预留为零也冻结。
- `cancel({reservationId, confirmedNotSent: true, idempotencyKey})`：仅取消尚未开始、且可信宿主确认未发出的预留。已经开始或费用未知的请求不能取消。若确认已开始的请求实际费用为零，应经核实后通过 `settle(actualUnits: 0)` 留下结算记录。
- `get(id)`：查询当前快照或 null。
- `summary()`：账户限额、已结算费用、保留金额、`availableUnits`、冻结原因及各状态计数。
- `close()`：关闭本地连接。

所有写入返回 `{reservation, replayed, dispatchAllowed}`。只有首次成功的 `start` 返回 true；其他操作和任何重试均为 false。相同请求和幂等键返回原操作快照，不是最新状态，需要最新状态时调用 `get`。幂等键在整个账户内跨操作唯一；同键不同载荷抛出 `IDEMPOTENCY_CONFLICT`。每一次真正独立的收费尝试使用独立键，重试网络/存储操作保留原键。

可用量为 `max(0, limitUnits - spentUnits - heldUnits)`。已开始的请求始终占用预留，重启或超时不会自动释放或重发。`requiresReconciliation` 表示有开始或费用未知的记录；只有开始状态本身不会阻止仍有额度的其他请求。未知费用全部核实结算后，未知费用冻结可以解除。

任何结算费用超过该请求预留，均记录真实费用并永久留下 `reservation-overrun` 冻结标志，即使账户总限额尚未用完。超出账户限额还会显示 `account-limit-exceeded`。既有请求仍可结算、未发出的预留仍可确认取消，但不允许新增消费。修改配置文件或重复打开账本不能消除冻结。

聚合采用 BigInt 避免整数溢出。极端情况下若累计实际费用超过 JS 安全整数，汇总金额返回精确十进制字符串并显示 `accounting-overflow` 冻结；`availableUnits` 仍是安全整数且为零。单次金额本身始终必须是安全整数。

## 一致性与恢复

SQLite 的写事务串行化并发预留。所有操作使用追加事件、请求哈希及哈希链，写入前重放验证，不覆盖历史。该机制检测意外损坏，不防御有文件写权限的恶意系统管理员。账本目录和文件的权限、原子初始化、事务恢复由共享存储组件负责。损坏文件不会被当作新账户重建；不自动修复或覆盖。

进程在 `start` 后退出时，恢复后的记录仍为 started：不自动释放、不自动再次发送。宿主必须核对实际请求和费用；无法确认费用则 `markUnknown`。账本不会自动读取外部账单，也不能证明一个模型请求已经结束。

账本的账户范围不是用户认证系统。文件对同一系统账户可见；对外提供 API 时仍需要认证、权限边界及审计。此版本每次重放全部事件，适合个人助手的受控调用量；大量调用前需要检查点和负载测试，不能直接作为高频金融交易账本。

## 验证

运行 `node test/budget.test.mjs`。18 项测试覆盖跨代理额度、预留/开始/结算、幂等性、费用未知冻结、超预留真实费用、损坏保护、8 进程抢占额度、6 进程重复开始只授权一次，以及进程退出/未提交事务恢复。仅使用临时模拟数据，不调用任何模型或生产服务。
