// 模块五端到端：预览数据（文本 / Office / PDF / 图片 / 不支持）
const PORT = process.argv[2] ?? '9223'

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

const find = async (query) => (await invoke('search_files', { query, scope: null, limit: 30 })) ?? []

const pickByExt = (hits, ext) => hits.find((hit) => hit.ext === ext)

// DOCX
const docxHits = await find('示例设计说明书')
const docx = pickByExt(docxHits, 'docx')
if (docx) {
  const preview = await invoke('preview_file', { path: docx.path })
  record('DOCX 预览', {
    kind: preview.kind,
    chars: preview.totalChars,
    truncated: preview.truncated,
    含命中词: (preview.text ?? '').includes('托盘'),
    头部: (preview.text ?? '').slice(0, 40),
  })
}

// PDF
const pdf = pickByExt(docxHits, 'pdf')
if (pdf) {
  const preview = await invoke('preview_file', { path: pdf.path })
  record('PDF 预览', {
    kind: preview.kind,
    chars: preview.totalChars,
    头部: (preview.text ?? preview.message ?? '').slice(0, 60),
  })
}

// 图片
const imageHits = await find('png')
const image = imageHits.find((hit) => hit.kind === 'image')
if (image) {
  const preview = await invoke('preview_file', { path: image.path })
  record('图片预览', {
    name: preview.name,
    kind: preview.kind,
    dataUrl前缀: (preview.imageDataUrl ?? '').slice(0, 24),
  })
}

// 代码/文本
const codeHits = await find('md')
const code = codeHits.find((hit) => hit.ext === 'md' || hit.ext === 'ts' || hit.ext === 'rs')
if (code) {
  const preview = await invoke('preview_file', { path: code.path })
  record('文本预览', { name: preview.name, kind: preview.kind, language: preview.language, chars: preview.totalChars })
}

// 二进制/不支持
const binaryHits = await find('exe')
const binary = binaryHits.find((hit) => hit.ext === 'exe' || hit.ext === 'dll')
if (binary) {
  const preview = await invoke('preview_file', { path: binary.path })
  record('不支持的类型', { name: preview.name, kind: preview.kind, message: preview.message })
}

const failures = results.filter(r => ['DOCX 预览','文本预览','图片预览','不支持的类型'].includes(r.label) && (!r.value || r.value.kind === 'error' || (r.label === '不支持的类型' ? r.value.kind !== 'unsupported' : false))).map(r => r.label)
console.log(JSON.stringify(results, null, 2))
if (failures.length > 0) {
  console.error('FAILED:', JSON.stringify(failures, null, 2))
  process.exit(1)
}
ws.close()
