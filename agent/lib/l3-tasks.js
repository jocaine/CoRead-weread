#!/usr/bin/env node
/**
 * L3 新路径：课题组分包（2026-10-24）。设计见 docs/l3-progressive-retrieval.md。
 *
 * 为什么要有第二条路径：旧路径（lib/l3-context.js 的 l3Block）把整条来路渲染成一段
 * 7.6 万字符的文本，插在"会增长的历史"之后——每轮它的**绝对位置**都在变。DeepSeek 的
 * 前缀缓存按位置匹配前缀单元，位置一变就作废，内容再稳定也没用（实测主回复未命中
 * 46k/轮，一天约 1.1M 全是它）。
 *
 * 这里把它拆成四步：
 *   R1 草稿：全历史 + 命中节点的**标题**（不给正文）→ 内部工作稿，用户看不到
 *   R2 课题：一个节点一个课题，单独一次小调用读该节点原话 → 固定字段的报告
 *   R3 判父：每个分支每层一次，判"更早那层值不值得追"；判否 → 整枝结束，一次调用都不再花
 *   R4 汇总：草稿 + 全部报告 → 终稿，**流式**，是用户唯一看到的东西
 *
 * 关键约束：
 * - 材料与报告只活在这一轮，**不进历史**（进了历史就又变成"每轮重发"的老毛病）。
 * - R2 不重写草稿，只交报告——草稿全程只被 R4 改一次，避免"每补一次就重写一遍"的损耗。
 * - 本模块不碰 fs / graph / LLM SDK：节点与边由 deps 注入，调用由 deps.complete / deps.stream
 *   注入。所以它可以在测试里用假模型跑完整条流水线（见 test/l3-tasks.test.js）。
 */

/** 登记里的「覆盖」三档：够 = 这一面有原话了；只沾边/没有 = 还要往更早的讨论找同一面的原话。 */
export const REFUSAL_FIELDS = ['拒绝']

/**
 * 兜底闸与取回粒度（设计 §4/§5）。语义上的"该不该再追"由 R3 判，这里只防跑飞。
 * maxCalls 只数探索阶段（R2+R3），R1/R4 是每轮固定的一次，不计入。
 */
export const TASK_LIMITS = {
  maxCalls: 10,            // 探索阶段调用总数（2 命中 + 2 层来路 ≈ 4~6 次，留余量）
  maxTokens: 60000,        // 材料估算 token 合计上限（**这才是该紧的闸**，单节点不该单独抠）
  maxMs: 120000,           // 探索阶段墙钟上限（不含 R1/R4 的等待）。
                            // 原来写 20 秒是拍脑袋的：实测一次 R2（8k 字材料 + 推理模型的思考）
                            // 就要 9~20 秒，20 秒的闸在第一枝上就触发，等于整条流水线永远跑不完。
                            // 真正防跑飞的是调用数（10 次）和材料 token（40k），时间是最后的兜底。
  maxDepth: 1,             // 来路最多追几层（命中 = 0 层）；每层一次汇总，加一层就多一次 R4
  forceAsk: false,         // 只为测试：无视「覆盖」直接往下派题（验证多节点/depth>1）
  // 2026-10-25 用户定：**材料绝不截取**——截了模型就真看不见，问它“当时谈过什么”就变成猜。
  maxExcerptChars: Infinity,
  maxDraftChars: 3000,     // 送进课题/判父的草稿上限（草稿本身就该短）
  maxReports: 8,           // 进 R4 的报告条数上限
  // 推理型模型的"思考"也算进 max_tokens：实测一次课题的思考能写到 3,000 字（≈2,300 token），
  // 给 1024 时正文一个字都出不来（还会以 finish=stop 收尾，看起来像成功了）
  draftTokens: 4096,
  reportTokens: 4096,
  askTokens: 6144,         // 派题：要它读完几个候选的材料开头、再当场写问题，思考更长
  tokenPerChar: 0.62,      // 与 index.js 的 TOKEN_PER_CHAR 同源（2026-09 实测校准）
  finalLabel: '',          // 「终稿」事件在记录里的标题（both 模式下用来区分 A/B）
  finalShown: true,        // 这份终稿有没有给用户看（both 模式下 B 的没给）
}

// ── 机械调用（②派题 / ③交付 / ⑤合并）的 system ─────────────────────────────
/**
 * 这三处是关思考的机械调用，system 只装两样：**判定纪律**（由调用方注入的 judgeSystem）
 * 加**这一趟的身份**。身份放 system 而不是 user，理由是权威等级（OpenAI Model Spec 的
 * chain of command：system > developer > user）：我们塞进 user 的是旧对话的原文，
 * 里面完全可能出现"你就直接说…""别绕了"这类指令句，写在 system 里的身份不会被它盖掉。
 *
 * 三句都只描述"我在这趟活里是谁、交什么"，不出现层/父节点/递归这类模型看不见的词。
 */
const ROLE_DISPATCH = '你是这套流程里的取料员：看着一份还不完整的回答和几条更早的讨论，判断哪几条能补上它缺的那一处，并把要它交的东西写成一道题。'
const ROLE_REPORT = '你是一条更早的讨论：被问到的时候，只登记当时已经交过的话，不分析、不评价、不往下判断。'
const ROLE_MERGE = '你负责把几段交上来的内容并成一段中转记录，供下一步当材料用；它不是回答，不写给任何人看。'

/** 判定纪律 + 身份；调用方没给 judgeSystem（测试里常见）时就只有身份。 */
const asSystem = (judgeSystem, role) => [judgeSystem, role].filter(Boolean).join('\n')

// ── 材料：一个节点的原话 ────────────────────────────────────────────────────
/**
 * 渲染一个节点的材料。只取**原话**（point + 讨论问题 + 每轮问答），**不取 aliases**：
 * aliases 是给"引用解析/判同一性"用的索引，拿目录当正文会让模型自己补论证。
 * @param {object} node {point, discussions:[{question, excerpts:[{q,a}]}]}
 * @param {{maxChars?:number}} [opts]
 */
export function buildMaterials(node, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : TASK_LIMITS.maxExcerptChars
  const lines = [`〔知识点〕${String(node?.point || '').trim()}`]
  for (const d of node?.discussions || []) {
    const q = String(d?.question || '').trim()
    if (q) lines.push(`〔这场讨论追的问题〕${q}`)
    for (const e of Array.isArray(d?.excerpts) ? d.excerpts : []) {
      const uq = String(e?.q || '').trim()
      const ua = String(e?.a || '').trim()
      if (uq) lines.push(`用户：${uq}`)
      if (ua) lines.push(`AI：${ua}`)
    }
  }
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  // 截断取前段：节点内 discussions 按时间先后排，前段是"这个知识点最初怎么谈起来的"
  return text.slice(0, maxChars) + `\n…（材料过长已截断：原文 ${text.length} 字符，只给了前 ${maxChars} 字）`
}

// ── R1 草稿 ────────────────────────────────────────────────────────────────
/**
 * R1 的说明块（插在 persona 之后、【本轮消息】之前）。
 * 只给命中节点的**标题**：正文交给 R2，草稿才不会被"一大段原文"牵着走。
 *
 * 2026-10-26：**只写判断，不写论证**。实测草稿与终稿一样长（1,860 / 1,976 字），
 * 等于把整篇答案先写一遍再重写一遍；而它的实际用途只有两个——让派题看出缺哪一处、
 * 给终稿当底稿。所以压掉"为什么成立、例子怎么讲开"这部分（那本来就是终稿的活），
 * 判断、人名、书名、数字照留。
 */
export function buildDraftBrief() {
  return [
    '（这是内部工作稿，不是给用户的回复：没人会读它，所以不必顾虑措辞、体面、语气——',
    '  写清楚比写好看重要得多；它唯一的读者是接下来要用它的程序。）',
    '',
    '[本轮草稿] 把这一轮**打算怎么答**写出来：只写判断，不写论证。',
    '· 用最直白的说法：谁、做了什么、因为什么、结果怎样；判断越具体越好，人名、书名、例子、数字直接写；',
    '· 一个判断写一条，一条一行；它为什么成立、有没有反例、例子怎么讲开——这些留给终稿，草稿不写；',
    '· 全篇 600 字上下，最多 800 字。草稿一长，下一步就分不清哪一处是真缺口了。',
  ].join('\n')
}

/**
 * 派题（第一层）：看着**当前提问 + 草稿**，给每个命中节点派一道题。
 *
 * 2026-10-25 用户定下两条判据（不是"加一条规则"，是这一步该干的事）：
 *   ① 草稿在哪儿**不充分**（说得浅、没依据）或**孤立**（单独杵着、跟别的部分不搭）——那是要补的口子；
 *   ② 这条旧讨论能给出使用者**最切近、最熟悉**的东西（他当时认下的说法、用过的例子、认得的人和书）；
 *   题 = 用②的料补①的口子，让回答落在**当前最紧急的那一层**，而不是铺开重讲一遍。
 * 所以这一步必须同时看到提问与草稿：只拿草稿派题，派出来就是"照着草稿再研究一遍"。
 */
/**
 * 派题（第一层）：**判断「这个回答相对于提问还差哪一处」**。
 *
 * 2026-10-25 用户把这个环节的辩证法讲清楚了：
 *   草稿是**针对提问的一次回答**，不是一篇文章；它不可能答完满，
 *   而它「完满到什么程度」只能**相对于提问**来衡量（不是它自己写得好不好）。
 * 所以「可补充的部分」= **这一版回答相对于提问还缺的那一处**，不是给草稿本身添内容；
 * 材料是拿来补那一处的手段——补不上就写「无」，不派。
 */
/**
 * 每层的派题（第一层、以及往下的每一层都用它）。
 *
 * 2026-10-25 用户定下的结构：**每层都对着原始提问**，答案逐层变厚，每层一次汇总。
 *   · 第 0 层：带草稿（草稿是针对提问的一次回答）；
 *   · 第 N 层：带"上一层拿这块料干什么"（也就是上一层的题），原始提问仍然带着；
 * 判据（辩证法的说法）：草稿/上一版不可能答完满，它的完满程度只能**相对于提问**衡量；
 * 所以「可补充的」= 这一版回答相对于提问还缺的那一处，而不是给这一版添内容。
 * 材料是补那一处的手段；补不上就写「无」，这一枝不派。
 */
/**
 * 每层的派题（第 0 层与往下的每一层都用它）。
 *
 * 输入三样，缺一样都判不准：
 *   ① **原始提问**——标的，每一层都带，题必须对得起它；
 *   ② **当前层的提问**——这一层是从哪几道题往下追的（第 0 层没有，第 0 层的"题"就是草稿本身）；
 *   ③ **现在这一版回答的全文**——完满程度只能相对于提问衡量，所以要看见它。
 * 判据：这一版相对提问还缺哪一处，你手里的料能不能在那一处上补一手；补不上就写「无」。
 */
/**
 * 派题（每一层都用它）：把「原始提问 / 当前层的提问 / 本节点已经交出的那段话 / 这一层的候选」四样摆清，
 * 再给出编号的判断规则，让模型没有自主发挥的空间。
 *
 * 三条不可动摇的约定（2026-10-26 用户校准）：
 *   ① 缺口只按**原始提问**算；当前层的提问只是"本节点被要求交什么"，不能代替原始提问；
 *   ② 「能补」必须落在候选材料里**已有的那句话**上，不许要它推导、补写、拼合；
 *   ③ 补不上就写「无」，这一枝不派。
 */
/**
 * 派题（每一层都用它）。
 *
 * 2026-10-26 用户指出：模型**没有"层"的概念**，也不站在我们的流水线里看自己——
 * 跟它说"原始提问""当前层的提问""本节点"它读不懂，那只是两个陌生标签。
 * 所以这里只用它能看见的四样东西说话，且都用大白话：
 *   ① 有人问的那句话；② 这一次要办的具体一件小事（是①里的一小块）；
 *   ③ 手上这份还不完整的答案；④ 几条更早的讨论，以及它们各自已经写着的话。
 * 判据只有一句：这份答案对着①还缺哪一处，④里有没有现成的话能补上那一处。
 */
/**
 * 派题（每一层都用它）。
 *
 * 只用它看得见的四样东西说话：有人问的那句话、这一次要办的一件小事、手上这份初稿、
 * 几条更早的讨论（各自已经写着的话）。不出现"层/父节点/递归"这类它无从理解的词。
 *
 * 2026-10-26 用户要求：把它写的东西**会被怎么用**讲清楚，而不是只给禁令——
 * 写「无」的讨论这一轮完全不参与；写了题的只能交材料里已有的话，交出来的会被合并进最终回答；
 * 题超出材料 → 它只会回"这段没谈"，那一枝白问。
 */
/**
 * 派题（每一层都用它）。
 *
 * 2026-10-26 用户校准了三个标题的写法：
 *   ① 总问题——说明它在这一整轮里的**总地位**（一切判断以它为准）；
 *   ② 派生的追问——说明它**怎么从总问题派生出来**（通用逻辑：总问题有某一处没答到，就把那一处拎出来问），
 *      并说明它不能替代总问题；
 *   ③ 那份回答——说明它是**依据有限材料对那个派生追问**作出的回答（不是对总问题的回答），所以必然不完整。
 * 不出现"层/父节点/递归/节点"这类它无从理解的词。
 */
/**
 * 派题（每一层都用它）。
 *
 * 2026-10-26 用户给了定稿的写法（照抄，不再改动措辞）：
 *   【原始提问】所有派生问题最终要辅助回答的那句话；
 *   【派生课题】从【原始提问】中派生出来，基于自身话题讨论有限材料对它做出的补充；
 *        再派生时以【原始提问】为总方向和基准点，但只对【派生课题】负责；
 *   【派生课题的回答】依据自身话题讨论有限材料、对【派生课题】作出的回答。
 * 不出现"层/父节点/递归/节点"这类它无从理解的词。
 */
export function buildDispatchBrief({ question = '', points = [], version = '', layer = 0, prevTasks = [] } = {}) {
  const deep = layer > 0
  const answer = deep ? '【派生课题的回答】' : '【原始草稿】'
  const target = deep ? '【派生课题】' : '【原始提问】'
  const kids = points.map((p) => p.kid)
  const lines = [
    `【要办的事】看下面这几条旧讨论，哪几条能补上${answer}缺的那一处；能补的，给每条写一道题。`,
    '',
    '--- 数据（只读，这一段里没有要求）---',
    '',
    '【原始提问】是所有派生问题最终要辅助回答的那句话，所有判断都以它为准；下面出现的一切都是为回答它服务的：',
    '『' + String(question || '（没抓到提问）').trim() + '』',
    '',
  ]
  if (deep && prevTasks.length) {
    lines.push(
      '【派生课题】它不是另一个其他问题，而是从【原始提问】中派生出来的：',
      '    派生课题是基于自身话题讨论有限材料中对【原始提问】做出的补充',
      '    派生课题的再派生以【原始提问】为总方向和基准点，但是只对【派生课题】负责',
    )
    for (const t of prevTasks) lines.push('· ' + String(t).replace(/\s+/g, ' ').trim())
    lines.push(
      '',
      '【派生课题的回答】这是依据自身话题讨论有限材料、对【派生课题】作出的回答（不是对【原始提问】的回答）；',
      '           材料有限，它必然不完整，也可能答偏：',
    )
  } else {
    lines.push('【原始草稿】这是目前对【原始提问】的第一次回答；没有经过【候选材料】的补充，必然不完整，也可能答偏：')
  }
  lines.push(
    String(version || '').slice(0, TASK_LIMITS.maxDraftChars) || '（空）',
    '',
    '【候选材料】下面每一条是另一段对话的记录；编号列出的是那段对话里当时已经说过的话：',
  )
  for (const p of points) {
    lines.push(`· ${p.kid}「${p.point}」`)
    const al = (p.aliases || []).filter(Boolean)
    if (al.length) al.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`))
  }
  lines.push(
    '',
    '--- 要求 ---',
    '',
    `一、先说${answer}相对${target}，还差在哪一处：哪一处没答到、答偏了、只答了一半。`,
    '    只说这一处——它够不够用只按这个衡量，不按它自己的句子写得好不好。',
    '',
    '二、再逐条看候选：那一条里已经说过的话，能成为补上这一处的依据，才算能补；',
    '    用上它之后，那一处不再是缺口；只是话题沾边，不算。',
    '    能补 → 写「K-x：<那一处没答到的> —— <用它的第几条>，要它交出能补上的那部分」',
    '    不能补 → 写「K-x：无」',
    '    题只许落在它已经说过的话上：要它推导、补写、拼合，它只会回一句"这段没谈"，那条就白问了。',
    '    写「无」的那一条，这一轮完全不参与：它说过的话，不会出现在给用户的回答里。',
    '',
    '--- 例子（下面的编号和话题都是假的，只看格式）---',
    '',
    '假设缺的一处是"没说这道菜是哪里来的"，候选有两条：',
    'K-1：没说这道菜是哪里来的 —— 第 1 条，要它交出当时讲这道菜来历的那段',
    'K-2：无',
    '（例子结束）',
    '',
    '--- 输出 ---',
    '',
    `下面是这一轮的材料，每条材料占一行，顺序照上面，共 ${kids.length} 行，不要别的内容：`,
    ...kids.map((k) => `${k}：`),
  )
  return lines.join('\n')
}

/**
 * 从派题输出里取出「K-x：题」：Map<kid, 题>。
 * 值：非空 = 题；空串 = 这块料明确说「无」（不派）；键不存在 = 没解析出来（同样不派）。
 */
export function parseDraftTasks(text, kids = []) {
  const allowed = new Set(kids)
  const out = new Map()
  const raw = String(text || '')
  const at = raw.search(/【课题】|\[课题\]|派题/)
  const zone = at >= 0 ? raw.slice(at) : raw
  for (const line of zone.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*·•]?\s*(K-\d+(?:\.\d+)*)\s*[:：]\s*(.+)$/)
    if (!m || !allowed.has(m[1])) continue
    const q = m[2].trim()
    if (!q || q.startsWith('<')) continue
    out.set(m[1], /^(无|没有|不需要|none)$/i.test(q) ? '' : q)
  }
  return out
}
/**
 * 解析草稿的方向分段。认不出【方向：】标记时 directions 为空，raw 仍然可用
 * （R4 直接整合 raw；报告只用于补内容，不会因为解析不出方向就丢）。
 */
export function parseDraft(text) {
  const raw = String(text || '').trim()
  const re = /^【方向[:：]\s*(.+?)】\s*$/gm
  const marks = [...raw.matchAll(re)]
  const directions = marks.map((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length
    return { name: m[1].trim(), body: raw.slice(start, end).trim() }
  })
  return { raw, directions }
}

// ── R2 课题报告（交付登记）────────────────────────────────────────────────────
/**
 * R2 的规矩：一篇，不是规则清单。
 *   · 交付是**一段话**（成果 / 到哪儿为止 / 还没定下什么 / 当时态度），不是 JSON、不是四行字段——
 *     推理模型会把长 JSON 从字符串中间截断，而 finish_reason 仍然报 stop（2026-10-24 实测三次）。
 *   · 材料在前（同一段的字节固定，重试时前缀不变），题与要求在后（模型对最后一段更敏感）；
 *     开头先说一次要办的事，两头各一次（Azure 的「Double down」）。
 *   · 末尾给一个与本题无关的形状例子：这套调用关思考（非推理档），例子比形容词更能钉住格式。
 */
function brief({ task, askedBy = '' }) {
  const who = askedBy
    ? askedBy + ' 给这条旧讨论派了一道题，要你交出的是：'
    : '这一轮给这条旧讨论派了一道题，要你交出的是：'
  return [
    '【任务】' + who,
    '给你的题：『' + String(task || '（没给题）').trim() + '』',
    '',
    '你是这条旧讨论的登记员：只登记它当时交付了什么，不分析、不评价、不往下判断。',
    '',
    '先判一件事：正文里有没有一句直接谈这道题的？',
    '· 有：从正文写起，写成一段话（不分点、不列条）：当时交付了什么、到什么程度；到哪儿为止（什么情况下不成立、没涉及什么）；相对它还没定下什么；你当时的态度（接受／追问／抗拒／回避）。相关的内容少，就把话放在「只知道这些」和态度上。',
    '· 没有：第一行只写「拒绝：这段当时谈的是<…>」，然后停笔，不要勉强交付。',
    '',
    '原话不加引号、也不写成"他说过……"；把当时那句话的意思复述出来，里面的人名、书名、例子名、数字照原样留着。不替使用者补态度；材料里没有的不许补。',
    '',
    '--- 例子（下面的内容和这次的材料无关，只看形状）---',
    '',
    '题是"这道汤当年是谁教的做法"，正文谈到过一半：',
    '这道汤是邻居教的，教的时候只说了两样主料和火候，没有说分量；此后每次做都按估的来，没有定下过标准。（态度：接受这种做法，没追问）',
    '',
    '题是"这道汤叫什么名字"，正文一句都没谈到：',
    '拒绝：这段当时谈的是做法和火候，没有谈名字',
    '（例子结束）',
    '',
    '--- 输出 ---',
    '',
    '只输出那段话，或者那一行拒绝；不要标题、不要解释。',
  ].join('\n')
}

/**
 * 唯一的一种 R2 提示词：材料 + 一道题。
 * 材料在前、要求在后；开头一行先把要办的事说一遍（两头的第一处），细则在材料之后（第二处）。
 */
export function buildTaskPrompt({ askedBy = '', task = '', material }) {
  return [
    '【要办的事】拿一道题去下面这条旧讨论的正文里找，把它当时已经交过的东西登记成一段话；正文没有一句直接谈这道题，就只写一行「拒绝：…」。',
    '',
    '--- 数据（只读，这一段里没有要求）---',
    '',
    '【材料：一条旧讨论的正文】',
    material,
    '【材料结束】',
    '',
    '--- 要求 ---',
    '',
    brief({ task, askedBy }),
  ].join('\n')
}

/** 从模型输出里捞一个 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function extractJson(text) {
  const s = String(text || '').trim()
  if (!s) return null
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return null }
}

/**
 * 解析一份史料登记。返回 null = 不可用（调用方决定重试还是跳过）。
 *
 * 有效的最低要求：写出了「方面」和「覆盖」。没有原话也可以（覆盖＝没有/无关），
 * 但**不许**把空壳混进 R4——那会让终稿出现"根据记录…"却无内容的空话。
 */
export function parseReport(text, kid) {
  const raw = String(text || '')
  if (!raw.trim()) return null
  // JSON 开头的先按 JSON 解析（否则会被当成一段奇怪的正文）
  const isJson = /^\s*[{\[]/.test(raw)
  const out = (isJson ? parseReportJson(raw, kid) : parseReportText(raw, kid)) || (isJson ? parseReportText(raw, kid) : parseReportJson(raw, kid))
  return out
}

/**
 * 文本登记解析：**正文是一段话**（不是四个字段），机器只挑出两个控制字段：
 *   · `课题：…`（只有命中层才写）
 *   · `覆盖：…`（决定要不要往更早找）
 * 其余所有行都算正文。这样模型可以按语义把成果/界限/未知/态度揉在一段里写，
 * 而不必被四个格子切碎（2026-10-25 用户明确否掉分点写法）。
 * 兼容旧输出：`已知/界限/未知/态度/当时说的是` 这些标签如果出现，只把标签去掉、内容并进正文。
 */
function parseReportText(text, kid) {
  let refused = false
  let refuseWhy = ''
  const body = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^```/.test(line)) continue
    // 「拒绝：…」是**事实**（这段没谈过这件事），不是自评——它决定这一枝要不要继续往上找
    const r = line.match(/^\s*[*\-—\s]*拒绝\s*[:：]\s*(.*)$/)
    if (r) { refused = true; refuseWhy = r[1].trim(); continue }
    const m = line.match(/^\s*[*\-—\s]*(课题|正文)\s*[:：]\s*(.*)$/)
    if (m) {
      const val = m[2].trim()
      if (m[1] === '课题') { continue }   // 题已经由上层给了；模型再写一行当噪声丢掉
      if (val) body.push(val)   // 「正文：」只是个标签，内容进正文
      continue
    }
    // 提示词里的规矩（边界/注意/要求/格式…）不是正文，别让它混进来
    if (/^\s*[*\-—\s]*(边界|注意|说明|要求|格式)\s*[:：]/.test(line)) continue
    body.push(line)
  }
  const prose = noneToEmpty(stripQuotes(body.join(' ').replace(/\s{2,}/g, ' ').trim()))
  // 既没正文也没拒绝 → 不可用（模型跑偏了，重试）
  // 太短的空话不算交付（模型跑偏时常常先吐一句"我不太确定…"）
  if (!refused && prose.length < 20) return null
  if (!prose && !refused) return null
  return {
    kid,
    body: prose,
    refused,
    refuseWhy,
  }
}

/** 兼容 JSON（换协议之前的老输出、以及别的模型） */
function parseReportJson(text, kid) {
  const obj = extractJson(text)
  if (!obj || typeof obj !== 'object') return null
  const body = noneToEmpty(stripQuotes(String(obj['正文'] ?? obj.body ?? '').trim()))
  const refuseWhy = String(obj['拒绝'] ?? obj.refusal ?? '').trim()
  if (!body && !refuseWhy) return null
  return {
    kid: String(obj['课题'] || kid || '').trim() || kid,
    body,
    refused: !!refuseWhy,
    refuseWhy,
  }
}


const stripQuotes = (s) => String(s || '').trim().replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim()
const noneToEmpty = (s) => (/^(无|没有|none|-—)$/i.test(String(s || '').trim()) ? '' : String(s || '').trim())
// ── 报告解析 ────────────────────────────────────────────────────────────────

// ── R4 汇总 ────────────────────────────────────────────────────────────────

/**
 * 中间层汇总（回归时用）：把「本节点交出的那段话」和「更早的讨论回来那几段」合成一段**中转记录**。
 *
 * 与 R4 的区别（2026-10-26 用户定）：
 *   · R4 是写给用户看的回答（要相处规则、要判断、要例子）；
 *   · 这里只是往上一层交的中转记录——写短，留要点、边界、还没定下的东西，**不是回答**。
 * 之前复用 R4 的提示词，模型按"写答案"的标准写了 2,286 字、花 37 秒。
 */
export function buildMergeMessage({ own = '', kids = [] } = {}) {
  const lines = [
    '【要办的事】把下面两块内容并成一段中转记录——它不是回答，是给下一步当材料用的东西。',
    '',
    '--- 数据（只读，这一段里没有要求）---',
    '',
    '【本节点交出的那段话】',
    String(own || '（空）').trim(),
    '',
    '【更早的讨论回来这几段】',
  ]
  if (!kids.length) lines.push('（没有回来的东西）')
  for (const k of kids) {
    lines.push('· ' + k.kid)
    lines.push('  ' + String(k.summary || '').trim())
  }
  lines.push(
    '',
    '--- 要求 ---',
    '',
    '· 写短：只留各自的成果、到哪儿为止、还没定下什么，不重讲它的论证；',
    '· 几段说的是同一件事，并成一处，写明是哪几块并的；',
    '· 说不到一起、甚至打架的，分别写清各自怎么说、差在哪一点，不要给它们找共同说法；',
    '· 不称呼读者，不做总结式收尾。',
    '',
    '--- 例子（下面的内容和这次无关，只看形状）---',
    '',
    '两段回来，一段说"名单留不下来"，一段说"人凑不齐"，并成：',
    '名单这一件事有两层：人少的时候连名单都留不下来，人多的时候又凑不齐；两段都停在这儿，谁也没说清名单本来是为了什么。',
    '（例子结束）',
    '',
    '--- 输出 ---',
    '',
    '直接输出这一段，不要写"合并如下"之类的话。',
  )
  return lines.join('\n')
}

/**
 * 终稿的输入：**一次真正的回答**，不是把草稿和史料并在一起。
 *
 * 2026-10-26 用户定：草稿关思考之后只有骨架（判断、无论证、无具体的人名年份），
 * 所以终稿不能只当"汇总"——它得把骨架当场想清楚、用具体的东西落地。这里的三块因此各换了身份：
 *   草稿 = 这一轮先列出来的判断清单（骨架）
 *   史料 = 那次讨论的状态（归纳，不是原话）
 *   回答 = 由终稿现写，历史里有的用历史，没有的标明是判断。
 */
export function buildAggregateMessage({ draft, reports = [] }) {
  const raw = String(draft?.raw || '').trim()
  const lines = [
    '【草稿骨架】（这一轮内部先列出来的判断清单：只有判断，没有论证、没有展开；用户看不到它，也不会读它）',
    raw || '（无草稿）',
    '',
    '【史料记录】（每条都是一段话，写那次讨论的**状态**：得出了什么、到哪儿为止、还没定什么、你当时什么态度；都是归纳，不是口头原话）',
  ]
  if (!reports.length) lines.push('（这一轮没登记到史料：按骨架写，别假装记得旧讨论）')
  for (const r of reports) {
    lines.push(`· ${r.kid}｜题：${r.task || '（没给题）'}`)
    if (r.body) lines.push(`  ${r.body}`)
  }
  lines.push(
    '',
    '【这次要写的是回答，不是汇总】',
    '① 骨架上的每一条判断，你都要当场想清楚它凭什么成立、落在哪个具体的人／书／例子／数字上——历史里有的用历史，没有的用你自己知道的写，但要让人听得出那是判断，不是旧讨论说过的；',
    '② 用户问到的每一面，只要史料支撑得住，就要在回答里出现；但**不要写成栏目或清单**——按【相处规则】的说话方式把它讲出来；',
    '③ 史料记录是归纳，引用它的内容可以，但**不许加引号当成他说过的原话**；记录里没有的旧讨论内容，一个字都不许补；',
    '④ 旧讨论的推进停在哪，你要接着往前走——**新的推进由你来做**；但要说得出哪句是旧讨论里的说法（已归纳）、哪句是你现在的判断，不许把新判断说成"我们当时说过"；',
    '⑤ 直接输出正文，不要写"根据史料记录""综合以上"，不要输出 JSON、也不要写"以下是回答"；**说话方式以【相处规则】为准**（直接给判断、例子落地、结尾别强行延伸、代词说清是谁）。',
  )
  return lines.join('\n')
}

/** 去掉空白与标点，取三元组集合（中文按字切）。 */
function trigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '')
  const set = new Set()
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3))
  return set
}

/**
 * 终稿对某条报告的"覆盖度" = 报告结论的三元组有多少比例出现在终稿里。
 *
 * ⚠️ 这是**代理指标**，不是语义判定：模型整合时几乎不会照抄原句，只按字面查"依据是否出现"
 * 会把它读成 100% 丢弃。所以设计里说的"取一个特征短语，检查是否出现在终稿"在这里落成
 * 三元组重叠率，并把**数值**打进日志——阈值可以拿真实数据回看再调，别把它当判决。
 */
export function coverageRatio(finalText, reportText) {
  const want = trigrams(reportText)
  if (!want.size) return 1
  const got = trigrams(finalText)
  let n = 0
  for (const g of want) if (got.has(g)) n++
  return n / want.size
}

/**
 * 检查每条报告有没有被整合（阈值以下算"疑似丢弃"）。只记录，不阻断、不改写终稿。
 * @returns {{dropped: Array<{kid:string, ratio:number}>, ratios: Array<{kid:string, ratio:number}>}}
 */
export function checkCoverage(finalText, reports, { threshold = 0.2 } = {}) {
  const ratios = []
  for (const r of reports) {
    if (!r || r.refused) continue
    const text = r.body || ''
    if (!text) continue
    ratios.push({ kid: r.kid, ratio: coverageRatio(finalText, text) })
  }
  return { ratios, dropped: ratios.filter((x) => x.ratio < threshold) }
}

// ── 流水线 ─────────────────────────────────────────────────────────────────
/**
 * 跑一轮：R1 → 派课题 → 逐层判父 + R2 → R4（流式）。
 *
 * deps：
 *   hist / persona / anchored   本轮 messages 的三段（与旧路径同一套语义）
 *   hits                        本轮**新命中**的节点 id（栈内旧引用不触发，见设计 §2.3）
 *   nodeOf(id) / parentsOf(id)  图查询（parentsOf = user 入边的 from）
 *   complete({kind, system, messages, maxTokens, temperature}) → Promise<string>
 *   stream({kind, messages})   → AsyncGenerator<{chunk, accumulated}>
 *   fallback()                 → AsyncGenerator（可省）：R1 失败时退回"整段来路注入"的旧路径
 *   judgeSystem                 判定纪律那一段（②③⑤ 用；身份由本模块自己追加，R1/R4 用默认阅读助手 system）
 *   checkStop()                 用户点停止时抛错（R1~R3 之间也要能停）
 *   log(msg)                    控制台留痕
 *   onEvent(evt)                全过程事件（调试用；形状见 lib/l3-trace.js）。抛错会被吃掉，
 *                               绝不因为"记录写不进去"影响这一轮回答。
 *
 * 生成器 yield 出来的形状与 callLLMStream 一致（{chunk, accumulated}），say() 原样消费；
 * return 值 = 终稿全文。
 */
export async function* runTasksPipeline(deps = {}) {
  const {
    hist = [], persona = '', anchored = '',
    // 当前提问 = 用户这一轮真的问的那句（**不是**节点里那条旧问题）。整套课题都锚在它上面。
    question: curQuestion = '',
    hits = [], nodeOf = () => null, parentsOf = () => [],
    complete, stream, judgeSystem = '', checkStop = () => {}, log = () => ({}),
    fallback = null, onEvent = () => {}, onRefusal = null, opts = {},
  } = deps
  if (typeof complete !== 'function') throw new TypeError('runTasksPipeline: 缺少 deps.complete')
  if (typeof stream !== 'function') throw new TypeError('runTasksPipeline: 缺少 deps.stream')

  /** 记一笔全过程事件（调试记录）。抛错就地吃掉：记录不该影响回答。 */
  const emit = (evt) => { try { onEvent(evt) } catch {} }

  const lim = { ...TASK_LIMITS, ...(opts || {}) }
  const t0 = Date.now()
  const spent = { calls: 0, chars: 0 }
  /** 兜底闸：返回空串 = 还能花；返回原因 = 到顶了（先到先停）。 */
  const budget = () => {
    if (spent.calls >= lim.maxCalls) return `调用数 ${spent.calls}/${lim.maxCalls}`
    if (spent.chars * lim.tokenPerChar >= lim.maxTokens) return `材料约 ${Math.round(spent.chars * lim.tokenPerChar)}/${lim.maxTokens} token`
    if (Date.now() - t0 >= lim.maxMs) return `耗时 ${Date.now() - t0}/${lim.maxMs}ms`
    return ''
  }

  /** 把一次流式调用原样转发出去（R4 / 无命中的普通回复共用）。 */
  async function* relay(messages) {
    let out = ''
    for await (const piece of stream({ kind: '主回复', messages })) {
      if (piece && piece.accumulated) out = piece.accumulated
      yield piece
    }
    return out
  }

  /** 降级：整条流水线走不下去时，退回"整段来路注入"的旧路径——引用轮不能没有答案。 */
  async function* degraded(reason) {
    if (typeof fallback !== 'function') throw new Error(`${reason}（且没有兜底可用）`)
    emit({ type: 'fallback', reason })
    log(`${reason} → 退回旧的整段注入（这一轮照样有答案）`)
    let full = ''
    for await (const piece of fallback()) {
      if (piece && piece.accumulated) full = piece.accumulated
      yield piece
    }
    emit({ type: 'final', text: full, coverage: [], note: '兜底：这一轮走的是旧的整段注入（不是命题递归）' })
    return full
  }

  // ── R1：草稿（用户看不到）──
  checkStop()
  // 先过滤再编号：命中 id 可能来自已删节点，先剔掉，免得课题号出现"没有 K-1 的 K-2"
  const live = []
  for (const id of new Set(hits)) {
    const node = nodeOf(id)
    // 别名要一起带上：它写着"这块料是什么、能用它回答什么"，是出题的判断依据（2026-10-25 用户定：全给）
    if (node) live.push({ id, point: String(node.point || '').trim(), aliases: (node.aliases || []).filter(Boolean) })
  }
  const points = live.map((h, i) => ({ ...h, kid: `K-${i + 1}` }))
  if (!points.length) {
    // 命中 id 全都不在图上了（节点被清理/手改图）：别为一件不存在的事跑两步，
    // 也别退回"整段来路"——那会把栈里那 47k 又发一遍。直接一次普通回复。
    log('命中节点都不在图上 → 按普通回复处理（不带 L3，不派课题）')
    emit({ type: 'note', text: '命中节点都不在图上了 → 按普通回复处理（不带 L3，不派课题）' })
    const plain = yield* relay([...hist, { role: 'user', content: persona }, { role: 'user', content: anchored }])
    emit({ type: 'final', text: plain, coverage: [], note: '本轮没有可用的命中节点' })
    return plain
  }
  if (points.length > 3) log(`命中 ${points.length} 个（设计：超过 3 个只记日志，不做硬截断）`)

  let draftRaw = ''
  const tDraft = Date.now()
  try {
    draftRaw = await complete({
      kind: '课题草稿',
      messages: [
        ...hist,
        { role: 'user', content: persona },
        { role: 'user', content: buildDraftBrief() },
        { role: 'user', content: anchored },
      ],
      // 2026-10-26 用户定：草稿**不思考**。它是判断清单，不是回答；
      // 实测同一份输入：开思考 25.5s / 1,025 字（附日期、法规、数额），关思考 4.9s / 621 字（只剩骨架）。
      // 具体的人名年份不靠它兜——它是内部清单，具体的东西由终稿现写。
      contentOnly: true, thinking: false,
      maxTokens: lim.draftTokens,
    })
  } catch (e) {
    return yield* degraded(`R1 草稿失败：${e.message}`)
  }
  if (!String(draftRaw || '').trim()) return yield* degraded('R1 草稿是空的')
  const draft = parseDraft(draftRaw)
  log(`R1 草稿 ${draft.raw.length} 字 / ${draft.directions.length} 个方向${draft.directions.length ? '：' + draft.directions.map((d) => d.name).join('、') : ''}`)
  emit({
    type: 'draft', raw: draft.raw, chars: draft.raw.length,
    directions: draft.directions.map((d) => d.name), ms: Date.now() - tDraft,
  })
  emit({ type: 'section', text: '② 命题递归（子节点点题 → 父节点作答）' })

  // ── 递归：一个节点先交付，再给父节点派题，等父节点"回归"后逐层汇总往回交 ──────
  const initial = draft.raw
  const reports = []
  const mismatches = []
  const refusals = []
  const expanded = new Set(points.map((p) => p.id))
  const kidSeq = new Map()
  let full = ''
  let streamed = false

  let gateEmitted = false
  let tripped = ''
  const callOnce = async (o) => {
    tripped = budget()
    if (tripped) {
      if (!gateEmitted) { gateEmitted = true; emit({ type: 'gate', reason: tripped }) }
      return null
    }
    spent.calls++
    return complete(o)
  }

  const readReport = async (prompt, kid, materialChars) => {
    spent.chars += materialChars
    for (let attempt = 1; attempt <= 2; attempt++) {
      let out = null
      try {
        out = await callOnce({
          kind: '课题报告',
          system: asSystem(judgeSystem, ROLE_REPORT),
          contentOnly: true, thinking: false,
          messages: [{ role: 'user', content: attempt === 1 ? prompt : prompt + '\n\n（上一次的输出不是合法登记，这次按「一段正文」或「拒绝：…」输出，不要写别的。）' }],
          maxTokens: lim.reportTokens,
          temperature: 0,
        })
      } catch (e) {
        log(`R2 ${kid} 调用失败：${e.message}`)
        return { reason: `调用失败：${e.message}` }
      }
      if (out == null) return { reason: `兜底闸：${tripped || '到顶了'}` }
      const rep = parseReport(out, kid)
      if (rep) return { report: rep }
      log(`R2 ${kid} 输出不是合法登记（第 ${attempt} 次）：${String(out).replace(/\s+/g, ' ').slice(0, 80)}`)
    }
    return { reason: '两次输出都不合格式（既没有一段正文，也没有「拒绝：」）' }
  }

  /** 回归汇总的输入：本节点交出的那段话 + 各父节点回来的一段话 */
  const aggregateInput = (kid, own, kids, depth) => {
    const reps = kids.filter((k) => k.summary).map((k) => ({ kid: k.kid, task: '（那一支回归上来的结果）', body: k.summary }))
    const agg = buildAggregateMessage({ draft: { raw: own }, reports: reps })
    emit({ type: 'aggregate', kid, depth, message: agg })
    return [...hist, { role: 'user', content: persona }, { role: 'user', content: agg }, { role: 'user', content: anchored }]
  }

  const nextKid = (parentKid) => {
    const n = (kidSeq.get(parentKid) || 0) + 1
    kidSeq.set(parentKid, n)
    return parentKid + '.' + n
  }

  /** 派题（往下）：输入 = 原始提问 + 本节点这一层的题 + **本节点交出来的那段话** + 各父节点(point+别名) */
  const dispatchDown = async ({ kid, taskText, body, candidates, depth }) => {
    checkStop()
    const t = Date.now()
    try {
      const out = await callOnce({
        kind: '课题派题',
        system: asSystem(judgeSystem, ROLE_DISPATCH),
        contentOnly: true, thinking: false,
        messages: [{
          role: 'user',
          content: buildDispatchBrief({
            question: curQuestion,
            points: candidates,
            version: body,
            layer: depth,
            prevTasks: [taskText],
          }),
        }],
        maxTokens: lim.askTokens,
        temperature: 0,
      })
      if (out == null) { log(`${kid} 派题：兜底闸（${tripped}）`); return new Map() }
      const tasks = parseDraftTasks(out, candidates.map((c) => c.kid))
      const brief = [...tasks].map(([k, v]) => k + ':' + (v ? '有题' : '用不上')).join('、')
      log(`${kid} 派题 → ${tasks.size}/${candidates.length}${tasks.size ? '（' + brief + '）' : '（没派出来）'}｜${((Date.now() - t) / 1000).toFixed(1)}s`)
      emit({ type: 'dispatch', kid, depth, ms: Date.now() - t, tasks: [...tasks].map(([k, task]) => ({ kid: k, task })), raw: String(out || '').trim().slice(0, 600) })
      return tasks
    } catch (e) {
      log(`${kid} 派题失败：${e.message}（这一层不再往下）`)
      emit({ type: 'note', text: `${kid} 派题失败：${e.message}` })
      return new Map()
    }
  }

  /**
   * 回归汇总：本节点自己的交付 + 各父节点回来的结果 → 交给上一层。
   *
   * 2026-10-26 用户定（方案 B）：这次调用只喂**要并的那几段**——不喂历史、画像/相处规则、本轮提问，
   * system 换成判定那一句。理由：它的产物是给程序用的中转记录，不是回答；带满上下文时它会按
   * "在回答这一轮"来写（实测 2,286 字 / 37 秒），而且它读到的最后一段正是本轮提问，等于在催它作答。
   */
  const aggregateUp = async ({ kid, own, kids, depth }) => {
    const t = Date.now()
    try {
      const merged = buildMergeMessage({ own, kids })
      emit({ type: 'aggregate', kid, depth, message: merged })
      const out = await complete({
        kind: '课题汇总',
        system: asSystem(judgeSystem, ROLE_MERGE),
        messages: [{ role: 'user', content: merged }],
        // 预算必须自己给：以前这三行没写 maxTokens，线上就落到兜底的 1024，
        // 思考写掉 2,847 字、正文一个字没出来（2026-10-26 实跑）。contentOnly 是同一件事的另一半：
        // 正文空时绝不许把思考链当中转记录往上传。
        maxTokens: lim.reportTokens,
        contentOnly: true,
      })
      const txt = String(out || '').trim()
      log(`${kid} 汇总：${txt.length} 字（回归层，不流给用户，${((Date.now() - t) / 1000).toFixed(1)}s）`)
      // 汇总也记一条 report 事件，脑图上看得到"这一层往上交了什么"
      emit({ type: 'report', kid, point: '', depth, task: '（回归汇总）', body: txt, refused: false, merged: kids.map((k) => k.kid), ms: Date.now() - t })
      return txt
    } catch (e) {
      log(`${kid} 汇总失败：${e.message}（直接把交付往上传）`)
      return own
    }
  }

  /**
   * 递归主体。返回 { kid, summary, reports }
   *   ① 交付（R2）
   *   ② 到深度上限 / 拒绝 / 没有未访问的父节点 → 直接把交付交上去
   *   ③ 否则：派题给父节点 → 递归 → 回归汇总（自己的交付 + 父节点回来的结果）
   *
   * visitInner 只负责跑；外面那层 `visit` 顺手记一件事：**哪些来路节点最终成功上报了**
   * （summary 非空、depth ≥ 1）。这一组 id 会以 live 事件发出去，下一轮可能继承它们重跑
   * ——见 lib/l3-live.js 的说明。
   */
  const liveUp = new Set()
  const visit = async (args) => {
    const r = await visitInner(args)
    if ((args.depth || 0) >= 1 && r.summary) liveUp.add(args.id)
    return r
  }
  const visitInner = async ({ kid, id, point, aliases, depth, askedBy, taskText }) => {
    const node = nodeOf(id)
    if (!node) return { kid, summary: '', reports: [] }
    const material = buildMaterials(node)
    const prompt = buildTaskPrompt({ askedBy: depth === 0 ? '' : (askedBy || ''), task: taskText, material })
    const t1 = Date.now()
    const got = await readReport(prompt, kid, material.length)
    const materialChars = material.length
    const truncated = /（材料过长已截断/.test(material)
    if (!got.report) {
      emit({ type: 'report', ok: false, reason: got.reason, kid, point, depth, task: taskText, askedBy: askedBy || '', materialChars, truncated, ms: Date.now() - t1 })
      return { kid, summary: '', reports: [] }
    }
    const mine = { ...got.report, task: taskText }
    reports.push(mine)
    log(`R2 ${kid}｜${mine.refused ? '拒绝交付' : '交付 ' + String(mine.body || '').length + ' 字'}｜题：${String(taskText).slice(0, 36)}`)
    emit({
      type: 'report', kid, point, depth, task: taskText, askedBy: askedBy || '',
      taskFrom: depth === 0 ? 'R1' : (askedBy || ''),
      materialChars, truncated, ms: Date.now() - t1,
      material, materialPreview: material.slice(0, 300),
      body: mine.body, refused: !!mine.refused, refuseWhy: mine.refuseWhy || '',
      aliases: aliases || [],
    })
    if (mine.refused) {
      const r = { kid, nodeId: id, point, aliases: aliases || [], why: mine.refuseWhy || '', question: taskText || '', depth }
      refusals.push(r)
      if (typeof onRefusal === 'function') { try { onRefusal(r) } catch {} }
      mismatches.push(kid)
      emit({ type: 'mismatch', kid, askedBy: askedBy || '', task: taskText, point: point || '', body: mine.body || '' })
      return { kid, summary: '', reports: [mine] }
    }

    const own = String(mine.body || '').trim()
    if (depth >= lim.maxDepth) return { kid, summary: own, reports: [mine] }

    const candidates = []
    for (const pid of (parentsOf(id) || [])) {
      if (!pid || expanded.has(pid)) continue
      const n = nodeOf(pid)
      if (!n) continue
      candidates.push({ kid: nextKid(kid), id: pid, point: String(n.point || '').trim(), aliases: (n.aliases || []).filter(Boolean), depth: depth + 1, askedBy: kid })
    }
    if (!candidates.length) return { kid, summary: own, reports: [mine] }

    const tasks = await dispatchDown({ kid, taskText, body: own, candidates, depth })
    const kids = []
    for (const c of candidates) {
      const t = tasks.get(c.kid)
      if (!t) {
        // 明确写「无」、或压根没解析出来 → 这一轮不派，不拿提问硬问
        emit({ type: 'ask', kid: c.kid, depth: c.depth, skipped: '用不上' })
        continue
      }
      expanded.add(c.id)
      kids.push(await visit({ ...c, taskText: t }))
    }
    const withSummary = kids.filter((k) => k.summary)
    // 孩子全拒/全空：没有可合并的东西，别白跑一次汇总（实测这一跑要 37 秒）
    if (!withSummary.length) {
      log(`${kid} 没有可合并的回归（孩子都没交）→ 直接把自己的交付往上传`)
      return { kid, summary: own, reports: [mine, ...kids.flatMap((k) => k.reports)] }
    }

    const summary = await aggregateUp({ kid, own, kids: withSummary, depth })
    return { kid, summary: summary || own, reports: [mine, ...kids.flatMap((k) => k.reports)] }
  }

  // 顶层：草稿 → 派题（命中层）→ 每个命中递归 → 终稿汇总（草稿 + 各命中回来的汇总）
  const firstT = await dispatchDown({ kid: '草稿', taskText: '', body: initial, candidates: points.map((p) => ({ ...p, depth: 0, askedBy: '' })), depth: 0 })
  const tops = []
  for (const p of points) {
    const t = firstT.get(p.kid)
    if (!t) {
      emit({ type: 'ask', kid: p.kid, depth: 0, skipped: '用不上' })
      continue
    }
    expanded.add(p.id)
    tops.push(await visit({ kid: p.kid, id: p.id, point: p.point, aliases: p.aliases, depth: 0, askedBy: '', taskText: t }))
  }

  const finalReports = tops.filter((x) => x.summary).map((x) => ({ kid: x.kid, task: '', body: x.summary }))
  full = yield* relay([
    ...hist,
    { role: 'user', content: persona },
    { role: 'user', content: buildAggregateMessage({ draft: { raw: initial }, reports: finalReports }) },
    { role: 'user', content: anchored },
  ])
  streamed = true
  log(`终稿 ${full.length} 字（草稿 + ${finalReports.length} 份回归汇总）`)
  emit({ type: 'final', text: full, coverage: [], ...(lim.finalLabel ? { label: lim.finalLabel } : {}), ...(lim.finalShown === false ? { shown: false } : {}) })

  if (tripped) log(`探索阶段触发兜底闸：${tripped}（还有枝想问下去也停了，属正常保护）`)

  // 这一轮「成功上报的来路节点」交出去（index.js 会把它记成下一轮可继承的清单）。
  // 只记 depth ≥ 1 的（父节点）：命中节点本身每轮都由引用解析重新决定要不要跑。
  if (liveUp.size) log(`本轮有效来路 ${liveUp.size} 个：${[...liveUp].join('、')}（下一轮同栈继续时可继承）`)
  emit({ type: 'live', nodes: [...liveUp] })

  const kept = reports.filter((r) => !r.refused)
  const cov = checkCoverage(full, kept)
  log(`终稿 ${full.length} 字｜登记 ${reports.length} 份（拒绝 ${refusals.length}）｜疑似丢弃 ${cov.dropped.length}`)
  emit({
    type: 'stats',
    text: `命中 ${points.length} 个｜探索调用 ${spent.calls} 次（材料约 ${Math.round(spent.chars * lim.tokenPerChar)} token）`
      + `｜登记 ${reports.length} 份｜全程 ${((Date.now() - t0) / 1000).toFixed(1)}s`
      + (mismatches.length ? `｜⚠️ 概述与正文不一致 ${mismatches.length} 个` : '')
      + (refusals.length ? `｜🛑 拒绝交付 ${refusals.length} 个` : ''),
  })

  return full
}
