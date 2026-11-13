// 生命周期状态机端到端验证：通过 WebView2 远程调试端口调用真实命令，
// 断言 hidden → showing → visible → hiding → hidden 的相位变化与窗口可见性。

const PORT = process.argv[2] ?? '9223'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && (t.url.includes('tauri.localhost') || t.url.includes('1420')))
if (!page) throw new Error('找不到主窗口页面目标')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const invoke = (cmd, args) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`)

const info = () => invoke('get_runtime_info')
const results = []
const record = (label, value) => {
  results.push({ label, value })
}

record('初始相位', (await info()).phase)

// 隐藏：应经过 hiding 再到 hidden
await invoke('hide_launcher')
await sleep(60)
record('隐藏中相位', (await info()).phase)
await sleep(450)
const afterHide = await info()
record('隐藏后相位', afterHide.phase)
record('隐藏后窗口可见', afterHide.launcherVisible)

// 显示：应立即进入 showing，动画结束后 visible
await invoke('show_launcher')
await sleep(60)
record('唤起中相位', (await info()).phase)
await sleep(450)
const afterShow = await info()
record('唤起后相位', afterShow.phase)
record('唤起后窗口可见', afterShow.launcherVisible)

// toggle：可见时应转入 hiding
await invoke('toggle_launcher')
await sleep(60)
record('toggle 后相位', (await info()).phase)
await sleep(450)
record('toggle 稳定相位', (await info()).phase)

// 再 toggle 回到可见，检查重复唤起只是 focus 不改相位
await invoke('toggle_launcher')
await sleep(500)
record('二次唤起相位', (await info()).phase)
const settingsBefore = await invoke('get_settings')
await invoke('show_launcher')
await sleep(200)
const settingsAfter = await invoke('get_settings')
record('重复唤起不重置设置', JSON.stringify(settingsBefore) === JSON.stringify(settingsAfter))

// 设置写入 + 跨窗口广播
const patched = await invoke('patch_settings', { patch: { resultLimit: 12 } })
record('设置写入生效', patched.resultLimit)
await invoke('patch_settings', { patch: { resultLimit: 8 } })

record('末尾相位', (await info()).phase)
record('运行环境', `${(await info()).platform} / material=${(await info()).material} / hotkey=${(await info()).hotkey} active=${(await info()).hotkeyActive}`)

console.log(JSON.stringify(results, null, 2))
ws.close()
