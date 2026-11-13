// 抓取模块二的界面状态：真实最近文件、真实搜索结果、范围过滤、索引设置页。
import fs from 'node:fs'

const PORT = process.argv[2] ?? '9223'
const OUT = process.argv[3] ?? 'shots'
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
  await send('Page.enable')
  await send('Runtime.enable')
  return { send, close: () => ws.close() }
}

const targets = async () =>
  (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(
    (t) => t.type === 'page' && !t.url.includes('settings.html'),
  )

async function main() {
  const [page] = await targets()
  const client = await attach(page)

  // 固定主题，避免上次实验留下的浅色
  await client.send('Runtime.evaluate', {
    expression: `document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`,
  })
  await sleep(400)

  const shot = async (file) => {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(`${OUT}/${file}`, Buffer.from(data, 'base64'))
    console.log('saved', file)
  }

  await shot('30-m2-empty-real.png')

  // 真实输入
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 92, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 92, button: 'left', clickCount: 1 })
  await client.send('Input.insertText', { text: 'aura' })
  await sleep(500)
  await shot('31-m2-search-aura.png')

  const count = await client.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('[role=option]').length`,
    returnByValue: true,
  })
  console.log('results for aura =', count.result.value)

  // 清空后点“文档”范围
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'
    })()`,
  })
  await sleep(400)
  await client.send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.chip')].find(b => b.textContent.includes('Documents') || b.textContent.includes('文档'))?.click()`,
  })
  await sleep(500)
  await shot('32-m2-scope.png')

  client.close()

  // 设置窗口的「索引与扫描」页
  const mainPage = (await targets())[0]
  const mainClient = await attach(mainPage)
  await mainClient.send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke('open_settings')`,
    awaitPromise: true,
  })
  mainClient.close()
  await sleep(2500)

  const all = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const settingsPage = all.find((t) => t.type === 'page' && t.url.includes('settings.html'))
  if (settingsPage) {
    const s = await attach(settingsPage)
    await s.send('Runtime.evaluate', {
      expression: `document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F';
        [...document.querySelectorAll('.navitem')].find(b => b.textContent.includes('索引与扫描'))?.click()`,
    })
    await sleep(600)
    const { data } = await s.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(`${OUT}/33-settings-indexing.png`, Buffer.from(data, 'base64'))
    console.log('saved 33-settings-indexing.png')
    s.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
