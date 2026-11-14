// 在隔离实例上拍 README 用的界面截图（只用假语料）。
// 前置：tools/capture-screens.ps1 已用假语料启动实例。
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] ?? '9225'
const OUT = process.argv[3] ?? 'docs/screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) throw new Error('找不到窗口页面')

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (!msg.id || !pending.has(msg.id)) return
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Page.enable')
  await send('Runtime.enable')
  const ev = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))
      .result?.value
  return { ws, send, ev }
}

const main = await attach(page)
const { send, ev } = main

const shoot = async (session, name) => {
  await sleep(450)
  const { data } = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'))
  console.log('saved', name)
}

const type = async (text) => {
  await ev(`(() => {
    const input = document.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(900)
}

const key = async (k, code, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await sleep(300)
}

const togglePreview = () => key(' ', 'Space', 32, 2)

// 用鼠标悬停选中指定行（不会触发打开），坐标由 DOM 现算
const hoverRow = async (text) => {
  const point = await ev(`(() => {
    const row = [...document.querySelectorAll('[role=option]')]
      .find((el) => el.textContent.includes(${JSON.stringify(text)}))
    if (!row) return null
    const rect = row.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (!point) return 'missing'
  for (const type of ['mouseMoved', 'mouseMoved']) {
    await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'none' })
    await sleep(120)
  }
  await sleep(300)
  return 'ok'
}
const closePreview = () => key('Escape', 'Escape', 27)
const moveDown = () => key('ArrowDown', 'ArrowDown', 40)

const clickChip = async (label) =>
  ev(`(() => {
    const chip = [...document.querySelectorAll('.filters .chip')].find((el) => el.textContent.trim() === ${JSON.stringify(label)})
    if (!chip) return 'missing'
    chip.click()
    return 'ok'
  })()`)

await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(800)
await ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)
await sleep(300)

// 1) 搜索结果
await type('预算')
await shoot(main, '01-search.png')

// 2) DOCX 预览：悬停选中 docx 行再开预览
await type('报告')
console.log('hover docx:', await hoverRow('季度预算报告.docx'))
await togglePreview()
await sleep(1200)
console.log('preview title:', await ev(`document.querySelector('.preview__title')?.textContent ?? 'none'`))
await shoot(main, '02-preview-docx.png')
await closePreview()

// 3) JSON 预览（代码高亮）
await type('config')
await sleep(300)
await togglePreview()
await sleep(900)
await shoot(main, '03-preview-code.png')
await closePreview()

// 4) 图片预览
await type('统计')
await sleep(300)
await togglePreview()
await sleep(900)
await shoot(main, '04-preview-image.png')
await closePreview()

// 5) 类型筛选（代码）
await type('')
await sleep(400)
console.log('chip:', await clickChip('代码'))
await sleep(700)
await shoot(main, '05-filter-code.png')
await clickChip('全部')
await sleep(300)

// 6/7) 设置窗口
await ev(`window.__TAURI_INTERNALS__.invoke('open_settings')`)
await sleep(2500)
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const settingsPage = targets.find((t) => t.url.includes('settings.html'))
if (settingsPage) {
  const settings = await attach(settingsPage)
  await settings.ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)
  await sleep(300)
  const nav = (label) =>
    settings.ev(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.includes(${JSON.stringify(label)}))
      if (!btn) return 'missing'
      btn.click()
      return 'ok'
    })()`)

  console.log('nav search:', await nav('搜索与排序'))
  await sleep(800)
  await shoot(settings, '06-settings-search.png')

  console.log('nav ai:', await nav('AI 与模型'))
  await sleep(800)
  await shoot(settings, '07-settings-ai.png')

  await settings.ev(`window.__TAURI_INTERNALS__.invoke('close_settings')`)
  settings.ws.close()
}

// 10) 无结果：先限定范围，再搜一个不存在的词
await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(600)
await type('')
await sleep(400)
const scopedChip = `(() => {
  const chip = [...document.querySelectorAll('.quickrow .chip')].find((el) => /corpus|示例/.test(el.textContent))
  if (!chip) return 'missing'
  chip.click()
  return 'ok'
})()`
console.log('scope chip:', await ev(scopedChip))
await sleep(400)
await type('zzzz不存在')
await sleep(700)
await shoot(main, '10-no-results.png')
await type('')
await sleep(500)
await ev(scopedChip)
await sleep(400)

// 11) 正文命中：行内显示「正文」来源标签
await type('调剂')
await sleep(900)
await shoot(main, '11-source-tag.png')

await sleep(300)
main.ws.close()
