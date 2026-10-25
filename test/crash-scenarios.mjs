/**
 * 崩溃场景回归测试（用真实 @deepseek-ai/cordis + 真实 @deepseek-ai/dsh-scope 派发）。
 *
 * 背景：宿主 `$NPX/dsh-agent-loop/lib/index.js:920` 会执行
 *   `if (decision.kind === "reject") return decision;`
 * 所以只要某个 `agent/pre-step` 监听器让 `decision` 变成 undefined，
 * 整个回合就会在 `step/start` 之前以
 * `Cannot read properties of undefined (reading 'kind')` 失败
 * （会话日志表现：turn/start → turn/end error，零 step）。
 *
 * 本文件验证：无论下游监听器返回 undefined / null / 非对象，还是抛异常，
 * 本插件的监听器都**必须**交回一个合法决策对象，让宿主的读取点永远不抛。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 用绝对 file:// 导入真实 cordis + dsh-scope（profile 的 node_modules 里没有它们，
// 只有 schemastery）。这份构建与宿主 asar 内的同源，见 README 的「取证」段落。
import { Context } from 'file:///C:/Users/Lenovo/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js'
import { createScope, scopeTarget } from 'file:///C:/Users/Lenovo/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-scope/lib/index.js'
import { apply, Config, name } from '../lib/index.js'

// 面板历史落盘默认写到 `<DSH_HOME>/emotion-feedback/history`。测试必须改道到临时目录：
// 否则既会污染用户真实数据，在沙箱里也会因工作区外写入被拒而刷出 EPERM 警告。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ef-history-crash-'))

const results = []
const test = async (title, fn) => {
  try {
    await fn()
    results.push({ title, ok: true })
    console.log(`  ok   ${title}`)
  }
  catch (error) {
    results.push({ title, ok: false, error })
    console.log(`  FAIL ${title}\n       ${error?.message}`)
  }
}

/**
 * 去掉源码里的注释，供「源码扫描」用例使用。
 * 先剥 `/** … *\/` 块注释，再剥整行 `//` 与行内 `//` 之后的尾巴：
 * 本仓库的文档注释一律以 `//` 或 `/**` 起行，这样既不会把注释里保留的旧写法
 * 误判成真实调用，也不会踩 `https://` 这类字面量。
 */
function stripCodeComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line.split('//')[0]))
    .join('\n')
}

/** 最小宿主桩：logger / llm / agentDefaultModel + 一个 agent scope。 */function makeHost(configOverrides = {}) {
  const root = new Context()
  const lines = []
  // 宿主日志桩：logger 既是函数（logger('scope') → 子 logger）又带 info/warn/debug 方法。
  const mkLogger = () => {
    const sink = (...a) => lines.push(['log', ...a])
    sink.info = (...a) => lines.push(['info', ...a])
    sink.warn = (...a) => lines.push(['warn', ...a])
    sink.debug = (...a) => lines.push(['debug', ...a])
    sink.error = (...a) => lines.push(['error', ...a])
    sink.extend = () => mkLogger()
    return sink
  }
  root.logger = mkLogger()
  root.provide('llm', {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"emotion":"愧疚","intensity":0.7,"reason":"x"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  root.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  const config = new Config({ judgeProvider: 'p', judgeModel: 'm', ...configOverrides })
  // 与宿主一致：插件在根 ctx 上注册。
  const api = apply(root, config)
  // 现实快照：只含真正的宿主事件类型。本插件的历史类型 `emotion-feedback/state`
  // 属于**被删掉的**宿主类型，现实中不会出现在快照里，所以不能把它塞进来。
  api.setKnownTypesSourceForTest(() => new Set(['user/message', 'assistant/message']))
  // 与宿主一致：每个 agent 有独立 scope，carrier = scopeTarget(agent, agent)。
  const agent = { id: 'sess-1' }
  const scoped = createScope(root, agent)
  return { root, config, api, lines, agentKey: agent, agentCtx: scoped.ctx }
}

/** 造一个真实形状的 agent：session.log 里 turn 1 说了一句会被关键词命中的话。 */
function makeAgent(host) {
  const log = [
    { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '抱歉，是我的问题。' }] },
      },
    },
    { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = {
    id: 'sess-1',
    log,
    deriveMessages: () => log.filter((e) => e.type === 'assistant/message').map((e) => e.data.message),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  return { id: 'sess-1', session, options: { provider: 'p', model: 'm' }, ctx: host.agentCtx, steer() {} }
}

const claimedOf = () => [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user', rpcId: 'r1' } }]

/** 用真实 scoped 派发一次 agent/pre-step 瀑布。 */
function dispatchPreStep(host, liveAgent, { turn = 2, step = 1, claimed = claimedOf(), inner } = {}) {
  const carrier = scopeTarget(host.agentKey, host.agentKey)
  const fallback = () => Promise.resolve({ kind: 'enter', messages: [...claimed] })
  return host.root.waterfall(
    carrier,
    'agent/pre-step',
    { messages: claimed, agent: liveAgent, turn, step, signal: new AbortController().signal },
    inner ?? fallback,
  )
}

/** 用真实 scoped 派发一次 agent/turn-stopping。 */
function stopTurn(host, liveAgent, turn = 1) {
  const carrier = scopeTarget(host.agentKey, host.agentKey)
  return host.root.serial(carrier, 'agent/turn-stopping', { agent: liveAgent, turn, signal: new AbortController().signal })
}

console.log(`# ${name} 崩溃场景回归（真实 cordis + dsh-scope 派发）`)

// ① 判定一次（关键词层命中「抱歉」→ 愧疚），让状态就绪。
await test('前置：回合 1 判定出状态', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  const state = host.api.currentState('sess-1')
  assert.equal(state?.emotion, '愧疚', JSON.stringify(state))
  assert.equal(state?.source, 'rule')
})

// ② 正常路径：仍然注入，且返回对象。
await test('正常：回注合成消息且返回合法决策', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  const decision = await dispatchPreStep(host, agent)
  assert.equal(typeof decision, 'object')
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, JSON.stringify(decision.messages.map((m) => m.source)))
  assert.equal(decision.messages[1].source.kind, 'emotion-feedback')
})

// ③ 最内层返回 undefined → 本插件必须兜底成 enter 决策（而不是把 undefined 交回宿主）。
await test('下游返回 undefined：兜底为合法 enter 决策', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  const decision = await dispatchPreStep(host, agent, { inner: () => Promise.resolve(undefined) })
  assert.equal(typeof decision, 'object', '必须返回对象')
  assert.equal(decision.kind, 'enter', decision.kind)
  assert.ok(Array.isArray(decision.messages), 'messages 必须是数组')
  assert.ok(host.lines.some(([level, text]) => level === 'warn' && String(text).includes('非对象决策')), `应打印取证日志：${JSON.stringify(host.lines)}`)
})

// ④ 下游 next() 抛异常 → 本插件必须捕获并交回合法决策。
await test('下游 next() 抛异常：捕获并交回合法 enter 决策', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  const decision = await dispatchPreStep(host, agent, { inner: () => { throw new Error('boom from downstream') } })
  assert.equal(typeof decision, 'object')
  assert.equal(decision.kind, 'enter')
  assert.ok(host.lines.some(([level, text]) => level === 'warn' && String(text).includes('boom from downstream')), `取证日志应含真实错误消息：${JSON.stringify(host.lines)}`)
})

// ⑤ 下游返回 null / 字符串 / 数字 / 布尔，一律兜底。
await test('下游返回 null/字符串/数字/布尔：一律兜底', async () => {
  for (const bad of [null, 'enter', 42, true]) {
    const host = makeHost()
    const agent = makeAgent(host)
    await stopTurn(host, agent, 1)
    const decision = await dispatchPreStep(host, agent, { inner: () => Promise.resolve(bad) })
    assert.equal(typeof decision, 'object', `bad=${String(bad)} 必须兜底成对象`)
    assert.equal(decision.kind, 'enter')
    assert.ok(Array.isArray(decision.messages))
  }
})

// ⑥ 复刻宿主的读取点：`decision.kind === 'reject'` 不能抛。
await test('复刻宿主读取点 decision.kind 不抛错', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  const decision = await dispatchPreStep(host, agent, { inner: () => Promise.resolve(undefined) })
  // 宿主 $NPX/dsh-agent-loop/lib/index.js:920 原文
  assert.doesNotThrow(() => {
    if (decision.kind === 'reject') return decision
  })
})

// ⑦ disabled 开关：立刻停用，但仍交回合法决策。
await test('disabled: true 时不注入、仍返回合法决策', async () => {
  const host = makeHost({ disabled: true })
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  const decision = await dispatchPreStep(host, agent)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1, '停用时不应注入')
})

// ⑧ 与 agent-scope 内的监听器串联（复刻 dsh-agent 的 installModelSelection 位置）。
await test('与 agent-scope 监听器串联时决策链路完整', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  let seen
  host.agentCtx.on('agent/pre-step', async ({ messages, signal, step }, next) => {
    const decision = await next()
    seen = decision
    assert.equal(decision.kind, 'enter')
    assert.ok(Array.isArray(decision.messages))
    return decision
  }, { prepend: true })
  const decision = await dispatchPreStep(host, agent)
  assert.equal(decision.kind, 'enter')
  assert.equal(seen?.kind, 'enter', 'agent-scope 监听器必须看到合法决策')
  assert.equal(seen.messages.length, 2)
})

// ⑨ 每个会话的护栏互相隔离（回归「模块级变量污染」那个 bug）。
await test('两个会话的同一回合号互不抑制', async () => {
  const host = makeHost()
  const a = makeAgent(host)
  await stopTurn(host, a, 1)
  const da = await dispatchPreStep(host, a, { turn: 2 })
  assert.equal(da.messages.length, 2, 'A 会话应注入')
  const b = { ...makeAgent(host), id: 'sess-2', session: { ...makeAgent(host).session, id: 'sess-2' } }
  // 让 B 会话也有状态：直接复用 A 的判定逻辑（关键词层即可）。
  const logB = [
    { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '抱歉，是我的问题。' }] } } },
  ]
  b.session = { id: 'sess-2', log: logB, deriveMessages: () => [], requestHeader: () => undefined }
  await stopTurn(host, b, 1)
  const db = await dispatchPreStep(host, b, { turn: 2 })
  assert.equal(db.messages.length, 2, 'B 会话也应注入（不能被 A 的回合号挡住）')
})

// ⑩ 复刻真实邻居插件（dsh-preset-anchored-standard/presets/anchored-standard/tool-bootstrap.mjs:296-338）：
//    它在最外层 prepend，无保护读 decision.kind（:298-299），catch 里 (:333-337) 又把这个 undefined 的
//    decision 原样交回宿主。它与本插件的监听器串联时，链路必须仍交出合法决策。
await test('与最外层「无保护读 kind」的邻居串联时，链路仍交出合法决策', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  await stopTurn(host, agent, 1)
  host.agentCtx.on('agent/pre-step', async (_payload, next) => {
    let decision
    try {
      decision = await next()
      if (decision.kind === 'reject') return decision
    } catch {
      return decision
    }
    return decision
  }, { prepend: true })
  const decision = await dispatchPreStep(host, agent, { inner: async () => undefined })
  assert.equal(decision.kind, 'enter', JSON.stringify(decision))
  assert.ok(Array.isArray(decision.messages))
})

// ⑪ 会话事件契约（2026-10-11 现场故障的回归）：
//    宿主读日志时逐条校验 `!KNOWN_SESSION_EVENT_TYPES.has(type) && ignorable !== true` ⇒ 拒绝解释**整个日志**，
//    GUI 报「历史加载失败 / resume failed … unknown to this harness and not marked ignorable」。
//    而 `Session.append(type, data, ...opts)` 无法设置 ignorable ⇒ 插件**一个自定义事件类型都不能写**。
//    本用例给会话桩装上记录型 append：判定 + 回注之后必须一条会话事件都没写。
await test('契约：插件不向会话日志写任何自定义事件类型', async () => {
  const host = makeHost()
  const agent = makeAgent(host)
  const appended = []
  agent.session.append = (type, data, ...opts) => {
    appended.push({ type, data, opts })
    return appended.length
  }
  await stopTurn(host, agent, 1)
  await dispatchPreStep(host, agent)
  assert.deepEqual(
    appended.map((item) => item.type),
    [],
    `插件写了会话事件，会让日志无法重新打开：${JSON.stringify(appended.map((item) => item.type))}`,
  )
})

// ⑫ 硬护栏（2026-10-11 加固）：即使有人把写入放回去，`guardedAppend` 也必须在写入前拦住。
//    这里**故意**调用插件记录的禁用类型，断言「守卫拒绝 + session.append 没被触碰」。
//    反向对照放在用例⑬：证明这套断言真的具有区分力（合法类型在同一条路径上确实会通过）。
await test('护栏：禁用类型（emotion-feedback/state）在写入前被拒绝', async () => {
  const host = makeHost()
  const appended = []
  host.api.setKnownTypesSourceForTest(() => new Set(['user/message', 'assistant/message']))
  const session = { id: 's1', append: (type, data, ...opts) => { appended.push({ type, data, opts }); return appended.length } }
  const written = host.api.guardedAppend(session, 'emotion-feedback/state', { turn: 1, emotion: '焦虑' })
  assert.equal(written, false, '禁用类型必须被拒绝')
  assert.deepEqual(appended, [], `护栏没拦住：${JSON.stringify(appended)}`)
  // 反向对照：同一个 session、同一套桩，换成白名单内类型就会真的写进去。
  const writtenOk = host.api.guardedAppend(session, 'user/message', { text: 'x' })
  assert.equal(writtenOk, true, '白名单内的类型应当被放行（否则本用例没有区分力）')
  assert.equal(appended.length, 1, '白名单内的类型应当真的落到 session.append')
  assert.equal(appended[0].type, 'user/message')
})

// ⑬ 黑名单是独立的第二道防线（不是重复代码）：万一「已知类型快照」过期、
//    或将来 harness 把某个旧类型加回白名单，黑名单**仍然**必须拒绝它。
//    反过来说，删掉黑名单判定时本用例必须变红 —— 突变测试（_diag\mutation-guard.mjs）已验证这一点。
await test('护栏：即便快照把禁用类型当已知类型，也必须拒绝', async () => {
  const appended = []
  const session = { id: 's-stale', append: (type, data, ...opts) => { appended.push({ type, data, opts }); return appended.length } }
  const hostStale = makeHost()
  // 故意把禁用类型混进快照 ⇒ 白名单判定会放行，只有黑名单能拦住。
  hostStale.api.setKnownTypesSourceForTest(() => new Set(['user/message', 'emotion-feedback/state']))
  assert.equal(
    hostStale.api.guardedAppend(session, 'emotion-feedback/state', { turn: 1 }),
    false,
    '黑名单类型必须被拒绝，哪怕快照里出现了它',
  )
  assert.deepEqual(appended, [], `黑名单没拦住：${JSON.stringify(appended)}`)
})

// ⑭ 护栏的第二道防线：快照里查不到的类型也必须拒绝；连快照都读不到时**保守全拒**。
//    2026-10-11 补充：注入来源**给不出**可用快照时不得回落磁盘（见用例⑯）。
await test('护栏：未知类型与「快照读不到」都必须拒绝', async () => {
  const appended = []
  const session = { id: 's2', append: (type, data, ...opts) => { appended.push({ type, data, opts }); return appended.length } }
  const hostA = makeHost()
  hostA.api.setKnownTypesSourceForTest(() => new Set(['user/message']))
  assert.equal(hostA.api.guardedAppend(session, 'some-plugin/invented-event', { a: 1 }), false, '白名单外的类型必须拒绝')
  // 显式带 ignorable:true 是契约允许的唯一例外。
  assert.equal(hostA.api.guardedAppend(session, 'some-plugin/invented-event', { a: 1 }, { ignorable: true }), true, '带 ignorable:true 的未知类型应当放行')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].opts[0].ignorable, true)
  // 快照完全读不到 ⇒ 保守：一个会话事件都不写。
  const hostB = makeHost()
  hostB.api.setKnownTypesSourceForTest(() => undefined)
  const before = appended.length
  assert.equal(hostB.api.guardedAppend(session, 'user/message', { text: 'y' }), false, '快照缺失时应当保守拒绝')
  assert.equal(appended.length, before, '快照缺失时不应写入任何事件')
  // 参数形状不对也不能抛出去（不能因为护栏本身把回合搞崩）。
  assert.equal(hostB.api.guardedAppend(undefined, 'user/message', {}), false)
  assert.equal(hostB.api.guardedAppend({}, 'user/message', {}), false)
  assert.equal(hostB.api.guardedAppend(session, '', {}), false)
})

// ⑮ 快照发现链必须走通**生产相对布局**（2026-10-11 回归，静默降级最危险的那种故障）。
//    故障形态：搜索深度曾经只到 `lib` 的上三级，而本轮生产布局里快照在 `dsh-work\_diag`
//    即上**四级**（profiles\desktop\node_modules\dsh-emotion-feedback 是 Junction →
//    dsh-work\bigfish's\emotions，插件文件在 …\emotions\lib）。于是磁盘发现**恒失败**，
//    guardedAppend 保守拒绝一切写入 —— 不报错、不崩溃，只是静默什么都不做。
//
//    2026-10-11 打包分发时改写：原用例直接依赖开发机上的 `dsh-work\_diag\known-event-types.json`
//    （**包外**文件），换台机器或换个目录就恒红。现在把「同深度布局」自建进临时目录，
//    用发现链的测试参数 `from` 指过去 ⇒ 任何机器上都能验证深度语义；
//    开发机上有真快照时再顺带端到端验一遍，没有就只提示、不判失败。
await test('护栏：快照发现链按生产相对布局走通（自建同深度布局 + 真实布局）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ef-layout-'))
  try {
    // 与生产同深度：`from` 是插件 lib 目录，快照在它的上四级（`from` 的 ../../../_diag）。
    const from = join(root, "bigfish's", 'emotions', 'lib')
    mkdirSync(from, { recursive: true })
    const diag = join(root, '_diag')
    mkdirSync(diag, { recursive: true })
    const types = Array.from({ length: 24 }, (_, i) => `synthetic/type-${i}`)
    types[0] = 'user/message'
    types[1] = 'assistant/message'
    writeFileSync(join(diag, 'known-event-types.json'), JSON.stringify({ types }))

    const hostD = makeHost()
    hostD.api.setKnownTypesSourceForTest(undefined) // 还原成「没注入，去磁盘找」
    const found = hostD.api.discoverKnownSessionEventTypesFromDisk(from)
    assert.ok(found !== null, '自建同深度布局下必须找到 _diag\\known-event-types.json（深度被砍浅即变红）')
    assert.ok(found.size > 20, `快照条数应当是一份真快照，实为 ${found.size}`)
    assert.ok(found.has('user/message'), '快照里必须含真实的宿主类型 user/message')

    // 反向对照：快照不在时必须判「读不到」——证明刚才真的在读这一份，
    // 而不是因为 `from` 被忽略、碰巧命中了别处（比如开发机上的真快照）。
    rmSync(join(diag, 'known-event-types.json'))
    assert.equal(hostD.api.discoverKnownSessionEventTypesFromDisk(from), null, '快照不在时必须判「读不到」')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }

  // 结构断言（与布局无关）：搜索深度必须覆盖到第四级。
  // 运行时发现链能走通、是因为当前布局恰好也在浅层留了一条路；
  // 深度只要被砍回三级，换到生产布局（快照只在上四级）就恒失败。
  // 这条断言让「-1 深度」这个突变必然变红（见 _diag\mutation-guard.mjs）。
  const libSource = stripCodeComments(readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8'))
  const depthLine = libSource.split('\n').find((line) => line.includes('const bases = [here'))
  assert.ok(depthLine, '应当能找到 bases 深度声明')
  // 逐级写法是 join(here, '..', …)：`here` 之后每多一层就多一个 join ⇒ 3 个即到四级。
  assert.equal(
    (depthLine.match(/join\(here/g) ?? []).length,
    3,
    `bases 必须逐级到 lib 的上四级（即 3 个 join），实际：${depthLine.trim()}`,
  )

  // 真实布局（只有开发机才有 `dsh-work\_diag`）：有就再端到端验一遍。
  const hostReal = makeHost()
  hostReal.api.setKnownTypesSourceForTest(undefined)
  const real = hostReal.api.discoverKnownSessionEventTypesFromDisk()
  if (real === null) {
    console.log('       （本机没有 _diag 快照 ⇒ 跳过真实布局端到端断言；自建同深度布局已覆盖发现链）')
  }
  else {
    assert.ok(real.size > 20, `真实快照条数应当是一份真快照，实为 ${real.size}`)
    assert.ok(real.has('user/message'), '快照里必须含真实的宿主类型 user/message')
    assert.equal(real.has('emotion-feedback/state'), false, '被删掉的宿主类型不该出现在快照里')
    // 端到端：真实布局下，合法类型真的写得进去（这才叫「不降级」）。
    const appended = []
    const session = { id: 's3', append: (type) => { appended.push(type); return appended.length } }
    assert.equal(hostReal.api.guardedAppend(session, 'user/message', { text: 'ok' }), true, '真实快照下合法类型必须放行')
    assert.deepEqual(appended, ['user/message'])
  }
})

// ⑯ 注入来源给不出可用快照时，**不得回落到磁盘**。
//    否则测试里注入 `{}` / 坏路径会被静默忽略、改用本机真快照，
//    「快照缺失 ⇒ 保守全拒」这类断言就变成假绿（测的是别的东西）。
await test('护栏：坏注入判「读不到」，不得静默回落磁盘真快照', async () => {
  const appended = []
  const session = { id: 's4', append: (type) => { appended.push(type); return appended.length } }
  for (const bad of [{}, '', 42, true, () => undefined]) {
    const host = makeHost()
    host.api.setKnownTypesSourceForTest(bad)
    assert.equal(
      host.api.guardedAppend(session, 'user/message', { text: 'x' }),
      false,
      `注入 ${typeof bad === 'function' ? '()=>undefined' : JSON.stringify(bad)} 时应判「读不到」并保守拒绝`,
    )
  }
  assert.equal(appended.length, 0, '坏注入下不应写入任何会话事件')

  // 取证日志：判「读不到」时必须留下痕迹，否则线上只能看到「护栏静默什么都不做」。
  const hostLog = makeHost()
  hostLog.api.setKnownTypesSourceForTest({})
  hostLog.api.guardedAppend(session, 'user/message', { text: 'x' })
  assert.ok(
    hostLog.lines.some(([level, text]) => level === 'warn' && String(text).includes('注入的已知类型快照不可用')),
    `坏注入应当留下 warn 取证日志：${JSON.stringify(hostLog.lines)}`,
  )
})

// ⑰ 防绕过：源码扫描。护栏只在「所有写入都走它」时才有意义，
//    所以这里直接读源码，断言不存在任何 `xxx.append(` 的直接会话写入。
//    反向对照说明：把 `guardedAppend(session, '…')` 改回 `session.append('…')` 时本用例会失败。
await test('契约：lib/index.js 里不存在绕过护栏的 session.append 调用', async () => {
  const host0 = makeHost()
  const file = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const source = readFileSync(file, 'utf8')
  const code = stripCodeComments(source)
  const calls = [...code.matchAll(/session\s*\.\s*append\s*\(\s*([^,)]*)/g)]
  // 护栏内部**必须**恰好有两处真实写入：显式 ignorable:true 的例外路径，与白名单内路径。
  // 多出来的每一处都是绕过护栏的直写，正是 2026-10-11 故障的成因。
  assert.equal(
    calls.length,
    2,
    `lib/index.js 里 session.append 调用点应为 2 处（护栏内部），实为 ${calls.length} 处 —— 多出来的都是绕过护栏的直写`,
  )
  // 逐调用点检查第一个实参：任何被硬编码的禁用类型都必须触发本用例失败。
  // 注意不能拿 `emotion-feedback/state` 做全文计数：同一个字符串也是**合法的**
  // HTTP 路由（`PANEL_ROUTE = '/emotion-feedback/state'`），它在源码里出现很多次。
  for (const call of calls) {
    const firstArg = call[1].trim()
    const line = code.slice(0, call.index ?? 0).split('\n').length
    assert.ok(
      !/^(?:'|"|`)/.test(firstArg),
      `第 ${line} 行把会话事件类型硬编码了（${firstArg}）：这里的类型不可信，必须走黑名单与白名单两重判定`,
    )
    for (const forbidden of host0.api.forbiddenSessionEventTypes()) {
      assert.ok(
        !firstArg.includes(forbidden),
        `第 ${line} 行的 session.append 又把禁用类型「${forbidden}」写回去了`,
      )
    }
  }
  assert.ok(code.includes('const guardedAppend ='), 'lib/index.js 里应当存在 guardedAppend 护栏')
  // 反向对照：确认我们**不是**靠删掉旧实现把用例弄绿的 —— 原实现必须仍以注释形式留在源码里。
  assert.ok(
    source.includes("// guardedAppend(session, 'emotion-feedback/state'"),
    '被停用的原实现应当作为注释保留（改注释会让本用例失败，这是刻意的）',
  )
})

const failed = results.filter((r) => !r.ok)
console.log(`\n崩溃场景回归：${results.length - failed.length} passed, ${failed.length} failed`)

// 结构化结果（可选）：`_diag\mutation-guard.mjs` 靠它把「哪条用例变红」和「施加了哪个突变」
// 对上号 —— 沙箱禁止管道 stdio 的 spawnSync（EPERM），所以结果只能经文件回传。
const resultFile = process.env.DSH_EMOTION_TEST_RESULT
if (typeof resultFile === 'string' && resultFile !== '') {
  try {
    writeFileSync(resultFile, JSON.stringify({
      suite: 'crash-scenarios',
      total: results.length,
      failed: failed.map((r) => ({ title: r.title, message: r.error?.message ?? String(r.error) })),
    }), 'utf8')
  }
  catch { /* 回传失败不影响测试结论 */ }
}

process.exit(failed.length === 0 ? 0 : 1)
