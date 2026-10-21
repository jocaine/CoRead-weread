/**
 * CoRead service worker
 * 拦截 /web/book/chapter/e_{N} 请求，提取章节正文，转发到本地接收端。
 *
 * 实测结论（2026-06-12）：
 * - 章节内容走标准 HTTP fetch，接口为 /web/book/chapter/e_{chapterIdx}
 * - DOM textContent 返回正确汉字，无字体混淆
 * - 无 WebSocket
 */

import { installTranslateBackground } from './translate-background.js'
import { reportExtensionToHost } from './translate-protocol.js'

const RECEIVER = 'http://127.0.0.1:7239'

// AI-012：放开 chrome.storage.session 给 content script 用。默认访问级别是
// TRUSTED_CONTEXTS（仅扩展页面/后台），content script 属于 untrusted context——
// 此前 content.js 里的 readSharedChapter/persistSharedChapter 一直在静默失败，
// 跨帧共享章节（coreadChapter）从未真正生效，画布书跳回章节捕获为 0。
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {})

self.addEventListener('fetch', event => {
  const url = event.request.url
  if (!url.includes('weread.qq.com/web/book/chapter/e_')) return

  event.respondWith(
    fetch(event.request.clone()).then(async response => {
      try {
        const cloned = response.clone()
        const raw = await cloned.text()
        await extractAndForward(url, raw)
      } catch (e) {
        console.warn('[CoRead SW] extract error', e)
      }
      return response
    })
  )
})

async function extractAndForward(url, rawText) {
  // URL 格式：https://weread.qq.com/web/book/chapter/e_{chapterIdx}
  // 查询参数可能带 bookId, chapterUid 等
  const urlObj = new URL(url)
  const bookId = urlObj.searchParams.get('bookId') || ''
  const chapterUid = urlObj.searchParams.get('chapterUid') || urlObj.pathname.split('/').pop()

  let text = ''
  try {
    const json = JSON.parse(rawText)
    // 尝试常见字段：content / chapterContent / data.content
    text = json.content
      || json.chapterContent
      || (json.data && json.data.content)
      || ''
    // 如果是数组（段落数组），拼接
    if (Array.isArray(text)) text = text.join('\n\n')
    // 还没拿到就 fallback 到 raw
    if (!text && rawText.length > 200) text = rawText
  } catch {
    // 非 JSON（纯文本），直接用
    if (rawText.length > 200) text = rawText
  }

  if (!text || text.length < 100) return

  // 去掉 HTML 标签（如果有）
  text = text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()

  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId, chapterUid, text, sourceUrl: url }),
    })
    console.log(`[CoRead SW] content saved: bookId=${bookId} uid=${chapterUid} (${text.length} chars)`)
  } catch {
    // 接收端未启动时静默失败
  }
}

// ── 来自 content.js 的 DOM 提取内容（补充路线） ────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type !== 'COREAD_DOM_CONTENT') return
  const { bookId, chapterUid, text } = event.data
  if (!text || text.length < 100) return
  fetch(`${RECEIVER}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId, chapterUid, text, source: 'dom' }),
  }).catch(() => {})
})

// ── Side Panel ────────────────────────────────────────────────────────────────
// 点击扩展图标直接打开 side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

/**
 * 尽力打开侧栏，并**如实回报结果**（2026-11）。
 *
 * 为什么不能只 `open().catch(()=>{})`：请我们开面板的有两条真实链路——书页画完一条
 * 划线、工具栏「查引用」——它们都只想知道"到底开没开"。吞掉错误的话，用户看到的是
 * "划线之后什么都没发生"，而我们这边连一行日志都没有。
 *
 * ⚠️ `chrome.sidePanel.open()` 必须由**用户手势**触发，且手势不穿过 sendMessage
 * 从页面传到后台（实测证据：logs\debug.jsonl 的 open-side-panel-lesson，
 * error=`sidePanel.open()` may only be called in response to a user gesture.）。
 * 所以这里的 `open()` **必须同步发起**——在监听器里 await 过任何东西再调它，
 * 连"理论上可能成功"的那点机会也没了。成功与否都返回，由调用方决定怎么兜底。
 */
function openSidePanelForTab(tabId) {
  if (!tabId) return Promise.resolve({ opened: false, error: 'no-tab' })
  // Chrome 114 之前没有 sidePanel API：老浏览器上如实回报，不要让监听器抛异常
  // （抛出去的话消息通道直接断，调用方只会看到一句"Receiving end does not exist"）
  if (!chrome.sidePanel || !chrome.sidePanel.open) return Promise.resolve({ opened: false, error: 'no-sidePanel-api' })
  const p = chrome.sidePanel.open({ tabId })
  return Promise.resolve(p).then(
    () => ({ opened: true }),
    async (e) => {
      // 失败时要分清"已经被用户开着了"（无害）与"缺手势"（浏览器策略，我们改不了）
      let alreadyOpen = false
      try {
        const ctxs = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })
        alreadyOpen = !!(ctxs && ctxs.length)
      } catch {}
      return { opened: false, alreadyOpen, error: String((e && e.message) || e) }
    },
  )
}

// 来自 content.js / sidebar 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openPanel') {
    openSidePanelForTab(sender.tab?.id).then(sendResponse)
    return true   // 异步回报（调用方要把结果写进日志）
  }

  // 引用删除后 → 通知微信读书 tab 刷新共读标记
  if (msg.action === 'refreshCoReadMarks') {
    chrome.tabs.query({ url: 'https://weread.qq.com/*' }).then(([tab]) => {
      if (!tab?.id) return
      chrome.tabs.sendMessage(tab.id, { action: 'refreshCoReadMarks' }).catch(() => {})
    })
    return false
  }
  // getReadingContext 已改为侧栏直接定向查询活动 tab（AI-008），不再走 SW 转发，
  // 此前的转发分支已删除。
})

// ── 向本机服务报到（托盘「打开 CoRead 阅读器」要用）──────────────────────────
// 扩展 ID 只有浏览器知道，托盘那个独立进程问不到；这里每次启动报一次，接收端落成
// data\runtime\extension-id。三个入口各报一次，覆盖全部"浏览器重新认识这个插件"的时机：
//   · 浏览器刚启动 → onStartup（SW 被拉起）
//   · 插件刚装上 / 刚更新 / 被重新加载 → onInstalled
//   · SW 因空闲被回收后又被唤醒 → 顶层这一行
// 重复报到无害：接收端覆盖写同一个文件，ID 没变就不打日志。
reportExtensionToHost()
chrome.runtime.onStartup.addListener(() => reportExtensionToHost())
chrome.runtime.onInstalled.addListener(() => reportExtensionToHost())

// ── 教程状态迁移（2026-10-20）───────────────────────────────────────────────
// 内置的《第一次共读》连同它的课程引导已经**整套删掉**，改成一本真的 PDF
//（用户放进书库的《CoRead 使用教程》）。这里只做一件事：把老版本留在 storage 里的
// `tutorialRun` 清掉——不清的话它永远躺在那儿没人读，属于"看不见的垃圾"。
// 只需要跑一次，所以不再挂 onStartup / onInstalled（那两条是为旧功能的生命周期服务的）。
;(async () => {
  try {
    const st = await chrome.storage.local.get('tutorialRun')
    if (st && st.tutorialRun) await chrome.storage.local.remove('tutorialRun')
  } catch (e) {}
})()

// ── 翻译能力（框选截图 / 划词）────────────────────────────────────────────────
// 逻辑都在 translate-background.js 里，只在这里装配，避免和共读的 SW 逻辑混在一起。
// 它自带一个 chrome.runtime.onMessage 监听，只接管自己认识的那些 action。
installTranslateBackground()
