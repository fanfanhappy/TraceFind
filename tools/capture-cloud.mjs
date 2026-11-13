import fs from "node:fs"
const port = 9223
const sleep = ms => new Promise(r => setTimeout(r, ms))
const all = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const sp = all.find(t => t.url.includes("settings.html"))
const ws = new WebSocket(sp.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send = (method, params={}) => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})) })
await send("Page.enable"); await send("Runtime.enable")
const ev = async x => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.value
await ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)
await sleep(300)
console.log("nav:", await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('AI 与模型')); if(!b) return 'no nav'; b.click(); return 'ok' })()`))
await sleep(700)
console.log("cloud:", await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='云端接口'); if(!b) return 'no btn'; b.click(); return 'ok' })()`))
await sleep(1200)
const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true })
fs.writeFileSync("shots/40-cloud-embedding.png", Buffer.from(data, "base64"))
console.log("saved")
console.log("back:", await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='本地模型'); if(!b) return 'no btn'; b.click(); return 'ok' })()`))
await sleep(600)
ws.close()
