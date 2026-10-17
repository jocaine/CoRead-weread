#!/usr/bin/env node
/**
 * 「适宽」：面板拉宽后页面不重排的兜底（2026-11 用户报）
 *
 * 用户原话：「在马克思中文网…有一个页面它貌似有自己的最小宽度，导致我拉大面板的时候，
 * 左侧页面并没有自己适应，而是部分被遮盖」。根因在页面自己（老文库页是固定宽度版心），
 * 侧栏只是夺走了网页区的宽度。所以这段代码做的是**改页面**：只把"比可视区还宽"的那几个
 * 元素压回来，文字重排、字号不变；全程只动行内 style，可逐条还原。
 *
 * 这里锁的是**最容易悄悄坏掉的两处纯逻辑**（把函数源码抠出来，配桩数据真跑）：
 *   · fitOffenders：只留最外层（祖先已在名单里就丢子孙）＋ 绝不碰我们自己的浮层；
 *   · fitMinWidthRules：跨域样式表读 cssRules 会抛，抛了必须跳过、不能整个探针挂掉。
 * 另外几条源码级守卫锁"改完还能还原"与"必须被 boot 调到"。
 *
 * 真机行为（到底能不能把那页压回来）这个测试盖不到：那要用户在浏览器里点一下，
 * 结果由页面自己写的 /debug 探针回报（见 fitProbe）。
 * 跑法：node --test agent/test/mia-fit-width.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_PATH = path.join(__dirname, '..', '..', 'extension', 'source-mia.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf8')

/** 抠出一个 2 空格缩进的函数体（与仓库里其它源码级守卫同一套做法） */
function fnSource(name) {
  const at = SRC.indexOf('function ' + name + '(')
  assert.ok(at > 0, `找不到 function ${name}()`)
  const end = SRC.indexOf('\n  }\n', at)
  assert.ok(end > at, `找不到 function ${name} 的结尾`)
  return SRC.slice(at, end + 4)
}

/** 把函数源码 + 它依赖的闭包变量一起包成一个可调用的函数 */
function buildFn(name, deps) {
  const keys = Object.keys(deps)
  const body = fnSource(name)
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body + `\n  return ${name};`)(...keys.map((k) => deps[k]))
}

// ── 桩元素 ─────────────────────────────────────────────────────────────────
function el({ tag = 'DIV', w = 0, right = null, cls = '', id = '', inside = null, style = '', widthAttr = null } = {}) {
  const node = {
    tagName: tag, id, className: cls,
    _w: w, _inside: inside,
    _attrs: Object.assign({}, style ? { style } : {}, widthAttr != null ? { width: widthAttr } : {}),
    children: [],
    getBoundingClientRect() { return { width: this._w, right: this._right != null ? this._right : this._w } },
    getAttribute(n) { return n in this._attrs ? this._attrs[n] : null },
    contains(o) { return this.children.includes(o) },
    // 只回答"有没有落在我们自己的浮层里"——真实代码调的正是 closest(OUR_UI_SEL)。
    // 早先这里写成"直接返回 _inside"，于是任何有祖先的元素都被当成"在我们浮层里"被跳过，
    // 掩盖过一条真错（body 与它的子元素一起被丢）。
    closest() {
      let p = this._inside
      while (p) {
        if (String(p.className || '').split(/\s+/).indexOf('coread-mia-ui') !== -1) return p
        p = p._inside
      }
      return null
    },
  }
  if (right != null) node._right = right
  if (inside) inside.children.push(node)
  return node
}

/** fitOffenders 的依赖（qsa 只给后代，body 由 document.body 传进去） */
function offendersOf(body, descendants, slop = 2) {
  return buildFn('fitOffenders', {
    qsa: () => descendants,
    OUR_UI_SEL: '.coread-mia-ui',
    document: { body: body },
    FIT_SLOP: slop,
  })
}

const OUR_UI = { tagName: 'DIV', className: 'coread-mia-ui', children: [] }

/** 只够 fitDetect 用的最小节点（它只读 clientWidth/scrollWidth/tagName/className/closest） */
function fakeNode(tag, over = {}) {
  return Object.assign({
    tagName: tag, id: '', className: '', clientWidth: 0, scrollWidth: 0,
    closest: () => null, getBoundingClientRect: () => ({ width: 0, right: 0 }),
  }, over)
}

// ── fitOffenders：只留最外层 + 跳过我们自己的浮层 ──────────────────────────
test('fitOffenders：祖先已在名单里就不再收子孙（否则压重复、还原清单也乱）', () => {
  const wrapper = el({ tag: 'TABLE', w: 900 })
  const inner = el({ tag: 'TD', w: 880, inside: wrapper })
  const lone = el({ tag: 'DIV', w: 800 })
  const fitOffenders = offendersOf(el({ tag: 'BODY', w: 600 }), [wrapper, inner, lone, el({ tag: 'P', w: 300 })])
  const got = fitOffenders(600).map((o) => o.el.tagName + ':' + o.w)
  assert.deepEqual(got, ['TABLE:900', 'DIV:800'], '只留最外层那两个；不超宽的 P 不收')
})

test('fitOffenders：我们自己注入的浮层/胶囊/对话框绝不能被压（压了就点不着了）', () => {
  const mine = el({ tag: 'BUTTON', w: 900, inside: OUR_UI })
  const page = el({ tag: 'DIV', w: 900 })
  const fitOffenders = offendersOf(el({ tag: 'BODY', w: 600 }), [mine, page])
  const got = fitOffenders(600).map((o) => o.el.tagName)
  assert.deepEqual(got, ['DIV'], '只收页面自己的元素')
})

test('fitOffenders：只比可视区宽 1px 的不动（容差 2px，防亚像素抖动来回改）', () => {
  const fitOffenders = offendersOf(el({ tag: 'BODY', w: 600 }), [el({ tag: 'DIV', w: 601 }), el({ tag: 'DIV', w: 603 })])
  assert.deepEqual(fitOffenders(600).map((o) => o.w), [603])
})

// ── fitDetect：两种"装不下"都要认出来（用户报"没看到胶囊"的根因） ──────────
test('fitDetect：文档宽度干净、但有元素被 overflow:hidden 裁掉时，也要算"装不下"', () => {
  // 这是用户那种「部分被遮盖」：祖先写了 overflow:hidden，溢出的部分被裁掉，
  // documentElement.scrollWidth 是干净的（旧判据量不到 → 胶囊不出现），
  // 但元素的布局宽度就是 900，比 600 的可视区宽出 300。
  const fitWidths = () => ({ vw: 600, docW: 600 })
  const fitOffenders = () => [{ el: fakeNode('TABLE'), w: 900 }]
  const qsa = () => []
  const fitDetect = buildFn('fitDetect', { fitWidths, fitOffenders, qsa, OUR_UI_SEL: '.coread-mia-ui' })
  const d = fitDetect()
  assert.equal(d.docOver, 0, '文档层面确实没溢出')
  assert.equal(d.worst - d.vw, 300, '但最宽元素超出 300px —— 这一条必须被报出来')

  const fitOverflowing = buildFn('fitOverflowing', { fitDetect })
  assert.equal(fitOverflowing(), 300, '"还装不下多少"取两者的大者（只看文档宽度就会漏判）')
})

test('fitOffenders：必须带上 body 自己（固定宽度常挂在 body 上，只扫 body * 会晚 36px）', () => {
  // 实测那页：整页 997、后代里最宽的是表格。只扫 `body *` → 判据要等到表格
  // 也被压到才成立 → 用户："压到文字也没立即出现，还要再多压一点"。
  // 这里让 body 与里面的表格**都超宽**，才能同时验证"带上 body"和"body 不吞子孙"。
  const body = el({ tag: 'BODY', w: 997 })
  const table = el({ tag: 'TABLE', w: 995, inside: body })
  const fitOffenders = offendersOf(body, [table])
  const got = fitOffenders(991).map((o) => o.el.tagName)
  assert.deepEqual(got, ['BODY', 'TABLE'],
    'body 自己必须在名单里（否则压不到真正撑住页面的那个）；里面的固定宽表格也要一起留着 —— '
    + 'body 变流体了，里面那个照样溢出')
})

test('fitOffenders：装得下的时候一个都不收（子元素没超宽就不该被牵连）', () => {
  const body = el({ tag: 'BODY', w: 997 })
  const table = el({ tag: 'TABLE', w: 960, inside: body })   // 960 < 991 → 它自己是装得下的
  const fitOffenders = offendersOf(body, [table])
  assert.deepEqual(fitOffenders(991).map((o) => o.el.tagName), ['BODY'], '只有 body 超宽')
})

test('fitOffenders：右边缘伸到可视区外的也算（绝对定位/负边距，自身宽度可能并不大）', () => {
  const narrow = el({ tag: 'DIV', w: 100, right: 1100 })   // 自身只有 100 宽，但右边缘在 1100
  const big = el({ tag: 'TABLE', w: 900 })
  const document = { body: el({ tag: 'BODY', w: 600 }) }
  const qsa = () => [narrow, big]
  const fitOffenders = buildFn('fitOffenders', { qsa, OUR_UI_SEL: '.coread-mia-ui', document, FIT_SLOP: 2 })
  const got = fitOffenders(600).map((o) => o.el.tagName)
  assert.deepEqual(got, ['DIV', 'TABLE'], '两种都算 offender（顺序＝扫描顺序：body 的后代里先小后大）')
})

test('fitOffenders：只比可视区宽 1px 的不动（容差 2px，防亚像素抖动来回改）', () => {
  const qsa = () => [el({ tag: 'DIV', w: 601 }), el({ tag: 'DIV', w: 603 })]
  const document = { body: el({ tag: 'BODY', w: 600 }) }
  const fitOffenders = buildFn('fitOffenders', { qsa, OUR_UI_SEL: '.coread-mia-ui', document, FIT_SLOP: 2 })
  assert.deepEqual(fitOffenders(600).map((o) => o.w), [603])
})

// ── fitDetect：两种"装不下"都要认出来 ─────────────────────────────────────
test('回归：页面一开始被切就报警（用户要的"压到页面就出现"），不再等压到文字', () => {
  // 真实现场：vw=991 / docW=997 → 被切 6px。第一版在这里就亮（用户要的就是这个时机），
  // 第二版因为漏了 body 拖到 vw=955 才亮（用户："还要再多压一点"）。这条把它钉住。
  const fitWidths = () => ({ vw: 991, docW: 997 })
  const fitOffenders = () => [{ el: fakeNode('BODY'), w: 997 }]
  const qsa = () => []
  const fitDetect = buildFn('fitDetect', { fitWidths, fitOffenders, qsa, OUR_UI_SEL: '.coread-mia-ui' })
  const fitOverflowing = buildFn('fitOverflowing', { fitDetect })
  assert.equal(fitOverflowing(), 6, '被切 6px 就该算"装不下"')
  assert.equal(fitDetect().offenders.length, 1, '而且这一瞬有东西可压（body）—— 点下去不是空动作')
})

test('fitOverflowing：三个信号取大者（整页 / 元素宽度 / 右边缘）', () => {
  const mk = (det) => buildFn('fitOverflowing', { fitDetect: () => det })
  assert.equal(mk({ vw: 600, docW: 760, docOver: 160, worst: 0, edgeOver: 0, offenders: [] })(), 160, '整页被切')
  assert.equal(mk({ vw: 600, docW: 600, docOver: 0, worst: 960, edgeOver: 0, offenders: [1] })(), 360, '元素比可视区宽')
  assert.equal(mk({ vw: 600, docW: 600, docOver: 0, worst: 0, edgeOver: 44, offenders: [1] })(), 44, '右边缘伸出去')
  assert.equal(mk({ vw: 600, docW: 600, docOver: 0, worst: 0, edgeOver: 0, offenders: [] })(), 0, '都正常 → 不出手')
})

test('fitDetect：顺手记下"元素自己横向滚动"的（另有其事，只报不压）', () => {
  const fitWidths = () => ({ vw: 600, docW: 600 })
  const fitOffenders = () => []
  const scroller = fakeNode('DIV', { clientWidth: 500, scrollWidth: 900 })
  const qsa = () => [scroller, fakeNode('P', { clientWidth: 500, scrollWidth: 500 })]
  const fitDetect = buildFn('fitDetect', { fitWidths, fitOffenders, qsa, OUR_UI_SEL: '.coread-mia-ui' })
  const d = fitDetect()
  assert.equal(d.scrollables.length, 1, '只记真正在横向滚的那个')
  assert.equal(d.scrollables[0].over, 400)
})


test('fitMinWidthRules：跨域样式表读 cssRules 抛异常时跳过它，别把整条探针带下去', () => {
  const crossOrigin = { get cssRules() { throw new Error('SecurityError') } }
  const sameOrigin = {
    cssRules: [
      { cssText: 'body { color: red }' },
      { cssText: 'table.layout { min-width: 760px }' },
      { cssText: 'div { max-width: 100% }' },
    ],
  }
  const document = { styleSheets: [crossOrigin, sameOrigin] }
  const fn = buildFn('fitMinWidthRules', { document })
  const got = fn(6)
  assert.deepEqual(got, ['table.layout { min-width: 760px }'], '只挑出写了 min-width 的规则')
})

// ── fitApply 幂等 + 还原清单（拖动时会连着跑好几趟，这里最容易把还原搞坏） ────
/** 只够 fitApply/fitRevert 用的状态与依赖 */
function applyState(offenders, widths) {
  const touched = [];
  const pressed = new Set();
  const zoom = { v: '' };
  const document = {
    documentElement: {
      style: {
        set zoom(v) { zoom.v = v },
        get zoom() { return zoom.v },
      },
    },
  };
  const fitDetect = () => ({ vw: 600, docW: 900, docOver: 300, worst: 900, offenders, scrollables: [] });
  const fitOverflowing = () => 0;
  const fitWidths = () => widths || { vw: 600, docW: 600 };
  const qsa = () => [];
  const deps = { fitDetect, fitOverflowing, qsa, OUR_UI_SEL: '.coread-mia-ui', fitWidths, document, fitTouched: touched, fitPressed: pressed };
  return {
    touched, pressed, zoom, document, deps,
    fitApply: buildFn('fitApply', deps),
    fitRevert: buildFn('fitRevert', deps),
  };
}
/** 够 fitApply 写行内样式用的最小节点 */
function pressableNode(tag) {
  const attrs = { style: null, width: '960' };
  return {
    tagName: tag,
    style: { set(v, val) { attrs[v] = val }, setProperty(k, v) { attrs[k] = v } },
    _attrs: attrs,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = v },
    hasAttribute: (n) => n in attrs && attrs[n] != null,
    removeAttribute: (n) => { delete attrs[n] },
  };
}

test('fitApply 幂等：同一个元素压两次只登记一条（否则"恢复原样"会把已压的样子当原样存回去）', () => {
  const node = pressableNode('TABLE');
  const s = applyState([{ el: node, w: 960 }]);
  assert.equal(s.fitApply(), 1, '第一次压了 1 个');
  assert.equal(s.touched.length, 1, '登记 1 条（原样）');
  assert.equal(s.fitApply(), 0, '第二次什么都不压（幂等）');
  assert.equal(s.touched.length, 1, '登记仍然只有 1 条 —— 重复登记就等于还原不回去');
  assert.equal(s.pressed.size, 1);
  // 老式 width 属性被摘掉（CSS 的 !important 压不过它）
  assert.equal(node.hasAttribute('width'), false, 'width="960" 属性必须摘掉');
})

test('fitRevert：还原后要清 fitPressed（不清的话下次 apply 会以为已经压过、漏压）', () => {
  const node = pressableNode('TABLE');
  const s = applyState([{ el: node, w: 960 }]);
  s.fitApply();
  assert.equal(s.pressed.size, 1, '前置：压过 1 个');
  s.fitRevert();
  assert.equal(s.pressed.size, 0, '还原后必须清空（与 fitTouched 同生同灭）');
  assert.equal(s.zoom.v, '', 'zoom 也要清掉');
  assert.equal(node.getAttribute('width'), '960', 'width 属性恢复原值');
})

test('fitApply：压完还装不下才用整体缩放（这时字会变小，日志里也记了）', () => {
  const node = pressableNode('TABLE');
  const s = applyState([{ el: node, w: 960 }], { vw: 600, docW: 1200 });
  s.fitApply();
  assert.equal(s.zoom.v, '0.5', '(600-2)/1200 = 0.498 → 夹到下限 0.5')
})

// ── resize：限频（不是防抖）——这正是"胶囊出现慢"的病根 ─────────────────────
test('守卫：resize 走"便宜路径 + 限频"，不许退回防抖（防抖＝松手才反应）', () => {
  const at = SRC.indexOf("window.addEventListener('resize'");
  assert.ok(at > 0, '找不到 resize 监听')
  const block = SRC.slice(at, at + 420)
  assert.ok(/fastCheck\(\)/.test(block), 'resize 里要先跑便宜路径：两个数一读就亮胶囊，不等定时器')
  assert.equal(/clearTimeout\(fitTimer\)/.test(block), false,
    '不许 clearTimeout 重置定时器——那是防抖，拖动时会一路往后推，胶囊只在松手后出现（用户报的"慢"）')
  assert.ok(/if \(fitTimer\) return/.test(block), '贵路径要"已在排队就不重复排"（限频）')
  assert.equal(/fitRevert\(\)/.test(block), false,
    'resize 里不许先还原再压：页面会先弹回原宽再压回去（视觉上就是闪）')
})

test('守卫：便宜路径只读两个数，不许在里面做全页扫描（那正是贵的地方）', () => {
  const at = SRC.indexOf('const fastCheck = function');
  assert.ok(at > 0, '找不到 fastCheck')
  const block = SRC.slice(at, at + 380)
  assert.ok(/clientWidth/.test(block) && /scrollWidth/.test(block), '只读可视区宽 / 整页宽')
  assert.equal(/fitDetect\(/.test(block), false, '便宜路径里不许调 fitDetect（那是全页遍历）')
  assert.equal(/qsa\(/.test(block), false, '便宜路径里不许遍历元素')
})


// ── resize 现场（判断"滞后在谁身上"的唯一依据） ─────────────────────────────
test('fitBurst：把 resize 现场压成一行（宽度@相对毫秒），能看出是"连续变"还是"跳变"', () => {
  const ring = [
    { t: 1000, vw: 1135, docW: 1135 },
    { t: 1031, vw: 900, docW: 1135 },
    { t: 1080, vw: 489, docW: 997 },
  ]
  const fitBurst = buildFn('fitBurst', { fitResizeRing: ring })
  const b = fitBurst()
  assert.equal(b.events, 3)
  assert.equal(b.spanMs, 80)
  assert.equal(b.vwMin, 489)
  assert.equal(b.vwMax, 1135)
  assert.equal(b.vwLast, 489)
  assert.deepEqual(b.series, ['1135@0', '900@31', '489@80'], '拖动的每一步都要能读出来')
  assert.deepEqual(buildFn('fitBurst', { fitResizeRing: [] })(), { events: 0 }, '空现场不报错')
})

test('fitNoteResize：现场只留最近 N 条（拖动会连着来上百个事件，不能无限涨）', () => {
  const ring = []
  const fitNoteResize = buildFn('fitNoteResize', { fitResizeRing: ring, FIT_RESIZE_KEEP: 3, fitNow: () => 1 })
  for (let i = 0; i < 5; i++) fitNoteResize(100 + i, 200)
  assert.equal(ring.length, 3, '超上限就丢最老的')
  assert.deepEqual(ring.map((r) => r.vw), [102, 103, 104], '留下的是最近的几条')
})

test('守卫：一次"装不下"只留一条现场，页面重新装得下要复位（否则拖动会把日志刷满）', () => {
  const at = SRC.indexOf('const fastCheck = function')
  assert.ok(at > 0, '找不到 fastCheck')
  const block = SRC.slice(at, at + 1100)
  assert.ok(/if \(!fitOverflowLogged\)/.test(block), '便宜路径里要"一次过程只记一条"')
  assert.ok(/burst: fitBurst\(\)/.test(block), '现场要带上 resize 序列（不然定不了案）')
  assert.ok(/pillMs: fitNow\(\) - t0/.test(block), '要量"从判断出装不下到胶囊上屏"我们自己花了多久')
  const scanAt = SRC.indexOf('const scan = function')
  const scanBlock = SRC.slice(scanAt, scanAt + 1600)
  assert.ok(/if \(over <= FIT_SLOP\) fitOverflowLogged = false/.test(scanBlock), '装得下时要复位，下次溢出才有新现场')
})

test('守卫：加载路径不许等 storage 往返（溢出判断与用户偏好无关，能早一帧是一帧）', () => {
  const at = SRC.indexOf('function fitInit()')
  assert.ok(at > 0, '找不到 fitInit')
  const end = SRC.indexOf("window.addEventListener('resize'", at)
  assert.ok(end > at, '找不到 fitInit 的结尾（resize 监听）')
  const block = SRC.slice(at, end)
  const fastAt = block.indexOf('fastCheck();')
  const storageAt = block.indexOf('chrome.storage.local.get')
  assert.ok(fastAt > 0, 'fitInit 里必须先跑一次 fastCheck()')
  assert.ok(storageAt > 0, 'fitInit 里仍然要读偏好（决定要不要顺手压）')
  assert.ok(fastAt < storageAt, 'fastCheck() 必须排在等 storage 之前（否则胶囊要等一次异步往返）')
})

test('守卫：拖动的便宜路径与全页扫描必须同一口径（否则一个亮一个藏＝闪烁）', () => {
  const at = SRC.indexOf('const fastCheck = function')
  const block = SRC.slice(at, at + 1200)
  assert.ok(/docW <= vw \+ FIT_SLOP/.test(block), '便宜路径用整页宽度 + 同一容差判断"页面被切了没有"')
  assert.ok(/fitPillShow\(\)/.test(block), '判为被切就立刻亮胶囊（当帧，不等定时器）')
  assert.ok(/fitNoteResize\(vw, docW\)/.test(block), '现场记录要保留（诊断"滞后在谁身上"用）')
  const scanAt = SRC.indexOf('const scan = function')
  const scanBlock = SRC.slice(scanAt, scanAt + 600)
  assert.ok(/Math\.max\(d\.docOver/.test(scanBlock), '扫描那一趟的 over 也必须含 docOver —— 两条路口径要一致')
})

test('守卫：不许拿"缓存的最宽元素宽度"当判据（那就是当年晚 36px 的写法）', () => {
  const at = SRC.indexOf('const fastCheck = function')
  const block = SRC.slice(at, at + 1200)
  assert.equal(/fitCritW/.test(block.replace(/critW: fitCritW/, '')), false,
    '便宜路径不许用 fitCritW 判显隐：它只在扫描到 offender 时才更新，等于"要等到压到元素才亮"')
})

test('守卫：迟到的"预告式"触发没有被偷偷做进去（定稿口径＝页面一开始被切）', () => {
  // 用户明确说过"如果不好改就算了"；代码里不许出现"面板离内容还有 N 像素就亮"那种预告逻辑，
  // 否则胶囊会在"页面本来就还剩余地"时冒出来，把"被切了"这个含义弄糊。
  // 只看代码行：注释里提到"预告"（解释为什么不这么做）是允许的。
  const code = SRC.split('\n')
    .filter((l) => {
      const t = l.trim()
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  assert.equal(/prewarn|PREWARN|预告/i.test(code), false, '没有预告式触发的实现')
})

test('守卫：fitApply 每条改动都先记进 fitTouched（否则「恢复原样」还原不回去）', () => {
  const body = fnSource('fitApply')
  const pushes = (body.match(/fitTouched\.push\(/g) || []).length
  assert.ok(pushes >= 2, `fitApply 里应有"压元素/折 pre"两处登记，实际 ${pushes} 处`)
  // 登记必须发生在动 style 之前
  const firstPush = body.indexOf('fitTouched.push(')
  const firstMutate = body.indexOf('.setProperty(')
  assert.ok(firstPush > 0 && firstMutate > firstPush, 'push 必须在第一次改动之前')
})

test('守卫：fitRevert 要清 zoom（整体缩放那一步的还原最容易漏）', () => {
  const body = fnSource('fitRevert')
  assert.ok(/style\.zoom = ''/.test(body), 'fitRevert 必须清掉 documentElement 的 zoom')
  assert.ok(/fitTouched = \[\]/.test(body), '还原后要清空登记表')
})

test('守卫：boot 会调用 fitInit，且「适宽」胶囊样式存在于注入的样式表里', () => {
  assert.ok(/fitInit\(\)/.test(SRC), 'bootInner 里必须调用 fitInit()')
  assert.ok(/\.coread-mia-fitpill\{/.test(SRC), '缺少 .coread-mia-fitpill 样式（胶囊会变成裸按钮）')
  assert.ok(/left:14px/.test(SRC) && /bottom:14px/.test(SRC), '适宽胶囊固定在左下角，避开右下角的绑定胶囊')
})

test('守卫：探针必须带上 offenders 与 minWidthRules（"到底哪条规则撑着"下次不用再猜）', () => {
  const body = fnSource('fitProbe')
  for (const k of ['offenders', 'minWidthRules', 'overflow', 'fitOn']) {
    assert.ok(body.includes(k + ':') || body.includes(k + ','), `探针里缺字段 ${k}（诊断会退化成猜）`)
  }
})

test('守卫：只按站点记开关（不能写成一个全局键，否则一个站开了全站都适宽）', () => {
  assert.ok(/FIT_PREF_KEY = 'miaFit:' \+ HOST/.test(SRC), '开关必须按 host 区分')
})

test('守卫：启用范围收在马克思主义文库（B 站没报过同类问题，不擅自往那边加浮层）', () => {
  assert.ok(/const FIT_ENABLED = SITE\.name === 'marxists'/.test(SRC),
    'FIT_ENABLED 必须显式限定站点')
  assert.ok(/function fitInit\(\) \{\s*\n\s*if \(!FIT_ENABLED\) return;/.test(SRC),
    'fitInit 第一句就要拦住未启用的站点（否则等于全站生效）')
})
