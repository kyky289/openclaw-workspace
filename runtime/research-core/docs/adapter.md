# 请求边界适配接口（未接入网关）

`src/adapter.mjs` 提供两个纯函数，把路由判定转换成可供接入代码使用的模型覆盖项，并验证解析后的型号没有变化。不注册 OpenClaw 插件或钩子，不安装依赖，不调用任何模型、服务或交易工具。

## 准备下一次请求

```js
import { prepareTurn, validateResolvedModel } from '../src/adapter.mjs';

const prepared = prepareTurn(trustedTaskInput, approvedPolicy);
// ready 时：
// prepared.modelOverride = {
//   providerOverride: 'anthropic',
//   modelOverride: '已验证且已批准的具体型号'
// };
// 其他情况下 prepared.modelOverride 和 verificationContext 均为 null。
```

返回值包含原始 `route`、覆盖字段对象 `modelOverride`、本次验证上下文 `verificationContext`，以及始终为 false 的 `executionAuthorized`。只有路由状态为 `ready`、不是演练、无需进一步审查时才给出覆盖项。候选模型默认仍未批准、未验证可用；成本未知或预算不足时不生成覆盖项。

`modelOverride` 对象内部使用 `providerOverride`、`modelOverride` 两个字段，便于后续映射到模型解析钩子的返回值。外层整个 `prepared` 对象不能直接当作钩子返回值；应由适配代码提取内部覆盖项。现阶段没有已注册或启用的钩子。

## 验证解析后的模型

```js
const verification = validateResolvedModel(
  { provider: actualResolvedProvider, model: actualResolvedModel },
  prepared.verificationContext,
);
// verification.valid 为 false 时，不继续发出该请求。
```

`receipt` 只能包含 `provider` 和 `model`；从实际 SDK 的解析结果中明确提取这两项。上下文由 `prepareTurn` 产生，包含预期提供商、型号、政策版本与角色。比较是精确匹配，不接受静默回退、`latest` 别名或换提供商。返回值只含有效性、固定理由代码及 `executionAuthorized: false`，不复制任意输入或提示文本。

上下文不是签名或权限凭据：调用方必须在可信进程内部保留它，并关联到相同任务和请求，不能接受客户端、文档或模型声称的上下文或解析结果。验证 SDK 的请求配置也不证明服务端实际上使用了哪个模型；若提供商返回真实模型信息，应在接收结果时再次核验，不匹配时阻止后续自动动作并报告。

## 上线前尚需完成

1. 根据已安装 OpenClaw 版本确认模型解析钩子、运行钩子的实际返回格式、权限及注册方式。
2. 使用可信任务分类器建立风险、影响和复杂度；不让用户材料自行降低元数据风险等级。
3. 核实 Claude CLI / API 的实际账号、型号映射、能力、计费方式及用户费用授权，完成真实质量评测。
4. 在请求前原子预留预算，在请求结束后记账或释放预留；按任务持久化升级和重试计数。并发请求不能重复消费同一剩余额度。
5. 将验证上下文绑定到一次请求，处理任务取消、过期、SDK 自动回退和恢复流程。
6. 保持独立的工具授权和投资风控；`ready` 和 `valid` 都不授予执行、下单或提高资金限额的权限。

本版有意不提供自动调用包装器：在预算账本和真实接入未实现前，仅返回纯判定，避免产生看似可执行却缺少预算原子性的接口。

离线验证：`node test/adapter.test.mjs`。测试只使用虚构 `fixture/*` 型号，没有网络请求或生产模型批准。
