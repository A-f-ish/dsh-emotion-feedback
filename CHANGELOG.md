# 变更记录

## 0.1.0 — 社区开源版追加

本节记录为按 **dsh-plugin 规范**公开发布所做的清单/文档改动；插件运行行为与下一条
「首个分发版本」完全相同（两个条目同属 0.1.0）。

### 清单与格式
- 增加 `dsh.manifestVersion: 1`，移除 `private`，补英文 `description` 与 `dsh-plugin` 关键词。
- 发布元数据指向 GitHub 账号 `A-f-ish`：仓库 `A-f-ish/dsh-emotion-feedback`、
  主页同地址、缺陷追踪 `/issues`、`author: "A-f-ish"`。
- 新增 `icon.svg`（≤256 KiB）、`locale/en.json`、`locale/zh.json`（`{"meta":{"title","description"}}`），
  `exports` 增加 `"./locale/*.json"`，`files` 白名单同步收录 `locale`、`icon.svg`、`docs`、`scripts`。
- `dsh.client.inject` 由 Cordis 服务名 `["connection"]` 改为客户端包名
  `["@deepseek-ai/dsh-client-ui-slots"]`：该字段是加载/预取元数据，不参与 apply 顺序，
  面板真正依赖的 `slots` 服务仍由 `lib/client.js` 的 `inject: ['slots']` 声明。
- peerDependencies 改为 `@deepseek-ai/cordis: >=4.0.4 <5.0.0` 与可选的
  `@deepseek-ai/dsh: >=0.2.0-rc.2 <0.3.0-0`；补 `publishConfig.access: public`，LICENSE 版权人改为 `A-f-ish`。
- 新增 `scripts/validate.mjs`：零依赖清单自检（`npm run check`），校验 bundle 补丁、exports 目标、
  icon 规则（相对路径 / 扩展名 / ≤256 KiB / 不越出包目录）、locale 语言文件名与字段、files 白名单。

### 文档
- `README.md` 改为英文社区版（首次公开的读者视角）；原中文文档整体保留为 `README.zh.md`。
- 新增 `docs/effect-measurement.md`：回注开/关对照实验摘要（24 会话 × 11 回合，
  判定持续性 77.2% vs 54.0%），并明确「状态层确立、显式词只是趋势、旧的 r≈0.30 结论被推翻」。
- 新增 `docs/publishing.md` 与 `docs/registry-entry.yml`：npm 发布、GitHub topic、
  awesome-dsh-plugin 注册表单文件 PR 的完整步骤与硬性要求。

## 0.1.0 — 首个分发版本

### 闭环
- `agent/turn-stopping`（serial，被 await）：取本回合**最后一条 assistant 正文**做判定；
  先走零成本的关键词层，未命中且 `useLlm` 时才调用一次轻量模型判定
  （`temperature 0`、单行 JSON、带 `PROTOCOL: EMOTION_TONE_JUDGE v1` 协议头）。
- `agent/pre-step`（`{ prepend: true }`）：把当前状态渲染成一条**合成 user 消息**
  （`source.kind = 'emotion-feedback'`）注入本次请求；同一会话同回合只注一次，
  强度低于 `minIntensity` 不注。
- 判定过程不追加任何会话事件，用户界面上看不到「判定」这一步。

### 状态模型
- 融合而非替换：`turnDecay`（默认 0.9）按相隔回合衰减旧强度；同情绪取 `max`，
  换情绪保留 `takeoverRetain`（默认 0.35）。
- 词表外标签**不再被改写成「平静」**，只标 `outOfList: true`。
- 关键词命中支持否定词保护（`negations`），挡住「不确定」「风险可控」这类反向命中。
- 闲置衰减模块已按需求停用（`rehydrate()` 中保留实现备查，`halfLifeMinutes` 字段保留不生效）。
- 每会话独立状态（`states` / `injectedTurns` / `judgingTurns` 三张 Map），`session/disposed` 时清理。

### 界面与读取面
- 浏览器面板：`conversation.composer.dock` 槽位、标签「情绪」；显示当前情绪、判定原值与融合倍率、
  依据、来源、下一回合将注入的状态、强度曲线、逐轮明细。
- 面板数据不依赖额外接口：宿主把回注消息写进会话日志，浏览器半边用槽位标准 props
  `useChat((s) => s.legacy.nodes)` 读会话节点并解析。
- 可选只读 HTTP 路由 `GET /emotion-feedback/state`（`panelRoute`，默认开）。
- 只读工具 `emotion_status`（`statusTool`，默认开）。
- 历史明细落盘 `<DSH_HOME>/emotion-feedback/history/<会话id>.json`（保留 30 天）。

### 健壮性
- **崩溃契约**：`agent/pre-step` 绝不返回非对象——`await next()` 包 try/catch，
  下游返回值一律过 `safeDecision()`，注入逻辑自身再包一层 try/catch；
  `disabled: true` 为紧急静默开关。
- 客户端渲染保险丝（class 错误边界）：面板读的三份输入（会话节点、host 快照、时间戳）
  任何一份换了形状，只让这一小块显示「情绪面板暂不可用」，不带崩会话视图。
- 所有外部数据入口按类型守卫（非数组、`null`、数字、对象混入都不会抛）。
- 测试：4 个套件约 1000 条断言，含真实 cordis 派发链路上的崩溃场景回归与面板数据层回归。

### 已知问题
- 判定**可能静默丢失**（实验中出现过 11 回合只判到 10 次），那一轮沿用上一个状态，不报错、不中断对话。
- 重启后内存状态为空，下一次判定之前无法回注（历史明细有落盘，可读回展示）。
