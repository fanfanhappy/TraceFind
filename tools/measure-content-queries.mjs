// 逐条测量不同查询的耗时，定位正文检索的开销来源
const PORT = process.argv[2] ?? '9223'
const QUERIES = ['a', 'au', 'aura', 'doc', 'docx', '文件', '会议', 'cwbg', 'xlsx', '托盘', '窗口规格', '的']

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
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
  const rows = []
  for (const query of ${JSON.stringify(QUERIES)}) {
    const started = performance.now()
    const hits = await window.__TAURI_INTERNALS__.invoke('search_files', { query, scope: null, limit: 30 })
    rows.push({ query, ms: Math.round((performance.now() - started) * 10) / 10, hits: hits.length, snippets: hits.filter(h => h.snippet).length })
  }
  return rows
})()`

const result = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log(JSON.stringify(result.result.value, null, 2))
ws.close()
