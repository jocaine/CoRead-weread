/**
 * 教程课程表：**书与侧栏共读的一份**。
 *
 * ── 为什么要这个文件（2026-11 用户定调）────────────────────────────────────
 * 上一版是"两张皮"：书里有四段自动播放的假界面（看它演），侧栏里另有一套六步引导（让你做），
 * 两边互不认识。用户的原话是"应该合起来"。
 * 合起来之后的分工是：
 *   · **书**负责讲清"这是什么、为什么"（正文）
 *   · **课程**负责让你在**真实界面**上做一遍（本文件 + tutorial-guide.js）
 *   一章 = 一课。读完正文 → 点「开始本课」→ 侧栏把你带一遍 → 回来翻下一章。
 *
 * 这个文件是"哪一章对应哪一课、每课几步"的**唯一真源**：
 *   · 书页（tutorial/render.js）用它决定"这一章有没有课、按钮上写什么"
 *   · 侧栏（tutorial-script.js）用它决定"这一课有哪几步、每步盯什么"
 * 以前两边各写一份，改一处忘一处就会出现"书里说有课、侧栏里没有"这种对不上的情况。
 *
 * ── 每一步的两种形态 ──────────────────────────────────────────────────────
 *   · `wait`   ：**你必须真的做那一下**（点某个控件 / 打字 / 等消息区出新气泡），做完自动下一步
 *   · `read`   ：只是讲一句，你点「继续」往下（不假装要你做什么）
 * 这两种必须分开写：把"讲一句"也写成等待，用户会盯着屏幕等一个永远不会来的自动跳转。
 */

/** 高亮目标：给侧栏里的元素 id（见 sidebar.html）。找不到时引导层会退化成"整片讲一句" */
const SEL = {
  header: 'header',
  refCard: 'ref-current',
  refText: 'rc-text',
  jumpBtn: 'rc-jump-btn',
  switchBtn: 'rc-switch-btn',
  input: 'input',
  sendBtn: 'send-btn',
  msgs: 'msgs',
  graphBtn: 'graph-btn',
  freeSwitch: 'free-switch',
  freeBar: 'free-conv-bar',
  moreBtn: 'more-btn',
  readerItem: 'mm-reader',
}

/**
 * 教程自带的一批引用样例（2026-11 用户要求："事先准备好一些引用"）。
 *
 * ── 为什么数据放在同目录的 sample-refs.json，而不是写在这个文件里 ──────────────
 * 用户的原话："你直接给他添加些预设的例句有什么难的"。他是对的——问题不在于难，
 * 而在于上一版让它**依赖了三件不该依赖的事**（侧栏认不认得出当前是教程书、
 * ES 模块加载完没有、抽屉什么时候渲染），任何一环不满足，用户看到的就是空列表。
 *
 * 静态内容就不该有"还没到"这种状态。所以：
 *   · 数据 = `sample-refs.json`（纯数据文件）
 *   · **侧栏用 fetch 读它**（经典脚本读 JSON 是最直接的路径，失败也有痕迹）
 *   · 这个文件也读同一个 JSON（`loadSamples()`），于是**只有一份数据**，不会两边分叉
 *
 * ⚠️ 它们只出现在**教程这本书**里（引用的 key 是教程书 ID），不会进用户别的书。
 */
let _samples = null
export async function loadSamples() {
  if (_samples) return _samples
  try {
    const r = await fetch(new URL('./sample-refs.json', import.meta.url))
    _samples = await r.json()
  } catch (e) {
    _samples = { items: [] }
  }
  return _samples
}

/** 同步取用（只在 loadSamples() 之后有效）。书页那一步的例句按钮用它 */
export function sampleRefs() {
  return _samples || { items: [] }
}

export const LESSONS = [
  {
    chapter: 2,
    title: '划词共读：走一遍真实流程',
    intro: '这一课在**真实界面**上走：你在左边的书里划一句，右边的侧栏会跟着动。每一步都得你自己动手，做对了才会往下走。',
    steps: [
      {
        target: SEL.header,
        title: '先划中一段话',
        body: '回到左边的 CoRead 阅读器（这本《第一次共读》），用鼠标划中任意一段正文——随便哪一段。松手时划中的地方会浮出一个「共读」。',
        // 判据：侧栏的"当前引用"被填上了内容（= 你在阅读器里点过共读了）
        wait: { kind: 'refFilled' },
      },
      {
        target: SEL.refCard,
        title: '换成我准备给你的那一句',
        // 用户的定调（2026-11）：**"我们应该是为其准备好一些引用，然后第一步用户自己随便
        // 引用完之后，让他切换到我们为他准备的"**。所以这一步不是"随便换一条"，
        // 而是"从我准备的例句里挑一条"——挑完后面的讲解（第 3、4 课讲命中）才对得上内容。
        //
        // ⚠️ 这一步原来写的是"点 📍 跳到原文"。那是个死步骤：用户从阅读器划完词过来，
        // 人就在原文那儿，没有可跳的（他只能点"跳过"）。
        body: '刚才那句是你自己随便划的，留着它后面的讲解就对不上号了。'
          + '<br>请换成**我准备的例句**：点这个卡片上的「切换引用 ▸」，抽屉最上面有一组'
          + '「教程例句」——挑其中任意一条。'
          + '<br>这正是"切换引用"的用法：一场讨论可以围着不同的段落展开，换引用不会丢掉已经聊过的内容。',
        wait: { kind: 'refChanged' },
        // 这一步要"换成我准备的那几条之一"。**不在这里抄一份文本**——
        // 那些句子是 sample-refs.json 里的数据，抄一份就会两边分叉
        // （用户在卡片上看到的和抽屉里看到的不是同一批）。
        // 运行时由 tutorial-script.js 用它读到的同一份数据填进 `samplesResolved`。
        samplesFrom: 'sample-refs',
      },
      {
        target: SEL.input,
        title: '在这里提问',
        body: '写一句你自己的疑问。不知道问什么也行——什么都不写、直接回车，它会就着这段话先开口。',
        wait: { kind: 'typed', min: 2 },
      },
      {
        target: SEL.sendBtn,
        title: '发出去',
        body: '点「发送」。接下来它会读完你划定范围里的原文，再决定站哪一边——注意它不会复述原文，也不会附和你。',
        wait: { kind: 'click', id: SEL.sendBtn },
      },
      {
        target: SEL.msgs,
        title: '等它接话',
        body: '这一步等的不是"检索"，是它读完原文之后决定怎么接你的话。接话气泡出现在这块区域。',
        wait: { kind: 'assistantBubble' },
      },
      {
        target: SEL.graphBtn,
        title: '这一场的讨论，以后能找回来',
        body: '聊透了它会自己收口，把这场讨论收成一个知识点（第 3 章讲这个）。右上角那个 ◎ 就是会意图——'
          + '这本手册里那几个点是**专门给你练手用的样例**，不会进你自己的知识网。',
        wait: { kind: 'click', id: SEL.graphBtn },
      },
    ],
  },
  {
    chapter: 3,
    title: '收口与知识点：去图上认一认',
    intro: '这一课不讲新操作，只把第 3 章说的那个"知识点"落到你眼前的界面上——你会看到它长什么样、从哪儿进去看。',
    steps: [
      {
        target: SEL.msgs,
        title: '先看这里有什么',
        body: '刚才那一课你问过一句、它接过一句。如果这场讨论已经聊透，它会被收口成一个知识点节点；没聊透就先不收——这是它自己判断的，不用你管。',
        read: true,
      },
      {
        target: SEL.graphBtn,
        title: '打开会意图',
        body: '点右上角这个 ◎。图上每个点是一次聊透、收口下来的讨论；连线是话题之间的来路。',
        wait: { kind: 'click', id: SEL.graphBtn },
      },
      {
        target: SEL.graphBtn,
        title: '在图上找到你自己',
        body: '滚轮缩放、拖空白平移、单击一个点看它的详情：当初追的是哪个问题、归纳出的几个要点、以及整场讨论的原文。这些是你自己长出来的，不是它替你总结的。',
        read: true,
      },
    ],
  },
  {
    chapter: 4,
    title: '把旧话题接回来',
    intro: '这一课教你"换个说法也能找回来"到底怎么用——关键是：**你不需要记住当初怎么说的**。',
    steps: [
      {
        target: SEL.input,
        title: '用你自己的话，再提一次旧话题',
        body: '写一句模糊的回忆就行，比如"这跟我以前纠结过的那个是不是一回事"。不用给关键词、不用给书名——它判的是意思，不是字面。',
        wait: { kind: 'typed', min: 4 },
      },
      {
        target: SEL.sendBtn,
        title: '发出去，看它认不认得',
        body: '认得的话，它会把当年的来路接回来：那个点当初引用了谁、那些又是怎么来的，而且**给的是你俩的原话全文，不是摘要**。',
        wait: { kind: 'click', id: SEL.sendBtn },
      },
      {
        target: SEL.graphBtn,
        title: '命中的那条线会亮起来',
        body: '对话命中旧知识点时，会意图上相关的那条路径会自动高亮，其余压暗。点 ◎ 看一眼——那一次，就是"你的那条线"被接上了。',
        wait: { kind: 'click', id: SEL.graphBtn },
      },
    ],
  },
  {
    chapter: 5,
    title: '自由模式：切过去看一眼',
    intro: '自由模式是"随手记"的地方。这一课只需要你亲手切一次，感受一下界面怎么变。',
    steps: [
      {
        target: SEL.freeSwitch,
        title: '把开关拨到「自由」',
        body: '顶部这个开关控制读书 / 自由两种模式。自由模式下每场对话完全独立，不按书归属，也不会污染你的知识网。',
        wait: { kind: 'click', id: SEL.freeSwitch },
      },
      {
        target: SEL.freeBar,
        title: '顶上多了一条对话栏',
        body: '这条就是自由模式的样子：左边是当前对话，右边能新建、能归档。归档时会问你两个问题——要不要存进记忆、要不要收进会意图（两个都默认勾上）。',
        read: true,
      },
      {
        target: SEL.freeSwitch,
        title: '切回「读书」',
        body: '切回来，当前引用还在，刚才那场正式讨论没被打断。这就是为什么要把两种模式分开：正式的归正式，随便的归随便。',
        wait: { kind: 'click', id: SEL.freeSwitch },
      },
    ],
  },
  {
    chapter: 6,
    title: 'PDF 阅读器在哪儿',
    intro: '这一课只解决一个问题：以后想用 PDF 阅读器 / 翻译的时候，上哪儿找。',
    steps: [
      {
        target: SEL.moreBtn,
        title: '点右上角这个「⋯」',
        body: '不常用的入口都收在这个菜单里：模型 API 配置、PDF 阅读器、工具箱、从已读书籍中选择。',
        wait: { kind: 'click', id: SEL.moreBtn },
      },
      {
        // ⚠️ 2026-11：PDF 阅读器**从工具箱里搬到了这里**。原先这一步指的是
        // 「🧰 工具箱 → 阅读器页」，那条路要走四步；用户问的正是"放在工具箱里合不合适"。
        // 它现在与「🔑 模型 API 配置」并排，是菜单里第一个真正的入口。
        target: SEL.readerItem,
        title: '「📕 PDF 阅读器」就在这一条',
        body: '**点一下就直接弹出选文件**，不用进工具箱再点一次。'
          + '另外没检测到在读的书时，侧栏**最底下也有一条**同样的入口；'
          + '托盘图标上也有「打开 CoRead 阅读器」，双击托盘图标同样能开。',
        read: true,
      },
      {
        // 定位（2026-11 用户明确）：PDF 默认**传进微信读书**读，本地阅读器留给两类情况：
        //   ① **外文 PDF** —— 微读转版对外文书最不友好、翻译体验也差，我们这边划词就译、
        //      译文锚在段落上。这是这一格最有力的那句话，所以**排在最前面**；
        //   ② 微读转不了 / 转成电子书会错版的（扫描件最典型）。
        // 写在侧栏课里而不是只写在书稿正文：真到要用的那一刻，用户手里拿的是侧栏。
        target: SEL.readerItem,
        title: '什么时候才用它',
        body: '默认还是把 PDF **传进微信读书**读：能划线、能共读，也是我们推荐的路。'
          + '**读外文**建议直接用这个阅读器——划词就译，译文按段落贴在原文上，'
          + '微读那边的转版和翻译对外文书都不太顺手。'
          + '另外**微读传不上去、或转成电子书会错版**的 PDF（扫描件最典型），也走这里。',
        read: true,
      },
      {
        target: SEL.moreBtn,
        title: '工具箱里剩下的是翻译',
        body: '「🧰 工具箱」现在只放翻译一件事：启用开关、框选 / 划词两个手动入口、'
          + '快捷键设置，以及模型的三项可选覆盖（留空就沿用「模型 API 配置」）。'
          + '读 PDF 不在这里了，别再往下找。',
        read: true,
      },
    ],
  },
]

/** 这一章有没有课（书页据此决定要不要显示「开始本课」按钮） */
export function lessonFor(chapterNum) {
  const n = Number(chapterNum)
  return LESSONS.find((l) => l.chapter === n) || null
}

/** 按章号取课在表里的位置（侧栏的状态里存的是这个下标） */
export function lessonIndex(chapterNum) {
  const n = Number(chapterNum)
  return LESSONS.findIndex((l) => l.chapter === n)
}
