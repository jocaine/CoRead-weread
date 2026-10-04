/**
 * 给驱动用：算出"从第 1 行文字开头拖到第 2 行文字末尾"的屏幕坐标。
 * 脚本在页面上下文里跑，只返回坐标，真正的鼠标事件由驱动（CDP）派发。
 */
const T = window.__readerTest
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 造一个假的翻译后台，免得真去调模型
T.state.translateOverride = async (msg) => {
  if (msg.action === 'translateText') return { ok: true, data: { original: msg.text, translation: '【译】' + msg.text.slice(0, 40) } }
  if (msg.action === 'setTranslationRef') return { ok: true }
  return { ok: false, error: { message: '意外消息 ' + msg.action } }
}

const pdfUrl = location.protocol === 'chrome-extension:' ? 'test/sample.pdf' : '/.selftest/sample.pdf'
const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())
await T.openBytes(bytes, 'sample.pdf')

const end = Date.now() + 20000
while (Date.now() < end && !(T.state.pages[0] && T.state.pages[0].rendered)) await sleep(150)

// 放大到字很大，跟用户截图里的情形一致（缩放后再选，选区字形的问题最容易看出来）
await T.setScale(3.2)
await sleep(600)

const spans = [...T.state.pages[0].layer.querySelectorAll('span')]
if (!spans.length) return { error: '第 1 页没有文字节点' }

const a = spans[0].getBoundingClientRect()
const b = spans[1].getBoundingClientRect()
// 从第一行偏左起拖，拖到第二行偏右 —— 横向穿过文字，保证真的划到内容
return {
  from: [a.left + 2, a.top + a.height / 2],
  to: [b.right - 2, b.top + b.height / 2],
  spanCount: spans.length,
  firstText: spans[0].textContent.slice(0, 30),
}
