/**
 * 引用自带的「划线附近原文」（PDF 阅读器那条路的上下文）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * agent 组装书籍上下文时，先拿划线原文去 `data\reading\books\<书>\chapters\*.txt` 里找
 * 整章正文、取前后各 300 字（见 index.js 的 chapterWindow）。那条路的正文来自**微信读书
 * 页面抓取**（扩展的 content.js 把整章 DOM 文字 POST 给 receiver），所以微读的书一直有上下文。
 *
 * 而 PDF 阅读器没有章节正文：`data\reading\books\rd_*\chapters\` 是空的（实测 0 个文件），
 * 于是 chapterWindow 落空，prompt 里只剩划线那一句 +「（暂无这本书的原文足迹…）」。
 *
 * 2026-11 起：阅读器在「设为引用」时把**划线前后各 300 字**随标注一起报上来
 * （extension/reader.js 的 contextAround → 后台 setTranslationRef → receiver 的 /annotation），
 * receiver 把整个请求体原样写进 `data\reading\annotations.jsonl`，所以那段文字就躺在
 * `context` 字段里。这个模块负责"按书 + 划线原文把它认领回来"。
 *
 * 只读不写；认不到就返回空串，调用方照旧说"暂无原文足迹"。
 */
import fs from 'node:fs'
import { ANNOTATIONS_FILE } from './paths.js'

/** 空白一律忽略后比较 —— 与 index.js 的 normalizeText 同规则（pdf.js 抽文字可能吞掉词间空格）。 */
function norm(text) {
  return String(text || '').replace(/\s+/g, '')
}

/**
 * 在一批标注记录里找这条引用的附近原文。纯函数，单测直接喂数组。
 *
 * @param {Array<object>} rows annotations.jsonl 解析出来的记录
 * @param {string} bookId 引用所属的书
 * @param {string} selectedText 划线原文
 * @param {(id: string) => string} [normalizeBookId] 书 ID 归一化（默认原样比较）。
 *        agent 侧传自己的 baseBookId（要去掉微读的 `k<suffix>` 章号后缀），
 *        所以这里不自己复制一份规则 —— 归一化规则只有一处真源。
 */
export function findAnnotationContext(rows, bookId, selectedText, normalizeBookId = (x) => x) {
  const base = normalizeBookId(bookId)
  const needle = norm(selectedText)
  if (!base || !needle) return ''
  // 认不到全文时的兜底：按前 24 字找（与阅读器 locateText 的取法一致）。
  // 会走到这里的现实原因：用户重开这本书之后再点一次同一条引用，两种路径抽出来的文字
  // 可能在行尾断词处差一个连字符。
  const head = needle.slice(0, 24)
  let exact = ''
  let loose = ''
  for (const a of Array.isArray(rows) ? rows : []) {
    const ctx = String((a && a.context) || '').trim()
    if (!ctx) continue
    if (normalizeBookId(a.bookId || '') !== base) continue
    const text = norm(a.selectedText)
    if (!text) continue
    if (text === needle) exact = ctx            // 同一段文字划了多次：取最后一条（最近那次）
    else if (head && text.startsWith(head)) loose = ctx
  }
  return exact || loose
}

// 存档一份几百 KB，而每条带引用的消息都要查一次 → 按 size+mtime 缓存解析结果。
let _cache = { file: '', key: '', rows: [] }

/** 读标注存档（解析失败的行跳过；文件不在就返回空数组）。 */
export function readAnnotationRows(file = ANNOTATIONS_FILE) {
  let st = null
  try { st = fs.statSync(file) } catch { return [] }
  const key = st.size + ':' + st.mtimeMs
  if (_cache.file === file && _cache.key === key) return _cache.rows
  let rows = []
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
  _cache = { file, key, rows }
  return rows
}

/**
 * 一步到位：按书 + 划线原文取那段附近原文（认不到 → 空串）。
 * @param {{file?: string, normalizeBookId?: (id: string) => string}} [opts]
 */
export function annotationContextFor(bookId, selectedText, opts = {}) {
  return findAnnotationContext(
    readAnnotationRows(opts.file),
    bookId,
    selectedText,
    opts.normalizeBookId,
  )
}
