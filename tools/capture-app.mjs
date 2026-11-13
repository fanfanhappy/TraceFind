// 直接从运行中的桌面程序（WebView2）抓图，不依赖桌面截屏，
// 因此在锁屏/远程会话下同样可用。产物是窗口内容的真实渲染结果。
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

async function shoot(targetPart, file, background, theme) {
  const cssColor = `rgb(${background[0]}, ${background[1]}, ${background[2]})`
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes(targetPart))
  if (!page) return false
  const client = await attach(page)
  // 截图期间临时关闭“透明材质”，让页面自己铺一层实色底，
  // 否则透明 WebView 截图会合成到白底、整图发灰。抓完即还原。
  await client.send('Runtime.evaluate', {
    expression: `
      document.documentElement.dataset.theme = '${theme}';
      document.documentElement.dataset.material = 'solid';
      document.body.style.background = '${cssColor}';
      'ok'
    `,
  })
  await sleep(400)
  // 窗口是透明的（材质由 DWM 提供），截图时补一层底色，避免合成到白底发灰
  await client.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: background[0], g: background[1], b: background[2], a: 255 },
  })
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  client.close()
  return true
}

const mainShot = await shoot('tauri.localhost/', `${OUT}/10-desktop-app-dark.png`, [23, 25, 31], 'dark')
console.log('main', mainShot)
await shoot('tauri.localhost/', `${OUT}/11-desktop-app-light.png`, [245, 244, 248], 'light')
console.log('light true')
