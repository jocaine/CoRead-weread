#!/usr/bin/env node
/**
 * 数据目录迁移：旧布局（散在代码目录里）→ 新布局（<包根>\data\，按类型分格）
 *
 * ── 什么时候要跑 ────────────────────────────────────────────────────────────
 * 2026-10 目录重构之前装过 CoRead、并且想保住阅读记录的，升级后跑一次。
 * agent 启动时会自动体检：发现旧位置有数据、新位置没有，会打印提示指到这里。
 * （只有自由对话列表在迁移前也能读到——lib/free-conversation.js 有旧路径回退；
 *   聊天库 chat.db 没有回退，不迁移就是空的，所以这一步不能省。）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node agent/scripts/migrate-data-layout.mjs                        # 演练：只打印计划
 *   node agent/scripts/migrate-data-layout.mjs --apply                # 真迁移
 *   node agent/scripts/migrate-data-layout.mjs --clean-legacy         # 看残渣清单
 *   node agent/scripts/migrate-data-layout.mjs --apply --clean-legacy # 清掉残渣
 *
 *   上面是**开发目录**的写法（node 在 PATH 里）。便携包用户要换成：
 *     internal\node.exe internal\agent\scripts\migrate-data-layout.mjs --apply
 *   —— 包里 node 不在 PATH，自带的是 internal\node.exe。程序里所有面向用户的提示
 *   都由 paths.js 的 scriptCommand() 按当前布局生成，不要再手写死命令。
 *
 *   --apply          真正执行（不带就是演练，一个文件都不动）
 *   --keep-source    搬完**保留**旧文件（默认搬完删源，避免下次启动又看到"双份"）
 *   --clean-legacy   清理旧布局残渣（见下）
 *
 * ── 关于"残渣"（--clean-legacy）────────────────────────────────────────────
 * 迁移只搬**代码还在读**的文件。旧布局里另有一批东西代码早已不读，会留在原地：
 *   · 老格式聊天流水与流式快照（chat_output.jsonl 及其一堆 .bak，本机实测 198 MB）
 *   · 老去重台账 / 游标（.chat_input_*、.agent_processed_anns）—— 已被 SQLite 取代
 *   · 调试日志 debug.jsonl、瞬态 stream.jsonl
 *   · 各类 .bak（画像、流水账、图谱、讨论栈）
 * 它们不是"数据"，删掉不影响任何功能；但**默认不删**——那是用户的东西，
 * 脚本无权替人做主。想腾空间就跑一次 --clean-legacy（会先列清单与体积）。
 *
 * ── 安全规矩（照抄本仓库既有迁移脚本的口径）────────────────────────────────
 *   1. 先复制到新位置，**逐个校验字节数一致**，通过之后才删源文件；
 *      关键文件（chat.db / 图谱 / 讨论栈）在删源之前再补一份 .pre-migrate 备份。
 *   2. 新位置已经有同名文件的，**不覆盖**（记 skipped）。这条是硬规则：宁可少搬，
 *      也不能拿旧数据盖掉用户升级后新产生的记录。
 *   3. 演练是默认行为。没有 --apply 就绝不写盘。
 *   4. 全程不碰数据内容本身（不解析、不改写），只搬位置。
 */

import fs from 'fs'
import path from 'path'
import { legacyLocations, DATA_DIR, PACKAGE_ROOT, layoutSummary, scriptCommand } from '../lib/paths.js'

const APPLY = process.argv.includes('--apply')
const KEEP_SOURCE = process.argv.includes('--keep-source')
const CLEAN_LEGACY = process.argv.includes('--clean-legacy')

/**
 * 迁移前先给这些关键文件留一份 .pre-migrate 备份 —— 丢了就找不回来的那些。
 * 名字按**新布局的目标名**写；判定时源名与目标名都认，因为老布局里这个文件叫
 * `topic_stack.json`（下划线），搬过去才叫 `topic-stack.json`（连字符）。
 *
 * ⚠️ 2026-10-08 修过这里：原来只拿**源 basename** 去比上面这份连字符名单，于是讨论栈
 * 永远匹配不上 —— 而迁移默认是**删源**，结果它在旧位置被删掉、新位置又没留第二份备份。
 * 讽刺的是文件头第 1 条与用户手册（instructions-zh）都写着"关键文件（聊天库、图谱、
 * 讨论栈）在删源之前再补一份 .pre-migrate 备份"：承诺了三份，实际只给两份。
 */
const BACKUP_BEFORE_DELETE = new Set(['chat.db', 'knowledge-graph.json', 'topic-stack.json'])

function fmt(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 递归统计目录：文件数 + 总字节 */
function dirStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) { files++; try { bytes += fs.statSync(p).size } catch {} }
    }
  }
  walk(dir)
  return { files, bytes }
}

/**
 * 旧位置里"代码早就不读"的残渣清单。
 * 规则：只列**确定不再被任何代码引用**的东西——宁可少列（用户只是没清干净），
 * 也绝不能把还有用的文件列进来（那是删数据）。
 * 程序文件（index.js / lib / scripts）一律不碰。
 */
function legacyResidue() {
  const agents = [...new Set([
    path.join(PACKAGE_ROOT, 'agent'),                  // 开发布局
    path.join(PACKAGE_ROOT, 'internal', 'agent'),       // 便携包布局（解压出来的包）
  ])]
  const inboxes = [...new Set([
    path.join(PACKAGE_ROOT, 'receiver', 'inbox'),
    path.join(PACKAGE_ROOT, 'internal', 'receiver', 'inbox'),
  ])]

  const items = []
  for (const inbox of inboxes) {
    for (const n of [
      'chat_output.jsonl', 'chat_input.jsonl', 'stream.jsonl', 'debug.jsonl',
      'pending.txt', '.chat_input_cursor', '.chat_input_replied', '.agent_processed_anns',
      'chat.db-shm', 'chat.db-wal',
    ]) items.push(path.join(inbox, n))
    try {
      for (const f of fs.readdirSync(inbox)) {
        if (/\.bak(-|$)/.test(f) || f.startsWith('deleted-messages.')) items.push(path.join(inbox, f))
      }
    } catch {}
  }
  for (const agent of agents) {
    try {
      for (const f of fs.readdirSync(agent)) {
        if (/^(profile|soul|session_journal|topic_stack|hist_cursors)\..*\.bak/.test(f)) {
          items.push(path.join(agent, f))
        }
        // .coldstart_skipped = 旧的"别再问我是否加载微信读书历史"标记。
        // 那句提问与 coldstart.js 已于 2026-10-06 删除，所以它现在只是**残渣**：
        // 不再搬进新布局（搬了就是造一个没人读的死文件），列在这里供 --clean-legacy 删掉。
        if (f === '.coldstart_skipped') items.push(path.join(agent, f))
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(path.join(agent, 'data'))) {
        if (/\.bak/.test(f)) items.push(path.join(agent, 'data', f))
      }
    } catch {}
  }
  return [...new Set(items)].filter((p) => fs.existsSync(p))
}

function cleanLegacy() {
  console.log('\n=== CoRead 旧布局残渣清理 ===')
  const items = legacyResidue()
  if (!items.length) {
    console.log('没有发现残渣——已经很干净了。\n')
    return
  }
  let total = 0
  const rows = items.map((p) => {
    let size = 0
    try { size = fs.statSync(p).size } catch {}
    total += size
    return { p, size }
  }).sort((a, b) => b.size - a.size)

  console.log(`\n残渣 ${rows.length} 项，合计 ${fmt(total)}：\n`)
  for (const r of rows) console.log(`  ${fmt(r.size).padStart(10)}  ${path.relative(PACKAGE_ROOT, r.p)}`)
  console.log('\n这些都是**代码已经不再读取**的东西：老格式聊天流水与流式快照、老游标/台账、')
  console.log('调试日志、各类 .bak 备份。删掉不影响任何功能——你的记录已经在 data\\ 里了。')

  if (!APPLY) {
    console.log('\n这是演练。确认后加 --apply 真删：')
    console.log(`  ${scriptCommand('migrate-data-layout.mjs')} --apply --clean-legacy\n`)
    return
  }
  let n = 0
  for (const r of rows) {
    try { fs.rmSync(r.p, { force: true }); n++ } catch (e) { console.log(`  ✗ 删不掉 ${r.p}：${e.message}`) }
  }
  console.log(`\n已清理 ${n} 项，释放约 ${fmt(total)}。\n`)
}

function migrate() {
  console.log('\n=== CoRead 数据目录迁移 ===')
  console.log(layoutSummary())
  console.log(`目标数据目录：${DATA_DIR}`)
  console.log(`模式：${APPLY ? '**真迁移**' : '演练（只打印计划，不动任何文件）'}`)
  console.log(`搬完源文件：${KEEP_SOURCE ? '保留' : '删除（校验通过后）'}\n`)

  const plan = []
  for (const m of legacyLocations()) {
    if (!fs.existsSync(m.from)) continue
    const dstExists = fs.existsSync(m.to)
    let size = 0
    if (m.kind === 'dir') size = dirStats(m.from).bytes
    else { try { size = fs.statSync(m.from).size } catch {} }
    plan.push({ ...m, size, dstExists })
  }

  if (!plan.length) {
    console.log('没有发现旧位置的数据——要么已经是新布局，要么这是全新安装。无需迁移。')
    console.log('（想看看旧位置有没有可清理的残渣：加 --clean-legacy）\n')
    return
  }

  const todo = plan.filter((p) => !p.dstExists)
  const skipped = plan.filter((p) => p.dstExists)

  console.log(`待迁移 ${todo.length} 项，跳过 ${skipped.length} 项（新位置已有文件，不覆盖）：\n`)
  for (const p of todo) console.log(`  [搬] ${p.note.padEnd(22)} ${fmt(p.size).padStart(10)}  ${p.from}`)
  for (const p of skipped) console.log(`  [跳过] ${p.note.padEnd(20)} 新位置已存在：${p.to}`)

  const totalBytes = todo.reduce((a, p) => a + p.size, 0)
  console.log(`\n合计需搬 ${fmt(totalBytes)}。`)

  if (!APPLY) {
    console.log('\n这是演练。确认无误后加 --apply 真正执行：')
    console.log(`  ${scriptCommand('migrate-data-layout.mjs')} --apply\n`)
    return
  }

  console.log('\n开始迁移…\n')
  let ok = 0
  let failed = 0
  const failures = []

  for (const p of todo) {
    try {
      fs.mkdirSync(path.dirname(p.to), { recursive: true })

      if (p.kind === 'dir') {
        fs.cpSync(p.from, p.to, { recursive: true, force: false, errorOnExist: false })
        const s = dirStats(p.from)
        const d = dirStats(p.to)
        if (s.files !== d.files || s.bytes !== d.bytes) {
          throw new Error(`校验不一致：源 ${s.files} 文件/${fmt(s.bytes)}，目标 ${d.files} 文件/${fmt(d.bytes)}`)
        }
        console.log(`  ✓ ${p.note}（${d.files} 个文件 / ${fmt(d.bytes)}）`)
      } else {
        fs.copyFileSync(p.from, p.to)
        const s = fs.statSync(p.from).size
        const d = fs.statSync(p.to).size
        if (s !== d) throw new Error(`校验不一致：源 ${s} 字节，目标 ${d} 字节`)
        if (BACKUP_BEFORE_DELETE.has(path.basename(p.from)) || BACKUP_BEFORE_DELETE.has(path.basename(p.to))) {
          fs.copyFileSync(p.to, p.to + '.pre-migrate')
        }
        console.log(`  ✓ ${p.note}（${fmt(d)}）`)
      }

      if (!KEEP_SOURCE) {
        if (p.kind === 'dir') fs.rmSync(p.from, { recursive: true, force: true })
        else fs.rmSync(p.from, { force: true })
      }
      ok++
    } catch (e) {
      failed++
      failures.push({ item: p, error: e.message })
      console.log(`  ✗ ${p.note} 失败：${e.message}`)
    }
  }

  console.log(`\n迁移结束：成功 ${ok} 项，失败 ${failed} 项。`)
  if (failures.length) {
    console.log('\n失败明细（源文件都还在，不会丢数据）：')
    for (const f of failures) console.log(`  · ${f.item.note}\n    源：${f.item.from}\n    因：${f.error}`)
    console.log('\n常见原因：CoRead 还在运行（文件被占用）。请先完全退出（托盘右键 → 退出），再重试。')
  } else {
    console.log(`\n完成。数据现在都在：${DATA_DIR}`)
    console.log('备份方式：复制这一个文件夹即可。')
    if (!KEEP_SOURCE) {
      console.log('（旧位置的源文件已删除；关键文件留了 *.pre-migrate 备份，确认无误后可自行清理）')
    }
    console.log('\n旧位置可能还留着代码已不读取的残渣（老格式流水、调试日志、.bak）。')
    console.log('看一眼：' + scriptCommand('migrate-data-layout.mjs') + ' --clean-legacy')
  }
  console.log('')
}

if (CLEAN_LEGACY) cleanLegacy()
else migrate()
