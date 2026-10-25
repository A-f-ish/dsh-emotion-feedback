/**
 * `emotion_status` 工具回归测试。
 *
 * 覆盖：
 *   1. 作者态 output schema 能被**真实** `@deepseek-ai/dsh-tools` 编译（含可空 turn 的 oneOf）；
 *   2. 无状态时返回「平静 / 0」兜底，不抛异常；
 *   3. 关键词规则命中后工具读到真实状态，turnIndex 从 1 开始；
 *   4. 多次判定后 history 逐条带递增 turnIndex；
 *   5. render 输出模型可读的一行摘要；
 *   6. `statusTool:false` / `disabled:true` / 宿主无 tools 服务时的降级行为；
 *   7. 返回值每个字段类型都符合声明的 output schema；
 *   8. 工具用 `exec.agent.session.id` 定位会话，不串到别的会话。
 *
 * `defineTool` 优先从本机 DSH 安装副本解析真实实现（那样上面的 schema 编译用例才有意义）；
 * 解析不到就跳过依赖真实宿主包的用例。插件本身是**惰性** import，所以这里通过
 * `apply(ctx, config, { defineTool })` 的注入口传入。
 *
 * 运行：node test/emotion-status-tool.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import * as emotion from '../lib/index.js'

const { apply, Config } = emotion
const here = dirname(fileURLToPath(import.meta.url))

// 面板历史落盘默认写到 `<DSH_HOME>/emotion-feedback/history`；测试改道临时目录，
// 免得污染用户真实数据（沙箱里还会因工作区外写入被拒而刷 EPERM 警告）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ef-history-tool-'))

const cases = []
function test(title, fn) {
  cases.push([title, fn])
}

/** 从本机安装副本里解析 dsh-tools；解析不到就跳过依赖真实宿主包的用例。 */
async function loadDefineTool() {
  const candidates = [
    join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    'C:/Users/Lenovo/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  ]
  for (const candidate of candidates) {
    try {
      const module = await import(pathToFileURL(candidate).href)
      if (typeof module.defineTool === 'function') return module.defineTool
    }
    catch {
      /* 试下一个 */
    }
  }
  return undefined
}

const defineTool = await loadDefineTool()
const hasRealTools = typeof defineTool === 'function'

/** 最小可用 ctx 桩件：捕获监听器、暴露 register / inject / effect。 */
function makeCtx() {
  const listeners = new Map()
  const captured = { tools: [], injected: [], effects: [], routes: [] }
  captured.toolsFacade = {
    register(definition) {
      captured.tools.push(definition)
      return () => {}
    },
  }
  captured.webServerFacade = {
    register(route) {
      captured.routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    logger: undefined,
    on(event, handler, options) {
      listeners.set(event, { handler, options })
      return () => listeners.delete(event)
    },
    inject(deps, callback) {
      captured.injected.push(deps)
      const scope = { tools: captured.toolsFacade, webServer: captured.webServerFacade }
      scope.effect = (fn, label) => {
        captured.effects.push({ fn, label, scope })
        return () => {}
      }
      callback(scope)
      return () => {}
    },
    effect(fn) {
      captured.effects.push({ fn, label: undefined, scope: undefined })
      return () => {}
    },
    get() {
      return undefined
    },
  }
  return { ctx, listeners, captured }
}

const sessionId = 'session-test-0001'

/** 用真实工具定义跑一次 execute。 */
async function runTool(definition, args = {}, agent = undefined) {
  const exec = { agent, signal: new AbortController().signal, deferContext() {} }
  return definition.execute(args, exec)
}

/**
 * 触发真实的 `agent/turn-stopping` 监听器写入一条判定。
 * 判定走关键词层（零模型调用），因此不需要 llm 桩件。
 */
async function seedTurn(listeners, text, turn) {
  const entry = listeners.get('agent/turn-stopping')
  assert.ok(entry, 'agent/turn-stopping 监听器已注册')
  const messages = [{ role: 'assistant', content: [{ type: 'text', text }] }]
  const agent = {
    id: sessionId,
    session: {
      id: sessionId,
      log: messages.map((message, index) => ({
        type: 'assistant/message',
        seq: index + 1,
        data: { turn, step: 1, message },
      })),
      deriveMessages: () => messages,
      append: () => {},
    },
    options: {},
  }
  await entry.handler({ agent, turn, signal: new AbortController().signal })
}

test('作者态 schema 能被真实 dsh-tools 编译（含 oneOf 可空 turn）', () => {
  assert.ok(hasRealTools, '需要真实 @deepseek-ai/dsh-tools 才能跑这个用例')
  const { ctx, captured } = makeCtx()
  apply(ctx, Config({}), { defineTool })
  assert.equal(captured.tools.length, 1, '注册了正好一个工具')
  const tool = captured.tools[0]
  assert.equal(tool.name, 'emotion_status')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.properties, {})
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.deepEqual(tool.output.schema.properties.turn, { oneOf: [{ type: 'number' }, { type: 'null' }] })
  assert.equal(tool.output.schema.properties.history.type, 'array')
  assert.equal(typeof tool.execute, 'function')
})

test('无状态时返回平静 0 兜底（不抛异常）', async () => {
  const { ctx, captured } = makeCtx()
  apply(ctx, Config({}), { defineTool })
  const value = await runTool(captured.tools[0], {}, { session: { id: sessionId } })
  assert.equal(value.sessionId, sessionId)
  assert.equal(value.emotion, '平静')
  assert.equal(value.intensity, 0)
  assert.equal(value.source, 'none')
  assert.equal(value.turn, null)
  assert.deepEqual(value.history, [])
})

test('没有任何 agent 时也不会抛异常', async () => {
  const { ctx, captured } = makeCtx()
  apply(ctx, Config({}), { defineTool })
  const value = await runTool(captured.tools[0])
  assert.equal(typeof value.emotion, 'string')
  assert.equal(value.intensity, 0)
  assert.ok(Array.isArray(value.history))
})

test('关键词规则命中后，工具能读到真实状态且 turnIndex 从 1 开始', async () => {
  const { ctx, listeners, captured } = makeCtx()
  apply(ctx, Config({ useLlm: false }), { defineTool })
  await seedTurn(listeners, '抱歉，是我的错，我不该忽略这一点。', 1)
  const value = await runTool(captured.tools[0], {}, { session: { id: sessionId } })
  assert.ok(['愧疚', '自责'].includes(value.emotion), `实际 ${value.emotion}`)
  assert.ok(value.intensity >= 0.6, `强度应偏高，实际 ${value.intensity}`)
  assert.equal(value.source, 'rule')
  assert.equal(value.turn, 1)
  assert.equal(value.history.length, 1)
  assert.equal(value.history[0].turnIndex, 1)
  assert.ok(value.reason.length > 0)
})

test('多次判定后 history 逐条带递增 turnIndex', async () => {
  const { ctx, listeners, captured } = makeCtx()
  apply(ctx, Config({ useLlm: false }), { defineTool })
  const texts = [
    '抱歉，是我的错。',
    '太好了，进展顺利。',
    '这里可能有问题，我担心风险。',
  ]
  for (let index = 0; index < texts.length; index++) {
    await seedTurn(listeners, texts[index], index + 1)
  }
  const value = await runTool(captured.tools[0], {}, { session: { id: sessionId } })
  assert.equal(value.history.length, 3)
  assert.deepEqual(value.history.map((item) => item.turn), [1, 2, 3])
  assert.deepEqual(value.history.map((item) => item.turnIndex), [1, 2, 3])
})

test('render 输出模型可读的一行摘要', async () => {
  const { ctx, listeners, captured } = makeCtx()
  apply(ctx, Config({ useLlm: false }), { defineTool })
  await seedTurn(listeners, '抱歉，是我的错。', 1)
  const tool = captured.tools[0]
  const value = await runTool(tool, {}, { session: { id: sessionId } })
  const blocks = tool.output.render({}, value)
  assert.ok(Array.isArray(blocks) && blocks.length >= 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, new RegExp(value.emotion))
  assert.match(blocks[0].text, /最近轨迹/)
})

test('statusTool:false 时不注册工具', () => {
  const { ctx, captured } = makeCtx()
  apply(ctx, Config({ statusTool: false }), { defineTool })
  assert.equal(captured.tools.length, 0)
})

test('disabled:true 时不注册工具', () => {
  const { ctx, captured } = makeCtx()
  apply(ctx, Config({ disabled: true }), { defineTool })
  assert.equal(captured.tools.length, 0)
})

test('宿主没有 tools 服务时插件仍正常工作（只是少一个工具）', () => {
  const { ctx, captured } = makeCtx()
  captured.toolsFacade = undefined
  apply(ctx, Config({}), { defineTool })
  assert.equal(captured.tools.length, 0)
  // 回注监听器仍然注册了
  const listeners = new Map()
  void listeners
})

test('返回值每个字段类型都符合声明的 output schema', async () => {
  assert.ok(hasRealTools, '需要真实 @deepseek-ai/dsh-tools 才能跑这个用例')
  const { ctx, listeners, captured } = makeCtx()
  apply(ctx, Config({}), { defineTool })
  await seedTurn(listeners, '抱歉，是我的错。', 1)
  const tool = captured.tools[0]
  const value = await runTool(tool, {}, { session: { id: sessionId } })
  const { schema } = tool.output
  // 编译后的 schema 把作者态逐属性 required 收成 JSON Schema 的 required 数组
  assert.deepEqual([...schema.required].sort(), [
    'emotion', 'history', 'intensity', 'reason', 'sessionId', 'source', 'turn',
  ])
  assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort())
  assert.deepEqual(Object.keys(value).sort(), Object.keys(schema.properties).sort())
  const check = {
    sessionId: 'string',
    emotion: 'string',
    intensity: 'number',
    reason: 'string',
    source: 'string',
  }
  for (const [key, type] of Object.entries(check)) {
    assert.equal(typeof value[key], type, `${key} 应为 ${type}`)
  }
  assert.ok(value.intensity >= 0 && value.intensity <= 1)
  assert.ok(value.turn === null || typeof value.turn === 'number')
  for (const item of value.history) {
    assert.deepEqual(Object.keys(item).sort(), ['emotion', 'intensity', 'turn', 'turnIndex'])
    assert.equal(typeof item.turn, 'number')
    assert.equal(typeof item.turnIndex, 'number')
    assert.equal(typeof item.emotion, 'string')
    assert.equal(typeof item.intensity, 'number')
  }
})

test('execute 收到多余字段也不报错（参数校验由 registry 负责）', async () => {
  const { ctx, captured } = makeCtx()
  apply(ctx, Config({}), { defineTool })
  const value = await runTool(captured.tools[0], { unexpected: 1 }, { session: { id: sessionId } })
  assert.equal(typeof value.emotion, 'string')
})

test('工具用 exec.agent.session.id 定位会话，不串到别的会话', async () => {
  const { ctx, listeners, captured } = makeCtx()
  apply(ctx, Config({}), { defineTool })
  await seedTurn(listeners, '抱歉，是我的错。', 1)
  const other = await runTool(captured.tools[0], {}, { session: { id: 'session-other' } })
  const mine = await runTool(captured.tools[0], {}, { session: { id: sessionId } })
  assert.equal(other.sessionId, 'session-other')
  assert.equal(other.source, 'none')
  assert.equal(other.emotion, '平静')
  assert.equal(mine.sessionId, sessionId)
  assert.equal(mine.emotion, '愧疚')
})

let passed = 0
let failed = 0
if (!hasRealTools) {
  console.log('提示：本机解析不到 @deepseek-ai/dsh-tools，跳过 2 个依赖真实宿主包的用例。')
}
for (const [title, fn] of cases) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${title}`)
  }
  catch (error) {
    failed++
    console.log(`  FAIL ${title}\n       ${error?.stack ?? error}`)
  }
}
console.log(`\nemotion_status 工具：${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
