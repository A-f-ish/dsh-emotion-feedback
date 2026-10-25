# 安装与自检（中文 handoff 指南）

> **English:** this file is the detailed Chinese install / self-check guide. The English overview is
> [README.md](./README.md); the Chinese overview is [README.zh.md](./README.zh.md). Everything below
> applies to the community package `dsh-emotion-feedback` as published on npm.

这是 **dsh-emotion-feedback 0.1.0** 的分发说明：一个 DSH 宿主插件，判定工作模型**自己**当前的情绪，
并在下一个回合开始前把该情绪静默回注给它。功能、配置、面板细节见 `README.md`（英文）与
`README.zh.md`（中文）；这里只讲「拿到包/检出仓库之后怎么装上、怎么确认它真的在工作、怎么关掉」。

- 运行环境：DSH（桌面版或 Web 版均可），Node `^22.19.0 || >=24.0.0`。
- 依赖：`@deepseek-ai/schemastery ~3.18.4`（唯一的运行时依赖，通常 profile 里已有它）；
  宿主 cordis `>=4.0.4 <5.0.0` 由 DSH 自己提供（peerDependencies）。
- 无构建步骤：`lib/index.js`（宿主）与 `lib/client.js`（浏览器）都是源文件，装好即用。

---

## 一、解压到固定目录

`dsh plugin add` 用的是 `link:` 安装，profile 里记下的是**绝对路径**，所以解压后不要再挪动。

```
Windows      C:\Users\<你>\dsh-plugins\dsh-emotion-feedback
macOS/Linux  ~/dsh-plugins/dsh-emotion-feedback
```

确认目录里直接就是 `package.json`、`cordis.patch.yml`、`lib/`（不要多套一层同名目录）。

## 二、装进 profile（三种方式，任选其一）

### 方式 A：在 DSH 会话里让 agent 装（最省事）

把下面这句话连路径一起发给 DSH 里的 agent：

> 请用 `plugin_manager` 工具的 `install_bundle`，把这个本地插件装进当前 profile：
> `C:\Users\<你>\dsh-plugins\dsh-emotion-feedback`

安装的组合包**默认就是启用状态**。如果这一步报 `ambiguous-install`（同名包已存在于注册表时可能出现），
改用方式 B 或 C。

### 方式 B：命令行

```powershell
# <profile> 是你的 profile 名（即 %DSH_HOME%\profiles\ 下的目录名，桌面版通常是 desktop）
dsh plugin --profile <profile> add "C:\Users\<你>\dsh-plugins\dsh-emotion-feedback"
```

### 方式 C：手改 profile 清单

编辑 `%DSH_HOME%\profiles\<profile>\package.json`（macOS/Linux 是 `~/.dsh/profiles/<profile>/package.json`）：

```jsonc
{
  "dsh": { "profile": { "bundles": [ /* …原有项…, */ "dsh-emotion-feedback" ] } },
  "dependencies": {
    /* …原有依赖…, */
    "dsh-emotion-feedback": "link:C:/Users/<你>/dsh-plugins/dsh-emotion-feedback"
  }
}
```

然后在 profile 目录里执行一次包安装，让 pnpm 建好链接：

```powershell
cd $env:DSH_HOME\profiles\<profile>
pnpm install
```

---

## 三、完全重启 DSH

安装只是把 bundle 补丁层并进配置图；**插件模块的加载与 `apply()` 发生在宿主启动时**。
浏览器那一半（面板）是静态 bundle，**没有 HMR**，也必须重启才会加载。所以：**退出并重新启动 DSH**，
不要只重开一个会话。

## 四、五项自检

1. **宿主的只读路由**（Web 形态才有，桌面端渲染进程内部可达）：
   `http://127.0.0.1:<DSH 端口>/emotion-feedback/state`
   应返回 `{"generatedAt":…,"config":{…},"sessions":[…]}`；`config` 里能看到默认值
   （`inject:true`、`minIntensity:0.2`、`useLlm:true`、`persistHistory:true` …）。
2. **面板**：会话输入框上方出现「情绪」小面板（折叠态是一枚彩色圆点 + 情绪名 + 强度）。
   刚装完还没有判定，面板会显示「暂无判定」，聊一轮就有数据。
3. **聊两轮**：每轮结束后，面板的「当前情绪」应给出情绪名与强度，逐轮明细里每行都有
   **依据**（关键词文案或模型判定说明）和**来源**（`关键词` / `模型判定`）。
4. **模型侧读数**：让 agent 调用只读工具 `emotion_status`，应返回当前会话的情绪状态 JSON。
5. **离线自检**（不需要 DSH）：在插件目录里跑测试：

   ```powershell
   node test/all.mjs
   ```

   期望输出 `套件 4/4 通过`（四个套件：会话闭环 57 条 / 崩溃场景 17 条 /
   面板数据层 ≈900 条 / `emotion_status` 工具 12 条，合计约 1000 条断言）。
   若本机没有开发期留下的 `_diag` 快照，崩溃场景那套会多打印一行
   `（本机没有 _diag 快照 ⇒ 跳过真实布局端到端断言；自建同深度布局已覆盖发现链）`
   —— 这是正常的：那条用例会自己在临时目录里搭一份同深度的布局来验发现链。

## 五、配置

插件行由 `cordis.patch.yml` 的 `insert` 提供（`id: emotion-feedback`）。要改配置，在
`%DSH_HOME%\profiles\<profile>\cordis.patch.yml` 里追加一条同 id 的覆盖，重启后生效：

```yaml
- id: emotion-feedback
  config:
    minIntensity: 0.3     # 回注门槛（默认 0.2）
    judgeModel: ''        # 判定用的模型；留空 = 用当前会话的模型
    judgeProvider: ''     # 同上，供应商
    useLlm: true          # 关键词未命中时是否允许调用模型判定
    inject: true          # false = 只判定、不回注
    includeReason: false  # true = 回注文案里带上判定依据
    timeoutMs: 6000       # 单次判定超时，超时保持原状态
    turnDecay: 0.9        # 每回合强度衰减
    takeoverRetain: 0.35  # 情绪切换时旧强度保留比例
    disabled: false       # 紧急开关：true = 全部行为静默（优先于 enabled）
    debug: false          # true = 每回合打印判定结果
```

完整字段（含 `emotions` 词表、`rules` 关键词规则、`negations` 否定词、`prompt`/`template` 文案、
`panelEvent`/`panelRoute`/`statusTool`/`persistHistory`）见 `lib/types/index.d.ts` 的 `Config`
与 `README.md` 的配置表。

## 六、静默与卸载

```powershell
# 临时静默（保留安装）：profile 补丁里加 config: { disabled: true }，重启
# 卸载：
dsh plugin --profile <profile> remove dsh-emotion-feedback
# 或在 DSH 会话里让 agent 用 plugin_manager 的 remove_bundle 卸载
```

## 七、已知边界

- **判定可能静默丢失**：实验中出现过「11 个回合只判到 10 次」的丢样（那一轮沿用上一个状态，
  不会报错、不会中断对话）。这是已知问题，已在 README 的优化队列里。
- **状态活在进程内存里**：重启后下一次判定之前没有状态可回注（历史明细另有落盘：
  `%DSH_HOME%\…\emotion-feedback\history\<sessionId>.json`，保留 30 天，面板重启后可读回）。
- **回注消息会进入会话历史**：它是 `source.kind = 'emotion-feedback'` 的合成 user 消息，
  界面上不显示为「反馈」，但翻会话原始日志能看到；不想让它进上下文就把 `inject` 设为 `false`。
- **判定只用本回合最后一条 assistant 正文**：工具调用、思考块不参与判定。
- **HTTP 路由只在有 `webServer` 服务时注册**；纯桌面形态取不到该路由，面板会自动降级为
  只用会话内数据，功能不受影响。
- 改源码不需要重装（profile 里是 junction），但**每次改动都要完全重启 DSH** 才会加载。

## 八、常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| 重启后界面上没有「情绪」面板 | 客户端 bundle 未加载：确认 profile 的 `dsh.profile.bundles` 里有 `dsh-emotion-feedback`，且 profile 的 `node_modules` 里有指向插件目录的 junction（`pnpm install` 一次即可）；确认是**完全重启**而不是重开浏览器标签 |
| `/emotion-feedback/state` 返回 404 | 该路由只在 Web 形态注册；桌面形态没有这个 HTTP 面，面板会走会话内数据 |
| 面板一直「暂无判定」 | 还没产生判定（聊一轮）；或关键词没命中且 `useLlm: false`；或 `disabled: true` |
| 会话里出现「你当前的内在情绪状态是…」 | 这就是回注的合成 user 消息（设计如此）。`inject: false` 可停 |
| 模型抱怨被评估/谈情绪 | 回注模板里已要求不要谈元层面；可改 `template`，或用 `judgeModel` 换判定模型 |
| 插件加载报错、整个 profile 起不来 | 在 profile 目录执行 `pnpm install` 补齐依赖（缺 `@deepseek-ai/schemastery`），或直接卸载本插件重启 |
| 判定一直不触发 | 确认宿主已重启（安装后当前进程并未挂载监听器），并检查 `debug: true` 的日志 |

## 九、卸载干净

卸载后残留只有两处，都可以手动删：`%DSH_HOME%\emotion-feedback\history\*.json`
（面板历史落盘）与 profile 的 `cordis.patch.yml` 里你自己追加的覆盖条目。
