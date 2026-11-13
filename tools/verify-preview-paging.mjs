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
// 1) 分页：文本预览应返回 nextStart
const first = JSON.parse(await call('preview_file', { path: '${process.env.TRACEFIND_TEST_DOCS ?? "C:\\\\Users\\\\demo\\\\Documents"}\\示例产品说明.docx', start: 0 }))
console.log('DOCX 预览 kind=' + first.kind, 'chars=' + (first.text || '').length, 'total=' + first.totalChars, 'next=' + first.nextStart)
const code = JSON.parse(await call('preview_file', { path: 'D:\\AI_Work_Space\\AURA Search\\src\\lib\\bridge.ts', start: 0 }))
console.log('代码预览 kind=' + code.kind, 'lang=' + code.language, 'chars=' + (code.text || '').length, 'next=' + code.nextStart)
const page2 = JSON.parse(await call('preview_file', { path: 'D:\\AI_Work_Space\\AURA Search\\src\\lib\\bridge.ts', start: code.nextStart ?? 0 }))
console.log('第二页 chars=' + (page2.text || '').length, 'next=' + page2.nextStart)
ws.close()
