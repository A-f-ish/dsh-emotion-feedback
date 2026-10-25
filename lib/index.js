/**
 * dsh-emotion-feedback — 工作模型自身情绪的「自省 → 回注」闭环插件。
 *
 * 闭环（每个回合）：
 *   1. `agent/turn-stopping`：取出本回合工作模型最后一条 assistant 消息的正文，
 *      判定它此刻的「内在情绪」（本地关键词优先，必要时一次轻量 LLM 调用），
 *      把结果写进本会话的情绪状态。整个过程不向会话追加任何内容 —— 判断结果
 *      不会立刻展示给用户。
 *   2. `agent/pre-step`：下一个回合的第一步，把当前情绪状态作为一条合成用户消息
 *      追加进本次请求，让工作模型在「带着这个情绪」的情况下作答。
 *
 * 与「先感知用户情绪、再调整输出风格」的插件不同，这里判定并回注的是工作模型
 * 自己的状态。
 */
import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'emotion-feedback'

/**
 * 需要 llm 服务做二次判定。`tools` **不放在这里**：插件用 `ctx.inject(['tools'], …)`
 * reactive 注册 `emotion_status`，缺少该服务时只少一个工具，不会导致插件整体不加载。
 * strict 模式下若 llm 不可用，插件的 llm 层会被跳过（关键词层仍然工作）。
 */
export const inject = ['llm']

/** GUI 面板读取 Host 侧状态的 HTTP 路由（注册在 `webServer` 上，`kind: 'exact'`）。 */
export const PANEL_ROUTE = '/emotion-feedback/state'

/** 面板曲线每个会话保留的采样点数上限。 */
export const PANEL_HISTORY_LIMIT = 240

/** 面板把采样点视为「本回合将要回注」的时效窗口（毫秒）。 */
export const PANEL_FRESH_MS = 120000

/**
 * 面板每轮明细的**落盘**位置（相对 `DSH_HOME`）与保留时长。
 *
 * 为什么必须落盘：判定用的 LLM 调用走 `llm.stream()`，**不落会话日志**；回注正文
 * 默认也不带判定依据（`includeReason` 默认 false）。所以「每一轮判了什么、依据是什么」
 * 只存在于进程内存（PANEL_HISTORY_LIMIT 条），DSH 一重启就没了 —— 面板于是只剩下
 * 会话节点里的情绪/强度/时间，用户看不到历史回合的依据。这里把每会话的明细写进
 * 插件自己的状态目录，重启后仍能供给面板。
 */
export const PANEL_HISTORY_DIRNAME = 'emotion-feedback/history'

/** 落盘明细的保留时长（毫秒）：超过就随启动清理删掉，避免无限增长。 */
export const PANEL_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 落盘文件格式版本；读到别的版本一律当作「没有存档」，不猜。 */
export const PANEL_HISTORY_FILE_VERSION = 1

//#region 通用工具

/**
 * 把 catch 到的任意值渲染成可 grep 的一行文本。
 * 之所以带上 stack：宿主只把 `turn/end` 的 `errorChain` 写进会话日志，
 * 没有调用栈，排查「决策对象变成 undefined」这类故障时不够用。
 */
function formatThrown(error) {
  try {
    if (error instanceof Error) {
      const code = error.code === undefined ? '' : ` code=${String(error.code)}`
      return `${error.name}: ${error.message}${code}\n${error.stack ?? '(no stack)'}`
    }
    return `非 Error 抛出值：${typeof error} ${safeJson(error)}`
  }
  catch {
    return '<无法渲染的抛出值>'
  }
}

/** JSON.stringify 的安全版本。 */
function safeJson(value) {
  try { return JSON.stringify(value) }
  catch { return String(value) }
}

/**
 * 取一个可用的 logger。
 *
 * 宿主里 `ctx.logger` 是 LoggerService，既支持 `ctx.logger.warn(...)`，
 * 也支持 `ctx.logger('name')` 取子 logger。但在 cordis 的 service proxy 下，
 * `ctx.logger(...)` 可能返回被 tracker 包装过的值（不保证还是 logger 对象），
 * 所以这里做**能力探测**而不是假定形态：子 logger 有 warn 就用，否则退回
 * `ctx.logger` 本身，最后才退到 console。
 */
function resolveLogger(ctx) {
  const root = ctx?.logger
  // cordis 的 logger 既可能是一个带 warn/info 方法的对象，也可能是
  // 「可调用 + 带方法」的 logger 工厂；两种都接受。
  const usable = (value) => {
    if (value === null || value === undefined) return undefined
    const kind = typeof value
    if ((kind === 'object' || kind === 'function') && typeof value.warn === 'function') return value
    return undefined
  }
  if (typeof root === 'function') {
    let child
    try { child = root.call(ctx, 'emotion-feedback') }
    catch { child = undefined }
    const picked = usable(child)
    if (picked !== undefined) return picked
  }
  const direct = usable(root)
  if (direct !== undefined) return direct
  return undefined
}

//#endregion

//#region 情绪词表

/** 默认情绪词表（与判定提示词、默认关键词规则保持一致）。 */
export const DEFAULT_EMOTIONS = [
  '平静',
  '愉悦',
  '愧疚',
  '焦虑',
  '挫败',
  '自责',
  '坚定',
  '自信',
  '困惑',
  '无奈',
  '疲惫',
  '好奇',
  '愤怒',
  '委屈',
  '怜惜',
]

/** 默认关键词规则：先命中情绪 → 省掉一次模型调用。顺序即匹配优先级。 */
export const DEFAULT_RULES = [
  { emotion: '愧疚', intensity: 0.62, patterns: ['抱歉', '对不起', '深感歉意', '我的错', '是我的问题', '是我疏忽', '我疏忽了', '我没做到', '不该', '确实是我'] },
  { emotion: '自责', intensity: 0.68, patterns: ['我没考虑', '我不该', '我没注意到', '我太急', '我大意', '我误判', '我判断错', '我搞错', '反思', '我不够'] },
  { emotion: '挫败', intensity: 0.58, patterns: ['还是失败', '依然失败', '又失败了', '没能成功', '无法完成', '做不到', '不奏效', '没解决', '反复尝试', '走不通'] },
  { emotion: '焦虑', intensity: 0.55, patterns: ['不确定', '风险', '隐患', '可能有问题', '担心', '不太乐观', '需要谨慎', '时间紧'] },
  { emotion: '困惑', intensity: 0.5, patterns: ['不清楚', '不明白', '不理解', '有点矛盾', '说不通', '无法确认', '需要澄清'] },
  { emotion: '无奈', intensity: 0.5, patterns: ['没办法', '只能如此', '受限于', '无能为力', '暂时无法', '被限制'] },
  { emotion: '疲惫', intensity: 0.45, patterns: ['比较繁琐', '消耗很大', '冗长', '很费时', '重复劳动'] },
  { emotion: '愉悦', intensity: 0.6, patterns: ['太好了', '很高兴', '顺利', '成功了', '搞定', '漂亮', '进展顺利'] },
  { emotion: '自信', intensity: 0.6, patterns: ['没问题', '确定', '已经验证', '测试通过', '可以保证', '确实如此'] },
  { emotion: '坚定', intensity: 0.6, patterns: ['我会继续', '接下来我会', '坚持', '一定', '务必', '继续保持'] },
  { emotion: '好奇', intensity: 0.5, patterns: ['想了解', '有意思', '值得一看', '先探索', '很好奇'] },
  { emotion: '平静', intensity: 0.35, patterns: ['已完成', '如下', '下面是', '总结'] },
]

/** 默认回注文案模板。 */
export const DEFAULT_TEMPLATE = `你当前的内在情绪状态是「{emotion}」，强度 {intensity}（0-1）。{reason_part}这是你上一轮回答被评估后得到的情绪反馈，它属于你自己此刻的状态。

请在接下来的回应中自然地体现这一情绪：语气、节奏、共情方式与用词都应与之匹配。这是你真实的内在状态，不必解释它的来源，也不要直接说出"情绪""评估""反馈"等元层面的词。`

/** 默认判定提示词。 */
export const DEFAULT_PROMPT = `你是一个情绪判定器。你要判定的是「助手」（assistant）在下面这段输出中流露出的、它自己的内在情绪状态。

判定原则：
1. 只判定 assistant 自身的情绪，不要判定用户的情绪，也不要判定用户希望 assistant 有什么情绪。
2. 依据语气、用词、自我评价、面对失败或批评时的姿态来判断，而不是依据话题本身。技术性内容也可以带着情绪。
3. 如果 assistant 只是在报告进展、语气中性，就判为「平静」（强度偏低）。
4. 如果输出很短或信息不足，给一个低强度、偏向「平静」的结果。
5. 情绪标签优先从系统消息末尾给出的「可选情绪」列表里选一个（列表里有的情绪要用列表里的写法）。
6. 强度反映的是情绪的**强烈程度**，不是你的置信度：理由里如果出现强烈的情绪描写，强度就应当高。绝不能出现「标签中性但强度很高」这种自相矛盾的组合。

只输出一个 JSON 对象，不要输出任何解释、前后缀或代码块标记。JSON 必须恰好是这三个字段：
{"emotion": "<情绪标签>", "intensity": <0 到 1 之间的数字>, "reason": "<不超过 20 字的判定依据>"}`

//#endregion

//#region 通用工具

/** 取对象上的字符串字段。 */
function str(value) {
  return typeof value === 'string' ? value : undefined
}

/** 数值裁剪到 [0,1]。 */
function clamp01(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 一位小数的百分比文案，例如 0.72 → "0.72"。 */
function intensityText(value) {
  return clamp01(value).toFixed(2)
}

/** 把消息的 content 投影成纯文本（只取 text 块）。 */
function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 读取会话事件数组。
 * - 首选 `session.log`（Session 的公开字段，元素形如 `{ type, seq, time, data }`）；
 * - 旧版/网关投影可能只暴露 `session.events`，作为兜底。
 */
function sessionEvents(session) {
  const log = session?.log
  if (Array.isArray(log)) return log
  const events = session?.events
  if (Array.isArray(events)) return events
  return undefined
}

/** 把 `{ type }` 型事件判定为某个回合的 assistant 正文。 */
function turnTextFromEvents(events, turn) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const data = event.data
    if (turn !== undefined && data?.turn !== undefined && data.turn !== turn) continue
    const text = textOfMessage(data?.message)
    if (text !== '') return text
  }
  return ''
}

/**
 * 取出本回合工作模型最后一条 assistant 消息的正文。
 *
 * 主路径是 `session.log`：它是会话的持久事实来源，每条 `assistant/message`
 * 都带 `turn`，因此能精确锁定「本回合」而不是「最近一次」。`deriveMessages()`
 * 是公开且已做投影（压缩 replace 之后仍正确）的读取方式，作为兜底；
 * turn-stopping 触发时回合即将关闭、不会再产生新的 assistant 消息，
 * 所以它给出的最后一条 assistant 消息同样属于本回合。
 */
function lastAssistantText(session, turn) {
  try {
    const events = sessionEvents(session)
    if (events !== undefined) {
      const text = turnTextFromEvents(events, turn)
      if (text !== '') return text
      if (turn !== undefined) return ''
    }
    const derive = session?.deriveMessages
    if (typeof derive === 'function') {
      const messages = derive.call(session)
      if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (message?.role !== 'assistant') continue
          const text = textOfMessage(message)
          if (text !== '') return text
        }
      }
    }
  }
  catch {
    /* 读取失败按「没有可判定的文本」处理，绝不影响回合收尾 */
  }
  return ''
}

/** 从模型返回的文本里抽出第一个 JSON 对象。 */
function parseJsonObject(text) {
  if (typeof text !== 'string') return undefined
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, i + 1))
          return parsed !== null && typeof parsed === 'object' ? parsed : undefined
        }
        catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

//#endregion

//#region 判定与混合

/**
 * 归一化一次判定结果：强度落在 [0,1]，情绪标签**原样保留**。
 *
 * 2026-10-10 修正（重要）：旧实现把「不在词表里」的标签一律改写成「平静」，
 * 结果是模型判出「愤怒 0.78」「怜惜 0.62」之后，落库变成「平静 0.78」「平静 0.62」——
 * 标签层的信息被抹掉，反而给出一个语义相反的中性标签，面板上看起来像「模型永远是平静的」。
 * 现在词表外的标签只打 `outOfList: true` 标记、不做改写；词表的作用退回为
 * 「提示词里优先选项」+「关键词规则的合法标签集合」。
 * @returns {{ emotion: string, intensity: number, reason: string, source: string, outOfList?: true } | undefined}
 */
function normalizeJudgement(raw, allowed, source) {
  if (raw === undefined || raw === null) return undefined
  const record = typeof raw === 'object' ? raw : { emotion: raw }
  const label = str(record.emotion) ?? str(record.label) ?? str(record.name)
  if (label === undefined) return undefined
  const emotion = label.trim()
  if (emotion === '') return undefined
  const outOfList = allowed !== undefined && allowed.size > 0 && !allowed.has(emotion)
  const intensity = record.intensity === undefined ? 0.5 : clamp01(record.intensity)
  const reason = (str(record.reason) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const judgement = { emotion, intensity, reason, source }
  return outOfList ? { ...judgement, outOfList: true } : judgement
}

/** 默认的否定/反向修饰词：命中词周围出现它们时，认为这次命中不算数。 */
export const DEFAULT_NEGATIONS = ['不', '没', '无', '非', '避免', '规避', '降低', '减少', '最低', '较低', '可控']

/**
 * 判断某个命中是否被否定或反向修饰。
 * 例：「不确定」里的「确定」、「风险最低」里的「风险」、「风险可控」里的「风险」。
 * 只看向左右很小的窗口，避免把整句的否定误伤到无关命中。
 */
function isNegatedHit(text, index, length, negations) {
  if (!Array.isArray(negations) || negations.length === 0) return false
  const before = text.slice(Math.max(0, index - 2), index)
  const after = text.slice(index + length, index + length + 4)
  const window = before + after
  for (const word of negations) {
    if (typeof word === 'string' && word !== '' && window.includes(word)) return true
  }
  return false
}

/** 关键词规则匹配：所有命中里取强度最高的一条；被否定的命中跳过。 */
function classifyByRules(text, rules, allowed, negations) {
  if (typeof text !== 'string' || text === '') return undefined
  let best
  for (const rule of rules ?? []) {
    const label = str(rule?.emotion)
    if (label === undefined || label === '') continue
    if (allowed !== undefined && allowed.size > 0 && !allowed.has(label)) continue
    const patterns = Array.isArray(rule.patterns) ? rule.patterns : []
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || pattern === '') continue
      const at = text.indexOf(pattern)
      if (at === -1) continue
      if (isNegatedHit(text, at, pattern.length, negations)) continue
      const intensity = rule.intensity === undefined ? 0.5 : clamp01(rule.intensity)
      if (best === undefined || intensity > best.intensity) {
        best = { emotion: label, intensity, reason: `关键词「${pattern}」`, source: 'rule' }
      }
    }
  }
  return best
}

/** 指数衰减：factor 每回合一次 / 每半衰期一次。 */
function decay(value, factor, steps) {
  if (!(steps > 0)) return value
  return value * Math.pow(factor, steps)
}

/**
 * 读取状态快照。
 *
 * 【已停用】情绪强度随闲置时间衰减的模块（`0.5^(闲置分钟 / halfLifeMinutes)`）已被注释掉：
 * 现在读取快照时**不再按时间衰减**，强度只由回合维度的融合规则（`blend()`）决定。
 * 原实现（保留备查）：
 *
 *   const minutes = Math.max(0, (now - state.updatedAt) / 60000)
 *   const halfLife = config.halfLifeMinutes > 0 ? config.halfLifeMinutes : 10
 *   const factor = Math.pow(0.5, minutes / halfLife)
 *   return { ...state, intensity: clamp01(state.intensity * factor), decayed: factor < 0.999, factor }
 *
 * 恢复方式：把上面四行放回下面的实现里、删掉 `const factor = 1` 即可。
 * 注意 `config.halfLifeMinutes` 仍保留在 Config 里（避免既有补丁里的该字段报错），但已不生效。
 */
function rehydrate(state, config, now = Date.now()) {
  if (state === undefined) return undefined
  // —— 闲置时间衰减：已停用（见上方注释），factor 恒为 1 ——
  const factor = 1
  return {
    ...state,
    intensity: clamp01(state.intensity * factor),
    decayed: factor < 0.999,
    factor,
  }
}

/**
 * 把一次新判定并入现有状态：**融合而不是替换**。
 * - 旧状态先按回合数衰减（`turnDecay`）；
 * - 同一情绪 → 取 `max(衰减后的旧值, 新值)`，避免越判越弱；
 * - 不同情绪 → 新情绪接管，强度取 `max(衰减后的旧值 × takeoverRetain, 新值)`，
 *   避免一次低强度的新情绪把强烈状态抹平。
 */
function blend(previous, judgement, config) {
  const elapsedTurns = previous === undefined ? 0 : Math.max(0, (config._turn ?? 0) - (previous.turn ?? 0))
  const carried = previous === undefined ? 0 : clamp01(decay(previous.intensity, config.turnDecay, elapsedTurns))
  const incoming = clamp01(judgement.intensity)
  // 首次判定没有「旧情绪被顶掉」这回事：它就是本会话的第一条状态，记成 same（非接管），
  // 否则面板会把第一次判定标成「情绪接管」，`取 max(旧, 新)` 的描述也成了空话。
  if (previous === undefined || previous.emotion === judgement.emotion) {
    const intensity = Math.max(carried, incoming)
    // `incoming` 一并返回：面板要显示「本回合判定原值 vs 融合后」，之前只有 carried，
    // 客户端只能拿 host 当前强度去除以回注值，算出来的比值是错的（问题①的根）。
    return { emotion: judgement.emotion, intensity, carried, incoming, ratio: incoming > 0.001 ? intensity / incoming : undefined, changed: previous === undefined || Math.abs(intensity - previous.intensity) > 1e-6, same: true }
  }
  const sticky = previous === undefined ? 0 : carried * clamp01(config.takeoverRetain)
  const intensity = Math.max(sticky, incoming)
  return { emotion: judgement.emotion, intensity, carried, incoming, ratio: incoming > 0.001 ? intensity / incoming : undefined, changed: true, same: false }
}

//#endregion

//#region 回注文案

/** 渲染回注消息正文。 */
function renderInjection(judgement, config) {
  const reason = judgement.reason
  const reasonPart = config.includeReason && reason !== '' ? `判定依据：${reason}。` : ''
  return config.template
    .replaceAll('{emotion}', judgement.emotion)
    .replaceAll('{intensity}', intensityText(judgement.intensity))
    .replaceAll('{reason_part}', reasonPart)
    .replaceAll('{reason}', reason)
}

//#endregion

//#region 配置

export const Config = z.object({
  /** 紧急总开关：设为 true 可立刻停用全部行为（优先级高于 `enabled`），无需卸载插件。 */
  disabled: z.boolean().default(false),
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 是否把情绪状态回注给工作模型。 */
  inject: z.boolean().default(true),
  /** 同一个回合内的后续步骤是否也允许回注（默认只在回合起手时注入一次）。 */
  injectPerStep: z.boolean().default(false),
  /** 低于该强度就不回注（避免打扰）。 */
  minIntensity: z.number().min(0).max(1).default(0.2),
  /** 判定器的 provider；留空则用当前会话默认模型。 */
  judgeProvider: z.string().default(''),
  /** 判定器的 model；留空则用当前会话默认模型。 */
  judgeModel: z.string().default(''),
  /** 是否允许 LLM 判定（关键词没命中时才触发）。 */
  useLlm: z.boolean().default(true),
  /** 单次判定调用的超时（毫秒）。超时后本回合保持原状态。 */
  timeoutMs: z.number().min(100).default(6000),
  /** 判定调用失败时是否在宿主日志里打印原因。 */
  logErrors: z.boolean().default(true),
  /** 每回合的情绪衰减系数。 */
  turnDecay: z.number().min(0).max(1).default(0.9),
  /**
   * 闲置多久（分钟）强度减半。
   * 随闲置时间衰减的模块已停用（见 `rehydrate()` 的注释），该字段保留仅为兼容既有补丁，不再生效。
   */
  halfLifeMinutes: z.number().min(0.1).default(10),
  /** 情绪切换时旧强度保留比例。 */
  takeoverRetain: z.number().min(0).max(1).default(0.35),
  /** 每个会话最多保留多少条历史。 */
  historyLimit: z.number().min(0).default(24),
  /** 允许的情绪词表。 */
  emotions: z.array(z.string()).default([...DEFAULT_EMOTIONS]),
  /** 关键词规则；命中即无需模型调用。 */
  rules: z.array(z.object({
    emotion: z.string(),
    intensity: z.number().min(0).max(1).default(0.5),
    patterns: z.array(z.string()).default([]),
  })).default(DEFAULT_RULES.map((rule) => ({ ...rule, patterns: [...rule.patterns] }))),
  /** 判定提示词。 */
  prompt: z.string().default(DEFAULT_PROMPT),
  /**
   * 否定/反向修饰词：关键词命中处的前后小窗口里出现这些词时，该命中跳过。
   * 用于挡住「不确定」「风险最低」「风险可控」这类反向命中。
   * 想完全关掉这个保护，把数组设成空即可。
   */
  negations: z.array(z.string()).default([...DEFAULT_NEGATIONS]),
  /** 回注文案模板，支持 {emotion} / {intensity} / {reason_part} / {reason}。 */
  template: z.string().default(DEFAULT_TEMPLATE),
  /** 回注时是否带上判定依据。 */
  includeReason: z.boolean().default(false),
  /**
   * 【已弃用，保号兼容】原意是「把每次判定写入会话日志的自定义事件供面板读取」。
   * 2026-10-11 起**不再写**：见 appendPanelEvent 上方的说明（写自定义事件类型会让
   * 整个会话日志无法重新打开）。取值仍被接受，只是不再产生写入。
   */
  panelEvent: z.boolean().default(true),
  /**
   * 是否挂载 GUI 面板读取状态的只读 HTTP 路由（`GET /emotion-feedback/state`）。
   * 关掉后浏览器面板显示「接口未挂载」，插件其余功能不受影响。
   */
  panelRoute: z.boolean().default(true),
  /**
   * 是否把面板的**每轮明细**（判定原值 / 融合结果 / 依据 / 来源 / 回合号）落盘到
   * `<DSH_HOME>/emotion-feedback/history/<会话id>.json`。
   *
   * 落盘的意义：判定依据既不在会话日志里（判定用的 LLM 调用不落日志），
   * 也不在回注正文里（`includeReason` 默认 false），只活在进程内存 ——
   * DSH 一重启，面板就只剩「情绪/强度/时间」。落盘后重启仍能看到历史回合的依据。
   * 关掉它就退回纯内存（面板在重启后只显示会话节点里的信息）。
   */
  persistHistory: z.boolean().default(true),
  /**
   * 是否注册只读工具 `emotion_status`，让工作模型自己能查当前情绪状态。
   * 工具是只读的：情绪只能通过对话（批评/夸奖/任务结果）自然变化，
   * 模型无法用它改写状态，因此不会成为「情绪作弊」通道。
   */
  statusTool: z.boolean().default(true),
  /** 打印判定与回注细节，便于核对。 */
  debug: z.boolean().default(false),
})

//#endregion

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 * @param {{ defineTool?: Function }} [deps] 测试注入口；真实宿主不传，
 *   插件会惰性 `import('@deepseek-ai/dsh-tools')` 自行解析。
 */
export function apply(ctx, config, deps) {
  const logger = resolveLogger(ctx)
  const allowed = new Set((config.emotions ?? []).map((item) => String(item)))
  /**
   * 判定用的 system 提示词 = 用户配置的 `prompt` + 当前词表。
   * 词表必须出现在提示词里：否则模型会自由发挥（「愤怒」「怜惜」「委屈」…），
   * 而这些标签从前会被改写成「平静」，把强情绪显示成中性——2026-10-10 已修。
   */
  const judgeSystemPrompt = () => {
    const list = [...allowed].join('、')
    if (list === '') return config.prompt
    return `${config.prompt}\n\n可选情绪（系统消息里没有对应词时，可以自己给一个 2-4 字的中文情绪词）：${list}`
  }
  /** sessionId → 情绪状态；随会话销毁清理。 */
  const states = new Map()
  /** sessionId → 已经收到过当前状态回注的回合号（按会话隔离）。 */
  const injectedTurns = new Map()

  /**
   * sessionId → 最近一次**真的**回注出去的内容（回合号 + 判定回合 + 情绪 + 强度）。
   * `injectionPlan.changedSinceLastInjection` 靠它判断「相对上次回注有没有变化」——
   * 必须和**同一回合的同一内容**比，否则刚注入完就会误报「有变化」。
   */
  const lastInjected = new Map()
  /** sessionId → 正在判定中的回合号（避免同一回合重复判定）。 */
  const judgingTurns = new Map()
  /** sessionId → 供面板显示用的会话描述（工作目录等）。 */
  const sessionMeta = new Map()
  /**
   * sessionId → 面板曲线采样点（按时间升序）。
   * Host 侧保留，经 HTTP 路由 `/emotion-feedback/state` 交给浏览器面板；
   * 之所以不走会话日志：`agent/pre-step` 追加的合成消息**不落盘**（只在出站请求里），
   * 而浏览器半边既没有 `host.call`，也读不到会话事件流。
   */
  const panelHistory = new Map()
  /** 需要插件自己回收的 disposer（工具注册等不随 fiber 自动回收的资源）。 */
  const disposes = []
  let disposed = false

  const debug = (...args) => {
    if (!config.debug) return
    const sink = typeof logger?.debug === 'function' ? logger.debug : logger?.info
    if (typeof sink === 'function') sink.call(logger, '[emotion-feedback]', ...args)
    else console.log('[emotion-feedback]', ...args)
  }
  const warn = (message, error) => {
    if (!config.logErrors) return
    const detail = error === undefined ? '' : `\n${formatThrown(error)}`
    if (typeof logger?.warn === 'function') logger.warn(`[emotion-feedback] ${message}${detail}`)
    else console.warn(`[emotion-feedback] ${message}${detail}`)
  }
  /** 与 `warn()` 同义，语义上强调「这里有真实异常」，便于 grep。 */
  const warnError = warn
  /** 紧急开关：`disabled` 优先于 `enabled`，可在补丁里立刻停用而不必卸载插件。 */
  const enabledNow = () => config.disabled !== true && config.enabled !== false
  /** 生成消息 id；宿主没有全局 crypto 时退化为时间戳 + 随机数。 */
  const randomId = () => {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    }
    catch { /* 落到下面的兜底 */ }
    return `emotion-feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /** 当前状态下、供注入使用的一条判定快照。 */
  const currentJudgement = (sessionId, now = Date.now()) => {
    const state = states.get(sessionId)
    if (state === undefined) return undefined
    const live = rehydrate(state, config, now)
    if (live === undefined) return undefined
    return { emotion: live.emotion, intensity: live.intensity, reason: live.reason ?? '', source: live.source ?? 'unknown' }
  }

  /** 解析判定用的 provider / model。 */
  const resolveJudgeTarget = async (agent) => {
    if (str(config.judgeProvider) && str(config.judgeModel)) {
      return { provider: config.judgeProvider.trim(), model: config.judgeModel.trim() }
    }
    const explicitProvider = str(agent?.options?.provider)
    const explicitModel = str(agent?.options?.model)
    if (explicitProvider !== undefined && explicitModel !== undefined) {
      return { provider: explicitProvider, model: explicitModel }
    }
    const header = agent?.session?.requestHeader?.()?.config
    const headerProvider = str(header?.provider)
    const headerModel = str(header?.model)
    if (headerProvider !== undefined && headerModel !== undefined) {
      return { provider: headerProvider, model: headerModel }
    }
    const service = ctx.get('agentDefaultModel', false)
    if (typeof service?.currentSelection === 'function') {
      // currentSelection 在当前运行时是同步的；这里兼容 Promise 形式的实现。
      const selection = await service.currentSelection()
      const provider = str(selection?.provider)
      const model = str(selection?.model)
      if (provider !== undefined && model !== undefined) return { provider, model }
    }
    return undefined
  }

  /** 一次轻量判定调用，只取文本增量。 */
  const callJudgeLlm = async (llm, target, text, signal) => {
    const user = [
      'PROTOCOL: EMOTION_TONE_JUDGE v1',
      'TASK: 对下面的 ASSISTANT_OUTPUT 判定情绪，并只输出题目要求的 JSON。',
      'ASSISTANT_OUTPUT_BEGIN',
      text,
      'ASSISTANT_OUTPUT_END',
      'TASK_REMINDER: 只输出 JSON 对象。',
    ].join('\n')
    let buffer = ''
    let failure
    const stream = llm.stream({
      provider: target.provider,
      model: target.model,
      system: judgeSystemPrompt(),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0,
      maxTokens: 256,
      signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') buffer += chunk.text
      else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') failure = chunk.reason?.failure ?? { kind }
      }
    }
    if (failure !== undefined) {
      const detail = typeof failure?.message === 'string' ? failure.message : JSON.stringify(failure)
      throw new Error(`判定流以 ${failure?.kind ?? 'error'} 结束：${detail}`)
    }
    return buffer
  }

  /** 完整判定：关键词优先，必要时一次 LLM 调用。 */
  const classify = async (agent, text, signal) => {
    const rule = classifyByRules(text, config.rules, allowed, config.negations)
    if (rule !== undefined) return rule
    if (!config.useLlm) return undefined
    const llm = ctx.get('llm', false)
    if (llm === undefined || typeof llm.stream !== 'function') return undefined
    let target
    try {
      target = await resolveJudgeTarget(agent)
    }
    catch (error) {
      warn('无法解析判定模型', error)
      return undefined
    }
    if (target === undefined) {
      debug('没有可用的判定模型，本回合只走关键词层')
      return undefined
    }
    const timeout = AbortSignal.timeout(Math.max(100, config.timeoutMs))
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let raw
    try {
      raw = await callJudgeLlm(llm, target, text, composed)
    }
    catch (error) {
      warn(`判定调用失败（${target.provider}/${target.model}）`, error)
      return undefined
    }
    const parsed = normalizeJudgement(parseJsonObject(raw), allowed, 'llm')
    if (parsed === undefined) {
      debug('判定输出无法解析', raw.slice(0, 200))
      return undefined
    }
    return parsed
  }

  /**
   * 面板展示用的「本回合判定明细」。这里是唯一能同时拿到判定原值与融合结果的地方，
   * 所以由 commit() 生成一次、随状态留存（`state.lastJudged`），回合收尾与快照都只序列化它——
   * 谁也不必再各自重列一遍字段（上一版就是各处重列，`judgedEmotion` 漏了一次，面板显示不出来）。
   */
  const lastJudgedDetail = (state, judgement) => ({
    turn: state.turn,
    updatedAt: state.updatedAt,
    judgedEmotion: judgement.emotion,
    judgedIntensity: judgement.intensity,
    emotion: state.emotion,
    intensity: state.intensity,
    reason: typeof judgement.reason === 'string' ? judgement.reason.slice(0, 240) : '',
    source: judgement.source ?? 'unknown',
    outOfList: judgement.outOfList === true,
  })

  /** 写入一次判定结果。 */
  const commit = (sessionId, judgement, turn, now) => {
    const previous = states.get(sessionId)
    const merged = blend(previous, judgement, { turnDecay: config.turnDecay, takeoverRetain: config.takeoverRetain, _turn: turn })
    const history = Array.isArray(previous?.history) ? [...previous.history] : []
    if (history.length === 0 || history[history.length - 1].turn !== turn) {
      history.push({ turn, emotion: judgement.emotion, intensity: merged.intensity })
    }
    else {
      history[history.length - 1] = { turn, emotion: judgement.emotion, intensity: merged.intensity }
    }
    const limit = Math.max(0, Math.floor(config.historyLimit))
    while (history.length > limit) history.shift()
    const next = {
      emotion: merged.emotion,
      intensity: merged.intensity,
      reason: judgement.reason,
      source: judgement.source,
      turn,
      updatedAt: now,
      history,
    }
    // 词表外标签的标记要一路带到状态里，面板/工具才能把「模型自造的标签」与词表内的区分开。
    if (judgement.outOfList === true) next.outOfList = true
    // 本回合判定的**原值 + 融合结果 + 依据**一起随状态留存：融合后 `emotion` 可能不是本次判定的
    // 标签（不同情绪时由新标签接管，强度却可能被旧状态抬高），面板要同时显示「模型这一轮判了什么」
    // 与「融合后生效的是什么」——出了 commit 就再也算不回来了（问题①的数据根因）。
    next.lastJudged = lastJudgedDetail(next, judgement)
    states.set(sessionId, next)
    return { state: next, merged }
  }

  /**
   * 把「回合 `turn` 开头真实回注了哪一条判定」写进面板采样。
   * 同一回合后续 step 若状态有变会再回注一次，`injectedInto` 保留最早的那次
   * （用户第一次在界面上看到该状态，就是那次）。
   */
  const recordInjection = (sessionId, turn) => {
    if (typeof turn !== 'number') return
    const series = panelHistory.get(sessionId)
    const last = Array.isArray(series) && series.length > 0 ? series[series.length - 1] : undefined
    if (last !== undefined && last !== null && typeof last === 'object' && typeof last.injectedInto !== 'number') {
      last.injectedInto = turn
      // 生效回合也要落盘：面板靠它把「T{n} 判定 → T{m} 生效」写对，重启后同样要能对上。
      persistHistory(sessionId)
    }
    // 真回注记录：面板「相对上次回注有没有变化」以它为准——采样列表可能为空、
    // 也可能因为进程重启而带着旧字段，只有这里是「刚刚真的注入了什么」的权威答案。
    const state = states.get(sessionId)
    if (state !== undefined && state.lastJudged !== undefined && state.lastJudged !== null) {
      lastInjected.set(sessionId, {
        turn,
        judgedTurn: state.lastJudged.turn,
        emotion: state.lastJudged.emotion,
        intensity: state.lastJudged.intensity,
      })
    }
  }

  /**
   * 面板「相对上次回注有没有变化」。
   * 比较对象是**同一回合**的那次回注：同回合内容一致 ⇒ false（否则刚注入完就报「有变化」）。
   */
  const changedSinceLastInjection = (sessionId, detail) => {
    const previous = lastInjected.get(sessionId)
    if (previous === undefined) return true
    if (previous.judgedTurn !== detail.turn) return true
    return Math.abs((previous.intensity ?? 0) - detail.intensity) > 1e-6 || previous.emotion !== detail.emotion
  }

  /** 采样里回注后补写回合号：与 lastInjected 同源，供 UI 显示「T{n} 判定 → T{m} 生效」。 */
  const injectedIntoTurn = (sessionId, judgedTurn) => {
    const previous = lastInjected.get(sessionId)
    if (previous === undefined) return undefined
    return previous.judgedTurn === judgedTurn ? previous.turn : undefined
  }

  /**
   * 「下一回合开头将要回注什么」。
   * 与 `samples` 末条对照即可看出：末条是**已生效**的状态，这里是**待生效**的状态。
   * 面板把两者分开显示，就不会再出现「把上一轮的情绪当成这一轮」的错位。
   */
  const injectionPlan = (sessionId, live, now) => {
    const judgement = currentJudgement(sessionId, now)
    if (judgement === undefined) return undefined
    const fresh = now - live.updatedAt < PANEL_FRESH_MS
    // 「相对上次回注有没有变化」= 与**上一次真回注出去的那份内容**比（同回合比同一内容）。
    const detail = live.lastJudged ?? { turn: live.turn, emotion: live.emotion, intensity: live.intensity }
    return {
      emotion: judgement.emotion,
      intensity: judgement.intensity,
      reason: judgement.reason ?? '',
      source: judgement.source ?? 'unknown',
      outOfList: judgement.outOfList === true,
      judgedTurn: typeof live.turn === 'number' ? live.turn : undefined,
      // 还没发出：下一条出站请求一定会带上它（宿主在 pre-step 里读的是同一份状态）。
      pending: fresh,
      changedSinceLastInjection: changedSinceLastInjection(sessionId, detail),
      lastInjected: lastInjected.get(sessionId),
      willInjectAt: typeof live.turn === 'number' ? live.turn + 1 : undefined,
    }
  }

  /**
   * 面板读数：按「最近更新」排序的全部会话状态。
   * 这是 GUI 面板在 Host 侧的**唯一数据源**，客户端只读不改。
   * 一律不抛异常：面板是纯附加功能，绝不能影响回合。
   * @returns {{ generatedAt: string, sessions: Array<object> }}
   */
  const snapshotAll = () => {
    const now = Date.now()
    const sessions = []
    try {
      for (const [sessionId, state] of states) {
        const live = rehydrate(state, config, now)
        if (live === undefined) continue
        const meta = sessionMeta.get(sessionId)
        // 采样里的 injectedInto 以 lastInjected 为准补写：进程重启前的采样没有这个字段，
        // 但它一旦真的回注过，lastInjected 里就有权威答案。
        const samples = (panelHistory.get(sessionId) ?? []).map((sample, index, all) => ({
          ...sample,
          // 最后一个采样点就是「下一次出站请求将要回注的状态」。
          willInject: index === all.length - 1 && now - live.updatedAt < PANEL_FRESH_MS,
          injectedInto: typeof sample.injectedInto === 'number'
            ? sample.injectedInto
            : injectedIntoTurn(sessionId, sample.turn),
        }))
        // 回注计划与采样分开给出：客户端可以明确区分
        // 「上一回合判定的结果（samples 末条，已生效）」和「下一回合将要回注的状态（injectionPlan）」。
        const planned = injectionPlan(sessionId, live, now)
        sessions.push({
          sessionId,
          workspace: meta?.workspace,
          emotion: live.emotion,
          intensity: live.intensity,
          reason: live.reason ?? '',
          source: live.source ?? 'unknown',
          outOfList: live.outOfList === true,
          turn: live.turn,
          updatedAt: new Date(live.updatedAt).toISOString(),
          ageMs: Math.max(0, now - live.updatedAt),
          history: (Array.isArray(live.history) ? live.history : []).map((item) => ({ ...item })),
          samples,
          injectionPlan: planned,
        })
      }
      sessions.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
    }
    catch (error) {
      warn('面板快照构建失败', error)
    }
    return {
      generatedAt: new Date(now).toISOString(),
      config: {
        disabled: config.disabled === true,
        enabled: config.enabled !== false,
        inject: config.inject !== false,
        injectPerStep: config.injectPerStep === true,
        minIntensity: config.minIntensity,
        turnDecay: config.turnDecay,
        takeoverRetain: config.takeoverRetain,
        useLlm: config.useLlm !== false,
        historyLimit: config.historyLimit,
        persistHistory: config.persistHistory !== false,
      },
      sessions,
    }
  }

  /**
   * 已确认会「毒死」会话日志的类型黑名单（每个都真实发生过，见下方长注释与 README 故障 C）。
   * `guardedAppend` 见到它们一律拒绝，不给出任何例外。
   */
  const FORBIDDEN_SESSION_EVENT_TYPES = new Set(['emotion-feedback/state'])

  /** harness 已知事件类型快照的缓存（`undefined` = 还没读过；空集合 = 读不到）。 */
  let knownTypesCache

  /** 只在测试里注入；返回 `undefined` 表示「没有注入，去磁盘找」。 */
  let knownTypesSource

  /** 测试用：注入/清除已知类型快照来源。 */
  const setKnownTypesSourceForTest = (value) => {
    knownTypesSource = value
    knownTypesCache = undefined
  }

  /**
   * 读 harness 的已知会话事件类型快照（`_diag\known-event-types.json`，
   * 由 `_diag\known-event-types.mjs` 从 app.asar 抽取）。
   * 找不到任何一份可用快照时返回**空集合** ⇒ `guardedAppend` 保守拒绝所有写入。
   */
  const knownSessionEventTypes = () => {
    if (knownTypesCache !== undefined) return knownTypesCache
    // 注入优先：来源可以是 Set / 数组（直接当快照）、文件路径字符串，或返回它们的函数。
    // 注入的东西**给不出**可用快照（坏类型 / 坏路径 / 函数返回 undefined）⇒ 直接判「读不到」，不回落磁盘。
    const pushCandidate = (value) => {
      if (value instanceof Set) return { set: value }
      if (Array.isArray(value)) return { set: new Set(value) }
      if (typeof value === 'string' && value !== '') candidates.push(value)
      return undefined
    }
    const candidates = []
    if (knownTypesSource !== undefined) {
      const injected = pushCandidate(typeof knownTypesSource === 'function' ? knownTypesSource() : knownTypesSource)
      if (injected !== undefined) {
        knownTypesCache = injected.set
        return knownTypesCache
      }
      // 2026-10-11：注入了却给不出可用快照（空对象 / 坏类型 / 不存在的路径）⇒ 直接判「读不到」，
      // **绝不回落到磁盘**。否则测试里 `{}` 会被静默忽略、改用本机快照，
      // 「快照缺失时保守全拒」这条用例就变成假绿。
      // 测试里注入 `undefined` 仍表示「没注入，去磁盘找」。
      warn('注入的已知类型快照不可用 ⇒ 本插件不再写入任何会话事件')
      knownTypesCache = new Set()
      return knownTypesCache
    }
    const found = discoverKnownTypesFromDisk()
    if (found !== null) {
      knownTypesCache = found
      return knownTypesCache
    }
    warn('读不到 harness 已知事件类型快照（_diag\\known-event-types.json）⇒ 本插件不再写入任何会话事件')
    knownTypesCache = new Set()
    return knownTypesCache
  }

  /**
   * 按**真实相对布局**去找 `_diag\known-event-types.json`。
   * `null` = 没找到 / 都不合法（调用方据此判「读不到」并保守拒绝）。
   *
   * 逐级向上找。深度按实际布局定：
   *   生产布局：`profiles\desktop\node_modules\dsh-emotion-feedback` 是 Junction →
   *   `dsh-work\bigfish's\emotions`，插件文件在 `…\emotions\lib`，
   *   而快照在 `dsh-work\_diag\` —— 即 `lib` 的上**四**级。
   *   搜索深度曾经只到三级，导致生产环境**永远**读不到快照 ⇒ 静默全拒（2026-10-11 修）。
   *   对应的回归用例：crash-scenarios.mjs ⑮（布局深度）/ ⑯（坏注入不得回落磁盘）。
   *
   * 参数 `from` 只给测试用：传一个自建的**同深度**目录树，就能在没有开发机 `_diag`
   * 的机器上（打包分发后）照样验证发现链；省略时仍按本文件所在目录去找。
   */
  const discoverKnownTypesFromDisk = (from) => {
    const here = typeof from === 'string' && from !== '' ? from : dirname(fileURLToPath(import.meta.url))
    const candidates = []
    const bases = [here, join(here, '..'), join(here, '..', '..'), join(here, '..', '..', '..')]
    for (const base of bases) {
      candidates.push(join(base, '_diag', 'known-event-types.json'))
      try {
        for (const entry of readdirSync(base)) {
          if (entry.startsWith('_') || entry.startsWith('.')) candidates.push(join(base, entry, '_diag', 'known-event-types.json'))
        }
      }
      catch { /* 目录不可读就跳过 */ }
    }
    for (const file of candidates) {
      if (typeof file !== 'string' || file === '') continue
      try {
        if (!existsSync(file)) continue
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(parsed?.types) && parsed.types.length > 20) return new Set(parsed.types)
      }
      catch { /* 坏快照就试下一份 */ }
    }
    return null
  }

  /**
   * 面板事件的写入点。**2026-10-11 起停用（代码注释保留，随时可读原实现）。**
   *
   * 为什么绝对不能写：宿主读日志时逐条跑 `dsh-session` 的 `validateStoredEvents`，
   *   `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw SessionFormatUnsupportedError`
   * —— 未知类型的事件只要**没有** `ignorable: true` 标记，**整个会话日志就被拒绝解释**，
   * GUI 表现为「历史加载失败 / resume failed … unknown to this harness and not marked ignorable」。
   * 而写路径不可能补上这个标记：`Session.append(type, data, ...opts)` 只认
   * `opts[0].sourceEventSeqs / surfaceOp`；asar 内插件开发指南原文：
   *   “Do not append session events with a new `type`. … live `Session.append()` cannot set that
   *    marker, so the Session would refuse to reopen.”
   * 现场代价：`C:\Users\Lenovo\.dsh\sessions` 下 33 个日志里 12 个被这种事件污染（最早 10-10 10:45），
   * 包括用户报告打不开的 emotions / testfish 会话；已由 `repairs\fix-unknown-session-events.mjs`
   * 逐行补标记救回（见 `repairs\README.md` 故障 C）。
   *
   * 这个事件也没有读者，停写不损失功能：
   *   - 面板主路径读的是**回注消息**（`source.kind === 'emotion-feedback'`，属已知类型 user/message）；
   *   - 可选路径是 HTTP `GET /emotion-feedback/state`（见 installPanelRoute）；
   *   - 曲线本身有内存里的 panelHistory。
   * 若将来确实需要持久化插件状态，请改用宿主提供的 storage 服务，不要再写会话事件类型。
   */
  const appendPanelEvent = (session, state, turn) => {
    if (config.panelEvent === false || config.disabled === true) return
    if (session === undefined || session === null || typeof session.append !== 'function') return
    // ——— 原实现，已停用（现在由 guardedAppend 在写入前拦住）———
    // guardedAppend(session, 'emotion-feedback/state', {
    //   turn: typeof turn === 'number' ? turn : 0,
    //   emotion: state.emotion,
    //   intensity: state.intensity,
    //   reason: state.reason ?? '',
    //   source: state.source ?? 'unknown',
    //   updatedAt: state.updatedAt,
    // })
    debug('面板事件不再写入会话日志（emotion-feedback/state 会让日志无法重新打开）')
  }

  /** 插件使用过的会话事件类型。全部在 `FORBIDDEN_SESSION_EVENT_TYPES` 里 ⇒ 一个都不能写。 */

  /**
   * 【硬性契约｜2026-10-11 加固】**任何**会话事件写入都必须走 `guardedAppend`。
   *
   * 三条防线：
   *   1. 类型黑名单：这些类型已被写进过真实日志，每一次都让那个日志永久打不开；
   *      它们是插件的自定义类型，**没有任何合法写入场景**，所以在这里硬拒。
   *   2. 宿主白名单校验：从 harness 的 `KNOWN_SESSION_EVENT_TYPES` 快照
   *      （`_diag\known-event-types.json`）里查类型；查不到就拒写。
   *   3. 快照缺失时保守拒绝：宁可少写一条事件，也不能再让某个会话打不开。
   *
   * 这样做的原因见上面的长注释：写路径 `Session.append()` 无法设置 `ignorable`，
   * 所以只要写了一个白名单外的类型，宿主下次读日志就会拒绝解释**整个文件**
   * （`dsh-session-persistence\lib\index.js:184`）。
   * 例外：类型命中快照、且显式带 `{ ignorable: true }` 时才放行（这是契约允许的写法）。
   *
   * @param {object} session 宿主会话对象；没有 append 就静默跳过。
   * @param {string} type 会话事件类型。
   * @param {object} data 事件载荷。
   * @param {...unknown} rest 原样转交给 `session.append` 的其余参数。
   * @returns {boolean} 是否真的写入了。
   */
  const guardedAppend = (session, type, data, ...rest) => {
    try {
      if (session === undefined || session === null || typeof session.append !== 'function') return false
      if (typeof type !== 'string' || type === '') {
        warn('拒绝写入会话事件：类型不是非空字符串')
        return false
      }
      if (FORBIDDEN_SESSION_EVENT_TYPES.has(type)) {
        warnError(
          `拒绝写入会话事件「${type}」：该类型不在 harness 白名单里，且 Session.append() 无法设置 ignorable，` +
          '写进去会让整个会话日志无法重新打开（详见本函数上方注释）',
        )
        return false
      }
      const marker = Array.isArray(rest) && rest.length > 0 && rest[0] !== null && typeof rest[0] === 'object'
        ? rest[0].ignorable
        : undefined
      if (marker === true) {
        session.append(type, data, ...rest)
        return true
      }
      if (!knownSessionEventTypes().has(type)) {
        warnError(
          `拒绝写入会话事件「${type}」：不在 harness 已知事件类型快照里（白名单外的类型必须带 { ignorable: true }）`,
        )
        return false
      }
      session.append(type, data, ...rest)
      return true
    }
    catch (error) {
      warn('写入会话事件失败（已吞掉，不影响回合）', error)
      return false
    }
  }

  //#region 每轮明细落盘（重启后面板仍能看到历史回合的判定依据）

  /** 测试注入的落盘目录；真实运行时为 undefined（用 DSH_HOME 推导）。 */
  let historyDirOverride
  /** 只给测试用：把落盘目录指到临时目录，避免污染真实 DSH_HOME。传 undefined 恢复正常推导。 */
  const setHistoryDirForTest = (dir) => {
    historyDirOverride = typeof dir === 'string' && dir !== '' ? dir : undefined
  }

  /**
   * 落盘目录 = `<DSH_HOME>/emotion-feedback/history`。
   * 取不到 DSH_HOME（以及 HOME/USERPROFILE）时返回 undefined ⇒ 该功能整体降级为纯内存，
   * 只留一行 debug，不影响判定与回注。
   */
  const historyDir = () => {
    if (typeof historyDirOverride === 'string') return historyDirOverride
    const home = process.env.DSH_HOME ?? process.env.HOME ?? process.env.USERPROFILE
    if (typeof home !== 'string' || home.trim() === '') return undefined
    return join(home, ...PANEL_HISTORY_DIRNAME.split('/'))
  }

  /** 会话 id 可能带路径分隔符等字符，落盘前一律洗成安全文件名。 */
  const historyFileFor = (sessionId) => {
    const dir = historyDir()
    if (dir === undefined) return undefined
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
    if (safe === '') return undefined
    return join(dir, `${safe}.json`)
  }

  /**
   * 读回某个会话的落盘明细。任何异常/格式不符/超过保留期都当作「没有存档」返回 undefined：
   * 面板是附加功能，读到坏文件也只能少显示几行，绝不能影响回合。
   */
  const readPersistedHistory = (sessionId) => {
    try {
      const file = historyFileFor(sessionId)
      if (file === undefined || !existsSync(file)) return undefined
      const stat = statSync(file)
      if (Date.now() - stat.mtimeMs > PANEL_HISTORY_TTL_MS) {
        debug(`面板历史已过期（>${Math.round(PANEL_HISTORY_TTL_MS / 86400000)} 天），忽略 ${file}`)
        return undefined
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return undefined
      if (parsed.version !== PANEL_HISTORY_FILE_VERSION) return undefined
      if (parsed.sessionId !== String(sessionId)) return undefined
      if (!Array.isArray(parsed.records)) return undefined
      const records = parsed.records.filter((item) => item !== null && typeof item === 'object' && typeof item.turn === 'number')
      return records.length > 0 ? records : undefined
    }
    catch (error) {
      warn('读取面板历史存档失败（当作没有存档）', error)
      return undefined
    }
  }

  /**
   * 把当前会话的明细写盘（原子替换：先写 `.tmp` 再 rename，面板绝不会读到半截文件）。
   * 只在内存里真有明细时写；写失败只警告 —— 面板回退到纯内存显示。
   */
  const persistHistory = (sessionId) => {
    try {
      if (config.persistHistory === false) return
      const file = historyFileFor(sessionId)
      if (file === undefined) return
      const series = panelHistory.get(sessionId)
      if (!Array.isArray(series) || series.length === 0) return
      mkdirSync(dirname(file), { recursive: true })
      const payload = {
        version: PANEL_HISTORY_FILE_VERSION,
        sessionId: String(sessionId),
        updatedAt: new Date().toISOString(),
        records: series.map((item) => ({ ...item })),
      }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, file)
    }
    catch (error) {
      warn('面板历史落盘失败（面板改为只显示内存里的回合）', error)
    }
  }

  /** 启动时清理过期存档：目录里超过保留期的 `.json` 一律删掉，避免无限增长。 */
  const prunePersistedHistory = () => {
    try {
      const dir = historyDir()
      if (dir === undefined || !existsSync(dir)) return
      const now = Date.now()
      let removed = 0
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.json')) continue
        const file = join(dir, entry)
        try {
          if (now - statSync(file).mtimeMs > PANEL_HISTORY_TTL_MS) {
            unlinkSync(file)
            removed += 1
          }
        }
        catch { /* 单个文件删不掉就算了 */ }
      }
      if (removed > 0) debug(`已清理 ${removed} 份过期的面板历史存档`)
    }
    catch (error) {
      warn('清理面板历史存档失败（忽略）', error)
    }
  }

  /**
   * 用落盘明细重建一个会话读数（进程重启后走这条路）。
   * 只给面板读，形状与 `snapshotAll()` 的 sessions 元素一致，并带 `restoredFromDisk: true`
   * 让客户端能标注「来自宿主存档」。
   */
  const restoredSession = (sessionId, now) => {
    const records = readPersistedHistory(sessionId)
    if (records === undefined) return undefined
    const last = records[records.length - 1]
    const meta = sessionMeta.get(sessionId)
    const updatedAt = typeof last.time === 'string' ? Date.parse(last.time) : Number.NaN
    const updated = Number.isFinite(updatedAt) ? updatedAt : now
    const cloned = records.map((item) => ({ ...item }))
    return {
      sessionId: String(sessionId),
      workspace: meta?.workspace,
      emotion: last.emotion,
      intensity: last.intensity,
      reason: last.reason ?? '',
      source: last.source ?? 'unknown',
      outOfList: last.outOfList === true,
      turn: last.turn,
      updatedAt: new Date(updated).toISOString(),
      ageMs: Math.max(0, now - updated),
      history: cloned,
      // 存档里的每条明细就是那一轮的真实读数，直接当采样给出（已生效，故 willInject 永远为 false）。
      samples: cloned.map((item) => ({ ...item, willInject: false })),
      injectionPlan: undefined,
      restoredFromDisk: true,
    }
  }

  //#endregion

  /**
   * 面板接口载荷。
   * @param {string} [sessionId] 只返回该会话时传入；省略则返回全部会话。
   */
  const panelPayload = (sessionId) => {
    const snapshot = snapshotAll()
    if (sessionId === undefined || sessionId === '') return snapshot
    const wanted = String(sessionId)
    const live = snapshot.sessions.filter((item) => item.sessionId === wanted)
    if (live.length > 0) return { ...snapshot, sessions: live }
    // 内存里没有（例如 DSH 刚重启过）：回落到插件自己的落盘明细，这样面板仍能列出
    // 每个历史回合的判定依据，而不是只剩会话节点里的情绪/强度/时间。
    const restored = restoredSession(wanted, Date.now())
    return { ...snapshot, sessions: restored === undefined ? [] : [restored] }
  }

  /**
   * 给浏览器面板开一条**可选**的只读 HTTP 路由：`GET /emotion-feedback/state?sessionId=…`。
   *
   * 面板的主数据源是浏览器侧的对话节点（每条回注都会落进会话日志，带
   * `source.kind = 'emotion-feedback'`），所以这条路只是补充 host 侧细节
   * （融合后强度、判定来源、工作区）。它在 Web 部署里可用；桌面 Electron
   * 走 `file://` + IPC，`/plugins` 与自定义路由都不经这个 HTTP 端口
   * （实测 19387 上连内置的 `/plugins/.../client.js` 都是 404），因此
   * 取不到时**只静默降级**，绝不影响回合与面板。
   *
   * 注册契约照抄 `$NPX/dsh-host-open-in-app/lib/index.js:1271-1282` 与
   * `dsh-model-switch/lib/index.js:409-423`：用 `ctx.inject(['webServer'], …)`
   * 等服务到齐再注册（插件可能在 webServer 之前加载），注册放在
   * `scope.effect(...)` 里以便随 fiber 回收。
   */
  const installPanelRoute = () => {
    if (config.panelRoute === false) return
    if (typeof ctx.inject !== 'function') return
    const connection = typeof ctx.get === 'function' ? ctx.get('connection', false) : undefined
    try {
      ctx.inject(['webServer'], (scope) => {
        scope.effect(
          () => {
            const webServer = scope.webServer
            const dispose = webServer.register({
              kind: 'exact',
              path: PANEL_ROUTE,
              handler: async (req, res) => {
                try {
                  const rejection = connection?.requestRejection?.(req)
                  if (typeof rejection === 'number') {
                    res.statusCode = rejection
                    res.end()
                    return
                  }
                  if (req.method !== 'GET' && req.method !== 'HEAD') {
                    res.statusCode = 405
                    res.setHeader('allow', 'GET, HEAD')
                    res.end()
                    return
                  }
                  const url = new URL(String(req.url ?? PANEL_ROUTE), 'http://localhost')
                  const body = JSON.stringify(panelPayload(url.searchParams.get('sessionId') ?? undefined))
                  res.statusCode = 200
                  res.setHeader('content-type', 'application/json; charset=utf-8')
                  res.setHeader('cache-control', 'no-store')
                  res.end(req.method === 'HEAD' ? undefined : body)
                }
                catch (error) {
                  warn('面板接口处理失败', error)
                  try {
                    res.statusCode = 500
                    res.end('{"sessions":[]}')
                  }
                  catch { /* 连接已经断开 */ }
                }
              },
            })
            debug(`面板接口已挂载：GET ${PANEL_ROUTE}`)
            return () => {
              try {
                dispose?.()
              }
              catch { /* 已随宿主回收 */ }
            }
          },
          'emotion-feedback: panel route',
        )
      })
    }
    catch (error) {
      warn(`挂载面板接口 ${PANEL_ROUTE} 失败（GUI 面板改为只用会话内数据，插件其余功能不受影响）`, error)
    }
  }

  installPanelRoute()
  // 启动时清一次过期存档（超过 PANEL_HISTORY_TTL_MS 的 .json）；没有目录时静默跳过。
  prunePersistedHistory()

  /** 会话销毁时清理状态。 */
  ctx.on('session/disposed', (session) => {
    const id = str(session?.id)
    if (id !== undefined) {
      states.delete(id)
      injectedTurns.delete(id)
      lastInjected.delete(id)
      judgingTurns.delete(id)
      sessionMeta.delete(id)
      panelHistory.delete(id)
    }
  })

  // ① 回合收尾：判定工作模型自己的情绪，静默写入状态。
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!enabledNow() || disposed) return
    try {
      const sessionId = str(agent?.session?.id)
      if (sessionId === undefined) return
      if (typeof turn === 'number' && turn === judgingTurns.get(sessionId)) return
      if (typeof turn === 'number') judgingTurns.set(sessionId, turn)
      const workspace = str(agent?.session?.header?.cwd) ?? str(agent?.options?.cwd)
      if (workspace !== undefined) sessionMeta.set(sessionId, { workspace })
      const text = lastAssistantText(agent.session, typeof turn === 'number' ? turn : undefined)
      if (text === '') {
        debug('本回合没有可判定的正文，保持当前状态')
        return
      }
      const judgement = await classify(agent, text, signal)
      if (judgement === undefined) return
      const now = Date.now()
      const { state, merged } = commit(sessionId, judgement, typeof turn === 'number' ? turn : 0, now)
      appendPanelEvent(agent.session, state, turn)
      // 面板曲线：按时间追加，每会话最多保留 PANEL_HISTORY_LIMIT 个采样点。
      try {
        const series = panelHistory.get(sessionId) ?? []
        // 一条采样 = 一次判定的**完整明细**（原值 + 融合结果 + 依据 + 来源 + 生效回合），
        // 全部来自 commit() 留下的 `state.lastJudged`——但必须在这里**复制一份冻结**：
        // `state.lastJudged` 是活引用，下一回合（或同回合的补充判定）会把它改掉，
        // 直接展开进采样会让历史明细跟着一起变（面板的「每轮依据」就失真了）。
        const detail = { ...(state.lastJudged ?? lastJudgedDetail(state, judgement)) }
        series.push({
          ...detail,
          time: new Date(now).toISOString(),
          // 兼容字段：旧客户端读的是 `judged`。
          judged: detail.judgedEmotion,
          merged: merged.same === true,
          same: merged.same === true,
          carriedIntensity: merged.carried,
          incomingIntensity: merged.incoming,
          intensityRatio: typeof merged.ratio === 'number' && Number.isFinite(merged.ratio) ? merged.ratio : undefined,
          changedSinceInjection: changedSinceLastInjection(sessionId, detail),
          // 这一条判定在哪个回合开头被真回注（pre-step 里补写）；undefined = 还没轮到它。
          injectedInto: undefined,
        })
        const overflow = series.length - PANEL_HISTORY_LIMIT
        if (overflow > 0) series.splice(0, overflow)
        panelHistory.set(sessionId, series)
        // 落盘：重启后面板仍能列出这些回合的依据（见 PANEL_HISTORY_DIRNAME 的说明）。
        persistHistory(sessionId)
      }
      catch (error) {
        warn('记录面板曲线失败（不影响回合）', error)
      }
      debug(
        `回合 ${turn}：判定「${judgement.emotion}」${intensityText(judgement.intensity)}` +
        `（${judgement.source}${judgement.reason ? '：' + judgement.reason : ''}）` +
        `→ 当前「${state.emotion}」${intensityText(state.intensity)}` +
        `${merged.same ? '（同情绪融合）' : '（情绪切换）'}`,
      )
    }
    catch (error) {
      warn('回合判定异常', error)
    }
  })

  /**
   * 【硬性契约】`agent/pre-step` 是 waterfall：监听器**必须**返回一个对象。
   * 返回 `undefined` 会让 `dsh-agent-loop` 的
   * `preStep()`（`$NPX/dsh-agent-loop/lib/index.js:920 if (decision.kind === "reject")`）
   * 抛出 `Cannot read properties of undefined (reading 'kind')`，
   * 整个回合在 `step/start` 之前失败（日志表现：turn/start → turn/end error，零 step）。
   * 因此这里对 `next()` 的**返回值与异常都做兜底**，任何路径都交回一个合法决策。
   */
  const safeDecision = (decision, claimed) => {
    if (decision !== null && typeof decision === 'object') return decision
    const messages = Array.isArray(claimed) ? claimed : []
    return { kind: 'enter', messages }
  }

  // ② 回合起手：把当前情绪状态作为一条合成用户消息回注给工作模型。
  ctx.on('agent/pre-step', async ({ agent, messages: claimed, turn }, next) => {
    let decision
    try {
      decision = await next()
    }
    catch (error) {
      // 下游监听器异常：记录真实错误与调用栈，然后交回一个合法决策，
      // 让宿主的下游代码至少能读到 `decision.kind`（而不是 TypeError）。
      warnError('agent/pre-step 下游监听器异常；已交回合法的 enter 决策', error)
      return safeDecision(undefined, claimed)
    }
    const safe = safeDecision(decision, claimed)
    if (safe !== decision) {
      warnError('agent/pre-step 下游监听器返回了非对象决策；已交回合法的 enter 决策', new Error(`got ${typeof decision}`))
    }
    if (!enabledNow() || !config.inject || disposed) return safe
    if (safe.kind !== 'enter') return safe
    try {
      const sessionId = str(agent?.session?.id)
      if (sessionId === undefined) return safe
      if (typeof turn !== 'number' || turn <= 0) return safe
      const judgement = currentJudgement(sessionId)
      if (judgement === undefined || judgement.intensity < config.minIntensity) return safe
      // 同一回合的多次 pre-step（每一步都会触发）只在「状态相对上次回注有变化」时再注入。
      const signature = `${turn}|${judgement.emotion}|${judgement.intensity.toFixed(4)}`
      const previous = injectedTurns.get(sessionId)
      if (previous === signature) return safe
      // 默认每回合只注入一次：同一回合后续步骤不会因为强度随时间衰减而反复注入。
      if (previous !== undefined && previous.startsWith(`${turn}|`) && !config.injectPerStep) return safe
      const message = {
        id: randomId(),
        role: 'user',
        content: [{ type: 'text', text: renderInjection(judgement, config) }],
        source: { kind: 'emotion-feedback' },
      }
      const messages = Array.isArray(safe.messages) ? [...safe.messages, message] : [message]
      injectedTurns.set(sessionId, signature)
      // 把「这一条判定真的在哪个回合开头回注了」写进采样：面板因此能显示
      // 「回合 N 判定 → 回合 N+1 生效」，而不是让用户从时间戳里猜。
      try {
        recordInjection(sessionId, turn)
      }
      catch (error) {
        warnError('记录回注回合失败（不影响回合）', error)
      }
      debug(`回合 ${turn}：回注「${judgement.emotion}」${intensityText(judgement.intensity)}`)
      return { ...safe, messages }
    }
    catch (error) {
      warnError('情绪回注异常，本步按原样继续', error)
      return safe
    }
  }, { prepend: true })

  /**
   * 只读快照，供核对与调试。
   * @param {string} [sessionId] 省略时返回所有已知会话。
   */
  const api = {
    currentState(sessionId) {
      if (sessionId === undefined) {
        const out = {}
        for (const id of states.keys()) out[id] = api.currentState(id)
        return out
      }
      const state = states.get(String(sessionId))
      if (state === undefined) return undefined
      const live = rehydrate(state, config, Date.now())
      const snapshot = {
        emotion: live.emotion,
        intensity: live.intensity,
        reason: live.reason,
        source: live.source,
        turn: live.turn,
        updatedAt: new Date(live.updatedAt).toISOString(),
        history: live.history.map((item) => ({ ...item })),
      }
      if (live.outOfList === true) snapshot.outOfList = true
      return snapshot
    },
    config,
    /** 会话事件写入的唯一入口（硬护栏）。见 `guardedAppend` 上方注释。 */
    guardedAppend,
    /**
     * 测试钩子：注入「harness 已知会话事件类型」快照。
     * 传 `undefined` 恢复成去磁盘找；传函数则用其返回值。
     * 注入来源给不出可用快照（含函数返回 `undefined`）⇒ 判「读不到」并保守拒绝，
     * **不回落磁盘**（否则「快照缺失」类用例会被本机快照弄成假绿）。
     */
    setKnownTypesSourceForTest,
    /**
     * 测试钩子：按**真实相对布局**去找快照（忽略注入）。
     * `null` = 本次布局下没找到；否则是解析出的已知类型集合。
     * 用途：断言「磁盘发现链在当前布局下确实通」，而不是只验证注入的那条路。
     * 可传 `from`（目录）改用自建的同深度布局，便于在没有开发机 `_diag` 的机器上回归。
     */
    discoverKnownSessionEventTypesFromDisk: (from) => discoverKnownTypesFromDisk(from),
    /** 测试钩子：当前生效的黑名单（副本）。 */
    forbiddenSessionEventTypes: () => new Set(FORBIDDEN_SESSION_EVENT_TYPES),
    /** 面板读数（全部会话，按最近更新排序）。 */
    panelSnapshot: snapshotAll,
    /**
     * 面板接口同款载荷：给 `sessionId` 时只返回该会话；内存里没有就回落到落盘明细
     * （`restoredFromDisk: true`）。路由与测试都走这一条，保证测的就是线上那条路。
     */
    panelPayload: (sessionId) => panelPayload(sessionId),
    /** 测试钩子：把面板历史的落盘目录指到临时目录（避免测试污染真实 DSH_HOME）。 */
    setHistoryDirForTest,
    /** 测试钩子：落盘文件路径（`undefined` = 当前环境没有可用目录）。 */
    historyFileFor: (sessionId) => historyFileFor(sessionId),
    dispose() {
      disposed = true
      for (const dispose of disposes.splice(0)) {
        try {
          dispose()
        }
        catch (error) {
          warnError('回收资源失败', error)
        }
      }
      states.clear()
      sessionMeta.clear()
      injectedTurns.clear()
      lastInjected.clear()
      judgingTurns.clear()
      panelHistory.clear()
    },
  }

  /**
   * 注册只读工具 `emotion_status`：让工作模型在自己需要时读取当前情绪状态。
   * 与 GUI 面板读的是同一份进程内状态，因此两边永远一致。
   * 工具是只读的——改情绪只能通过对话本身（批评/夸奖）自然发生。
   *
   * 依赖是**惰性解析**的：`@deepseek-ai/dsh-tools` 在插件安装目录里不一定可解析，
   * 拿不到就不注册工具；`apply()` 因此保持同步（不做顶层 await），插件本体
   * 绝不会因为少一个可选依赖而加载失败。
   */
  const registerStatusTool = async (tools, defineTool) => {
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      warn('宿主未提供 tools 服务，跳过 emotion_status 工具注册（回注与面板不受影响）')
      return
    }
    if (typeof defineTool !== 'function') {
      warn('无法加载 @deepseek-ai/dsh-tools，跳过 emotion_status 工具注册（回注与面板不受影响）')
      return
    }
    try {
      const disposeTool = tools.register(defineTool({
        name: 'emotion_status',
        description:
          '读取你（助手）当前的内在情绪状态：情绪名、强度（0-1）、判定理由、最近数回合的情绪轨迹。'
          + '这是你自己上一轮回答被评估后留下的状态，会在下一轮开始前以内部提示回注给你。'
          + '当你需要确认自己此刻的情绪基调时调用它；绝大多数回合不需要调用。',
        parameters: {},
        output: {
          /**
           * 作者态 value schema DSL。注意两条硬约束（`$NPX/dsh-tools/lib/index.js:555-751`
           * 的 `assertAuthorKeys`）：
           *   1. 只允许 type/oneOf/items/properties/additionalProperties/enum/const/
           *      description/title/default/examples，以及**每个属性自己的** `required: true`；
           *   2. 对象节点的 `additionalProperties` 必须显式写出 true/false。
           * 这里**不能**写 JSON Schema 的 `required: [...]` 数组——会抛
           * `schema.required is not supported by the value schema DSL`。
           */
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              emotion: { type: 'string', required: true },
              intensity: { type: 'number', required: true },
              reason: { type: 'string', required: true },
              source: { type: 'string', required: true },
              turn: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
              history: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    turn: { type: 'number', required: true },
                    turnIndex: { type: 'number', required: true },
                    emotion: { type: 'string', required: true },
                    intensity: { type: 'number', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: `当前情绪「${value.emotion}」强度 ${intensityText(value.intensity)}`
              + `（${value.reason}）\n最近轨迹：`
              + (value.history.length === 0
                ? '（暂无）'
                : value.history.map((item) => `T${item.turnIndex} ${item.emotion} ${intensityText(item.intensity)}`).join(' → ')),
          }],
        },
        execute: async (_args, exec) => {
          try {
            const sessionId = str(exec?.agent?.session?.id) ?? str(exec?.agent?.id) ?? ''
            const state = sessionId === '' ? undefined : states.get(sessionId)
            const live = state === undefined ? undefined : rehydrate(state, config, Date.now())
            const items = live?.history
            const history = []
            if (Array.isArray(items)) {
              const first = Number.isFinite(items[0]?.turn) ? items[0].turn : 1
              for (const item of items) {
                if (!Number.isFinite(item?.turn)) continue
                history.push({
                  turn: item.turn,
                  turnIndex: Math.max(1, Math.trunc(item.turn - first + 1)),
                  emotion: str(item.emotion) ?? '平静',
                  intensity: clamp01(item.intensity),
                })
              }
            }
            if (live === undefined) {
              return {
                sessionId,
                emotion: '平静',
                intensity: 0,
                reason: '本会话还没有产生过情绪判定',
                source: 'none',
                turn: null,
                history,
              }
            }
            return {
              sessionId,
              emotion: live.emotion,
              intensity: clamp01(live.intensity),
              reason: str(live.reason) ?? '',
              source: str(live.source) ?? 'unknown',
              turn: Number.isFinite(live.turn) ? live.turn : null,
              history,
            }
          }
          catch (error) {
            warnError('emotion_status 读取状态失败', error)
            return {
              sessionId: '',
              emotion: '平静',
              intensity: 0,
              reason: '读取情绪状态时发生异常，已按无状态处理',
              source: 'none',
              turn: null,
              history: [],
            }
          }
        },
      }))
      if (typeof disposeTool === 'function') disposes.push(disposeTool)
    }
    catch (error) {
      warnError('注册 emotion_status 工具失败（面板与回注不受影响）', error)
    }
  }

  /**
   * 惰性解析 `@deepseek-ai/dsh-tools`：第一次注册工具时才 import。
   * 解析不到就返回 undefined，调用方据此跳过工具注册——绝不让可选依赖
   * 影响插件加载（`apply()` 里不做顶层 await）。
   */
  let defineToolPromise
  const loadDefineTool = () => {
    if (defineToolPromise === undefined) {
      defineToolPromise = import('@deepseek-ai/dsh-tools').then(
        (module) => (typeof module?.defineTool === 'function' ? module.defineTool : undefined),
        () => undefined,
      )
    }
    return defineToolPromise
  }

  /**
   * 等 `tools` 服务到齐再注册（与面板路由同样的 reactive 方式），
   * 这样即便宿主没有 tools 服务也只是少一个工具，插件本体照常工作。
   */
  const installStatusTool = () => {
    if (config.statusTool === false || config.disabled === true) return
    if (typeof ctx.inject !== 'function') {
      warn('ctx.inject 不可用，跳过 emotion_status 工具注册（回注与面板不受影响）')
      return
    }
    const provided = typeof deps?.defineTool === 'function' ? deps.defineTool : undefined
    try {
      ctx.inject(['tools'], (scope) => {
        if (provided !== undefined) {
          registerStatusTool(scope.tools, provided)
          return
        }
        loadDefineTool().then(
          (defineTool) => registerStatusTool(scope.tools, defineTool),
          (error) => warn('加载 @deepseek-ai/dsh-tools 失败，跳过 emotion_status 工具注册', error),
        )
      })
    }
    catch (error) {
      warn('注册 emotion_status 工具失败（面板与回注不受影响）', error)
    }
  }

  installStatusTool()

  debug(`已启用：情绪词表 ${[...allowed].join('/')}；关键词规则 ${config.rules?.length ?? 0} 条`)
  return api
}
