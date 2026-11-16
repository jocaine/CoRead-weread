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
 *   R1 草稿：全历史 + 本轮问题 + 画像（不看命中标题）→ 内部工作稿（总判断 → 几步 → 收口），用户看不到
 *   R2 课题：一个节点一个课题，单独一次小调用读该节点原话 → 固定字段的报告
 *   R3 判父：每个分支每层一次，判"更早那层值不值得追"；判否 → 整枝结束，一次调用都不再花
 *   R4 终稿：草稿 + 全部报告 → **一整篇回答**，流式，是用户唯一看到的东西（不是"把两块并起来"的汇总）
 *
 * 关键约束：
 * - 材料与报告只活在这一轮，**不进历史**（进了历史就又变成"每轮重发"的老毛病）。
 * - R2 不重写草稿，只交报告——草稿全程只被 R4 改一次，避免"每补一次就重写一遍"的损耗。
 * - 本模块不碰 fs / graph / LLM SDK：节点与边由 deps 注入，调用由 deps.complete / deps.stream
 *   注入。所以它可以在测试里用假模型跑完整条流水线（见 test/l3-tasks.test.js）。
 */

/**
 * 取回粒度与各类预算（设计 §4/§5）。
 *
 * 2026-10-26 用户定：**不要兜底闸**。原来那三道（探索调用数 10、材料约 6 万 token、墙钟 120 秒）
 * 一律删掉——"该不该再追"只由派题判，不由程序数着花销替你喊停。
 * 保留下来的是每次调用各自的 maxTokens（那是单次生成的预算，不是整轮的上限）。
 */
export const TASK_LIMITS = {
  maxDepth: 2,             // 来路最多追几层（命中 = 0 层）；每层一次汇总。
                            // 2026-10-26 用户定：1 → 2，即"命中 + 父 + 祖父"都能读。
                            // 注意它和跨轮继承叠加：继承来的节点本轮按 0 层算，所以每轮只往后退
                            // 一层，而跨轮可以一直往后退——maxDepth 管的是"一轮之内退几层"。
  // 2026-10-25 用户定：**材料绝不截取**——截了模型就真看不见，问它“当时谈过什么”就变成猜。
  maxExcerptChars: Infinity,
  maxDraftChars: 3000,     // 送进派题的草稿/交付上限（草稿本身就该短）
  // 推理型模型的"思考"也算进 max_tokens：实测一次课题的思考能写到 3,000 字（≈2,300 token），
  // 给 1024 时正文一个字都出不来（还会以 finish=stop 收尾，看起来像成功了）
  draftTokens: 4096,
  reportTokens: 4096,
  askTokens: 6144,         // 派题：要它读完几个候选的标题+别名、再当场写题，思考更长
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
 * 2026-10-29 用户定：**不再列命中节点的标题**——派题那一步自己看候选目录；R1 只写骨架，
 * 不提前知道"手边有哪些旧讨论"，免得草稿被候选标题带着走。
 *
 * 2026-10-26：**只写判断，不写论证**。实测草稿与终稿一样长（1,860 / 1,976 字），
 * 等于把整篇答案先写一遍再重写一遍；而它的实际用途只有两个——让派题看出缺哪一处、
 * 给终稿当底稿。所以压掉"为什么成立、例子怎么讲开"这部分（那本来就是终稿的活），
 * 判断、人名、书名、数字照留。
 *
 * 2026-10-28：**草稿要有骨架，不再是一张平铺的判断清单**。用户对比旧路径的回答后发现
 * 新路径"整体的逻辑性框架性下降"（同一道题：旧路径写"四件事+三条折扣+一句收"，新路径
 * 开头说"两类"、下面列出五类，五条还是并排的话题）。根因在 R1：它只列编号判断、明令
 * "不写分节标题"，于是每条都是独立结论，终稿只能一条一段地平铺。现在 R1 先交一句总判断、
 * 二到四步、一句收口，后一步从前一步的结论里长出来；R4 照这条线写。步骤仍然是判断，
 * 不是论证——这一步"只写判断"的约定没有放宽。
 *
 * 2026-10-29 用户纠正：**长期议题不是用来"围绕"的**。它只是让 AI 参考使用者的逻辑偏好、
 * 理论背景、思维习惯，不是可以直接被具体围绕的对象，也不能拿它替这一轮的题目。
 * 所以上一版"先选线、写接的议题/位置"的改法整条撤回：R1 仍是总/步/收，画像只用来定
 * **怎么搭**（从哪切入、先拆什么、哪些要解释、举什么例子），不决定**搭什么**。
 */
export function buildDraftBrief() {
  const lines = [
    '【要办的事】给下面这条提问搭一张内部草稿：一句总判断、几步、一句收口，末尾附一份待查清单。不是写回答。',
    '（内部草稿，用户不会读，不必顾虑措辞。）',
    '',
    '写草稿的规矩：',
    '· 总判断一句，能被反驳；不是"这个问题很重要"，也不是"有几种做法"。',
    '· 步数由这一问的转折数决定，不设目标：两步能说清就两步，需要几步写几步；不要照抄模板或例子的步数。',
    '· 第1步从总判断里分出第一层；之后每一步只做一件事，后一步从前一步的结论往下走。把各步连起来读，要是一句推理，不是并列的几个方面；全篇只有一条主线。',
    '· 写完删一遍：删掉后链条仍成立的步骤删掉；一步里塞了两个转折的拆开。',
    '· 收口一句：总判断成立到什么程度，或者被材料改成了什么。',
    '· 总、步、收都只写判断：不写评价、不写"为什么"、不写"比如"、不另加小标题；具体数据（年份、金额、法条号、机构名）都不写，留给待查。',
    '· 末尾另起一块"待查"：只列具体事实（年份、文件、数字、机构），一条一行，用"验："开头；总、步、收里的事实都算，不限步数。没有具体事实就写"待查：无"，不要每一步都写无。前面这轮对话里已经落到具体出处的，不再列。',
    '· "验"行要带年代：搜索读不懂"当时"。',
    '· 写完对一遍提问：问到的每一面链上有没有位置？没有的，先看能不能并进现有某一步的一句里；只有真的多一个转折，才新开一步。链上每个具体事实待查里有没有一行？没有的补；待查里没有对应事实的行删掉。',
    '· 上一块【背景档案】里的画像只用来定怎么搭（他的逻辑偏好、理论背景、思维习惯）：从哪切入、先拆什么、哪些要解释、举什么例子；长期议题只当背景，不要围绕它们写，也不要为了贴合它改判断；题目永远是下面这条提问。',
    '· 用户说"继续说/然后/接着"时，第1步从上一轮停下的地方开始，已经讲过的不要再列；前面已经立住一条主线时，接着它往下走，不要每轮重新起头，只有换了问题才另起。',
    '',
    '--- 例子（内容无关，只看形状）---',
    '提问：这道汤为什么这么鲜？',
    '总：这锅汤鲜，不是某一种料下得多，是两路鲜味叠在一起。',
    '第1步：把两路鲜味分开：火腿给肌苷酸，笋给鸟苷酸',
    '第2步：把两路合起来看：叠在一起比单放一样更鲜，所以两样都得有',
    '收：所以鲜不鲜看的是搭配，不是火腿放得多不多。',
    '待查：',
    '验：这两种物质叠在一起会不会放大鲜味（1980年代以来的食品化学研究）',
    '验：火腿的现行国家标准对陈放期怎么规定（现行版本）',
    '（例子结束：这个例子两步就够，第三步并进了第二步，因为它不是新的转折。）',
    '',
    '--- 输出 ---',
    '只输出下面这些行，不要标题、不要解释：',
    '总：',
    '第1步：',
    '第2步：',
    '收：',
    '待查：',
    '验：',
  ]
  return lines.join('\n')
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
 *   ② 「能补」必须落在候选目录里**已有的说法**上，不许要它推导、补写、拼合；
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
    lines.push('【原始草稿】这是目前对【原始提问】的第一次回答；没有经过【候选目录】的补充，必然不完整，也可能答偏：')
  }
  lines.push(
    // 剥掉「验：」行：那是给联网验证的清单，不是派题要看的缺口（见 stripVerify 注释）
    stripVerify(String(version || '')).slice(0, TASK_LIMITS.maxDraftChars) || '（空）',
    '',
    '【候选目录】下面每一条是另一段对话的记录：一个标题，加几行它当时留下的说法（这些是它当时的说法，不是正文）：',
  )
  for (const p of points) {
    lines.push(`· ${p.kid}「${p.point}」`)
    const al = (p.aliases || []).filter(Boolean)
    // 不给编号（2026-10-29 用户定）：题面里引"第几条"对这条旧讨论是空指针——
    // 它看不到这张目录，只会以为有若干具体条目要对。说法照给，取舍不靠编号。
    if (al.length) al.forEach((a) => lines.push(`  · ${a}`))
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
    '    能补 → 写「K-x：<那一处没答到的>，要它交出能补上的那部分」',
    '    不能补 → 写「K-x：无」',
    '    题只许落在它已经说过的话上：要它推导、补写、拼合，它只会回一句"这段没谈"，那条就白问了。',
    // 2026-10-29 用户定：题里不许出现条目编号。线上实跑里题面长这样——
    //   「缺的是X —— 第2、3、4、5、6、7、8、21、22条，要它交出…」
    // 被问的那条旧讨论看不到那张目录，编号对它是空指针；而且一串编号会把题意冲淡。
    '    题里不要出现条目编号：被问的那条讨论看不到这张目录，编号对它没有意义。要哪一部分，就把那件事写出来。',
    '    写「无」的那一条，这一轮完全不参与：它说过的话，不会出现在给用户的回答里。',
    '',
    '--- 例子（下面的话题是假的，只看格式）---',
    '',
    '假设缺的一处是"没说这道菜是哪里来的"，候选有两条：',
    'K-1：没说这道菜是哪里来的，要它交出当时讲这道菜来历的那段',
    'K-2：无',
    '（例子结束）',
    '',
    '--- 输出 ---',
    '',
    `下面是这一轮的候选，每条候选占一行，顺序照上面，共 ${kids.length} 行，不要别的内容：`,
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
 *
 * 2026-10-28 起草稿的主形状是「总 / 第N步 / 收」，方向分段是旧形状，保留解析只为
 * 兼容历史记录与旧测试。thesis / steps / closing 只用于**记录与日志**（trace 里能看见
 * 这一轮有没有一条主线），R4 拿到的仍是 raw 全文，不另做拼装。
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
  const one = (re2) => {
    const m = raw.match(re2)
    return m ? m[1].trim() : ''
  }
  const thesis = one(/^(?:总判断|总)\s*[:：]\s*(.+)$/m)
  const closing = one(/^(?:收口|收)\s*[:：]\s*(.+)$/m)
  const steps = [...raw.matchAll(/^第\s*[一二三四五六七八九十\d]+\s*步\s*[:：]\s*(.+)$/gm)]
    .map((m) => m[1].trim())
    .filter(Boolean)
  return { raw, directions, thesis, closing, steps }
}

/**
 * 剥掉大纲里的「待查」块和「验：…」行（2026-10-27，2026-10-29 加待查块）。
 *
 * 为什么必须剥：派题的输入就是草稿 raw，它的任务是"看这份草稿还差在哪一处"。
 * 草稿里躺着一行「验：征地补偿标准要查」，派题会读成"缺口已经写明了"，于是不派题。
 * 缺口归派题判，验什么归联网验证判——两件事，别让一边看见另一边的清单。
 * 「待查：」只是那块的表头，一起剥；「待查：无」也一并去掉。
 */
export function stripVerify(text) {
  return String(text || '')
    .replace(/^[ \t]*待查[ \t]*[:：].*$/gm, '')     // 待查表头（含「待查：无」）
    .replace(/^[ \t]*验[ \t]*[:：].*$/gm, '')       // 独占一行
    .replace(/[ \t]*验[ \t]*[:：][^\n]*/g, '')       // 跟判断写在同一行
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 抽大纲里的「验」行 = 这一轮要联网确认的几处（给搜索当查询种子）。
 * 写「无」的不算。返回去重后的字符串数组，顺序照大纲。
 */
export function parseVerifyLines(draft) {
  const out = []
  for (const m of String(draft || '').matchAll(/验\s*[:：]\s*([^\n]+)/g)) {
    const t = m[1].trim()
    if (t && !/^(无|没有|none)[。.]?$/i.test(t)) out.push(t)
  }
  return [...new Set(out)]
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
    '原话不加引号、也不写成"他说过……"；把当时那句话的意思复述出来，里面的人名、书名、例子名、数字照原样留着。不替使用者补态度；正文里没有的不许补。',
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
    '【一条旧讨论的正文】',
    material,
    '【正文结束】',
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

// ── 回归汇总（中转记录，不是 R4；R4 在下面「R4 终稿」一节）──────────────────────

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

// ── R4 终稿（对话档：开思考，产物是用户唯一看到的那份回答）────────────────────
/**
 * 终稿的输入：**一次真正的回答**，不是把草稿和史料并在一起。
 *
 * 2026-10-26 用户定：草稿关思考之后只有骨架（判断、无论证、无具体的人名年份），
 * 所以终稿不能只当"汇总"——它得把骨架当场想清楚、用具体的东西落地。这里的三块因此各换了身份：
 *   草稿 = 这一轮先列出来的判断清单（骨架）
 *   史料 = 那次讨论的状态（归纳，不是原话）
 *   回答 = 由终稿现写，历史里有的用历史，没有的标明是判断。
 *
 * 2026-10-26 晚修正（同一天，用户看到实跑后定的）：上面"把骨架当场想清楚"被模型执行成了
 * "为了保住骨架去改写材料"。有一轮里历史明明写着"改成区片价了，但仍不是市价，因为没有议价"，
 * 终稿为了自圆骨架把它压成"按原用途定价的原则没变"——后者是错的。所以加了两条：
 *   ① **骨架可以改**，材料比骨架准（草稿是关思考的粗稿，它不该有否决权）；
 *   ② **具体事实先到历史里找**，历史和史料都没有就降粒度，不许为了"具体"编数。
 * 注意这两条针对的是两种不同的错：改骨架治"把对的改错"，找历史治"没有却硬写"。
 *
 * 提示词档位（2026-10-26 用户按 prompt-craft 要求重写）：这是**对话档**——R4 开思考，产物是
 * 给用户看的回答。所以规则写成"结果标准"，不写成编号禁令：机械档那六条（任务句打头、数据/要求
 * 分隔、换话题的形状例子、打头输出模板）只适用于 thinking:false 的调用；搬到推理模型上会变成
 * 一堆它不会照做的 MUST。对话档只管三件事：结果标准是什么、新的推进归谁、不用字数管长度。
 *
 * 2026-10-27 用户定：事实的来源按可信度排三级——**搜索结果 > 前面这轮对话 > 自己的知识**。
 * 所以多了一块可选的【搜索结果】（联网查到的，附出处）：这一轮没查就整块不出现，规则照样读得通。
 * TC（联网验证）接上时只需把结果填进 search，不用再改这段提示词。
 *
 * 2026-10-27 晚（用户看到 A/B 实跑后定）：终稿里材料占的篇幅打断了阅读连续性，"材料 → 判断"
 * 那一层反而太薄。改成——正文按主干逻辑写，材料只当**凭据**：用到了就在该处打一个 `[编号]`，
 * 原话、条文、出处名留在编号后面，由侧栏点开看（默认折叠）。核对照做，只是核对的过程不进正文。
 * 配套：材料块每条带编号（web-search.js 的 pickSearchItems），条目随消息落库（payload.sources）。
 *
 * 2026-10-28：**"按主干逻辑写"这句太虚，实跑落成了话题并排**。用户拿同一道题的两份答案对比：
 * 旧路径写"四件事 + 三条折扣 + 一句收"，新路径开头说"两类"、下面列出五类（五条还是并排的
 * 话题）。所以这里不再只说"围着主干走"，而是点名草稿的形状（总 / 第N步 / 收），并要求每一步
 * 接住上一步、结尾回到总判断。另加两条实测踩到的边界：一条主线（说了几类就只有几类）、
 * 接着上一轮说时不要重头再讲。
 *
 * 2026-10-29 用户纠正：画像里的长期议题只是参考（逻辑偏好 / 理论背景 / 思维习惯），
 * 不是可以直接被具体围绕的对象，也不能替这一轮的题目。所以上一版「接的议题 / 这一问的位置」
 * 整条撤回；R4 只是不要为了贴合画像改判断——题目永远是用户这一问。
 *
 * 2026-10-29 用户定：**R1 的链只是假设，不是判决**。R4 先按它串联，但逐步在材料面前检验：
 * 哪一环站不住改哪一环，总判断被事实推翻就换总判断；材料是证据不是清单，不用逐条用上；
 * 事实与推理冲突时先信事实，不许把事实压小来保住原结论；正文不写"原来/我改了"的过程话。
 */
export function buildAggregateMessage({ draft, reports = [], search = '' }) {
  const raw = String(draft?.raw || '').trim()
  const searchText = String(search || '').trim()
  const lines = []
  // 搜索结果排最前：它是最新查证的，优先于草稿和旧讨论（2026-10-27 用户定）。
  // 这一轮没查就整块不出现——规则写的是"上面有【搜索结果】才先按它来"，所以照样读得通。
  if (searchText) {
    // 2026-10-27 实测：接口有两块文本——summary 是它自己写的二手转述，snippet 是网页里原样摘的
    // 那一两句（中间用「...」省略）。正文取的是 snippet，所以这里说的是"别把省略补上"，
    // 不是"别当原话引"：党章那句原文就直接在 snippet 里。
    // 2026-10-27 晚：每条前面带编号（[1]、[2]…），终稿正文引用材料时写的就是这个编号。
    lines.push('【搜索结果】（这一轮联网查到的。每条前面有编号 [1]、[2]…，正文引用材料时写这个编号；原话中间的「...」是省略，不要补上）', searchText, '')
  }
  lines.push(
    '【原始草稿】（这一轮先搭出来的骨架：一句总判断、从它往下走的几步、一句收口；末尾可能带一块「待查」，那是这一轮要查的清单，不是正文；只有判断、没有论证，也没经过材料核对；用户看不到它。**它是出发点，不是判决——材料推翻它，是正常的**）',
    raw || '（无草稿）',
    '',
    '【史料记录】（每条都是一段话，写那次讨论的**状态**：得出了什么、到哪儿为止、还没定什么、你当时什么态度；都是归纳，不是口头原话）',
  )
  if (!reports.length) lines.push('（这一轮没登记到史料：按草稿写，具体事实到前面这轮对话里找；别假装记得旧讨论）')
  for (const r of reports) {
    // 有题才印「｜题：…」。终稿拿到的多半是"整枝合并后的中转记录"，不对应单一题——
    // 空着印「（没给题）」只会让提示词读起来像没做完（2026-10-26 改）。
    lines.push(r.task ? `· ${r.kid}｜题：${r.task}` : `· ${r.kid}`)
    if (r.body) lines.push(`  ${r.body}`)
  }
  lines.push(
    '',
    '【这次要写的是回答，不是汇总】',
    '要交出去的是一份回答，不是把上面几块拼起来。标准只有一条：用户读完，对这个问题的判断比他问之前更准。',
    '',
    '【草稿的链是假设，不是判决】草稿的「总 / 第N步 / 收」是这一轮先立的一条假设。先按它走一遍：每一步在材料面前还站得住吗？站得住就顺着写（开头立判断、每一步接住上一步、结尾回到判断）；哪一环站不住就改哪一环，缺一环就补一环；总判断被事实推翻就换总判断，不要为了保住原链的形状去改事实。改完仍只能有一条主线——开头说分几类，下面就只有那几类，不许说"两类"列五类，也不许把步骤写成"市场那一头""企业那一头"。草稿没写成总/步/收的，先替它把这条线理出来再写。',
    '',
    '【材料是证据，不是清单】搜索到的材料和史料不是必须逐条用上的清单：只用在支撑或推翻某一步的地方，跟这条链无关的不写，用了才打 [编号]。事实跟原来的推理冲突时，先信事实再改推理——年份、条文、数字、谁做的，材料里明确写了的按材料，不许为了保住原结论把事实说小；反过来，材料只是补充/旁证、不足以推翻判断时，不要因为"搜到了"就改结论。标准是这条链在事实面前站不站得住，不是材料用了几条。',
    '',
    '【正文只写改后的论证】不写"草稿/原来/我改了"这类过程话；直接把改后的判断写出来。草稿上的每一条判断你都要当场想清楚它凭什么站得住，但**想清楚不等于写出来**——原话、条文、因素清单、逐年数字留在原处，不搬进正文。草稿末尾的「待查」是查询清单，不是正文。',
    '',
    '画像只用来定详略和切入，不是这一轮的题目；不要为了贴合它把判断改成它想听的。',
    '',
    '如果用户这一轮是在要求接着上一轮说（"继续说""然后呢""接着"），上一轮已经说过的只当已完成的步骤：从它停下的那一句往下走，不要重新开头，也不要把同一段再讲一遍。',
    '',
    '草稿和【史料记录】对不上时，记录是对的；记录和搜索里明确的事实对不上时，以事实为准。但记录是归纳、搜索是材料：别拿一条旁证推翻整条判断，也别拿"记录里没写"去否定明确的事实。',
    '',
    '年份、文件号、金额、倍数这类具体的东西，【史料记录】里和前面这轮对话里都没有的，就说得笼统些，别凭印象补一个数。',
    '',
  )
  // 下面三段只在**这一轮真的联了网**时出现。
  // 2026-10-27 修：它们原来无条件打印，于是没联网的回合里也写"【搜索结果】不是结论……"，
  // 指向一块根本没印出来的材料；而且那行用方头括号起头，看着像第二个材料块（用户就问过"为啥有两处搜索结果"）。
  // 现在开头改成句子（"开头那块搜索结果…"），并且整段跟着块一起出现或一起消失。
  if (searchText) {
    lines.push(
      '开头那块搜索结果是**凭据**，不是要转述的内容。你打算写的那些具体东西——哪一年、哪份文件、多少、谁定的——先在这里对一遍：搜索里有确切说法的，就按它写，哪怕跟草稿上写的不一样。它不替你决定判断，但会改事实：事实跟你原来的推理冲突时，先信事实，再改推理；不要为了保住原结论把材料里的事实说小。两处都没有的，就用你自己知道的写，说清那是判断。',
      '',
      '用到了哪一条材料，就在那句话后面打一个 [编号]（材料前面那个数字，比如 [3]）。读者看不到材料内容，只看见这个编号：点开它才展开那一条的原话和链接。所以正文里不用替材料复述，也不用把出处名、机关名、年份写进去——那些留给编号后面那一条。**唯一的例外是出处本身就是论据**（比如"怎么分由国务院定、报人大备案"这句话里，报人大备案才是关键）。同一处判断只打一次；不同判断可以重复引同一条材料——同一份法条支撑两处不同的判断时，两处各打一次。同一个判断用了几条，就按顺序打几个。编号只能用开头那块里真有的。',
      '',
      '数字只留这个判断靠它成立的那一个（"19 倍"这种本身就是论据的留着）；同一件事的一串数字（起止年份、逐年增长、占比连乘）不在正文里报菜名，需要的时候用一句话说清往哪边变。',
      '',
      '同一件事在 1980 年代、2004 年、2019 年可能不是同一个答案。搜到的几条分属不同年代时，按这条判断问的是哪一年去挑，不要拿最近的那条顶上去，也不要拿一条去否定另一条。',
      '',
      '没查到的，写出来要像个判断：用"大致""我印象里""一般认为"这一类说法，不要写成跟查到的一样硬。前面这轮对话里已经这样落到底的具体说法，可以照用，不必因为这一轮没再查到就把它降成"据说"。',
      '',
    )
  }
  lines.push(
    '用户问到的每一面，只要材料撑得住就要有回应。旧讨论只告诉你当时说到哪儿：从停下的地方往前走，不要把已经得出的结论再推一遍；引用它的内容可以，别加引号当成我们说过的话，记录里没有的旧讨论内容一个字都不许补。往前那一步是这一轮的——要说得出哪句是旧说法、哪句是你现在的判断。',
    '',
    '直接输出正文：不要写"根据史料记录""综合以上"，不要输出 JSON，也不要写"以下是回答"。按【相处规则】说话，不要写成一条条的栏目或清单——步骤之间要连成话，不是列条目。',
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

/**
 * 正文里的编号按**出现先后**重排成 [1]、[2]…（2026-10-27 晚，用户实跑报的）。
 *
 * 为什么要动它：模型是按"在材料块里挑东西的顺序"写的，不是按读者读的顺序。实测那一轮第一句
 * 就写 `[2]`，`[1]` 出现在后面——读者看到第一个标记是 [2]，像引用错位，也让人怀疑编号只是
 * 材料块的序号、并不对应正文。重排之后：正文第 1 个标记就是 [1]，重复出现的还是同一个号。
 *
 * 只改方括号里的数字，别的一个字不动；对不上材料的编号（模型自己编的）原样留着。
 * 没被引用的材料不进返回的清单——一个编号都指不到它，带上只是让 payload 变胖。
 *
 * @returns {{text: string, items: Array}} items 已按新号排好（n 换成新号）
 */
export function renumberCitations(text, items = []) {
  const byN = new Map()
  for (const it of (Array.isArray(items) ? items : [])) {
    const n = Number(it && it.n)
    if (Number.isFinite(n) && n > 0 && !byN.has(n)) byN.set(n, it)
  }
  const order = []   // 老号，按第一次出现的先后
  const out = String(text || '').replace(/\[(\d{1,2})\]/g, (m, d) => {
    const n = Number(d)
    if (!byN.has(n)) return m
    const at = order.indexOf(n)
    if (at >= 0) return `[${at + 1}]`
    order.push(n)
    return `[${order.length}]`
  })
  return { text: out, items: order.map((n, i) => ({ ...byN.get(n), n: i + 1 })) }
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
    // 相处规则（2026-10-27）：**只给终稿用，不给 R1**（用户明确定：大纲只管列判断）。
    // 原来它被包在 persona 的【背景档案】里，那块的抬头写着"只用于理解背景、不得转述或引用"，
    // 于是"照这个做"的要求被"这只是一份资料"的定性压掉了。现在单独一条、紧贴提问。
    agreement = '',
    // 当前提问 = 用户这一轮真的问的那句（**不是**节点里那条旧问题）。整套课题都锚在它上面。
    question: curQuestion = '',
    hits = [], nodeOf = () => null, parentsOf = () => [],
    fallbackHits = hits, // 退回整段注入时，只有已有引用和继承节点可以标亮
    complete, stream, judgeSystem = '', checkStop = () => {}, log = () => ({}),
    fallback = null, onEvent = () => {}, onRefusal = null, opts = {},
    // 联网搜索（2026-10-27 接上）：search(验行数组) → Promise<{text, stats}>。
    // 传**函数**而不是字符串，是因为它必须在这里当场发出去，才能跟下面的派题递归同时跑。
    // 不传 = 这一轮不联网，终稿提示词里那一块整块不出现。
    search = null,
  } = deps
  if (typeof complete !== 'function') throw new TypeError('runTasksPipeline: 缺少 deps.complete')
  if (typeof stream !== 'function') throw new TypeError('runTasksPipeline: 缺少 deps.stream')

  /** 记一笔全过程事件（调试记录）。抛错就地吃掉：记录不该影响回答。 */
  const emit = (evt) => { try { onEvent(evt) } catch {} }

  const lim = { ...TASK_LIMITS, ...(opts || {}) }
  const t0 = Date.now()
  // 只用来记账（stats 里报"探索调用 N 次 / 材料约 N token"），不参与任何拦截
  const spent = { calls: 0, chars: 0 }

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
    // 降级时没有逐节点筛选，只高亮已确认的引用和继承节点。
    const confirmed = new Set(fallbackHits)
    const ids = points.filter(p => confirmed.has(p.id)).map(p => p.id)
    emit({ type: 'used', nodes: ids, hits: ids })
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
    // 新节点的检索描述就是讨论目录。旧节点仍用别名，目录只供选择，正文另读。
    if (node) {
      const descriptions = Array.isArray(node.descriptions) ? node.descriptions : node.aliases
      live.push({ id, point: String(node.point || '').trim(), aliases: (descriptions || []).filter(Boolean) })
    }
  }
  const points = live.map((h, i) => ({ ...h, kid: `K-${i + 1}` }))
  // 没有命中节点：不派题，但**照样列大纲、照样联网**（2026-10-27 用户定）。
  // 原来这里直接回一句普通答案，等于"你没读过的话题一律不查网"——而那正是最容易编的一类问题。
  // 搜索不需要节点、只需要一句提问，所以不该被"有没有命中"拦住。
  const noHits = points.length === 0
  if (noHits) {
    log('这一轮没有可派题的命中 → 不派题，但仍列大纲并联网验证')
    emit({ type: 'note', text: '没有命中节点 → 不派题，但仍列大纲并联网验证' })
  } else if (points.length > 3) {
    log(`命中 ${points.length} 个（设计：超过 3 个只记日志，不做硬截断）`)
  }

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
  const hasSpine = Boolean(draft.thesis && draft.steps.length)
  log(
    `R1 草稿 ${draft.raw.length} 字｜`
    + (hasSpine
      ? `骨架：总「${draft.thesis.slice(0, 40)}」→ ${draft.steps.length} 步${draft.closing ? ` → 收「${draft.closing.slice(0, 30)}」` : ''}`
      : `没解析出骨架（总/步/收），终稿只能按清单整合`),
  )
  // 待联网验证的几处：从「验：」行抽出来，跟派题是**并列**的两条路（2026-10-27 用户定）——
  // 派题往下追旧讨论，验证去查外部事实，互不等待，最后都并进 R4。
  const verifyPoints = parseVerifyLines(draft.raw)
  if (verifyPoints.length) log(`R1 待联网验证 ${verifyPoints.length} 处（与派题并行）：${verifyPoints.map((v) => v.slice(0, 18)).join(' / ')}`)
  // 当场发出去、**不 await**：这一句就是"并行"的全部实现。下面一路派题递归要跑十几秒，
  // 而搜索实测 0.3–0.5 秒，等派题跑完时它早就回来了。
  // 这里必须立刻 catch：派题那条路要是先抛错，这个 promise 就没人接了（unhandled rejection）。
  const searchTask = (async () => {
    if (typeof search !== 'function' || !verifyPoints.length) return { text: '', stats: null }
    try {
      const r = await search(verifyPoints)
      return typeof r === 'string' ? { text: r, stats: null } : (r || { text: '', stats: null })
    } catch (e) {
      log(`联网搜索失败（不影响这一轮回答）：${e.message}`)
      return { text: '', stats: { error: e.message } }
    }
  })()
  emit({
    type: 'draft', raw: draft.raw, chars: draft.raw.length,
    directions: draft.directions.map((d) => d.name),
    spine: { thesis: draft.thesis, steps: draft.steps, closing: draft.closing },
    verify: verifyPoints, ms: Date.now() - tDraft,
  })
  // 一条命中都没有：没有题可派，但**大纲和联网照跑**（2026-10-27 用户定）。
  // 原来是直接回一句普通答案——等于"你没读过的话题一律不查网"，而那正是最容易编的一类问题。
  if (!noHits) emit({ type: 'section', text: '② 命题递归（子节点点题 → 父节点作答）' })

  // ── 递归：一个节点先交付，再给父节点派题，等父节点"回归"后逐层汇总往回交 ──────
  const initial = draft.raw
  const reports = []
  const mismatches = []
  const refusals = []
  const expanded = new Set(points.map((p) => p.id))
  // 顶层判为「用不上」的命中节点：这一轮既不当命中、也不能再当别人的父节点（已在 expanded）。
  // 2026-10-26 先只记日志、不改行为——先看这种屏蔽有多频繁，再决定要不要放开结构。
  const unusedHits = new Set()
  const kidSeq = new Map()
  let full = ''

  // 2026-10-26：兜底闸已删（用户定：该不该再追只由派题判，不由程序数着花销喊停）。
  // callOnce 现在只做两件事：记一笔调用数（stats 用）、把调用发出去。
  const callOnce = async (o) => {
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
      const rep = parseReport(out, kid)
      if (rep) return { report: rep }
      log(`R2 ${kid} 输出不是合法登记（第 ${attempt} 次）：${String(out).replace(/\s+/g, ' ').slice(0, 80)}`)
    }
    return { reason: '两次输出都不合格式（既没有一段正文，也没有「拒绝：」）' }
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
   * visitInner 只负责跑；外面那层 `visit` 顺手记两件事（都以 live 事件发出去）：
   *   · `nodes`  = **成功上报的来路节点**（summary 非空、depth ≥ 1）→ 下一轮可以继承
   *   · `failed` = **这一轮交付被拒的节点**（任意深度）→ 从继承集合里去掉
   * 用户定的规则是"这一轮无效的就不再继承"，所以光并集不够，还得做减法。
   */
  const liveUp = new Set()
  const refusedNodes = new Set()
  // 这一轮**读过、并且交上了料**的节点（2026-10-27 用户定）。图上的命中高亮只画这一份：
  // 顶层派题判「用不上」的、读了材料但交付被拒的都不在里面——它们这一轮没起作用，
  // 画上去等于说"这一轮用了它"。顺序 = 交付完成的顺序（往深处追的父节点先完成）。
  const usedNodes = []
  const usedSeen = new Set()
  const visit = async (args) => {
    const r = await visitInner(args)
    if (r.summary && !usedSeen.has(args.id)) { usedSeen.add(args.id); usedNodes.push(args.id) }
    if ((args.depth || 0) >= 1 && r.summary) liveUp.add(args.id)
    if (r.refused) refusedNodes.add(args.id)
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
      return { kid, summary: '', reports: [mine], refused: true }
    }

    const own = String(mine.body || '').trim()
    if (depth >= lim.maxDepth) return { kid, summary: own, reports: [mine] }

    const candidates = []
    for (const pid of (parentsOf(id) || [])) {
      if (!pid) continue
      if (expanded.has(pid)) {
        // 顶层判「用不上」的命中节点被整轮屏蔽：材料一个字都没读。只记日志，不改行为。
        if (unusedHits.has(pid)) log(`${kid} 的候选 ${pid} 因顶层「用不上」被整轮屏蔽（材料没读）`)
        continue
      }
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
  // 没有命中时这一整段跳过：不派题，但草稿和搜索结果照样进终稿。
  const firstT = noHits
    ? new Map()
    : await dispatchDown({ kid: '草稿', taskText: '', body: initial, candidates: points.map((p) => ({ ...p, depth: 0, askedBy: '' })), depth: 0 })
  const tops = []
  for (const p of points) {
    const t = firstT.get(p.kid)
    if (!t) {
      unusedHits.add(p.id)
      emit({ type: 'ask', kid: p.kid, depth: 0, skipped: '用不上' })
      continue
    }
    expanded.add(p.id)
    tops.push(await visit({ kid: p.kid, id: p.id, point: p.point, aliases: p.aliases, depth: 0, askedBy: '', taskText: t }))
  }

  const finalReports = tops.filter((x) => x.summary).map((x) => ({ kid: x.kid, task: '', body: x.summary }))
  // 图上亮哪些（2026-10-27 用户定）：**只亮这一轮读过、并且交上了料的节点**——顶层判「用不上」的、
  // 读了材料但交付被拒的都不算（它们这一轮没起作用）。发出时机卡在终稿流式之前：终稿是最后一步，
  // 此刻清单已经定下来了，用户开始读答案时图已经亮着（旧做法是提问后立刻亮，那时还没判，
  // 只能把全部候选都画上去，图上亮的和实际用的对不上）。
  //   nodes = 图上要亮的：本轮命中里真用上的在前，再跟上往下追读的父节点
  //   hits  = 其中属于「本轮引用命中」的那几条（自由模式的引用窗体按它自动并入；
  //           往下追读的父节点是模型自己读的、不是用户指认的，不进窗体）
  const usedHits = points.filter((p) => usedSeen.has(p.id)).map((p) => p.id)
  const usedHitSet = new Set(usedHits)
  const usedIds = [...usedHits, ...usedNodes.filter((id) => !usedHitSet.has(id))]
  if (usedIds.length) log(`本轮真读到 ${usedIds.length} 个：${usedIds.join('、')}（图命中只亮这些）`)
  emit({ type: 'used', nodes: usedIds, hits: usedHits })
  // 派题这条路走完了，回头收搜索那份——它多半在几秒前就回来了（实测 0.3–0.5 秒）。
  const searched = await searchTask
  const searchText = String(searched?.text || '')
  if (searched?.stats) {
    const s = searched.stats
    if (s.error) log(`这一轮没联网：${s.error}`)
    else log(`联网查了 ${s.queries} 处${s.requests > s.queries ? `（拆成 ${s.requests} 次）` : ''} → ${s.kept} 条可用（${s.ms}ms，${s.chars} 字进终稿）`)
    emit({ type: 'search', queries: s.queries, requests: s.requests, results: s.results, kept: s.kept, chars: s.chars, ms: s.ms, split: s.split || 0, error: s.error || '' })
  }
  // 条目交给侧栏：终稿正文里那些 [编号] 点开要看的就是它们（标题 / 原话 / 链接）。
  // 只交**真印进材料块**的这些——编号和材料块同源（pickSearchItems），不会各数一套。
  // 注意它还要等终稿写完再发：终稿一出来就要按出现先后重排编号（见下面），那时才知道哪些用上了。
  const searchItems = Array.isArray(searched?.items) ? searched.items : []
  // 终稿这一块的输入要进记录（2026-10-27 补）：以前只有"每层回归汇总"进记录（带 kid），
  // 终稿自己那次输入从来没落过。加了搜索之后这块里躺着一整块网页材料——出问题时
  // 想说"它为什么这么答"，得能看见它当时看到的是什么。
  const r4Message = buildAggregateMessage({ draft: { raw: initial }, reports: finalReports, search: searchText })
  emit({ type: 'aggregate', message: r4Message })
  const agree = String(agreement || '').trim()
  full = yield* relay([
    ...hist,
    { role: 'user', content: persona },
    { role: 'user', content: r4Message },
    // 相处规则紧贴提问：模型对末尾更敏感（prompt-craft），而这一块要的是"照这个说"，
    // 不是"了解这个人"。夹在材料和提问之间，是它唯一该在的位置。
    ...(agree ? [{ role: 'user', content: agree }] : []),
    { role: 'user', content: anchored },
  ])
  log(`终稿 ${full.length} 字（草稿 + ${finalReports.length} 份回归汇总）`)
  // 编号两件事都在这儿做，顺序不能反（2026-10-27 晚，用户实跑报的）：
  //   ① 对不上材料的编号（模型自己编的）只记日志，原样留在正文里——它是个信号，别悄悄抹掉；
  //   ② 对得上的按**出现先后**重排成 [1]、[2]…。模型常常先写 [5] 再写 [2]（它按在材料块里
  //      挑东西的顺序写，不是按读者读的顺序），读者看到第一个标记就是 [5]，像引用错位。
  let roundItems = []
  if (searchItems.length) {
    const cited = new Set([...String(full).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
    const bad = [...cited].filter((n) => !searchItems.some((it) => it.n === n))
    if (bad.length) log(`终稿里有 ${bad.length} 处编号对不上材料（${bad.join('、')}），原样留着、不改成链接`)
    const re = renumberCitations(full, searchItems)
    full = re.text
    roundItems = re.items
    if (roundItems.length) log(`终稿引到 ${roundItems.length} 条材料，已按出现先后重排为 [1]…[${roundItems.length}]（这一轮印了 ${searchItems.length} 条）`)
    else log('终稿一处材料都没引（这一轮虽然查到了）')
  }
  emit({ type: 'final', text: full, coverage: [], ...(lim.finalLabel ? { label: lim.finalLabel } : {}), ...(lim.finalShown === false ? { shown: false } : {}) })
  // 条目必须等重排之后再发：n 已经换成正文里的新号，侧栏拿到的和读者看到的是同一套。
  if (roundItems.length) emit({ type: 'sources', items: roundItems })

  // 这一轮的继承增量交出去（index.js 会「并上 nodes、去掉 failed」写下一轮可继承的清单）。
  //   nodes  = 成功上报的来路节点（depth ≥ 1）：命中节点本身每轮由引用解析重新决定要不要跑
  //   failed = 这一轮**没起作用**的节点，两种都算（2026-10-26 用户定）：
  //            · 读了材料、交付被拒（任意深度）
  //            · 顶层派题判「用不上」——没读正文，但派题就是这一轮唯一有资格判它有没有用的地方
  // 只要这一轮轮到它、而它没起作用，下一轮就不再继承；没轮到它的才留在集合里。
  const deadNodes = new Set([...refusedNodes, ...unusedHits])
  if (liveUp.size) log(`本轮有效来路 ${liveUp.size} 个：${[...liveUp].join('、')}（下一轮同栈继续时可继承）`)
  if (deadNodes.size) log(`本轮没起作用 ${deadNodes.size} 个：${[...deadNodes].join('、')}（从继承集合里去掉）`)
  emit({ type: 'live', nodes: [...liveUp], failed: [...deadNodes] })

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
