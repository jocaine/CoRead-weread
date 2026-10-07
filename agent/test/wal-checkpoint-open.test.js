/**
 * 回归守卫：凡是要跑 `PRAGMA wal_checkpoint(...)` 的维护脚本，打开库时**不能用只读连接**。
 *
 * 为什么要有这条 —— 同一个坑在三天里踩了两次，第二次的代价比第一次大得多：
 *   · 2026-10-07  chat.db.diag-wal.mjs：只读打开 + checkpoint → 脚本当场崩，
 *                  "暂存本里有没有没搬回去的数据"这个最要紧的判读打印不出来
 *                  （修于 fd37892：「体检脚本改可写打开」）。
 *   · 2026-10-08  backup-chat.mjs：同一处漏修 → **暂存本非空时崩在预检，备份根本没产出**。
 *                  而它恰恰在"有数据悬在暂存本里"时才崩，暂存本为空时反而跑得通 ——
 *                  等于"没事时能备份、真有事时备份不了"，旧的备份文件还留在目录里，
 *                  用户很容易以为已经备过。
 *
 * 机制（一句话）：checkpoint 是**写操作**（把暂存本里的帧搬回主库），只读连接上 SQLite
 * 会抛 `disk I/O error`（errstr=disk I/O error，errcode 778=SQLITE_IOERR_WRITE），
 * 也可能报 `attempt to write a readonly database` —— 同一个成因，措辞随环境变。
 *
 * 为什么用"扫源码"而不是"真连一个库跑一遍"：真跑需要 spawn 子进程（CLI 脚本会
 * process.exit），而受限沙箱里 spawn 带管道的子进程会被拒（EPERM），
 * 这条守卫就会在沙箱里永远红着。扫源码没有依赖，任何环境都跑得动。
 * 本仓库已有同类守卫的先例（graph-view 不许出现 .strokeText(、render() 不许直接读 hl.ids）。
 *
 * 覆盖范围：agent/scripts/*.mjs（面向用户的维护脚本都在这一格）。
 * agent/lib/chat-store.js 里那句 wal_checkpoint(TRUNCATE) 不在范围内 —— 它跑在类自己
 * 持有的连接上，是否只读取决于实例化参数，静态扫不出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts')

/**
 * 只留**代码行**（去掉注释）。
 * 必要性：diag-wal 的说明注释里就原样写着 `{ readonly: true }`（那是"别这么写"的示例），
 * 一并匹配会把正确的写法判成错的。同理，注释里提到 wal_checkpoint 也不算"真的在跑"。
 */
function codeLines(src) {
  return src.split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const s = text.trim()
      return s && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
    })
}

const files = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')).sort()
const sources = new Map(files.map((f) => [f, codeLines(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'))]))
const checkpointFiles = files.filter((f) => sources.get(f).some((l) => /wal_checkpoint/.test(l.text)))

test('守卫确实覆盖到会 checkpoint 的脚本（防止它悄悄失效）', () => {
  assert.ok(checkpointFiles.includes('backup-chat.mjs'),
    'backup-chat.mjs 应当在受检清单里；若它不再 checkpoint，请同步删掉这条守卫')
  assert.ok(checkpointFiles.includes('chat.db.diag-wal.mjs'),
    'chat.db.diag-wal.mjs 应当在受检清单里；若它不再 checkpoint，请同步删掉这条守卫')
})

for (const f of checkpointFiles) {
  const lines = sources.get(f)
  test(`${f}：跑 wal_checkpoint 的连接必须是可写的`, () => {
    for (const hit of lines.filter((l) => /wal_checkpoint/.test(l.text))) {
      // 往回找最近的"打开库"语句：checkpoint 写在哪个连接上，就看那一条
      const openers = lines
        .filter((l) => l.line < hit.line)
        .filter((l) => /openChatStore\s*\(|new\s+DatabaseSync\s*\(/.test(l.text))
      const opener = openers[openers.length - 1]
      assert.ok(opener,
        `${f}:${hit.line} 之前 25 行代码内找不到打开库的语句 —— 若改了写法，请同步更新这条守卫`)
      assert.doesNotMatch(opener.text, /readOnly\s*:\s*true|readonly\s*:\s*true/,
        `${f}:${opener.line} 用只读连接打开，却在 ${hit.line} 跑写操作 wal_checkpoint —— ` +
        `暂存本非空时脚本会当场崩（见本文件头部记录）`)
    }
  })
}
