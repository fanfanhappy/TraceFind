const port = 9223
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
await send('Runtime.enable')
const evalJs = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { error: r.exceptionDetails.text } : r.result.value }
console.log('APPLY:', JSON.stringify(await evalJs(`window.__TAURI_INTERNALS__.invoke('apply_hotkey', { accel: 'Ctrl+Alt+Space' })`)))
console.log('INFO:', JSON.stringify(await evalJs(`window.__TAURI_INTERNALS__.invoke('get_runtime_info')`)))
ws.close()
