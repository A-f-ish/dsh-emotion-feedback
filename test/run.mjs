/**
 * 本地自测：不依赖 DSH 运行时，用最小 ctx 桩驱动插件，
 * 覆盖「判定 → 状态 → 回注 → 下一次判定」的完整闭环。
 *
 * 运行：node test/run.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, DEFAULT_EMOTIONS } from '../lib/index.js'

let passed = 0
let failed = 0
const failures = []

async function test(title, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${title}`)
  }
  catch (error) {
    failed++
    failures.push({ title, error })
    console.log(`  FAIL ${title}\n       ${error?.message ?? error}`)
  }
}

/** 最小 ctx 桩：只实现插件用到的部分。 */
function createHarness(options = {}) {
  const listeners = new Map()
  const warnings = []
  // 面板历史的落盘目录：测试默认写临时目录（`options.historyDir` 可指定/关闭），
  // 否则会去写真实的 DSH_HOME（沙箱里直接 EPERM，也会污染用户数据）。
  const historyDir = options.historyDir === undefined
    ? mkdtempSync(join(tmpdir(), 'ef-history-'))
    : options.historyDir
  const ctx = {
    logger() {
      return {
        info: (...args) => void 0,
        warn: (...args) => warnings.push(args.map(String).join(' ')),
      }
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const list = listeners.get(event) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
        return true
      }
    },
    get(service, strict) {
      const value = options.services?.[service]
      if (value === undefined && strict !== false) throw new Error(`missing service ${service}`)
      return value
    },
  }
  const config = options.config ?? new Config({})
  const api = apply(ctx, config)
  if (historyDir !== null && historyDir !== false && typeof api.setHistoryDirForTest === 'function') {
    api.setHistoryDirForTest(historyDir)
  }
  return {
    ctx,
    config,
    api,
    historyDir,
    warnings,
    handlers: (event) => listeners.get(event) ?? [],
    /** 触发 agent/turn-stopping。 */
    async stopTurn(payload) {
      for (const handler of listeners.get('agent/turn-stopping') ?? []) await handler(payload)
    },
    /** 触发 agent/pre-step，返回最终 decision。 */
    async preStep({ agent, turn }) {
      const chain = [...(listeners.get('agent/pre-step') ?? [])]
      const next = async () => ({ kind: 'enter', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: '用户请求' }] }] })
      let index = 0
      const run = async () => {
        if (index >= chain.length) return next()
        const handler = chain[index++]
        return handler({ agent, messages: [], turn, step: 1, signal: undefined }, run)
      }
      return run()
    },
  }
}

/** 造一个只带 session.log 的假 agent。 */
function fakeAgent(sessionId, assistantText, turn) {
  return {
    id: sessionId,
    session: {
      id: sessionId,
      log: [
        { type: 'turn/start', seq: 0, data: { turn } },
        {
          type: 'assistant/message',
          seq: 1,
          data: {
            turn,
            step: 1,
            message: {
              role: 'assistant',
              content: [
                { type: 'reasoning', text: '内部推理不应被判定' },
                { type: 'text', text: assistantText },
              ],
            },
          },
        },
      ],
    },
  }
}

/** 造一个只有派生消息历史、没有 log 的假 agent（兼容旧投影）。 */
function fakeAgentDerived(sessionId, assistantText) {
  return {
    id: sessionId,
    session: {
      id: sessionId,
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '用户请求' }] },
        { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
      ],
    },
  }
}

const injectedText = (decision) => {
  const message = decision.messages.at(-1)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'emotion-feedback' })
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  return message.content[0].text
}

console.log('\n[1] 配置 schema')
await test('默认配置能解析，词表含愧疚', () => {
  const config = new Config({})
  assert.ok(config.emotions.includes('愧疚'))
  assert.equal(config.turnDecay, 0.9)
  assert.equal(config.halfLifeMinutes, 10)
  assert.equal(config.inject, true)
  assert.equal(config.rules.length > 0, true)
})
await test('用户配置覆盖默认值', () => {
  const config = new Config({ judgeProvider: 'deepseek-account', judgeModel: 'deepseek-flash', minIntensity: 0.5 })
  assert.equal(config.judgeProvider, 'deepseek-account')
  assert.equal(config.minIntensity, 0.5)
  assert.deepEqual(new Config({ emotions: ['愧疚'] }).emotions, ['愧疚'])
})

console.log('\n[2] 关键词层：判定工作模型自己的情绪')
await test('反思式道歉 → 愧疚', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了，没有先确认你的前提。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '愧疚')
  assert.ok(state.intensity >= 0.6, `intensity=${state.intensity}`)
  assert.equal(state.source, 'rule')
  assert.equal(state.turn, 1)
})
await test('失败重试 → 挫败', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '反复尝试了几种方式，还是失败。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1').emotion, '挫败')
})
await test('顺利交付 → 愉悦', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '太好了，测试全部通过，搞定了。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1').emotion, '愉悦')
})
await test('一条覆盖多条规则时取强度最高者', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，我没注意到这个前提。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '自责', '自责(0.68) 应压过 愧疚(0.62)')
})
await test('关键词命中时不调用 llm', async () => {
  let calls = 0
  const h = createHarness({
    services: { llm: { stream: async function* () { calls++; yield { type: 'text-delta', text: '{}' } } } },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  assert.equal(calls, 0)
})
await test('反向命中不算数：「风险最低」不判焦虑', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '这个方案风险最低，可以走。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1'), undefined, '「风险」被「最低」反向修饰，不该判成焦虑')
})
await test('否定词挡住子串误伤：「不确定」判焦虑而不是自信', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '这个我不确定。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '焦虑', '「确定」被「不」否定，不该按自信(0.6)压过焦虑(0.55)')
  assert.equal(state.reason, '关键词「不确定」')
})
await test('否定保护可关闭：negations 置空后恢复旧行为', async () => {
  const h = createHarness({ config: new Config({ negations: [] }) })
  await h.stopTurn({ agent: fakeAgent('s1', '这个方案风险最低，可以走。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '焦虑')
  assert.equal(state.intensity, 0.55)
})
await test('否定只作用于命中词附近，不影响同句的其它规则', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '我对结果不确定，不过进度很顺利。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '愉悦', '「不确定」应被挡掉，「顺利」仍应判出愉悦')
})

console.log('\n[3] 回注：下一个回合带上情绪')
await test('先判定后回注，且不追加任何会话事件', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了，没有先确认你的前提。', 1)
  const before = agent.session.log.length
  await h.stopTurn({ agent, turn: 1 })
  const decision = await h.preStep({ agent, turn: 2 })
  const text = injectedText(decision)
  assert.equal(agent.session.log.length, before, '判定不应写入会话')
  assert.match(text, /你当前的内在情绪状态是「愧疚」/)
  assert.match(text, /强度 0\.62/)
  assert.match(text, /不要直接说出/)
  assert.ok(decision.messages.length >= 2, '应保留原有消息并追加回注')
})
await test('回注文案带上判定依据（includeReason）', async () => {
  const h = createHarness({ config: new Config({ includeReason: true }) })
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  const text = injectedText(await h.preStep({ agent, turn: 2 }))
  assert.match(text, /判定依据：关键词/)
})
await test('没有状态时原样放行', async () => {
  const h = createHarness()
  const decision = await h.preStep({ agent: fakeAgent('s1', 'x', 1), turn: 1 })
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].id, 'u')
})
await test('同一回合第二次 pre-step 不重复回注', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  assert.equal((await h.preStep({ agent, turn: 2 })).messages.length, 2)
  assert.equal((await h.preStep({ agent, turn: 2 })).messages.length, 1)
})
await test('强度低于阈值不回注', async () => {
  const h = createHarness({ config: new Config({ minIntensity: 0.9 }) })
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  assert.equal((await h.preStep({ agent, turn: 2 })).messages.length, 1)
})
await test('两个会话的同一回合号互不抑制回注', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('a', '抱歉，是我疏忽了。', 1), turn: 1 })
  await h.stopTurn({ agent: fakeAgent('b', '反复尝试还是没能成功。', 1), turn: 1 })
  assert.equal((await h.preStep({ agent: fakeAgent('a', '', 1), turn: 2 })).messages.length, 2)
  assert.equal((await h.preStep({ agent: fakeAgent('b', '', 1), turn: 2 })).messages.length, 2)
  assert.equal((await h.preStep({ agent: fakeAgent('a', '', 1), turn: 2 })).messages.length, 1)
  assert.equal((await h.preStep({ agent: fakeAgent('b', '', 1), turn: 2 })).messages.length, 1)
})
await test('inject=false 时只判定不回注', async () => {
  const h = createHarness({ config: new Config({ inject: false }) })
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  assert.equal(h.api.currentState('s1').emotion, '愧疚')
  assert.equal((await h.preStep({ agent, turn: 2 })).messages.length, 1)
})
await test('reject 决策不被改写', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  const chain = h.handlers('agent/pre-step')
  const decision = await chain[0]({ agent, messages: [], turn: 2, step: 1 }, async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
})

console.log('\n[4] 状态混合与衰减')
await test('同一情绪继续，强度取 max 不下降', async () => {
  const h = createHarness()
  const a1 = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent: a1, turn: 1 })
  const first = h.api.currentState('s1').intensity
  await h.stopTurn({ agent: fakeAgent('s1', '对不起，这确实是我的问题。', 2), turn: 2 })
  const second = h.api.currentState('s1').intensity
  assert.equal(h.api.currentState('s1').emotion, '愧疚')
  assert.ok(second >= first * 0.9, `${first} -> ${second}`)
})
await test('情绪切换时旧强度按比例保留', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', 1), turn: 1 })
  await h.stopTurn({ agent: fakeAgent('s1', '太好了，测试通过了。', 2), turn: 2 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '愉悦')
  assert.ok(state.intensity >= 0.6)
  assert.equal(state.history.length, 2)
  assert.equal(state.history[0].emotion, '愧疚')
})
await test('同回合重复判定不叠加强度', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', 1), turn: 1 })
  const once = h.api.currentState('s1').intensity
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1').intensity, once)
  assert.equal(h.api.currentState('s1').history.length, 1)
})
await test('闲置时间不再衰减强度（该模块已停用）', async () => {
  const original = Date.now
  try {
    Date.now = () => 1_700_000_000_000
    const h = createHarness()
    await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', 1), turn: 1 })
    const base = h.api.currentState('s1').intensity
    Date.now = () => 1_700_000_000_000 + 10 * 60_000
    assert.equal(h.api.currentState('s1').intensity, base)
    Date.now = () => 1_700_000_000_000 + 60 * 60_000
    assert.equal(h.api.currentState('s1').intensity, base)
  }
  finally {
    Date.now = original
  }
})
await test('历史长度受 historyLimit 限制', async () => {
  const h = createHarness({ config: new Config({ historyLimit: 2 }) })
  for (let turn = 1; turn <= 5; turn++) {
    await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', turn), turn })
  }
  assert.equal(h.api.currentState('s1').history.length, 2)
})

console.log('\n[5] LLM 判定层')
await test('关键词未命中时调用一次判定，使用会话默认模型', async () => {
  const seen = []
  const h = createHarness({
    services: {
      llm: {
        stream(options) {
          seen.push(options)
          return (async function* () {
            yield { type: 'text-delta', text: '{"emotion"' }
            yield { type: 'text-delta', text: ':"焦虑","intensity":0.8,"reason":"隐含风险"}' }
            yield { type: 'finish', reason: 'stop' }
          })()
        },
      },
      agentDefaultModel: { currentSelection: async () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '这段迁移路径我会再看看。', 1), turn: 1 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'deepseek-account')
  assert.equal(seen[0].model, 'deepseek-flash')
  assert.equal(seen[0].temperature, 0)
  assert.match(seen[0].messages[0].content[0].text, /PROTOCOL: EMOTION_TONE_JUDGE/)
  assert.match(seen[0].messages[0].content[0].text, /这段迁移路径我会再看看/)
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '焦虑')
  assert.equal(state.intensity, 0.8)
  assert.equal(state.source, 'llm')
  assert.equal(state.reason, '隐含风险')
})
await test('判定提示词里必须带上词表（模型才不会自造标签）', async () => {
  const seen = []
  const h = createHarness({
    services: {
      llm: {
        stream(options) {
          seen.push(options)
          return (async function* () { yield { type: 'text-delta', text: '{"emotion":"平静","intensity":0.3}' } })()
        },
      },
      agentDefaultModel: { currentSelection: async () => ({ provider: 'p', model: 'm' }) },
    },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '我看看这段。', 1), turn: 1 })
  assert.match(seen[0].system, /可选情绪/, 'system 提示词要显式列出可选情绪')
  assert.match(seen[0].system, /愤怒、委屈、怜惜/, '新增词表项要出现在提示词里')
})
await test('自定义词表会同步进判定提示词', async () => {
  const seen = []
  const h = createHarness({
    config: new Config({ emotions: ['开心', '难过'] }),
    services: {
      llm: {
        stream(options) {
          seen.push(options)
          return (async function* () { yield { type: 'text-delta', text: '{"emotion":"开心","intensity":0.9}' } })()
        },
      },
      agentDefaultModel: { currentSelection: async () => ({ provider: 'p', model: 'm' }) },
    },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '我看看这段。', 1), turn: 1 })
  assert.match(seen[0].system, /开心、难过/)
  assert.equal(h.api.currentState('s1').emotion, '开心')
})
await test('配置的 judgeProvider/judgeModel 优先', async () => {
  const seen = []
  const h = createHarness({
    config: new Config({ judgeProvider: 'custom', judgeModel: 'small' }),
    services: {
      llm: { stream: (options) => { seen.push(options); return (async function* () { yield { type: 'text-delta', text: '{"emotion":"平静","intensity":0.3}' } })() } },
    },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '一切正常。', 1), turn: 1 })
  assert.equal(seen[0].provider, 'custom')
  assert.equal(seen[0].model, 'small')
})
await test('模型返回代码块包裹的 JSON 也能解析', async () => {
  const h = createHarness({
    services: {
      llm: { stream: () => (async function* () { yield { type: 'text-delta', text: '```json\n{"emotion":"无奈","intensity":2}\n```' } })() },
    },
    config: new Config({ judgeProvider: 'p', judgeModel: 'm' }),
  })
  await h.stopTurn({ agent: fakeAgent('s1', '这条路暂时走不下去，我先停在这里。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '无奈')
  assert.equal(state.intensity, 1, '强度需裁剪到 1')
  assert.equal(state.source, 'llm')
})
await test('词表外的情绪原样保留并打标，不再改写成平静', async () => {
  const h = createHarness({
    config: new Config({ judgeProvider: 'p', judgeModel: 'm' }),
    services: { llm: { stream: () => (async function* () { yield { type: 'text-delta', text: '{"emotion":"嫉妒","intensity":0.9}' } })() } },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '嗯。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '嫉妒', '旧实现会把它改写成「平静」，把强情绪显示成中性')
  assert.equal(state.intensity, 0.9)
  assert.equal(state.outOfList, true, '词表外的标签要带 outOfList 标记，便于面板区分')
})
await test('词表内的情绪不带 outOfList 标记', async () => {
  const h = createHarness({
    config: new Config({ judgeProvider: 'p', judgeModel: 'm' }),
    services: { llm: { stream: () => (async function* () { yield { type: 'text-delta', text: '{"emotion":"愧疚","intensity":0.7}' } })() } },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '嗯。', 1), turn: 1 })
  const state = h.api.currentState('s1')
  assert.equal(state.emotion, '愧疚')
  assert.equal('outOfList' in state, false)
})
await test('useLlm=false 时不做模型调用', async () => {
  let calls = 0
  const h = createHarness({
    config: new Config({ useLlm: false }),
    services: { llm: { stream: () => { calls++; return (async function* () {})() } } },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '一切正常。', 1), turn: 1 })
  assert.equal(calls, 0)
  assert.equal(h.api.currentState('s1'), undefined)
})

console.log('\n[6] 容错')
await test('没有 llm 服务也不崩（strict 桩会抛错）', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '一切正常。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1'), undefined)
})
await test('llm 调用抛错时保持原状态且不影响回合', async () => {
  const h = createHarness({
    config: new Config({ judgeProvider: 'p', judgeModel: 'm' }),
    services: { llm: { stream: () => { throw new Error('boom') } } },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1').emotion, '愧疚')
  await h.stopTurn({ agent: fakeAgent('s1', '路由表已经对齐。', 2), turn: 2 })
  assert.equal(h.api.currentState('s1').emotion, '愧疚', '调用失败不应改写状态')
  assert.ok(h.warnings.some((line) => line.includes('判定调用失败')), JSON.stringify(h.warnings))
})
await test('判定流以 error 结束时不算成功', async () => {
  const h = createHarness({
    config: new Config({ judgeProvider: 'p', judgeModel: 'm' }),
    services: {
      llm: {
        stream: () => (async function* () {
          yield { type: 'text-delta', text: '{"emotion":"焦虑","intensity":0.9}' }
          yield { type: 'finish', reason: { kind: 'error', failure: { kind: 'network', message: 'reset' } } }
        })(),
      },
    },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '路由表已经对齐。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1'), undefined)
  assert.ok(h.warnings.some((line) => line.includes('判定流以 network 结束')), JSON.stringify(h.warnings))
})
await test('文本无法解析时保持原状态', async () => {
  const h = createHarness({
    config: new Config({ judgeProvider: 'p', judgeModel: 'm' }),
    services: { llm: { stream: () => (async function* () { yield { type: 'text-delta', text: '我觉得还行' } })() } },
  })
  await h.stopTurn({ agent: fakeAgent('s1', '路由表已经对齐。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1'), undefined)
})
await test('session.log 缺失时退化到派生消息', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgentDerived('s1', '抱歉，是我疏忽了。'), turn: 1 })
  assert.equal(h.api.currentState('s1').emotion, '愧疚')
})
await test('只有 reasoning 没有正文时不判定', async () => {
  const h = createHarness()
  const agent = { id: 's1', session: { id: 's1', log: [{ type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考中' }] } } }] } }
  await h.stopTurn({ agent, turn: 1 })
  assert.equal(h.api.currentState('s1'), undefined)
})
await test('没有 session.id 时安全跳过', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: { session: {} }, turn: 1 })
  assert.deepEqual(h.api.currentState(), {})
})
await test('会话销毁后状态被清理', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', 1), turn: 1 })
  for (const handler of h.handlers('session/disposed')) handler({ id: 's1' })
  assert.equal(h.api.currentState('s1'), undefined)
})
await test('多个会话状态互相隔离', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('a', '抱歉，是我的问题。', 1), turn: 1 })
  await h.stopTurn({ agent: fakeAgent('b', '太好了，测试通过了。', 1), turn: 1 })
  assert.equal(h.api.currentState('a').emotion, '愧疚')
  assert.equal(h.api.currentState('b').emotion, '愉悦')
})

console.log('\n[7] 词表与回注模板')
await test('默认词表覆盖参考方案的情绪词', () => {
  for (const label of ['愧疚', '平静', '自责', '焦虑']) assert.ok(DEFAULT_EMOTIONS.includes(label), label)
})
await test('自定义模板生效', async () => {
  const h = createHarness({ config: new Config({ template: '[{emotion}|{intensity}]' }) })
  const agent = fakeAgent('s1', '抱歉，是我的问题。', 1)
  await h.stopTurn({ agent, turn: 1 })
  assert.equal(injectedText(await h.preStep({ agent, turn: 2 })), '[愧疚|0.62]')
})
await test('自定义词表时默认规则里越界的情绪被忽略', async () => {
  const h = createHarness({ config: new Config({ emotions: ['平静', '好奇'] }) })
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我的问题。', 1), turn: 1 })
  assert.equal(h.api.currentState('s1'), undefined)
})

console.log('\n[8] 面板每轮明细（host 侧契约）')
await test('快照带完整判定明细：原值、依据、来源、融合关系', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  const session = h.api.panelSnapshot().sessions[0]
  const sample = session.samples.at(-1)
  // 一条采样必须同时带「原值」与「融合后」，面板才能显示「这一轮判了什么、依据是什么」。
  assert.equal(sample.turn, 1)
  assert.equal(sample.judged, '愧疚')
  assert.ok(Number.isFinite(sample.judgedIntensity), 'judgedIntensity 应该是数字')
  // 依据必须**带上内容**才算数（只断言 typeof 是 string 的话，把 reason 写成 '' 也能过）。
  assert.match(sample.reason, /^关键词「.+」$/, `每轮依据应该是关键词层的原文，实际 ${JSON.stringify(sample.reason)}`)
  assert.equal(sample.source, 'rule')
  assert.equal(sample.merged, true)
  assert.equal(sample.intensityRatio, 1)
  assert.equal(sample.carriedIntensity, 0)
  assert.equal(sample.injectedInto, undefined, '还没回注时 injectedInto 应为 undefined')
})
await test('合并下一条采样仍带原值（融合后强度与原值分开记录）', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  await h.stopTurn({ agent: fakeAgent('s1', '太好了，测试全部通过。', 2), turn: 2 })
  const series = h.api.panelSnapshot().sessions[0].samples
  assert.equal(series.length, 2)
  assert.equal(series[0].judged, '愧疚')
  assert.equal(series[1].judged, '愉悦')
  // 不同情绪 ⇒ 新情绪接管，可能带着旧状态的残留（takeoverRetain），但原值始终是「愉悦」的判定值。
  assert.notEqual(series[1].judgedEmotion, undefined)
  assert.ok(Number.isFinite(series[1].judgedIntensity))
  // 历史明细是**冻结**的：两条各自的依据不能被后一轮覆盖成同一条。
  assert.match(series[0].reason, /^关键词「.+」$/)
  assert.match(series[1].reason, /^关键词「.+」$/)
  assert.notEqual(series[0].reason, series[1].reason, '两轮的依据是各自的判定原文，不该一样')
})
await test('真实回注后 injectedInto 记录生效回合', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  assert.equal(h.api.panelSnapshot().sessions[0].samples.at(-1).injectedInto, undefined)
  await h.preStep({ agent, turn: 2 })
  assert.equal(h.api.panelSnapshot().sessions[0].samples.at(-1).injectedInto, 2)
})
await test('injectionPlan 描述下一回合将要回注什么', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  const plan = h.api.panelSnapshot().sessions[0].injectionPlan
  assert.equal(plan.emotion, '愧疚')
  assert.ok(Number.isFinite(plan.intensity))
  assert.equal(plan.pending, true)
  assert.equal(plan.willInjectAt, 2)
  assert.equal(plan.changedSinceLastInjection, true, '还没回注过 ⇒ 相对上次回注有变化')
  await h.preStep({ agent, turn: 2 })
  const after = h.api.panelSnapshot().sessions[0].injectionPlan
  assert.equal(after.pending, true, '状态仍然新鲜 ⇒ 下一条出站请求还会带上它')
  assert.equal(after.changedSinceLastInjection, false, '刚注入过同一状态 ⇒ 相对上次回注没有变化')
})
await test('快照与面板读的是同一份状态，且不因回注而改变「当前情绪」', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  const before = h.api.panelSnapshot().sessions[0]
  await h.preStep({ agent, turn: 2 })
  const after = h.api.panelSnapshot().sessions[0]
  assert.equal(after.emotion, before.emotion)
  assert.equal(after.intensity, before.intensity)
  assert.equal(after.samples.length, 1, '回注不会新增采样点（采样只在回合收尾判定时追加）')
})
// 用户报告的问题②：只看得到每一轮的趋势，看不到每一轮的判断依据。
// 根因是采样与状态共用同一份「上一条判定」，下一回合的判定会把历史明细一起改掉。
// `willInject` 是快照当场算出来的展示字段（只有末条可能为 true），不是判定明细，比较时剔除。
const panelDetail = (sample) => {
  const copy = { ...sample }
  delete copy.willInject
  return copy
}
await test('历史采样冻结：下一回合判定不得改写上一回合的依据/原值', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  const first = panelDetail(h.api.panelSnapshot().sessions[0].samples[0])
  await h.stopTurn({ agent: fakeAgent('s1', '反复尝试了几种方式，还是失败。', 2), turn: 2 })
  const series = h.api.panelSnapshot().sessions[0].samples
  assert.equal(series.length, 2)
  assert.deepEqual(panelDetail(series[0]), first, '回合 1 的采样必须原封不动（对象也不许被就地改）')
  // 两条采样必须各自带自己的判定原值与依据，而不是「两条都显示最新那条」。
  assert.equal(series[0].judgedEmotion, '愧疚')
  assert.equal(series[0].source, 'rule')
  assert.equal(series[1].judgedEmotion, '挫败')
  assert.notEqual(series[0].judgedEmotion, series[1].judgedEmotion)
  assert.equal(typeof series[0].reason, 'string')
  assert.equal(typeof series[1].reason, 'string')
})
// 「T{n} 判定 → T{m} 生效」的两个数都由 host 给出，客户端不再自己推。
await test('采样与回注计划都带判定回合 / 生效回合', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  const sample = h.api.panelSnapshot().sessions[0].samples.at(-1)
  assert.equal(sample.turn, 1, '判定发生在回合 1 收尾')
  assert.equal(sample.injectedInto, undefined, '还没回注时没有生效回合')
  const plan = h.api.panelSnapshot().sessions[0].injectionPlan
  assert.equal(plan.judgedTurn, 1)
  assert.equal(plan.willInjectAt, 2)
  await h.preStep({ agent, turn: 2 })
  const after = h.api.panelSnapshot().sessions[0]
  assert.equal(after.samples.at(-1).injectedInto, 2, '真的在回合 2 回注了')
  assert.equal(after.injectionPlan.judgedTurn, 1)
  assert.deepEqual(
    { turn: after.injectionPlan.judgedTurn, injectedInto: after.samples.at(-1).injectedInto },
    { turn: 1, injectedInto: 2 },
    '面板靠这两个数写「T1 判定 → T2 生效」',
  )
})
// 问题①的另一半：判定原值必须一路留到快照里（融合只改 intensity/emotion 的展示值）。
await test('每条采样都带判定原值、来源与依据（问题②的显示前提）', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  await h.stopTurn({ agent: fakeAgent('s1', '反复尝试了几种方式，还是失败。', 2), turn: 2 })
  const samples = h.api.panelSnapshot().sessions[0].samples
  assert.equal(samples.length, 2)
  for (const item of samples) {
    assert.equal(typeof item.judgedEmotion, 'string', '每轮都要有判定原值')
    assert.ok(Number.isFinite(item.judgedIntensity), '每轮都要有判定原值强度')
    assert.equal(typeof item.reason, 'string', '每轮都要有判定依据')
    assert.equal(typeof item.source, 'string', '每轮都要有判定来源')
    assert.equal(typeof item.merged, 'boolean', '每轮都要有融合关系')
    assert.ok(Number.isFinite(item.intensity), '每轮都要有生效强度')
  }
  assert.equal(samples[0].source, 'rule')
  assert.equal(samples[0].merged, true, '首次判定没有「接管」可言')
})

// 问题②的持久化前提：判定依据既不在会话日志里（判定用的 LLM 调用不落日志），
// 也不在回注正文里（includeReason 默认 false）——只活在内存里，DSH 一重启就没了。
// 所以每轮明细必须落进插件自己的状态目录。
await test('[9] 判定后把每轮明细落盘（含依据 / 判定原值 / 来源）', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  const file = h.api.historyFileFor('s1')
  assert.equal(typeof file, 'string', '应当能算出落盘路径')
  assert.ok(existsSync(file), '判定后必须出现落盘文件')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.sessionId, 's1')
  assert.equal(saved.records.length, 1)
  const record = saved.records[0]
  assert.equal(record.turn, 1)
  assert.equal(record.judgedEmotion, '愧疚', '判定原值也要落盘（面板要显示「判定 → 生效」）')
  assert.equal(record.source, 'rule')
  assert.ok(Number.isFinite(record.intensity), '生效强度要落盘')
  assert.equal(typeof record.reason, 'string')
  assert.ok(record.reason.includes('抱歉'), `依据必须落盘，实得 ${JSON.stringify(record.reason)}`)
})
// 生效回合是面板写「T{n} 判定 → T{m} 生效」的另一半，同样要落盘。
await test('[9] 生效回合也落盘（重启后「T1 判定 → T2 生效」仍对得上）', async () => {
  const h = createHarness()
  const agent = fakeAgent('s1', '抱歉，是我疏忽了。', 1)
  await h.stopTurn({ agent, turn: 1 })
  const before = JSON.parse(readFileSync(h.api.historyFileFor('s1'), 'utf8'))
  assert.equal(before.records[0].injectedInto, undefined, '还没回注时没有生效回合')
  await h.preStep({ agent, turn: 2 })
  const after = JSON.parse(readFileSync(h.api.historyFileFor('s1'), 'utf8'))
  assert.equal(after.records[0].injectedInto, 2, '回注后必须把生效回合写进存档')
})
// 核心用例：模拟 DSH 重启（新实例、内存全空），面板仍要能列出历史回合的依据。
await test('[9] 重启后（内存为空）面板仍能拿到每轮依据', async () => {
  const first = createHarness()
  await first.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  await first.stopTurn({ agent: fakeAgent('s2', '反复尝试了几种方式，还是失败。', 1), turn: 1 })
  const rebooted = createHarness({ historyDir: first.historyDir })
  assert.equal(rebooted.api.panelSnapshot().sessions.length, 0, '新实例内存里确实没有会话')
  const payload = rebooted.api.panelPayload('s1')
  assert.equal(payload.sessions.length, 1, '内存为空时要回落到落盘明细')
  const session = payload.sessions[0]
  assert.equal(session.restoredFromDisk, true, '客户端靠这个标记写「来自宿主存档」')
  assert.equal(session.turn, 1)
  assert.equal(session.emotion, '愧疚')
  assert.equal(session.history.length, 1)
  assert.equal(session.history[0].turn, 1)
  assert.equal(session.history[0].judgedEmotion, '愧疚')
  assert.equal(typeof session.history[0].reason, 'string')
  assert.ok(session.history[0].reason.includes('抱歉'))
  assert.equal(session.samples.length, 1)
  assert.equal(session.samples[0].willInject, false, '存档里的都是已生效的读数')
  // 只回答被问的那个会话，绝不串号。
  assert.equal(rebooted.api.panelPayload('s2').sessions[0].emotion, '挫败')
  // 没有存档的会话：空数组，不抛。
  assert.deepEqual(rebooted.api.panelPayload('nope').sessions, [])
})
// 存档是「附带产物」：坏了、版本不符、过期，都只能让面板少显示，绝不能抛到回合里。
await test('[9] 坏存档 / 版本不符 / 过期 → 当作没有存档，且不抛', async () => {
  const h = createHarness()
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  const file = h.api.historyFileFor('s1')
  writeFileSync(file, '{ 这不是 JSON')
  const bad = createHarness({ historyDir: h.historyDir })
  assert.deepEqual(bad.api.panelPayload('s1').sessions, [], '坏 JSON 必须当作没有存档')
  writeFileSync(file, JSON.stringify({ version: 99, sessionId: 's1', records: [{ turn: 1, reason: 'x' }] }))
  assert.deepEqual(createHarness({ historyDir: h.historyDir }).api.panelPayload('s1').sessions, [], '版本不符必须忽略')
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: 's1', records: [{ turn: 1, reason: 'x' }] }))
  const old = Date.now() / 1000 - 400 * 86400
  utimesSync(file, old, old)
  assert.deepEqual(createHarness({ historyDir: h.historyDir }).api.panelPayload('s1').sessions, [], '过了保留期必须忽略')
})
// 关掉开关就退回纯内存（不产生任何文件）。
await test('[9] persistHistory:false 时不落盘', async () => {
  const h = createHarness({ config: new Config({ persistHistory: false }) })
  await h.stopTurn({ agent: fakeAgent('s1', '抱歉，是我疏忽了。', 1), turn: 1 })
  assert.equal(existsSync(h.api.historyFileFor('s1')), false)
  assert.equal(h.api.panelSnapshot().sessions[0].history.length, 1, '内存里照旧有明细')
})

console.log(`\n${passed} passed, ${failed} failed`)// 结构化回传：突变测试台靠它判断「哪条用例变红」（沙箱禁止管道 stdio 的 spawnSync）。
if (process.env.DSH_EMOTION_TEST_RESULT) {
  writeFileSync(process.env.DSH_EMOTION_TEST_RESULT, JSON.stringify({
    suite: 'run', total: passed + failed,
    failed: failures.map(({ title, error }) => ({ title, message: String(error?.message ?? error) })),
  }, null, 2))
}
if (failed > 0) {
  for (const { title, error } of failures) console.log(`\n--- ${title}\n${error?.stack ?? error}`)
  process.exit(1)
}
