/**
 * 教程书：一页（= 一章）的渲染。
 *
 * 正文为什么用真 DOM、真文字节点：教程书是一本**真书**——用户要能在里面划线共读。
 * 所以正文不能画在 canvas 上、也不能用图片，必须是能被 Range 选中的文字。
 *
 * ── 这一版最大的变化（2026-11 用户定调"应该合起来"）────────────────────────
 * 上一版这里还有"自动播放的假界面"（`.tut-demo` + `demo.js`）：书里演一遍、侧栏里再做一遍，
 * **两张皮**。现在书里不再演戏——一章 = 一课：
 *   · 书负责讲清"这是什么、为什么"（正文）
 *   · 「开始本课」按钮把这课交给**真实侧栏**里的引导去做（`tutorial-script.js`）
 * 所以本文件只管「正文怎么排」与「那一课的入口怎么显示」。
 */

import { lessonFor, LESSONS } from './lessons.js'

/** 当前章的清理函数（离开这一章时要停掉所有计时器与观察器） */
let cleanupCurrent = null

/**
 * 宿主注入的环境（由 index.js 的 openChapter 传进来）。
 *
 * 为什么要注入而不是在这里 import：本模块要"把选中的话设为侧栏的当前引用"、
 * 要弹提示条，而这些能力属于阅读器（后台通信面、提示条）。反过来 import reader.js
 * 会成环（reader.js → tutorial/index.js → render.js → reader.js），所以由调用方传。
 * 没传时装成不可用状态（自测夹具就是这种情形），而不是抛错——教程正文本身照样能看。
 */
let env = {
  bookId: '',
  bookTitle: '',
  callBackground: async () => ({ ok: false, error: { message: '当前环境不支持与侧栏通信' } }),
  toast: () => {},
  /**
   * 开始某一课（书里的「开始本课」按钮用它）。
   *
   * 为什么不在这个文件里直接调 `tutorial-script.js`：那会把"书页渲染"和"侧栏引导"
   * 耦成一个模块，而它们分属两个页面（书 = 阅读器页，引导 = 侧栏页）。
   * 由宿主（reader.js）注入：它知道怎么把消息送到侧栏去。
   */
  startLesson: async () => ({ ok: false, error: '当前环境不支持开始课程' }),
}

/**
 * 「共读」浮标：在教程正文上划词时出现，点它就把选中的话设为侧栏的当前引用。
 *
 * 为什么教程书要支持这个（2026-11 用户要求把教程做成"引导你动手"的形式）：
 * 教程要教的第一步就是"划中一段话 → 点共读"。这一步必须是真的——
 * 用户自己动手划过一次，才知道那个浮标长什么样、点下去会发生什么。
 * 而它背后的链路完全是产品现有那条（阅读器 → 后台 setTranslationRef → 接收端
 * /annotation(setRef) → 侧栏设为当前引用），教程没有替它做任何假动作。
 */
const selection = { range: null, text: '' }

function ensureTip() {
  let tip = document.getElementById('tut-sel-tip')
  if (tip) return tip
  tip = document.createElement('div')
  tip.id = 'tut-sel-tip'
  tip.className = 'tut-sel-tip'
  tip.hidden = true
  tip.innerHTML = '<button type="button">共读</button><button type="button" class="ghost">复制</button>'
  tip.querySelector('button').addEventListener('click', () => { submitSelection() })
  tip.querySelectorAll('button')[1].addEventListener('click', () => {
    try { navigator.clipboard.writeText(selection.text) } catch {}
    hideTip()
  })
  document.body.appendChild(tip)
  return tip
}

function hideTip() {
  const tip = document.getElementById('tut-sel-tip')
  if (tip) tip.hidden = true
}

function showTipAt(rect) {
  const tip = ensureTip()
  tip.hidden = false
  const w = tip.offsetWidth || 120
  const h = tip.offsetHeight || 32
  let left = rect.left + rect.width / 2 - w / 2
  let top = rect.top - h - 8
  if (top < 8) top = rect.bottom + 8
  tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left)) + 'px'
  tip.style.top = top + 'px'
}

/** 选区是不是落在教程正文里 */
function selectionInTutorial() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const host = document.getElementById('rd-pages')
  if (!host || !host.contains(range.startContainer)) return null
  const text = String(sel.toString() || '').trim()
  if (text.length < 2) return null
  return { range, text }
}

function onTutorialSelectionSettled() {
  const hit = selectionInTutorial()
  if (!hit) { hideTip(); selection.range = null; selection.text = ''; return }
  selection.range = hit.range
  selection.text = hit.text
  showTipAt(hit.range.getBoundingClientRect())
}

/**
 * 点「共读」→ 把这段设为侧栏的当前引用。
 * 走的是现成的后台动作 setTranslationRef（它只管"把这段原文设为引用"，不产生提问）；
 * 用户接着在侧栏输入框里自己提问——这正是教程要教的节奏。
 */
/**
 * 点「共读」→ 把这段设为侧栏的当前引用。
 * 走的是现成的后台动作 setTranslationRef（它只管"把这段原文设为引用"，不产生提问）；
 * 用户接着在侧栏输入框里自己提问——这正是教程要教的节奏。
 *
 * 导出给 index.js 再转给阅读器：那一步教的是真实操作，所以要能被自测真的调一次。
 */
export async function submitSelection() {
  const text = selection.text
  if (!text) return { ok: false, error: { message: '没有选中文字' } }
  hideTip()
  if (!env.bookId) return { ok: false, error: { message: '教程书还没打开' } }
  const res = await env.callBackground({
    action: 'setTranslationRef',
    original: text,
    translation: text,
    url: 'reader://' + env.bookId + '#' + env.bookTitle,
    pageTitle: env.bookTitle,
    bookId: env.bookId,
    bookTitle: env.bookTitle,
  })
  if (res && res.ok) env.toast('已设为当前引用（看右侧侧栏）')
  else env.toast('未能设为引用：' + ((res && res.error && res.error.message) || '未知原因'), true)
  return res
}

/**
 * 渲染一章。
 * @param {HTMLElement} host 挂载点（阅读器把页面容器交给它）
 * @param {object} chapter chapter.json 的内容
 * @param {{index:number,total:number,bookTitle:string,bookId?:string,chapterNum?:number,
 *          callBackground?:Function,toast?:Function,startLesson?:Function}} meta
 *   `chapterNum` 是**章号（1 起）**：课程表按章号索引，而 index 是 0 起的，别混
 *   （混了的表现是"第 2 章的按钮开的是第 1 课"）
 */
export async function renderChapter(host, chapter, meta) {
  clearChapter()
  host.replaceChildren()
  env = {
    bookId: meta.bookId || '',
    bookTitle: meta.bookTitle || '',
    callBackground: meta.callBackground || env.callBackground,
    toast: meta.toast || env.toast,
    startLesson: meta.startLesson || env.startLesson,
  }

  const page = document.createElement('article')
  page.className = 'tut-page'

  const head = document.createElement('header')
  head.className = 'tut-head'
  head.innerHTML =
    `<div class="tut-eyebrow">${esc(meta.bookTitle)} · 第 ${meta.index + 1} 章 / 共 ${meta.total} 章</div>` +
    `<h1 class="tut-title">${esc(chapter.title || '')}</h1>`
  page.appendChild(head)

  const body = document.createElement('div')
  body.className = 'tut-body'
  page.appendChild(body)

  for (const block of chapter.blocks || []) {
    const el = block.type === 'lesson'
      ? renderLessonBlock(meta.chapterNum, meta)
      : renderTextBlock(block)
    if (el) body.appendChild(el)
  }
  host.appendChild(page)

  // 划词 → 浮出「共读」（教程的第一步必须是真的，理由见上面 submitSelection 的注释）
  const onUp = () => setTimeout(onTutorialSelectionSettled, 0)
  const onDown = (ev) => {
    const tip = document.getElementById('tut-sel-tip')
    if (tip && tip.contains(ev.target)) return
    hideTip()
  }
  document.addEventListener('mouseup', onUp)
  document.addEventListener('keyup', onUp)
  document.addEventListener('mousedown', onDown, true)

  cleanupCurrent = () => {
    document.removeEventListener('mouseup', onUp)
    document.removeEventListener('keyup', onUp)
    document.removeEventListener('mousedown', onDown, true)
    hideTip()
  }

  return { page }
}

export function clearChapter() {
  if (cleanupCurrent) {
    try { cleanupCurrent() } catch {}
    cleanupCurrent = null
  }
}

// ── 正文块 ────────────────────────────────────────────────────────────────────
function renderTextBlock(block) {
  const t = block && block.type
  if (t === 'heading') {
    const h = document.createElement('h2')
    h.className = 'tut-h2'
    h.textContent = block.text || ''
    return h
  }
  if (t === 'paragraph') {
    const p = document.createElement('p')
    p.className = 'tut-p'
    // 正文里的 **强调** 只支持这一种写法（刻意不用 markdown 渲染器：
    // 这段文字要能被 AI 按原文匹配到，加工越少越好）
    p.innerHTML = inlineMd(block.text || '')
    return p
  }
  if (t === 'note') {
    const d = document.createElement('aside')
    d.className = 'tut-note'
    d.innerHTML = `<div class="tut-note-tag">边注</div><div class="tut-note-body">${inlineMd(block.text || '')}</div>`
    return d
  }
  if (t === 'list') {
    const ul = document.createElement('ul')
    ul.className = 'tut-ul'
    for (const item of block.items || []) {
      const li = document.createElement('li')
      li.innerHTML = inlineMd(item)
      ul.appendChild(li)
    }
    return ul
  }
  if (t === 'quote') {
    const q = document.createElement('blockquote')
    q.className = 'tut-quote'
    // 引文段**不加任何行内标记**：用户很可能就划这一句去提问，
    // 划出来的原文必须与这里写的逐字一致（这也是它不用 <em> 之类的原因）
    q.innerHTML = `<p class="tut-quote-text">${esc(block.text || '')}</p>` +
      (block.attribution ? `<cite class="tut-quote-cite">${esc(block.attribution)}</cite>` : '')
    return q
  }
  return null
}

/** 只处理 **强调** 与 `代码`：够用，且不会把文字改形 */
function inlineMd(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── 本课的入口 ────────────────────────────────────────────────────────────────
/**
 * 一块「开始本课」：把这一章对应的那一课交给**真实侧栏**里的引导去做。
 *
 * 为什么是按钮而不是自动开始（2026-11 用户定调"应该合起来"之后的设计）：
 * 引导要在一片真实界面上高亮、要你动手，**必须在你准备好、且侧栏可见的时候才该开始**。
 * 自动弹出来会把人从"我正在读书"里硬拽走。所以：书里给一个明确的入口，点了才开始。
 *
 * 侧栏没开着的时候点了会怎样：引导状态写进 storage，侧栏一打开就接上（见
 * tutorial-script.js 的 restoreRun）。所以这里**如实告知**"看右侧侧栏"，而不是假装开始了。
 */
function renderLessonBlock(chapterNum) {
  const lesson = lessonFor(chapterNum)
  if (!lesson) return null

  const box = document.createElement('aside')
  box.className = 'tut-lesson'
  box.dataset.lesson = String(lesson.chapter)

  const steps = Array.isArray(lesson.steps) ? lesson.steps.length : 0
  box.innerHTML =
    '<div class="tut-lesson-head">' +
      '<span class="tut-lesson-tag">动手做</span>' +
      '<span class="tut-lesson-title">' + esc(lesson.title || '') + '</span>' +
    '</div>' +
    (lesson.intro ? '<p class="tut-lesson-intro">' + inlineMd(lesson.intro) + '</p>' : '') +
    '<div class="tut-lesson-meta">在真实界面上走 ' + steps + ' 步，每步都得你自己动手，做对了才往下走。</div>'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tut-lesson-btn'
  btn.textContent = '开始本课'
  const hint = document.createElement('div')
  hint.className = 'tut-lesson-hint'
  hint.hidden = true

  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = '已开始，看右侧侧栏'
    hint.hidden = false
    // 这一步的提示必须是**能照做的**：侧栏打不开不是故障（`sidebar.open()` 需要用户手势，
    // 手势不会穿过消息传到后台），所以直接给两条打开方式，别只说"去开侧栏"。
    hint.innerHTML = '引导在**右侧侧栏**里等着。如果侧栏没开着，任选一种方式打开：' +
      '<br>· 点浏览器工具栏上的 <b>CoRead 图标</b>（U 形那个），或按 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>' +
      '<br>· 已经在**微信读书**页面时：直接点侧栏里的「▶ 开始教程」' +
      '<br>侧栏一打开就会接上这一课（状态已经存好了，关了也不丢）。'
    const r = await env.startLesson(lesson.chapter)
    if (!r || !r.ok) {
      btn.disabled = false
      btn.textContent = '开始本课'
      hint.textContent = '没起来：' + ((r && r.error) || '未知原因')
    }
  })

  box.append(btn, hint)
  return box
}

// ── 自测入口 ──────────────────────────────────────────────────────────────────
// 划词浮标那套（只在这一层能验：它挂在页面级 body 上、由本文件的监听器驱动）。
// ⚠️ 上一版这份入口在"演示块"那一段的末尾，删演示时被一起删掉了——
//    表现是自测直接报 `T0.tip is not a function`。这类"测试入口被顺手删掉"的事
//    只能靠真跑一次发现，所以它必须留在与它同源的文件里、并有一条闸门盯着。
if (typeof window !== 'undefined') {
  window.__tutorialTest = Object.assign(window.__tutorialTest || {}, {
    tip() {
      const t = document.getElementById('tut-sel-tip')
      if (!t) return { exists: false, hidden: true, label: '', text: '' }
      const btns = [...t.querySelectorAll('button')]
      return {
        exists: true,
        hidden: !!t.hidden,
        label: btns.length ? String(btns[0].textContent || '').trim() : '',
        text: selection.text || '',
      }
    },
    clickTip() {
      const t = document.getElementById('tut-sel-tip')
      const b = t && t.querySelector('button')
      if (!b) return false
      b.click()
      return true
    },
    /** 当前有没有选中文字（浮标该不该露的判据） */
    selection: () => String((window.getSelection() || {}).toString() || ''),
  })
}
