const SCOPE = process.env.TRACEFIND_TEST_DOCS ?? 'C:\\\\Users\\\\demo\\\\Documents'
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

const probe = JSON.parse(await call('semantic_probe', { query: '界面配色看着累', limit: 10, scope: 'C:\\Users\\demo\\Documents' }))
const outside = probe.filter(([p]) => !p.toLowerCase().startsWith('c:\\users\\demo\\documents\\'))
console.log(`P1-2 scope=Documents: ${probe.length} 条, 越界 ${outside.length}`)
if (outside.length) console.log(outside.slice(0,2))

const t0 = Date.now()
const hits = JSON.parse(await call('search_files', { query: '界面配色看着累', scope: 'C:\\Users\\demo\\Documents', limit: 8 }))
console.log(`P1-3 同步返回: ${hits.length} 条, ${Date.now()-t0}ms`)
ws.close()
