// 实测搜索耗时：在渲染进程里用 performance.now 包住 invoke，
// 包含 IPC 往返 + SQL 查询 + 排序，是用户能感知的口径。
const PORT = process.argv[2] ?? '9223'
const ROUNDS = Number(process.argv[3] ?? 30)

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

const expr = `(async () => {
  const samples = []
  const queries = ['a', 'au', 'aura', 'doc', 'docx', '文件', '会议', 'cwbg', 'mokuai', 'xlsx']
  for (let round = 0; round < ${ROUNDS}; round += 1) {
    const query = queries[round % queries.length]
    const started = performance.now()
    await window.__TAURI_INTERNALS__.invoke('search_files', { query, scope: null, limit: 30 })
    samples.push(Math.round((performance.now() - started) * 100) / 100)
  }
  return samples
})()`

const result = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
})

const samples = result.result.value
const sorted = [...samples].sort((a, b) => a - b)
const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]

console.log(
  JSON.stringify(
    {
      rounds: samples.length,
      p50: pick(0.5),
      p95: pick(0.95),
      max: sorted[sorted.length - 1],
      samples,
    },
    null,
    2,
  ),
)
ws.close()
