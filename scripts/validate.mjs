/**
 * dsh-emotion-feedback — 发布前格式自检（零依赖）。
 *
 * 用法：node scripts/validate.mjs
 * 退出码 0 = 通过；1 = 有硬性不合规项（会在末尾列出）。
 *
 * 检查项全部对齐 DSH 的官方实现与作者文档：
 * - @deepseek-ai/dsh-package-manifest 的清单类型（name/version/icon/dsh{manifestVersion,bundle,client}）
 * - @deepseek-ai/dsh-client-modules 的 dsh.client 解析（platform 必填字符串，inject/external 必须是字符串数组）
 * - @deepseek-ai/dsh-app-boot 的显示元数据读取（locale/<lang>.json 的 meta.title/description、
 *   icon 必须是包内相对路径的 SVG/PNG/JPEG/WebP 且 ≤256 KiB）
 * - awesome-dsh-plugin 的收录硬性要求（声明 dsh.bundle + 仓库根 cordis.patch.yml 含 `- insert:`）
 */
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NL = '\n'
const problems = []
const warnings = []
const notes = []

const fail = (message) => problems.push(message)
const warn = (message) => warnings.push(message)
const note = (message) => notes.push(message)
const isStr = (value) => typeof value === 'string' && value !== ''

const readJson = (abs) => JSON.parse(readFileSync(abs, 'utf8'))
/** 相对包根的可读路径（诊断里一律用它，便于 grep）。 */
const rel = (abs) => relative(ROOT, abs).split(sep).join('/')

// ---------------------------------------------------------------- package.json
const pkgPath = join(ROOT, 'package.json')
if (!existsSync(pkgPath)) {
  console.error('找不到 package.json，请从包根运行本脚本。')
  process.exit(1)
}
const pkg = readJson(pkgPath)

for (const field of ['name', 'version', 'description', 'license', 'type']) {
  if (!isStr(pkg[field])) fail(`package.json 缺少必填字段 ${field}`)
}
if (pkg.type !== 'module') fail('package.json 的 type 必须是 "module"（lib 使用 ESM）')
if (pkg.private === true) fail('package.json 的 private 为 true —— 会挡住 npm publish（社区版必须删掉该字段）')
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(String(pkg.version))) warn(`version "${pkg.version}" 不是标准 semver`)
if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('dsh-plugin')) {
  warn('keywords 建议包含 "dsh-plugin"（社区检索与市场收录会用到）')
}
if (pkg.publishConfig?.access !== 'public') warn('建议设置 publishConfig.access = "public"（与官方插件惯例一致）')
for (const [field, value] of [
  ['repository.url', pkg.repository?.url],
  ['homepage', pkg.homepage],
  ['bugs.url', pkg.bugs?.url],
  ['author', pkg.author],
]) {
  if (!isStr(value)) fail(`发布元数据缺 ${field}`)
  else if (/OWNER|TODO|example\.com/.test(value)) warn(`发布前需要替换占位值 ${field} = "${value}"`)
}
if (isStr(pkg.repository?.url) && !String(pkg.repository.url).includes(pkg.name)) {
  warn(`repository.url 里没有出现包名 ${pkg.name}，确认仓库地址正确`)
}

// ---------------------------------------------------------------- dsh manifest
const dsh = pkg.dsh
if (dsh === null || typeof dsh !== 'object') {
  fail('package.json 缺少 dsh 段：社区收录要求声明 dsh.bundle（只声明 dsh.client 是最常见的被拒原因）')
} else {
  if (dsh.manifestVersion === undefined) warn('建议显式声明 dsh.manifestVersion = 1')
  else if (dsh.manifestVersion !== 1) fail(`dsh.manifestVersion 目前只支持 1，当前为 ${JSON.stringify(dsh.manifestVersion)}`)

  const patch = dsh.bundle?.patch
  if (patch === undefined) {
    fail('dsh.bundle.patch 缺失：宿主靠它把插件接进 profile 配置图')
  } else if (!isStr(patch) && !(Array.isArray(patch) && patch.every(isStr))) {
    fail('dsh.bundle.patch 必须是字符串或字符串数组')
  } else {
    const patches = Array.isArray(patch) ? patch : [patch]
    const ids = new Set()
    for (const entry of patches) {
      if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry) || entry.split('/').includes('..')) {
        fail(`dsh.bundle.patch 必须是包内相对路径：${entry}`)
        continue
      }
      const abs = join(ROOT, entry)
      if (!existsSync(abs)) {
        fail(`补丁文件不存在：${entry}`)
        continue
      }
      const text = readFileSync(abs, 'utf8')
      if (!/^\s*-\s*insert:/m.test(text)) fail(`${entry} 里没有 "- insert:" 段（社区收录硬性要求）`)
      if (!text.includes(pkg.name)) warn(`${entry} 里没有出现包名 ${pkg.name}，确认 insert.name 指向本包`)
      for (const match of text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)) {
        if (ids.has(match[1])) fail(`${entry} 里 id "${match[1]}" 重复（profile 内 id 必须唯一）`)
        ids.add(match[1])
      }
      note(`bundle 补丁 ${entry} → insert id: ${[...ids].join(', ') || '(未解析到 id)'}`)
    }
  }

  const client = dsh.client
  if (client !== undefined) {
    if (client === null || typeof client !== 'object') fail('dsh.client 必须是对象')
    else {
      if (!isStr(client.platform)) fail('dsh.client.platform 必须是字符串（浏览器半边填 "web"）')
      for (const field of ['inject', 'external']) {
        const value = client[field]
        if (value === undefined) continue
        if (!Array.isArray(value) || value.some((item) => !isStr(item))) {
          fail(`dsh.client.${field} 必须是字符串数组`)
          continue
        }
        for (const item of value) {
          if (!item.startsWith('@') && !item.includes('-')) {
            fail(`dsh.client.${field} 的 "${item}" 看起来是 Cordis 服务名而不是包名；按官方实现这里写的是客户端包名（信息性的加载/预取边）`)
          }
        }
      }
      if (client.immediately !== undefined && typeof client.immediately !== 'boolean') {
        fail('dsh.client.immediately 必须是布尔值')
      }
      if (!isStr(pkg.exports?.['./client'])) {
        fail('声明了 dsh.client，但 exports 里没有 "./client"（浏览器半边入口）')
      }
    }
  }
}

// ---------------------------------------------------------------- exports / files
const exportsMap = pkg.exports
if (exportsMap === null || typeof exportsMap !== 'object') fail('package.json 缺少 exports')
else {
  for (const key of ['.', './package.json', './locale/*.json']) {
    if (exportsMap[key] === undefined) fail(`exports 缺少 "${key}"（宿主按 Node ESM exports 解析 locale 与清单）`)
  }
  /** 把 exports 的取值（字符串或条件对象）摊平成目标路径列表。 */
  const targetsOf = (value) => {
    if (isStr(value)) return [value]
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(targetsOf)
    return []
  }
  for (const [key, value] of Object.entries(exportsMap)) {
    if (key.includes('*')) continue
    for (const target of targetsOf(value)) {
      if (!target.startsWith('./')) continue
      if (!existsSync(join(ROOT, target))) fail(`exports["${key}"] 指向的文件不存在：${target}`)
    }
  }
  const clientTarget = targetsOf(exportsMap['./client'])[0]
  if (isStr(clientTarget)) note(`浏览器半边入口 exports["./client"] → ${clientTarget}`)
}

const files = pkg.files
if (!Array.isArray(files) || files.length === 0) {
  fail('package.json 缺少 files 白名单')
} else {
  const joined = files.join(' ')
  for (const required of ['lib', 'cordis.patch.yml', 'icon.svg', 'locale']) {
    if (!joined.includes(required)) fail(`files 白名单缺 "${required}"（该文件不会被发布，宿主找不到）`)
  }
  if (files.some((entry) => entry.includes('node_modules'))) fail('files 白名单不应包含 node_modules')
  if (!joined.includes('README')) warn('files 白名单没包含 README（包页会没有说明）')
}

// ---------------------------------------------------------------- icon
const icon = pkg.icon
const ICON_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const MAX_ICON_BYTES = 256 * 1024
if (!isStr(icon)) {
  fail('package.json 缺少 icon 字段（插件列表里的图标）')
} else if (icon.startsWith('/') || /^[a-zA-Z]:/.test(icon)) {
  fail('icon 必须是包内相对路径')
} else {
  const abs = join(ROOT, icon)
  if (!existsSync(abs)) fail(`icon 不存在：${icon}`)
  else {
    if (!ICON_EXT.has(extname(icon).toLowerCase())) fail(`icon 扩展名不在允许集合（SVG/PNG/JPEG/WebP）：${icon}`)
    const size = statSync(abs).size
    if (size > MAX_ICON_BYTES) fail(`icon 超过 256 KiB（当前 ${size} 字节）`)
    if (!realpathSync(abs).startsWith(realpathSync(ROOT))) fail('icon 的真实路径不在包目录内（符号链接逃逸）')
    note(`icon ${icon}（${size} 字节，${extname(icon).slice(1).toUpperCase() || '未知类型'}）`)
  }
}

// ---------------------------------------------------------------- locale
const localeDir = join(ROOT, 'locale')
const LANG_ID = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
if (!existsSync(localeDir)) {
  fail('缺少 locale/ 目录（显示元数据：locale/en.json 提供 title/description）')
} else {
  const entries = readdirSync(localeDir).filter((name) => name.endsWith('.json'))
  if (!entries.includes('en.json')) fail('locale/en.json 缺失（宿主用它做显示元数据的兜底）')
  for (const name of entries) {
    const id = name.slice(0, -'.json'.length)
    if (!LANG_ID.test(id)) fail(`locale 文件名必须是语言 id：locale/${name}`)
    try {
      const data = readJson(join(localeDir, name))
      const meta = data?.meta
      if (meta === null || typeof meta !== 'object') {
        fail(`locale/${name} 缺少 meta 对象（形如 {"meta":{"title":"…","description":"…"}}）`)
        continue
      }
      if (!isStr(meta.title)) fail(`locale/${name} 的 meta.title 必须是非空字符串`)
      if (!isStr(meta.description)) warn(`locale/${name} 缺 meta.description（插件列表会回落到 package.json 的 description）`)
    } catch (error) {
      fail(`locale/${name} 不是合法 JSON：${error.message}`)
    }
  }
  note(`locale 语言表：${entries.join(', ') || '(空)'}`)
}

// ---------------------------------------------------------------- peers / engines
const peers = pkg.peerDependencies ?? {}
const gated = Object.keys(peers).filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
if (gated.length === 0) {
  warn('没有声明任何 @deepseek-ai/dsh* peer：DSH 的兼容性预检会放行所有宿主版本')
} else {
  for (const name of gated) {
    const optional = pkg.peerDependenciesMeta?.[name]?.optional === true
    note(`peer ${name}: "${peers[name]}"${optional ? '（optional）' : '（不满足宿主版本时安装会被禁用）'}`)
  }
}
if (isStr(pkg.engines?.node)) note(`engines.node: ${pkg.engines.node}`)

// ---------------------------------------------------------------- report
console.log(`dsh-emotion-feedback 发布自检 — ${pkg.name}@${pkg.version}`)
console.log(`包目录：${ROOT}`)
console.log(NL + '检查摘要：')
for (const line of notes) console.log(`  · ${line}`)
if (warnings.length > 0) {
  console.log(NL + `警告 ${warnings.length} 条（不阻塞发布）：`)
  for (const line of warnings) console.log(`  ! ${line}`)
}
if (problems.length > 0) {
  console.log(NL + `不合规 ${problems.length} 条：`)
  for (const line of problems) console.log(`  × ${line}`)
  console.log(NL + '结论：不通过。修掉上面全部 × 项后重跑 node scripts/validate.mjs')
  process.exitCode = 1
} else {
  console.log(NL + '结论：通过 —— 清单符合 dsh-plugin 格式（dsh.bundle / dsh.client / icon / locale / exports / files 均已对齐官方读取实现）。')
}
