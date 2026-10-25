/**
 * 一次跑完全部回归套件：node test/all.mjs
 * 退出码非 0 表示至少一个套件失败（可直接用于交付前的最终校验）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const suites = [
  'test/run.mjs',
  'test/crash-scenarios.mjs',
  'test/panel-data.mjs',
  'test/emotion-status-tool.mjs',
]
let failed = 0
const cwd = fileURLToPath(new URL('..', import.meta.url))

for (const suite of suites) {
  console.log(`\n${'='.repeat(60)}\n>>> ${suite}\n${'='.repeat(60)}`)
  // `stdio: 'inherit'` 而不是默认的管道：管道 stdio 在受限沙箱里会以 EPERM 失败
  // （子进程无法打开命名管道），继承 stdio 既不受限，又能让子套件的输出实时可见。
  const result = spawnSync(process.execPath, [suite], { stdio: 'inherit', cwd })
  if (result.status !== 0) {
    failed++
    console.log(`!!! ${suite} 退出码 ${result.status}${result.error ? `（${result.error.code}: ${result.error.message}）` : ''}`)
  }
}

console.log(`\n${'='.repeat(60)}\n套件 ${suites.length - failed}/${suites.length} 通过`)
if (failed > 0) process.exitCode = 1
