/**
 * 用 DevTools 协议驱动无头 Chrome 跑一个自测页面。
 *
 * 为什么不用 --virtual-time-budget：那会把 worker 的初始化卡死，异步渲染根本跑不完。
 * 这里改成真等待 —— 页面暴露 window.__selftest()，驱动调用它并 await 结果，
 * 拿到结构化数据后再截图。Node 24 自带 WebSocket，不需要任何依赖。
 *
 *   node .selftest/drive.mjs <url> <截图输出路径> [--port=9222] [--wait=60000]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
let url = args.find((a) => !a.startsWith('--'))
const outPng = args.filter((a) => !a.startsWith('--'))[1]
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : dflt
}
const PORT = Number(opt('port', 9222))
const WAIT_MS = Number(opt('wait', 60000))
const CHROME = opt('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
const EXT = opt('ext', '')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 每轮用独立 profile：共用一个 profile 时，上一轮没退干净的 Chrome 会接管新进程，
  // 于是调试端口返回的是旧实例（表现为"扩展没加载起来"，其实是连错了浏览器）。
  const profile = path.resolve('.selftest', 'chrome-profile-' + PORT)
  fs.mkdirSync(profile, { recursive: true })

  // 上一轮的结果先清掉，免得读到过期数据还以为是这一轮的
  const jsonPath0 = path.resolve('.selftest', 'last-report.json')
  try { fs.unlinkSync(jsonPath0) } catch {}

  const chromeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--window-size=1200,1600',
  ]
  if (EXT) {
    const extPath = path.resolve(EXT)
    // 以真实扩展身份跑：MV3 的 CSP 比普通网页严得多，扩展页面必须单独验一次
    chromeArgs.push(`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`)
  } else {
    chromeArgs.push('--disable-extensions-except=')
  }
  chromeArgs.push('about:blank')

  const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' })

  let target = null
  let extensionId = ''
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      const sw = list.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))
      if (sw) extensionId = sw.url.split('/')[2]
      if (target && (!EXT || extensionId)) break
    } catch {}
    await sleep(300)
  }
  if (!target) throw new Error('连不上 Chrome 的调试端口')
  if (EXT) {
    if (!extensionId) throw new Error('扩展没有加载起来（拿不到扩展 ID）')
    console.log('扩展 ID: ' + extensionId)
  }
  if (url && url.startsWith('ext:')) {
    if (!extensionId) throw new Error('要打开扩展页面，但扩展没加载（需要 --ext=）')
    url = 'chrome-extension://' + extensionId + '/' + url.slice(4)
    console.log('目标页面: ' + url)
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket 打不开')) })

  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  const consoleErrors = []
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable').catch(() => {})

  // 视口尺寸：窄屏行为（对照栏自动收起成窄条）只有把窗口真的变窄才测得到
  const vw = Number(opt('width', 1200))
  const vh = Number(opt('height', 1600))
  const dpr = Number(opt('dpr', 0))
  if (dpr > 0 || vw !== 1200 || vh !== 1600) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: vw, height: vh, deviceScaleFactor: dpr > 0 ? dpr : 1, mobile: false,
    })
    console.log('视口模拟为 ' + vw + '×' + vh + (dpr > 0 ? ' @dpr' + dpr : ''))
  }
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION ' + (msg.params?.exceptionDetails?.exception?.description || ''))
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params?.type)) {
      consoleErrors.push(msg.params.type + ': ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      consoleErrors.push('LOG ' + msg.params.entry.text)
    }
  })

  // 页面脚本执行**之前**注入（--preload=<文件>）。
  // 有些替身必须在模块加载前就在位：比如 reader.js 在模块顶层注册 onMessage 监听，
  // 替身要是等场景脚本才装，那次注册就已经错过了（踩过）。
  const preload = opt('preload', '')
  if (preload) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: fs.readFileSync(preload, 'utf8'),
    })
    console.log('已预注入: ' + preload)
  }

  await send('Page.navigate', { url })

  // 等页面把 __selftest 挂上（脚本是 module，加载完才有）
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面里抛错')
    return r.result?.value
  }

  let ready = false
  const readyDeadline = Date.now() + WAIT_MS
  while (Date.now() < readyDeadline) {
    ready = await evalJs('typeof window.__selftest === "function"').catch(() => false)
    if (ready) break
    await sleep(300)
  }

  // 真实鼠标拖拽：程序造的 Range 走不到浏览器的选中机制，只有 CDP 的真实输入事件才算数。
  // --drag=<文件> 里的脚本返回 {from:[x,y], to:[x,y], steps?}，由驱动派发按下/移动/松开。
  const dragFile = opt('drag', '')
  if (dragFile) {
    const spec = await evalJs(`(async () => { ${fs.readFileSync(dragFile, 'utf8')} })()`, true)
    if (!spec || !spec.from || !spec.to) throw new Error('拖拽脚本没有返回 from/to 坐标')
    const steps = spec.steps || 12
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spec.from[0], y: spec.from[1], button: 'none' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spec.from[0], y: spec.from[1], button: 'left', clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      const x = spec.from[0] + (spec.to[0] - spec.from[0]) * (i / steps)
      const y = spec.from[1] + (spec.to[1] - spec.from[1]) * (i / steps)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' })
      await sleep(12)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spec.to[0], y: spec.to[1], button: 'left', clickCount: 1 })
    console.log('已派发真实拖拽: ' + JSON.stringify(spec.from) + ' → ' + JSON.stringify(spec.to))
    await sleep(400)
  }

  // 真实点击：--click=<选择器> 取元素中心，派发按下/松开/点击
  const clickSel = opt('click', '')
  if (clickSel) {
    const box = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(clickSel)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, display: st.display, hidden: el.hidden }
    })()`)
    if (!box) throw new Error('找不到要点击的元素: ' + clickSel)
    console.log('点击 ' + clickSel + ' → ' + JSON.stringify(box))
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(500)
  }

  let report
  const evalFile = opt('eval', '')
  if (evalFile) {
    // 场景脚本要用页面自己的测试入口，必须等模块真的执行完。
    // 不等的话会拿到 undefined，还会误判成"CSP 把脚本拦了"。
    const entryWait = opt('entry', '__readerTest')
    let hasEntry = false
    const entryDeadline = Date.now() + WAIT_MS
    while (Date.now() < entryDeadline) {
      hasEntry = await evalJs(`typeof window.${entryWait} === "object"`).catch(() => false)
      if (hasEntry) break
      await sleep(200)
    }
    if (!hasEntry) {
      console.log('===== 页面报错 =====')
      for (const e of consoleErrors.slice(0, 20)) console.log(e)
      throw new Error(`页面入口 ${entryWait} 一直没出现（页面脚本没跑起来？）`)
    }
    // 场景脚本在页面上下文里跑，能直接摸到页面自己的测试入口
    const src = fs.readFileSync(evalFile, 'utf8')
    report = await evalJs(`(async () => { ${src} })()`, true)
  } else {
    if (!ready) throw new Error('页面没有暴露 __selftest（等了 ' + WAIT_MS + 'ms）')
    report = await evalJs('window.__selftest()', true)
  }

  // 第二段场景：刷新页面后重跑（用来验证"关掉再打开，译文还在原位"）
  const evalFile2 = opt('eval2', '')
  let report2 = null
  if (evalFile2) {
    await send('Page.reload', { ignoreCache: true })
    const reloadDeadline = Date.now() + WAIT_MS
    let ok2 = false
    while (Date.now() < reloadDeadline) {
      ok2 = await evalJs('typeof window.__readerTest === "object"').catch(() => false)
      if (ok2) break
      await sleep(300)
    }
    if (!ok2) throw new Error('刷新后页面没有就绪')
    const src2 = fs.readFileSync(evalFile2, 'utf8')
    report2 = await evalJs(`(async () => { ${src2} })()`, true)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const shotPath = path.resolve(outPng || '.selftest/shot.png')
  fs.mkdirSync(path.dirname(shotPath), { recursive: true })
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

  console.log('===== SELFTEST REPORT =====')
  console.log(JSON.stringify(report, null, 2))
  if (report2) {
    console.log('===== SELFTEST REPORT (刷新后) =====')
    console.log(JSON.stringify(report2, null, 2))
  }

  // 同时落一份 JSON：终端重定向在 Windows 上会变成 UTF-16，Node 读不了，
  // 摘要脚本直接读这个文件最稳。
  const jsonPath = path.resolve('.selftest', 'last-report.json')
  fs.writeFileSync(jsonPath, JSON.stringify({ report, report2, consoleErrors }, null, 2))
  if (consoleErrors.length) {
    console.log('===== 页面报错 =====')
    for (const e of consoleErrors.slice(0, 20)) console.log(e)
  }
  console.log('截图: ' + shotPath + ' (' + fs.statSync(shotPath).size + ' 字节)')

  ws.close()
  // 杀整棵进程树并等它真的退干净，否则下一轮会连到这一轮的残留实例
  await killTree(chrome)
}

/** 只杀我们自己起的这棵 Chrome 进程树（绝不动用户自己的浏览器）。 */
async function killTree(child) {
  if (!child || !child.pid) return
  await new Promise((resolve) => {
    const t = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    t.on('exit', resolve)
    t.on('error', resolve)
    setTimeout(resolve, 4000)
  })
  await sleep(400)
}

main().catch(async (e) => {
  console.error('驱动失败: ' + (e && e.message))
  process.exit(1)
})
