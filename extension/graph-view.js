/**
 * 会意图拓扑视图（AI-020）
 *
 * Obsidian 式话题拓扑图：节点 = 知识点（point），边 = 用户问题意识轨迹（有向，
 * kind = user 用户引用 / derived 对话衍生）。对应 topic-library-design.md §5 会意图。
 *
 * 两种状态：
 * - 观察态（一般情况）：浏览整张拓扑图——滚轮缩放、拖拽空白平移、拖节点微调布局、
 *   悬停高亮邻接子图、点选节点看详情（point / 能指 / 节点讨论 / 元信息）、
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
  const REPULSION = 13000      // 斥力系数（f = REP / d²）
  const SPRING = 0.018         // 弹簧系数（沿边）
  const REST_LEN = 170        // 边静止长度（世界单位）
  const GRAVITY = 0.009       // 重心引力系数
  const DAMPING = 0.85        // 速度阻尼
  const MAX_SPEED = 13        // 速度上限
  const TICKS = 420           // 物理迭代上限（每帧 2 子步 → 约 3.5s 收敛）
  const SETTLE_E = 0.004      // 收敛阈值（平均动能）
  const FRICTION_V = 3.0      // 静止摩擦速度阈值（世界单位/步）：低于此速度额外耗散
  const FRICTION_K = 0.45     // 静止摩擦系数：低速每步再乘 0.45，静止时安静不发飘
  const COLLIDE_PAD = 1.0     // 碰撞死区（屏幕 px）：重叠小于此值不推，静止不发飘（亚像素重叠不可见）
  const LABEL_MIN_SCALE = 0.5  // 标签可见/参与碰撞的最低缩放：低于此值不画标签，也不做标签碰撞（防缩小后乱碰）
  const MAX_PUSH = 24         // 单对单帧最大推开量（世界单位）：防极端缩放/拖拽时瞬时甩飞
  const MAX_STEP = 6          // 单节点每帧最大位移预算（世界单位）：重排渐进发生，不爆发式甩飞


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
     *   onHitNotify: (count:number)=>void  命中但图视图未打开时的通知回调
     */
    constructor(opts = {}) {
      this.recv = opts.receiver || 'http://127.0.0.1:7239'
      this.container = opts.container
      this.onHitNotify = typeof opts.onHitNotify === 'function' ? opts.onHitNotify : null

      this.graph = null      // { nodes, edges, demo, updatedAt }
      this.run = null        // 运行时：{ nodes:[{id,point,aliases,discussions,books,r,x,y,vx,vy,pinned,color}], edges:[{from,to,kind}], byId }
      this.cam = { x: 0, y: 0, scale: 1 }   // 世界→屏幕：sx = (wx - cam.x)*scale + W/2
      this.hl = null         // 高亮态：{ mode:'hit'|'manual'|'search', ids:Set, edges:Set, roots:[], recent:[], targets:[], reason, at }
      this.hover = null      // 悬停节点 id
      this.sel = null        // 选中节点 id
      this.pendingHits = null // 图未打开时收到的命中 { hits, reason }
      this._physics = { running: false, tick: 0 }
      this._anim = null      // 相机动画
      this._pulseUntil = 0
      this._dragging = null
      // 悬停过渡（AI-027）：压暗/放大/pill 淡入淡出按帧缓动，不再闪变
      this._nodeDim = new Map()   // 节点压暗强度 0..1（1 = 非邻接全暗）
      this._edgeDim = new Map()   // 边压暗强度 0..1
      this._mag = new Map()       // 放大 + 标签 pill 淡入强度 0..1
      this._raf = 0
      this._built = false
      this._bound = false
      this._open = false
      this._demo = false
      this._source = 'file'   // 图数据来源：file（固化图）| results（冒烟有效图）| demo（演示拓扑）
      this._baseScale = 0       // 内容长度分级基准 = 初始 fit scale（决定初始化显示多短）
      this._bookColors = null   // 同图取色表（AI-028）：buildRun 时按全部书名贪心分配
      this._detailFont = 15    // 详情正文基准字号（AI-032），A± 缩放 13~22px，localStorage 记忆
      this._detailFontMin = 13
      this._detailFontMax = 22
      try { const v = +localStorage.getItem('coread.graphDetailFont'); if (v >= this._detailFontMin && v <= this._detailFontMax) this._detailFont = v } catch {}
      this._settleFitted = false  // 物理收敛后是否已自动适配一次
      this._w = 0
      this._h = 0
      this._ro = null
    }

    // ── 公开接口 ──────────────────────────────────────────────────────────
    open() {
      this._open = true
      if (!this.container) return
      this.container.classList.add('on')
      if (!this._built) this._build()
      this._bind()
      this._resize()
      // 双保险（AI-021）：display:none → flex 切换后 clientWidth/clientHeight 常要到
      // 下一帧才稳定，直接读可能是 0（canvas 按 0 尺寸渲染成空画布）。等一帧再测一次。
      requestAnimationFrame(() => { if (this._open) { this._resize(); this.render() } })
      if (this.pendingHits) {
        const p = this.pendingHits
        this.pendingHits = null
        this.applyHit(p.hits, p.reason, 'hit')
      } else {
        this.loadGraph(this._demo)   // 每次打开重拉一次，图文件更新即生效
      }
    }
    close() {
      this._open = false
      this.hover = null
      this._physics.running = false   // 关闭时停掉常驻物理/渲染循环，避免后台空转
      this._hideTooltip()
      if (this.container) this.container.classList.remove('on')
    }
    isOpen() { return this._open }

    /** SSE graph-hit 命中：图未打开时暂存 + 通知，打开时应用 */
    onHit(hits, reason) {
      const ids = (Array.isArray(hits) ? hits : []).filter(Boolean)
      if (!ids.length) return
      if (!this._open) {
        this.pendingHits = { hits: ids, reason: reason || '' }
        if (this.onHitNotify) this.onHitNotify(ids.length)
        return
      }
      this.applyHit(ids, reason || '', 'hit')
    }

    /** 图文件更新（SSE graph-updated）：开着就重拉；重拉后保留高亮（按 targets 重算） */
    reload() {
      if (!this._open) return
      this.loadGraph(this._demo)
    }

    /** 重新拉图并（重）布局。返回 Promise<graph|null> */
    async loadGraph(demo) {
      this._demo = !!demo
      this._setLoading('加载中…')
      try {
        const res = await fetch(this.recv + '/graph' + (this._demo ? '?demo=1' : ''))
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const g = await res.json()
        this.graph = {
          nodes: Array.isArray(g.nodes) ? g.nodes : [],
          edges: Array.isArray(g.edges) ? g.edges : [],
          demo: !!g.demo,
          updatedAt: g.updatedAt || 0,
        }
        this._demo = this.graph.demo
        this._source = g.source || (this._demo ? 'demo' : 'file')
        this._updateSourceBadge()
        this._settleFitted = false
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
        this.render()
        return this.graph
      } catch (e) {
        this._setLoading('')
        this._setEmpty(true, '加载拓扑失败（receiver 未启动？），可重试。', true)
        console.warn('[CoRead] graph load failed:', e)
        return null
      }
    }

    /** 命中应用：算 root→recent 路径并集 → 高亮 + 横幅 + 适配相机（手动高亮不动相机） */
    async applyHit(hits, reason, mode) {
      if (!this.graph) {
        const g = await this.loadGraph(this._demo)
        if (!g) return
      }
      const result = computePath(this.run.nodes, this.run.edges, hits)
      if (!result.ordered.length) {
        if (this.onHitNotify) this.onHitNotify(0)
        return
      }
      this.setHighlight(result, mode || 'hit', reason || '')
      if (mode !== 'manual') {
        this.fitToNodes(result.ordered.map((id) => this.run.byId.get(id)).filter(Boolean), true)
      }
    }

    /** 手动：高亮某节点的 root→recent 路径（详情面板按钮） */
    highlightFrom(nodeId, mode) {
      const n = this.run && this.run.byId.get(nodeId)
      if (!n) return
      const result = computePath(this.run.nodes, this.run.edges, [nodeId])
      this.setHighlight(result, mode || 'manual', '')
      if (mode === 'simulate') this.fitToNodes(result.ordered.map((id) => this.run.byId.get(id)).filter(Boolean), true)
    }

    setHighlight(result, mode, reason) {
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
      this._pulseUntil = Date.now() + 1600
      this._renderBanner()
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
      this._renderBanner()
    }
    clearHighlight() {
      this.hl = null
      this._renderBanner()
      this.render()
    }

    selectNode(id) {
      this.sel = id
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
      this.run = { nodes, edges, byId: new Map(nodes.map((n) => [n.id, n])) }
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
          if (sp < FRICTION_V && !this._dragging) { n.vx *= FRICTION_K; n.vy *= FRICTION_K }
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

      const hl = this.hl
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
        if (hlIds) { onPath = hlEdges.has(e); alpha = onPath ? 1 : 0.16 }
        else if (hoverOn) alpha = 0.62 - (this._edgeDim.get(e.from + '>' + e.to) || 0) * 0.5
        ctx.globalAlpha = alpha
        ctx.strokeStyle = onPath && hlIds ? COLORS.pathAccent : (e.kind === 'user' ? COLORS.edgeUser : COLORS.edgeDerived)
        ctx.lineWidth = onPath && hlIds ? 2.2 : 1.4
        const x1 = tx(a.x), y1 = ty(a.y), x2 = tx(b.x), y2 = ty(b.y)
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
        // 方向箭头（有向图：引用方向 from → to；低缩放/短边不画，防噪）
        const segLen = Math.hypot(x2 - x1, y2 - y1)
        if (cam.scale > 0.45 && segLen > 44) {
          const ang = Math.atan2(y2 - y1, x2 - x1)
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
        // recent 深绿实环 + 脉冲（命中节点 = 当前讨论所在节点）
        if (hl && hl.recent.includes(n.id)) {
          const k = clamp(1 - (Date.now() - hl.at) / 1400, 0, 1)
          ctx.globalAlpha = alpha * (0.45 + 0.55 * k)
          ctx.strokeStyle = COLORS.recentMark
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(px, py, r + 4.5 + (1 - k) * 8, 0, Math.PI * 2)
          ctx.stroke()
          ctx.globalAlpha = alpha
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
        this.cam = target
        if (!this._baseScale) this._baseScale = target.scale   // 记录初始 fit 基准（内容长度分级用）
        this.render()
      }
    }
    _animCam(to) {
      this._anim = { from: { ...this.cam }, to, t0: Date.now(), dur: 360 }
      this._ensureLoop()
    }
    _stepAnim() {
      const a = this._anim
      if (!a) return
      const k = clamp((Date.now() - a.t0) / a.dur, 0, 1)
      const e = 1 - Math.pow(1 - k, 3)
      this.cam.x = a.from.x + (a.to.x - a.from.x) * e
      this.cam.y = a.from.y + (a.to.y - a.from.y) * e
      this.cam.scale = a.from.scale + (a.to.scale - a.from.scale) * e
      if (k >= 1) this._anim = null
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
            if (!this._settleFitted && this.run) {
              this._settleFitted = true
              this.fitToNodes(this.run.nodes, true)
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
      const hlIds = this.hl ? this.hl.ids : null
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
          '<button class="gv-btn" id="gv-fit" title="适配全部节点">适应</button>' +
          '<button class="gv-btn" id="gv-legend-btn" title="图例">图例</button>' +
          '<button class="gv-btn gv-close" id="gv-close" title="关闭">✕</button>' +
        '</div>' +
        '<div class="gv-banner" id="gv-banner" hidden>' +
          '<span class="gv-banner-text" id="gv-banner-text"></span>' +
          '<button class="gv-btn gv-banner-clear" id="gv-banner-clear">清除高亮</button>' +
        '</div>' +
        '<div class="gv-canvas-wrap" id="gv-wrap">' +
          '<canvas id="gv-canvas"></canvas>' +
          '<div class="gv-hint">滚轮缩放 · 拖空白平移 · 悬停节点看名称 · 点选看详情</div>' +
          '<div class="gv-legend" id="gv-legend" hidden>' +
            '<div><span class="sw" style="background:#6d72e8"></span>user 边 · 用户引用</div>' +
            '<div><span class="sw" style="background:#8a92a6"></span>derived 边 · 对话衍生</div>' +
            '<div><span class="ring" style="border-color:#9aa3f2"></span>root · 路径起点（无入边）</div>' +
            '<div><span class="ring" style="border-color:#3f45cd"></span>recent · 当前命中节点</div>' +
            '<div class="gv-lg-title">节点颜色 · 所属书籍</div>' +
            '<div id="gv-legend-books"></div>' +
          '</div>' +
          '<div class="gv-detail" id="gv-detail" hidden>' +
            '<div class="gd-head"><span class="gd-title" id="gv-d-point"></span>' +
              '<span class="gd-fsgroup"><button class="gd-fsbtn" id="gv-d-fs-down" title="缩小字号">A−</button><button class="gd-fsbtn" id="gv-d-fs-up" title="放大字号">A＋</button></span>' +
              '<button class="gd-close" id="gv-d-close" title="关闭">✕</button></div>' +
            '<div class="gd-body">' +
              '<div class="gd-label">能指</div>' +
              '<div id="gv-d-aliases"></div>' +
              '<div class="gd-discs-zone" id="gv-d-zone">' +
                '<div class="gd-label">专题化讨论</div>' +
                '<div id="gv-d-discs"></div>' +
              '</div>' +
              '<div class="gd-actions">' +
                '<button class="gv-btn primary" id="gv-d-path">高亮此节点路径</button>' +
                '<button class="gv-btn" id="gv-d-sim" title="模拟一次引用解析命中，演示命中高亮">模拟命中（演示）</button>' +
              '</div>' +
              '<div class="gd-note" id="gv-d-note" hidden>演示数据：节点只有知识点表述（point）。能指与专题化讨论由会意系统在真实讨论收口固化时生成，真实图写入后此处会显示。</div>' +
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
          if (!d.moved) this.selectNode(d.id)
          else this.render()
        } else if (d && d.kind === 'pan' && !d.moved) {
          // 点击空白（未拖动）→ 取消选中，回到浏览态
          if (this.sel) this.closeDetail()
        }
      }
      cv.addEventListener('pointerup', endDrag)
      cv.addEventListener('pointercancel', endDrag)
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
      this.container.querySelector('#gv-fit').addEventListener('click', () => this.fitToNodes(this.run ? this.run.nodes : [], true))
      const legendBtn = this.container.querySelector('#gv-legend-btn')
      legendBtn.addEventListener('click', () => {
        const el = this.container.querySelector('#gv-legend')
        const show = el.hidden
        el.hidden = !show
        legendBtn.textContent = show ? '图例 ✓' : '图例'
      })
      this.container.querySelector('#gv-banner-clear').addEventListener('click', () => this.clearHighlight())
      this.container.querySelector('#gv-d-close').addEventListener('click', () => this.closeDetail())
      this._applyDetailFont()
      const fsUp = this.container.querySelector('#gv-d-fs-up')
      const fsDown = this.container.querySelector('#gv-d-fs-down')
      if (fsUp) fsUp.addEventListener('click', () => this._setDetailFont(1))
      if (fsDown) fsDown.addEventListener('click', () => this._setDetailFont(-1))
      this.container.querySelector('#gv-d-path').addEventListener('click', () => {
        if (this.sel) this.highlightFrom(this.sel, 'manual')
      })
      this.container.querySelector('#gv-d-sim').addEventListener('click', () => {
        if (this.sel) this.highlightFrom(this.sel, 'simulate')
      })
      this.container.querySelector('#gv-empty-demo').addEventListener('click', () => this.loadGraph(true))
      this.container.querySelector('#gv-empty-retry').addEventListener('click', () => this.loadGraph(this._demo))

      const search = this.container.querySelector('#gv-search')
      search.addEventListener('input', () => {
        const q = search.value.trim()
        if (!q) {
          if (this.hl && this.hl.mode === 'search') this.clearHighlight()
          this.render()
          return
        }
        const run = this.run
        if (!run) return
        const matches = run.nodes.filter((n) => {
          const hay = [n.point].concat(n.aliases, n.discussions.map((d) => d.question)).join(' ').toLowerCase()
          return hay.includes(q.toLowerCase())
        })
        if (!matches.length) {
          if (this.hl && this.hl.mode === 'search') this.clearHighlight()
          this._setBanner('🔍 无匹配「' + q + '」', '')
          return
        }
        const ids = matches.map((n) => n.id)
        const result = computePath(run.nodes, run.edges, ids)
        this.setHighlight(Object.assign({}, result, { recent: [] }), 'search', '🔍 搜索「' + q + '」命中 ' + ids.length + ' 个节点')
        this.fitToNodes(matches, true)
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
    _renderBanner() {
      const hl = this.hl
      if (!hl) {
        this.banner.hidden = true
        return
      }
      let text = ''
      if (hl.mode === 'search') text = hl.reason || '搜索命中'
      else if (hl.mode === 'simulate') text = '🔗 模拟命中（演示）：高亮「' + nodePoint(this, hl.targets[0]) + '」的 root→recent 路径（' + hl.ids.size + ' 节点）'
      else if (hl.mode === 'manual') text = '◎ 已高亮「' + nodePoint(this, hl.targets[0]) + '」的 root→recent 路径（' + hl.ids.size + ' 节点）'
      else text = '🔗 会话命中：引用解析命中 ' + hl.targets.length + ' 个节点 → 高亮 root→recent 路径并集（' + hl.ids.size + ' 节点）'
      if (hl.reason && hl.mode !== 'search') text += ' · ' + hl.reason
      this._setBanner(text, hl.mode === 'hit' || hl.mode === 'simulate' ? 'hit' : '')
    }
    _setBanner(text, kind) {
      if (!text) { this.banner.hidden = true; return }
      this.banner.hidden = false
      this.banner.className = 'gv-banner' + (kind === 'hit' ? ' hit' : '')
      this.bannerText.textContent = text
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
      html += '<div>' + discs + ' 次专题化讨论 · ' + (n.aliases || []).length + ' 条能指</div>'
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
      const isDemo = !!(this.graph && this.graph.demo)
      this.detail.querySelector('#gv-d-point').textContent = n.point
      const aliasEl = this.detail.querySelector('#gv-d-aliases')
      aliasEl.innerHTML = (n.aliases && n.aliases.length)
        ? n.aliases.map((a) => '<div class="gd-alias">' + escHtml(a) + '</div>').join('')
        : '<div class="gd-none">' + (isDemo ? '（演示数据无能指）' : '（无能指）') + '</div>'
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
            const q = e && e.q ? '<div class="gd-ex"><span class="gxl">问</span><span class="gd-ext">' + escHtml(String(e.q)) + '</span></div>' : ''
            const a = e && e.a ? '<div class="gd-ex gd-ex-a"><span class="gxl">答</span><span class="gd-ext">' + escHtml(String(e.a)) + '</span></div>' : ''
            return '<div class="gd-round">' + q + a + '</div>'
          }).join('')
          return '<div class="gd-disc">' +
            '<div class="gd-q"><span class="gd-caret">▸</span><span class="gd-qtext">' + escHtml(d.question || '') + '</span></div>' +
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