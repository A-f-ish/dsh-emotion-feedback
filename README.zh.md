# dsh-emotion-feedback

DSH 宿主插件：**判定工作模型「自己」当前的情绪，并在下一个回合开始前把这个情绪静默回注给它。**

> 与「先感知用户情绪、再调整输出风格」的插件方向相反：这里判定并回注的是工作模型自身的状态，
> 形成 **自省 → 状态留存 → 行为调整** 的闭环。

## 闭环怎么跑

```
① 回合收尾  agent/turn-stopping
   取本回合最后一条 assistant 正文
        ↓  本地关键词优先（命中即 0 次模型调用）
        ↓  未命中且 useLlm=true → 一次轻量 llm.stream 判定（temperature 0，输出一行 JSON）
   判定结果写进「本会话的情绪状态」——不追加任何会话事件，用户看不到这次判定

② 下一回合起手  agent/pre-step（{ prepend: true }）
   把当前状态渲染成一条合成用户消息（source.kind = 'emotion-feedback'）追加进本次请求
        ↓
   工作模型带着这个情绪作答，且不必解释它的来源
```

判定过程本身对用户不可见：`turn-stopping` 阶段不追加任何会话事件，状态只存在进程内，
所以用户看不到「判定」这一步；下一回合才有一条回注消息进入请求。
回注消息的正文会提到「情绪状态」（模型需要知道自己在什么状态里），但模型被告知不要
在回答里直接谈论情绪、评估、反馈这类元层面的话。

## 情绪状态

```js
{
  emotion: '愧疚',        // 词表外的标签也会原样保留，并带 outOfList: true 标记
  intensity: 0.62,        // 0-1
  reason: '关键词「抱歉」',
  source: 'rule',         // 'rule' | 'llm'
  outOfList: true,        // 只在该标签不在 config.emotions 里时出现
  turn: 7,
  history: [{ turn: 7, emotion: '愧疚', intensity: 0.62 }, /* … */],
}
```

**标签不再被改写（2026-10-10 修正）**：旧实现把「不在词表里」的标签一律改写成「平静」，
结果是判定器说出「愤怒 0.78」「怜惜 0.62」之后，落库变成「平静 0.78」「平静 0.62」——
标签层的信息被抹掉，而且换成了语义相反的中性标签，面板上看起来像「模型永远是平静的」。
现在词表外标签只打 `outOfList: true` 标记、不做改写；词表的作用退回为
「判定提示词里优先选项」+「关键词规则的合法标签集合」。判定提示词末尾会附上当前词表
（`judgeSystemPrompt()`），所以模型自造标签的情况本身也会大幅减少。

**关键词层会跳过被否定的命中**：命中词左右小窗口里出现 `config.negations`
（默认 `不 / 没 / 无 / 非 / 避免 / 规避 / 降低 / 减少 / 最低 / 较低 / 可控`）时该命中不算数。
用于挡住「不确定」「风险最低」「风险可控」这类反向命中。想恢复旧行为就把 `negations` 设为 `[]`。

**融合而非替换**：旧强度先按回合数衰减 `turnDecay^相隔回合数`，然后
- 同一情绪 → `max(旧强度, 新强度)`（同类情绪会累积变强，不会因为再判一次而变淡）
- 切换情绪 → `max(旧强度 × takeoverRetain, 新强度)`（旧情绪残留一点，不会瞬间清零）

**闲置衰减已停用**：原先读取快照时按 `0.5^(闲置分钟 / halfLifeMinutes)` 计算强度衰减，该模块
已按需求注释掉（`lib/index.js` 的 `rehydrate()` 里保留原实现备查，`Config.halfLifeMinutes`
字段也保留但不再生效）。因此强度**不会因为一段时间不说话而变淡**，只由回合维度的融合规则
（`blend()` + `turnDecay`）决定。

## 配置

在 profile 补丁里给插件行加 `config:` 即可，全部字段都有默认值：

```yaml
- insert:
    - id: emotion-feedback
      name: 'dsh-emotion-feedback'
      config:
        minIntensity: 0.25      # 低于这个强度不回注，避免打扰
        judgeModel: ''          # 留空 = 用当前会话默认模型；可指定更便宜的判定模型
        useLlm: true            # 关键词没命中时才触发模型判定
        halfLifeMinutes: 10     # 已停用（闲置衰减模块被注释掉），字段保留但不再生效
        includeReason: false    # 回注时是否带上判定依据
        debug: false            # 打开后每回合打印判定结果
```

完整字段见 `lib/types/index.d.ts` 的 `Config`。要点：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` / `inject` | `true` | 总开关 / 是否回注（关掉回注就只判定、只留状态） |
| `disabled` | `false` | **紧急开关**：设为 `true` 立刻停用全部行为（优先级高于 `enabled`），无需卸载插件 |
| `minIntensity` | `0.2` | 回注门槛 |
| `judgeProvider` / `judgeModel` | `''` | 判定用的模型；留空依次回落到 `agent.options` → 会话请求头 → 会话默认模型 |
| `useLlm` | `true` | 是否允许模型判定层 |
| `timeoutMs` | `6000` | 单次判定超时，超时保持原状态 |
| `turnDecay` | `0.9` | 每回合衰减 |
| `halfLifeMinutes` | `10` | ~~闲置半衰期~~ **已停用**（保留字段，不再生效） |
| `takeoverRetain` | `0.35` | 情绪切换时旧强度保留比例 |
| `injectPerStep` | `false` | 同一回合内后续步骤是否也允许回注 |
| `emotions` / `rules` / `prompt` / `template` | 内置 | 词表 / 关键词规则 / 判定提示词 / 回注文案（词表默认 15 项，含愤怒 / 委屈 / 怜惜） |
| `negations` | 见上文 | 否定词表：命中词附近出现它们时该次命中跳过；设为 `[]` 可关闭保护 |
| `panelEvent` / `panelRoute` / `statusTool` | `true` | 面板事件 / 面板 HTTP 路由 / `emotion_status` 工具（见下文两节） |

## 安装

插件是一个带 `dsh.bundle` 的 bundle，装法有三种：

```powershell
# A. 从 npm 安装（社区版）
dsh plugin --profile desktop add dsh-emotion-feedback

# B. 从本地目录安装（plugin_manager 的 install_bundle 也接受绝对路径）
dsh plugin --profile desktop add "C:\path\to\dsh-emotion-feedback"
```

方式 C：把仓库路径发给 DSH 会话里的 agent，让它用 `plugin_manager` 的 `install_bundle` 安装。

安装流程会 `pnpm add` 该包 → 校验 `package.json` 的 `dsh.bundle` → 加载 `cordis.patch.yml`。

`cordis.patch.yml` 里的一行 `insert` 就是全部接线（`name` 解析到本包；`id` 必须在 profile 里唯一）。
安装完成后 profile 的两处变化：

```jsonc
// %DSH_HOME%\profiles\<profile>\package.json
"dependencies": { "dsh-emotion-feedback": "^0.1.0" },   // 本地目录安装时是 "link:C:/…"
"dsh": { "profile": { "bundles": [ /* … */, "dsh-emotion-feedback" ] } }
```

从本地目录安装时，`node_modules\dsh-emotion-feedback` 是指向源码目录的 **junction**，
所以改源码等同于改已安装的插件（下次加载时生效，无需重新安装）。

> **需要重启 DSH 才能生效。** 安装只把 bundle 补丁层并进配置图（包清单里会立刻出现
> `enabled: true`）；插件模块的加载与 `apply()` 发生在宿主启动装配插件代际时。已实测：安装后
> 当前正在运行的会话日志／投影缓存里没有任何情绪回注事件，即本代宿主尚未挂上这两个监听器。
> 重启 App 后 `agent/turn-stopping` + `agent/pre-step` 才会真正生效。

## 情绪面板（浏览器半边）

插件自带一个可视化面板，挂在输入框上方的 composer dock 槽位（`conversation.composer.dock`），
标签「情绪」。折叠时只显示一枚彩色圆点 + 当前情绪 + 强度；点开后显示：

- 强度条（颜色 = 情绪）
- 最近一次**判定**的时间、上一次的情绪（旧标签写作「最近回注」，实际读的是判定，2026-10-10 改名）
- 判定依据（`includeReason: true` 时来自回注文案；否则回落到 host 快照里的 `reason`）
- **来源**：`关键词` / `模型判定`，并标出「词表外标签」（来自 host 快照的 `source` / `outOfList`）
- host 快照可用时，额外显示本回合判定原值与融合倍率
- 强度曲线（最近 40 次判定，柱高 = 强度、颜色 = 情绪、悬停显示原始判定值）
- 最近 8 次判定列表与累计次数

### 数据从哪来（关键设计）

面板**不依赖任何额外接口**：宿主每次回注都会把那条合成消息写进会话日志
（`user/message` + `source.kind = 'emotion-feedback'` + `surfaceOp: 'append'`），
浏览器半边用槽位的标准 props `useChat((s) => s.legacy.nodes)` 读到会话节点，
再从节点里认出这些消息并解析出情绪/强度。所以曲线展示的**就是模型真实收到的每一条回注**。

为什么不能走 RPC：静态 `dsh.bundle` 包的浏览器半边在加载时只拿到一个 `require`
（`$NPX/dsh-client-modules/lib/client.js:683`），拿不到 `host.call`；`ConversationSnapshot` /
`SessionSnapshot` 里也没有独立的状态通道。唯一可行的读取面就是会话节点本身。

面板另有一条**可选**的 host 侧 HTTP 通道 `GET /emotion-feedback/state?sessionId=…`
（`Config.panelRoute`，默认开）。实测桌面端渲染进程**能**取到它——面板底部那行
「host 快照：<工作目录> · 更新 <时间>」就是它返回的数据；而用 `curl` 从宿主外部访问同一端口
会得到 404/401（那是在插件尚未挂进运行进程时测的，且该端口有浏览器鉴权），两种结果不矛盾。
取不到时面板静默降级，只用会话内数据，不影响任何功能。

### 相关配置

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `panelEvent` | `true` | 是否把每次判定写成会话事件 `emotion-feedback/state`（不参与消息投影，不进模型上下文） |
| `panelRoute` | `true` | 是否注册 host 侧只读 HTTP 路由（Web 部署用；桌面端取不到会自动降级） |

面板本身没有额外的安装步骤：`package.json` 的 `exports["./client"]` + `dsh.client`
（`platform: "web"`）就已声明完毕，宿主半边的那一行 patch 会让浏览器半边被自动组装。

## 模型侧读数：`emotion_status` 工具（只读）

面板是给「人」看的，`emotion_status` 是给**工作模型**自己看的：它调用一次就能拿到当前情绪名、
强度、判定理由、来源（`rule` / `llm`）与最近数回合的轨迹。两者读的是同一份进程内状态，
所以面板与模型的自述永远一致。

- 只读：工具不能改情绪。要改只能通过对话本身自然发生（批评 → 愧疚/自责，夸奖 → 愉悦/自信）。
- 触发时机由模型决定；绝大多数回合不需要调用，它的存在只是让「我现在到底是什么状态」可自证。
- 注册方式是 reactive 的：`ctx.inject(['tools'], …)`，宿主没有 `tools` 服务时只少一个工具，
  回注与面板照常工作；`deps.defineTool` 注入口仅用于测试。
- `@deepseek-ai/dsh-tools` 是**惰性** import —— 插件目录里解析不到它时同样只是少一个工具，
  `apply()` 全程同步，插件本体不会因为少一个可选依赖而加载失败。
- 作者态 output schema 必须遵守 value schema DSL（`$NPX/dsh-tools/lib/index.js:555-751`）：
  **不能**写 JSON Schema 的 `required: [...]` 数组，只能给每个属性写 `required: true`；
  对象节点必须显式写 `additionalProperties: true|false`。写错会在 `defineTool` 处抛
  `schema.required is not supported by the value schema DSL`（已被离线测试覆盖）。

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `statusTool` | `true` | 是否注册 `emotion_status` 工具（`disabled: true` 时一并停用） |

## 验证

1. **已装载自查**：profile 的包清单里出现 `dsh-emotion-feedback`（`enabled: true`、`installed: true`，
   行 `rowId: emotion-feedback`）即补丁层解析成功；`dsh --profile desktop --dump-config` 可看到同一行
   （本机没有独立的 `dsh` 命令，该步仅在装了 CLI 的机器上可用）。用
   `cordis_inspect_query(platform="host", provider="Config", method="listConfigs", input={entry:"include:emotion-feedback"})`
   还能看到**运行进程真正加载的那一代 schema**：字段里出现 `panelEvent` / `statusTool` 才说明宿主
   已经拿到新代码（Node ESM 按 URL 缓存模块，改盘不热更，必须重启 DSH）。
2. **离线自测**（不需要宿主）：`node test/all.mjs` 一次跑四套件 —— `run.mjs` 37 例覆盖关键词层、
   模型判定层、回注时机、强度融合、容错与多会话隔离；`crash-scenarios.mjs` 9 例用**真实 cordis +
   真实 `dsh-scope` 派发链路**验证崩溃契约（下游返回 undefined / 抛异常 / null / 字符串 / 数字 /
   布尔时都交回合法决策）；`panel-data.mjs` 45 例在 Node 沙箱里加载 `lib/client.js`，用**真实会话
   日志里的回注文案**验证面板的解析、识别与曲线聚合；`emotion-status-tool.mjs` 12 例验证
   `emotion_status` 的 schema 能被**真实 `@deepseek-ai/dsh-tools`** 编译，以及返回值类型、
   会话隔离、降级行为。
3. **功能验证（需重启后）**：连发两条消息。
   - 第一条故意让工作模型受挫或道歉，例如「上一版的接口设计有问题，你反思一下」。
   - 第二条随便提个要求（例如「再讲讲下一步」）。第二条的回答应当带上与「愧疚/自责」匹配的
     语气与节奏。
   - 取证：第二条消息所在回合的 `step/start` 之后，会话日志里会出现一条 `user/message`，
     `source.kind === 'emotion-feedback'`、正文以「你当前的内在情绪状态是」开头 —— 这就是回注。
     回注是一条 user 角色消息，因此会以「用户消息」的形态出现在转录里（判定过程本身仍然不可见）。
4. **面板验证（需重启后）**：输入框上方应出现「情绪」徽标。
   - 折叠态：彩色圆点 + 情绪词 + 强度；没有数据时显示「情绪：暂无判定」。
   - 第一条消息之后徽标应变成判定结果（判定发生在回合收尾，所以从下一回合起显示）。
   - 点开应看到强度条与曲线；连发几条不同语气的消息，曲线应逐条增长，颜色随情绪变化。
   - 面板读的是**会话里真实的回注消息**，因此「曲线最后一点 = 模型下一回合将收到的状态」。
   - 若面板一直显示「情绪：暂无判定」而日志里确实有回注，用 `node test/panel-data.mjs` 复核解析层，
     再从浏览器控制台检查 `useChat` 是否给出了节点。
5. **临时查状态**：把 `config.debug` 设为 `true` 看宿主日志的 `[emotion-feedback]` 行，或临时
   在 `apply()` 返回的 API 上接一个调试入口（`debug` 只在判定发生时打印，不写入会话）。
6. **卸载干净**：删除 profile 补丁里那一行并移除依赖；无残留监听器（`ctx.on` 与 `ctx.effect`
   注册的都是调用 fiber 的 effect，随插件卸载自动回收；面板样式标签带 `data-plugin`，
   HMR 会按 id 扫删）。

## 设计取舍

- **判定对象是「最后一轮回答」而不是每一步的工具调用**：用户的例子是「对批评做了反思 →
  被判为愧疚」，那是回合收尾时的可见态度；每一步都判会引入噪声与延迟。
- **关键词层在前**：`agent/turn-stopping` 是 **serial 且被 await** 的——回合边界要等它返回，
  所以无条件调用模型会给每个回合都加上可见延迟。命中关键词时零模型开销。
- **状态只存在进程内的 `Map`**：情绪是瞬时状态，丢失无害；而「不展示给用户」是硬要求，
  不落盘反而更安全（宿主提供的 `sessionProjections` / `storageDomain` 都需要 zod 记录 schema，
  且会把状态写进会话持久层）。
- **判定调用不传 `purpose`**：`purpose` 是封闭的 `'compaction' | 'session-title'` 二值联合，
  第三方插件无法声明自己的用途，改用消息的 `source.kind` 标识。
- **防自判**：判定调用同样会经过 `llm/stream` 这个 waterfall，插件不监听它；提示词里带
  `PROTOCOL: EMOTION_TONE_JUDGE v1` 协议头，便于在日志里识别自己的调用。

## 崩溃契约（硬性保证）

`agent/pre-step` 是 waterfall，宿主在 `@deepseek-ai/dsh-agent-loop` 里紧接着读 `decision.kind`：

```js
// $NPX/dsh-agent-loop/lib/index.js:920
if (decision.kind === "reject") return decision;   // decision === undefined ⇒ TypeError "reading 'kind'"
```

也就是说任何一个 `agent/pre-step` 监听器只要把 `undefined` 交回调用方，整个回合会在第一步就失败
（`turn/end` 里只有 `{"message":"Cannot read properties of undefined (reading 'kind')","code":"UNKNOWN"}`，
没有 `step/start`，且 `errorChain` 会丢掉调用栈）。因此本插件的监听器遵守三条不可违反的契约：

1. `await next()` 一律包在 `try/catch` 里；下游抛错时记日志并交回**自己构造的合法 `{ kind: 'enter', messages }`**。
2. 下游返回值一律过 `safeDecision()`：不是非 null 对象就换成合法 `enter` 决策，并记一条取证日志。
3. 自己的注入逻辑同样包在 `try/catch` 里，失败时返回**下游原决策**而不是 undefined。

另外 `enabledNow()`（`config.disabled !== true && config.enabled !== false`）在两条监听器入口都会被检查：
把配置改成 `disabled: true` 即可让插件完全静默，无需卸载或重启。

### 浏览器半边：渲染保险丝

槽位组件由外壳以 `(0, react_jsx_runtime.jsx)(Comp, props)` 渲染
（`$NPX/dsh-client-ui-renderer/lib/client.js:772`），而且外壳自身给每个槽位条目套了
`SlotErrorBoundary`（同文件 `:611`、`:1074`）——单个插件在渲染期抛错不会带走兄弟槽位，
这是第二道防线。本插件在这之上再套一层自己的边界（`EmotionFuse`，`lib/client.js:679`）：
面板读的是三份都不由本插件控制的输入（会话节点、host 快照、时间戳），任何一份换了形状都
只允许这一小块变成「情绪面板暂不可用」，而不是把整块 composer dock 交给外壳的错误占位符。
拿不到 `React.Component` 时（精简运行时、测试替身）自动退化为不套边界，行为与加固前一致
——不会更差。
