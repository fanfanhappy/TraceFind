// 模块三端到端：验证文件监听 + 增量写入
// 新建 / 改名 / 删除 都会在 5 秒内反映到搜索结果里，且不需要重新扫描。
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

const results = []
const record = (label, value) => results.push({ label, value })

const DIR = path.join(process.env.USERPROFILE ?? 'C:\\Users\\demo', 'Documents', 'aura-watch-test')
const FILE_A = path.join(DIR, '实时测试文件.txt')
const FILE_B = path.join(DIR, '改名之后的文件.txt')

const searchNames = async (query) =>
  (await invoke('search_files', { query, scope: null, limit: 10 })).map((hit) => hit.name)

/** 轮询等待某个断言成立，返回耗时（ms）与最终结果 */
async function waitFor(label, predicate, timeoutMs = 6000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await predicate()
    if (last.ok) {
      record(label, { ok: true, ms: Date.now() - started, detail: last.detail })
      return true
    }
    await sleep(200)
  }
  record(label, { ok: false, ms: Date.now() - started, detail: last?.detail })
  return false
}

const info = await invoke('get_runtime_info')
record('实时监听已开启', info.watching)

// 1) 新建目录 + 文件
fs.mkdirSync(DIR, { recursive: true })
fs.writeFileSync(FILE_A, 'watch test')
await waitFor('新建文件出现在搜索结果', async () => {
  const names = await searchNames('实时测试')
  return { ok: names.includes('实时测试文件.txt'), detail: names }
})

// 2) 改名（同一目录内 rename）
fs.renameSync(FILE_A, FILE_B)
await waitFor('改名后旧名消失', async () => {
  const names = await searchNames('实时测试')
  return { ok: !names.includes('实时测试文件.txt'), detail: names }
})
await waitFor('改名后新名可搜到', async () => {
  const names = await searchNames('改名之后')
  return { ok: names.includes('改名之后的文件.txt'), detail: names }
})

// 3) 新建子目录并放入文件（验证目录变更会递归补扫）
const SUB = path.join(DIR, '子目录')
fs.mkdirSync(SUB, { recursive: true })
fs.writeFileSync(path.join(SUB, '深层文件.md'), '# x')
await waitFor('子目录里的新文件可搜到', async () => {
  const names = await searchNames('深层文件')
  return { ok: names.includes('深层文件.md'), detail: names }
})

// 4) 删除文件
fs.rmSync(FILE_B)
await waitFor('删除后从索引消失', async () => {
  const names = await searchNames('改名之后')
  return { ok: !names.includes('改名之后的文件.txt'), detail: names }
})

// 5) 删除整个目录（子树清理）
fs.rmSync(DIR, { recursive: true, force: true })
await waitFor('删除目录后子树清空', async () => {
  const names = await searchNames('深层文件')
  return { ok: names.length === 0, detail: names }
})

// 6) 索引条目数应回到稳定值
const status = await invoke('index_status')
record('索引状态', { state: status.state, files: status.files })

const failures = results.filter(r => r.value && r.value.ok === false).map(r => r.label)
console.log(JSON.stringify(results, null, 2))
if (failures.length > 0) {
  console.error('FAILED:', JSON.stringify(failures, null, 2))
  process.exit(1)
}
ws.close()
