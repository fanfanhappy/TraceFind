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
await send("Runtime.enable")
const ev = async x => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? {error: r.exceptionDetails.text} : r.result.value }
await ev(`window.__TAURI_INTERNALS__.invoke('open_settings')`)
await sleep(2500)
const all = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const sp = all.find(t => t.url.includes("settings.html"))
if (!sp) { console.log("no settings page"); ws.close(); process.exit(1) }
const w2 = new WebSocket(sp.webSocketDebuggerUrl)
await new Promise((r, j) => { w2.onopen = r; w2.onerror = j })
let s2 = 0; const p2 = new Map()
w2.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p2.has(m.id)) { const p = p2.get(m.id); p2.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send2 = (method, params={}) => new Promise((resolve,reject)=>{ const id=++s2; p2.set(id,{resolve,reject}); w2.send(JSON.stringify({id,method,params})) })
await send2("Page.enable"); await send2("Runtime.enable")
await send2("Runtime.evaluate", { expression: `
  document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F';
  const nav=[...document.querySelectorAll('nav button, .settings-nav button, button')].find(b=>b.textContent.includes('AI'));
  nav?.click();
` })
await sleep(900)
const { data } = await send2("Page.captureScreenshot", { format: "png", fromSurface: true })
fs.writeFileSync("shots/39-semantic-settings.png", Buffer.from(data, "base64"))
console.log("saved 39-semantic-settings.png")
await ev(`window.__TAURI_INTERNALS__.invoke('close_settings')`)
w2.close(); ws.close()
