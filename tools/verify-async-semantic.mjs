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
const ev = async x => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.value

await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(600)
await ev(`(() => { const i=document.querySelector('input'); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,'界面配色看着累'); i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await sleep(250)
const early = await ev(`document.querySelectorAll('[role=option]').length`)
await sleep(1200)
const late = await ev(`document.querySelectorAll('[role=option]').length`)
const names = await ev(`[...document.querySelectorAll('[role=option]')].slice(0,3).map(n => n.textContent.slice(0,40))`)
console.log(`异步语义：250ms=${early} 条 → 1.4s=${late} 条`)
console.log('前三条:', JSON.stringify(names))
ws.close()
