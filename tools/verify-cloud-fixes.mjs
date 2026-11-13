const port = 9223
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find(t => t.type === "page" && t.url.includes("tauri.localhost"))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map(); const events = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled') return
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
}
const send = (method, params={}) => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})) })
await send("Runtime.enable")
const call = async (cmd, args={}) => (await send("Runtime.evaluate", { expression: `(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})))()`, awaitPromise: true, returnByValue: true })).result.value

// 监听设置事件，检查是否带密文
await send("Runtime.evaluate", { expression: `
  window.__evt = [];
  window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'aura:settings-changed', target: { kind: 'Any' }, handler: window.__tauri__ ? undefined : undefined }).catch(()=>{});
`, awaitPromise: true })

// P1-3：搜索延迟（本地结果应立即返回）
const t0 = Date.now()
const hits = JSON.parse(await call('search_files', { query: '界面配色看着累', scope: null, limit: 8 }))
const t1 = Date.now()
console.log(`P1-3 本地结果返回: ${hits.length} 条, ${t1-t0}ms`)

// P1-2：scope 过滤
const probe = JSON.parse(await call('semantic_probe', { query: '界面配色看着累', limit: 8, scope: '${process.env.TRACEFIND_TEST_DOCS ?? "C:\\\\Users\\\\demo\\\\Documents"}' }))
const outside = probe.filter(([path]) => !path.startsWith('${process.env.TRACEFIND_TEST_DOCS ?? "C:\\\\Users\\\\demo\\\\Documents"}'))
console.log(`P1-2 scope=Documents: ${probe.length} 条, 越界 ${outside.length} 条`, outside.slice(0,2))

// P1-1：未确认时开启云端应被拒绝
await call('patch_settings', { patch: { semanticProvider: 'cloud', cloudConsent: false } })
const denied = await call('set_semantic', { enabled: true })
console.log('P1-1 未确认开启云端:', denied.slice(0, 80))

// P2-2：改模型应清空向量
const before = JSON.parse(await call('semantic_status', {}))
await call('patch_settings', { patch: { cloudModel: 'another-model' } })
const after = JSON.parse(await call('semantic_status', {}))
console.log(`P2-2 改模型后 vectors: ${before.vectors} -> ${after.vectors}`)
console.log('P2-2 日志身份:', (await call('get_settings', {})).includes('another-model'))
ws.close()
