/**
 * 教程引导：**在真实侧栏里**一步步带你做（2026-11 用户定调"游戏那种教程"）。
 *
 * ── 它跟书的关系（上一版是"两张皮"，已合并）────────────────────────────────
 *   · **书**（`tutorial/book/*`）负责讲清"这是什么、为什么"
 *   · **本文件 + tutorial/lessons.js** 负责让你在真实界面上做一遍
 *   一章 = 一课：书里读完正文 → 点「开始本课」→ 这里把你带一遍 → 回书里翻下一章。
 *   "哪一章对应哪一课、每课几步"只在 `tutorial/lessons.js` 里写一份，两边共读。
 *
 * ── 三条设计约束（都踩过或想清楚了才这么写）────────────────────────────────
 * ① **不可跳过关键动作**：每一步都盯着真实事件（点击 / 输入 / 消息区出现新气泡），
 *    没做就不往下走，点错会被抖一下并重新提示。反过来，每一步都留「跳过这步」——
 *    没有出口的教程会把人卡死在里面。
 * ② **"讲一句"和"要你做"必须分开**：`read` 类步骤给「继续」按钮，`wait` 类必须真做。
 *    把讲一句也写成等待，用户会盯着屏幕等一个永远不会自己跳的步骤。
 * ③ **状态放 chrome.storage**：侧栏会被关掉重建（扩展页面每次打开都是新会话），
 *    放内存里的话用户一去阅读器划词、回来教程就没了。
 */

import * as Guide from './tutorial-guide.js'
import { LESSONS } from './tutorial/lessons.js'

const RUN_KEY = 'tutorialRun'
/** 各步的等待上限：到了就提示"还没等到"，但**不推进**——决定权在用户 */
const WAIT_MS = 25000
/**
 * 一条记录多久算过期（毫秒）。
 *
 * ⚠️ 这个数只管"很久以前那次"要不要丢掉，**不再**决定"打开侧栏时要不要自动弹出教程"——
 * 那个判断已经改成明确的 `paused` 语义（见 restoreRun 与 pause）。
 * 2026-11 用户报的 bug 就是这里：扩展更新后一打开侧栏就自己冒出教程，
 * 因为只要存储里有一条不到 1 小时的记录，任何一次打开都会把它接起来。
 */
const STALE_MS = 12 * 60 * 60 * 1000

/** 当前这一次引导的内存态（真源在 storage，见 start/advance） */
let run = null
/** 等待器：{ stop() } */
let waiting = null
/** 消息区观察器：等接话回来用 */
let msgObserver = null
/** 等太久的那个定时器 */
let waitTimer = 0
/** 进入当前这一步时，引用卡里是什么（`refChanged` 要拿它当基准） */
let refAtStepStart = ''
/**
 * 上一次画卡片时用的按钮组。
 *
 * 为什么留着：把高亮挪到抽屉上时要重画卡片，而**按钮不能丢**——
 * 例句按钮重画一次就没了处理器（`Guide.showStep` 是 `replaceChildren`）。
 * 踩过同一个坑的变体：重画时忘带 actions，卡片上只剩"退出教程"。
 */
let lastActions = []

/**
 * 预读例句表（模块初始化时就开始）。
 *
 * 为什么在模块顶层预读、而不是"要例句的时候才去读"：`renderStep` 是**同步**的
 * （改成 async 会牵动一串调用方，而且卡片渲染本来就该立刻可见），
 * 而"用的时候才读"必然出现"这一次渲染没有例句"的空窗——
 * 那正是上一版用户看到空列表的一个原因。预读把它变成"要用的时候一定有"。
 *
 * 数据源与侧栏抽屉**同一份**（`tutorial/sample-refs.json`）：不抄第二份，
 * 否则用户在卡片上看到的和抽屉里看到的会不是同一批句子。
 */
let samplesReady = { items: [] }
import('./tutorial/lessons.js')
  .then((m) => m.loadSamples())
  .then((data) => { samplesReady = (data && Array.isArray(data.items)) ? data : { items: [] } })
  .catch(() => {})

/**
 * 抽屉里到底有没有那批例句？`null` = 还不知道。
 *
 * 为什么要问侧栏而不是自己判断：例句是**侧栏**渲染进抽屉的，只有它知道
 * "我读到数据了吗、抽屉里有那几条吗"。教程这边瞎猜的结果就是上一版——
 * 卡片上多出一排按钮，而用户要的是"去点切换引用"（用户明确要求去掉那些按钮）。
 */
let drawerSamplesKnown = null
let drawerProbeDone = false
async function probeDrawerSamples() {
  if (drawerProbeDone) return drawerSamplesKnown
  drawerProbeDone = true
  try {
    const r = await chrome.runtime.sendMessage({ action: 'coreadTutorialProbe', want: 'drawerSamples' })
    if (r && r.ok) {
      drawerSamplesKnown = !!r.drawerHasSamples
      // 探测结果变了 → 重画一次卡片（此时才决定要不要兜底按钮）
      if (run) renderStep()
    }
  } catch (e) {}
  return drawerSamplesKnown
}

const el = (id) => document.getElementById(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 当前这一课（没有就返回 null） */
function lesson() {
  if (!run) return null
  return LESSONS[run.lesson] || null
}
function step() {
  const l = lesson()
  if (!l || !Array.isArray(l.steps)) return null
  return l.steps[run.step] || null
}

async function saveRun() {
  // `at` 是"最后一次活动"的时间戳，**每次存都刷新**（2026-11）。
  // 踩过：原来只在开始/换步时写，于是用户在第 3 步停留很久（正合教程的本意——
  // 他要在真界面上操作），那条记录的时间戳还停在很久以前，被判成过期丢掉。
  if (run) run.at = Date.now()
  try {
    if (run) await chrome.storage.local.set({ [RUN_KEY]: run })
    else await chrome.storage.local.remove(RUN_KEY)
  } catch {}
}

/**
 * 侧栏刚打开时把上次那一步接回来。
 * 状态在 storage，所以"去阅读器划完词再回来"教程还在——这正是上一版丢过的体验。
 */
export async function restoreRun() {
  try {
    const got = await chrome.storage.local.get(RUN_KEY)
    const saved = got && got[RUN_KEY]
    // 诊断（2026-11）：这一条以前只回报 true/false，于是"没读到状态"和"读到了但判过期"
    // 两种情况长得一模一样，只能靠猜。把原始值一起报上去，一次就能分开。
    const diag = {
      stage: 'tutorial-restore-run',
      found: !!saved,
      active: !!(saved && saved.active),
      lesson: saved ? saved.lesson : null,
      ageMs: saved && saved.at ? (Date.now() - saved.at) : null,
      keys: saved && typeof saved === 'object' ? Object.keys(saved).join(',') : String(saved),
    }
    if (saved && saved.active && Date.now() - (saved.at || 0) < STALE_MS) {
      run = saved
      // ⚠️ **暂停态不自动弹出引导**（2026-11 用户报的 bug：更新扩展后一打开侧栏就冒出教程）。
      // 侧栏每次打开都是新会话，而"上次中途关掉"不该变成"这次自动开始上课"——用户会以为插件坏了。
      // 所以：状态留着，但只交给侧栏显示一个「继续教程」的入口，由**用户点**才真的接上（见 resume()）。
      if (saved.paused) {
        reportDiag(Object.assign(diag, { result: 'paused-awaiting-user' }))
        return 'paused'
      }
      renderStep()
      reportDiag(Object.assign(diag, { result: 'restored', guideActive: Guide.isActive() }))
      return true
    }
    reportDiag(Object.assign(diag, { result: 'ignored' }))
  } catch (e) {
    reportDiag({ stage: 'tutorial-restore-run', result: 'error', error: String((e && e.message) || e) })
  }
  return false
}

/**
 * 把"上次中途关掉"这一次标成暂停（侧栏 pagehide 时调用）。
 *
 * 与 stop() 的区别很重要：stop 是**用户主动退出**（状态要清掉），
 * pause 只是"这个页面要被销毁了"（状态留着，但下次**不自动**接着上课）。
 */
export async function pause() {
  if (!run || !run.active) return false
  run.paused = true
  run.pausedAt = Date.now()
  await saveRun()
  return true
}

/** 用户明确点了「继续教程」：解除暂停，接着上次那一步 */
export async function resume() {
  try {
    const got = await chrome.storage.local.get(RUN_KEY)
    const saved = got && got[RUN_KEY]
    if (!saved || !saved.active) return false
    run = Object.assign({}, saved, { paused: false })
    await saveRun()
    renderStep()
    return true
  } catch (e) {
    return false
  }
}

/** 存储里有没有一条"暂停中的教程"（侧栏据此决定要不要显示「继续教程」入口） */
export async function pausedState() {
  try {
    const got = await chrome.storage.local.get(RUN_KEY)
    const s = got && got[RUN_KEY]
    if (!s || !s.active) return null
    const l = LESSONS[s.lesson]
    return {
      lesson: s.lesson,
      step: s.step,
      paused: !!s.paused,
      title: l ? l.title : '',
      stepCount: l ? l.steps.length : 0,
      stale: Date.now() - (s.at || 0) > STALE_MS,
    }
  } catch (e) {
    return null
  }
}

/**
 * 清掉存储里的教程状态（扩展启动时用）。
 *
 * 为什么要有它：状态是跨会话的，一旦某次没清干净（用户直接关了浏览器、或扩展被更新），
 * 它会一直躺着，之后每次打开侧栏都被接起来——用户看到的就是"教程自己冒出来"。
 * 教程是"你开始才存在"的东西，所以每次扩展启动都作废这份状态。
 */
export async function clearStale() {
  try {
    await chrome.storage.local.remove(RUN_KEY)
    run = null
    return true
  } catch (e) {
    return false
  }
}

/** 把诊断送到接收端的 debug 日志（日志是这条链路唯一的现场记录） */
function reportDiag(data) {
  try {
    fetch('http://127.0.0.1:7239/debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ source: 'tutorial-script', timestamp: Date.now() }, data)),
    }).catch(() => {})
  } catch (e) {}
}

/**
 * 开始一课。
 * @param {number} lessonIdx `tutorial/lessons.js` 里的下标
 * @param {{resumed?:boolean}} [opts] `resumed` 只用于日志：区分"用户新开始"与"接着上次"
 */
export async function start(lessonIdx = 0, opts = {}) {
  const i = Math.max(0, Math.min(LESSONS.length - 1, Number(lessonIdx) || 0))
  // 换课/重开都要清掉暂停标记，否则下一步会被 restoreRun 当成"暂停中"而不显示
  run = { active: true, lesson: i, step: 0, at: Date.now(), paused: false }
  await saveRun()
  renderStep()
  reportDiag({ stage: 'tutorial-start', lesson: i, resumed: !!opts.resumed, total: LESSONS.length })
  return { ok: true, lesson: i, total: LESSONS.length }
}

/** 只读当前状态（不触发重绘） */
export function state() {
  const l = lesson()
  return run
    ? { active: !!run.active, lesson: run.lesson, step: run.step, stepCount: l ? l.steps.length : 0, title: l ? l.title : '' }
    : { active: false, lesson: 0, step: 0, stepCount: 0, title: '' }
}

/** 退出：收掉引导层，清掉状态 */
export async function stop(reason = '') {
  clearWaiting()
  Guide.hide()
  run = null
  await saveRun()
  if (reason) console.info('[教程] 已退出：' + reason)
  return { ok: true }
}

function clearWaiting() {
  if (waiting && waiting.stop) { try { waiting.stop() } catch {} }
  waiting = null
  if (msgObserver) { try { msgObserver.disconnect() } catch {}; msgObserver = null }
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = 0 }
}

/** 往前/往后挪一步（不动课程） */
async function gotoStep(n) {
  if (!run) return
  const l = lesson()
  if (!l) return await stop('这一课不存在')
  if (n >= l.steps.length) return await finishLesson()
  clearWaiting()
  run.step = Math.max(0, n)
  run.at = Date.now()
  await saveRun()
  renderStep()
}

/** 这一课走完了：告诉书"可以翻下一章了"，然后收摊 */
async function finishLesson() {
  const l = lesson()
  clearWaiting()
  Guide.hide()
  const nextChapter = l ? l.chapter + 1 : 0
  run = null
  await saveRun()
  // 让书页跟着走：翻到下一章（书那边会自己判断有没有下一章）
  try {
    await chrome.runtime.sendMessage({ action: 'readerCommand', type: 'gotoChapter', chapter: nextChapter })
  } catch (e) {}
  return { ok: true, done: true, nextChapter }
}

// ── 每一步：怎么显示、怎样才算做完 ────────────────────────────────────────────
/** 目标元素；找不到就返回 null（引导层会退化成"整片讲一句"，不报错） */
function targetEl(id) { return id ? el(id) : null }

/** 等"某个按钮被点到"（捕捉阶段监听，不干扰它自己的处理） */
function waitClick(id, done) {
  const handler = (ev) => {
    const t = el(id)
    if (!t) return
    if (ev.target === t || t.contains(ev.target)) {
      document.removeEventListener('click', handler, true)
      // 让它自己的处理先跑完，再推进（否则可能在它更新界面之前就把引导挪走了）
      setTimeout(done, 0)
    }
  }
  document.addEventListener('click', handler, true)
  return { stop: () => document.removeEventListener('click', handler, true) }
}

function waitTyped(min, done) {
  const input = el('input')
  if (!input) return null
  const check = () => { if (String(input.value || '').trim().length >= min) done() }
  input.addEventListener('input', check)
  check()
  return { stop: () => input.removeEventListener('input', check) }
}

/**
 * 等"引用被填上内容"，并且要求这是**这一次**填的。
 *
 * ⚠️ 这里连着踩了两个坑，记下来：
 *  ① 最初的判据只写"引用卡里有内容"。而用户在第 1 步就把它填上了 →
 *     进入第 2 步时条件**立刻成立**，第 2 步被瞬间跳过，他根本没看见那一步。
 *  ② 我改成"必须先见过空、再被填上"。看着能治 ①，实际更糟：**如果引用卡里本来就有
 *     旧内容**（上一课的残留、或用户上次读这本时留的），它就一直等"先变空"——
 *     而用户不会去清空它，于是**卡死在第 1 步**。自测里当场逮到了。
 *
 * 现在的判据是明确的先后关系：**进入这一步之后，引用卡的内容发生过一次变化**。
 * 与 ① 的区别是"必须重新划一次"，与 ② 的区别是"不必先变空"。
 */
function waitRefFilled(done) {
  const now = () => (((el('rc-text') || {}).textContent) || '').trim()
  const before = now()
  const iv = setInterval(() => {
    const t = now()
    if (t && t !== before) done()
  }, 400)
  return { stop: () => clearInterval(iv) }
}

/**
 * 等"引用换成了另一条"。
 *
 * 与 refFilled 的区别：那一条只要"有内容"就过，而第 2 步要的是**换一条**——
 * 用户是从阅读器划完词过来的，引用卡里本来就有内容，如果还用 refFilled，这一步会被瞬间跳过。
 * （2026-11 用户报的"这一步我没有可以操作的地方"，一半原因就在这里：原来的判据是
 *  "点 📍 跳转"，而他人在原文那儿、没什么可跳的，只能点跳过。）
 */
function waitRefChanged(before, done) {
  const now = () => ((el('rc-text') || {}).textContent || '').trim()
  const iv = setInterval(() => {
    const t = now()
    if (t && t !== before) done()
  }, 400)
  return { stop: () => clearInterval(iv) }
}

function waitAssistantBubble(done) {
  const msgs = el('msgs')
  if (!msgs) return null
  const before = msgs.querySelectorAll('.msg-assistant').length
  const hit = () => { if (msgs.querySelectorAll('.msg-assistant').length > before) done() }
  msgObserver = new MutationObserver(hit)
  msgObserver.observe(msgs, { childList: true, subtree: true })
  hit()
  return { stop: () => { if (msgObserver) msgObserver.disconnect(); msgObserver = null } }
}

/** 把这一课的等待条件挂上 */
function armWait(w, done) {
  if (!w) return null
  if (w.kind === 'click') return waitClick(w.id, done)
  if (w.kind === 'typed') return waitTyped(Number(w.min) || 1, done)
  if (w.kind === 'refFilled') return waitRefFilled(done)
  if (w.kind === 'refChanged') return waitRefChanged(refAtStepStart, done)
  if (w.kind === 'assistantBubble') return waitAssistantBubble(done)
  return null
}

/** 画出当前这一步 */
function renderStep() {
  const l = lesson()
  const s = step()
  if (!run || !l || !s) return

  const total = l.steps.length
  const n = run.step + 1
  const isLast = run.step >= total - 1
  const actionLabel = s.read ? '继续' : '这步先跳过'

  // 卡片上给足信息：**这是第几课、第几步、这一步在干嘛、为什么**。
  // 上一版只有一句"点这里"，用户说"像提示不像教程"——差的就是这几行字。
  //
  // 如果这一步带了 `samples`（第 2 步那批准备例句），**直接把它们做成卡片上的按钮**。
  // 为什么不在卡片上写"去点切换引用"就完了（2026-11 用户实测）：
  // 用户找不到那批例句（抽屉里那组的可见性依赖好几件事：侧栏认不认得出当前是教程书、
  // 样例模块有没有加载完），而这一步一旦找不到就只能点"跳过"——那这一步就白设计了。
  // 做成按钮之后，例句就长在引导卡片上，点得到、也不依赖别的东西。
  // ⚠️ **卡片上不放例句按钮**（2026-11 用户明确要求"把第二步的那些按钮去掉"）。
  // 这一步的正经做法是：用户点卡片上的「切换引用 ▸」，在抽屉最上面那组「教程例句」里挑一条。
  // 上一版把例句做成了卡片按钮——那等于把"切换引用"这个操作**绕过去了**，
  // 而这一步本来就是要教这个操作。用户要的是那条例句出现在**列表**里，不是出现在卡片上。
  //
  // 万一抽屉那条路真的坏了（探针说没读到例句）：**不塞按钮，而是把话说明白**——
  // 用户至少知道该报什么，我也能一眼看出该修哪儿。
  const sampleBtns = []
  const drawerBroken = drawerSamplesKnown === false && s.samplesFrom === 'sample-refs'

  const primaryActions = [
    { label: actionLabel, onClick: () => gotoStep(run.step + 1) },
    { label: '上一课', onClick: () => gotoStep(run.step - 1) },
    ...sampleBtns,
  ]
  lastActions = primaryActions

  // 顺便探一次"抽屉里有没有例句"（结果回来后决定要不要在卡片上兜底，见上面）
  probeDrawerSamples()

  Guide.showStep(Object.assign(stepOpts(), {
    step: `第 ${run.lesson + 1} 课 · ${n} / ${total}`,
    lesson: l.title,
    title: s.title,
    // 抽屉那条路坏了就说清楚（**不塞按钮**：那会把"切换引用"这个操作绕过去，
    // 而这一步本来就是要教它）。用户看到这句就知道该报什么，我也知道该修哪儿。
    body: drawerBroken
      ? '⚠️ 预设例句没读出来（这是教程的 bug，不是你的操作问题）。请点「这步先跳过」继续，'
        + '并把这句话告诉开发者：sidebar sample-refs 没读到。'
      : s.body,
    target: s.target ? (() => targetEl(s.target)).bind(null) : null,
    targetId: s.target || '',
    actions: primaryActions,
    onQuit: () => stop('用户退出'),
  }))

  // read 类步骤不挂等待（它只要点「继续」）；wait 类挂上
  clearWaiting()
  // 记下这一步开始时引用卡里的内容：`refChanged` 靠它判断"换了另一条"
  refAtStepStart = ((el('rc-text') || {}).textContent || '').trim()
  if (!s.read && s.wait) {
    const w = armWait(s.wait, () => { gotoStep(run.step + 1) })
    if (w) waiting = w
    // 等太久：**不推进**，只把话说清楚（决定权在用户，不能替他走）
    waitTimer = setTimeout(() => {
      if (!run || run.step !== n - 1) return
      Guide.showStep(Object.assign(stepOpts(), {
        step: `第 ${run.lesson + 1} 课 · ${n} / ${total}`,
        lesson: l.title,
        title: '还没等到',
        body: '不着急。做完了它会自己往下走；也可以点「这步先跳过」。',
        target: s.target ? (() => targetEl(s.target)).bind(null) : null,
        targetId: s.target || '',
        actions: [{ label: isLast ? '结束本课' : '这步先跳过', onClick: () => gotoStep(run.step + 1) }],
        onQuit: () => stop('用户退出'),
      }))
    }, WAIT_MS)
  } else if (isLast) {
    // read 类且是最后一步：按钮语义换成"结束本课"
    Guide.refresh()
  }
}

/** 当前这一步的基础选项（重画卡片时复用：目标、退出回调） */
function stepOpts() {
  const s = step()
  return {
    target: s && s.target ? (() => targetEl(s.target)).bind(null) : null,
    targetId: (s && s.target) || '',
    onQuit: () => stop('用户退出'),
  }
}

// ── 对外的自测入口 ────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.__tutorialScript = {
    start,
    stop,
    state,
    lessonAt: (i) => LESSONS[i] || null,
    lessonCount: () => LESSONS.length,
    nextStep: () => gotoStep(run ? run.step + 1 : 0),
    /** 自测用：让引导层按当前 DOM 重算一次遮罩（加了 data-guide-pin 元素之后要调它） */
    refreshGuide: () => { Guide.refresh(); return true },
    /**
     * 当前这一步（原样给出，侧栏据此判断"这一步跟引用有关吗"）。
     * 为什么要暴露它：侧栏要在**打开引用抽屉**时决定"该不该把高亮挪到抽屉上"，
     * 而"这一步盯的是谁"只有这里知道。
     */
    currentStep: () => (run ? step() : null),
    /**
     * 把高亮临时挪到另一个元素上（`sel` 是选择器或元素）。
     * `inner` 给一个更靠内的选择器，用来把高亮框缩到抽屉的标题条那一条，
     * 而不是把整个抽屉圈起来（整个抽屉圈起来时那个框会盖住它自己的内容，看着像故障）。
     */
    anchorTo: (sel, inner) => {
      if (!run) return false
      const outer = typeof sel === 'string' ? document.querySelector(sel) : sel
      if (!outer) return false
      const el = (inner && outer.querySelector && outer.querySelector(inner)) || outer
      Guide.showStep(Object.assign(stepOpts(), {
        step: `第 ${run.lesson + 1} 课 · ${run.step + 1} / ${(lesson() || { steps: [] }).steps.length}`,
        lesson: (lesson() || {}).title || '',
        title: (step() || {}).title || '',
        body: '',                 // 只管挪框，不重复写字（避免卡片内容闪一下）
        target: () => el,
        targetId: el.id || 'ref-drawer-head',
        actions: (lastActions || []),
        onQuit: () => stop('用户退出'),
      }))
      return true
    },
    /** 自测用：看引导层现在高亮的是谁、写着什么 */
    guide() {
      return {
        active: Guide.isActive(),
        target: Guide.currentTarget(),
        step: (document.querySelector('#tut-guide-tip .tg-step') || {}).textContent || '',
        lessonTitle: (document.querySelector('#tut-guide-tip .tg-lesson') || {}).textContent || '',
        title: (document.querySelector('#tut-guide-tip .tg-title') || {}).textContent || '',
        body: (document.querySelector('#tut-guide-tip .tg-body') || {}).textContent || '',
        actions: [...document.querySelectorAll('#tut-guide-tip .tg-acts button')].map((b) => b.textContent),
        masks: [...document.querySelectorAll('.tut-mask')].filter((m) => m.style.display !== 'none').length,
      }
    },
  }
}
