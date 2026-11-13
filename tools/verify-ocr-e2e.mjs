const port = 9223
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find(t => t.type === "page" && t.url.includes("tauri.localhost"))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send = (method, params={}) => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})) })
await send("Runtime.enable")
const call = async (cmd, args={}) => (await send("Runtime.evaluate", { expression: `(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})))()`, awaitPromise: true, returnByValue: true })).result.value

for (let i = 0; i < 20; i++) {
  const hits = JSON.parse(await call('search_files', { query: '季度预算', scope: null, limit: 8 }))
  const found = hits.find(h => h.name.includes('aura-ocr-test'))
  if (found) {
    console.log(`OCR 入库并可检索：${found.name}`)
    console.log('  片段:', (found.snippet || '').slice(0, 50))
    break
  }
  if (i === 19) console.log('未命中，最后一次结果:', hits.map(h => h.name).slice(0, 3))
  await sleep(3000)
}
const status = JSON.parse(await call('content_status', {}))
console.log('内容索引状态:', JSON.stringify(status))
ws.close()
