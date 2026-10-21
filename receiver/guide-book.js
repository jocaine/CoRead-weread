/**
 * 内置教程书的投放（2026-10-21）
 *
 * ── 为什么需要这一步 ────────────────────────────────────────────────────────
 * 用户报："打出来的包没有自带 coread 教程。" 教程 PDF 既不是程序文件，也不是用户数据，
 * 三个位置各有一道硬理由：
 *   · 放 `data\`  → 打包脚本的闸门会拦（`data\` 必须只有空壳）。那道闸门是对的：
 *                   升级最自然的做法是"解压新包覆盖旧文件夹"，包里多带任何一个数据文件
 *                   都会在那一刻盖掉用户自己的记录（2026-10 用 api-config.json 踩过）。
 *   · 放 `extension\` → 它会把 1.2 MB 塞进插件目录，而 PDF 不是插件资源。
 *   · 放 `builtin\` → 这是"分发用内置资源"的格子：不属于用户、不参与备份、升级覆盖也无所谓。
 *                     所以 PDF 随包放在 `builtin\`，由本模块在**第一次启动时**拷进书库。
 *
 * ── 为什么是"拷一份"，而不是让书库直接读 builtin\ ──────────────────────────
 * 书库这一路的每个环节（打开原件、记读到第几页、翻译记录、从书库删除）都按
 * `data\reading\books\rd_<哈希>\` 这个目录工作。让内置书走另一条只读分支，等于在
 * 列表、取原件、删除三处各加一个 if，而这三处已经各有一段血泪注释。
 * 拷一份之后，它就是一本书，没有任何特殊路径。
 *
 * ── 三条规矩 ────────────────────────────────────────────────────────────────
 * 1. **只投放一次**：投放成功后写 `data\reading\guide-book.json`。用户从书库删掉教程，
 *    下次启动不会再冒出来 —— "删了就是删了"，不搞复活。
 * 2. **绝不覆盖**：书库里已经有这本（同哈希目录存在）就只补标记、不动任何文件。
 *    否则等于把用户读到的页码、译过的段落清空。
 * 3. **失败不影响启动**：整段包在 try/catch 里。缺 builtin 文件（开发目录就是这样）→
 *    静默跳过；书库目录不可写 → 记一行日志，下次启动再试。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/** 随包放在 `builtin\` 里的文件名（ASCII：包里不放中文文件名，显示名由 reader-meta 决定） */
export const GUIDE_PDF = 'coread-tutorial.pdf'
/** 书库里显示的书名 */
export const GUIDE_NAME = 'CoRead 使用教程.pdf'
/** 投放标记：存在即表示"已经给过这本书了" */
export const GUIDE_MARKER = 'guide-book.json'

/**
 * 书库侧元信息文件名。⚠️ 与 `receiver/index.js` 的 `READER_META` 必须是同一个字面量
 * （那边是全仓库唯一写它的地方，这里是启动时补一份；两个名字一旦分叉，书库列表会把
 * 这本当成"不是阅读器的书"直接跳过）。
 */
const READER_META = 'reader-meta.json'
/** 共读侧元信息（书名 / 已读过的书籍）：与 receiver/index.js 的 writeBookMeta 同一形态 */
const BOOK_META = 'meta.json'
/** 书的目录名前缀：`rd_` + 内容哈希（与 receiver/index.js 的 readerBookDir 同一口径） */
const READER_BOOK_PREFIX = 'rd_'

/** 目录名：`rd_` + 内容哈希 */
function readerBookDir(booksDir, hash) {
  return path.join(booksDir, READER_BOOK_PREFIX + hash)
}

/**
 * 把内置教程 PDF 放进书库（幂等；只做一次）。
 *
 * @param {object} o
 * @param {string} o.builtinDir  包根 `builtin\`
 * @param {string} o.booksDir    `data\reading\books`
 * @param {string} o.readingDir  `data\reading`（标记文件放这里，与 books 同级）
 * @param {(msg: string) => void} [o.log]
 * @returns {{ seeded: boolean, reason: string, hash?: string }}
 *   reason: 'no-builtin'（包里没这本，开发目录常态）| 'already'（给过了）
 *         | 'exists'（书库里已有，只补标记）| 'seeded'（刚放进去）| 'error'
 */
export function seedGuideBook({ builtinDir, booksDir, readingDir, log = () => {} }) {
  const marker = path.join(readingDir, GUIDE_MARKER)
  try {
    // 已经投放过了：只补一份共读侧 meta.json（老版本投放时没写它），别的一个字节都不动
    const prev = readMarker(marker)
    if (prev) {
      if (prev.hash) ensureBookMeta(booksDir, prev.hash)
      return { seeded: false, reason: 'already', hash: prev.hash }
    }

    const src = path.join(builtinDir, GUIDE_PDF)
    let bytes
    try { bytes = fs.readFileSync(src) } catch { return { seeded: false, reason: 'no-builtin' } }
    if (!bytes.length) return { seeded: false, reason: 'no-builtin' }

    // 书库的 ID 就是 PDF 内容的 sha256（extension/reader.js 的 readerBookId 用同一算法算）。
    // 哈希不一致 = 扩展按这个 ID 取不到原件，所以必须现算，不能写死。
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const dir = readerBookDir(booksDir, hash)
    const metaFile = path.join(dir, READER_META)
    const sourceFile = path.join(dir, 'source.pdf')

    if (fs.existsSync(sourceFile) || fs.existsSync(metaFile)) {
      // 书库里已经有这本：一个字节都不动，只记下"给过了"
      ensureBookMeta(booksDir, hash)
      writeMarker(marker, { hash, name: GUIDE_NAME, note: '书库里已有，未覆盖' })
      return { seeded: false, reason: 'exists', hash }
    }

    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(src, sourceFile)
    // 只写这几项，**不写 lastOpenedAt**：它表示"上次读到什么时候"，从来没有打开过的书
    // 不该有值（书库按它倒序排，没打开过的书自然排在打开过的后面）。
    // pages / entries 也留空：它们分别是页数与译文条数，打开一次后会由阅读器报回来。
    fs.writeFileSync(metaFile, JSON.stringify({
      name: GUIDE_NAME,
      size: bytes.length,
      hash,
      updatedAt: Date.now(),
    }, null, 2))
    ensureBookMeta(booksDir, hash)
    writeMarker(marker, { hash, name: GUIDE_NAME })
    log(`已把内置教程放进书库：${GUIDE_NAME}`)
    return { seeded: true, reason: 'seeded', hash }
  } catch (e) {
    log(`投放内置教程失败（不影响启动，下次再试）：${(e && e.message) || e}`)
    return { seeded: false, reason: 'error' }
  }
}

/**
 * 教程的**开场会话**（2026-10-21，用户定调："一打开就有它的会话，而且里面有内容"）。
 *
 * 为什么必须提前写进对话库：教程是一本 PDF，打开它时侧栏会切到"这本书的会话"。
 * 如果那里是空的，用户看到的是一块白板 —— 教程该在的地方，反而最空。
 *
 * 只写 **assistant** 消息，不伪造用户提问：用户消息会被当成用户真说过的话，
 * 进会意图、进记忆、进以后每一轮上下文，造假成本太高。
 */
export const GUIDE_OPENING = [
  '这是《CoRead 使用教程》的会话。教程本身是旁边那本 5 页的 PDF：先读一遍，再把没看明白的地方问在这里。',
  '用法记住一句就够：选中想说的那段，点「设为引用」，带着它提问。\n\n'
  + '讨论够充分的事会收口成会意图里的一个点，下次提问能命中它。'
  + '这条会话只属于这本教程，换到别的书不会跟过去。',
]

/**
 * 给教程这本书写开场会话（幂等，只写一次）。
 *
 * 三条规矩：
 *  1. 标记里记 `conversation: true` —— 用户把这段对话删了，不再补回来；
 *  2. 书里已经有消息就一条都不写（老用户可能自己聊过），只补标记；
 *  3. 失败不影响启动：教程照常能读，只是会话是空的。
 *
 * @param {{ store: any, readingDir: string, log?: (m: string) => void }} o
 * @returns {{ seeded: boolean, reason: string }}
 */
export function seedGuideConversation({ store, readingDir, log = () => {} }) {
  const markerFile = path.join(readingDir, GUIDE_MARKER)
  const marker = readMarker(markerFile)
  if (!marker || !marker.hash) return { seeded: false, reason: 'no-book' }   // 还没投放这本书
  if (marker.conversation) return { seeded: false, reason: 'already' }
  const bookId = READER_BOOK_PREFIX + marker.hash
  try {
    const existing = store.listMessages({ conv: bookId, limit: 1 })
    if (existing.length) {
      writeMarker(markerFile, { ...marker, conversation: true, note: '已有对话，未覆盖' })
      return { seeded: false, reason: 'has-messages' }
    }
    const now = Date.now()
    GUIDE_OPENING.forEach((content, i) => {
      store.insertMessage({
        conv: bookId,
        role: 'assistant',
        content,
        ts: now + i,                    // 连续两条：时间戳递增，历史回放顺序才稳
        bookId,
        bookTitle: GUIDE_NAME,
        payload: { seed: 'guide-book', v: 1 },   // 留痕：以后要改/清这段开场，认得出这几条
      })
    })
    writeMarker(markerFile, { ...marker, conversation: true })
    log(`已为内置教程写好开场会话（${GUIDE_OPENING.length} 条）`)
    return { seeded: true, reason: 'seeded' }
  } catch (e) {
    log(`写教程开场会话失败（不影响阅读）：${(e && e.message) || e}`)
    return { seeded: false, reason: 'error' }
  }
}

function readMarker(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    return d && typeof d === 'object' ? d : null
  } catch { return null }
}

/**
 * 共读侧 `meta.json`：让这本在侧栏「已读过的书籍」里也是一个会话
 * （只写书库侧 reader-meta.json 时，侧栏要等用户聊过一次才认得出它）。
 * 只在文件不存在时写，绝不改已有内容（那份可能已被用户聊过）。
 */
function ensureBookMeta(booksDir, hash) {
  const dir = readerBookDir(booksDir, hash)
  // ⚠️ 书已经不在了（用户从书库删了）就什么都不写，**连目录都不建**：
  // 建出来会是一个没有 source.pdf 的空书目录 —— 书库不列它，用户却能在磁盘上看到它。
  if (!fs.existsSync(dir)) return
  const file = path.join(dir, BOOK_META)
  if (fs.existsSync(file)) return
  const bookId = READER_BOOK_PREFIX + hash
  fs.writeFileSync(file, JSON.stringify({
    bookId,
    baseBookId: bookId,
    bookTitle: GUIDE_NAME,
    wereadBookId: '',
    updatedAt: Date.now(),
  }))
}

function writeMarker(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...data, seededAt: Date.now() }, null, 2))
}
