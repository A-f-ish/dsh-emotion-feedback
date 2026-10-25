/**
 * dsh-emotion-feedback — 浏览器半边（手写、无构建步骤）。
 *
 * 加载方式：宿主以经典 <script> 注入本文件，本文件只做一件事——
 * 通过 window.__ModuleLoader__.load() 注册一个惰性工厂；一切副作用
 * （DOM、样式、监听器）都发生在工厂被 materialize、apply() 执行时。
 *
 * 数据来源（两条，互为补充）：
 * 1) 主路径 —— useChat(s => s.legacy.nodes)：宿主把情绪回注作为一条
 *    合成用户消息（source.kind === 'emotion-feedback'）追加进本回合的
 *    出站请求，并落进会话日志（session.v4.jsonl 里确证存在
 *    user/message + source.kind='emotion-feedback' + surfaceOp='append'），
 *    因此浏览器侧能从对话节点里直接读到每一回合真实回注了什么。
 *    这条路不依赖任何额外接口，离线可用。
 * 2) 可选路径 —— GET /emotion-feedback/state（宿主 panelRoute）：只在
 *    Web 部署里存在，桌面 Electron 走 file://+IPC，取不到时静默降级。
 *    用来补充 host 侧的融合后强度、判定来源等细节。
 */
window.__ModuleLoader__.load({
  id: 'dsh-emotion-feedback',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useMemo, useRef } = React

    /** 宿主包名（必须与 package.json 的 name 一致）。 */
    const NS = 'dsh-emotion-feedback'
    /** composer dock 槽位里的条目 id。 */
    const DOCK_ID = 'emotion-feedback'
    /** 曲线最多展示多少个采样点。 */
    const MAX_POINTS = 40
    /** 最近判定列表最多展示多少条。 */
    const MAX_LIST = 8
    /** 可选 HTTP 通道的轮询间隔与超时。 */
    const PANEL_PATH = '/emotion-feedback/state'
    const POLL_MS = 5000
    const REQUEST_TIMEOUT_MS = 5000

    /** 词表 → 稳定配色（与 host 默认词表一致；未知词走色相哈希）。 */
    const PALETTE = {
      平静: '#7f8ea3',
      愉悦: '#4caf7d',
      好奇: '#3fa7c4',
      坚定: '#4a7fd4',
      自信: '#2f9e8f',
      愧疚: '#b0722a',
      自责: '#c2603a',
      焦虑: '#c99a2e',
      挫败: '#b4534f',
      困惑: '#8a6fbf',
      无奈: '#7a7a86',
      疲惫: '#6d7a6a',
    }

    const CSS = `
.ef-root { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
  line-height: 1; color: var(--dsh-text-secondary, #8a8f98); user-select: none; }
.ef-root > button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px;
  border: 1px solid var(--dsh-border, rgba(127,142,163,.35)); border-radius: 999px;
  background: var(--dsh-surface, rgba(127,142,163,.08)); color: inherit;
  font: inherit; cursor: pointer; transition: border-color .15s, background .15s; }
.ef-root > button:hover { border-color: var(--dsh-border-strong, rgba(127,142,163,.6)); }
.ef-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ef-name { color: var(--dsh-text-primary, #d7dae0); font-weight: 500; }
.ef-val { font-variant-numeric: tabular-nums; opacity: .85; }
.ef-caret { opacity: .6; font-size: 9px; }
.ef-panel { position: relative; }
.ef-card { position: absolute; bottom: calc(100% + 8px); left: 0; width: 360px;
  box-sizing: border-box; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--dsh-border, rgba(127,142,163,.35));
  background: var(--dsh-surface-raised, #1c1f24); color: var(--dsh-text-primary, #d7dae0);
  box-shadow: 0 8px 28px rgba(0,0,0,.35); z-index: 30; }
.ef-card h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; opacity: .8; }
.ef-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; }
.ef-row .k { opacity: .65; }
.ef-bar { height: 6px; border-radius: 3px; background: rgba(127,142,163,.2); overflow: hidden; }
.ef-bar > i { display: block; height: 100%; border-radius: 3px; }
.ef-chart { display: flex; align-items: flex-end; gap: 2px; height: 40px; margin: 8px 0 4px; }
.ef-chart > span { flex: 1 1 0; min-width: 2px; border-radius: 2px 2px 0 0; opacity: .9; }
.ef-list { margin: 6px 0 0; padding: 0; list-style: none; max-height: 168px; overflow: auto; }
.ef-list li { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.ef-list .t { margin-left: auto; opacity: .5; font-variant-numeric: tabular-nums; }
.ef-list .ef-reason { flex: 1 1 auto; min-width: 0; opacity: .62; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
.ef-list .ef-turn { flex: none; opacity: .5; font-variant-numeric: tabular-nums; font-size: 11px; }
.ef-row .ef-reason { flex: 1 1 auto; min-width: 0; text-align: right; opacity: .8;
  overflow-wrap: anywhere; }
.ef-row-plan { opacity: .85; }
.ef-note { margin-top: 8px; padding-top: 6px; border-top: 1px dashed rgba(127,142,163,.3);
  opacity: .6; line-height: 1.5; }
.ef-empty { opacity: .6; }
.ef-broken { display: inline-flex; align-items: center; gap: 6px; opacity: .6; }
`

    // ---------------------------------------------------------------- helpers

    const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value)

    const str = (value) => (typeof value === 'string' && value !== '' ? value : undefined)

    // 调色用的哈希：**必须容忍任何输入**。情绪名从 host payload 读进来，形状不受本插件
    // 控制（可能是 null、数字、对象）。旧写法直接 `text.length`，一旦拿到 undefined 就是
    // TypeError，而这行在渲染路径上——面板会把整个会话视图一起带崩。
    const hashHue = (text) => {
      const value = typeof text === 'string' ? text : String(text ?? '')
      let hash = 0
      for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360
      return hash
    }

    const colorOf = (emotion) => PALETTE[emotion] ?? `hsl(${hashHue(emotion)} 45% 58%)`

    /** 把一条消息的 content 块拼成纯文本。 */
    const textOf = (content) => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block !== null && typeof block === 'object') {
          if (typeof block.text === 'string') parts.push(block.text)
        } else if (typeof block === 'string') parts.push(block)
      }
      return parts.join('\n')
    }

    /** 引号里的词，用于优先命中「愧疚」这类被引号包住的情绪名。 */
    const QUOTED = /[「『“"]([^」』”"]{1,24})[」』”"]/

    /**
     * 从对话节点里取回合号。
     *
     * 回注消息是在**回合 N 起手**时注入的（宿主 agent/pre-step 里 push 进本回合的
     * 出站消息），所以节点若带 turn，它的值就是「这条状态从第几回合开始生效」。
     * 字段名在不同宿主版本里可能是 turn / turnIndex / round，都认；都没有则 undefined。
     */
    const turnOfNode = (node) => {
      if (node === null || typeof node !== 'object') return undefined
      for (const key of ['turn', 'turnIndex', 'round']) {
        const value = node[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return undefined
    }

    /**
     * 这条节点是不是「用户真的说了话」。
     *
     * 回注本身也是一条 user/message（插件把它塞进本回合的出站消息），但它的
     * `source.kind` 是插件名；只有 `source.kind === 'user'` 才是用户发的。
     * 运行时上下文快照（runtime-context / time-context）也不算。
     */
    const isRealUserNode = (node) => {
      if (node === null || typeof node !== 'object') return false
      const kind = node.source !== null && typeof node.source === 'object' ? node.source.kind : node.kind
      return kind === 'user'
    }

    /** 词表性格：中文 1–6 字，或纯 ASCII 1–24 字符（允许自定义英文情绪名）。 */
    const looksLikeEmotion = (text) =>
      /^[\u4e00-\u9fff]{1,6}$/.test(text) || /^[A-Za-z][A-Za-z '-]{0,23}$/.test(text)

    /**
     * 从一条真实的回注消息文本里解析出情绪与强度。
     * 主匹配取「情绪状态是」后的引号词；模板被改过时退化为词表扫描。
     * 强度支持 `0.72`、`85%`、`0.72（0-1）` 等写法；情绪解析不出时返回 undefined。
     */
    const parseInjection = (text) => {
      if (typeof text !== 'string' || text === '') return undefined
      if (!text.includes('内在情绪状态') && !text.includes('情绪状态是')) return undefined
      let emotion
      const quoted = QUOTED.exec(text)
      if (quoted !== null && quoted[1] !== undefined) {
        const candidate = quoted[1].trim()
        if (looksLikeEmotion(candidate)) emotion = candidate
      }
      if (emotion === undefined) {
        for (const name of Object.keys(PALETTE)) {
          if (text.includes(name)) {
            emotion = name
            break
          }
        }
      }
      if (emotion === undefined) return undefined
      let intensity
      const ratio = /强度\s*([0-9]*\.?[0-9]+)\s*%/.exec(text)
      if (ratio !== null) intensity = clamp01(Number(ratio[1]) / 100)
      else {
        const plain = /强度\s*([0-9]*\.?[0-9]+)/.exec(text)
        if (plain !== null) intensity = clamp01(Number(plain[1]))
      }
      // 依据与后续句子之间用中文句号分隔，所以遇到 `。`/换行即停。
      const reasonMatch = /判定依据[：:]\s*([^。\n]+)/.exec(text) ?? /依据[：:]\s*([^。\n]+)/.exec(text)
      const reason = reasonMatch !== null ? reasonMatch[1].trim() : undefined
      return { emotion, intensity, reason }
    }

    /**
     * 从消息节点里认出本插件写下的回注消息。
     *
     * 主判据是 `source.kind`（宿主回注时写的是 `emotion-feedback`，正是本包名）。
     * 兜底只在「source 完全没有 kind」或「是宿主注入的上下文行且带 emotion-feedback
     * 生产者的中文名」时按文案特征匹配——否则会话里任何提到情绪词的注入行都会被误判。
     */
    const injectionOf = (node) => {
      if (node === null || typeof node !== 'object') return undefined
      const source = node.source
      const tag = source !== null && typeof source === 'object' ? str(source.kind) : undefined
      const text = textOf(node.content)
      if (tag === NS || tag === 'emotion-feedback') {
        const parsed = parseInjection(text)
        return parsed === undefined ? undefined : { ...parsed, text }
      }
      if (node.kind !== 'user' && node.kind !== 'context') return undefined
      const producer = node.producer
      const producedByUs = producer !== null && typeof producer === 'object' && str(producer.label) === 'emotion-feedback'
      if (tag !== undefined && !producedByUs) return undefined
      const parsed = parseInjection(text)
      return parsed === undefined ? undefined : { ...parsed, text }
    }

    /** chat 节点数组 → 按时间升序的采样点。 */
    const samplesOf = (nodes) => {
      if (!Array.isArray(nodes)) return []
      const out = []
      // 真实用户消息的出现次数 = 当前走到第几回合。回注紧跟在本回合那条用户消息之后
      // （已用线上日志逐条核对：26 条用户消息、19 条回注，序号严格同序），
      // 所以「截至这条回注为止数到第几条用户消息」就是它的生效回合。
      let turnSeen = 0
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (isRealUserNode(node)) turnSeen += 1
        const hit = injectionOf(node)
        if (hit === undefined) continue
        out.push({
          seq: typeof node.seq === 'number' ? node.seq : out.length,
          time: typeof node.time === 'number' ? node.time : undefined,
          // turn = 这条回注从第几回合起生效（回合 N 起手注入 ⇒ 用户在回合 N 就看到它）。
          // 节点自带回合号就用它，否则用上面数出来的位置——不能再留 undefined：
          // 之前面板每行都显示「—」，就是因为线上节点根本没有 turn 字段。
          turn: turnOfNode(node) ?? (turnSeen > 0 ? turnSeen : undefined),
          emotion: hit.emotion,
          intensity: hit.intensity,
          // 回注文案里本来就带「判定依据」句（config.includeReason 打开时才有）。
          reason: hit.reason,
        })
      }
      out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      return out
    }

    /**
     * 把「会话里真实回注过的状态」（samples，离线就有）与「host 侧判定明细」（history）合并。
     *
     * 两者各缺一半：
     *   - samples 是**模型真正收到的**状态，但没有判定原值、融合关系、来源；
     *   - host history 有原值/依据/来源/融合关系，但它只存在于进程内存里（重启即空）。
     * 以 host 为主、samples 补「生效时刻」，就能在同一条记录里同时拿到
     * 「那一轮判了什么、依据是什么、结果以多大强度真的注入了」。
     *
     * 合并键统一成**生效回合**（effectiveTurn）：一次判定在回合 N 收尾做出、从回合 N+1
     * 起生效。会话侧的样本本来就只有生效回合；host 侧用 `injectedInto`（真回注记下的
     * 那个回合），没记上就按 `turn + 1` 预告。之前两边一个用「判定回合」一个用「生效
     * 回合」当键，同一条判定被拆成两行，面板因此同时显示「—」和重复行。
     */
    const mergeRounds = (samples, history) => {
      const rows = new Map()
      const push = (key, patch) => {
        const id = typeof key === 'number' && Number.isFinite(key) ? `e${key}` : `?${rows.size}`
        const existing = rows.get(id)
        const base = existing ?? { id, source: 'session' }
        // `undefined` 不当覆盖：host 记录里缺某个字段（例如老存档没有 reason）时，
        // 不能把会话侧已经从回注正文里解析出来的依据抹掉——抹掉就等于「每轮依据」凭空消失。
        const clean = {}
        for (const [name, value] of Object.entries(patch)) {
          if (value !== undefined) clean[name] = value
        }
        rows.set(id, { ...base, ...clean })
      }
      for (const sample of Array.isArray(samples) ? samples : []) {
        // 数组里混进 null/数字也要活得下去：`sample.turn` 对 null 是 TypeError。
        if (sample === null || typeof sample !== 'object') continue
        const effectiveTurn = typeof sample.turn === 'number' && Number.isFinite(sample.turn) ? sample.turn : undefined
        push(effectiveTurn, {
          sessionSeq: sample.seq,
          effectiveAt: sample.time,
          effectiveTurn,
          emotion: sample.emotion,
          intensity: sample.intensity,
          reason: sample.reason,
        })
      }
      for (const item of Array.isArray(history) ? history : []) {
        if (item === null || typeof item !== 'object') continue
        const judgedTurn = typeof item.turn === 'number' ? item.turn : undefined
        const effectiveTurn = typeof item.injectedInto === 'number'
          ? item.injectedInto
          : (judgedTurn === undefined ? undefined : judgedTurn + 1)
        push(effectiveTurn, {
          source: 'host',
          judgedTurn,
          effectiveTurn,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
          judgedEmotion: item.judgedEmotion,
          judgedIntensity: item.judgedIntensity,
          emotion: item.emotion,
          intensity: item.intensity,
          reason: item.reason,
          sourceKind: item.source,
          outOfList: item.outOfList === true,
          injectedInto: typeof item.injectedInto === 'number' ? item.injectedInto : undefined,
        })
      }
      const out = [...rows.values()].map((row) => {
        // `turn` 保持「判定回合」的语义（面板文案与老测试都按它读）。
        // 只有会话样本、没有 host 明细时，判定回合 = 生效回合 - 1：这是回注机制本身
        // 决定的（回合 N 起手注入的状态，只可能来自回合 N-1 收尾的那次判定）。
        const inferred = typeof row.judgedTurn === 'number'
          ? undefined
          : (typeof row.effectiveTurn === 'number' && row.effectiveTurn > 1 ? row.effectiveTurn - 1 : undefined)
        const turn = typeof row.judgedTurn === 'number' ? row.judgedTurn : inferred
        return { ...row, turn, judgedInferred: inferred !== undefined }
      })
      out.sort((a, b) => {
        const left = a.effectiveTurn ?? a.turn ?? Number.POSITIVE_INFINITY
        const right = b.effectiveTurn ?? b.turn ?? Number.POSITIVE_INFINITY
        if (left !== right) return left - right
        return (a.sessionSeq ?? 0) - (b.sessionSeq ?? 0)
      })
      return out
    }

    /**
     * 「当前情绪」取哪一行：**最近一次真的注入出去**的判定。
     *
     * 一次判定在回合 N 收尾做出、回合 N+1 起手才注入，所以合并后的最后一行常常是
     * 「已判定、还没发出」的那条（host 采样没有 injectedInto）。它不能当「当前情绪」：
     * 一是它还没生效，二是它已经单独显示在「下一回合将注入」那一行，两处都算就是重复。
     * 判据：会话节点里真出现过（`sessionSeq`）或 host 记下了生效回合（`injectedInto`）。
     * 一条都没有时（例如只拿到 host 存档、或日志里读不到回注）退回最后一行，至少不空。
     */
    const lastAppliedRound = (rounds) => {
      if (!Array.isArray(rounds) || rounds.length === 0) return undefined
      for (let index = rounds.length - 1; index >= 0; index -= 1) {
        const row = rounds[index]
        if (row === null || row === undefined || typeof row !== 'object') continue
        if (typeof row.injectedInto === 'number' || row.sessionSeq !== undefined) return row
      }
      return rounds[rounds.length - 1]
    }

    /**
     * 「T{n} 判定 → T{m} 生效」文案。
     * 判定发生在回合 N 收尾、状态从回合 N+1 起生效，所以这两个数天然差 1——
     * 把两个数都写出来，用户就不用再从时间戳里猜「这到底是哪一轮的判定」。
     */
    const turnPair = (row) => {
      if (row === undefined || row === null) return '—'
      const judged = typeof row.turn === 'number' ? row.turn : undefined
      const effective = typeof row.injectedInto === 'number'
        ? row.injectedInto
        : (typeof row.effectiveTurn === 'number'
          ? row.effectiveTurn
          : (judged === undefined ? undefined : judged + 1))
      if (judged === undefined) return effective === undefined ? '—' : `T${effective} 生效`
      return `T${judged} 判定 → T${effective} 生效`
    }

    /** 「回合 N 生效」文案；没有回合号时退回「最近一次回注」。 */
    const effectiveLabel = (row) => {
      if (row === undefined) return '最近一次回注'
      if (typeof row.effectiveTurn === 'number') return `回合 ${row.effectiveTurn} 生效`
      if (typeof row.turn === 'number') return `回合 ${row.turn} 生效`
      return '最近一次回注'
    }

    /** 本次回注的强度相对判定原值的倍率（有原值才显示）。 */
    const blendRatio = (row) => {
      if (row === undefined) return undefined
      const judged = Number(row.judgedIntensity)
      const live = Number(row.intensity)
      if (!Number.isFinite(judged) || !Number.isFinite(live) || judged <= 0.001) return undefined
      return live / judged
    }

    const clock = (time) => {
      if (typeof time !== 'number' || !Number.isFinite(time)) return ''
      const date = new Date(time)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    const formatIntensity = (value) => (Number.isFinite(value) ? Number(value).toFixed(2) : '—')

    /** 判定来源的显示名：关键词层 / 模型判定层。 */
    const sourceLabel = (value) => (value === 'rule' ? '关键词' : value === 'llm' ? '模型判定' : String(value))

    const asPayload = (value) =>
      value !== null && typeof value === 'object' && Array.isArray(value.sessions) ? value : undefined

    /** 可选的 host 侧快照（Web 部署才有；取不到就返回 undefined）。 */
    const fetchPayload = async (sessionId) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const query = typeof sessionId === 'string' && sessionId !== '' ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
        const response = await fetch(`${PANEL_PATH}${query}`, {
          signal: controller.signal,
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return undefined
        return asPayload(await response.json())
      } catch {
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }

    // ------------------------------------------------------------- components

    function Bar(props) {
      const { emotion, intensity } = props
      const width = `${Math.round(clamp01(Number(intensity) || 0) * 100)}%`
      return React.createElement(
        'div',
        { className: 'ef-bar' },
        React.createElement('i', { style: { width, background: colorOf(emotion) } }),
      )
    }

    function Chart(props) {
      const { samples, active } = props
      const shown = (Array.isArray(samples) ? samples : []).slice(-MAX_POINTS)
      if (shown.length === 0) return null
      return React.createElement(
        'div',
        { className: 'ef-chart' },
        shown.map((sample, index) =>
          React.createElement('span', {
            key: `${sample.seq ?? index}`,
            title: `${sample.emotion} ${formatIntensity(sample.intensity)}${sample.time !== undefined ? ` · ${clock(sample.time)}` : ''}`,
            style: {
              height: `${Math.max(6, Math.round(clamp01(sample.intensity) * 100))}%`,
              background: colorOf(sample.emotion),
              opacity: index === shown.length - 1 && active === true ? 1 : 0.75,
            },
          }),
        ),
      )
    }

    /** composer dock 上的情绪面板。 */
    function EmotionDock(props) {
      const [open, setOpen] = useState(false)
      const [host, setHost] = useState(undefined)
      const sessionId = str(props.sessionId)

      // 槽位标准 props：useChat 是「有则用、无则忽略」的可选读取口。
      const nodes = typeof props.useChat === 'function'
        ? props.useChat((snapshot) => (snapshot !== null && typeof snapshot === 'object' && snapshot.legacy !== undefined
          ? snapshot.legacy.nodes
          : undefined))
        : undefined

      const samples = useMemo(() => samplesOf(nodes), [nodes])

      // 可选通道：host 侧快照（Electron 桌面端取不到，静默忽略）。
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        const tick = async () => {
          const payload = await fetchPayload(sessionId)
          if (!alive.current) return
          if (payload !== undefined) setHost(payload)
        }
        void tick()
        const timer = setInterval(() => void tick(), POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [sessionId])

      const hostSession = useMemo(() => {
        if (host === undefined) return undefined
        const list = host.sessions
        if (sessionId !== undefined) {
          const exact = list.find((item) => item !== null && typeof item === 'object' && item.sessionId === sessionId)
          if (exact !== undefined) return exact
        }
        return list.find((item) => item !== null && typeof item === 'object')
      }, [host, sessionId])

      // host 侧的**逐轮明细**在 `samples` 里：每条都带 judgedEmotion / judgedIntensity /
      // reason / source / outOfList / injectedInto（快照与存档两条路径都是这个形状）。
      // `history` 只是压缩过的 { turn, emotion, intensity } —— 只读 history 的话，
      // 面板每一行都只能写「无依据」（用户报告的问题②）。
      const hostRows = hostSession !== undefined && Array.isArray(hostSession.samples) && hostSession.samples.length > 0
        ? hostSession.samples
        : (hostSession !== undefined && Array.isArray(hostSession.history) ? hostSession.history : [])
      const rounds = useMemo(() => mergeRounds(samples, hostRows), [samples, hostRows])
      // 「当前情绪」= 回合起手真的注入给模型的那一条。
      // 判定明细用同一条记录的 host 字段补上——**绝不再把 host 当前强度配到这条上**：
      // host 的 intensity 是下一次要注入的状态，配到已生效的行上就是「错位一轮」。
      const lastRound = lastAppliedRound(rounds)
      const emotion = lastRound !== undefined ? lastRound.emotion : (hostSession !== undefined ? str(hostSession.emotion) : undefined)
      const intensity = lastRound !== undefined ? lastRound.intensity : (hostSession !== undefined ? hostSession.intensity : undefined)
      const total = samples.length
      // 下一回合将要回注的状态（host 独有）：与已生效行分开显示，用户能看到「判了什么」和「什么时候生效」。
      const plan = hostSession !== undefined && hostSession.injectionPlan !== null && typeof hostSession.injectionPlan === 'object'
        ? hostSession.injectionPlan
        : undefined
      const planEmotion = plan !== undefined ? str(plan.emotion) : undefined
      const planIntensity = plan !== undefined && Number.isFinite(plan.intensity) ? plan.intensity : undefined
      const planPending = plan !== undefined && plan.pending === true
      // `willInjectAt` 是**生效**回合（判定回合 + 1），判定回合是 `judgedTurn`。
      // 上一版把 willInjectAt 当成判定回合写进文案，回合号整体偏了一轮。
      const planJudgedTurn = plan !== undefined && typeof plan.judgedTurn === 'number' ? plan.judgedTurn : undefined
      const planInjectTurn = plan !== undefined && typeof plan.willInjectAt === 'number' ? plan.willInjectAt : undefined
      const planReason = plan !== undefined ? str(plan.reason) : undefined
      const planSource = plan !== undefined ? str(plan.source) : undefined
      const planOutOfList = plan !== undefined && plan.outOfList === true
      // host 快照比会话节点多带 source / reason / outOfList，面板据此把「这条判定是怎么来的」显示出来。
      const lastReason = lastRound !== undefined ? str(lastRound.reason) : undefined
      const judgedIntensity = lastRound !== undefined && Number.isFinite(lastRound.judgedIntensity) ? lastRound.judgedIntensity : undefined
      const judgedEmotion = lastRound !== undefined ? str(lastRound.judgedEmotion) : undefined
      const ratio = blendRatio(lastRound)
      const sourceKind = lastRound !== undefined ? str(lastRound.sourceKind) : undefined
      const outOfList = lastRound !== undefined && lastRound.outOfList === true

      const folded = React.createElement(
        'button',
        {
          type: 'button',
          title: '情绪面板：点击展开/收起',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
        React.createElement('span', {
          className: 'ef-dot',
          style: { background: emotion !== undefined ? colorOf(emotion) : 'rgba(127,142,163,.5)' },
        }),
        React.createElement('span', { className: 'ef-name' }, emotion ?? '情绪：暂无判定'),
        emotion !== undefined ? React.createElement('span', { className: 'ef-val' }, formatIntensity(intensity)) : null,
        React.createElement('span', { className: 'ef-caret' }, open ? '▼' : '▲'),
      )

      if (!open) return React.createElement('span', { className: 'ef-root' }, folded)

      return React.createElement(
        'span',
        { className: 'ef-root ef-panel' },
        folded,
        React.createElement(
          'div',
          { className: 'ef-card' },
          React.createElement('h4', null, '工作模型当前情绪'),
          emotion === undefined
            ? React.createElement('div', { className: 'ef-empty' }, '本会话还没有判定结果。判定发生在每个回合结束时，从下一回合起显示。')
            : React.createElement(
                'div',
                null,
                // ① 此刻正在生效的情绪：回合 N 起手注入给模型的那一条。
                React.createElement(
                  'div',
                  { className: 'ef-row' },
                  React.createElement('span', null, React.createElement('span', { className: 'ef-dot', style: { background: colorOf(emotion), display: 'inline-block', marginRight: 6 } }), emotion),
                  React.createElement('span', { className: 'ef-val' }, `强度 ${formatIntensity(intensity)}`),
                ),
                React.createElement(Bar, { emotion, intensity }),
                React.createElement(
                  'div',
                  { className: 'ef-row' },
                  React.createElement('span', { className: 'k' }, '生效'),
                  React.createElement('span', null, `${effectiveLabel(lastRound)}${lastRound !== undefined && lastRound.effectiveAt !== undefined ? ` · ${clock(lastRound.effectiveAt)}` : ''}`),
                ),
                // ② 这条情绪的判定明细：原值、融合倍率、依据、来源。
                judgedEmotion !== undefined || judgedIntensity !== undefined
                  ? React.createElement(
                      'div',
                      { className: 'ef-row' },
                      React.createElement('span', { className: 'k' }, '判定原值'),
                      React.createElement(
                        'span',
                        { title: judgedEmotion !== undefined && judgedEmotion !== emotion ? `模型判定的是「${judgedEmotion}」，融合后生效的是「${emotion}」` : undefined },
                        `${judgedEmotion ?? emotion} ${formatIntensity(judgedIntensity)}` +
                          (ratio !== undefined ? `（融合后 ${formatIntensity(intensity)}，×${ratio.toFixed(2)}）` : ''),
                      ),
                    )
                  : null,
                React.createElement(
                  'div',
                  { className: 'ef-row' },
                  React.createElement('span', { className: 'k' }, '依据'),
                  React.createElement('span', { className: 'ef-reason', title: lastReason ?? '' }, lastReason !== undefined && lastReason !== '' ? lastReason : '—'),
                ),
                sourceKind !== undefined || judgedIntensity !== undefined
                  ? React.createElement(
                      'div',
                      { className: 'ef-row' },
                      React.createElement('span', { className: 'k' }, '来源'),
                      React.createElement('span', null, `${sourceKind !== undefined ? sourceLabel(sourceKind) : '关键词判定'}${outOfList ? ' · 词表外标签' : ''}`),
                    )
                  : null,
                // ③ 下一回合将要回注的状态（尚未发出，与②分开，避免被误读成「这一轮的情绪」）。
                planEmotion !== undefined
                  ? React.createElement(
                      'div',
                      { className: 'ef-row ef-row-plan' },
                      React.createElement('span', { className: 'k' }, planPending ? '下一回合将注入' : '下一回合状态'),
                      React.createElement(
                        'span',
                        null,
                        `${planEmotion} ${formatIntensity(planIntensity)}` +
                          `（回合 N${planJudgedTurn !== undefined ? planJudgedTurn : '?'} 判定` +
                          `${planInjectTurn !== undefined ? ` → 回合 N${planInjectTurn} 生效` : ''}` +
                          `${planSource !== undefined ? ` · ${sourceLabel(planSource)}${planOutOfList ? ' · 词表外标签' : ''}` : ''}` +
                          `${planPending ? ' · 尚未发出' : ''}）`,
                      ),
                      // 依据必须**看得见**：挂在 title 上等于看不见（用户报告的问题②）。
                      React.createElement('span', { className: 'ef-reason' }, planReason !== undefined && planReason !== '' ? `依据：${planReason}` : '依据：—'),
                    )
                  : null,
                React.createElement(Chart, { samples, active: true }),
                React.createElement(
                  'div',
                  { className: 'ef-row' },
                  React.createElement('span', { className: 'k' }, '累计'),
                  React.createElement('span', null, `${total} 次判定 / 最近 ${Math.min(total, MAX_POINTS)} 次曲线`),
                ),
                React.createElement(
                  'ul',
                  { className: 'ef-list' },
                  // 逐轮明细：每一条 = 那一轮判了什么、依据是什么、以多大强度生效。
                  rounds.slice(-MAX_LIST).reverse().map((row, index) => {
                    // 这两个字段直接来自 host payload，形状不由本插件决定：数字/对象交给真
                    // React 会以「Objects are not valid as a React child」整屏报错，先收成字符串。
                    const rowEmotion = str(row.emotion)
                    const rowReason = str(row.reason)
                    return React.createElement(
                      'li',
                      { key: `${row.id ?? index}`, title: rowReason !== undefined ? `依据：${rowReason}` : undefined },
                      React.createElement('span', { className: 'ef-turn', title: turnPair(row) }, turnPair(row)),
                      React.createElement('span', { className: 'ef-dot', style: { background: colorOf(rowEmotion) } }),
                      React.createElement('span', { className: 'ef-name' }, rowEmotion ?? '未知'),
                      React.createElement('span', { className: 'ef-val' }, formatIntensity(row.intensity)),
                      React.createElement('span', { className: 'ef-reason' }, rowReason ?? '无依据'),
                      React.createElement('span', { className: 't' }, row.effectiveAt !== undefined ? clock(row.effectiveAt) : ''),
                    )
                  }),
                ),
              ),
          React.createElement(
            'div',
            { className: 'ef-note' },
            hostSession !== undefined
              ? (hostSession.restoredFromDisk === true
                // 内存里没有该会话（DSH 重启过）：明细来自插件自己的存档，所以历史回合的依据还在。
                ? `host 存档：${str(hostSession.workspace) ?? '未知工作区'} · DSH 重启前的明细（更新 ${clock(Date.parse(str(hostSession.updatedAt) ?? ''))}）`
                : `host 快照：${str(hostSession.workspace) ?? '未知工作区'} · 更新 ${clock(Date.parse(str(hostSession.updatedAt) ?? ''))}`)
              : '数据来源：会话内真实回注消息（每条回注都会出现在这里）。',
          ),
        ),
      )
    }

    /**
     * 渲染保险丝（React 错误边界）。
     *
     * 面板读的是三份都不由本插件控制的输入：会话节点（外壳给的）、host 快照（HTTP）、
     * 时间戳。任何一份换了形状，**只允许这一小块变成「情绪面板暂不可用」**，绝不能把
     * 会话视图一起带崩——宿主侧对应的是 `safeDecision()`：宁可少显示，也绝不抛出去。
     *
     * 必须是 class：函数组件里的 try/catch 抓不到子组件渲染阶段抛出的错误（那时
     * createElement 早就返回了，真正的调用发生在 React 内部）。
     * 拿不到 `React.Component`（例如某些精简运行时/测试替身）时原样返回，行为与不加保险丝一致。
     */
    const withFuse = (Inner) => {
      if (React === null || typeof React !== 'object' || typeof React.Component !== 'function') return Inner
      class EmotionFuse extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }
        static getDerivedStateFromError() { return { failed: true } }
        componentDidCatch() {}
        render() {
          if (this.state !== null && this.state !== undefined && this.state.failed === true) {
            return React.createElement(
              'span',
              { className: 'ef-root ef-broken' },
              React.createElement('span', { className: 'ef-dot', style: { background: 'rgba(127,142,163,.5)' } }),
              React.createElement('span', { className: 'ef-name' }, '情绪面板暂不可用'),
            )
          }
          return React.createElement(Inner, this.props)
        }
      }
      // 测试要能拿到内层面板（错误边界本身无法用函数渲染器渲染）。
      EmotionFuse.inner = Inner
      EmotionFuse.displayName = 'EmotionFuse'
      return EmotionFuse
    }

    /** host 融合前后强度比，仅用于展示。 */
    function judgeRatio(judged, live) {
      if (!Number.isFinite(judged) || !Number.isFinite(live) || judged <= 0.001) return undefined
      const value = live / judged
      return value < 0.1 ? 0.1 : value > 2 ? 2 : value
    }

    // ------------------------------------------------------------------ styles

    /** 注册插件样式；返回移除函数（宿主 HMR 按 data-plugin 回收）。 */
    const insertStyles = () => {
      const selector = `style[data-plugin-css="${NS}/emotion-panel.css"]`
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = `${NS}/emotion-panel.css`
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ------------------------------------------------------------------- entry

    // 测试钩子：只有在测试沙箱里预置了 window.__EF_TEST__ 时才写出（真实页面
    // 上这个键不存在，因此不会污染宿主环境）。让 test/panel-data.mjs 能直接
    // 验证上面这些纯函数，而不必把逻辑复制一份到测试里。
    if (window.__EF_TEST__ !== undefined && window.__EF_TEST__ !== null) {
      window.__EF_TEST__ = {
        parseInjection, samplesOf, injectionOf, colorOf, textOf, sourceLabel,
        mergeRounds, effectiveLabel, blendRatio, turnOfNode, turnPair, lastAppliedRound, withFuse,
      }
    }

    return {
      name: `${NS}-client`,
      /** Cordis 服务名：只用到槽位注册表。 */
      inject: ['slots'],
      apply(ctx) {
        // 工厂体内才允许有副作用：样式注册必须走 ctx.effect 才能在卸载时回收。
        ctx.effect(insertStyles, `${NS}: emotion panel styles`)
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: DOCK_ID, order: 1, label: '情绪' },
            withFuse(EmotionDock),
          ),
        )
      },
    }
  },
})
