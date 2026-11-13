// 界面验证：用 headless Chromium 走真实的浏览器输入管线。
// 浏览器预览下没有 Rust 索引，数据来自 src/lib/files.ts 的演示条目，
// 因此断言只检查“行为”而不写死具体条数，桌面端另有 verify-m2.mjs 验证真实数据。
//
// 用法：node tools/verify-ui.mjs [baseUrl] [outDir]

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const BASE = process.argv[2] ?? 'http://127.0.0.1:4173/'
const OUT = process.argv[3] ?? 'shots'
const PROFILE = path.resolve('.ui-profile')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  await fs.rm(PROFILE, { recursive: true, force: true })

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let wsUrl = null
  for (let i = 0; i < 80 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      wsUrl = (await res.json()).webSocketDebuggerUrl
    } catch {
      await sleep(150)
    }
  }
  assert.ok(wsUrl, 'Chrome 未启动')

  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  let seq = 0
  const pending = new Map()
  const consoleErrors = []

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.text ?? 'exception')
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  }

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cmd = (method, params = {}) => send(method, params, sessionId)

  await cmd('Page.enable')
  await cmd('Runtime.enable')
  await cmd('Page.bringToFront')
  await cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cmd('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 540,
    deviceScaleFactor: 2,
    mobile: false,
  })

  async function goto(url) {
    await cmd('Page.navigate', { url })
    await sleep(700)
    await cmd('Page.bringToFront')
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
    await sleep(150)
  }

  async function clickSearchField() {
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 92, button: 'left', clickCount: 1 })
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 92, button: 'left', clickCount: 1 })
    await sleep(120)
  }

  const evaluate = async (expression) => {
    const result = await cmd('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  async function shot(name) {
    const { data } = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await fs.writeFile(path.join(OUT, name), Buffer.from(data, 'base64'))
  }

  async function key(keyName, code, vk) {
    await cmd('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyName,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    })
    await cmd('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyName,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    })
    await sleep(140)
  }

  const results = []
  const check = async (label, fn) => results.push({ label, value: await fn() })

  /* ---------------------------------------------------------- 深色主窗口 */
  await goto(BASE)

  await check('初始聚焦在搜索框', () => evaluate(`document.activeElement?.tagName === 'INPUT'`))
  await check('空状态有最近文件', () => evaluate(`document.querySelectorAll('[role=option]').length`))
  await shot('01-launcher-empty-dark.png')

  await clickSearchField()
  await cmd('Input.insertText', { text: 'aura' })
  await sleep(350)
  await check('输入后命中条数', () => evaluate(`document.querySelectorAll('[role=option]').length`))
  // 命中可能发生在文件名或路径上，两者都算
  await check(
    '每条结果都含关键词',
    () =>
      evaluate(`[...document.querySelectorAll('.result')].every(row =>
        row.textContent.toLowerCase().includes('aura'))`),
  )
  await check('命中片段被高亮', () => evaluate(`document.querySelectorAll('mark').length > 0`))
  await shot('02-launcher-results-dark.png')

  await key('ArrowDown', 'ArrowDown', 40)
  await check('方向键改变选中项', () =>
    evaluate(`document.querySelectorAll('[role=option]')[1]?.getAttribute('aria-selected')`),
  )

  await key('Tab', 'Tab', 9)
  await check('Tab 后焦点在列表', () => evaluate(`document.activeElement?.getAttribute('role')`))
  await key(' ', 'Space', 32)
  await check('Space 打开预览抽屉', () => evaluate(`!!document.querySelector('.drawer')`))
  await shot('03-launcher-preview-dark.png')

  await key('Escape', 'Escape', 27)
  await check('Esc 关闭预览', () => evaluate(`!document.querySelector('.drawer')`))
  await key('Escape', 'Escape', 27)
  await check('再按 Esc 清空输入', () => evaluate(`document.querySelector('input').value === ''`))

  /* --------------------------------------------------------------- 浅色 */
  await evaluate(`localStorage.setItem('aura-settings', JSON.stringify({theme:'light'}))`)
  await goto(BASE)
  await sleep(300)
  await check('浅色主题生效', () => evaluate(`document.documentElement.dataset.theme`))
  await shot('04-launcher-empty-light.png')
  await clickSearchField()
  await cmd('Input.insertText', { text: '设计' })
  await sleep(350)
  await shot('05-launcher-results-light.png')

  /* ------------------------------------------------------------- 设置窗口 */
  await evaluate(`localStorage.setItem('aura-settings', JSON.stringify({theme:'dark'}))`)
  await goto(`${BASE}settings.html`)
  await sleep(300)
  await check('设置分类数量', () => evaluate(`document.querySelectorAll('.navitem').length`))
  await check('返回搜索按钮存在', () => evaluate(`!!document.querySelector('.iconbtn--back')`))
  await shot('06-settings-general.png')

  await evaluate(`[...document.querySelectorAll('.navitem')].find(b => b.textContent.includes('索引与扫描'))?.click()`)
  await sleep(300)
  await check('索引页有扫描范围区', () => evaluate(`document.querySelectorAll('.pathrow').length`))
  await shot('07-settings-indexing.png')

  await evaluate(`[...document.querySelectorAll('.navitem')].find(b => b.textContent.includes('外观'))?.click()`)
  await sleep(250)
  await shot('08-settings-appearance.png')

  await evaluate(`[...document.querySelectorAll('.navitem')].find(b => b.textContent.includes('快捷键'))?.click()`)
  await sleep(250)
  await shot('09-settings-hotkeys.png')

  const errors = consoleErrors.filter((line) => !line.includes('favicon'))
  await check('无控制台错误', () => errors.length)

  ws.close()
  chrome.kill()

  console.log(JSON.stringify(results, null, 2))
  console.log('CONSOLE_ERRORS', JSON.stringify(errors))
  console.log('SHOTS', OUT)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
