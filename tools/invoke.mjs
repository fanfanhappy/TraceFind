// 通过 WebView2 调试端口执行一个 Tauri 命令：
//   node tools/invoke.mjs <command> ['{"json":"args"}'] [port]
const PORT = process.argv[4] ?? process.env.AURA_CDP_PORT ?? '9223'
const COMMAND = process.argv[2]
// 支持两种写法：JSON 或 key=value（PowerShell 传 JSON 容易吃掉引号）
const rawArgs = process.argv[3]
const ARGS = !rawArgs
  ? {}
  : rawArgs.trim().startsWith('{')
    ? JSON.parse(rawArgs)
    : Object.fromEntries(
        rawArgs
          .split(',')
          .map((pair) => pair.split('='))
          .map(([key, value]) => {
            const text = (value ?? '').trim()
            if (text === 'true') return [key.trim(), true]
            if (text === 'false') return [key.trim(), false]
            if (/^-?\d+$/.test(text)) return [key.trim(), Number(text)]
            return [key.trim(), text]
          }),
      )

if (!COMMAND) {
  console.error('用法: node tools/invoke.mjs <command> [jsonArgs] [port]')
  process.exit(2)
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find(
  (t) => t.type === 'page' && (t.url.includes('tauri.localhost') || t.url.includes('127.0.0.1')),
)
if (!page) throw new Error('找不到窗口页面目标')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let seq = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}

await send('Runtime.enable')
const result = await send('Runtime.evaluate', {
  expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(COMMAND)}, ${JSON.stringify(ARGS)})`,
  awaitPromise: true,
  returnByValue: true,
})
console.log(JSON.stringify(result.exceptionDetails ? result.exceptionDetails : result.result.value, null, 2))
ws.close()
