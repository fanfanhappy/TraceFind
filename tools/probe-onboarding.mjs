// 首次使用引导：逐步点击并截图，最后确认落库
import fs from 'node:fs'
import path from 'node:path'

const [PORT = '9229', OUT = 'docs/screens'] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let targets = null
for (let i = 0; i < 80 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  } catch {
    await sleep(250)
  }
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push(String(m.params.exceptionDetails?.text ?? '').slice(0, 200))
  }
  if (!m.id || !pending.has(m.id)) return
  const p = pending.get(m.id)
  pending.delete(m.id)
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
}
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result
    ?.value
const call = async (cmd, args = {}) =>
  ev(`(async () => {
    try { return JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})) }
    catch (error) { return 'ERR ' + String(error) }
  })()`)

const shoot = async (name) => {
  await sleep(600)
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'))
  console.log('saved', name)
}

/** 只在引导面板里找按钮，并用真实鼠标事件点击 */
const clickOnboarding = async (text) => {
  const rect = await ev(`(() => {
    const btn = [...document.querySelectorAll('.onboarding .btn, .onboarding .linkbtn')]
      .find((el) => el.textContent.trim().includes(${JSON.stringify(text)}))
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  })()`)
  if (!rect) return 'missing'
  const { x, y } = JSON.parse(rect)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return 'ok'
}

await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
let shown = false
for (let i = 0; i < 40 && !shown; i++) {
  shown = await ev(`!!document.querySelector('.onboarding')`)
  if (!shown) await sleep(250)
}
if (!shown) {
  console.log('引导未出现')
  process.exit(2)
}

// 固定材质，避免截到半透明玻璃
await ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)
await sleep(900)
await shoot('13-onboarding-welcome.png')

console.log('start:', await clickOnboarding('开始'))
await sleep(800)
console.log('step2:', await ev(`document.querySelectorAll('.onboarding__root').length`), 'roots')
// 截图里用示例路径，避免把本机用户名带进仓库
await ev(`(() => {
  for (const el of document.querySelectorAll('.onboarding__rootpath')) {
    el.textContent = el.textContent.replace(/C:\\\\Users\\\\[^\\\\]+/i, 'C:\\\\Users\\\\demo')
  }
  return true
})()`)
await shoot('14-onboarding-folders.png')

console.log('next:', await clickOnboarding('下一步'))
await sleep(800)
await shoot('15-onboarding-ready.png')

console.log('finish:', await clickOnboarding('建立索引并开始'))
await sleep(1800)
console.log(
  'after:',
  await ev(`JSON.stringify({
    onboarding: !!document.querySelector('.onboarding'),
    rows: document.querySelectorAll('.result').length,
    files: document.querySelector('.statusbar .pill')?.textContent ?? '',
  })`),
)
// 重新观看：应该能再次拉起引导且不动已有目录
await call('restart_onboarding')
await sleep(900)
console.log('replay overlay:', await ev(`!!document.querySelector('.onboarding')`))
console.log('replay roots kept:', await ev(`document.querySelectorAll('.onboarding__root').length`))
const settings = await call('get_settings')
console.log('settings:', settings)
console.log('exceptions:', JSON.stringify(logs))
ws.close()
