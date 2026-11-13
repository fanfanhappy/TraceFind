// 模块四端到端：正文抽取 + FTS5 检索
// 用真实的 docx/pdf 验证「文件名里没有、正文里有」的关键词能命中，并带回片段。
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

// 清空并重建，保证从零开始验证
await invoke('rebuild_content')
await sleep(1500)

// 只等"这套用例要验证的正文"就绪，不等全库跑空（图片 OCR 队列可能很长）
let status
const started = Date.now()
let ready = false
while (Date.now() - started < 180_000) {
  status = await invoke('content_status')
  if (status.done > 0) {
    const probe = await invoke('search_files', { query: '托盘', scope: null, limit: 5 })
    if (probe.some((hit) => hit.snippet)) {
      ready = true
      break
    }
  }
  await sleep(1000)
}
record('正文索引状态', status)
record('用例资料就绪', ready)
record('等待耗时(ms)', Date.now() - started)

const search = (query) => invoke('search_files', { query, scope: null, limit: 10 })

// 这些词只出现在正文里，文件名中没有
for (const term of ['托盘', '窗口规格', '玻璃', '快捷键注册']) {
  const hits = await search(term)
  const withSnippet = hits.filter((hit) => hit.snippet)
  record(`正文「${term}」`, {
    命中数: hits.length,
    带片段: withSnippet.length,
    首条: hits[0] ? `${hits[0].name}` : null,
    片段: withSnippet[0]?.snippet?.slice(0, 80) ?? null,
  })
}

// 文件名命中仍要优先，并且不应被正文结果挤掉
const byName = await search('AURA')
record('文件名「AURA」', { 命中数: byName.length, 首条: byName[0]?.name ?? null })

// 范围过滤 + 正文
const settings = await invoke('get_settings')
const docsRoot = settings.roots.find((root) => root.endsWith('Documents'))
if (docsRoot) {
  const scoped = await invoke('search_files', { query: '托盘', scope: docsRoot, limit: 10 })
  record('正文 + 范围过滤', { 命中数: scoped.length, 首条: scoped[0]?.name ?? null })
}

const failures = results.filter(r => typeof r.label === 'string' && r.label.startsWith('正文「') && (r.value.命中数 === 0 || r.value.带片段 === 0)).map(r => r.label)
console.log(JSON.stringify(results, null, 2))
if (failures.length > 0) {
  console.error('FAILED:', JSON.stringify(failures, null, 2))
  process.exit(1)
}
ws.close()
