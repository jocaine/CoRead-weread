#!/usr/bin/env node
/**
 * `/l3` 指令（2026-10-24）：切 L3 装配模式 + 开关调试。
 *
 * 为什么要有它：开关本来是两个文件（data\config\l3-mode、l3-debug）。文件没问题，但**不好用**——
 * 每次切都要找到目录、确认写对了、还得记住"改完下一句生效"。收进一条指令以后，
 * 在侧栏里直接说，回执还会把"当前是什么"念一遍（省得写错了不知道）。
 *
 * 指令形状（都写进侧栏的系统气泡，不进历史、不进栈、不调模型）：
 *   /l3                 看当前模式 + 用法
 *   /l3 full            旧路径：整条来路全量注入（每轮重发）
 *   /l3 tasks           新路径：命题递归（草稿 → 派课题 → 判父 → 汇总）
 *   /l3 both            同时跑两条：旧路径的回答给用户看，两条都进脑图（对比用）
 *   /l3 off             不发 L3（第 0 步因果验证：看 miss 掉多少）
 *   /l3 debug on|off    开/关全过程记录（脑图 + Markdown + 输入抓取）
 */
import fs from 'node:fs'
import path from 'node:path'

export const MODE_DESC = {
  full: '旧路径：整条来路全量注入（每轮重发，今天的行为）',
  tasks: '新路径：命题递归（草稿 → 派课题 → 判父 → 汇总）',
  both: '两条同跑：旧路径的回答给用户看，两条终稿都进脑图（对比用，引用那轮更慢）',
  off: '不发 L3（用于"关掉 L3 看 miss 掉多少"的因果验证）',
}

const USAGE = [
  '/l3                看当前模式',
  '/l3 full|tasks|both|off   切换（下一句提问就生效，不用重启）',
  '/l3 debug on|off   开/关全过程记录（脑图 + 逐字版 + 输入抓取）',
].join('\n')

const readTrim = (file) => {
  try { return String(fs.readFileSync(file, 'utf8')).trim().toLowerCase() } catch { return '' }
}
const exists = (file) => { try { return fs.existsSync(file) } catch { return false } }

/**
 * 执行一条 /l3 指令。
 * @param {string} arg 斜杠后面的部分
 * @param {object} p {modeFile, debugFile, log} 文件路径由调用方给（测试可传临时文件）
 * @returns {{reply:string, mode:string, debug:boolean, changed:boolean}}
 */
export function handleL3Command(arg, { modeFile, debugFile, log = () => {} } = {}) {
  const raw = String(arg || '').trim()
  const [head, ...rest] = raw.split(/\s+/)
  const sub = (head || '').toLowerCase()
  const mode0 = readTrim(modeFile) || 'full'
  const debug0 = exists(debugFile)
  const state = `当前：模式 \`${mode0}\`（${MODE_DESC[mode0] || '未知'}）｜调试 ${debug0 ? '**已开**' : '关'}`

  if (!raw) return { reply: `${state}\n\n${USAGE}`, mode: mode0, debug: debug0, changed: false }

  if (sub === 'debug') {
    const want = (rest[0] || '').toLowerCase()
    if (!['on', 'off'].includes(want)) return { reply: `用法：/l3 debug on|off\n\n${state}`, mode: mode0, debug: debug0, changed: false }
    try {
      if (want === 'on') {
        fs.mkdirSync(path.dirname(debugFile), { recursive: true })
        if (!exists(debugFile)) fs.writeFileSync(debugFile, '')
      } else if (exists(debugFile)) {
        fs.unlinkSync(debugFile)
      }
    } catch (e) {
      return { reply: `调试开关没能改（${e.message}）——检查 data\\config 能不能写。`, mode: mode0, debug: debug0, changed: false }
    }
    const on = want === 'on'
    log(`调试 ${on ? '开' : '关'}`)
    return {
      reply: `调试已${on ? '开' : '关'}。${on
        ? '\n下一句**引用到旧知识点**的话，会多出三样东西：\n· 脑图（跑完自动用浏览器打开）\n· 逐字全过程（data\\runtime\\l3-trace\\）\n· 这一轮的输入快照（data\\config\\l3-dump.json）\n想把两条路径**同时**跑、两份终稿并排看，再加一句 `/l3 both`。\n⚠️ 里面有你的真实对话，看完记得 /l3 debug off。'
        : '\n不再生成记录与脑图（已经生成的还在 data\\runtime\\l3-trace\\）。'}`,
      mode: mode0, debug: on, changed: true,
    }
  }

  if (MODE_DESC[sub]) {
    try {
      fs.mkdirSync(path.dirname(modeFile), { recursive: true })
      fs.writeFileSync(modeFile, sub + '\n')
    } catch (e) {
      return { reply: `模式没写成（${e.message}）——检查 data\\config 能不能写。`, mode: mode0, debug: debug0, changed: false }
    }
    log(`模式 ${mode0} → ${sub}`)
    const extra = sub === 'both'
      ? '\n脑图**每轮都会写**（data\\runtime\\l3-trace\\），但不自动弹窗；想每轮自动用浏览器打开，再开 `/l3 debug on`。'
      : (sub === 'off' ? '\n这一轮之后的提问都不再带 L3（用来量"关掉能省多少"）。' : '')
    return {
      reply: `已切到 \`${sub}\`：${MODE_DESC[sub]}\n下一句提问就生效（不用重启）。${extra}`,
      mode: sub, debug: debug0, changed: true,
    }
  }

  return { reply: `认不出 \`${sub}\`。\n\n${state}\n\n${USAGE}`, mode: mode0, debug: debug0, changed: false }
}
