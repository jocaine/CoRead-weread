/**
 * 教程书渲染器 —— 入口。
 *
 * 这本书与 PDF 那套**完全不同**：PDF 是 pdf.js 把每一页画成位图 + 一层透明文字层，
 * 而这里每一章是一篇真正的 HTML（正文是真实文字节点，所以划词、选区、复制全都天然可用），
 * 其中若干章还挂着一个「把 CoRead 自己的界面演一遍」的动画。
 *
 * 为什么单独一个目录、单独一套模块（而不是塞进 reader.js）：
 * reader.js 已经 1700 多行，全都是 PDF 的东西（pdf.js 视口、懒渲染队列、扫描件判定、
 * 译文锚点）。把动画时间轴、演示帧、迷你会意图塞进去，两边都会变得没法改。
 * 阅读器只跟本模块的 8 个接口打交道（见文件末尾的导出）。
 *
 * 数据从哪来：正文在 `extension/tutorial/book/`（随扩展走，不落进用户的 data\），
 * 用户的划线/讨论走阅读器原本那条路（记在 data\reading\books\<书ID>\）。
 *
 * 书 ID 的来历（⚠️ 改它之前先读这段）：
 * 阅读器那边的书 ID 一律是「`rd_` + 内容哈希」，教程书没有 PDF、没有哈希，
 * 但**不能因此发明第二种 ID 形态**——接收端与侧栏有三处正则校验，发明新形态会被当场拦掉：
 *   receiver/index.js:370  ^[a-f0-9]{16,64}$        （归一化）
 *   receiver/index.js:407  ^rd_[a-f0-9]{32,64}$     （共读侧 ID）
 *   sidebar.js 的 applyBookContext  ^[A-Za-z0-9_]{12,}$（侧栏书籍上下文）
 * 所以这里把 ID 定成一个**固定的 64 位十六进制常量**：内容取
 * sha256('CoRead 使用手册 v1')。它天生满足上面三条，三处校验一个字都不用改。
 * 它必须与 `extension/reader.js` 里的 TUTORIAL_HEX **逐字相同**（自测会比对）。
 */

import { renderChapter, clearChapter } from './render.js'

/**
 * 这本书的固定 ID（64 位十六进制）与共读侧 ID（`rd_` 前缀）。
 * 前者的来历见文件头注释；后者与 PDF 完全同构，只是它对应的不是一个真实文件。
 */
export const TUTORIAL_HEX = 'e0c91cb6aa56dd0057235ba7374c03e599e1e37e09b3bc9f55f64e1a5b98a25e'
export const TUTORIAL_BOOK_ID = 'rd_' + TUTORIAL_HEX

/** 读到第几章记在哪：与 PDF 那套同前缀、同存储，免得又多一处「进度存在哪」的答案 */
export const TUTORIAL_STORE_KEY = 'rd:book:' + TUTORIAL_HEX

/** 正文根目录（相对**本模块**，不是相对页面） */
const BOOK_DIR = 'book/'

let manifest = null      // book.json 的内容
let current = -1         // 当前章序号（-1 = 还没打开）
let mount = null         // 章节挂在哪

/**
 * 把资源路径解析成**相对本模块**的绝对地址。
 *
 * 为什么不能直接 fetch('tutorial/book/book.json')（2026-11 实测踩到）：
 * 相对地址是按**页面**的 URL 解析的，而本模块会被两种宿主加载：
 *   · 扩展页面 reader.html（在扩展根）        → 'tutorial/book/…' 正好对
 *   · 自测夹具 test/selftest/tutorial-harness.html → 同一个相对路径会 404
 * 按 `import.meta.url` 解析则以模块自身位置为准，两种宿主都对，也不用各处各写一份。
 */
export function assetUrl(rel) {
  return new URL(rel, import.meta.url).href
}

/**
 * 取回一个 JSON。**必须检查 res.ok**：扩展页面里 fetch 一个不存在的路径会拿到
 * 一个 404 的 HTML，直接 .json() 会抛出一句跟真实原因完全无关的解析错误，
 * 排查时会被带到错误的方向去（踩过）。
 */
async function fetchJson(rel) {
  const url = assetUrl(rel)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`读不到 ${rel}（HTTP ${res.status}）`)
  return await res.json()
}

/** 读一次书的结构（幂等：只有第一次真的取） */
export async function loadBook() {
  if (manifest) return manifest
  manifest = await fetchJson(BOOK_DIR + 'book.json')
  if (!Array.isArray(manifest.chapters) || !manifest.chapters.length) {
    throw new Error('教程书没有章节（book.json 的 chapters 是空的）')
  }
  return manifest
}

export function title() {
  if (!manifest) return '第一次共读'
  const sub = manifest.subtitle ? '· ' + manifest.subtitle : ''
  return manifest.title + sub
}

export function chapterCount() { return manifest ? manifest.chapters.length : 0 }
export function currentIndex() { return current }
export function isOpen() { return current >= 0 }

/** 章节目录（阅读器的「页」就是章） */
export function toc() {
  if (!manifest) return []
  return manifest.chapters.map((c, i) => ({ num: i + 1, title: c.title, key: c.key }))
}

/**
 * 打开第 n 章（从 0 数）。重复打开同一章是幂等的。
 * @param {number} index 章序号
 * @param {HTMLElement} [host] 挂载点
 * @param {{callBackground?:Function, toast?:Function, startLesson?:Function}} [opts] 宿主注入的能力（见 render.js 的 env）
 */
export async function openChapter(index, host, opts = {}) {
  await loadBook()
  const list = manifest.chapters
  const i = Math.max(0, Math.min(list.length - 1, Number(index) || 0))
  if (host) mount = host
  if (!mount) throw new Error('教程渲染器没有挂载点')
  const chapter = await fetchJson(BOOK_DIR + list[i].key + '/chapter.json')
  const meta = Object.assign({
    index: i,
    // 课程表按**章号（1 起）**索引，而 index 是 0 起的。两个都传，别让下游自己 +1
    //（混了的表现是"第 2 章那个按钮开的是第 1 课"）
    chapterNum: i + 1,
    total: list.length,
    bookTitle: manifest.title,
    // 教程书在共读侧的身份：正文里划词点「共读」时要用它（后台据此定书、接收端据此归属）
    bookId: TUTORIAL_BOOK_ID,
  }, opts)
  await renderChapter(mount, chapter, meta)
  current = i
  return { page: i + 1, total: list.length, title: chapter.title || list[i].title }
}

/**
 * 打开这本书：先问存储「上次读到第几章」，没有就从第一章起。
 * @param {HTMLElement} host 章节挂载点
 * @param {{callBackground?:Function, toast?:Function}} [opts] 宿主注入的能力
 * @returns {Promise<{page:number,total:number}>}
 */
export async function open(host, opts = {}) {
  await loadBook()
  let index = 0
  try {
    const key = TUTORIAL_STORE_KEY
    const got = await chrome.storage.local.get(key)
    const rec = got && got[key]
    // 存的是章序号（不是页码也不是滚动位置）：章节数量少，按章恢复足够，
    // 而且正文改版之后这个数仍然有意义（页码会失效，章序不会）
    if (rec && Number.isFinite(rec.page)) index = Math.max(0, Math.min(manifest.chapters.length - 1, rec.page - 1))
  } catch {}
  return await openChapter(index, host, opts)
}

/** 关掉这本书：停掉动画、清掉挂载点里的东西 */
export function close() {
  clearChapter()
  current = -1
}

/**
 * 快照（给阅读器存进度、给侧栏认书用）。
 * 它必须在「还没打开任何一章」时也能回答出书 ID 与书名——阅读器一挂上就调它，
 * 那时候章节还在路上。
 */
export function snapshot() {
  return {
    bookId: TUTORIAL_BOOK_ID,
    hash: TUTORIAL_HEX,
    name: title(),
    page: current >= 0 ? current + 1 : 1,
    total: chapterCount() || 1,
  }
}

/**
 * 给自测用的钩子（无头浏览器里驱动动画，不靠看截图）。
 * 只暴露"读状态"和"推进到某一步"，不暴露内部实现。
 */
export function testApi() {
  return {
    key: TUTORIAL_HEX,
    bookId: TUTORIAL_BOOK_ID,
    storeKey: TUTORIAL_STORE_KEY,
    book: manifest ? { title: manifest.title, chapters: manifest.chapters.map((c) => c.key) } : null,
    current: current,
  }
}

/**
 * 把当前选中的正文设为侧栏的当前引用（教程第一步"划中 → 点共读"走的就是它）。
 * 导出是为了让阅读器把它转交给自测：那一步必须是真的，所以也要能真的验。
 */
export { submitSelection } from './render.js'

/** 课程表：书页据此决定"这一章有没有课"，侧栏据此取每一步。两边共读同一份。 */
export { LESSONS, lessonFor, lessonIndex } from './lessons.js'