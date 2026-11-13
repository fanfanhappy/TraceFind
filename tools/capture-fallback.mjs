import fs from "node:fs"
const port = 9223
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find(t => t.type === "page" && t.url.includes("tauri.localhost"))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send = (method, params={}) => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})) })
await send("Page.enable"); await send("Runtime.enable")
await send("Runtime.evaluate", { expression: `document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'` })
await new Promise(r => setTimeout(r, 400))
const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true })
fs.writeFileSync("shots/37-hotkey-fallback.png", Buffer.from(data, "base64"))
console.log("saved 37-hotkey-fallback.png")
ws.close()
