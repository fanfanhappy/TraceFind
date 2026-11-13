import fs from "node:fs"
const port = 9223
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find(t => t.type === "page" && t.url.includes("tauri.localhost"))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send = (method, params={}) => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})) })
await send("Page.enable"); await send("Runtime.enable")
const ev = async x => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.value
await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(500)
await ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)
await ev(`(() => { const i=document.querySelector('input'); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,'预算'); i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await sleep(900)
const brand = await ev(`({ name: document.querySelector('.brandbar__brand')?.textContent, mark: !!document.querySelector('.brandbar__mark svg'), version: document.querySelector('.brandbar__version')?.textContent })`)
console.log('品牌:', JSON.stringify(brand))
const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true })
fs.writeFileSync("shots/45-tracefind-main.png", Buffer.from(data, "base64"))
console.log('saved 45-tracefind-main.png')
ws.close()
