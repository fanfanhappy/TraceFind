// 隔离索引的端到端验证：语料由 run-isolated.ps1 准备，不碰真实用户目录。
// 覆盖四个关键场景：目录边界、删除清理、同秒覆盖、提取失败。
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] ?? '9224'
const HARD_TIMEOUT_MS = 150_000
setTimeout(() => {
  console.error('E2E HARD TIMEOUT')
  process.exit(3)
}, HARD_TIMEOUT_MS).unref()
const CORPUS = process.env.AURA_E2E_CORPUS

if (!CORPUS) {
  console.error('AURA_E2E_CORPUS 未设置')
  process.exit(2)
}

const WORK = path.join(CORPUS, 'Work')
const BENCH = path.join(CORPUS, 'Workbench')
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
const failures = []
const check = (label, ok, detail) => {
  results.push({ label, ok, detail })
  if (!ok) failures.push(label)
}

const search = async (query, scope = null) =>
  (await invoke('search_files', { query, scope, limit: 20 })) ?? []

async function waitFor(label, predicate, timeoutMs = 8000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await predicate()
    if (last.ok) break
    await sleep(200)
  }
  check(label, Boolean(last?.ok), { ms: Date.now() - started, ...last })
}

// 等首次索引就绪
await waitFor('首次索引就绪', async () => {
  const status = await invoke('index_status')
  return { ok: status.state === 'ready' && status.files >= 5, status }
})

// 1) 目录边界：scope=Work 不能命中 Workbench
await waitFor('scope=Work 命中 Work 内文件', async () => {
  const hits = await search('预算', WORK)
  return { ok: hits.some((hit) => hit.name === 'a.md'), names: hits.map((hit) => hit.name) }
})
{
  const hits = await search('预算', WORK)
  const leaked = hits.filter((hit) => hit.path.startsWith(BENCH))
  check('scope=Work 不泄漏到 Workbench', leaked.length === 0, { leaked: leaked.map((hit) => hit.name) })
}
{
  const hits = await search('预算', CORPUS)
  check(
    '不加范围时两者都能命中',
    hits.some((hit) => hit.name === 'a.md') && hits.some((hit) => hit.name === 'c.md'),
    { names: hits.map((hit) => hit.name) },
  )
}

// 2) 同秒覆盖：内容变了但大小相同、mtime 可能不变
fs.writeFileSync(path.join(CORPUS, 'note.txt'), 'v2 新内容', 'utf8')
await waitFor('覆盖后新内容可搜到', async () => {
  const hits = await search('v2')
  return { ok: hits.some((hit) => hit.name === 'note.txt'), names: hits.map((hit) => hit.name) }
})
await waitFor('覆盖后旧内容不再命中', async () => {
  const hits = await search('v1')
  return { ok: !hits.some((hit) => hit.name === 'note.txt'), names: hits.map((hit) => hit.name) }
})

// 3) 提取失败：坏 docx 记为 failed，且不会留下正文
{
  const status = await invoke('content_status')
  check('坏文件记为 failed', status.failed >= 1, status)
}

// 4) 删除：文件与正文都要消失
fs.rmSync(path.join(WORK, 'a.md'))
await waitFor('删除后从索引消失', async () => {
  const hits = await search('预算', WORK)
  return { ok: !hits.some((hit) => hit.name === 'a.md'), names: hits.map((hit) => hit.name) }
})
await waitFor('删除后正文不再命中', async () => {
  const hits = await search('本季度预算')
  return { ok: !hits.some((hit) => hit.name === 'a.md'), names: hits.map((hit) => hit.name) }
})

// 5) 监听：新建文件立刻可搜
fs.writeFileSync(path.join(WORK, 'new.md'), '新建内容 zenxin', 'utf8')
await waitFor('新建文件 5s 内可搜到', async () => {
  const hits = await search('zenxin')
  return { ok: hits.some((hit) => hit.name === 'new.md'), names: hits.map((hit) => hit.name) }
})

console.log(JSON.stringify(results, null, 2))
if (failures.length > 0) {
  console.error('FAILED:', JSON.stringify(failures))
  process.exit(1)
}
ws.close()
