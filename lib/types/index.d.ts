/**
 * dsh-emotion-feedback 的手写类型声明（与 lib/index.js 保持同步）。
 *
 * 只在有编辑器/类型检查需求时使用；宿主加载插件走的是 `lib/index.js`。
 */

/** 一条关键词规则。 */
export interface EmotionRule {
  /** 判定出的情绪名，必须出现在 {@link Config.emotions} 里。 */
  emotion: string
  /** 命中后的起始强度（0-1）。 */
  intensity: number
  /** 命中任一子串即算命中。 */
  patterns: string[]
}

/** 刚判定出来的单次结果。 */
export interface Judgement {
  emotion: string
  intensity: number
  reason: string
  /** 'rule' = 本地关键词层；'llm' = 模型判定层。 */
  source: 'rule' | 'llm'
  /**
   * 该标签不在 {@link Config.emotions} 里（判定器自造的词）。
   * 2026-10-10 起这里原样保留标签，**不再改写成「平静」**；只有该标记为 `true` 时才出现。
   */
  outOfList?: true
}

/** 供核对/调试的只读快照。 */
export interface EmotionStateSnapshot {
  emotion: string
  /** 实时强度。注意：随闲置时间衰减的模块已停用，这里等于落库时的强度。 */
  intensity: number
  reason: string
  source: string
  /** 见 {@link Judgement.outOfList}；仅在标签不在词表里时出现。 */
  outOfList?: true
  turn: number
  /** ISO 8601 时间串。 */
  updatedAt: string
  history: Array<{ turn: number; emotion: string; intensity: number }>
}

/** 插件配置（schemastery 校验）。 */
export interface Config {
  /**
   * 紧急开关：为 `true` 时插件完全静默（不判定、不回注、不写日志），优先级高于 `enabled`。
   * 可在 `cordis.patch.yml` 里写 `config: { disabled: true }` 立刻停用，无需卸载。
   */
  disabled: boolean
  /** 总开关。 */
  enabled: boolean
  /** 是否把情绪状态回注给工作模型。 */
  inject: boolean
  /** 同一个回合内的后续步骤是否也允许回注。 */
  injectPerStep: boolean
  /** 低于该强度就不回注。 */
  minIntensity: number
  /** 判定器的 provider；留空则用当前会话默认模型。 */
  judgeProvider: string
  /** 判定器的 model；留空则用当前会话默认模型。 */
  judgeModel: string
  /** 是否允许 LLM 判定（关键词没命中时才触发）。 */
  useLlm: boolean
  /** 单次判定调用的超时（毫秒）。 */
  timeoutMs: number
  /** 判定调用失败时是否在宿主日志里打印原因。 */
  logErrors: boolean
  /** 每回合的情绪衰减系数。 */
  turnDecay: number
  /**
   * 闲置多久（分钟）强度减半。
   * @deprecated 随闲置时间衰减的模块已停用，该字段保留仅为兼容既有补丁，不再生效。
   */
  halfLifeMinutes: number
  /** 情绪切换时旧强度保留比例。 */
  takeoverRetain: number
  /** 每个会话最多保留多少条历史。 */
  historyLimit: number
  /** 允许的情绪词表。 */
  emotions: string[]
  /** 关键词规则。 */
  rules: EmotionRule[]
  /** LLM 判定用的系统提示词。 */
  prompt: string
  /**
   * 否定/反向修饰词：关键词命中处前后的小窗口里出现它们时，该命中跳过。
   * 用于挡住「不确定」「风险最低」「风险可控」这类反向命中。设为 `[]` 可关闭该保护。
   */
  negations: string[]
  /** 回注文案模板，支持 {emotion} / {intensity} / {reason_part} / {reason}。 */
  template: string
  /** 回注时是否带上判定依据。 */
  includeReason: boolean
  /**
   * 是否把每次判定写成会话事件 `emotion-feedback/state`，供 GUI 面板读取。
   * 该事件不参与消息投影，因此不进模型上下文、也不在对话里显示。
   */
  panelEvent: boolean
  /**
   * 是否注册 host 侧只读 HTTP 路由 `/emotion-feedback/state`。
   * 桌面端浏览器半边走 file:// + IPC，取不到该路由会自动降级（面板以会话节点为准）；
   * Web 部署下它才是面板的取数通道。
   */
  panelRoute: boolean
  /**
   * 是否注册只读工具 `emotion_status`，让工作模型能自己读取当前情绪状态。
   * 依赖 `tools` 服务与 `@deepseek-ai/dsh-tools`（均为惰性解析，缺任一项都只少一个工具）。
   */
  statusTool: boolean
  /** 是否打印调试日志。 */
  debug: boolean
}

/** 面板快照中的一个会话。 */
export interface EmotionPanelSession {
  sessionId: string
  /** 会话工作目录（取不到时为空串）。 */
  workspace: string
  emotion: string
  intensity: number
  reason: string
  source: string
  /** 标签不在词表里（判定器自造的词）；面板可据此加标记。 */
  outOfList: boolean
  turn: number | null
  updatedAt: string
  ageMs: number
  history: Array<{ turn: number; emotion: string; intensity: number }>
}

/** 面板快照（`api.panelSnapshot()` 与 HTTP 路由返回的同一个对象）。 */
export interface EmotionPanelSnapshot {
  generatedAt: string
  config: {
    disabled: boolean
    enabled: boolean
    inject: boolean
    injectPerStep: boolean
    minIntensity: number
    turnDecay: number
    takeoverRetain: number
    useLlm: boolean
    historyLimit: number
  }
  sessions: EmotionPanelSession[]
}

/** 插件返回的 API（宿主不消费，供调试与自测使用）。 */
export interface EmotionFeedbackApi {
  /** 省略 sessionId 时返回所有已知会话的快照。 */
  currentState(sessionId?: string): EmotionStateSnapshot | Record<string, EmotionStateSnapshot> | undefined
  config: Config
  /** 面板读数：全部已知会话，按最近更新降序。 */
  panelSnapshot(): EmotionPanelSnapshot
  dispose(): void
}

/** Cordis 插件名（loader 诊断用）。 */
export declare const name: 'emotion-feedback'
/** 需要的服务。 */
export declare const inject: readonly ['llm']
/** schemastery 校验后的配置构造器。 */
export declare const Config: any
/** 默认情绪词表。 */
export declare const DEFAULT_EMOTIONS: readonly string[]
/** 默认关键词规则。 */
export declare const DEFAULT_RULES: readonly EmotionRule[]
/** 默认回注文案模板。 */
export declare const DEFAULT_TEMPLATE: string
/** 默认判定提示词。 */
export declare const DEFAULT_PROMPT: string
/** GUI 面板读取 Host 侧状态的 HTTP 路由。 */
export declare const PANEL_ROUTE: '/emotion-feedback/state'
/** 面板曲线每个会话保留的采样点数上限。 */
export declare const PANEL_HISTORY_LIMIT: 240
/** 面板把采样点视为「本回合将要回注」的时效窗口（毫秒）。 */
export declare const PANEL_FRESH_MS: 120000
/**
 * 装载入口。
 * @param deps 测试注入口（`{ defineTool }`）；真实宿主不传，插件会惰性 import
 *   `@deepseek-ai/dsh-tools` 自行解析。
 */
export declare function apply(
  ctx: any,
  config: Config,
  deps?: { defineTool?: Function },
): EmotionFeedbackApi
