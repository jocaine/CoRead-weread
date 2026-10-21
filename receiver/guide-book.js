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

/** 目录名：`rd_` + 内容哈希（与 receiver/index.js 的 readerDir 同一口径） */
function readerBookDir(booksDir, hash) {
  return path.join(booksDir, 'rd_' + hash)
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
    if (fs.existsSync(marker)) return { seeded: false, reason: 'already' }

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
    writeMarker(marker, { hash, name: GUIDE_NAME })
    log(`已把内置教程放进书库：${GUIDE_NAME}`)
    return { seeded: true, reason: 'seeded', hash }
  } catch (e) {
    log(`投放内置教程失败（不影响启动，下次再试）：${(e && e.message) || e}`)
    return { seeded: false, reason: 'error' }
  }
}

function writeMarker(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...data, seededAt: Date.now() }, null, 2))
}
