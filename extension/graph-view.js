/**
 * 会意图拓扑视图（AI-020）
 *
 * Obsidian 式话题拓扑图：节点 = 知识点（point），边 = 用户问题意识轨迹（有向，
 * kind = user 用户引用 / derived 对话衍生）。对应 topic-library-design.md §5 会意图。
 *
 * 两种状态：
 * - 观察态（一般情况）：浏览整张拓扑图——滚轮缩放、拖拽空白平移、拖节点微调布局、
 *   悬停高亮邻接子图、点选节点看详情（point / 相关说法 / 节点讨论 / 元信息）、
 *   搜索定位（point / aliases / 讨论问题）、图例（边种类、root、recent）。
 * - 命中态（对话命中）：SSE graph-hit（agent 引用解析命中旧知识点）→ 高亮各命中节点
 *   的 root→recent 路径并集（与 agent/lib/knowledge-graph.js contextOf 同规则：
 *   入边反向可达并集 + 拓扑序 root 在前）；路径节点/边提亮，其余压暗，
 *   命中节点（recent）脉冲环，root 节点虚线环，顶部横幅说明命中来源。
 *
 * 数据：GET {receiver}/graph[?demo=1]（receiver 转发 agent/data/knowledge-graph.json；
 * ?demo=1 载入演示拓扑，真实图为空时可预览交互与命中高亮）。
 * 协议：SSE message 事件 role='graph-hit' → { hits: [nodeId...], reason? }，客户端算路径。
 *
 * 无依赖、无构建：普通 <script> 加载，挂 window.CoReadGraphView。
 * 物理：自写力导向布局（斥力 + 弹簧 + 重心 + 阻尼 + 冷却），节点量级 <200，O(n²) 足够。
 * 常驻弹性（AI-024）：物理循环不停止——静止时近乎不动（静止摩擦 + 碰撞死区），
 * 拖拽/扰动时整图弹性联动；运动期四类碰撞（圆-圆/标签-标签/圆-标签）自动弹开。
 */

(function (global) {
  'use strict'

  // ── 常量 ────────────────────────────────────────────────────────────────
  const REPULSION = 22000      // 斥力系数（f = REP / d²）AI-038：提高 → 节点间距更大，缩放不易碰撞
  const SPRING = 0.018         // 弹簧系数（沿边）
  const REST_LEN = 200        // 边静止长度（世界单位）AI-038：拉长 → 相连节点更松，内部留白更大
  const GRAVITY = 0.004       // 重心引力系数 AI-038：调低 → 向心聚拢更弱，整体更铺开
  const DAMPING = 0.85        // 速度阻尼
  const MAX_SPEED = 13        // 速度上限
  const TICKS = 420           // 物理迭代上限（每帧 2 子步 → 约 3.5s 收敛）
  const SETTLE_E = 0.004      // 收敛阈值（平均动能）
  const FRICTION_V = 3.0      // 静止摩擦速度阈值（世界单位/步）：低于此速度额外耗散
  const FRICTION_K = 0.45     // 静止摩擦系数：低速每步再乘 0.45，静止时安静不发飘
  const COLLIDE_PAD = 1.0     // 碰撞死区（屏幕 px）：重叠小于此值不推，静止不发飘（亚像素重叠不可见）
  const LABEL_MIN_SCALE = 0.5  // 标签可见/参与碰撞的最低缩放：低于此值不画标签，也不做标签碰撞（防缩小后乱碰）
  const MAX_PUSH = 30         // 单对单帧最大推开量（世界单位）：AI-038 略增，缩放时弹开更利落
  const MAX_STEP = 9          // 单节点每帧最大位移预算（世界单位）：AI-038 略增，去重叠更敏捷
  const EDGE_CURVE = 0.16    // 曲边幅度系数（AI-034，占边长比例）：折返/互向边自动弯向相反侧
  const EDGE_CURVE_MAX = 200 // 曲边最大弯高（px）：超长边封顶，防弯过头甚至打结
  const ANG_MIN = 0.55       // 入射/出射边最小夹角（rad≈31.5°）：近 0=重合/折返，直接掰开（AI-037）
  const ANG_GAIN = 4.0       // 角分辨率力增益：缺角(rad)→速度增量
  const ANG_PUSH_MAX = 1.0   // 单边单帧速度增量上限：防瞬时甩飞，温和收敛


  const COLORS = {
    edgeUser: '#6d72e8',
    edgeDerived: '#8a92a6',
    nodeDefault: '#7c8b9d',
    pathAccent: '#5b5fe8',
    rootMark: '#9aa3f2',
    recentMark: '#3f45cd',
    nodeStroke: 'rgba(255,255,255,0.92)',
  }
  // 12 色高区分度调色板（AI-028）：红/橙/琥珀/黄绿/绿/青/玫红/蓝/青绿/靛/紫/粉，
  // 无同色系重影（旧版两个几乎相同的靛蓝 #6d72e8/#6366f1，RGB 距仅 18）；最接近的相邻对
  // 橙/琥珀 ≈45，远好于旧问题；配合贪心 + 交换优化，同图内书数 ≤6 时两两色距 ≥~100。
  // 色序刻意把 teal 放在 index 8：当前主书「静静的顿河」哈希落点即原色，贪心分配时主书保持稳定。
  const PALETTE = [
    '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#06b6d4',
    '#be185d', '#3b82f6', '#14b8a6', '#6366f1', '#a855f7', '#ec4899',
  ]
  
  // ── 纯工具（挂在 utils 上，node 下可单测） ─────────────────────────────
  function hashStr(s) {
    let h = 0
    const str = String(s || '')
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
    return Math.abs(h)
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

  // 拓扑排序（Kahn，子图）。边方向 = 引用方向（from 在前，to 在后），root 自然排最前。
  // 出现环时降级为按 id 稳定序，保证不挂（与 agent contextOf 同策略）。
  function topoSort(ids, edges) {
    const idSet = new Set(ids)
    const adj = new Map()
    const indeg = new Map()
    for (const id of ids) { adj.set(id, []); indeg.set(id, 0) }
    for (const e of edges) {
      if (!idSet.has(e.from) || !idSet.has(e.to)) continue
      adj.get(e.from).push(e.to)
      indeg.set(e.to, indeg.get(e.to) + 1)
    }
    const queue = [...ids].filter((id) => indeg.get(id) === 0)
    const order = []
    while (queue.length) {
      const cur = queue.shift()
      order.push(cur)
      for (const nxt of adj.get(cur)) {
        indeg.set(nxt, indeg.get(nxt) - 1)
        if (indeg.get(nxt) === 0) queue.push(nxt)
      }
    }
    return order.length === ids.length ? order : [...ids].sort()
  }

  /**
   * root→recent 路径并集（与 agent/lib/knowledge-graph.js contextOf 同规则）：
   * 目标节点沿入边反向收集所有可达祖先（含自身），多目标并集去重，按拓扑序输出。
   * @returns {{ordered: string[], roots: string[], recent: string[], pathEdges: Array}}
   *   ordered：拓扑序节点 id；roots：其中无入边的节点（最早追的知识点）；
   *   recent：目标节点（当前讨论所在节点）；pathEdges：两端都在路径上的边。
   */
  function computePath(nodes, edges, targetIds) {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const targets = (Array.isArray(targetIds) ? targetIds : [targetIds])
      .map((id) => String(id || '').trim())
      .filter((id) => id && byId.has(id))
    if (!targets.length) return { ordered: [], roots: [], recent: [], pathEdges: [] }

    const seen = new Set(targets)
    const stack = [...targets]
    while (stack.length) {
      const cur = stack.pop()
      for (const e of edges) {
        if (e.to === cur && !seen.has(e.from) && byId.has(e.from)) {
          seen.add(e.from)
          stack.push(e.from)
        }
      }
    }
    const ordered = topoSort([...seen], edges)
    const roots = ordered.filter((id) => !edges.some((e) => e.to === id && seen.has(e.from)))
    const pathEdges = edges.filter((e) => seen.has(e.from) && seen.has(e.to))
    return { ordered, roots, recent: targets, pathEdges }
  }

  // 命中按"链"分组（2026-09 用户定调）：链 = 一个命中节点的 root→recent 路径；
  // 路径节点集有交集的命中合并为同一条链（一个命中在另一命中的路径上、或共享
  // root/中间节点），互不相交的命中各自成链。返回
  // [{ hits: [被命中的节点 id...], nodes: [链上全部节点 id，拓扑序], pathEdges: [链内边] }]
  function computeChains(nodes, edges, targetIds) {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const targets = (Array.isArray(targetIds) ? targetIds : [targetIds])
      .map((id) => String(id || '').trim())
      .filter((id) => id && byId.has(id))
    const chains = []
    for (const t of targets) {
      const path = computePath(nodes, edges, [t])
      const pathSet = new Set(path.ordered)
      const overlap = chains.filter((c) => c.nodes.some((id) => pathSet.has(id)))
      if (!overlap.length) {
        chains.push({ hits: [t], nodes: path.ordered.slice(), pathEdges: path.pathEdges.slice() })
        continue
      }
      const c = overlap[0]
      c.hits.push(t)
      c.nodes = topoSort([...new Set([...c.nodes, ...path.ordered])], edges)
      for (const o of overlap.slice(1)) {
        c.hits.push(...o.hits)
        c.nodes = topoSort([...new Set([...c.nodes, ...o.nodes])], edges)
        chains.splice(chains.indexOf(o), 1)
      }
      c.pathEdges = edges.filter((e) => c.nodes.includes(e.from) && c.nodes.includes(e.to))
    }
    return chains
  }

  // 书名归一（AI-025）：冒烟数据里 book 字段形如「书名  章节」（章节号跟在书名后），
  // 取色/展示时剥离章节后缀，让同一本书的节点同色；无后缀则原样返回。
  function bookName(bookTitle) {
    return String(bookTitle || '').trim().replace(/\s{2,}.+$/, '').trim()
  }
  function bookColor(bookTitle) {
    const t = bookName(bookTitle)
    if (!t) return COLORS.nodeDefault
    return PALETTE[hashStr(t) % PALETTE.length]
  }
  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '')
    if (h.length !== 6) return { r: 128, g: 128, b: 128 }
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  function colorDist(c1, c2) {
    const a = hexToRgb(c1), b = hexToRgb(c2)
    return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
  }
  // 同图取色（AI-028）：哈希可能让两本书落到相近色（学做工/摩托日记曾同为靛蓝，RGB 距 18）。
  // 收集图中全部书名：讨论最多的书沿用哈希色（保持稳定），其余逐本贪心选「离已分配色最远」的调色板色；
  // 书数 ≤ 调色板长度时每本一色、互不相似；更多书时复用但尽量拉开。确定性、与节点顺序无关。
  function assignBookColors(books) {
    const counts = new Map()
    for (const b of books) counts.set(b, (counts.get(b) || 0) + 1)
    const sorted = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (a < b ? -1 : a > b ? 1 : 0))
    const map = new Map()
    let pool = PALETTE.slice()
    for (const b of sorted) {
      let pick
      if (map.size === 0) {
        pick = bookColor(b)
      } else {
        const usable = pool.length ? pool : PALETTE
        let best = null, bestD = -1
        for (const c of usable) {
          let minD = Infinity
          for (const used of map.values()) minD = Math.min(minD, colorDist(c, used))
          if (minD > bestD) { bestD = minD; best = c }
        }
        pick = best
      }
      map.set(b, pick)
      pool = pool.filter((c) => c !== pick)
    }
    return improveSpread(map)
  }
  // 贪心后再做局部交换优化：不动种子（讨论最多的书），逐个尝试换色，只要全局最小色距变大就保留。
  function improveSpread(map) {
    const keys = [...map.keys()]
    let cur = minPairDist(map)
    for (let pass = 0; pass < 10 && keys.length > 2; pass++) {
      let improved = false
      for (let i = 1; i < keys.length; i++) {
        const orig = map.get(keys[i])
        for (const c of PALETTE) {
          if (c === orig) continue
          map.set(keys[i], c)
          const d = minPairDist(map)
          if (d > cur + 1e-6) { cur = d; improved = true }
          else map.set(keys[i], orig)
        }
      }
      if (!improved) break
    }
    return map
  }
  function minPairDist(map) {
    const vals = [...map.values()]
    let m = Infinity
    for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
      const d = colorDist(vals[i], vals[j])
      if (d < m) m = d
    }
    return m
  }
  function fmtTime(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    const p = (x) => String(x).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  // ── 图视图 ──────────────────────────────────────────────────────────────
  class GraphView {
    /**
     * @param {object} opts
     *   receiver: string  receiver 地址（默认 http://127.0.0.1:7239）
     *   container: HTMLElement  #graph-overlay（CSS .on 控制显示，DOM 由本类构建）
     *   onPick: (node:{id,point,aliases,discussions})=>void  选择模式下双击节点回调
     *     （自由模式手动选取引用用，2026-09）
     */
    constructor(opts = {}) {
      this.recv = opts.receiver || 'http://127.0.0.1:7239'
      this.container = opts.container
      this.onPick = typeof opts.onPick === 'function' ? opts.onPick : null

      this.graph = null      // { nodes, edges, demo, updatedAt }
      this.run = null        // 运行时：{ nodes:[{id,point,aliases,discussions,books,r,x,y,vx,vy,pinned,color}], edges:[{from,to,kind}], byId }
      this.cam = { x: 0, y: 0, scale: 1 }   // 世界→屏幕：sx = (wx - cam.x)*scale + W/2
      this.hl = null         // 高亮态：{ mode:'hit'|'manual'|'search', ids:Set, edges:Set, roots:[], recent:[], targets:[], reason, at, chains? }
      this._hlHidden = false // 当前讨论命中高亮是否被用户手动隐藏（横幅按钮切换；hl 数据保留，渲染跳过）
      this._focusChain = 0   // 当前聚焦的链下标（hl.chains 内的索引；0 = 第一条）
      this._chainTimer = 0   // 多链轮播计时器（自动弹出动画：逐链展示横幅 + 聚焦）
      this._pickMode = false // 节点选取模式（自由模式手动选取引用）：单击看详情，双击选取
      this._pickSelectTimer = 0  // 选取模式下单击→详情打开的延迟计时器（防详情面板遮挡双击）
      this.hover = null      // 悬停节点 id
      this.sel = null        // 选中节点 id
      // 命中自动弹出 + 渐隐关闭（AI-020 命中动画）：图未打开时命中 → 自动打开 →
      // 播放命中路径动画（横幅 + 高亮 + 相机适配）→ 停留 → .gv-fading 渐隐关闭。
      // _autoCloseTimer：停留计时；_fadeTimer：渐隐过渡计时（CSS 0.7s 一致）。
      this._autoCloseTimer = 0
      this._fadeTimer = 0
      this._physics = { running: false, tick: 0 }
      this._anim = null      // 相机动画
      this._preFocusCam = null  // 聚焦前相机快照（取消聚焦/点空白时恢复，2026-09 用户定调——不回整体最小视图）
      this._savedState = null   // 单击预览暂存：{ hl, focusChain, hidden }——manual 覆盖消息级高亮前保存，点空白取消时原样恢复（2026-09 修复）
      this._bannerBtnKind = 'hl' // 横幅按钮类型：'hl' 高亮显隐切换 | 'clear' 清除搜索（2026-09）
      this._pulseUntil = 0
      this._pendingChainFit = false   // 物理收敛时的一次性命中聚焦校准挂起标记（2026-10）
      this._dragging = null
      // 悬停过渡（AI-027）：压暗/放大/pill 淡入淡出按帧缓动，不再闪变
      this._nodeDim = new Map()   // 节点压暗强度 0..1（1 = 非邻接全暗）
      this._edgeDim = new Map()   // 边压暗强度 0..1
      this._mag = new Map()       // 放大 + 标签 pill 淡入强度 0..1
      this._raf = 0
      this._built = false
      this._bound = false
      this._loadPromise = null   // 加载中的 promise（防重入：open 与 applyHit 并发加载时复用）
      this._open = false
      this._demo = false
      this._free = false   // 自由模式沙盒图（/graph?free=1，测试固化产物）
      this._source = 'file'   // 图数据来源：file（固化图）| results（冒烟有效图）| demo（演示拓扑）| free（自由模式沙盒图）
      this._baseScale = 0       // 内容长度分级基准 = 初始 fit scale（决定初始化显示多短）
      this._bookColors = null   // 同图取色表（AI-028）：buildRun 时按全部书名贪心分配
      this._detailFont = 15    // 详情正文基准字号（AI-032），A± 缩放 13~22px，localStorage 记忆
      this._detailFontMin = 13
      this._detailFontMax = 22
      try { const v = +localStorage.getItem('coread.graphDetailFont'); if (v >= this._detailFontMin && v <= this._detailFontMax) this._detailFont = v } catch {}
      this._w = 0
      this._h = 0
      this._ro = null
    }

    // ── 公开接口 ──────────────────────────────────────────────────────────
    // 打开遮罩的公共部分（open 与命中自动弹出共用）：显示容器、建 DOM、绑定事件、
    // 清残留渐隐态。不做数据加载（调用方各自决定拉图时机）。
    _openOverlay() {
      this._open = true
      if (!this.container) return
      this.container.classList.add('on')
      this.container.classList.remove('gv-fading')
      if (!this._built) this._build()
      this._bind()
      this._resize()
      // 双保险（AI-021）：display:none → flex 切换后 clientWidth/clientHeight 常要到
      // 下一帧才稳定，直接读可能是 0（canvas 按 0 尺寸渲染成空画布）。等一帧再测一次。
      requestAnimationFrame(() => { if (this._open) { this._resize(); this.render() } })
    }
    open() {
      this._cancelAutoDismiss()   // 用户手动打开：取消挂起的自动渐隐（命中动画让位）
      this._openOverlay()
      this.loadGraph(this._demo, this._free)   // 每次打开重拉一次，图文件更新即生效
    }
    close() {
      this._open = false
      this.hover = null
      this._physics.running = false   // 关闭时停掉常驻物理/渲染循环，避免后台空转
      this._hideTooltip()
      this._savedState = null   // 关闭即丢弃 manual 暂存（下次打开重拉图，命中态按 targets 重算）
      if (this.container) this.container.classList.remove('on')
      // 关闭即退出选取模式（下次进入由侧栏重新 setPickMode(true)）
      if (this._pickMode) this.setPickMode(false)
    }
    isOpen() { return this._open }

    /**
     * SSE graph-hit 命中（无论自由模式还是读书模式，行为一致）：
     * - 图未打开 → 自动弹出拓扑图 → 播放命中路径动画（横幅 + 高亮 + 相机适配，
     *   横幅即命中通知）→ 停留后渐隐关闭（.gv-fading，0.7s opacity）。
     * - 图已打开（用户正在浏览）→ 直接应用命中高亮，不自动关闭。
     */
    onHit(hits, reason) {
      const ids = (Array.isArray(hits) ? hits : []).filter(Boolean)
      if (!ids.length) return
      console.log('[CoRead][gv] onHit', ids.length, String(reason || '').slice(0, 24), 'open=', this._open)
      this._cancelAutoDismiss()   // 新命中取消挂起的自动渐隐（旧动画让位）
      if (!this._open) {
        this._autoShowHit(ids, reason || '')
        return
      }
      this.applyHit(ids, reason || '', 'hit')
    }

    // 命中自动弹出 + 渐隐关闭：打开遮罩 → 等图加载并应用命中（root→recent 路径
    // 高亮 + 横幅通知 + 相机适配）→ 按链展示：单链停留后渐隐关闭；多链轮播
    // （每条链横幅 + 聚焦，全部播完再渐隐关闭）。
    async _autoShowHit(hits, reason) {
      this._openOverlay()
      await this.applyHit(hits, reason, 'hit')
      if (!this.graph) { this.close(); return }   // 图加载失败：不演动画，直接收起
      const chains = this.hl && this.hl.chains
      if (chains && chains.length > 1) {
        this._startChainCarousel(chains.length)
      } else {
        clearTimeout(this._autoCloseTimer)
        this._autoCloseTimer = setTimeout(() => this.fadeOutClose(), 3200)
      }
    }

    // 渐隐关闭：加 .gv-fading（opacity 0，transition 0.7s）→ 过渡结束后再真正
    // close（display:none）。过渡期间用户手动打开/关闭都安全（open 清 fading，
    // close 幂等）。
    fadeOutClose() {
      if (!this._open || !this.container) return
      this.container.classList.add('gv-fading')
      clearTimeout(this._fadeTimer)
      this._fadeTimer = setTimeout(() => {
        this.container.classList.remove('gv-fading')
        this.close()
      }, 700)
    }

    // 取消挂起的自动渐隐（新命中/用户手动打开时调用），并清残留渐隐态
    _cancelAutoDismiss() {
      clearTimeout(this._autoCloseTimer)
      clearTimeout(this._fadeTimer)
      clearTimeout(this._chainTimer)
      if (this.container) this.container.classList.remove('gv-fading')
    }

    /** 切换图数据来源：'formal'（正式固化图）| 'demo'（演示拓扑）| 'free'（自由模式沙盒图）。
     *  侧栏自由模式入口/退出时调用；开着时立即重拉，关着时下次打开生效。 */
    setMode(mode) {
      if (mode === 'free') { this._free = true; this._demo = false }
      else if (mode === 'demo') { this._demo = true; this._free = false }
      else { this._demo = false; this._free = false }
      this._cancelAutoDismiss()   // 用户主动切数据源：取消挂起的自动渐隐
      if (this._open) this.loadGraph(this._demo, this._free)
    }

    /** 图文件更新（SSE graph-updated）：开着就重拉；重拉后保留高亮（按 targets 重算） */
    reload() {
      if (!this._open) return
      this.loadGraph(this._demo, this._free)
    }

    /** 重新拉图并（重）布局。返回 Promise<graph|null>。
     *  防重入（2026-10）：open() 与 applyHit/applyStackHits 可能并发触发加载
     *  （打开图按钮 → open 立即 loadGraph，refreshStackHits 的命中恢复里若图还没
     *  加载完也会 loadGraph），复用同一个 promise——否则两次 buildRun + 两次
     *  fitToNodes 竞态：后完成的 fitToNodes(全图) 会把先完成的命中链聚焦覆盖掉，
     *  正是"栈有命中时打开拓扑图聚焦位置不对"的根因（隐藏高亮后图已加载，
     *  命中恢复不再触发第二次加载，所以没这个问题）。 */
    async loadGraph(demo, free) {
      if (this._loadPromise) return this._loadPromise
      this._loadPromise = this._doLoad(demo, free)
      try { return await this._loadPromise } finally { this._loadPromise = null }
    }
    async _doLoad(demo, free) {
      this._demo = !!demo
      if (free !== undefined) this._free = !!free
      this._setLoading('加载中…')
      try {
        const q = this._demo ? '?demo=1' : this._free ? '?free=1' : ''
        const res = await fetch(this.recv + '/graph' + q)
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const g = await res.json()
        this.graph = {
          nodes: Array.isArray(g.nodes) ? g.nodes : [],
          edges: Array.isArray(g.edges) ? g.edges : [],
          demo: !!g.demo,
          free: !!g.free,
          updatedAt: g.updatedAt || 0,
        }
        this._demo = this.graph.demo
        this._free = this.graph.free
        this._source = g.source || (this._demo ? 'demo' : this._free ? 'free' : 'file')
        this._updateSourceBadge()
        this.buildRun()
        this._renderBookLegend()
        this._setLoading('')
        if (this.run.nodes.length === 0) {
          this._setEmpty(true, '会意图还没有节点：固化流程还没写出图文件。\n可先「载入演示拓扑」预览交互与命中高亮。')
          this.closeDetail()   // 空态时收起可能残留的详情面板
        }
        else this._setEmpty(false)
        // 保留高亮：按 targets 用新图重算
        if (this.hl && this.hl.targets && this.hl.targets.length) this.recomputeHighlight()
        this.startPhysics()
        this._baseScale = 0   // 重算内容长度分级基准（初始 fit scale）
        this.fitToNodes(this.run.nodes, false)
        // 注：这里不做"有命中态就聚焦链"（2026-10 试过又去掉）——加载完成瞬间
        // 物理刚从环形初始布局开始收敛，此刻 _fitToChain 的目标坐标未稳定，聚焦
        // 位置不对；命中聚焦统一交给物理收敛后的 _pendingChainFit 落位
        this._renderBanner()   // 重开图时搜索框残留旧词 → 恢复搜索横幅（2026-10）
        this.render()
        return this.graph
      } catch (e) {
        this._setLoading('')
        this._setEmpty(true, '加载拓扑失败（receiver 未启动？），可重试。', true)
        console.warn('[CoRead] graph load failed:', e)
        return null
      }
    }

    /** 命中应用：算 root→recent 路径并集 → 高亮 + 横幅 + 适配相机（手动高亮不动相机）。
     *  noFit=true：不播聚焦动画（打开图场景用——物理未收敛时动画目标基于环形
     *  初始布局的瞬时坐标，位置不对；聚焦交给物理收敛后的 _pendingChainFit 落位） */
    async applyHit(hits, reason, mode, noFit) {
      console.log('[CoRead][gv] applyHit', mode, 'hits=', (hits || []).length, 'noFit=', !!noFit)
      if (!this.graph) {
        const g = await this.loadGraph(this._demo, this._free)
        if (!g) return
      }
      const result = computePath(this.run.nodes, this.run.edges, hits)
      console.log('[CoRead][gv] applyHit ordered=', result.ordered.length)
      if (!result.ordered.length) {
        return
      }
      this.setHighlight(result, mode || 'hit', reason || '')
      if (mode !== 'manual' && !noFit) {
        this._fitToChain()
      }
    }

    /** 当前讨论命中（2026-09 用户定调）：命中 = 当前实时栈 cites 的节点脉络。
     *  打开图 / 收到 stack-updated / 切书时由侧栏调用：hits 非空 → 恢复
     *  "当前讨论命中"高亮 + 横幅；hits 空（栈已收口结束）→ 清除 hit 态高亮
     *  （不动 manual / search 高亮）。 */
    applyStackHits(hits) {
      console.log('[CoRead][gv] applyStackHits', Array.isArray(hits) ? hits.length : 'n/a', 'hl=', this.hl && this.hl.mode, 'at-ago=', this.hl ? Math.round((Date.now() - this.hl.at) / 1000) + 's' : '-')
      if (!Array.isArray(hits) || !hits.length) {
        // 命中动画保护（2026-10）：graph-hit 刚应用（4s 内）时，栈刷新的空结果
        // 不得立刻清除命中横幅——receiver 3s 轮询/栈写入滞后都可能让 /stack-hits
        // 暂时返回空（新消息尚未固化入栈），此时清横幅会把"消息命中"反馈吞掉；
        // 动画播完、用户稳定浏览后，栈收口清空才正常清除（2026-09 用户定调）
        if (this.hl && this.hl.mode === 'hit' && Date.now() - this.hl.at > 4000) this.clearHighlight()
        return
      }
      // 打开图（图还没加载）时 noFit：不播聚焦动画——物理刚从环形初始布局开始
      // 收敛，动画目标基于未稳定的瞬时坐标，聚焦位置不对；改为物理收敛后由
      // _pendingChainFit 一次性落位。图已加载的栈刷新/切书恢复保持动画聚焦。
      const needLoad = !this.graph
      if (needLoad) this._pendingChainFit = true   // 打开图场景：收敛后落位链聚焦
      return this.applyHit(hits, '', 'hit', needLoad)
    }

    // 聚焦当前链：相机适配到 _focusChain 指向的链节点；无链/无高亮 → 整体视图。
    // noAnim=true：直接落位（物理收敛后/动画结束时的校准用，不再播动画）
    _fitToChain(noAnim) {
      if (!this.run) return
      const chains = this.hl && this.hl.chains
      const c = chains && chains.length ? chains[Math.min(this._focusChain, chains.length - 1)] : null
      const ids = c ? c.nodes : (this.hl ? [...this.hl.ids] : [])
      const nodes = ids.map((id) => this.run.byId.get(id)).filter(Boolean)
      this.fitToNodes(nodes.length ? nodes : this.run.nodes, !noAnim)
    }

    // 用户手动切换聚焦链：取消自动轮播与渐隐（用户在看，不自动关闭），聚焦所选链
    focusChain(i) {
      this._cancelChainCarousel()
      this._focusChain = i
      this._renderBanner()
      this._renderChainSwitch()
      this._fitToChain()
    }

    // 聚焦到某节点所在的链（多链高亮时；选取新链节点后由侧栏调用，2026-09）。
    // 节点不在任何链 / 单链 → 不动。
    focusNodeChain(id) {
      const chains = this.hl && this.hl.chains
      if (!chains || chains.length <= 1) return
      const ci = chains.findIndex((c) => c.hits.includes(id) || c.nodes.includes(id))
      if (ci >= 0 && ci !== this._focusChain) this.focusChain(ci)
    }

    // 多链轮播（自动弹出动画）：依次展示每条链（横幅切换 + 聚焦），每条停留后
    // 播放下一条；全部播完 → 渐隐关闭。用户交互（切链/隐藏/手动打开）会取消。
    _startChainCarousel(n) {
      clearTimeout(this._chainTimer)
      const step = () => {
        if (!this._open) return
        if (this._focusChain >= n - 1) {
          clearTimeout(this._autoCloseTimer)
          this._autoCloseTimer = setTimeout(() => this.fadeOutClose(), 3200)
          return
        }
        this._focusChain++
        this._renderBanner()
        this._renderChainSwitch()
        this._fitToChain()
        this._chainTimer = setTimeout(step, 2600)
      }
      this._chainTimer = setTimeout(step, 2600)   // 第 0 条链停留后切下一条
    }
    _cancelChainCarousel() {
      clearTimeout(this._chainTimer)
      clearTimeout(this._autoCloseTimer)
    }

    /** 节点选取模式（2026-09，自由模式手动选取引用）：
     *  开启后提示条切换为「单击看详情 · 双击选取」，双击节点回调 opts.onPick。
     *  关闭图视图自动退出。 */
    setPickMode(on) {
      this._pickMode = !!on
      const hint = this.container && this.container.querySelector('.gv-hint')
      if (hint) {
        hint.textContent = this._pickMode
          ? '单击查看详情 · 双击选取为引用'
          : '滚轮缩放 · 拖空白平移 · 悬停节点看名称 · 点选看详情'
      }
    }

    /** 手动：高亮某节点的 root→recent 路径（详情面板按钮） */
    highlightFrom(nodeId, mode) {
      const n = this.run && this.run.byId.get(nodeId)
      if (!n) return
      const result = computePath(this.run.nodes, this.run.edges, [nodeId])
      this.setHighlight(result, mode || 'manual', '')
      if (mode === 'simulate') this._fitToChain()   // 演示命中：按链聚焦
    }

    setHighlight(result, mode, reason) {
      // 聚焦前相机快照：只在非 manual 时保存（2026-09 修复——manual 是临时预览，
      // 若覆盖快照，之后隐藏命中脉络会恢复到 manual 聚焦后的状态，而不是命中前的状态）
      if (mode !== 'manual') this._preFocusCam = { x: this.cam.x, y: this.cam.y, scale: this.cam.scale }
      // 新命中/选取（消息级状态）覆盖一切：清掉暂存的旧状态。
      // search 不清——搜索是临时定位，暂存由输入处负责，"清除搜索"时恢复。
      if (mode === 'hit' || mode === 'picked') this._savedState = null
      const hl = {
        mode: mode || 'manual',
        ids: new Set(result.ordered),
        edges: new Set(result.pathEdges),
        roots: result.roots,
        recent: result.recent,
        targets: result.recent,
        reason: reason || '',
        at: Date.now(),
      }
      this.hl = hl
      this._hlHidden = false   // 新命中/搜索/手动高亮：总是先显示
      // 命中按链分组（自动弹出 / 模拟 / 手动高亮 / 手动选取统一按链展示与聚焦）
      hl.chains = (mode === 'hit' || mode === 'simulate' || mode === 'manual' || mode === 'picked')
        ? computeChains(this.run ? this.run.nodes : [], this.run ? this.run.edges : [], result.recent)
        : null
      this._focusChain = 0
      this._pulseUntil = Date.now() + 1600
      this._renderBanner()
      this._renderChainSwitch()
      this._ensureLoop()
    }
    recomputeHighlight() {
      if (!this.hl || !this.hl.targets || !this.hl.targets.length) return
      const result = computePath(this.run.nodes, this.run.edges, this.hl.targets)
      if (!result.ordered.length) { this.clearHighlight(); return }
      this.hl.ids = new Set(result.ordered)
      this.hl.edges = new Set(result.pathEdges)
      this.hl.roots = result.roots
      this.hl.recent = result.recent
      // 图重载后链按新图重算；聚焦下标越界则回 0
      this.hl.chains = computeChains(this.run.nodes, this.run.edges, this.hl.targets)
      if (this._focusChain >= (this.hl.chains || []).length) this._focusChain = 0
      this._pendingChainFit = true   // 图重载后物理重跑，收敛时同样校准链聚焦（2026-10）
      this._renderBanner()
      this._renderChainSwitch()
    }
    clearHighlight() {
      this.hl = null
      this._hlHidden = false
      this._focusChain = 0
      this._preFocusCam = null
      this._savedState = null
      this._pendingChainFit = false
      this._renderBanner()
      this._renderChainSwitch()
      this.render()
    }

    /** 横幅按钮：显示 / 隐藏当前讨论命中高亮（hl 数据保留，隐藏只是不渲染——恢复显示
     *  不依赖重新命中；下一次命中/搜索/手动高亮会自动回到显示态）。
     *  聚焦语义：显示 → 聚焦当前链；隐藏 → 取消聚焦（相机回到整体视图）。 */
    toggleHighlightHidden() {
      this._hlHidden = !this._hlHidden
      this._cancelChainCarousel()   // 用户主动操作：取消轮播与自动渐隐（图保持打开）
      this._renderBanner()
      this._renderChainSwitch()
      this.render()
      if (this._hlHidden) {
        // 取消聚焦：回到聚焦前用户的缩放状态（2026-09 用户定调，不再默认回整体最小视图）
        if (this._preFocusCam) this._animCam(this._preFocusCam)
        else if (this.run) this.fitToNodes(this.run.nodes, true)
      } else {
        this._fitToChain()   // 恢复显示：聚焦当前链
      }
    }

    selectNode(id) {
      // 单击预览（manual）：若当前有消息级高亮（hit / picked / search），整个暂存起来，
      // 点空白取消时原样恢复——单击聚焦是临时预览，不销毁命中态（2026-09 用户定调修复：
      // 否则取消聚焦后命中横幅与非聚焦标识会一起消失）
      if (!this._savedState && this.hl && this.hl.mode !== 'manual') {
        this._savedState = { hl: this.hl, focusChain: this._focusChain, hidden: this._hlHidden }
      }
      this.sel = id
      // 单击节点：高亮并聚焦它的临时讨论脉络（root→recent，2026-09 用户定调——
      // 替代详情面板里已删除的「高亮此节点路径」按钮）
      this.highlightFrom(id, 'manual')
      this._fitToChain()
      this._renderDetail()
      this.render()
    }
    closeDetail() {
      this.sel = null
      this._hideDetail()
      this.render()
    }

    // ── 运行时构建 / 物理 ──────────────────────────────────────────────────
    buildRun() {
      const g = this.graph
      const rnd = mulberry32(20260828)
      // 同图取色（AI-028）：先收集全部书名做贪心分配，保证两本书颜色显著不同
      const bookNames = []
      for (const n of g.nodes) for (const d of (n.discussions || [])) { const b = bookName(d.book); if (b) bookNames.push(b) }
      const bookColors = assignBookColors(bookNames)
      this._bookColors = bookColors
      const nodes = g.nodes.map((n, i) => {
        const discussions = Array.isArray(n.discussions) ? n.discussions : []
        const books = [...new Set(discussions.map((d) => bookName(d.book)).filter(Boolean))]
        const ang = (i / Math.max(g.nodes.length, 1)) * Math.PI * 2 + rnd() * 0.5
        const rad = 260 + rnd() * 130
        return {
          id: n.id,
          point: String(n.point || n.id || ''),
          aliases: Array.isArray(n.aliases) ? n.aliases : [],
          discussions,
          books,
          r: clamp(8 + Math.log2(discussions.length + 1) * 4.5, 8, 23),
          x: rad * Math.cos(ang),
          y: rad * Math.sin(ang),
          vx: 0, vy: 0,
          pinned: false,
          color: bookColors.get(books[0]) || COLORS.nodeDefault,
          createdAt: n.createdAt || 0,
          updatedAt: n.updatedAt || 0,
        }
      })
      const edges = g.edges.map((e) => ({
        from: e.from, to: e.to,
        kind: e.kind === 'derived' ? 'derived' : 'user',
      }))
      const byId = new Map(nodes.map((n) => [n.id, n]))
      // 邻接表（角分辨率约束 AI-037 用）：nodeId → Set(邻居 nodeId)，忽略方向（无自环）
      const adj = new Map(nodes.map((n) => [n.id, new Set()]))
      for (const e of edges) { adj.get(e.from).add(e.to); adj.get(e.to).add(e.from) }
      this.run = { nodes, edges, byId, adj }
      this._nodeDim.clear(); this._edgeDim.clear(); this._mag.clear()   // 新图重置悬停过渡（AI-027）
    }

    startPhysics() {
      this._physics.running = true
      this._physics.tick = 0
      this._ensureLoop()
    }

    // 一帧物理（返回是否仍在运动）
    tickPhysics() {
      const run = this.run
      if (!run || !run.nodes.length) return false
      const t = this._physics.tick
      const heat = Math.max(0.25, 1 - t / TICKS)
      const ns = run.nodes
      // 弹性联动判定（AI-037）：仅在「真正拖动已移动过的节点」时才关闭静止摩擦，
      // 让相连子图随目标弹性联动；单纯按下/点击/平移不解除摩擦 → 图不漂、不聚拢。
      const elasticDragging = !!(this._dragging && this._dragging.kind === 'node' && this._dragging.moved)
      // 重心
      let cx = 0, cy = 0
      for (const n of ns) { cx += n.x; cy += n.y }
      cx /= ns.length; cy /= ns.length
      // 斥力（O(n²)，节点量级 <200 够用）
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const a = ns[i], b = ns[j]
          let dx = b.x - a.x, dy = b.y - a.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = dx * dx + dy * dy || 1 }
          const d = Math.sqrt(d2)
          const f = Math.min(REPULSION / d2 * heat, 60)
          const fx = (dx / d) * f, fy = (dy / d) * f
          if (!a.pinned) { a.vx -= fx; a.vy -= fy }
          if (!b.pinned) { b.vx += fx; b.vy += fy }
        }
      }
      // 弹簧（沿边）
      for (const e of run.edges) {
        const a = run.byId.get(e.from), b = run.byId.get(e.to)
        if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = SPRING * (d - REST_LEN) * heat
        const fx = (dx / d) * f, fy = (dy / d) * f
        if (!a.pinned) { a.vx += fx; a.vy += fy }
        if (!b.pinned) { b.vx -= fx; b.vy -= fy }
      }
      // 角分辨率约束（AI-037）：节点处把「入射/出射射线夹角」约束进可读带 [ANG_MIN, π-ANG_MIN]。
      // 防两类退化：①近乎重合/折返（夹角≈0，两条边叠成一根）→ 掰开拉大；
      // ②链式直穿（三点共线单调链，夹角≈180）→ 仅在纯链节点（度=2）弯折。
      // 切向力与径向弹簧/斥力正交，不破坏边长；只推邻居节点、枢纽 B 不动；
      // 夹角入带即停（不再施力）→ 收敛为可读布局，静止期不抖。
      for (const b of ns) {
        const neigh = run.adj.get(b.id)
        if (!neigh || neigh.size < 2) continue
        const deg = neigh.size
        const angMin = Math.min(ANG_MIN, Math.PI / deg)   // 高自由度用更小最小角，保证可满足
        const isChain = deg === 2
        const list = [...neigh]
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const u = run.byId.get(list[i]), v = run.byId.get(list[j])
            if (!u || !v || (u.pinned && v.pinned)) continue
            const duX = u.x - b.x, duY = u.y - b.y, dvX = v.x - b.x, dvY = v.y - b.y
            const lu = Math.hypot(duX, duY), lv = Math.hypot(dvX, dvY)
            if (lu < 1e-3 || lv < 1e-3) continue
            const dot = clamp((duX * dvX + duY * dvY) / (lu * lv), -1, 1)
            const ang = Math.acos(dot)
            if (ang >= angMin && ang <= Math.PI - ANG_MIN) continue   // 已可读
            if (ang > Math.PI - ANG_MIN && !isChain) continue          // 高自由度节点不纠直穿
            const cross = duX * dvY - duY * dvX
            const phi = Math.atan2(cross, dot)
            const sp = phi !== 0 ? Math.sign(phi) : (u.id < v.id ? 1 : -1)
            const tuX = -duY / lu, tuY = duX / lu, tvX = -dvY / lv, tvY = dvX / lv
            const dirU = ang < angMin ? -sp : sp
            const dirV = ang < angMin ? sp : -sp
            const deficit = ang < angMin ? (angMin - ang) : (ang - (Math.PI - ANG_MIN))
            const F = Math.min(deficit * ANG_GAIN, ANG_PUSH_MAX)
            if (!u.pinned) { u.vx += tuX * dirU * F; u.vy += tuY * dirU * F }
            if (!v.pinned) { v.vx += tvX * dirV * F; v.vy += tvY * dirV * F }
          }
        }
      }
      // 重心引力 + 积分
      let energy = 0
      for (const n of ns) {
        if (!n.pinned) {
          n.vx += (cx - n.x) * GRAVITY * heat
          n.vy += (cy - n.y) * GRAVITY * heat
          n.vx *= DAMPING; n.vy *= DAMPING
          const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
          if (sp > MAX_SPEED) { n.vx = n.vx / sp * MAX_SPEED; n.vy = n.vy / sp * MAX_SPEED }
          // 静止摩擦（AI-024）：未拖拽时低速额外耗散 → 静止安静不发飘；
          // 拖拽中不启用摩擦 → 即使慢慢拖动，邻接节点也能弹性联动。
          if (sp < FRICTION_V && !elasticDragging) { n.vx *= FRICTION_K; n.vy *= FRICTION_K }
          n.x += n.vx; n.y += n.vy
          energy += n.vx * n.vx + n.vy * n.vy
        }
      }
      this._physics.tick++
      return energy / ns.length > SETTLE_E && this._physics.tick < TICKS
    }
    // 标签屏幕盒子（AI-022）：与渲染同一套分级/换行/字号，返回屏幕像素矩形 {x,y,w,h}。
    // 屏幕坐标便于直接比较可见重叠；用 world 位移弹开时再除以 cam.scale。
    _labelBoxScreen(n) {
      const scale = this.cam.scale || 1
      const fontPx = clamp(Math.round(11 * scale), 11, 24)
      const ratio = scale / (this._baseScale || scale || 1)
      const chars = ratio < 0.8 ? 6 : (ratio < 1.2 ? 9 : (ratio < 1.7 ? 13 : (ratio < 2.6 ? 17 : 20)))
      const linesN = ratio < 0.8 ? 1 : (ratio < 1.2 ? 2 : 3)
      this.ctx.font = fontPx + 'px -apple-system, BlinkMacSystemFont, \'PingFang SC\', \'Helvetica Neue\', sans-serif'
      const wrapped = wrapText(n.point, chars, linesN)
      let maxWpx = 0
      for (const l of wrapped) { const w = this.ctx.measureText(l).width; if (w > maxWpx) maxWpx = w }
      const bw = maxWpx + 12
      const bh = linesN * fontPx * 1.3 + 6
      const px = (n.x - this.cam.x) * scale + this._w / 2
      const py = (n.y - this.cam.y) * scale + this._h / 2
      return { x: px - bw / 2, y: py + n.r * scale + 4 - 3, w: bw, h: bh }
    }

    // 碰撞弹开（AI-023）：节点运动 / 相机动画 / 拖拽过程中，若「节点圆」或「标签盒子」在屏幕
    // 上重叠，就把节点推开，直到恰好分离。四类碰撞全部检测：圆-圆沿圆心连线弹开；标签-标签沿
    // 较小穿透轴（MTV）弹开；圆-标签/标签-圆沿圆心到矩形最近点连线弹开（圆不压字、字不压圆）。
    // 位置式修正，只作用于运动期，运动结束即收敛为 「不重叠」 的稳定布局；
    // 不运动时不动布局，避免干扰已读的图。
    _separateLabels() {
      const ns = this.run && this.run.nodes
      if (!ns || ns.length < 2) return false
      const scale = this.cam.scale || 1
      const cam = this.cam
      // 标签碰撞与渲染同门槛（AI-026）：低于 LABEL_MIN_SCALE 标签不画，也不参与碰撞，
      // 否则缩小时看不见的标签盒子会按 overlap/scale 疯狂推开节点（越小越剧烈）。
      const labelsActive = cam.scale >= LABEL_MIN_SCALE
      const boxes = ns.map((n) => labelsActive ? this._labelBoxScreen(n) : { x: 0, y: 0, w: 0, h: 0 })
      const sx = (wx) => (wx - cam.x) * scale + this._w / 2
      const sy = (wy) => (wy - cam.y) * scale + this._h / 2
      let moved = false
      // 单节点每帧位移预算（AI-026）：一次碰撞修正里每个节点最多移动 MAX_STEP 世界单位，
      // 需要大范围重排时逐帧渐进完成，避免缩放/拖拽时瞬间甩飞（乱碰）。
      const budget = new Map(ns.map((n) => [n, MAX_STEP]))
      const moveNode = (n, dx, dy, box) => {
        const rem = budget.get(n)
        if (!(rem > 0)) return
        const dist = Math.hypot(dx, dy)
        if (!(dist > 0)) return
        const use = Math.min(dist, rem)
        const k = use / dist
        n.x += dx * k; n.y += dy * k
        budget.set(n, rem - use)
        if (box) { box.x += dx * k * scale; box.y += dy * k * scale }
      }
      for (let iter = 0; iter < 12; iter++) {
        let any = false
        for (let i = 0; i < ns.length; i++) {
          for (let j = i + 1; j < ns.length; j++) {
            const a = ns[i], b = ns[j]
            const mi = a.pinned ? 0 : 1, mj = b.pinned ? 0 : 1
            if (mi + mj === 0) continue
            const A = boxes[i], B = boxes[j]
            // 1) 节点圆-圆重叠：沿圆心连线弹开
            const ax = sx(a.x), ay = sy(a.y), bx = sx(b.x), by = sy(b.y)
            let dx = bx - ax, dy = by - ay
            let d = Math.hypot(dx, dy)
            const minD = (a.r + b.r) * scale
            if (d < minD - COLLIDE_PAD) {
              if (d < 1e-6) { dx = 1; dy = 0; d = 1 }
              const nx = dx / d, ny = dy / d
              const pen = Math.min((minD - d - COLLIDE_PAD) / scale, MAX_PUSH)
              const av = pen * (mi / (mi + mj)), bv = pen * (mj / (mi + mj))
              any = true; moved = true
              if (mi) moveNode(a, -nx * av, -ny * av, A)
              if (mj) moveNode(b, nx * bv, ny * bv, B)
            }
            // 2) 标签盒子重叠：沿较小穿透轴（MTV）弹开
            const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)
            const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)
            const overPx = Math.min(ox, oy) - COLLIDE_PAD
            if (overPx > 0) {
              any = true; moved = true
              if (ox < oy) {
                const dir = (A.x + A.w / 2) < (B.x + B.w / 2) ? -1 : 1
                const pen = Math.min(overPx / scale, MAX_PUSH)
                const av = pen * (mi / (mi + mj)), bv = pen * (mj / (mi + mj))
                if (mi) moveNode(a, dir * av, 0, A)
                if (mj) moveNode(b, -dir * bv, 0, B)
              } else {
                const dir = (A.y + A.h / 2) < (B.y + B.h / 2) ? -1 : 1
                const pen = Math.min(overPx / scale, MAX_PUSH)
                const av = pen * (mi / (mi + mj)), bv = pen * (mj / (mi + mj))
                if (mi) moveNode(a, 0, dir * av, A)
                if (mj) moveNode(b, 0, -dir * bv, B)
              }
            }
            // 3) 节点 i 的标签 vs 节点 j 的圆：圆不能压住标签
            {
              const ccx = clamp(bx, A.x, A.x + A.w), ccy = clamp(by, A.y, A.y + A.h)
              let ddx = bx - ccx, ddy = by - ccy
              let dist = Math.hypot(ddx, ddy)
              if (dist < b.r * scale - COLLIDE_PAD) {
                let nx, ny
                if (dist > 1e-6) { nx = ddx / dist; ny = ddy / dist }
                else {
                  const l = bx - A.x, rg = A.x + A.w - bx, tp = by - A.y, bt = A.y + A.h - by
                  const m = Math.min(l, rg, tp, bt)
                  if (m === l) { nx = -1; ny = 0 } else if (m === rg) { nx = 1; ny = 0 }
                  else if (m === tp) { nx = 0; ny = -1 } else { nx = 0; ny = 1 }
                }
                const pen = Math.min((b.r * scale - dist - COLLIDE_PAD) / scale, MAX_PUSH)
                const av = pen * (mi / (mi + mj)), bv = pen * (mj / (mi + mj))
                any = true; moved = true
                if (mi) moveNode(a, -nx * av, -ny * av, A)
                if (mj) moveNode(b, nx * bv, ny * bv, B)
              }
            }
            // 4) 节点 j 的标签 vs 节点 i 的圆：圆不能压住标签
            {
              const ccx = clamp(ax, B.x, B.x + B.w), ccy = clamp(ay, B.y, B.y + B.h)
              let ddx = ax - ccx, ddy = ay - ccy
              let dist = Math.hypot(ddx, ddy)
              if (dist < a.r * scale - COLLIDE_PAD) {
                let nx, ny
                if (dist > 1e-6) { nx = ddx / dist; ny = ddy / dist }
                else {
                  const l = ax - B.x, rg = B.x + B.w - ax, tp = ay - B.y, bt = B.y + B.h - ay
                  const m = Math.min(l, rg, tp, bt)
                  if (m === l) { nx = -1; ny = 0 } else if (m === rg) { nx = 1; ny = 0 }
                  else if (m === tp) { nx = 0; ny = -1 } else { nx = 0; ny = 1 }
                }
                const pen = Math.min((a.r * scale - dist - COLLIDE_PAD) / scale, MAX_PUSH)
                const av = pen * (mi / (mi + mj)), bv = pen * (mj / (mi + mj))
                any = true; moved = true
                if (mi) moveNode(a, nx * av, ny * av, A)
                if (mj) moveNode(b, -nx * bv, -ny * bv, B)
              }
            }
          }
        }
        if (!any) break
      }
      return moved
    }

    // ── 渲染 ──────────────────────────────────────────────────────────────
    render() {
      const run = this.run
      const cv = this.canvas
      if (!cv || !this._w || !this._h) return
      const ctx = this.ctx
      const dpr = window.devicePixelRatio || 1
      if (cv.width !== Math.round(this._w * dpr) || cv.height !== Math.round(this._h * dpr)) {
        cv.width = Math.round(this._w * dpr)
        cv.height = Math.round(this._h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, this._w, this._h)
      if (!run || !run.nodes.length) return

      const W = this._w, H = this._h, cam = this.cam
      const labelFontPx = clamp(Math.round(11 * cam.scale), 11, 24)   // 标签字号随缩放：放大图文字变大(12→24)
      const tx = (x) => (x - cam.x) * cam.scale + W / 2
      const ty = (y) => (y - cam.y) * cam.scale + H / 2

      const hl = this._hlHidden ? null : this.hl   // 手动隐藏：跳过高亮渲染（数据保留）
      const hlHidden = this._hlHidden && this.hl ? this.hl : null   // 隐藏模式的残留标识数据源
      const hlIds = hl ? hl.ids : null
      const hlEdges = hl ? hl.edges : null
      // 悬停邻接子图（有路径高亮时不压暗，悬停只出标签/提示）；压暗强度走缓动值（AI-027）
      const hoverOn = !!this.hover && !hlIds

      // 边
      for (const e of run.edges) {
        const a = run.byId.get(e.from), b = run.byId.get(e.to)
        if (!a || !b) continue
        let alpha = 0.62
        let onPath = false
        let faintChain = false   // 隐藏模式：链内连接线标记
        if (hlIds) { onPath = hlEdges.has(e); alpha = onPath ? 1 : 0.16 }
        else if (hlHidden) { faintChain = hlHidden.edges.has(e); alpha = faintChain ? 0.9 : 0.62 }
        else if (hoverOn) alpha = 0.62 - (this._edgeDim.get(e.from + '>' + e.to) || 0) * 0.5
        ctx.globalAlpha = alpha
        ctx.strokeStyle = faintChain ? COLORS.pathAccent : (onPath && hlIds ? COLORS.pathAccent : (e.kind === 'user' ? COLORS.edgeUser : COLORS.edgeDerived))
        ctx.lineWidth = faintChain ? 2 : (onPath && hlIds ? 2.2 : 1.4)
        const x1 = tx(a.x), y1 = ty(a.y), x2 = tx(b.x), y2 = ty(b.y)
        // 曲边（AI-034）：从圆心直线改成二次贝塞尔，控制点沿 from→to 方向的垂线偏移。
        // 关键：偏移只由「边的方向」决定（取一致的旋转侧）→ 同一对节点的正反向边
        // （X→Y 与 Y→X）、折返链（A→B→C 且近似共线）因方向反转而自动弯向相反侧，
        // 不再共用同一条线段「两条线重合」；单调链则轻微蛇形，读起来更顺。
        const ddx = x2 - x1, ddy = y2 - y1
        const segLen = Math.hypot(ddx, ddy) || 1
        const bendMag = EDGE_CURVE * Math.min(segLen, EDGE_CURVE_MAX)
        const cx = (x1 + x2) / 2 + (-ddy / segLen) * bendMag
        const cy = (y1 + y2) / 2 + ( ddx / segLen) * bendMag
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.quadraticCurveTo(cx, cy, x2, y2)
        ctx.stroke()
        // 方向箭头（有向图：引用方向 from → to；低缩放/短边不画，防噪）。
        // 曲边下箭头沿曲线末端切线（控制点 → 端点），而非弦方向。
        if (cam.scale > 0.45 && segLen > 44) {
          const ang = Math.atan2(y2 - cy, x2 - cx)
          const arr = clamp(cam.scale, 0.5, 1.3) * 4.5
          const ax = x2 - Math.cos(ang) * (b.r * cam.scale + 6)
          const ay = y2 - Math.sin(ang) * (b.r * cam.scale + 6)
          ctx.save()
          ctx.translate(ax, ay)
          ctx.rotate(ang)
          ctx.beginPath()
          ctx.moveTo(arr, 0)
          ctx.lineTo(-arr * 0.55, -arr * 0.7)
          ctx.lineTo(-arr * 0.55, arr * 0.7)
          ctx.closePath()
          ctx.fill()
          ctx.restore()
        }
      }

      // 节点（命中高亮分四层：路径节点最亮+绿色外圈；root 浅绿虚线起点；recent 深绿实环+脉冲；
      // 非路径节点保留 0.32 亮度(背景仍可见)。整条脉络绿色系、层次分明，不再压暗到几乎消失。）
      for (const n of run.nodes) {
        let alpha = 1
        const onPath = !!(hl && hl.ids.has(n.id))
        if (hl) alpha = onPath ? 1 : 0.32
        else if (hoverOn) alpha = 1 - (this._nodeDim.get(n.id) || 0) * 0.78   // 缓动压暗：1 → 0.22
        const px = tx(n.x), py = ty(n.y)
        const r = n.r * cam.scale
        const magnify = this.hover === n.id || this.sel === n.id
        const magAmt = this._mag.get(n.id) || 0
        const rDraw = r * (1 + 0.2 * magAmt)   // 放大也缓动，不跳变
        // 路径节点外圈（主绿色粗描边——脉络一眼可辨）
        if (hl && onPath) {
          ctx.globalAlpha = alpha
          ctx.strokeStyle = COLORS.pathAccent
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(px, py, r + 2.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        // root 浅绿虚线环（无入边 = 路径起点 = 最早追的知识点）
        if (hl && hl.roots.includes(n.id)) {
          ctx.globalAlpha = alpha * 0.95
          ctx.setLineDash([3, 3])
          ctx.strokeStyle = COLORS.rootMark
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(px, py, r + 5.5, 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])
        }
        // recent 深绿实环 + 脉冲（命中节点 = 当前讨论所在节点）。
        // 单击选中（manual）不用 recent 表示——选中只是脉络标记 + sel 粗圈，不冒充命中（2026-09 用户定调）
        if (hl && hl.mode !== 'manual' && hl.recent.includes(n.id)) {
          const k = clamp(1 - (Date.now() - hl.at) / 1400, 0, 1)
          ctx.globalAlpha = alpha * (0.45 + 0.55 * k)
          ctx.strokeStyle = COLORS.recentMark
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(px, py, r + 4.5 + (1 - k) * 8, 0, Math.PI * 2)
          ctx.stroke()
          ctx.globalAlpha = alpha
        }
        // 隐藏（非聚焦）模式残留标识：本次命中节点细环（2026-09 用户定调加回——
        // 隐藏高亮后仍能看到命中节点在哪；链内连接线由上方 faintChain 标记，
        // 与显示态同色同粗，仅去掉脉冲与压暗）
        if (hlHidden && hlHidden.recent.includes(n.id)) {
          ctx.globalAlpha = alpha
          ctx.strokeStyle = COLORS.pathAccent
          ctx.lineWidth = 2.2
          ctx.beginPath()
          ctx.arc(px, py, r + 3.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        // 选中外圈（比普通路径描边更粗）
        if (this.sel === n.id) {
          ctx.globalAlpha = alpha
          ctx.strokeStyle = COLORS.pathAccent
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(px, py, r + 3, 0, Math.PI * 2)
          ctx.stroke()
        }
        // 主体（显式设置透明度——否则非高亮节点会继承上一个节点的残留值，亮度错乱）
        ctx.globalAlpha = alpha
        ctx.fillStyle = n.color
        ctx.beginPath()
        ctx.arc(px, py, rDraw, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = COLORS.nodeStroke
        ctx.lineWidth = 1.4
        ctx.stroke()
        // 标签：可缩放看更多字——scale≥0.5 常显；路径/搜索/悬停必显示；
        // 路径节点(150px≈14字)比普通(100px≈9字)更完整；悬停~28字 + 白底 pill。
        const searchHit = hl && hl.mode === 'search' && hl.ids.has(n.id)
        if (cam.scale >= LABEL_MIN_SCALE || this.hover === n.id || searchHit || (hl && onPath)) {
          // point 显示长度随缩放分级：用「当前 scale / 初始基准」比值判断，与面板尺寸无关。
          // 初始化(比值≈1)每行 9 字、最多 2 行(标签短、不挤)；放大逐步提升到 13/17/20 字。
          const ratio = cam.scale / (this._baseScale || cam.scale || 1)
          const baseChars = ratio < 0.8 ? 6 : (ratio < 1.2 ? 9 : (ratio < 1.7 ? 13 : (ratio < 2.6 ? 17 : 20)))
          const focus = this.hover === n.id || searchHit || (hl && onPath)
          const labelChars = focus ? Math.max(baseChars, 13) : baseChars
          const labelLines = focus ? 3 : (ratio < 0.8 ? 1 : (ratio < 1.2 ? 2 : 3))
          const pillFade = magnify ? magAmt : 1   // 悬停/选中的 pill 淡入淡出（AI-027）
          drawLabel(ctx, n.point, px, py + rDraw + 4, alpha, labelChars, magnify || searchHit || (hl && onPath), labelFontPx, labelLines, pillFade)
        }
      }
      ctx.globalAlpha = 1
    }

    // ── 相机 / 适配 ────────────────────────────────────────────────────────
    _worldAt(sx, sy) {
      return {
        x: this.cam.x + (sx - this._w / 2) / this.cam.scale,
        y: this.cam.y + (sy - this._h / 2) / this.cam.scale,
      }
    }
    fitToNodes(nodes, animated) {
      if (!nodes || !nodes.length || !this._w || !this._h) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) {
        if (n.x < minX) minX = n.x
        if (n.y < minY) minY = n.y
        if (n.x > maxX) maxX = n.x
        if (n.y > maxY) maxY = n.y
      }
      const pad = 30
      const bw = Math.max(maxX - minX, 40), bh = Math.max(maxY - minY, 40)
      const scale = clamp(Math.min((this._w - pad * 2) / bw, (this._h - pad * 2) / bh), 0.12, 4)
      const target = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale }
      if (animated) this._animCam(target)
      else {
        this._anim = null   // 非动画适配直接落位：清掉可能挂起的相机动画，防残留插值乱跳（2026-10）
        this.cam = target
        if (!this._baseScale) this._baseScale = target.scale   // 记录初始 fit 基准（内容长度分级用）
        this.render()
      }
    }
    _animCam(to) {
      // 2026-09 用户定调：聚焦/取消聚焦动画舒缓——时长 360 → 720ms，缓动 easeInOutCubic
      this._anim = { from: { ...this.cam }, to, t0: Date.now(), dur: 720 }
      this._ensureLoop()
    }
    _stepAnim() {
      const a = this._anim
      if (!a) return
      const k = clamp((Date.now() - a.t0) / a.dur, 0, 1)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2   // easeInOutCubic：两端缓起缓收
      this.cam.x = a.from.x + (a.to.x - a.from.x) * e
      this.cam.y = a.from.y + (a.to.y - a.from.y) * e
      this.cam.scale = a.from.scale + (a.to.scale - a.from.scale) * e
      if (k >= 1) this._anim = null
      // 注：不做"动画结束即时校准"（2026-10 试过又去掉）——动画播完（720ms）
      // 时物理仍在收敛，节点还在移动，此刻直接落位只会造成突兀跳变且位置仍偏；
      // 校准统一交给物理收敛那一刻（_ensureLoop 的 _pendingChainFit 分支），
      // 收敛后节点基本静止，落位一次即准确稳定。
    }

    _ensureLoop() {
      if (this._raf) return
      const frame = () => {
        this._raf = 0
        let busy = false
        if (this._physics.running) {
          // 每帧 2 子步，加快收敛
          if (this.tickPhysics() | this.tickPhysics()) busy = true
          else {
            // 常驻弹性（AI-024）：收敛后不再停止物理——静止时接近不动（安静），
            // 但拖拽/点按任一节点时，整张图会弹性联动再缓缓收敛。
            // 注意：收敛后不再自动 fitToNodes（2026-09 用户定调删掉）——
            // 否则打开图几秒后相机被强拉回初始整体缩放，打断用户正在进行的查看。
            // 例外（2026-10）：挂起的命中聚焦校准——新命中/打开图恢复命中时，
            // 物理收敛的这一刻用最终坐标把相机落位到链上（打开图聚焦错位的
            // 根因：动画目标取的是环形初始布局的瞬时坐标，收敛后节点已移动）
            if (this._pendingChainFit) {
              this._pendingChainFit = false
              if (this._open && this.hl && !this._hlHidden && (this.hl.mode === 'hit' || this.hl.mode === 'picked') && this.hl.chains) {
                this._anim = null   // 取消可能进行中的聚焦动画，直接落位（防动画插值打架）
                this._fitToChain(true)
              }
            }
            busy = true
          }
        }
        if (this._anim && Date.now() < this._anim.t0 + this._anim.dur) { this._stepAnim(); busy = true }
        else this._anim = null
        if (Date.now() < this._pulseUntil) busy = true
        if (this._dragging) busy = true
        // 碰撞弹开（AI-023）：运动期自动推开重叠的节点圆/标签，收敛后不破坏已读布局
        if (this._physics.running || this._anim || this._dragging) {
          if (this._separateLabels()) busy = true
        }
        this._stepHoverFx()   // 悬停压暗/放大缓动（AI-027）
        this.render()
        if (busy) this._ensureLoop()
      }
      this._raf = requestAnimationFrame(frame)
    }

    // 悬停过渡（AI-027）：每帧把 压暗强度 / 放大强度 向目标缓动（指数趋近，约 200ms 内稳定）。
    // 进入/离开/在节点间快速扫过都是平滑渐变，不闪变。目标值与原行为一致：
    // 非邻接节点/边压暗（1→0.22 / 0.62→0.12），悬停/选中节点放大 1.2 倍 + pill 淡入。
    _stepHoverFx() {
      const run = this.run
      if (!run || !run.nodes.length) return
      const hlIds = !this._hlHidden && this.hl ? this.hl.ids : null
      const hoverOn = !!this.hover && !hlIds   // 有路径高亮时不压暗（只出标签）
      let neigh = null, edges = null
      if (hoverOn) {
        neigh = new Set([this.hover])
        edges = new Set()
        for (const e of run.edges) {
          if (e.from === this.hover) { neigh.add(e.to); edges.add(e) }
          if (e.to === this.hover) { neigh.add(e.from); edges.add(e) }
        }
      }
      const K = 0.18
      for (const n of run.nodes) {
        const dimT = hoverOn && !neigh.has(n.id) ? 1 : 0
        const dc = this._nodeDim.get(n.id)
        this._nodeDim.set(n.id, (dc || 0) + (dimT - (dc || 0)) * K)
        const magT = this.hover === n.id || this.sel === n.id ? 1 : 0
        const mc = this._mag.get(n.id)
        this._mag.set(n.id, (mc || 0) + (magT - (mc || 0)) * K)
      }
      for (const e of run.edges) {
        const key = e.from + '>' + e.to
        const dimT = hoverOn && !edges.has(e) ? 1 : 0
        const dc = this._edgeDim.get(key)
        this._edgeDim.set(key, (dc || 0) + (dimT - (dc || 0)) * K)
      }
    }

    // ── DOM 构建 / 事件 ────────────────────────────────────────────────────
    _build() {
      const c = this.container
      c.innerHTML = ''
      c.insertAdjacentHTML('beforeend',
        '<div class="gv-toolbar">' +
          '<span class="gv-title">◎ 会意图<span class="gv-badge" id="gv-demo-badge" hidden>演示数据</span></span>' +
          '<input class="gv-search" id="gv-search" placeholder="搜索知识点…" spellcheck="false">' +
          '<button class="gv-btn" id="gv-legend-btn" title="图例">图例</button>' +
          '<button class="gv-btn gv-close" id="gv-close" title="关闭">✕</button>' +
        '</div>' +
        '<div class="gv-banner" id="gv-banner" hidden>' +
          '<span class="gv-banner-text" id="gv-banner-text"></span>' +
          '<button class="gv-btn gv-banner-clear" id="gv-banner-clear">隐藏当前讨论命中高亮</button>' +
        '</div>' +
        '<div class="gv-canvas-wrap" id="gv-wrap">' +
          '<canvas id="gv-canvas"></canvas>' +
          '<div class="gv-hint">滚轮缩放 · 拖空白平移 · 悬停节点看名称 · 点选看详情</div>' +
          '<div class="gv-chain-switch" id="gv-chain-switch" hidden></div>' +
          '<div class="gv-legend" id="gv-legend" hidden>' +
            '<div><span class="sw" style="background:#6d72e8"></span>user 边 · 用户引用</div>' +
            '<div><span class="sw" style="background:#8a92a6"></span>derived 边 · 对话衍生</div>' +
            '<div class="gv-lg-title">命中高亮 · 三种圈</div>' +
            '<div><span class="ring" style="border-color:#5b5fe8"></span>path · 命中路径上的节点</div>' +
            '<div><span class="ring dashed" style="border-color:#9aa3f2"></span>root · 路径起点（无入边）</div>' +
            '<div><span class="ring thick" style="border-color:#3f45cd"></span>recent · 当前命中节点</div>' +
            '<div class="gv-lg-title">节点颜色 · 所属书籍</div>' +
            '<div id="gv-legend-books"></div>' +
          '</div>' +
          '<div class="gv-detail" id="gv-detail" hidden>' +
            '<div class="gd-head"><span class="gd-title" id="gv-d-point"></span>' +
              '<span class="gd-fsgroup"><button class="gd-fsbtn" id="gv-d-fs-down" title="缩小字号">A−</button><button class="gd-fsbtn" id="gv-d-fs-up" title="放大字号">A＋</button></span>' +
              '<button class="gd-close" id="gv-d-close" title="关闭">✕</button></div>' +
            '<div class="gd-body">' +
              '<div class="gd-label">相关说法</div>' +
              '<div id="gv-d-aliases"></div>' +
              '<div class="gd-discs-zone" id="gv-d-zone">' +
                '<div class="gd-label">专题化讨论</div>' +
                '<div id="gv-d-discs"></div>' +
              '</div>' +
              '<div class="gd-note" id="gv-d-note" hidden>演示数据：节点只有知识点表述（point）。相关说法与专题化讨论由会意系统在真实讨论收口固化时生成，真实图写入后此处会显示。</div>' +
            '</div>' +
            '<div class="gd-pip-tip" id="gv-d-pip-tip"></div>' +   // 轮次 pip 详情 tooltip（AI-035）
          '</div>' +
          '<div class="gv-tooltip" id="gv-tooltip"></div>' +
          '<div class="gv-empty" id="gv-empty" hidden>' +
            '<div class="gv-empty-text" id="gv-empty-text"></div>' +
            '<div class="gv-empty-actions" id="gv-empty-actions">' +
              '<button class="gv-btn primary" id="gv-empty-demo">载入演示拓扑</button>' +
              '<button class="gv-btn" id="gv-empty-retry" hidden>重试</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      )
      this.canvas = this.container.querySelector('#gv-canvas')
      this.ctx = this.canvas.getContext('2d')
      this.wrap = this.container.querySelector('#gv-wrap')
      this.banner = this.container.querySelector('#gv-banner')
      this.bannerText = this.container.querySelector('#gv-banner-text')
      this.bannerClearBtn = this.container.querySelector('#gv-banner-clear')
      this.tooltip = this.container.querySelector('#gv-tooltip')
      this.detail = this.container.querySelector('#gv-detail')
      this.emptyEl = this.container.querySelector('#gv-empty')
      this.emptyText = this.container.querySelector('#gv-empty-text')
      this._built = true
    }
    _bind() {
      if (this._bound) return
      this._bound = true
      const cv = this.canvas

      cv.addEventListener('pointerdown', (e) => {
        if (!this.run) return
        try { cv.setPointerCapture(e.pointerId) } catch {}
        const p = this._pos(e)
        const n = this._hitTest(p.x, p.y)
        this._dragging = n
          ? { kind: 'node', id: n.id, sx: p.x, sy: p.y, moved: false }
          : { kind: 'pan', sx: p.x, sy: p.y, moved: false }
        cv.classList.add('panning')
        this._hideTooltip()
      })
      cv.addEventListener('pointermove', (e) => {
        if (!this.run) return
        const p = this._pos(e)
        const d = this._dragging
        if (d) {
          d.moved = d.moved || Math.hypot(p.x - d.sx, p.y - d.sy) > 4
          if (d.kind === 'node') {
            const n = this.run.byId.get(d.id)
            if (n) {
              const w = this._worldAt(p.x, p.y)
              n.x = w.x; n.y = w.y
              n.pinned = true
            }
          } else if (d.kind === 'pan' && d.moved) {
            this.cam.x -= (p.x - d.sx) / this.cam.scale
            this.cam.y -= (p.y - d.sy) / this.cam.scale
            d.sx = p.x; d.sy = p.y
          }
          this._ensureLoop()
          return
        }
        const n = this._hitTest(p.x, p.y)
        if ((n ? n.id : null) !== this.hover) {
          this.hover = n ? n.id : null
          cv.style.cursor = n ? 'pointer' : 'grab'
          this._updateTooltip(p.x, p.y, n)
          this.render()
        } else if (n) {
          this._updateTooltip(p.x, p.y, n)
        }
      })
      const endDrag = (e) => {
        const d = this._dragging
        this._dragging = null
        if (!this.canvas) return
        this.canvas.classList.remove('panning')
        if (d && d.kind === 'node') {
          const n = this.run && this.run.byId.get(d.id)
          if (n) n.pinned = false
          if (!d.moved) {
            if (this._pickMode) {
              // 选取模式：单击延迟 300ms 打开详情——给双击留出窗口。若双击发生，
              // dblclick 处理器会 clearTimeout 取消这次详情打开；否则双击的第二击
              // 会被右侧详情面板挡住（面板不跟随节点，宽度 360px，覆盖右侧区域），
              // 导致选取失效（2026-09 实测修复）。
              clearTimeout(this._pickSelectTimer)
              this._pickSelectTimer = setTimeout(() => {
                if (this._open) this.selectNode(d.id)
              }, 300)
            } else {
              this.selectNode(d.id)
            }
          } else this.render()
        } else if (d && d.kind === 'pan' && !d.moved) {
          // 点击空白（未拖动）→ 取消选中与手动聚焦，回到浏览态（2026-09 用户定调）。
          // 条件不依赖 sel：详情关闭（sel 置空）后，只要还有单击选中（manual）的
          // 高亮，点空白依然取消聚焦。
          // 若 manual 之前暂存了消息级高亮（hit/picked/search）→ 原样恢复它
          // （横幅 + 高亮 + 相机），不销毁；否则才真正清除高亮。
          if (this.sel || (this.hl && this.hl.mode === 'manual')) {
            if (this.hl && this.hl.mode === 'manual') {
              if (this._savedState) {
                const st = this._savedState
                this._savedState = null
                this.hl = st.hl
                this._focusChain = st.focusChain
                this._hlHidden = st.hidden
                this.recomputeHighlight()   // 按当前图重算路径/链并重渲染横幅
                // 相机：显示态聚焦回命中链；隐藏态回命中前（与 toggleHighlightHidden 一致）
                if (this._hlHidden) {
                  if (this._preFocusCam) this._animCam(this._preFocusCam)
                  else if (this.run) this.fitToNodes(this.run.nodes, true)
                } else {
                  this._fitToChain()
                }
              } else {
                const back = this._preFocusCam
                this.clearHighlight()
                // 取消聚焦：恢复聚焦前用户的缩放状态（2026-09 用户定调）
                if (back) this._animCam(back)
                else if (this.run) this.fitToNodes(this.run.nodes, true)
              }
            }
            this.closeDetail()
          }
        }
      }
      cv.addEventListener('pointerup', endDrag)
      cv.addEventListener('pointercancel', endDrag)
      // 选择模式双击：选取节点为引用（自由模式手动选取，2026-09）。
      // 双击优先于单击：取消挂起的"单击打开详情"（否则双击后详情面板弹出干扰）。
      cv.addEventListener('dblclick', (e) => {
        if (!this._pickMode || !this.run) return
        clearTimeout(this._pickSelectTimer)
        const p = this._pos(e)
        const n = this._hitTest(p.x, p.y)
        if (n && this.onPick) {
          this.onPick({ id: n.id, point: n.point, aliases: n.aliases || [], discussions: n.discussions || [] })
        }
      })
      cv.addEventListener('pointerleave', () => {
        if (!this._dragging && this.hover) {
          this.hover = null
          this._hideTooltip()
          this.render()
        }
      })
      cv.addEventListener('wheel', (e) => {
        e.preventDefault()
        const p = this._pos(e)
        const factor = Math.exp(-e.deltaY * 0.0012)
        const scale = clamp(this.cam.scale * factor, 0.12, 6)
        const w = this._worldAt(p.x, p.y)
        this.cam.scale = scale
        this.cam.x = w.x - (p.x - this._w / 2) / scale
        this.cam.y = w.y - (p.y - this._h / 2) / scale
        this.render()
      }, { passive: false })

      this.container.querySelector('#gv-close').addEventListener('click', () => this.close())
      const legendBtn = this.container.querySelector('#gv-legend-btn')
      legendBtn.addEventListener('click', () => {
        const el = this.container.querySelector('#gv-legend')
        const show = el.hidden
        el.hidden = !show
        legendBtn.textContent = show ? '图例 ✓' : '图例'
      })
      this.container.querySelector('#gv-banner-clear').addEventListener('click', () => this._onBannerBtn())
      this.container.querySelector('#gv-d-close').addEventListener('click', () => this.closeDetail())
      this._applyDetailFont()
      const fsUp = this.container.querySelector('#gv-d-fs-up')
      const fsDown = this.container.querySelector('#gv-d-fs-down')
      if (fsUp) fsUp.addEventListener('click', () => this._setDetailFont(1))
      if (fsDown) fsDown.addEventListener('click', () => this._setDetailFont(-1))
      this.container.querySelector('#gv-empty-demo').addEventListener('click', () => this.loadGraph(true, false))
      this.container.querySelector('#gv-empty-retry').addEventListener('click', () => this.loadGraph(this._demo, this._free))

      const search = this.container.querySelector('#gv-search')
      search.addEventListener('input', () => {
        const q = search.value.trim()
        if (!q) {
          // 手动清空搜索框 = 清除搜索（恢复搜索前状态 / 关无匹配横幅）
          this._clearSearch()
          return
        }
        const run = this.run
        if (!run) return
        const matches = this._searchMatches(q)
        if (!matches.length) {
          // 无匹配：只退出搜索高亮，不用 clearHighlight（它会把"清除搜索"要恢复的
          // 暂存一起清掉）；横幅 = 无匹配 + 清除搜索按钮
          if (this.hl && this.hl.mode === 'search') {
            this.hl = null
            this._hlHidden = false
            this._focusChain = 0
            this._renderBanner()
            this._renderChainSwitch()
          }
          this.render()
          this._setBanner('🔍 无匹配「' + q + '」', '')
          this._setBannerBtn('clear')   // 无匹配横幅按钮 = 清除搜索
          if (this.sel) this._renderDetail()   // 搜索词变化 → 详情高亮同步刷新
          return
        }
        const ids = matches.map((n) => n.id)
        const result = computePath(run.nodes, run.edges, ids)
        // 搜索是临时定位：暂存当前消息级高亮（hit/picked 等），"清除搜索"时原样恢复
        if (!this._savedState && this.hl && this.hl.mode !== 'search') {
          this._savedState = { hl: this.hl, focusChain: this._focusChain, hidden: this._hlHidden }
        }
        this.setHighlight(Object.assign({}, result, { recent: [] }), 'search', '🔍 搜索「' + q + '」命中 ' + ids.length + ' 个节点')
        this.fitToNodes(matches, true)
        if (this.sel) this._renderDetail()   // 详情开着：搜索词变化 → 高亮同步刷新
      })
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const q = search.value.trim()
          if (!q || !this.run) return
          const hay = (n) => [n.point].concat(n.aliases, n.discussions.map((d) => d.question)).join(' ').toLowerCase()
          const hit = this.run.nodes.find((n) => hay(n).includes(q.toLowerCase()))
          if (hit) this.selectNode(hit.id)
        }
      })

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this._open) this.close()
      })

      // 尺寸跟随
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this._resize())
        this._ro.observe(this.wrap)
      }
      window.addEventListener('resize', () => this._resize())
    }

    _resize() {
      if (!this._built || !this._open) return
      const w = this.wrap.clientWidth
      const h = this.wrap.clientHeight
      if (!w || !h) return
      this._w = w
      this._h = h
      this.render()
    }

    _pos(e) {
      const r = this.canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    _hitTest(sx, sy) {
      const run = this.run
      if (!run) return null
      const w = this._worldAt(sx, sy)
      let best = null, bestD = Infinity
      for (const n of run.nodes) {
        const d = Math.hypot(n.x - w.x, n.y - w.y)
        if (d < n.r + 6 / this.cam.scale && d < bestD) { bestD = d; best = n }
      }
      return best
    }

    // ── 面板 / 横幅 / 空态 ────────────────────────────────────────────────
    // 搜索匹配：搜索词落在 节点名/相关说法/讨论问题 里即命中（与搜索框 input 逻辑一致）
    _searchMatches(q) {
      if (!q || !this.run) return []
      const low = q.toLowerCase()
      return this.run.nodes.filter((n) => {
        const hay = [n.point].concat(n.aliases, n.discussions.map((d) => d.question)).join(' ').toLowerCase()
        return hay.includes(low)
      })
    }
    _renderBanner() {
      const hl = this.hl
      // 图视图从未打开（DOM 未构建，this.banner 为空）时直接跳过横幅操作：
      // 退出自由模式会经 syncPickHighlight → clearHighlight 走到这里，
      // 若在未构建状态下访问 this.banner 会抛 TypeError，中断侧栏恢复流程（2026-09 修复）
      if (!this.banner) return
      // 搜索框非空 → 搜索横幅无条件接管（2026-10 用户定调）：只要搜索框还有词，
      // 横幅就显示"搜索命中/无匹配"，与 hl 处于什么态无关（manual 点详情不吞、
      // hit 命中也不压）——需求 2 的规则是"搜索框有词 → 横幅不消失"
      const search = this.container ? this.container.querySelector('#gv-search') : null
      const sq = search ? search.value.trim() : ''
      if (sq) {
        console.log('[CoRead][gv] banner: search-mode (sq=' + sq.slice(0, 10) + ')')
        const matches = this._searchMatches(sq)
        this._setBannerLines(['🔍 ' + (matches.length ? '搜索「' + sq + '」命中 ' + matches.length + ' 个节点' : '无匹配「' + sq + '」')], '')
        this._setBannerBtn('clear')   // 搜索横幅按钮 = 清除搜索
        return
      }
      console.log('[CoRead][gv] banner: hl-mode=', hl && hl.mode)
      if (!hl) {
        this.banner.hidden = true
        return
      }
      const hidden = this._hlHidden
      let text = ''
      if (hl.mode === 'search') {
        // 搜索是用户主动操作，无需解释
        text = (hidden ? '〔高亮已隐藏〕' : '') + (hl.reason || '搜索命中')
        this._setBannerLines([text], '')
        this._setBannerBtn('clear')   // 搜索横幅按钮 = 清除搜索
      } else if (hl.mode === 'simulate') {
        text = (hidden ? '〔高亮已隐藏〕' : '') + '🔗 模拟命中（演示）：高亮「' + nodePoint(this, hl.targets[0]) + '」的讨论脉络（' + hl.ids.size + ' 节点）'
        this._setBannerLines([text], 'hit')
        this._setBannerBtn('hl')
      } else if (hl.mode === 'manual') {
        // 单击节点预览：manual 不显示自己的横幅，也不吞掉之前的横幅
        //（2026-10：预览前若有 hit/search 横幅，原样保留——点开详情不再让
        // 命中横幅消失；点空白恢复 _savedState 时会重渲染横幅回到原内容）
        return
      } else {
        // 会话命中（hit）/ 手动选取（picked）：横幅统一分行（2026-09 用户定调）——
        // 指示行 + 每个标题各占一行；单脉络（单链）同样分行，不做单行省略。
        // 每行由 .gv-banner-line 强制单行（nowrap + ellipsis），标题行内部不再被拆断。
        const chains = hl.chains || []
        const idx = chains.length ? Math.min(this._focusChain, chains.length - 1) : 0
        const cur = chains.length ? chains[idx] : null
        const hitIds = cur ? cur.hits : hl.targets
        const titles = hitIds.map((id) => {
          const n = this.run ? this.run.byId.get(id) : null
          const p = String(n && n.point ? n.point : id)
          return p.length > 30 ? p.slice(0, 30) + '…' : p
        })
        // 隐藏态前缀："高亮已隐藏"——隐藏的是高亮显示，命中事实不变；
        // 与横幅按钮文案"隐藏当前讨论命中高亮"用词一致，宾语明确（2026-09 用户定调）
        const prefix = (hidden ? '〔高亮已隐藏〕' : '')
        // 指示行统一主词"命中知识脉络"（2026-09 用户定调——不用"旧知识点"）；
        // 多链且显示态时括号标注当前展示的是第几条知识脉络（主词即链，1/2 指脉络
        // 序号，无"把链当知识点"的歧义），与右下角"脉络 N"悬浮按钮呼应。
        // 隐藏态不写（X/N）——隐藏时没有聚焦任何脉络，进度标注不成立（2026-09 修复）。
        const head = !hidden && chains.length > 1
          ? '命中知识脉络（' + (idx + 1) + '/' + chains.length + '）'
          : '命中知识脉络'
        // 隐藏态只保留指示行（2026-09 修复：隐藏时没有聚焦任何脉络，
        // 标题行和（X/N）都没有着落，一并去掉）；显示态 = 指示行 + 标题分行
        this._setBannerLines(
          hidden
            ? [prefix + head]
            : [prefix + head, ...titles.map((t) => '「' + t + '」')],
          !hidden ? 'hit' : ''
        )
        // 横幅按钮：hit/picked 态 = 高亮显隐开关（不"清除"数据，只是渲染切换）
        this._setBannerBtn('hl')
      }
    }
    // 横幅按钮（2026-09 用户定调）：
    // - 'hl'：hit/picked/simulate 态——当前讨论命中高亮的显示/隐藏开关
    // - 'clear'：search / 无匹配——清除搜索（清空搜索框、退出搜索命中、恢复搜索前状态）
    _setBannerBtn(kind) {
      if (!this.bannerClearBtn) return
      this._bannerBtnKind = kind
      if (kind === 'clear') {
        this.bannerClearBtn.textContent = '清除搜索'
        this.bannerClearBtn.title = '清空搜索框，退出搜索命中'
      } else {
        const hidden = this._hlHidden
        this.bannerClearBtn.textContent = hidden ? '显示当前讨论命中高亮' : '隐藏当前讨论命中高亮'
        this.bannerClearBtn.title = hidden ? '恢复显示本次命中的路径高亮' : '暂时隐藏本次命中的路径高亮（数据保留，可随时恢复）'
      }
    }
    _onBannerBtn() {
      if (this._bannerBtnKind === 'clear') this._clearSearch()
      else this.toggleHighlightHidden()
    }
    // 清除搜索：清空搜索框 + 退出搜索命中。搜索前若有消息级高亮（hit/picked 等），
    // 原样恢复它（搜索输入时暂存）；否则清高亮并恢复搜索前相机。
    _clearSearch() {
      const search = this.container && this.container.querySelector('#gv-search')
      if (search) search.value = ''
      if (this._savedState) {
        const st = this._savedState
        this._savedState = null
        this.hl = st.hl
        this._focusChain = st.focusChain
        this._hlHidden = st.hidden
        this.recomputeHighlight()   // 按当前图重算路径/链并重渲染横幅
        if (this._hlHidden) {
          if (this._preFocusCam) this._animCam(this._preFocusCam)
          else if (this.run) this.fitToNodes(this.run.nodes, true)
        } else {
          this._fitToChain()
        }
      } else if (this.hl && this.hl.mode === 'search') {
        const back = this._preFocusCam
        this.clearHighlight()
        if (back) this._animCam(back)   // 恢复搜索前相机
        else if (this.run) this.fitToNodes(this.run.nodes, true)
      } else {
        this._setBannerLines(null, '')   // 无匹配横幅：只关横幅，不动其他高亮
        this.render()
      }
      if (this.sel) this._renderDetail()   // 清空搜索词 → 详情高亮同步消失（2026-10）
    }
    // 悬浮链切换按钮（2026-09）：多链命中时显示在画布右下角，点击聚焦对应链；
    // 无链 / 单链 / 高亮隐藏时隐藏。
    _renderChainSwitch() {
      const el = this.container && this.container.querySelector('#gv-chain-switch')
      if (!el) return
      const chains = this.hl && this.hl.chains
      if (!chains || chains.length <= 1 || this._hlHidden) { el.hidden = true; return }
      el.hidden = false
      el.innerHTML = chains.map((c, i) =>
        '<button class="gv-chain-btn' + (i === this._focusChain ? ' sel' : '') + '" data-chain="' + i +
        '" title="聚焦第 ' + (i + 1) + ' 条讨论脉络（' + c.hits.length + ' 个命中节点）">脉络 ' + (i + 1) + '</button>'
      ).join('')
      for (const b of el.querySelectorAll('.gv-chain-btn')) {
        b.addEventListener('click', () => this.focusChain(Number(b.dataset.chain)))
      }
    }
    /** 按行渲染横幅：每行一个 <div class="gv-banner-line">（nowrap + ellipsis，
     *  2026-09 用户定调——命中横幅分行展示，且标题行内部不被 CSS 拆断）。 */
    _setBannerLines(lines, kind) {
      if (!lines || !lines.length || !lines.some(Boolean)) { this.banner.hidden = true; return }
      this.banner.hidden = false
      this.banner.className = 'gv-banner' + (kind === 'hit' ? ' hit' : '')
      this.bannerText.innerHTML = lines
        .filter(Boolean)
        .map((l) => '<div class="gv-banner-line">' + escHtml(l) + '</div>')
        .join('')
    }
    _setBanner(text, kind) {
      if (!text) { this.banner.hidden = true; return }
      this._setBannerLines([text], kind)
    }
    // 书籍图例（AI-025）：按书名分组列出 书籍 → 颜色，随图数据更新
    _renderBookLegend() {
      const el = this.container && this.container.querySelector('#gv-legend-books')
      if (!el) return
      const run = this.run
      if (!run || !run.nodes.length) { el.innerHTML = ''; return }
      const byBook = new Map()
      for (const n of run.nodes) {
        for (const b of n.books) {
          if (!byBook.has(b)) byBook.set(b, (this._bookColors && this._bookColors.get(b)) || bookColor(b))
        }
      }
      const entries = [...byBook.entries()]
      el.innerHTML = entries.length
        ? entries.map(([b, c]) => '<div class="gv-lg-row"><span class="sw" style="background:' + c + '"></span><span class="gv-lg-name" title="' + escHtml(b) + '">' + escHtml(b) + '</span></div>').join('')
        : '<div class="gv-lg-empty">（当前图无书籍归属）</div>'
    }
    _updateSourceBadge() {
      const badge = this.container && this.container.querySelector('#gv-demo-badge')
      if (!badge) return
      const s = this._source
      if (s === 'demo') { badge.hidden = false; badge.textContent = '演示数据'; badge.title = '演示拓扑：由 knowledge-graph-demo.json 重建' }
      else if (s === 'results') { badge.hidden = false; badge.textContent = '冒烟结果'; badge.title = '有效图：由冒烟/派生脚本产出（knowledge-graph-results.json）' }
      else if (s === 'free') { badge.hidden = false; badge.textContent = '自由模式'; badge.title = '自由模式沙盒图：测试对话的固化产物，不进入正式图' }
      else { badge.hidden = true }
    }
    _setLoading(text) {
      if (!text) {
        if (this.emptyEl && !this.emptyEl.hidden && this.emptyEl.dataset.kind === 'loading') this.emptyEl.hidden = true
        return
      }
      this.emptyEl.hidden = false
      this.emptyEl.dataset.kind = 'loading'
      this.emptyText.textContent = text
      const actions = this.emptyEl.querySelector('#gv-empty-actions')
      if (actions) actions.hidden = true
    }
    _setEmpty(show, text, retry) {
      if (!show) { if (this.emptyEl) this.emptyEl.hidden = true; return }
      this.emptyEl.hidden = false
      this.emptyEl.dataset.kind = 'empty'
      this.emptyText.textContent = text || ''
      const actions = this.emptyEl.querySelector('#gv-empty-actions')
      if (actions) actions.hidden = false
      const demoBtn = this.emptyEl.querySelector('#gv-empty-demo')
      if (demoBtn) demoBtn.hidden = !!retry || !!this._demo
      const retryBtn = this.emptyEl.querySelector('#gv-empty-retry')
      if (retryBtn) retryBtn.hidden = !retry
    }
    _updateTooltip(sx, sy, n) {
      if (!n) { this._hideTooltip(); return }
      const discs = (n.discussions || []).length
      let html = '<b>' + escHtml(n.point) + '</b>'
      if (n.books.length) html += '<div style="color:#9fb0c3">' + escHtml(n.books.join(' · ')) + '</div>'
      html += '<div>' + discs + ' 次专题化讨论 · ' + (n.aliases || []).length + ' 条相关说法</div>'
      this.tooltip.innerHTML = html
      this.tooltip.classList.add('show')   // CSS 过渡淡入（AI-027）
      const tw = this.tooltip.offsetWidth || 200
      this.tooltip.style.left = Math.min(sx + 14, this._w - tw - 8) + 'px'
      this.tooltip.style.top = Math.min(sy + 14, this._h - 60) + 'px'
    }
    _hideTooltip() {
      if (this.tooltip) this.tooltip.classList.remove('show')   // CSS 过渡淡出（AI-027）
    }
    _renderDetail() {
      const run = this.run
      const n = this.sel && run ? run.byId.get(this.sel) : null
      if (!n) { this.detail.hidden = true; return }
      this.detail.hidden = false
      this._applyDetailFont()   // 详情正文缩放变量（AI-032）
      // 搜索命中高亮（2026-10）：搜索框有词时，详情里出现的命中关键词包 <mark>；
      // 点开详情/换节点时按当前搜索词重算（搜索词变化 → 详情同步更新）
      const search = this.container ? this.container.querySelector('#gv-search') : null
      const q = search ? search.value.trim().toLowerCase() : ''
      const isDemo = !!(this.graph && this.graph.demo)
      this.detail.querySelector('#gv-d-point').innerHTML = hlText(n.point, q)
      const aliasEl = this.detail.querySelector('#gv-d-aliases')
      aliasEl.innerHTML = (n.aliases && n.aliases.length)
        ? n.aliases.map((a) => '<div class="gd-alias">' + hlText(a, q) + '</div>').join('')
        : '<div class="gd-none">' + (isDemo ? '（演示数据无相关说法）' : '（无相关说法）') + '</div>'
      // 专题化讨论：每个 question 是一个可折叠条目（默认折叠，点开看书/章/交锋原文）。
      // AI-034：每条讨论自带轮次导航（>1 轮显示序号），几条讨论就是几个独立导航，
      // 无需再做「哪根条对应哪条讨论」的跨讨论映射。
      const discEl = this.detail.querySelector('#gv-d-discs')
      discEl.innerHTML = (n.discussions && n.discussions.length)
        ? n.discussions.map((d) => {
          const book = d.book ? '《' + escHtml(bookName(d.book)) + '》' : ''
          const chapter = d.chapter ? escHtml(d.chapter) : ''
          const excerpts = Array.isArray(d.excerpts) ? d.excerpts : []
          const meta = [book, chapter, excerpts.length ? excerpts.length + ' 轮交锋' : ''].filter(Boolean).join(' · ')
          // AI-038：每张讨论卡片都显示轮次排号（即使只有 1 轮也显示「1」），保证导航必然可见
          const pipHtml = excerpts.length
            ? '<div class="gd-round-nav">' + excerpts.map((e, i) => '<span class="gd-pip" data-r="' + i + '">' + (i + 1) + '</span>').join('') + '</div>'
            : ''
          const exHtml = excerpts.map((e) => {
            const qq = e && e.q ? '<div class="gd-ex"><span class="gxl">问</span><span class="gd-ext">' + hlText(String(e.q), q) + '</span></div>' : ''
            const aa = e && e.a ? '<div class="gd-ex gd-ex-a"><span class="gxl">答</span><span class="gd-ext">' + hlText(String(e.a), q) + '</span></div>' : ''
            return '<div class="gd-round">' + qq + aa + '</div>'
          }).join('')
          return '<div class="gd-disc">' +
            '<div class="gd-q"><span class="gd-caret">▸</span><span class="gd-qtext">' + hlText(d.question || '', q) + '</span></div>' +
            pipHtml +   // AI-036：标题下方始终可见（不藏在可折叠体里，选中即可看到排号）
            '<div class="gd-qbody" hidden>' + (meta ? '<div class="meta">' + meta + '</div>' : '') + exHtml + '</div>' +
            '</div>'
        }).join('')
        : '<div class="gd-none">' + (isDemo ? '（演示数据无讨论记录）' : '（无讨论记录）') + '</div>'
      // 每条讨论内部的轮次导航（始终可见）：点序号——若讨论折叠先展开，再滚到该轮并高亮；
      // 悬停序号显示该轮「提问内容」（AI-036）
      const pipTip = this.detail.querySelector('#gv-d-pip-tip')
      discEl.querySelectorAll('.gd-disc').forEach((disc) => {
        const q = disc.querySelector('.gd-q')
        const body = disc.querySelector('.gd-qbody')
        const rounds = disc.querySelectorAll('.gd-round')
        const pips = disc.querySelectorAll('.gd-round-nav .gd-pip')
        q.addEventListener('click', () => {
          const open = !body.hidden
          body.hidden = open
          q.classList.toggle('open', !open)
        })
        pips.forEach((pip) => {
          const round = rounds[+pip.dataset.r]
          pip.addEventListener('click', () => {
            if (!round) return
            if (body.hidden) { body.hidden = false; q.classList.add('open') }   // 折叠中：先展开再跳
            // 精确跳转（AI-039）：只滚正文小滚动区，让目标轮顶部对齐滚动区顶部（留 8px），
            // 不滚整个面板、导航保持不动——避免 scrollIntoView(nearest) 只露出半截
            const bRect = body.getBoundingClientRect()
            const rRect = round.getBoundingClientRect()
            const target = Math.max(0, body.scrollTop + (rRect.top - bRect.top) - 8)
            if (Math.abs(target - body.scrollTop) > 1) {
              if (typeof requestAnimationFrame === 'function') {
                const start = body.scrollTop
                const delta = target - start
                const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
                let frames = 0
                const step = (now) => {
                  const k = Math.min(1, (now - t0) / 150)
                  body.scrollTop = start + delta * (1 - Math.pow(1 - k, 3))   // easeOutCubic，终点精确
                  if (k < 1 && ++frames < 30) requestAnimationFrame(step)   // 兜底：最多 30 帧
                }
                requestAnimationFrame(step)
              } else body.scrollTop = target
            }
            pips.forEach((p) => p.classList.toggle('active', p === pip))
          })
          pip.addEventListener('mouseenter', () => { if (round) this._showPipTip(pipTip, round, pip) })
          pip.addEventListener('mouseleave', () => { if (pipTip) pipTip.classList.remove('on') })
        })
      })
      const note = this.detail.querySelector('#gv-d-note')
      note.hidden = !isDemo
    }
    // 轮次 pip 详情 tooltip（AI-036）：悬停序号只显示该轮「提问内容」（问）
    _showPipTip(tipEl, round, pip) {
      if (!tipEl) return
      const exs = round.querySelectorAll('.gd-ex')
      let text = ''
      if (exs[0]) {
        const body = exs[0].querySelector('.gd-ext')
        text = (body && body.textContent) || ''
      }
      tipEl.textContent = text || '（该轮暂无详情）'
      tipEl.classList.add('on')
      const pr = pip.getBoundingClientRect()
      const vw = window.innerWidth || document.documentElement.clientWidth || 0
      const vh = window.innerHeight || document.documentElement.clientHeight || 0
      const w = tipEl.offsetWidth || 220
      const h = tipEl.offsetHeight || 80
      let left = pr.left + pr.width / 2 - w / 2
      left = Math.max(8, Math.min(left, vw - w - 8))
      tipEl.style.left = Math.round(left) + 'px'
      let top = pr.bottom + 6
      if (top + h > vh - 8) top = pr.top - h - 6
      top = Math.max(8, top)
      tipEl.style.top = Math.round(top) + 'px'
    }
    _hideDetail() {
      if (this.detail) this.detail.hidden = true
    }
    // 详情正文缩放（AI-032）：基准字号变量 --gd-fs（子元素全用 em 跟随缩放）
    _applyDetailFont() {
      if (!this.detail) return
      this.detail.style.setProperty('--gd-fs', this._detailFont + 'px')
      const up = this.detail.querySelector('#gv-d-fs-up')
      const down = this.detail.querySelector('#gv-d-fs-down')
      if (up) up.disabled = this._detailFont >= this._detailFontMax
      if (down) down.disabled = this._detailFont <= this._detailFontMin
    }
    _setDetailFont(delta) {
      const n = Math.max(this._detailFontMin, Math.min(this._detailFontMax, this._detailFont + delta))
      if (n === this._detailFont) return
      this._detailFont = n
      try { localStorage.setItem('coread.graphDetailFont', String(n)) } catch {}
      this._applyDetailFont()
    }
  }

  function nodePoint(view, id) {
    const n = view.run && view.run.byId.get(id)
    return n ? n.point : id
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  // 搜索命中高亮（详情面板用，2026-10）：把文本按查询切分，命中的片段包 <mark>。
  // 分段后各自 esc，避免先整体转义再套标签时把 &lt; 等实体的中间部分误当命中打坏。
  function hlText(text, q) {
    if (!q) return escHtml(text)
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('(' + safeQ + ')', 'i')
    return String(text).split(re).map((p) => {
      if (p && p.toLowerCase() === q.toLowerCase()) return '<mark>' + escHtml(p) + '</mark>'
      return escHtml(p)
    }).join('')
  }
  /**
   * 按「固定字符数」分行——折行点只由字符数决定，与字号/缩放完全解耦。
   * 这样缩放图时文字只改变大小、每行内容与折行点始终保持不变（稳定排版）。
   * 中文知识点近似等宽，按字符数分行简洁稳定；超过 maxLines 才在末行加 …。
   */
  function wrapText(text, charsPerLine, maxLines) {
    const src = String(text || '').replace(/\s+/g, ' ').trim()
    if (!src) return [' ']
    charsPerLine = Math.max(1, charsPerLine || 16)
    maxLines = maxLines || 3
    const all = []
    for (let i = 0; i < src.length; i += charsPerLine) all.push(src.slice(i, i + charsPerLine))
    if (all.length <= maxLines) return all
    const head = all.slice(0, maxLines - 1)
    let rem = all.slice(maxLines - 1).join('')
    if (rem.length > charsPerLine) rem = rem.slice(0, Math.max(charsPerLine - 1, 1)) + '…'
    head.push(rem)
    return head
  }
  function drawLabel(ctx, text, x, y, alpha, charsPerLine, withBg, fontPx, maxLines, fade) {
    fontPx = fontPx || 12
    if (fade == null) fade = 1
    ctx.font = fontPx + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif'
    const lines = wrapText(text, charsPerLine, maxLines || 3)
    let maxW = 0
    for (const l of lines) { const w = ctx.measureText(l).width; if (w > maxW) maxW = w }
    const lineH = fontPx * 1.3
    // 重点标签白底 pill：按最长行实际宽度整块覆盖。折行点固定，只随字号整体缩放。
    if (withBg) {
      ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.88 * fade).toFixed(3) + ')'
      const bw = maxW + 12, bh = lines.length * lineH + 6
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x - bw / 2, y - 3, bw, bh, 6); ctx.fill() }
      else ctx.fillRect(x - bw / 2, y - 3, bw, bh)
    }
    ctx.fillStyle = 'rgba(30, 34, 40, ' + (0.96 * alpha * fade).toFixed(3) + ')'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x, y + i * lineH)
  }
  console.log('[CoRead] graph-view v38 已加载：每张讨论卡片显示轮次排号（AI-038）')
  global.CoReadGraphView = { GraphView, utils: { computePath, topoSort, hashStr, mulberry32, clamp, wrapText, bookName, colorDist, assignBookColors } }
})(typeof window !== 'undefined' ? window : globalThis)