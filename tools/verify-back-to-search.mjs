// 验证设置窗口的“返回搜索”：点返回箭头后，设置窗口关闭且主窗口被唤起。
const PORT = process.argv[2] ?? '9223'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    return result.exceptionDetails ? { error: result.exceptionDetails.text } : result.result.value
  }
  return { evaluate, close: () => ws.close() }
}

const targetsOf = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json())
const isMain = (t) => t.url.includes('tauri.localhost/') || t.url.endsWith('1420/')
const isSettings = (t) => t.url.includes('settings.html')

const results = []
const record = (label, value) => results.push({ label, value })

let targets = await targetsOf()
const main = await attach(targets.find((t) => isMain(t)))
await main.evaluate(`window.__TAURI_INTERNALS__.invoke('open_settings')`)
await sleep(2200)

targets = await targetsOf()
const settingsPage = targets.find((t) => isSettings(t))
record('设置窗口已打开', Boolean(settingsPage))

if (settingsPage) {
  const settings = await attach(settingsPage)
  record('返回按钮存在', await settings.evaluate(`!!document.querySelector('.iconbtn--back')`))
  record('返回按钮标题', await settings.evaluate(`document.querySelector('.iconbtn--back')?.getAttribute('title')`))
  await settings.evaluate(`document.querySelector('.iconbtn--back').click()`)
  await sleep(1200)
  settings.close()
}

targets = await targetsOf()
record('设置窗口已关闭', !targets.some((t) => isSettings(t)))
const info = await main.evaluate(`window.__TAURI_INTERNALS__.invoke('get_runtime_info')`)
record('主窗口相位', info.phase)
record('主窗口可见', info.launcherVisible)

// Esc 等价路径
await main.evaluate(`window.__TAURI_INTERNALS__.invoke('open_settings')`)
await sleep(2200)
targets = await targetsOf()
const page2 = targets.find((t) => isSettings(t))
if (page2) {
  const settings2 = await attach(page2)
  await settings2.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(1200)
  settings2.close()
}
targets = await targetsOf()
record('Esc 后设置窗口关闭', !targets.some((t) => isSettings(t)))
const info2 = await main.evaluate(`window.__TAURI_INTERNALS__.invoke('get_runtime_info')`)
record('Esc 后主窗口可见', info2.launcherVisible)

console.log(JSON.stringify(results, null, 2))
main.close()
