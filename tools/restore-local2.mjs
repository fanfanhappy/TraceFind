const port = 9223
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find(t => t.type === "page" && t.url.includes("tauri.localhost"))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send = (method, params={}) => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})) })
await send("Runtime.enable")
const call = async (cmd, args={}) => (await send("Runtime.evaluate", { expression: `(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})))()`, awaitPromise: true, returnByValue: true })).result.value
const s = JSON.parse(await call('patch_settings', { patch: {
  semanticProvider: 'local', cloudModel: 'text-embedding-3-small', cloudBaseUrl: 'https://api.openai.com/v1', semanticEnabled: true } }))
console.log('恢复本地:', s.semanticProvider, s.cloudModel, 'enabled=' + s.semanticEnabled)
ws.close()
