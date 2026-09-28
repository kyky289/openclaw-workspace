# 五项媒体能力接入层

实现图片、音频、视频读取与图片、视频发送的宿主接口、持久状态和 OpenClaw 原生命令适配器。默认全部关闭；本轮只测试合成文件和模拟回执，未发送 Telegram 消息、未调用媒体模型。不是已安装到网关的插件。

## 原生复用与真实启用条件

复用当前 OpenClaw 的 `infer image describe`、`infer audio transcribe`、`infer video describe`、`message send --media`。不另装插件、不配置凭据，也不把 tools.profile 扩成 full。真实启用时由原 openclaw 用户调用；代码不自动提权或切换身份。

本机 2026.9.4 的 image/video 回执有 provider/model 但没有费用；audio 回执不含实际 provider/model 和费用。因此 native backend 缺少可信 `analyzeReceipt` 时拒绝开始读取。该适配器必须依据服务回执/计费证据返回 `{provider,model,costUnits,output}`，不能把 requestedModel 回填成实际型号，不能把未知费用写成 0。Claude 订阅不能假定覆盖其他供应商调用。

发图和发视频仅接受可信宿主明确列入白名单的私聊数字 ID，另外逐次调用可信 authorize；当前没有填写用户私聊 ID、没有开启发送。发送已有文件不代表 AI 生成媒体。

## API

```js
import { createMediaGateway, defaultMediaPolicy } from '../src/media.mjs';
const gateway = createMediaGateway({
  directory: '/absolute/new-private-state', agentId: 'main', environment: 'test',
  sourceRoots: ['/absolute/approved-inbox'], policy: defaultMediaPolicy(),
});
const media = gateway.ingest({path:'/absolute/approved-inbox/chart.png',kind:'image'});
// 启用前必须由可信宿主注入 ledger、backend、authorize。
// analyze({mediaId:media.id,question:'...',idempotencyKey:'task-a'}, trustedContext)
// send({mediaId:media.id,recipientId:'...',caption:'...',idempotencyKey:'delivery-a'}, trustedContext)
gateway.close();
```

`authorize({action,request,scope}, trustedContext)` 同步返回可信 `{actorId}`，默认拒绝。不能把模型传入的 approved 或 actorId 直接当作身份。宿主负责真实认证、任务与收件人授权；这些库接口不能直接暴露公网。

策略含 read.image/audio/video 的 enabled、modelRef、estimatedUnits，send.image/video、recipientIds、maxBytes、timeoutMs、budgetUnit。它们只能来自可信宿主。费用单位与账本一致，账户在首次读取时持久绑定。agent/environment 分区不能代替 OS/API 权限。

## 文件与理解边界

- 仅收指定根目录内的本地普通文件，不抓取 URL；拒绝路径穿越、符号链接、超限大小和签名不符。根目录必须由宿主管理，不应包含整个 workspace 或凭据目录。
- 支持 PNG/JPEG/WebP、WAV/MP3/Opus OGG、部分 MP4 品牌。签名检查不是完整解码验证，模型仍可能拒绝损坏或不支持的文件。
- 图片/音频/视频上限分别为 10/20/50 MiB，可调低。固定大小读取原件，保存 SHA-256 和字节到私有 SQLite；修改原文件不会改变已收录快照。
- 库文件 0600、目录 0700；CLI 临时文件使用私有目录与 0600，正常结束只清理自身临时文件。错误不回显原始 stdout/stderr、路径或凭据。
- 读取结果标记 `verification:'pending'`。OCR/转录/描述中的数字和投资说法须核验；输出永远不能自行取得执行、知识晋升或交易权限。提示词不等于提示注入防护保证。
- 尚无时长/帧数预检、时间码抽取、全视频覆盖、图表数值/中文转写准确率的真实验收；PDF/Word/Excel 和 TTS 继续保留在清单。

## 费用、故障与重试

读取在调用前持久占用幂等键、预留费用、记录 started。费用未知或超时保留预留并冻结账户；实际费用已知时，即使模型不匹配也照实记账；超预留则复核。账本只约束经过它的调用，不是供应商硬性账单上限。

同键必须对应同一材料、问题/收件人、说明和可信身份。已完成返回存储结果；中断、超时、未知送达时返回 needs-review，不自动再次调用/发送。不能通过更换新键绕过复核。发消息核对 channel、目标和 messageId，拒绝 dry-run、失败、部分失败和错目标回执。

预算与媒体库不是跨库同一事务；强制终止可能留下未结预留和待复核任务，必须保留到可信核对。尚无人工作业界面、自动清理、SIGKILL 临时遗留回收或长期媒体留存政策；部署前需补齐。合成测试通过不能标注五项能力已经生产上线。
