#!/usr/bin/env node
/**
 * 静态闸门：消息区遍历必须走唯一入口（2026-11）
 *
 * 背景：`#msgs` 是**一个容器装所有会话**——切书 / 切对话只把别的会话的气泡置成
 * `display:none`，不从 DOM 移除。所以那格里永远躺着所有会话的历史（实测几百个隐藏节点）。
 * 任何"这格有什么 / 有多少 / 是不是空的"的判断，如果只数"有没有子元素"，就会永远为真。
 *
 * 代价已经付过一次：开场卡整整两轮没露面，屏幕上什么都没有、日志里却说"已有内容"——
 * 因为判据撞上了别的书的隐藏气泡。正确写法靠人记着，就一定会再忘。
 *
 * 所以这里把它变成机器管的事：`extension/sidebar.js` 里凡是直接摸 `#msgs` 子节点的地方，
 * 只允许三类，其余一律报错：
 *   ① 唯一入口自身（nodesInContext / applyBookFilter 的过滤循环 / msgsDigest 的诊断循环）
 *      —— 用行尾标记 `msgs-walk-ok` 显式豁免，且**必须写明为什么**；
 *   ② 往消息区**追加**节点（appendChild：不涉及"读内容"，不受这条规则约束）；
 *   ③ 纯粹取容器本身（scrollTop / clientHeight / style.display 之类，不遍历）。
 *
 * 跑法：node agent/scripts/check-msgs-walk.mjs
 *       node agent/scripts/check-msgs-walk.mjs --selftest   （只验判据本身，13 条对照用例）
 * 退出码非 0 = 有人绕过了唯一入口，必须先改回 nodesInContext() 再提交。
 *
 * ⚠️ 这个文件必须待在**入库目录**里。第一版写在了 test/selftest/ 下，而整个 test/ 是
 * .gitignore 排除的（只有 README 例外）——那样的闸门只存在于作者本机，别人 clone 下来
 * 根本没有，等于没做。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SIDEBAR = path.join(ROOT, 'extension', 'sidebar.js')

// 其它文件里已知的、明确接受的例外（写清理由，别默默加）
const ALLOWED_FILES = new Map([
  ['tutorial-script.js', '教程自己的"AI 有没有回话"探针：按 .msg-assistant 计数做教学判定，' +
    '误判的代价只是教程多等一步；改动风险高于收益，故明确接受。'],
])

// ① 直接取消息区的子节点集合（点号 / 可选链 / 方括号三种写法都要拦）
// ⚠️ 三个踩过的坑，都是自检用例抓出来的，别改回去：
//   · 可选链不能写成 `(?:\?\.)?`——那个组把 `?.` 里的**点**也吃掉了，后面 `\.children`
//     就没点可匹配，`msgs?.children` 永远漏判。正确写法是只把 `?` 设为可选（`(?:\?)?`），
//     点留给后半段的 `\.\s*children`；
//   · 结尾**不能写 `\b`**：`msgs?.children` 里 `s` 与 `?` 都是非单词字符，两者之间
//     **不存在词边界**，`\bmsgs\b` 直接不成立。改用负向断言 `(?![\w$])`。
const MSGS_REF = /(?:getElementById\(\s*['"]msgs['"]\s*\)|_jumpMsgsEl|\bmsgs(?![\w$]))/
const CHILD_ACCESS = new RegExp(MSGS_REF.source + String.raw`\s*(?:\?)?\s*(?:\.\s*children|\[\s*['"]children['"]\s*\])`)
// ② 同理，别的"读这格内容"的入口一并拦下
const OTHER_READ = new RegExp(MSGS_REF.source + String.raw`\s*(?:\?)?\s*\.\s*(?:childNodes|firstElementChild|lastElementChild|querySelectorAll|querySelector)(?![\w$])`)
// ③ 往消息区追加：不读内容，放行
const APPEND = /\.\s*appendChild\b/
// ④ 显式豁免标记（必须带理由，见文件头）
const OK_MARK = /msgs-walk-ok/

/**
 * 把"确定是注释"的部分掏成空白，**字符串里的代码示例保留**。
 *
 * 走过的弯路（都留在这，免得后人再踩）：
 *   · 第一版做了完整的词法状态机掏注释 —— 它在 sidebar.js 中途跑偏（某个字符让它
 *     陷进字符串状态），此后所有注释都不再被掏，闸门开始咬自己的文档；
 *   · 而"注释里的示例"恰恰是本仓库注释写得细的必然产物（比如 nodesInContext 那段
 *     就写着 `for (const el of msgs.children)`）。
 * 结论：不做词法分析，只处理三类**一眼可判**的注释。判据要的是"这一行有没有真的去读
 * 那格"，不是精确的 JS 语法树——宁可窄一点，也不要一个会跑偏的状态机。
 */
function stripComments(line) {
  const t = line.trimStart()
  if (t.startsWith('//')) return ''          // 纯注释行
  if (t.startsWith('*')) return ''           // 块注释的续行（/** ... */ 中间那些 *）
  const i = line.indexOf('//')               // 代码之后的 // 注释（含方括号写法里的引号，见文件头说明）
  return i >= 0 ? line.slice(0, i) : line
}

/**
 * 判据自检（--selftest）：拿几行**造出来的**样本喂给判据，确认该抓的抓得住、
 * 该放行的放得过。为什么非要有：第一版闸门因为"掏空函数连字符串一起掏"而完全失效，
 * 跑出来是绿的——**闸门自己瞎掉是最坏的一种绿**。这几行用例就是防它再瞎。
 */
const SELFTEST_CASES = [
  { code: "for (const el of msgs.children) { }", want: true, why: '裸遍历 children' },
  { code: "for (const el of document.getElementById('msgs').children) { }", want: true, why: '裸遍历（就地取）' },
  { code: "const kids = msgs?.children", want: true, why: '可选链写法' },
  { code: "const kids = msgs['children']", want: true, why: '方括号写法' },
  { code: "msgs.querySelectorAll('.msg-user')", want: true, why: '另一种读内容的方式' },
  { code: "msgs.childNodes.length", want: true, why: 'childNodes' },
  { code: "msgs.appendChild(el)", want: false, why: '追加不算读内容' },
  { code: "msgs.scrollTop = msgs.scrollHeight", want: false, why: '只取容器本身' },
  { code: "for (const el of nodesInContext()) { }", want: false, why: '走了唯一入口' },
  { code: "// 别裸写 msgs.children", want: false, why: '整行注释里的说明不算违规' },
  { code: "  * 遍历一律用它，别裸写 msgs.children：", want: false, why: '块注释续行里的说明不算违规' },
  { code: "const x = 1  // 曾经写成 msgs.children", want: false, why: '行尾注释里的说明不算违规' },
  { code: "for (const el of msgs.children) { }  // msgs-walk-ok: 规则源头", want: false, why: '带豁免标记的裸遍历放行（标记由主流程判）' },
]

if (process.argv.includes('--selftest')) {
  let bad = 0
  for (const c of SELFTEST_CASES) {
    const bare = stripComments(c.code)
    const marked = OK_MARK.test(c.code)
    const got = !marked && ((CHILD_ACCESS.test(bare) || OTHER_READ.test(bare)) && !APPEND.test(bare))
    const ok = got === c.want
    if (!ok) bad++
    console.log(`${ok ? '✔' : '✖'} ${c.want ? '应报错' : '应放行'}：${c.why}`)
  }
  console.log(bad ? `\n✖ 判据自检失败 ${bad} 条` : `\nOK：判据自检通过（${SELFTEST_CASES.length}/${SELFTEST_CASES.length}）`)
  if (bad) {
    console.log('\n判据本体（排查用）：')
    console.log('  CHILD_ACCESS =', CHILD_ACCESS.source)
    console.log('  对 "const kids = msgs?.children" 的匹配 =', CHILD_ACCESS.test('const kids = msgs?.children'))
  }
  process.exit(bad ? 1 : 0)
}

const src = fs.readFileSync(SIDEBAR, 'utf8')
const lines = src.split('\n')
const violations = []

for (let n = 1; n <= lines.length; n++) {
  const line = lines[n - 1]
  const code = stripComments(line)
  if (!code.trim()) continue
  if (!CHILD_ACCESS.test(code) && !OTHER_READ.test(code)) continue
  if (APPEND.test(code)) continue
  if (OK_MARK.test(line)) continue             // 标记写在注释里，要在**原文**上找
  violations.push({ n, line: line.trim() })
}

// 扫一遍扩展目录里其它文件，只报"没登记在 ALLOWED_FILES 里"的新面孔
const EXT = path.join(ROOT, 'extension')
const others = []
for (const f of fs.readdirSync(EXT)) {
  if (!f.endsWith('.js') || f === 'sidebar.js') continue
  if (ALLOWED_FILES.has(f)) continue
  const text = fs.readFileSync(path.join(EXT, f), 'utf8')
  text.split('\n').forEach((line, i) => {
    if (CHILD_ACCESS.test(line) && !APPEND.test(line)) others.push(`${f}:${i + 1}  ${line.trim()}`)
  })
}

console.log(`检查 ${path.relative(ROOT, SIDEBAR)}（${lines.length} 行）`)
console.log(`豁免标记 msgs-walk-ok：${lines.filter((l) => OK_MARK.test(l)).length} 处`)

if (others.length) {
  console.log('\n✖ 扩展目录里有别处在读消息区，未登记在 ALLOWED_FILES：')
  for (const o of others) console.log('   ' + o)
  console.log('   → 要么改成走 sidebar.js 的 nodesInContext()，要么在本脚本 ALLOWED_FILES 里登记理由。')
}

if (violations.length) {
  console.log('\n✖ 发现绕过唯一入口的遍历（消息区里躺着所有会话的隐藏气泡，裸遍历会数错）：')
  for (const v of violations) console.log(`   sidebar.js:${v.n}  ${v.line}`)
  console.log('\n   → 改用 nodesInContext()（要全量含隐藏节点时传 { all: true }）。')
  console.log('   → 确实必须自己遍历的（规则源头 / 诊断），在行尾加 `// msgs-walk-ok: 理由`。')
}

if (violations.length || others.length) process.exit(1)
console.log('\nOK：消息区的遍历都走唯一入口 nodesInContext()')
