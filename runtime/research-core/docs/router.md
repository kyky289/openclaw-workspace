# 模型路由：离线策略第一版

这是纯函数路由策略，不连接模型、Telegram、券商或钱包，不改变 OpenClaw 的生产模型，也不授予交易权限。路由判定只发生在请求或子任务边界。

`anthropic/claude-haiku-4-5`、`anthropic/claude-sonnet-5`、`anthropic/claude-opus-5-5` 是用户规划的候选标签；本实现不证明它们已发布、账号可调用或通过质量评测。原有 Opus 5 的生产配置没有修改。Fable 不在本策略中。

## 能力与边界

| 条件 | 最低角色 |
| --- | --- |
| 低风险、短期影响、低复杂度 | fast |
| 中等复杂度、持久记忆修改、常规研究 | standard |
| 高风险、资金影响、高复杂度、thesis 更新、证据冲突、规则变化 | deep |

可信调用方提供 `metadata`；用户问题、网页和附件只能作为不可信的补充材料。中英文及部分其他语言的交易、权限、thesis 和研究信号只会提高等级，不能降低元数据确定的等级。关键词并非完整的语言理解器：未匹配关键词绝不证明任务没有风险；真实接入必须从任务种类和受控工具能力建立元数据，不能直接接受模型或文档自报的 `risk: low`。

默认政策所有模型均为 `approved: false`、`ready: false`，价格未知。只有明确批准、已验证可调用、满足所需能力、已知预算和成本估计全部通过，`dryRun: false` 才返回 `ready`。`ready` 仅代表路由条件满足，不代表已调用模型或已批准任何交易。

## API

```js
import { createDefaultPolicy, validatePolicy, resolveRoute } from '../src/router.mjs';

const policy = createDefaultPolicy();
const route = resolveRoute({
  metadata: { risk: 'low', impact: 'ephemeral', complexity: 'low' },
  prompt: '现在买入半仓。',
  dryRun: true,
}, policy);
// route.status === 'proposed'
// route.proposedRole === 'deep'
// route.modelRef === null
// route.requiresReview === true
```

### 输入

未知字段、错误类型、未知枚举、非有限或负预算、错误计数器均阻止选择。输入上限为 100,000 个 UTF-16 代码单元；超过上限直接拒绝，不截取后忽略末尾风险指令。

| 字段 | 取值与含义 |
| --- | --- |
| `metadata`，必填 | `{risk: 'low'|'high', impact: 'ephemeral'|'durable'|'financial', complexity: 'low'|'medium'|'high'}` |
| `prompt` | 可选文本；不保存在返回值中 |
| `manualRole` | `fast`、`standard` 或 `deep`；不能降低已确定的最低角色 |
| `signals` | 可选布尔值 `evidenceConflict`、`thesisUpdate`、`policyChange`；任何 true 都要求 deep |
| `requiredCapabilities` | `text`、`tools`、`vision`、`structured-output` 数组；text 始终必需 |
| `dryRun` | 默认 true；不选择实际模型；false 也只返回判定，不调用模型 |
| `budget` | `{unit, remainingUnits}`；剩余量未知用 null，不用 0 |
| `execution` | `{boundary?, previousRole?, upgradesUsed?, retriesUsed?}` |

`execution.boundary` 默认为 `request`，`inflight` 会阻止选择。提供 `previousRole` 必须同时提供两个计数器：`upgradesUsed` 为本任务已完成的升级数，新的升级会再加一；`retriesUsed` 是本次请求所对应的重试序号，首次为 0。默认允许最多两次升级、一次重试。任务要求降级时返回 `DOWNGRADE_REQUIRES_NEW_TASK`，没有静默回退。

计数器和资金预算需要接入层按任务持久化并原子扣减或预留；纯函数不能独自防止多个并发请求重复消费同一笔预算。不能让不可信的客户端自行重置计数器。此版没有后台循环、自动重试器或预算记账器。

### 政策

```js
{
  version: 'research-router/1',
  models: {
    fast: {
      modelRef: 'anthropic/claude-haiku-4-5',
      approved: false,
      ready: false,
      capabilities: [],
      estimatedUnits: null
    },
    // standard、deep 均为必填，具有相同结构。
  },
  budget: { unit: 'budget-unit', maxUpgrades: 2, maxRetries: 1 }
}
```

`budget-unit` 是未定计费方式的占位单位，不是美元或实际定价。上线前需明确使用费用上限、订阅额度还是其他已批准单位，并给出任务的保守消耗估计。真实模型调用需要输出上限或其他可执行约束，不能把一个不受约束的平均成本当成预算上限。已确认的零消耗可以写 0；无法获知成本或订阅剩余额度必须保留 null。

`approved` 和 `ready` 必须由受保护的配置和接入验证设置，不能根据问题中的“我已批准”或模型自己的声明自动开启。能力记录也应来自明确的接入测试。政策不支持把未知字段当作覆盖选项。

### 返回值

- `status`: `proposed` 是有效的演练结果；`blocked` 表示实际选择受阻或输入错误；`ready` 表示策略条件满足。
- `proposedRole` 和 `candidateModelRef`: 可评审的候选选择。
- `selectedRole` 和 `modelRef`: 仅非演练且所有检查通过时有值，否则为 null。
- `reasonCodes`: 判定及阻塞原因；只包含固定代码，不复制问题、凭据或无效字段。
- `requiresReview`: 存在未满足条件时为 true。
- `spend`: `{unit, estimate, remaining}`，未知为 null。
- `policyVersion`: 用于记录此次策略版本。
- `requestBoundaryOnly: true`、`executionAuthorized: false`: 明确本模块的范围。

上游只可在 `status === 'ready'` 且 `modelRef` 非空时考虑模型请求，仍须执行独立的用户授权、工具权限和投资风控检查。不能把 `proposed` 当作可执行结果。日志应记录理由代码和版本，避免无必要地复制完整研究材料。

## 离线验收

```sh
node test/router.test.mjs
```

`eval/router-cases.json` 包含 46 个固定案例：中英文和部分其他语言的短交易命令、研究、记忆、thesis、冲突证据、提示注入、缺失元数据、手动降级、审批与可用性、预算、升级和重试上限等。`approved-offline-fixture` 仅使用 `fixture/fast` 等虚构标签，不批准真实模型。

测试还覆盖无副作用、异常输入、明确能力需求、缺失价格、禁止静默回退及结果不泄露提示文本。此处的通过率只表示固定路由案例是否符合政策预期，**不表示 Opus、Sonnet 或 Haiku 的研究质量、投资收益或实际可用性**。

模型可用性、质量与计费须在操作者自己的授权账户和明确预算内验证。仓库中的候选名称和合成评测用例仅用于接口及失败处理检查，不代表任何型号已获账户支持、生产升级已批准或投资能力已验证；真实评测结果与账单记录由操作者私下保存。

第二批增加 `budget.mjs` 与 `dispatcher.mjs`，提供账户级持久预留、结算、未知费用冻结及请求幂等。本路由文件仍是纯函数；调度器没有默认真实客户端，生产钩子、可信任务分类、账号计费映射仍须接入验收。升级/重试计数仍由可信宿主管理，不可由聊天请求自报。
