const port = 9223
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find(t => t.type === "page" && t.url.includes("tauri.localhost"))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send = (method, params={}) => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})) })
await send("Runtime.enable")
const call = async (cmd, args={}) => (await send("Runtime.evaluate", { expression: `(async () => { try { return JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})) } catch (e) { return 'ERR ' + String(e) } })()`, awaitPromise: true, returnByValue: true })).result.value
for (const q of ['界面配色看着累', '预算报告', '快捷键冲突怎么办']) {
  const raw = await call('ask_files', { question: q, scope: null })
  if (raw.startsWith('ERR')) { console.log(q, '->', raw); continue }
  const r = JSON.parse(raw)
  console.log(q, '->', r.sources.length, '段 |', r.answer.slice(0, 60))
}
ws.close()
