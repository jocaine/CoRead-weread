/**
 * 联网搜索（2026-10-27）：把 R1 大纲里的「验：」行拿去查网页，结果作为一块材料交给终稿。
 *
 * 为什么是"我们自己调接口"而不是 function calling（工具调用）：R1 那行「验」就是模型自己
 * 写下的"该查什么"，查询计划已经在草稿里了；再让模型在终稿里来回发工具调用，只多出一轮
 * 等待，并且会把流式输出打断。所以我们直接 POST，模型只在最后读结果。
 *
 * 接口与实测（2026-10-27，DeepSeek 官方自研搜索引擎）：
 *   POST {apiBase}/v1/tools/search   {query, count, ori_question, need_content}
 *   → {results: [{rerank_score, title, url, snippet, summary, content, site_name, date, authority}]}
 *
 * 四条从实测里来的定规，不是猜的：
 *   ① rerank_score ≥ 1.5 才算数（官方文档：≥1.5 为优质结果）。实测「党章里党的性质」那次
 *      最高只有 1.24，返回的全是"党章为何义务先于权利"这类评述——拿它当证据就是幻觉原料。
 *   ② summary 长度从 53 字到 1,410 字不等（差 26 倍），必须截；不截的话 3 条 query × 5 条
 *      就有 9,535 字 ≈ 5,900 token，能把终稿的预算吃光。
 *   ③ date 不可信：一份 2007 年的解读页报 2025-09-26，党章全文报 null。它是页面时间，不是
 *      文件发布年。所以这块材料不印 date ——印了模型就会拿它当"哪一年"的答案。
 *   ④ snippet 是网页里**原样摘的句子**（中间用「...」省略掉一段），summary 才是搜索服务写的二手转述。
 *      所以正文取 snippet，提示词那头只用说一句"别把省略的部分补上"——它本来就可以当原话引。
 *
 * 不接 Fetch（抓整页）：实测摘要 300 字已经答上 8/10 条，剩 2 条是"要原文"场景；而整页
 * 13,751～21,060 字，第 48 条在 57% 处，抓回来还得再写一个定位器才用得上。这一版不做。
 *
 * 摘要一律**截开头**，不做"挑最贴题的一段"（试过，撤了，见 normalizeHits 上面那段注释）。
 *
 * 纯网络 + 纯字符串，不读写文件。
 */
import { canRetryError } from './error-classify.js'

export const SEARCH_LIMITS = {
  count: 5,             // 每次请求要几条（接口默认 10，上限 50；5 条够用且总量可控）
  keepPerQuery: 3,      // 每条 query 最多留几条给终稿
  summaryChars: 300,    // 正文上限（snippet 通常 75～195 字，碰不到；兜底用 summary 时才截）
  minSnippetChars: 40,  // snippet 短于这个就当没有，退回 summary 开头（见 normalizeHits）
  dedupeRatio: 0.6,     // 两条正文的两字组重合率到这儿就算"同一份文件被转发"（见 sameText）
  minScore: 1.5,        // rerank_score 低于这个不算数（见文件头 ①）
  maxChars: 3000,       // 整块材料的字数上限（≈1,860 token，终稿预算 6,144）
  queryChars: 128,      // **接口硬上限**：query 只能 1～128 个 Unicode 字符，超了直接 400
  timeoutMs: 10_000,    // 单次请求超时（实测 0.3–0.5 秒）
  retries: 1,           // 429/5xx/网络层失败重试几次
}

/**
 * 这个 API 地址有没有搜索接口。
 *
 * 为什么要判：侧栏的「模型 API 配置」允许填任意 OpenAI 兼容地址（agent/lib/api-config.js），
 * 而 /v1/tools/search 只有 DeepSeek 官方有。不判的话，换一家服务商就会每题撞一次 404，
 * 白等 0.3 秒、日志还满屏报错。
 */
export function canSearch(apiBase) {
  try {
    const h = new URL(String(apiBase)).hostname.toLowerCase()
    return h === 'deepseek.com' || h.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

/** 去掉结果 URL 末尾的 #1 / #2（接口自己加的序号，不是页面锚点，印给模型只会被照抄）。 */
export function cleanUrl(url) {
  return String(url || '').replace(/#\d+$/, '')
}


/**
 * 清标题：接口会把站点 URL 拼在尾巴上（"…的通知_国务院文件_中国政府网 - https://www"）。
 *
 * 2026-10-28 加：接口偶尔把**标题自己**重复拼一遍（实测"依法厘清政府债务范围 坚决堵住违法举债渠道
 * ——财政部有关负责人就地方政府债务问题答记者问 - 依法厘清政府债务范围 坚决…"，前面已经说完了，
 * 后面又从头念一遍再被截断）。判法：分段之后，非首段如果和首段开头重了 8 个字以上、或整段被首段
 * 包着，就丢掉那一段——而不是按"含 - 就去掉"硬砍，那会砍掉"XX - 国务院办公厅"这种真出处。
 */
export function cleanTitle(title, max = 60) {
  let t = String(title || '')
    .replace(/\s+-\s+https?:\/\/\S*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const stripTail = (s) => String(s || '').replace(/[…\.]+$/, '').trim()
  const parts = t.split(/\s+[-_|]\s+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length > 1) {
    const head = stripTail(parts[0])
    const kept = parts.filter((p, i) => {
      if (i === 0) return true
      const q = stripTail(p)
      // 门槛 10 个字是关键："国务院办公厅"这种 6 个字的真出处，往往正是首段开头的发文机关，
      // 按"开头重了就删"会把出处删掉（实测踩过一次）；而重复拼的标题尾巴都够长。
      if (q.length < 10) return true
      return !head.startsWith(q.slice(0, 10))
    })
    t = kept.join(' - ')
  }
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 清站点名：接口给的 site_name 常常是空的，退回域名就成了 `static.sse.com.cn` 这种给人看的东西
 * （读者不知道那是什么）。中文站点名（人民网财经）原样用；裸域名去掉常见的子域前缀。
 */
const SITE_SUBDOMAIN_RE = /^(?:www\d?|m|wap|static|news|app|web)\./i
export function cleanSite(site) {
  const s = String(site || '').trim()
  if (!s) return ''
  if (/[\u4e00-\u9fa5]/.test(s)) return s
  return s.replace(SITE_SUBDOMAIN_RE, '')
}

/** 只解常用的那几个实体；解不了的原样留着（宁可看见 `&foo;`，也别吞掉内容）。 */
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', middot: '·',
}
function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, k) => {
    const key = String(k).toLowerCase()
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m
  })
}

/** 剥掉开头那种 PDF/脚注残留："[21]526- 529总之，……"。只认紧跟数字的窄形状，别的不动。 */
const LEAD_FOOTNOTE_RE = /^\[\d{1,3}\][\d\s\-–—]{0,12}(?=[\u4e00-\u9fa5])/

/**
 * 只认 HTML 标签名，别的一律不当标签（2026-10-28 实测踩的）：
 * 原来用 `<[^>]*>` 通吃，把法条里的书名内层尖括号一起吃了——
 * `《关于修改<中华人民共和国工会法>的决定》` 被洗成 `《关于修改 的决定》`，正好丢掉"改的是哪部法"。
 */
const TAG_RE = /<\/?(?:a|b|i|u|s|p|br|hr|div|span|table|thead|tbody|tfoot|tr|td|th|li|ul|ol|dl|dt|dd|h[1-6]|strong|em|font|img|script|style|meta|link|section|article|header|footer|nav|blockquote|pre|code)\b[^>]*>/gi

/**
 * 把一条材料的正文洗成**人读得通、一个字不少**的几行（2026-10-28，用户两次校准）。
 *
 * 为什么洗：snippet 是搜索引擎从网页里摘的**几段不相邻的句子**，中间用「...」缝起来。给人读
 * 就成了"读着读着跳走了"——实测 28 条材料里 22 条是这种（79%）；还混进过整段 HTML 表格
 * （`</td><td></tr><tr>…`，模型能读，人不能）。用户原话："我现在反正是看不懂材料里面的写的东西"。
 *
 * 第一版是"只留最完整的那段"，用户当场否掉：193 字的材料洗完只剩 34 字，正在论证的那半截被丢了
 * ——"为什么会显示不全呢"。所以现在**不挑、不丢内容**，只做三件事：
 *   ① 去掉 HTML 标签、解常用实体、空白压成一个空格；
 *   ② 按「...」/「…」切段（300 字上限截出来的 `…` 也在这里切），**一段一行**——缝成一句才难读，
 *      分段读就行；
 *   ③ 只丢**真正的垃圾段**：没有中文的残片、不到 12 个字的碎句、页面的免责/著录说明
 *      （"本文数据来源…"）。丢完一个字的正文都不剩，就退回原文。
 * 每段各自清掉两侧那半个引号；段尾不是句号就在尾巴留一个「…」，让人看得见这段被截断了。
 *
 * 注意：这只用于**给人看的那份**（侧栏面板）。喂给终稿的还是原文——那是凭据，少一个字都可能
 * 让判断失据；而且记录里要能看见模型当时到底读到了什么。
 *
 * @param {string} text
 * @param {{minKeep?: number}} [opts]
 * @returns {string} 多段时用换行分隔（面板那边 .cite-txt 是 pre-wrap，换行会照原样显示）
 */
export function cleanSnippet(text = '', opts = {}) {
  const minKeep = Number(opts.minKeep) > 0 ? Number(opts.minKeep) : 12
  const raw = String(text || '').trim()
  if (!raw) return ''
  let t = raw.replace(TAG_RE, ' ')
  t = decodeEntities(t).replace(/\s+/g, ' ').trim()
  if (!t) return raw
  const segs = t.split(/\s*(?:\.{2,}|…+)\s*/).map((s) => s.trim()).filter(Boolean)
  if (!segs.length) return raw
  const kept = []
  for (const seg of segs) {
    if (isJunkSegment(seg)) continue
    kept.push(tidySegment(seg))
  }
  if (!kept.length) return raw
  const out = kept.join('\n')
  return out.replace(/\n/g, '').length >= minKeep ? out : raw
}

/** 页面元信息（免责、著录、口径说明），不是内容。 */
const META_SEGMENT_RE = /^(?:本文|本报告|本表|数据来源|资料来源|数据说明|注[:：]|说明[:：]|免责|口径|城投公司口径|全文)/

/** 这一段是不是该整段丢掉（判法见 cleanSnippet 的注释③）。 */
function isJunkSegment(s) {
  const x = String(s || '').replace(LEAD_FOOTNOTE_RE, '').trim()
  if (!x) return true
  if (!/[\u4e00-\u9fa5]/.test(x)) return true       // 纯符号/数字/外文残片
  if (x.length < 12) return true                    // "改革力度之大""第四章 基层工会组织"
  return META_SEGMENT_RE.test(x)
}

/** 段两侧那半个引号清掉；段尾被截断就留一个「…」。 */
function tidySegment(s) {
  let x = String(s || '').replace(LEAD_FOOTNOTE_RE, '').trim()
  // 段是从句子中间切开的：清掉开头残留的收尾引号、结尾残留的半截开引号
  x = x.replace(/^[”」』）)]+/, '').replace(/[“「『(（]+$/, '').trim()
  // 引号多出来一个（原文是一段长引文，被切在各段里）：把那半个引号去掉，
  // 否则读起来是「…限制条件”。」——不知道谁在说话，也不知道引到哪儿结束
  const nOpen = (x.match(/[“「『]/g) || []).length
  const nClose = (x.match(/[”」』]/g) || []).length
  if (nClose > nOpen) x = x.replace(/[”」』](?=[。！？，；：、）)])/g, '').trim()
  // 段尾被切在半个连接词上（实测"…倍数法。另外"）：这类尾巴留着只会让人以为还有下文
  x = x.replace(/(?:另外|以及|同时|并且|而且|但是|因此|所以|因为|由于|对于|关于)[，、]?$/, '').trim()
  if (!/[。！？…”」』）)]$/.test(x)) x = x.replace(/[，、；：,;:]+$/, '').trim() + '…'
  return x
}

/**
 * 两条结果是不是"同一份文件被不同站点转发"。
 *
 * 为什么要判：中国政府类网页的同一份文件会同时出现在门户、国务院公报、地方转发上，
 * 正文一字不差。实测一轮 11 条里 3 条是这种重复，白花掉四分之一预算，而终稿并不会因为
 * 多看到一遍就更确信。
 *
 * 判法用**两字组重合率**（Jaccard：交集 / 并集）。这里用词频是合适的——判"是不是同一段话"
 * 跟判"这段是不是答案"是两件事，前者词频很准，后者不行（那正是我撤掉挑窗口的原因）。
 */
export function sameText(a, b, ratio = SEARCH_LIMITS.dedupeRatio) {
  const grams = (s) => {
    const t = String(s || '').replace(/[\s\p{P}]/gu, '')
    const out = new Set()
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return String(a).trim() === String(b).trim()
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter) >= ratio
}

/**
 * 把接口返回的 results 收成能印的几条：过分数线的留下、按分数排、去重。
 *
 * 正文取 **snippet**，不取 summary —— 2026-10-27 实测改的，这是整块最要紧的一处：
 *   · summary 说的是"这一页讲了什么"，常常从公文头开始（发文机关｜发文字号｜发布日期）
 *     或者从页面导航开始。截 300 字，截到的经常是一张表。
 *   · snippet 说的是"这一页里跟这次 query 相关的那一两句"，接口已经挑好了——也就是业界说的
 *     上下文压缩（contextual compression），只不过压缩器在搜索引擎那边，不在我们这儿。
 *   · 实测 5 个问题 × 前 3 条共 15 条：snippet 命中 13 条，摘要前 300 字命中 12 条。
 *     更要紧的是内容：问"党章里党的性质原文"，snippet 直接是「中国共产党是中国工人阶级的
 *     先锋队……」，摘要前 300 字给的是第二章党的组织制度。
 *
 * 自造压缩器试过（按两字重合度滑窗挑最贴题的一段），量完撤了：12 条里只有 3 条略好，
 * 而那 3 条把标题/文号换掉了——正好是"什么文件"的答案。**词频高不等于答上了**。
 * 真要自己做压缩，业界的做法是让模型提取、或者让重排模型打分，不是数字频。
 *
 * 去重放在"截到 3 条"**之前**：同一份文件转发三次的，不该占掉三个名额。
 *
 * @param {Array} results 接口原样返回的 results
 * @param {object} opts 覆盖 SEARCH_LIMITS 的任一项
 * @returns {Array<{score: number, site: string, url: string, title: string, text: string, shown: string}>}
 *   `text` 是原文（喂终稿、进记录）；`shown` 是同一段洗过一遍的、给人看的那份（侧栏面板）。
 *   两份都在命中这里算出来，是为了让"洗"只有一处、侧栏不必自己再写一套规则。
 */
export function normalizeHits(results = [], opts = {}) {
  const lim = { ...SEARCH_LIMITS, ...(opts || {}) }
  const sorted = (Array.isArray(results) ? results : [])
    .filter((x) => Number(x?.rerank_score) >= lim.minScore)
    .sort((a, b) => Number(b.rerank_score) - Number(a.rerank_score))

  const picked = []
  for (const x of sorted) {
    const title = cleanTitle(x.title)
    // snippet 太短就没有信息量，退回摘要开头——这是唯一用 summary 的场合
    const snip = String(x.snippet || '').trim()
    const body = snip.length >= lim.minSnippetChars
      ? snip
      : (String(x.summary || '').trim() || snip || title)
    const text = body.length > lim.summaryChars ? body.slice(0, lim.summaryChars) + '…' : body
    const hit = {
      score: Number(x.rerank_score),
      site: cleanSite(String(x.site_name || '').trim() || (() => { try { return new URL(cleanUrl(x.url)).hostname } catch { return '网页' } })()),
      url: cleanUrl(x.url),
      title,
      text,
      shown: cleanSnippet(text),
    }
    if (picked.some((p) => sameText(p.text, hit.text, lim.dedupeRatio))) continue
    picked.push(hit)
    if (picked.length >= lim.keepPerQuery) break
  }
  return picked
}

/**
 * 这一轮真正要印出去的是哪几组（纯函数）。
 *
 * **出错的那组整条不印**（2026-10-27 定的）：网络挂了、402 了、超时了，是我们这边的问题，
 * 不是"这件事网上查不到"。印成「没搜到能用的」等于替事实下了一个它不该有的结论——
 * 终稿会据此告诉用户"这一处没有资料"。失败留给日志和记录，材料里一个字不提。
 */
function keepGroups(groups) {
  return (Array.isArray(groups) ? groups : []).filter((g) => g && String(g.query || '').trim() && !g.error)
}

/**
 * 按预算挑出每组要印哪几条（纯函数）。
 *
 * 预算怎么分：**每条 query 先保一条**——验证清单里每一处都该有结果，不能因为后面的高分结果
 * 多就把某一组整块挤掉；剩下的字数按分数从高到低填，每条 query 不超过 keepPerQuery。
 *
 * 单独成一个函数，是为了让"印出去几条"这个数**就是**印出去的条数：
 * 之前拿 normalizeHits 的产出当统计，报"可用 12 条"而实际印了 8 条（预算砍掉的没算）。
 *
 * @returns {Array<Array>} 每组要印的命中（顺序与 keepGroups 后的一致）
 */
export function selectHits(groups = [], opts = {}) {
  const lim = { ...SEARCH_LIMITS, ...(opts || {}) }
  const gs = keepGroups(groups)
  if (!gs.length) return []
  const cost = (h) => h.text.length + h.url.length + String(h.title || '').length + 20
  const keep = gs.map((g) => (Array.isArray(g.hits) && g.hits.length ? [g.hits[0]] : []))
  let used = 0
  for (const k of keep) for (const h of k) used += cost(h)

  const extra = []
  gs.forEach((g, gi) => {
    for (const h of (g.hits || []).slice(1)) extra.push({ gi, h })
  })
  extra.sort((a, b) => b.h.score - a.h.score)
  for (const { gi, h } of extra) {
    if (keep[gi].length >= lim.keepPerQuery) continue
    if (used + cost(h) > lim.maxChars) continue
    keep[gi].push(h)
    used += cost(h)
  }
  return keep
}

/**
 * 把"要印出去的命中"摊平成带编号的条目（纯函数）。
 *
 * 编号是**跨组连续**的：正文里写 `[3]`，指的就是材料块里第 3 条。分组那层（`· 问题`）只说明
 * "这条是为哪一问查的"，编号不跟着分组重新数——否则正文写 `[2]` 时读者得先猜是哪一组。
 *
 * 2026-10-27 加：终稿不再把材料抄进正文，只在该处打一个 `[n]`，点开才看得到原话。
 * 所以编号必须和材料块**同源同序**，由这个函数一处算出来，formatSearchBlock 与接线共用。
 *
 * @returns {Array<{n: number, query: string, title: string, site: string, text: string, url: string}>}
 */
export function pickSearchItems(groups = [], opts = {}) {
  const gs = keepGroups(groups)
  if (!gs.length) return []
  return flattenItems(gs, selectHits(gs, opts))
}

/** 组序 → 条目序（编号唯一的产生处，见 pickSearchItems）。 */
function flattenItems(gs, keep) {
  const out = []
  gs.forEach((g, gi) => {
    for (const h of keep[gi] || []) {
      out.push({
        n: out.length + 1,
        query: String(g.query).trim(),
        title: h.title || '',
        site: h.site || '',
        text: h.text || '',
        // 给人看的那一份（洗过）；没有就是没洗过（老数据），侧栏退回 text
        shown: h.shown || '',
        url: h.url || '',
      })
    }
  })
  return out
}

/**
 * 把各组的命中排成材料（纯函数，可测）。
 *
 * 输出是**纯数据**，不带【搜索结果】这种标题，也不写"不要编"这种规矩——提示词的骨架归
 * l3-tasks.js，这里只管把查到的东西摆清楚。
 *
 * 每条前面带 `[n]`：终稿正文引用材料时写的就是这个编号（编号由 flattenItems 统一产生，
 * 与 pickSearchItems 同序，不会各数一套）。
 *
 * @param {Array<{query: string, hits: Array}>} groups
 * @returns {string} 没有可用结果时返回 ''
 */
export function formatSearchBlock(groups = [], opts = {}) {
  const gs = keepGroups(groups)
  if (!gs.length) return ''
  const items = flattenItems(gs, selectHits(gs, opts))
  const lines = []
  for (const g of gs) {
    const q = String(g.query).trim()
    lines.push(`· ${q}`)
    const mine = items.filter((it) => it.query === q)
    if (!mine.length) {
      lines.push('  - 没搜到能用的')
      continue
    }
    for (const it of mine) {
      // 标题单独一行：snippet 常常不含文件身份（"《土地管理法》将于2020年1月1日实施"没说是哪份文件），
      // 而"什么文件"正是要答的东西。标题也顺带把年份/机关名带进来，比在正文里硬截可靠。
      lines.push(`  - [${it.n}] ${it.title || '（无标题）'}（${it.site}）`)
      lines.push(`    ${it.text}`)
      lines.push(`    ${it.url}`)
    }
  }
  return lines.join('\n')
}

/** 一次请求（含重试）。失败一律返回空数组——搜索不该让这一轮回答失败。 */
async function requestOnce({ apiBase, apiKey, query, question, lim, log }) {
  const url = `${String(apiBase).replace(/\/$/, '')}/v1/tools/search`
  const body = JSON.stringify({
    query: String(query).slice(0, 128),                       // 接口：1～128 个字符
    count: lim.count,
    need_content: false,                                      // 只要摘要（整页 1.4 万字，塞不进预算）
    ...(question ? { ori_question: String(question).slice(0, 128) } : {}),
  })
  for (let attempt = 0; attempt <= lim.retries; attempt++) {
    let resp
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(lim.timeoutMs),
      })
    } catch (e) {
      if (attempt < lim.retries && canRetryError(e)) { log(`搜索重试（${e.message.slice(0, 40)}）`); continue }
      throw e
    }
    const raw = await resp.text()
    if (!resp.ok) {
      const e = new Error(`搜索接口 HTTP ${resp.status}: ${raw.slice(0, 120)}`)
      e.status = resp.status
      if (attempt < lim.retries && canRetryError(e)) { log(`搜索重试（HTTP ${resp.status}）`); continue }
      throw e
    }
    let data
    try { data = JSON.parse(raw) } catch { throw new Error('搜索接口返回的不是 JSON') }
    if (data?.error) throw new Error(data.error.message || '搜索接口报错')
    return Array.isArray(data?.results) ? data.results : []
  }
  return []
}

/**
 * 「验」行太长时按句读切成几次搜（2026-10-27 用户定：不许设上限、不许悄悄截断）。
 *
 * 为什么不能直接发：接口写明 `query` 只能 1～128 个 Unicode 字符，超了返回 400。
 * 所以"不设上限"只能靠**切成几段分别搜**来实现——切在句读上，一段话不会从半句开头。
 * 断点太靠前（切出来只剩半句、没意义）就按 128 硬切，总比丢掉后半句强。
 *
 * 实测「验」行是 20～60 字，几乎不会触发；这条是为了"万一"。
 *
 * @returns {string[]} 每段都 ≤ max 字；整句够短时原样返回一段
 */
export function splitQuery(text, max = SEARCH_LIMITS.queryChars) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return []
  if (s.length <= max) return [s]
  const out = []
  let rest = s
  while (rest.length > max) {
    let end = -1
    for (const mark of ['。', '；', '，', '、', ' ']) {
      const at = rest.lastIndexOf(mark, max - 1)
      if (at >= 0 && at + 1 > end) end = at + 1   // 断点**含**这个标点，一个字都不丢
    }
    if (end < max / 3) end = max                  // 断点太靠前 → 硬切，别切出半句
    out.push(rest.slice(0, end).trim())
    rest = rest.slice(end).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/**
 * 把 R1 的「验」行逐条拿去搜，返回可以直接交给终稿的材料块。
 *
 * 任何一条失败都只影响它自己（那一组印「没搜到能用的」）；整体失败返回空串，
 * 终稿那边就当作"这一轮没联网"。
 *
 * **不设条数上限**（2026-10-27 用户定）：R1 列了几处就查几处。一处搜一次是 0.005 元、
 * 0.3–0.5 秒，并行发出去，加条数几乎不涨时间；而少查一处，终稿那一处就只能靠印象写。
 *
 * @param {string[]} queries  R1 抽出来的「验」行（一句一条）
 * @param {object} opts { apiBase, apiKey, question, limits?, log? }
 * @returns {Promise<{text: string, items: Array, stats: object}>}
 *   items 就是材料块里印出去的那些条目（带编号），侧栏用它渲染"点开看原话"的折叠块；
 *   text 是同一批条目的文字版，给终稿读。两者同源（pickSearchItems / formatSearchBlock）。
 */
export async function searchVerifyPoints(queries = [], opts = {}) {
  const lim = { ...SEARCH_LIMITS, ...(opts.limits || {}) }
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const t0 = Date.now()
  const clean = [...new Set((queries || []).map((q) => String(q || '').trim()).filter(Boolean))]
  // queries = 几处要查；requests = 实际发了几次（超长的会被切开）；split = 有几处被切过
  const stats = { queries: clean.length, requests: 0, results: 0, kept: 0, chars: 0, ms: 0, split: 0, error: '' }
  const done = () => { stats.ms = Date.now() - t0; return { text: '', items: [], stats } }

  if (!clean.length) return done()
  if (!opts.apiKey) { stats.error = '没有 API Key'; return done() }
  if (!canSearch(opts.apiBase)) { stats.error = '这个 API 地址没有搜索接口'; return done() }

  const groups = await Promise.all(clean.map(async (query) => {
    const parts = splitQuery(query, lim.queryChars)
    if (parts.length > 1) {
      stats.split++
      log(`「验」行 ${query.length} 字超过接口上限 ${lim.queryChars}，切成 ${parts.length} 次搜`)
    }
    try {
      const chunks = await Promise.all(parts.map((p) => requestOnce({
        apiBase: opts.apiBase, apiKey: opts.apiKey, query: p, question: opts.question, lim, log,
      })))
      stats.requests += parts.length
      stats.results += chunks.reduce((n, c) => n + c.length, 0)
      // 切开搜回来的几部分可能互相重复（同一份文件），合成一组时再按分数去重
      const merged = []
      for (const h of chunks.flatMap((c) => normalizeHits(c, lim)).sort((a, b) => b.score - a.score)) {
        if (merged.some((m) => sameText(m.text, h.text, lim.dedupeRatio))) continue
        merged.push(h)
        if (merged.length >= lim.keepPerQuery) break
      }
      return { query, hits: merged }
    } catch (e) {
      stats.requests += parts.length
      log(`搜索失败「${query.slice(0, 16)}」：${e.message.slice(0, 80)}`)
      return { query, hits: [], error: e.message }
    }
  }))

  const text = formatSearchBlock(groups, lim)
  const items = pickSearchItems(groups, lim)   // 与 text 同源同序：正文里的 [n] 靠它对上
  stats.kept = items.length                    // 印出去几条，就报几条
  stats.chars = text.length
  stats.ms = Date.now() - t0
  return { text, items, stats }
}
