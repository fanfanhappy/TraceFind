// 模块二端到端验证：造中文测试文件 → 重新扫描 → 验证中文/拼音/首字母/范围/排序。
// 结束后清理测试文件并再扫一次，保证索引回到真实状态。
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] ?? '9223'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) throw new Error('找不到窗口页面目标')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')
const invoke = async (cmd, args = {}) => {
  const result = await send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const TEST_DIR = path.join(process.env.USERPROFILE ?? 'C:\\Users\\demo', 'Documents', 'aura-m2-test')
const FILES = ['财务预算报告 2026.docx', '项目会议纪要-第三次.md', '季度销售数据.xlsx']

// 不依赖 lastScan：直接等"想要的结果出现/消失"，扫描与监听哪条路径先到都算数
async function waitUntil(label, predicate, timeoutMs = 15_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await predicate()
    if (last) return true
    await sleep(250)
  }
  throw new Error(`${label} 超时`)
}

const results = []
const record = (label, value) => results.push({ label, value })

// 准备测试文件
fs.mkdirSync(TEST_DIR, { recursive: true })
for (const name of FILES) fs.writeFileSync(path.join(TEST_DIR, name), 'test')
record('测试文件已创建', FILES.length)

const q = async (query, scope = null) =>
  (await invoke('search_files', { query, scope, limit: 10 })).map((hit) => hit.name)

const beforeScan = await invoke('index_status')
await invoke('start_index')
await waitUntil('文件进入索引', async () => {
  const status = await invoke('index_status')
  return status.state === 'ready' && (await q('财务')).some((name) => name.includes('财务预算'))
})
record('扫描后条目数', (await invoke('index_status')).files)



// 扫描与监听是两条路径：断言"最终能被搜到"，而不是"立刻能搜到"
async function waitForHit(query, pattern, timeoutMs = 8000) {
  const started = Date.now()
  let hits = []
  while (Date.now() - started < timeoutMs) {
    hits = await q(query)
    if (hits.some((name) => name.includes(pattern))) return hits
    await sleep(250)
  }
  return hits
}

const finHits = await waitForHit('财务', '财务预算'); record('中文「财务」', finHits)
record('中文「会议」', await q('会议'))
record('拼音全拼「caiwu」', await q('caiwu'))
record('拼音全拼「huiyi」', await q('huiyi'))
const cwbgHits = await q('cwbg'); record('首字母「cwbg」', cwbgHits)
const hyjyHits = await q('hyjy'); record('首字母「hyjy」', hyjyHits)
record('中英混合「xlsx 销售」', await q('xlsx 销售'))
record('路径中文「aura-m2-test」', await q('aura-m2-test'))
const scopedHits = await invoke('search_files', { query: '财务', scope: TEST_DIR, limit: 10 }); record('范围=测试目录', scopedHits.map((hit) => hit.name))
record('范围=文档根跑同一词', (await q('财务', path.dirname(TEST_DIR))).length)

// 排序：文件名精确匹配应排在前面
const ranked = await invoke('search_files', { query: '财务', scope: null, limit: 5 })
record('排序首条', ranked[0]?.name ?? '（空）')

// 清理：删除测试文件 → 重新扫描 → 确认被清理
fs.rmSync(TEST_DIR, { recursive: true, force: true })
await invoke('start_index')
await waitUntil('删除后索引清理', async () => !(await q('财务')).some((name) => name.includes('财务预算')))
record('清理后条目数', (await invoke('index_status')).files)
async function waitForGone(query, pattern, timeoutMs = 8000) {
  const started = Date.now()
  let hits = []
  while (Date.now() - started < timeoutMs) {
    hits = await q(query)
    if (!hits.some((name) => name.includes(pattern))) return hits
    await sleep(250)
  }
  return hits
}

const afterCleanHits = await waitForGone('财务', '财务预算')
record('清理后「财务」', afterCleanHits)

const failures = []
if (!finHits.some((name) => name.includes('财务预算'))) failures.push('中文检索未命中')
if (!cwbgHits.some((name) => name.includes('财务预算'))) failures.push('跳字首字母 cwbg 未命中')
if (!hyjyHits.some((name) => name.includes('会议纪要'))) failures.push('首字母 hyjy 未命中')
if (!scopedHits.every((hit) => hit.path.startsWith(TEST_DIR))) failures.push('范围过滤泄漏到目录外')
if (afterCleanHits.some((name) => name.includes('财务预算'))) failures.push('删除后仍能搜到')

console.log(JSON.stringify(results, null, 2))
if (failures.length > 0) {
  console.error('FAILED:', JSON.stringify(failures, null, 2))
  process.exit(1)
}
ws.close()
