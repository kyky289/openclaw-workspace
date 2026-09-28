# OpenClaw 研究与投资助手：源码审阅版

这是 2026-09-28 开发成果的可分享版本。目标是形成研究→决策→独立风控→执行→结果记录→复盘的系统。目前研究候选入口和执行记录已经具备实现，其余模块的完成程度见下表。

最终产品计划在整套系统开发完成后先集中进行模拟盘验收，通过且获得用户授权后，日常在预授权范围内直接实盘运行。每笔交易不需要再经过模拟盘；本仓库现在尚未实现完整实盘能力。

## 朋友从哪里开始

推荐 Linux 或 WSL，普通用户，Node.js 24 或更高版本（含 npm）。测试使用 Node 内置 SQLite、POSIX 文件权限和子进程；受限沙箱或原生 Windows 不是本次验证环境。

从仓库根目录进入：

```sh
cd runtime
node --version
npm test
npm run check
npm run demo:runtime
npm run demo
npm run eval:offline
```

这条离线路径没有第三方 npm 依赖，不必先 `npm install`，也不需要 OpenClaw、Claude、Telegram、行情或券商账户。测试和 demo 只使用合成输入及自己的临时数据；不会启动网关、发消息、调用模型或下单。Node 可能提示 SQLite experimental warning，应结合最终退出码和测试结果判断。

`demo:runtime` 演示：提交来源→保存候选→未核验时拒绝发布→合成维护身份核验→发布记录→保存独立结果证据→结算和复盘。输出中的 `externalModelCalls`、`telegramMessages`、`brokerOrders` 应为 0。其中维护身份只处理 fixture 来源，不是开放真实核验或交易权限的接口。

额外的 Python 评测器离线测试：

```sh
npm run test:models-offline
```

需要 Python 3。`ops/evaluate-models.py --run` 是另一条会调用真实模型的显式入口，不属于以上离线测试；使用者需自行配置账号并批准费用。不要为普通源码审阅运行它。

评测器保留了原部署的 Claude 可执行路径，以及以 root 启动时切换到 `openclaw` 用户的假设。真实使用需自行适配 `--claude` 路径和执行用户；源码审阅使用普通用户和上述离线测试即可。

## 结构与实际边界

| 目录或模块 | 用途 | 当前边界 |
| --- | --- | --- |
| `research-core/src/research.mjs`、`workflow.mjs` | 证据、候选、核验状态、版本冻结、发布恢复 | 实际来源是否可信仍需可信核验；候选不自动成为事实。 |
| `journal.mjs`、`review.mjs` | 事前预测/决策、结果结算、追加复盘、查询导出 | 尚未连接实际券商成交与完整投资业务。 |
| `router.mjs`、`adapter.mjs`、`budget.mjs`、`dispatcher.mjs` | 三档选择、预算预留/结算、未知费用、调用幂等 | 候选模型标签不是可用性证明；无默认真实模型客户端。 |
| `monitor-queue.mjs` | 持久任务、判重、租约、重试恢复 | 尚无完整市场扫描/自主学习 worker。 |
| `execution-*.mjs` | 模型执行绑定、版本化凭证、查询 | 本机观察并非提供商签名；未知费用保留 unknown。 |
| `media.mjs`、`openclaw-media-backend.mjs` | 图片/视频/语音读取和图片/视频发送接口 | 默认关闭；真实渠道质量和送达仍需另行验收。 |
| `performance.mjs` | 净收益、胜率、盈亏比、回撤、基准及验收条件 | 输入需独立核实；合成数据通过不证明策略有效。 |
| `openclaw-research-bridge/` | 四项 scoped test 研究工具、原生日志执行记录采集 | 需兼容的 OpenClaw 安装和真实可信身份；不提供交易操作。 |
| `telegram-active-window/` | 群消息活跃窗口与精确匹配修复候选 | 分享版身份均为合成夹具；门控不是账户权限或投资风控。 |
| `ops/` | 离线测试、bundle 构建、通用配置提案和技能审计 | 没有个人服务器部署、回填、重启或固定身份脚本。 |

原仓库的 `stable-skills/` 保留 Research Brain 与 thesis-monitoring 规则。Research Brain V1–V3 分别对应研究纪律、thesis 连续性和监控能力，不能理解成已经运行三个独立投资代理。这里新增的程序接口尚未替代所有旧技能流程。

仍缺少：真实行情与交易日历、专业投资策略、独立资金风控、订单状态机/幂等/持仓对账、模拟账户接入与整体验收、实盘执行、完整知识治理/Belief/Theory/自主学习及 App。现有群研究范围隔离也不等于整个 workspace、memory 和 shell 的隔离。

## 可选的集成检查

研究插件 bundle 可重建，不安装也不启动插件：

```sh
npm run build:bridge
```

默认 `npm test` 有意选择不依赖本机 OpenClaw 的测试。以下测试保留供集成审查，不混入默认离线验收：

- `openclaw-research-bridge/test/bundled-entry.test.mjs` 和 `native-manifest-contract.test.mjs` 需要 `OPENCLAW_RUNTIME_ROOT` 指向兼容的 OpenClaw 2026.9.4 安装，用真实 SDK 做合成检查。
- `openclaw-research-bridge/test/installed-runtime.test.mjs` 是原始未补丁运行时的历史源码审计，部分断言特意检查旧缺口；在修复版上失败不意味着应该撤销修复。
- `src/runtime-patch.mjs` 保留兼容修复逻辑供审阅；不能不核对版本就自动修改自己的安装。分享版没有自动部署脚本。

Telegram 门控源码为 TypeScript，仓库包含与分享版源码配套的 `dist/`，默认离线测试使用该构建。若要改 TypeScript 并重建，可在自己的开发环境按锁文件安装依赖后运行 `npm run test:telegram`。其开发依赖和实际网关存在版本兼容审查要求，离线门控测试不代表网关接入已经验收。

不要把仓库根目录的 `config/openclaw.example.json` 直接覆盖自己的重要配置。它是含身份/路径/凭据占位符的示例，并非这批 runtime 功能的自动安装器。真实接入时需要自行配置身份、模型、权限和数据目录，保留已有配置并逐项验证。

## 建议朋友重点审查

1. 研究事实、推断、未知是否分开；来源核验和正式采纳是否可能被绕过。
2. 幂等、并发、重启、超时、未知结果和数据库部分提交后的恢复是否合理。
3. 私聊/群权限与实际数据域是否一致；本地同 UID 权限边界有哪些限制。
4. 模型路由、预算、执行凭证和消息级用量是否可能错归因或重复累计。
5. 如何用现有接口接入行情、独立风控、订单与账户对账，并实现可验证的投资复盘。

反馈请注明模块/文件、复现步骤、预期与实际结果、修改建议；无需提供账号、密钥或真实聊天记录。可以在 GitHub 的分支比较、Issue 或后续 PR 中讨论。

## 分享范围

本批新增代码不带个人记忆、运行数据库、私有配置/报告、原生日志、密钥、备份或 node_modules。消息门控中的原个人标识已在分享副本替换为合成值；研究核心与桥接业务代码保留实现。仅分享副本的入口、说明和占位数据作可移植整理，生产服务不随此次源码分享改变。

仓库中既有 thesis 历史按原样保留。`.gitignore` 只阻止新的误提交，不能删除已经发布的 Git 历史。
