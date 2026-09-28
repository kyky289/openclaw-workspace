# 复盘与预测结算服务

此模块把 Research Brain 中已经核验并冻结的证据，接到现有 journal 的 review / resolution 记录。它不调用模型、不修改旧决策、不晋升策略、不改 memory、skills 或 thesis，也不授予交易权限。

## 宿主创建与授权

```js
const service = createReviewService({
  directory: '/absolute/private/development-data',
  agentId: 'main', environment: 'test', research, journal,
  authorizeReview({ operation, phase, scope, request, targetRecord }, trustedContext) {
    // 必须核验真实宿主身份及其针对本次动作的批准，不能相信 request 中的身份声明。
    if (!hostHasAuthorizedThisAction(trustedContext, operation, request)) return null;
    // preflight 时 targetRecord 为 null，尚未查询目标记录。
    if (phase === 'target' && !hostMayAccessTarget(trustedContext, operation, targetRecord)) return null;
    return {
      actorId: 'authenticated-operator',
      canReview: operation === 'review',
      canResolve: operation === 'resolve',
      canRead: operation === 'read',
      earlyResolutionConfirmed: phase === 'target'
        && hostConfirmedOriginalCriterionAlreadyResolved(targetRecord, request),
    };
  },
});
```

`authorizeReview` 默认拒绝，必须是同步的可信函数。它收到动作、phase、固定 scope、请求副本和目标记录副本。review/resolve 先以 `phase: 'preflight'`、`targetRecord: null` 核验身份及动作权限，通过后才读取目标，再以 `phase: 'target'` 和确切记录执行对象级授权。两个阶段必须分别允许相应动作，并返回同一 actorId。默认拒绝或未授权调用对于存在、不存在的目标均返回 `UNAUTHORIZED`，不会查询 journal 目标。回调应在 preflight 核验请求中目标引用的访问范围，不能依赖尚未读取的目标内容来确定是否允许初次读取。

返回有效 actorId 还不够：review 需要 `canReview: true`，resolve 需要 `canResolve: true`，getReceipt 需要 `canRead: true`。getReceipt 只执行 preflight，授权通过后才读取收据。提前结算只使用 target 阶段的显式确认。异步授权函数或 Promise 结果不被接受。

scope 由宿主固定，research 和 journal 都必须属于同一 agentId/environment，并使用同一个 directory 下的研究存储。模型、附件和聊天参数不能选择别人的 scope，也不能自己传 actorId、model、strategy、审核状态或 earlyResolutionConfirmed。不要将本服务的修改方法直接暴露为模型工具。同一操作系统账户能访问自身文件，这不是对同 UID shell 的强隔离机制。

## 新增复盘

```js
const receipt = service.review({
  target: { id: 'existing-decision-id', version: 1 },
  evidenceTaskId: 'frozen-follow-up-task',
  title: '为何这次没有交易',
  result: '原先缺失的证据尚未出现，继续等待符合原决策条件。',
  lessons: ['把不行动的条件也记录在决策前。'],
  idempotencyKey: 'review-unique-attempt',
}, trustedContext);
```

目标必须是本 scope 下真实存在的 prediction 或 decision 的确切版本。历史版本可以复盘，即使原记录已有后续版本；本次复盘会明确引用旧版本，不覆盖原判断。复盘本身不能成为新的复盘目标。

证据 task 必须是冻结快照；其中每一条证据在冻结时都已经 verified，并且首次提交时仍是相同的最新 verified 版本。之后才核验的 pending 快照不会自动升级，已经撤回或重新核验的旧快照也不能继续用于首次提交；需要重新冻结任务。

model、strategy 取自此次后续研究任务，而不是原决策或调用方手填值。证据引用保留 Research task、证据 ID、快照 SHA-256 和本次操作标记，可以查回确切来源与事实/推断分类。lessons 是记录内容，不会自动改策略。

## 预测结算

```js
service.resolve({
  target: { id: 'prediction-id', version: 2 },
  evidenceTaskId: 'verified-outcome-task',
  criterionResult: 1, // 数字 0 或 1，不能传布尔值
  resolvedAt: '2026-09-28T12:00:00Z',
  reason: '依据原先保存的结果判定标准，可信操作者确认事件已发生。',
  idempotencyKey: 'resolution-unique-attempt',
}, trustedContext);
```

resolve 只接受 prediction 的**当前版本**，journal 在原子写入时再次检查版本。不能通过本接口改概率、截止时间或原判定标准。resolvedAt 必须处于该版本创建时间和当前时间之间。

如果 resolvedAt 早于原 dueAt，授权回调必须显式返回 `earlyResolutionConfirmed: true`，表示可信身份已核实原标准允许提前确定结果。比如“截至某日之前是否发生”可以在确已发生后提前判为真；尚未发生通常不能在截止日前提前判为假。模块不解析自然语言标准、判断真实世界结果或替操作者批准结算。

resolve 创建 journal 的独立 resolution，不覆盖预测。原有 Brier 统计仍按初始记录概率计算；一次结算、样本达到某个阈值或一次盈利均不自动晋升模型/策略，也不等于投资净收益已经改善。

## 收据、幂等与跨库恢复

成功返回 `status: 'committed'`、operation、actorId、target、evidenceTaskId、taskSnapshotSha256、model、strategy、recordedAt、journalRecord，以及始终为 false 的 strategyPromotionAuthorized / executionAuthorized。提前结算确认也保存为历史审计字段。

```js
service.getReceipt({ idempotencyKey: 'review-unique-attempt' }, trustedContext);
// null、status:'reserved' 的待恢复记录，或 status:'committed' 的收据。
service.close();
```

每次查询也重新校验读取权限。调用方必须保存原始请求及幂等键：同键同内容同 actor 返回原结果；同键改变内容、动作或 actor 会冲突。字段顺序不影响摘要。不能靠重试把历史作者改成另一个人。

执行顺序为：保存不可变预留 → 核验当前证据资格 → 写 journal → 保存不可变收据。Review ID 和 journal 写入幂等键由 scope 与原始键确定。由于现有 journal 自行生成 resolution ID，恢复时按唯一预测目标查找 resolution，并核验完整内容和操作专属证据标记；别人的结算不能冒充本次操作。

如果 journal 已提交，但保存收据前进程失败，重复原请求会认领同一条 journal 记录，不重复创建。已提交之后证据被撤回，不会抹掉历史或阻止正确收据恢复。恢复保留原 actor 和原提前结算确认；当前调用仍需相应动作权限。若 journal 尚未提交，则重试仍须重新核验当前证据、预测版本以及提前结算授权，撤回后不得首次写入。

为避免“核验刚通过，另一进程立即撤回证据”的竞争，本服务在最后资格检查到 journal 提交之间持有现有 research SQLite 的写锁。仅使用现有版本 1 研究存储，不更改其 schema。Review 写库、research 锁和 journal 不是一个跨数据库原子事务，因此使用上述预留与确定性标记恢复；不宣称具备分布式事务。

私有存储中的预留/收据采用追加写入和摘要校验。发现目标、快照、收据或 journal 内容冲突时停止，不覆盖原数据。大量 resolution 的恢复目前采用分页扫描，适合个人研究记录；规模增加时需另行增加已审查索引/API。

## 离线验证

运行 `node test/review.test.mjs`。18 项测试覆盖默认拒绝、存在性探测防护、两阶段授权与作者一致性、伪造权限/模型字段、精确历史目标、scope 隔离、pending/撤回/重新核验、当前预测版本、提前结算、幂等作者、提交前失败、提交后故障及证据撤回后的恢复。测试仅使用临时 SQLite 和合成材料，没有真实模型、市场数据或交易操作。
