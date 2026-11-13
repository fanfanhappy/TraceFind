// 验证：设置窗口创生、开机启动开关、窗口置顶、托盘菜单所依赖的命令。
const PORT = process.argv[2] ?? '9223'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect(targetUrlPart) {
  for (let i = 0; i < 40; i += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const page = targets.find((t) => t.type === 'page' && (targetUrlPart === '@main' ? (t.url.includes('tauri.localhost') || t.url.includes('1420')) : t.url.includes(targetUrlPart)))
    if (page) return attach(page)
    await sleep(250)
  }
  throw new Error(`未找到目标 ${targetUrlPart}`)
}

async function attach(page) {
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
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  return {
    invoke: (cmd, args) =>
      evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`),
    evaluate,
    close: () => ws.close(),
  }
}

const results = []
const record = (label, value) => results.push({ label, value })

const main = await connect('@main')

// 1) 打开设置窗口
await main.invoke('open_settings')
await sleep(1500)
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const settingsTarget = targets.find((t) => t.url.includes('settings.html'))
record('设置窗口已创建', Boolean(settingsTarget))
record('页面目标数', targets.filter((t) => t.type === 'page').length)

// 2) 设置窗口里读设置、改主题，主窗口应收到广播
if (settingsTarget) {
  const settings = await attach(settingsTarget)
  const before = await settings.invoke('get_runtime_info')
  record('设置窗口材质', before.material)
  const patched = await settings.invoke('patch_settings', { patch: { theme: 'light' } })
  record('切换浅色主题', patched.theme)
  await sleep(500)
  const mainInfo = await main.invoke('get_runtime_info')
  record('主窗口主题同步', await main.evaluate(`document.documentElement.dataset.theme`))
  await settings.invoke('patch_settings', { patch: { theme: 'dark' } })
  await settings.close()
}

// 3) 开机启动开关：写入注册表登录项后立刻关闭，避免污染机器
const on = await main.invoke('patch_settings', { patch: { autostart: true } })
record('开机启动开启', on.autostart)
const infoOn = await main.invoke('get_runtime_info')
record('系统侧确认开启', infoOn.autostart)
const off = await main.invoke('patch_settings', { patch: { autostart: false } })
record('开机启动关闭', off.autostart)
const infoOff = await main.invoke('get_runtime_info')
record('系统侧确认关闭', infoOff.autostart)

// 4) 窗口置顶
const pinned = await main.invoke('patch_settings', { patch: { alwaysOnTop: true } })
record('置顶开启', pinned.alwaysOnTop)
await main.invoke('patch_settings', { patch: { alwaysOnTop: false } })

// 5) 关闭设置窗口命令
await main.invoke('close_settings')
await sleep(400)
const after = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
record('设置窗口已关闭', !after.some((t) => t.url.includes('settings.html')))

console.log(JSON.stringify(results, null, 2))
main.close()
