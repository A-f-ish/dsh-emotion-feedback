/**
 * 浏览器半边数据层回归：在 Node 里以最小桩件加载 lib/client.js，
 * 用真实会话日志里的回注文案（以及构造的边界样例）验证解析与曲线聚合。
 *
 * 为什么这样测：lib/client.js 是「经典 script + __ModuleLoader__ 惰性工厂」，
 * 无法直接 import；所以这里复刻模块加载器的最小契约（注册工厂 → 取回导出），
 * 并给 factory 提供桩 React，然后直接调用返回对象里挂出来的测试钩子。
 *
 * 用法: node test/panel-data.mjs
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const SESSIONS = 'C:\\Users\\Lenovo\\.dsh\\sessions'

let passed = 0
let failed = 0
// 结构化回传：突变测试台靠它判断「哪条用例变红」——沙箱禁止管道 stdio 的 spawnSync，
// 捕获输出行不通，只能走结果文件。
const failedCases = []
const ok = (name) => { passed++; console.log(`  ok  ${name}`) }
const bad = (name, detail) => {
  failed++
  failedCases.push({ title: name, message: String(detail) })
  console.log(`  FAIL ${name}\n       ${detail}`)
}
const check = (name, condition, detail = '') => (condition ? ok(name) : bad(name, detail))
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)

// ---------------------------------------------------------------- 加载浏览器半边

/** 用最小桩件执行 lib/client.js，取回工厂产物（导出对象 + 测试钩子）。 */
function loadClient() {
  const source = readFileSync(CLIENT, 'utf8')
  let registration
  // useState 要真的能改状态、并触发一次重渲：面板默认折叠（`open=false`），
  // 只有点开之后才会走「逐轮明细」那段渲染，光有纯函数钩子测不到它。
  // 槽位表与渲染函数都放在**闭包**里（不能挂在 React 对象上：每次渲染重设会丢状态）。
  let slots = 0
  const stateBox = []
  const effects = []
  let current = { tree: undefined, component: undefined, props: undefined }
  const doRender = () => {
    slots = 0
    current.tree = current.component(current.props)
  }
  // 最小 Component：面板外面套的「渲染保险丝」是 class 错误边界（函数组件的
  // try/catch 抓不到子组件渲染阶段的错误），桩 React 必须提供 Component，否则
  // withFuse 会走退化分支、边界本身就没被验证过。
  class Component {
    constructor(props) { this.props = props }
    setState(patch) { this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) } }
  }
  const React = {
    Component,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => {
      const index = slots++
      if (stateBox[index] === undefined) stateBox[index] = initial
      const set = (value) => {
        stateBox[index] = typeof value === 'function' ? value(stateBox[index]) : value
        doRender()
      }
      return [stateBox[index], set]
    },
    // effect 先登记、渲染结束后由 runEffects() 执行：真跑一遍「拉 host 快照 → setState」，
    // 否则面板永远只是 DOM 那半边数据，host 侧的判定原值/依据根本没被测到。
    useEffect: (callback) => { effects.push(callback) },
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
  }
  /** 渲染一次面板组件（每次调用都把 hooks 槽位归零，模拟一次全新的渲染）。 */
  const renderElement = (component, props) => {
    stateBox.length = 0
    effects.length = 0
    current = { tree: undefined, component, props }
    doRender()
    return {
      get tree() { return current.tree },
      /** 执行已登记的 effect，并把随之而来的异步 setState 跑完。 */
      async runEffects() {
        for (const callback of effects.splice(0)) callback()
        for (let i = 0; i < 8; i += 1) await Promise.resolve()
        return current.tree
      },
      /**
       * 找到带指定 class 的节点并点击它。
       * 类名可能只挂在外层容器上（真正的 onClick 在里层按钮上，按钮自己 className 为空），
       * 所以先在匹配节点自身找 onClick，找不到再往下找第一个带 onClick 的后代。
       */
      click(className) {
        const matches = walk(current.tree).filter((n) => n !== null && typeof n === 'object' && n.props !== undefined && String(n.props.className ?? '').includes(className))
        for (const match of matches) {
          if (typeof match.props.onClick === 'function') { match.props.onClick(); return true }
          const inner = walk(match).find((n) => n !== match && n !== null && typeof n === 'object' && typeof n.props?.onClick === 'function')
          if (inner !== undefined) { inner.props.onClick(); return true }
        }
        return false
      },
    }
  }
  const walk = (node, out = []) => {
    if (Array.isArray(node)) { for (const item of node) walk(item, out); return out }
    if (node === null || node === undefined || typeof node !== 'object') return out
    out.push(node)
    for (const child of node.children ?? []) walk(child, out)
    return out
  }
  /** 把渲染树里的文本按出现顺序拼起来（只看字符串子节点）。 */
  const textsOf = (node) => walk(node).flatMap((n) => (n.children ?? []).filter((c) => typeof c === 'string'))
  // 面板的 host 快照走 fetch；测试里换成可控实现（默认离线，与真实桌面端一致）。
  let fetchImpl = () => Promise.reject(new Error('offline'))
  const setFetch = (impl) => { fetchImpl = impl }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => { registration = value },
      },
      /** 预置非空键，client.js 才会写出测试钩子（真实页面里该键不存在）。 */
      __EF_TEST__: {},
    },
    require: (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require("${name}")`)
    },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    fetch: (...args) => fetchImpl(...args),
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }
  sandbox.globalThis = sandbox
  // 经典 script：顶层只有一次 __ModuleLoader__.load 调用，用 Function 执行即可。
  const run = new Function('window', 'require', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', source)
  run(sandbox.window, sandbox.require, sandbox.document, sandbox.fetch, sandbox.AbortController, sandbox.setTimeout, sandbox.clearTimeout, sandbox.setInterval, sandbox.clearInterval, console)
  if (registration === undefined) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  if (registration.id !== 'dsh-emotion-feedback') throw new Error(`factory id 不匹配：${registration.id}`)
  const exported = registration.factory(sandbox.require)
  const hooks = sandbox.window.__EF_TEST__
  if (hooks === undefined) throw new Error('client.js 没有在 window.__EF_TEST__ 暴露测试钩子')
  return { exported, hooks, renderElement, textsOf, walk, setFetch }
}

const { exported, hooks, renderElement, textsOf, walk, setFetch } = loadClient()
const { parseInjection, samplesOf, colorOf, injectionOf, mergeRounds, effectiveLabel, blendRatio, turnOfNode, lastAppliedRound } = hooks

// ---------------------------------------------------------------- 真实会话文案

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解 zstd 多帧会话日志，返回事件对象数组。 */
function decodeLog(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
  }
  let text = ''
  for (let i = 0; i < offsets.length; i++) {
    const slice = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : undefined)
    try { text += zstdDecompressSync(slice).toString('utf8') } catch { /* 尾部半帧 */ }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* 截断行 */ }
  }
  return events
}

/** 收集所有日志里 source.kind === 'emotion-feedback' 的真实回注正文。 */
function realInjections() {
  const files = []
  for (const dir of readdirSync(SESSIONS)) {
    const outer = join(SESSIONS, dir)
    try { if (!statSync(outer).isDirectory()) continue } catch { continue }
    for (const inner of readdirSync(outer)) {
      const target = join(outer, inner)
      try {
        if (statSync(target).isDirectory()) {
          for (const name of readdirSync(target)) if (name.endsWith('.jsonl.zstd')) files.push(join(target, name))
        } else if (inner.endsWith('.jsonl.zstd')) files.push(target)
      } catch { /* skip */ }
    }
  }
  const texts = []
  for (const file of files) {
    for (const event of decodeLog(file)) {
      if (event.type !== 'user/message') continue
      if (event.data?.source?.kind !== 'emotion-feedback') continue
      for (const block of event.data.content ?? []) if (typeof block?.text === 'string') texts.push(block.text)
    }
  }
  return texts
}

console.log('\n[1] 解析真实回注文案')
const real = realInjections()
check(`会话日志里找到真实回注 ${real.length} 条（要求 ≥1）`, real.length >= 1)
for (const text of real) {
  const parsed = parseInjection(text)
  check(`真实文案可解析：${text.slice(0, 24)}…`, parsed !== undefined, 'parseInjection 返回 undefined')
  if (parsed !== undefined) {
    check(`  情绪是有意义的中文词（${parsed.emotion}）`, /^[\u4e00-\u9fff]{1,6}$/.test(parsed.emotion))
    check(`  强度在 0-1（${parsed.intensity}）`, Number.isFinite(parsed.intensity) && parsed.intensity >= 0 && parsed.intensity <= 1)
  }
}

console.log('\n[2] 模板与边界的解析')
const T = (emotion, intensity, reason) =>
  `你当前的内在情绪状态是「${emotion}」，强度 ${intensity}（0-1）。${reason === undefined ? '' : `判定依据：${reason}。`}这是你上一轮回答被评估后得到的情绪反馈，它属于你自己此刻的状态。`
eq('默认模板 → 愧疚 0.72', parseInjection(T('愧疚', '0.72')), { emotion: '愧疚', intensity: 0.72, reason: undefined })
eq('两位小数 → 平静 0.3', parseInjection(T('平静', '0.30')), { emotion: '平静', intensity: 0.3, reason: undefined })
eq('自定义模板 + 判定依据', parseInjection(T('挫败', '0.55', '用户连续三次指出同一处错误')), {
  emotion: '挫败', intensity: 0.55, reason: '用户连续三次指出同一处错误',
})
eq('百分数强度', parseInjection('你当前的内在情绪状态是「愉悦」，强度 85%（0-1）。'), { emotion: '愉悦', intensity: 0.85, reason: undefined })
eq('无强度字段时 intensity 为 undefined', parseInjection('你当前的内在情绪状态是「好奇」。'), { emotion: '好奇', intensity: undefined, reason: undefined })
eq('普通用户消息 → undefined', parseInjection('帮我看看这段代码'), undefined)
eq('空串 → undefined', parseInjection(''), undefined)
eq('非字符串 → undefined', parseInjection(undefined), undefined)
eq('引号里是句子 → 不做情绪（词表兜底）', parseInjection('你当前的内在情绪状态是「我很好奇这件事」，强度 0.5'), { emotion: '好奇', intensity: 0.5, reason: undefined })
eq('未收录的情绪词仍可显示（引号是权威来源）', parseInjection('你当前的内在情绪状态是「柠檬」，强度 0.5'), { emotion: '柠檬', intensity: 0.5, reason: undefined })
eq('依据句里的句号会截断', parseInjection(T('挫败', '0.55', '用户连续三次指出同一处错误')).reason, '用户连续三次指出同一处错误')

console.log('\n[3] 从对话节点聚合曲线')
const node = (seq, time, emotion, intensity, sourceKind = 'emotion-feedback') => ({
  kind: 'context', seq, time, content: [{ type: 'text', text: T(emotion, intensity.toFixed(2)) }], source: { kind: sourceKind },
})
const nodes = [
  { kind: 'user', seq: 1, time: 1000, content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: 'r1' } },
  node(3, 2000, '平静', 0.3),
  { kind: 'assistant', seq: 4, time: 2500, blocks: [] },
  node(9, 4000, '愧疚', 0.72),
  { kind: 'context', seq: 10, time: 4500, content: [{ type: 'text', text: '时间上下文' }], source: { kind: 'time-context' } },
  node(15, 6000, '愧疚', 0.65),
]
const samples = samplesOf(nodes)
eq('只收本插件的回注，按 seq 升序', samples.map((s) => [s.seq, s.emotion, s.intensity]), [[3, '平静', 0.3], [9, '愧疚', 0.72], [15, '愧疚', 0.65]])
// 生效回合 = 截至该条回注为止出现过的真实用户消息数（回注紧跟在本回合那条用户消息之后）。
// 上面的夹具只有一条用户消息（seq 1），所以三条回注都落在回合 1。
eq('每条采样带回合号与判定依据字段（新契约）', samples.map((s) => [s.turn, s.reason]), [[1, undefined], [1, undefined], [1, undefined]])
eq('跨回合时按用户消息归属生效回合', samplesOf([
  { kind: 'user', seq: 1, time: 1, content: [], source: { kind: 'user' } },
  node(3, 2, '平静', 0.3),
  { kind: 'assistant', seq: 4, time: 3, blocks: [] },
  { kind: 'user', seq: 5, time: 4, content: [], source: { kind: 'user' } },
  node(6, 5, '愧疚', 0.7),
  // 回注自己也是 user/message，但 source.kind 是插件名，不能把回合数算多
  { kind: 'context', seq: 7, time: 6, content: [], source: { kind: 'time-context' } },
]).map((s) => [s.seq, s.turn]), [[3, 1], [6, 2]])
eq('节点带 turn 时采样记下生效回合', samplesOf([{ kind: 'context', seq: 21, time: 21, turn: 4, content: [{ type: 'text', text: T('坚定', '0.50') }], source: { kind: 'emotion-feedback' } }]).map((s) => s.turn), [4])
eq('turnIndex 也认', turnOfNode({ turnIndex: 7 }), 7)
eq('没有回合字段时为 undefined', turnOfNode({ seq: 1 }), undefined)
eq('回注文案里的依据会进采样（逐轮明细要用）', samplesOf([{ kind: 'context', seq: 22, time: 22, turn: 5, content: [{ type: 'text', text: T('挫败', '0.55', '用户连续三次指出同一处错误') }], source: { kind: 'emotion-feedback' } }]).map((s) => s.reason), ['用户连续三次指出同一处错误'])
check('末端即当前状态', samples[samples.length - 1].emotion === '愧疚' && samples[samples.length - 1].intensity === 0.65)
eq('未排序输入也会按 seq 归一', samplesOf([nodes[5], nodes[1], nodes[3]]).map((s) => s.seq), [3, 9, 15])
eq('空数组 → 空曲线', samplesOf([]), [])
eq('非数组 → 空曲线', samplesOf(undefined), [])
eq('全是非回注消息 → 空曲线', samplesOf(nodes.filter((n) => n.source?.kind !== 'emotion-feedback')).length, 0)

console.log('\n[4] 容错与识别')
eq('source 为 null 的节点不炸', Number.isFinite(samplesOf([{ kind: 'context', seq: 1, time: 1, content: [{ type: 'text', text: '普通上下文' }], source: null }]).length), true)
eq('source 为 null 时按文案识别回注', samplesOf([{ kind: 'context', seq: 1, time: 1, content: [{ type: 'text', text: T('平静', '0.20') }], source: null }]).length, 1)
eq('别的 source.kind 的上下文行不会被误判', samplesOf([{ kind: 'context', seq: 2, time: 2, content: [{ type: 'text', text: '时间上下文' }], source: { kind: 'time-context' } }]).length, 0)
eq('提到情绪词但不是回注文案的行不会被误判', samplesOf([{ kind: 'context', seq: 3, time: 3, content: [{ type: 'text', text: '现在情绪不错' }], source: { kind: 'runtime-context' } }]).length, 0)
eq('content 为字符串也认', samplesOf([{ kind: 'context', seq: 4, time: 4, content: T('焦虑', '0.40'), source: { kind: 'emotion-feedback' } }]).length, 1)
eq('source.kind 为包名也认', samplesOf([{ kind: 'context', seq: 5, time: 5, content: [{ type: 'text', text: T('坚定', '0.50') }], source: { kind: 'dsh-emotion-feedback' } }]).length, 1)
eq('宿主把 source.kind 改成别的名字时靠 producer 兜底', samplesOf([{ kind: 'context', seq: 6, time: 6, content: [{ type: 'text', text: T('好奇', '0.70') }], source: { kind: 'plugin-context' }, producer: { role: 'inject', label: 'emotion-feedback' } }]).length, 1)
check('识别函数对未知节点返回 undefined', injectionOf({ kind: 'assistant', seq: 1, blocks: [] }) === undefined)
check('识别函数对 null 返回 undefined', injectionOf(null) === undefined)
check('词表配色稳定', colorOf('愧疚') === colorOf('愧疚') && colorOf('愧疚') !== colorOf('平静'))
check('未知情绪回落到色相哈希', /^hsl\(/.test(colorOf('某种新情绪')))

console.log('\n[5] 浏览器半边导出契约')
eq('导出对象只 inject slots', exported.inject, ['slots'])
check('导出对象带 name', typeof exported.name === 'string' && exported.name.length > 0)
eq('工厂 id 等于包名（已在上方注册时校验）', true, true)
check('apply 是函数', typeof exported.apply === 'function')

console.log('\n[6] host 快照的判定来源显示')
const { sourceLabel } = hooks
eq('rule 显示为关键词', sourceLabel('rule'), '关键词')
eq('llm 显示为模型判定', sourceLabel('llm'), '模型判定')
eq('未知来源原样显示', sourceLabel('other'), 'other')
check('sourceLabel 已挂到测试钩子', typeof sourceLabel === 'function')

console.log('\n[7] 逐轮判定明细：合并 host 与会话两侧数据')
// 会话侧（模型真正收到的回注）：sample.turn 是**生效回合**（回注发生在该回合起手），
// 有生效时刻与依据，没有判定原值。
const sessionSamples = [
  { seq: 3, time: 1000, turn: 1, emotion: '平静', intensity: 0.3, reason: '开场寒暄' },
  { seq: 9, time: 3000, turn: 3, emotion: '愧疚', intensity: 0.72, reason: '用户指出遗漏前提' },
]
// host 侧（进程内判定记录）：turn 是**判定回合**，有判定原值/来源/融合关系，重启即空。
const hostHistory = [
  {
    turn: 2,
    updatedAt: 3000,
    judgedEmotion: '愧疚',
    judgedIntensity: 0.5,
    emotion: '愧疚',
    intensity: 0.72,
    reason: '用户指出遗漏前提',
    source: 'rule',
    outOfList: false,
    injectedInto: 3,
  },
]
const rounds = mergeRounds(sessionSamples, hostHistory)
// 两侧都按「生效回合」合到同一行：样本的 T3 生效 + host 的 T2 判定 → 一行「T2 判定 → T3 生效」。
eq('两侧按生效回合合并成同一行', rounds.length, 2)
eq('合并行同时带判定回合、生效回合与两边的数据',
  rounds.map((r) => [r.turn, r.effectiveTurn, r.emotion, r.intensity, r.judgedIntensity, r.sourceKind]),
  [[undefined, 1, '平静', 0.3, undefined, undefined], [2, 3, '愧疚', 0.72, 0.5, 'rule']])
eq('没有 host 明细时判定回合按「生效回合 - 1」推定',
  mergeRounds([sessionSamples[1]], []).map((r) => [r.turn, r.judgedInferred]), [[2, true]])
eq('生效回合是第一回合时不硬推成 T0',
  mergeRounds([sessionSamples[0]], []).map((r) => [r.turn, r.judgedInferred]), [[undefined, false]])
eq('有 host 明细时不标推定', rounds[1].judgedInferred, false)
eq('会话侧独有的生效时刻被保留', rounds[1].effectiveAt, 3000)
eq('按生效回合排序', mergeRounds([sessionSamples[1], sessionSamples[0]], []).map((r) => r.effectiveTurn), [1, 3])
eq('只给 host 数据也能成行', mergeRounds([], hostHistory).map((r) => [r.turn, r.effectiveTurn, r.emotion]), [[2, 3, '愧疚']])
eq('host 没记 injectedInto 时按 turn + 1 预告生效回合',
  mergeRounds([], [{ turn: 4, emotion: '平静', intensity: 0.3 }]).map((r) => [r.judgedTurn, r.effectiveTurn, r.turn]), [[4, 5, 4]])
eq('只给会话数据也能成行', mergeRounds(sessionSamples, []).map((r) => r.effectiveTurn), [1, 3])
eq('两侧都空 → 空列表', mergeRounds([], []), [])
eq('非数组输入不炸', mergeRounds(undefined, undefined), [])
eq('生效回合文案', effectiveLabel(rounds[1]), '回合 3 生效')
eq('没有回合号时退回最近一次回注', effectiveLabel({ emotion: '平静' }), '最近一次回注')
eq('融合倍率 = 生效强度 / 判定原值', blendRatio(rounds[1]), 1.44)
eq('没有判定原值时不算倍率', blendRatio(rounds[0]), undefined)

console.log('\n[7b] 每轮判定与生效回合的文案（用户报告的两个问题都在这行字上）')
const { turnPair } = hooks
check('turnPair 已挂到测试钩子', typeof turnPair === 'function')
// 判定在回合 N 收尾、状态从回合 N+1 起生效：两个数都要写出来，
// 用户才不用从时间戳里推「这到底是哪一轮的判定」。
eq('判定回合 + 生效回合都给出来', turnPair({ turn: 1, injectedInto: 2 }), 'T1 判定 → T2 生效')
eq('还没回注时按「判定回合 + 1」预告', turnPair({ turn: 3 }), 'T3 判定 → T4 生效')
eq('只有生效回合时只写生效', turnPair({ injectedInto: 5 }), 'T5 生效')
eq('两样都没有 → 占位符', turnPair({}), '—')
eq('undefined 不炸', turnPair(undefined), '—')
eq('null 不炸', turnPair(null), '—')
// 合并两侧数据后，会话侧独有的生效回合必须能被文案读到（而不是永远显示「判定回合+1」）。
const mergedWithInjection = mergeRounds(
  [{ seq: 9, time: 3000, turn: 3, emotion: '愧疚', intensity: 0.72, reason: '用户指出遗漏前提' }],
  hostHistory,
)
eq('合并后仍能读到真实生效回合', turnPair(mergedWithInjection[0]), 'T2 判定 → T3 生效')
eq('只有会话样本时按「生效回合 - 1」写出判定回合', turnPair(mergeRounds([{ seq: 9, time: 3000, turn: 3, emotion: '愧疚', intensity: 0.72 }], [])[0]), 'T2 判定 → T3 生效')

console.log('\n[8] 错位一轮回归：当前情绪必须取「已生效」的那一条，而不是 host 的待注入状态')
// 这正是用户报告的问题①：面板曾经把 host 当前强度（待注入）配到会话末条（已生效）上，
// 于是「情绪」来自上一轮、「强度/依据」来自下一轮，看着就错位了一轮。
const hostState = {
  sessionId: 's1',
  emotion: '挫败',
  intensity: 0.91,
  reason: '接下来的判定依据',
  source: 'llm',
  history: hostHistory,
  injectionPlan: { emotion: '挫败', intensity: 0.91, reason: '接下来的判定依据', source: 'llm', judgedTurn: 2, pending: true, willInjectAt: 3 },
}
const mixed = mergeRounds(sessionSamples, hostState.history)
const currentRow = mixed[mixed.length - 1]
eq('当前情绪取已生效行的强度', currentRow.intensity, 0.72)
check('绝不用 host 待注入强度覆盖已生效行', currentRow.intensity !== hostState.intensity)
eq('当前情绪取已生效行的情绪', currentRow.emotion, '愧疚')
check('待注入状态单独可读（供「下一回合将注入」那一行用）', hostState.injectionPlan.intensity === 0.91 && hostState.injectionPlan.willInjectAt === 3)
eq('逐轮明细每条都带依据', mixed.map((r) => r.reason !== undefined && r.reason !== ''), [true, true])
eq('依据文案不被截断成空', mixed[1].reason, '用户指出遗漏前提')

console.log('\n[9] 真渲染一遍逐轮明细（用户看到的就是这几个字）')
// 纯函数全绿也不代表界面对：这一段把面板组件真的渲染出来，检查
// ①每轮都写清「哪一轮判定、哪一轮生效」；②每轮都带自己的依据（问题①②的验收点）。
const panelText = T => ({ type: 'text', text: T })
// 文案照抄真实模板（lib/index.js:135 DEFAULT_TEMPLATE + :419 的判定依据拼法），
// 否则「依据」这一列测的是夹具的错，不是代码的错。
const injected = (emotion, intensity, reason) => `你当前的内在情绪状态是「${emotion}」，强度 ${intensity}（0-1）。判定依据：${reason}。这是你上一轮回答被评估后得到的情绪反馈，它属于你自己此刻的状态。`
const liveNodes = [
  { kind: 'user', seq: 5, time: 500, content: [panelText('第一条需求')], source: { kind: 'user' } },
  { kind: 'assistant', seq: 6, time: 600, blocks: [] },
  // 第一条回注落在回合 2：它是回合 1 收尾判出来的状态，回合 2 起手注入。
  { kind: 'user', seq: 9, time: 900, content: [panelText('第二条需求')], source: { kind: 'user' } },
  {
    kind: 'user',
    seq: 10,
    time: 1000,
    content: [panelText(injected('平静', '0.30', '开场寒暄'))],
    source: { kind: 'emotion-feedback' },
  },
  { kind: 'assistant', seq: 15, time: 1500, blocks: [] },
  { kind: 'user', seq: 18, time: 1800, content: [panelText('第三条需求')], source: { kind: 'user' } },
  {
    kind: 'user',
    seq: 20,
    time: 2000,
    content: [panelText(injected('愧疚', '0.72', '用户指出遗漏前提'))],
    source: { kind: 'emotion-feedback' },
  },
]
const liveHistory = [
  { turn: 1, judgedEmotion: '平静', judgedIntensity: 0.3, emotion: '平静', intensity: 0.3, reason: '开场寒暄', source: 'rule', injectedInto: 2 },
  { turn: 2, judgedEmotion: '愧疚', judgedIntensity: 0.5, emotion: '愧疚', intensity: 0.72, reason: '用户指出遗漏前提', source: 'rule', injectedInto: 3 },
]
const dockRegistered = []
const fakeCtx = {
  effect: () => ({ dispose() {} }),
  slots: {
    inject: (name, callback) => { dockRegistered.push(name); callback() },
    register: (slot, component) => { dockRegistered.push([slot.id, component]) },
  },
}
exported.apply(fakeCtx)
const registered = dockRegistered.find((item) => Array.isArray(item))[1]
// 槽位里注册的是**错误边界**（class），内层面板挂在它的 `inner` 上（函数组件渲染器
// 不能渲染 class，测试渲染内层；边界本身用它的静态方法/原型方法单独验证）。
const dock = typeof registered?.inner === 'function' ? registered.inner : registered
check('面板组件已注册到 conversation.composer.dock', typeof dock === 'function')
const isFuse = typeof registered === 'function' && registered.inner !== undefined
check('注册的是带保险丝的错误边界（拿不到 React.Component 时退化为原组件）', isFuse)
if (isFuse) {
  eq('错误边界的降级状态', registered.getDerivedStateFromError(), { failed: true })
  const fallback = registered.prototype.render.call({ state: { failed: true }, props: {} })
  check('边界在失败态渲染「情绪面板暂不可用」', textsOf(fallback).join(' ').includes('情绪面板暂不可用'))
  const normal = registered.prototype.render.call({ state: { failed: false }, props: {} })
  check('边界在正常态渲染内层面板', normal !== null && typeof normal === 'object' && normal.type === dock)
}
// host 快照走真实 HTTP 通道：判定原值、来源、依据都只有这里有（回注文案默认不带依据）。
// 注意会话级 `emotion/intensity` 故意取**与已生效样本不同**的「待注入」状态（0.91 挫败）：
// 这正是问题①的现场——面板若拿它当当前情绪，就会显示成上一轮/下一轮的状态。
setFetch(() => Promise.resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve({
    generatedAt: new Date(2000).toISOString(),
    sessions: [{
      sessionId: 's1',
      workspace: 'C:/w',
      emotion: '挫败',
      intensity: 0.91,
      reason: '这一轮刚判出来的',
      source: 'llm',
      turn: 2,
      updatedAt: new Date(2000).toISOString(),
      history: liveHistory,
      injectionPlan: { emotion: '挫败', intensity: 0.91, reason: '这一轮刚判出来的', source: 'llm', judgedTurn: 2, pending: true, willInjectAt: 3 },
    }],
  }),
}))
const view = renderElement(dock, {
  sessionId: 's1',
  useChat: (selector) => selector({ legacy: { nodes: liveNodes } }),
})
await view.runEffects()
if (process.env.EF_DEBUG === '1') {
  const dump = (node, depth = 0) => {
    if (Array.isArray(node)) return node.map((n) => dump(n, depth)).join('\n')
    if (node === null || node === undefined || typeof node !== 'object') return `${' '.repeat(depth)}${JSON.stringify(node)}`
    const cls = node.props !== undefined ? String(node.props.className ?? '') : ''
    const kids = (node.children ?? []).map((c) => dump(c, depth + 2)).join('\n')
    return `${' '.repeat(depth)}<${String(node.type)} class="${cls}" onClick=${typeof node.props?.onClick}>${kids ? '\n' + kids : ''}`
  }
  console.log(dump(view.tree))
}
check('折叠态只显示一个开关（还没展开）', textsOf(view.tree).includes('▲'))
// 闭合态就一眼能看到「当前情绪」：必须是**已生效**的那条（愧疚 0.72），
// 不能是 host 的待注入状态（挫败 0.91）——这一条就是问题①的守门用例。
const foldedText = textsOf(view.tree).join(' ')
check('折叠态显示的是已生效的情绪（愧疚）', foldedText.includes('愧疚'))
check('折叠态显示的是已生效的强度（0.72，不是 host 待注入的 0.91）', foldedText.includes('0.72') && !foldedText.includes('0.91'))
const clicked = view.click('ef-root')
eq('点开面板', clicked, true)
const expanded = view.tree
const seen = textsOf(expanded)
check('当前情绪行显示的是已生效的强度 0.72（问题①的界面验收点）', seen.includes('强度 0.72'))
eq('当前情绪行显示的是已生效的那条情绪', seen.includes('愧疚'), true)
// 「当前情绪」那一行必须是已生效行：它的「强度」格子不能是 host 的待注入值。
const liveRow = walk(expanded).find((n) => n !== null && typeof n === 'object' && String(n.props?.className ?? '') === 'ef-row'
  && textsOf(n).some((t) => typeof t === 'string' && t.startsWith('强度 ')))
eq('当前情绪行的强度格＝已生效值', liveRow === undefined ? [] : textsOf(liveRow).filter((t) => t.startsWith('强度 ')), ['强度 0.72'])
// 待注入状态只能出现在「下一回合」那一行，且明说「尚未发出」。
const planRow = walk(expanded).find((n) => n !== null && typeof n === 'object' && String(n.props?.className ?? '').includes('ef-row-plan'))
check('下一回合状态单独成行', planRow !== undefined)
check('待注入状态标了「尚未发出」，与当前情绪区分开',
  planRow !== undefined && textsOf(planRow).join(' ').includes('尚未发出'))
// 逐轮明细要按「行」检查：整棵树的文本里也包含顶部「依据」那一行，会数重。
const listNode = walk(expanded).find((n) => n !== null && typeof n === 'object' && String(n.props?.className ?? '') === 'ef-list')
check('逐轮明细列表已渲染', listNode !== undefined)
const listItems = listNode === undefined ? [] : walk(listNode).filter((n) => n !== null && typeof n === 'object' && n.type === 'li')
const cells = listItems.map((li) => textsOf(li))
eq('逐轮明细行数 = 合并后的回合数', cells.length, 2)
eq('每条都写「T{n} 判定 → T{m} 生效」', cells.map((c) => c[0]), ['T2 判定 → T3 生效', 'T1 判定 → T2 生效'])
eq('每条都带自己的依据', cells.map((c) => c[c.length - 2]), ['用户指出遗漏前提', '开场寒暄'])
check('依据不会被写成「无依据」', cells.every((c) => c[c.length - 2] !== '无依据'))
eq('每条都带生效时刻', cells.map((c) => c[c.length - 1]), ['08:00:02', '08:00:01'])

// host 路由不可达是**常态**（桌面端没有 webServer 时 fetch 直接失败，历史会话重启后也没有内存快照）：
// 这种情况下面板必须退回「只看会话数据」，而不是白屏或显示上一次的快照。
console.log('\n[10] host 快照不可达时的退化路径')
setFetch(() => Promise.reject(new Error('offline')))
const offlineView = renderElement(dock, {
  sessionId: 's1',
  useChat: (selector) => selector({ legacy: { nodes: liveNodes } }),
})
await offlineView.runEffects()
const offlineFolded = textsOf(offlineView.tree).join(' ')
check('离线时折叠态仍显示已生效的情绪与强度', offlineFolded.includes('愧疚') && offlineFolded.includes('0.72'))
check('离线时不显示「下一回合将注入」（那是 host 独有信息）', !offlineFolded.includes('下一回合'))
const offlineClicked = offlineView.click('ef-root')
eq('离线时也能点开', offlineClicked, true)
const offlineSeen = textsOf(offlineView.tree)
check('离线时当前情绪行仍取已生效值', offlineSeen.includes('强度 0.72'))
const offlineList = walk(offlineView.tree).find((n) => n !== null && typeof n === 'object' && String(n.props?.className ?? '') === 'ef-list')
const offlineCells = (offlineList === undefined ? [] : walk(offlineList).filter((n) => n !== null && typeof n === 'object' && n.type === 'li')).map((li) => textsOf(li))
eq('离线时逐轮明细仍逐条列出', offlineCells.length, 2)
eq('离线时依据来自回注正文（会话数据）', offlineCells.map((c) => c[c.length - 2]), ['用户指出遗漏前提', '开场寒暄'])
check('离线时不会给出 host 的判定原值行', !offlineSeen.some((t) => typeof t === 'string' && t === '判定原值'))

console.log('\n[11] 请求参数与宿主存档（DSH 重启后仍要看到历史回合的依据）')
// ①请求必须带上 sessionId：不带的话 host 只能返回「全部会话里的第一条」，
//   落盘回退也认不出该读哪一份存档——历史会话面板就会串到别的会话上。
const seenUrls = []
const archiveHistory = [
  { turn: 1, judgedEmotion: '平静', judgedIntensity: 0.3, emotion: '平静', intensity: 0.3, reason: '开场寒暄', source: 'rule', injectedInto: 2 },
  { turn: 2, judgedEmotion: '愧疚', judgedIntensity: 0.5, emotion: '愧疚', intensity: 0.72, reason: '用户指出遗漏前提', source: 'rule', injectedInto: 3 },
]
setFetch((url) => {
  seenUrls.push(String(url))
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      generatedAt: new Date(2000).toISOString(),
      sessions: [{
        sessionId: 's1',
        emotion: '愧疚',
        intensity: 0.72,
        reason: '用户指出遗漏前提',
        source: 'rule',
        turn: 2,
        updatedAt: new Date(2000).toISOString(),
        history: archiveHistory,
        // 内存里没有该会话（DSH 重启过）⇒ host 回落到插件自己的落盘明细。
        restoredFromDisk: true,
      }],
    }),
  })
})
const archiveView = renderElement(dock, {
  sessionId: 's1',
  useChat: (selector) => selector({ legacy: { nodes: liveNodes } }),
})
await archiveView.runEffects()
eq('请求带上 sessionId（否则 host 无法定位会话与存档）', seenUrls, ['/emotion-feedback/state?sessionId=s1'])
eq('点开存档面板', archiveView.click('ef-root'), true)
const archiveCells = (() => {
  const list = walk(archiveView.tree).find((n) => n !== null && typeof n === 'object' && String(n.props?.className ?? '') === 'ef-list')
  return (list === undefined ? [] : walk(list).filter((n) => n !== null && typeof n === 'object' && n.type === 'li')).map((li) => textsOf(li))
})()
eq('重启后逐轮明细仍逐条列出', archiveCells.length, 2)
eq('重启后每轮依据仍在', archiveCells.map((c) => c[c.length - 2]), ['用户指出遗漏前提', '开场寒暄'])
eq('重启后「判定 → 生效」仍对得上', archiveCells.map((c) => c[0]), ['T2 判定 → T3 生效', 'T1 判定 → T2 生效'])
check('存档来源被标注（用户能分辨「来自宿主存档」而不是当前进程快照）',
  textsOf(archiveView.tree).join(' ').includes('host 存档'))
check('存档里没有 injectionPlan 时不编造「下一回合将注入」',
  !textsOf(archiveView.tree).some((t) => typeof t === 'string' && t.includes('下一回合')))

console.log('\n[12] 活跃进程快照的真实形状：明细在 samples 里，history 只有情绪+强度')
// 这一节复现**用户报告的问题②在修复前的现场**。上面 [9]–[11] 给的都是「富 history」，
// 而真正跑着的 DSH 返回的快照是：`samples` 带判定原值/来源/依据/生效回合，
// `history` 只是压缩过的 {turn, emotion, intensity}（lib/index.js:735 那一次 push）。
// 客户端只读 history ⇒ 每一行都只能写「无依据」。默认配置 includeReason=false
// 时回注正文也不带依据，所以除了 samples 没有第二个来源。
const liveClientSamples = [
  { seq: 3, time: 1000, turn: 2, emotion: '平静', intensity: 0.3, reason: '开场寒暄' },
  { seq: 9, time: 3000, turn: 3, emotion: '愧疚', intensity: 0.72, reason: '用户指出遗漏前提' },
]
// 活跃快照的 samples：前两条已注入，**第三条刚判出、还没注入**（回合 4 起手才发）。
const liveSamples = [
  { turn: 1, judgedEmotion: '平静', judgedIntensity: 0.3, emotion: '平静', intensity: 0.3, reason: '开场寒暄', source: 'rule', injectedInto: 2 },
  { turn: 2, judgedEmotion: '愧疚', judgedIntensity: 0.5, emotion: '愧疚', intensity: 0.72, reason: '用户指出遗漏前提', source: 'rule', injectedInto: 3 },
  { turn: 3, judgedEmotion: '挫败', judgedIntensity: 0.91, emotion: '挫败', intensity: 0.91, reason: '这一轮刚判出来的', source: 'llm' },
]
const compactHistory = [
  { turn: 1, emotion: '平静', intensity: 0.3 },
  { turn: 2, emotion: '愧疚', intensity: 0.72 },
  { turn: 3, emotion: '挫败', intensity: 0.91 },
]
const reasonOf = (row) => (row.reason === undefined || row.reason === '' ? '无依据' : row.reason)
// 反证：只读压缩 history 时，host 独有、还没进对话的那一条没有任何依据可读（现场）。
eq('只读压缩 history 时最新判定的依据丢失',
  mergeRounds(liveClientSamples, compactHistory).map(reasonOf),
  ['开场寒暄', '用户指出遗漏前提', '无依据'])
eq('只读 samples 时依据齐全', mergeRounds(liveClientSamples, liveSamples).map(reasonOf),
  ['开场寒暄', '用户指出遗漏前提', '这一轮刚判出来的'])
eq('未注入的最新判定按「回合 4 生效」预告',
  mergeRounds(liveClientSamples, liveSamples).map((r) => r.effectiveTurn), [2, 3, 4])
eq('「当前情绪」跳过还没生效的末行', lastAppliedRound(mergeRounds(liveClientSamples, liveSamples)).turn, 2)
eq('「当前情绪」跳过还没生效的末行（强度也不取它）',
  lastAppliedRound(mergeRounds(liveClientSamples, liveSamples)).intensity, 0.72)

setFetch(() => Promise.resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve({
    generatedAt: new Date(2000).toISOString(),
    sessions: [{
      sessionId: 's1',
      workspace: 'C:/w',
      emotion: '挫败',
      intensity: 0.91,
      reason: '这一轮刚判出来的',
      source: 'llm',
      turn: 3,
      updatedAt: new Date(2000).toISOString(),
      samples: liveSamples,
      history: compactHistory,
      injectionPlan: { emotion: '挫败', intensity: 0.91, reason: '这一轮刚判出来的', source: 'llm', judgedTurn: 3, pending: true, willInjectAt: 4 },
    }],
  }),
}))
const liveSampleView = renderElement(dock, {
  sessionId: 's1',
  useChat: (selector) => selector({ legacy: { nodes: liveNodes } }),
})
await liveSampleView.runEffects()
const liveSampleFolded = textsOf(liveSampleView.tree).join(' ')
check('折叠态当前情绪 = 最近一次已生效的那条（愧疚 0.72）',
  liveSampleFolded.includes('愧疚') && liveSampleFolded.includes('0.72'))
check('还没发出的 0.91 不冒充当前情绪', !liveSampleFolded.includes('0.91'))
eq('点开活跃快照面板', liveSampleView.click('ef-root'), true)
const liveSampleSeen = textsOf(liveSampleView.tree)
const liveSampleList = walk(liveSampleView.tree).find((n) => n !== null && typeof n === 'object' && String(n.props?.className ?? '') === 'ef-list')
const liveSampleCells = (liveSampleList === undefined ? [] : walk(liveSampleList).filter((n) => n !== null && typeof n === 'object' && n.type === 'li')).map((li) => textsOf(li))
eq('活跃快照下逐轮明细仍逐条带依据', liveSampleCells.map((c) => c[c.length - 2]),
  ['这一轮刚判出来的', '用户指出遗漏前提', '开场寒暄'])
check('活跃快照下没有任何一行写成「无依据」', !liveSampleSeen.includes('无依据'))
const livePlanRow = walk(liveSampleView.tree).find((n) => n !== null && typeof n === 'object' && String(n.props?.className ?? '').includes('ef-row-plan'))
const livePlanText = livePlanRow === undefined ? '' : textsOf(livePlanRow).join(' ')
check('「下一回合」那一行写的是判定回合 N3（不是生效回合 N4）', livePlanText.includes('回合 N3 判定'))
check('「下一回合」那一行同时写出生效回合', livePlanText.includes('→ 回合 N4 生效'))
check('「下一回合」那一行的依据看得见，不是只挂在 title 上', livePlanText.includes('依据：这一轮刚判出来的'))

console.log('\n[13] 鲁棒性：坏形状只允许降级，不允许抛出去（面板崩 = 对话视图崩）')
// 这一节喂的全是**本插件无法控制的输入**：外壳给的会话节点、HTTP 拿回来的快照。
// 只要有一处抛错，真 React 就会把整个会话视图一起带走，所以这里的验收标准是
// 「不抛 + 还能显示出可读内容」，而不是「显示得对」。
const hostile = [
  ['整包 sessions 不是数组', { generatedAt: 'x', sessions: 'oops' }],
  ['会话字段全是坏类型', { sessions: [{ sessionId: 's1', samples: 'oops', history: 'oops', injectionPlan: 'oops', emotion: 42, intensity: 'x', workspace: 7, updatedAt: 5 }] }],
  ['samples 混进 null/数字/字符串', { sessions: [{ sessionId: 's1', samples: [null, 3, 'x', { turn: 'x', emotion: null, intensity: null, reason: {} }] }] }],
  ['history 条目缺字段（旧存档）', { sessions: [{ sessionId: 's1', history: [{ turn: 2 }, null] }] }],
  ['reason 是对象', { sessions: [{ sessionId: 's1', samples: [{ turn: 2, emotion: '愧疚', intensity: 0.7, reason: { nested: 1 } }] }] }],
  ['injectionPlan 字段坏类型', { sessions: [{ sessionId: 's1', samples: [{ turn: 2, emotion: '好奇', intensity: 0.5 }], injectionPlan: { emotion: '挫败', intensity: 'x', judgedTurn: 'x', willInjectAt: null, source: 9 } }] }],
  ['sessions 里混进 null', { sessions: [null, { sessionId: 's1', samples: [{ turn: 3, emotion: '平静', intensity: 0.4 }] }] }],
  ['sessions 为空', { generatedAt: 'x', sessions: [] }],
]
const renderHostile = async (payload) => {
  setFetch(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }))
  const view = renderElement(dock, {
    sessionId: 's1',
    useChat: (selector) => selector({ legacy: { nodes: liveNodes } }),
  })
  try {
    await view.runEffects()
    view.click('ef-root')
  } catch (error) {
    return { message: error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error), text: '' }
  }
  return { message: undefined, text: textsOf(view.tree).join(' ') }
}
for (const [name, payload] of hostile) {
  const { message } = await renderHostile(payload)
  check(`坏快照不抛错：${name}`, message === undefined, message ?? '')
}
// 坏类型经兜底后仍要显示出人看得懂的东西（而不是空白或 [object Object]）。
const objectReason = await renderHostile(hostile[4][1])
check('对象型 reason 收成「无依据」而不是 [object Object]',
  objectReason.message === undefined && objectReason.text.includes('无依据'), objectReason.text)
check('对象型 reason 不影响同一行的情绪名', objectReason.text.includes('愧疚'), objectReason.text)
// 渲染路径上的哈希：`colorOf(undefined)` 曾经是 `text.length` 的 TypeError，
// 而情绪名可能来自 host payload（null/数字/对象都合法地到得了这里）。
const colorResults = []
let colorThrew
for (const value of [undefined, null, 42, {}, [], '愧疚']) {
  try { colorResults.push(colorOf(value)) } catch (error) { colorThrew = String(error && error.message ? error.message : error) }
}
check('colorOf 对 undefined/null/数字/对象/数组都不抛', colorThrew === undefined, colorThrew ?? '')
check('colorOf 总是给出可用的颜色字符串', colorResults.every((value) => typeof value === 'string' && value.length > 0), JSON.stringify(colorResults))
// 合并层：数组里混进 null 不能让 `.turn` 抛（host payload / 存档都可能有缺口）。
eq('mergeRounds 跳过 null 与基础类型条目', mergeRounds([null, 3, 'x'], [null, 7, 'y']).length, 0)
eq('mergeRounds 保留坏条目旁边的正常条目', mergeRounds([null, { turn: 2, emotion: '平静', intensity: 0.4 }], []).length, 1)
eq('lastAppliedRound 对非数组/空数组返回 undefined', [lastAppliedRound('x'), lastAppliedRound(null), lastAppliedRound([])], [undefined, undefined, undefined])
eq('lastAppliedRound 全是无主行时退回最后一行', lastAppliedRound([{ id: 'a' }, { id: 'b' }]).id, 'b')
eq('samplesOf 对垃圾节点数组返回空', samplesOf([null, 1, 'x', {}, { source: { kind: 'user' } }]), [])
eq('parseInjection 对非字符串返回 undefined', [parseInjection(undefined), parseInjection(42), parseInjection({})], [undefined, undefined, undefined])
eq('turnPair/effectiveLabel 对空值有兜底', [turnPair(undefined), turnPair(null), effectiveLabel(undefined)], ['—', '—', '最近一次回注'])

console.log(`\n面板数据层回归：${passed} passed, ${failed} failed`)
if (process.env.DSH_EMOTION_TEST_RESULT) {
  writeFileSync(process.env.DSH_EMOTION_TEST_RESULT, JSON.stringify({
    suite: 'panel-data', total: passed + failed, failed: failedCases,
  }, null, 2))
}
if (failed > 0) process.exitCode = 1
