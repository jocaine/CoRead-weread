/**
 * 联网搜索（lib/web-search.js）的单元测试。
 *
 * 只测纯函数与收料逻辑：真调接口的那部分靠 test\scratch\search-probe.mjs 打真 API
 * （0.3–0.5 秒一次，单元测试里不该有网络）。
 *
 * 钉住的四件事，每件都来自 2026-10-27 的实测：
 *   ① rerank_score < 1.5 的结果不许进材料（实测「党章」那次全是 1.0–1.2 的评述文）
 *   ② 摘要必须截（实测 53～1,410 字，差 26 倍，不截会吃光终稿预算）
 *   ③ 每条 query 先保一条（不能因为后面的高分结果把某一组整个挤掉）
 *   ④ 别的服务商地址不许搜（/v1/tools/search 只有 DeepSeek 官方有）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SEARCH_LIMITS, canSearch, cleanUrl, cleanTitle, cleanSite, cleanSnippet, splitQuery, normalizeHits, selectHits, formatSearchBlock, pickSearchItems } from '../lib/web-search.js'

const R = (score, extra = {}) => ({
  rerank_score: score,
  title: '标题',
  url: 'https://example.com/a#1',
  snippet: '短摘要',
  summary: '长摘要',
  site_name: '某站',
  ...extra,
})

// ── 地址 ───────────────────────────────────────────────────────────────────
test('canSearch：只认 DeepSeek 家（别的服务商没有 /v1/tools/search）', () => {
  assert.equal(canSearch('https://api.deepseek.com'), true)
  assert.equal(canSearch('https://api.deepseek.com/'), true, '尾斜杠不影响')
  assert.equal(canSearch('https://foo.deepseek.com'), true, '子域也算')
  assert.equal(canSearch('https://api.openai.com/v1'), false)
  assert.equal(canSearch('http://127.0.0.1:8080/v1'), false, '本地兼容服务没有搜索接口')
  assert.equal(canSearch(''), false)
  assert.equal(canSearch('不是 URL'), false)
})

test('cleanUrl：剥掉接口加的 #1，真锚点不动', () => {
  assert.equal(cleanUrl('https://a.com/b.html#1'), 'https://a.com/b.html')
  assert.equal(cleanUrl('https://a.com/b.html#12'), 'https://a.com/b.html')
  assert.equal(cleanUrl('https://a.com/b.html#section-2'), 'https://a.com/b.html#section-2')
  assert.equal(cleanUrl(''), '')
})

// 去重是逐条比正文的，所以测试里给每条一个**互不相同的**正文（不同字组，重合率为 0）
const WORDS = ['甲乙丙丁', '戊己庚辛', '壬癸子丑', '寅卯辰巳', '午未申酉', '戌亥乾坤', '日月星辰', '春夏秋冬', '东南西北', '金木水火']
const T = (i) => WORDS[((i % 10) + 10) % 10].repeat(12)

// ── 收料 ───────────────────────────────────────────────────────────────────
test('normalizeHits：低于 1.5 分的不进材料，按分数从高到低，每条 query 最多 3 条', () => {
  const hits = normalizeHits([
    R(1.2, { snippet: T(1) }), R(2.1, { snippet: T(2) }), R(1.9, { snippet: T(3) }),
    R(1.6, { snippet: T(4) }), R(1.5, { snippet: T(5) }), R(2.9, { snippet: T(6) }),
  ])
  assert.deepEqual(hits.map((h) => h.score), [2.9, 2.1, 1.9], '1.2 低于线；1.6/1.5 被条数截掉')
  // 分数线单独验一次：只给低分的，必须一条都不剩
  assert.deepEqual(normalizeHits([R(1.49), R(0.9)]), [], '<1.5 不算优质结果，不许当证据')
  // 恰好 1.5 要留（文档写的是「大于等于」）
  assert.equal(normalizeHits([R(1.5)]).length, 1)
})

test('normalizeHits：同一份文件被不同站点转发的，只留一条（去重在截 3 条之前）', () => {
  const 原文 = '一、清理整顿开发区要纠正越权审批、违规圈占土地、低价出让土地等行为，促进各类开发区健康发展。'
  const hits = normalizeHits([
    R(2.4, { snippet: '国务院办公厅关于清理整顿各类开发区加强建设用地管理的通知 ... ' + 原文 }),
    R(2.3, { snippet: 原文 }),                                              // 同一段，换个开头
    R(2.2, { snippet: 原文.replace(/，/g, ',') }),                            // 同一段，全半角不同
    R(2.1, { snippet: T(9) }),                                             // 真的另一条
  ])
  assert.deepEqual(hits.map((h) => h.score), [2.4, 2.1], '三条重复只留最高分那条，另一条独立内容要保住')
  assert.equal(hits.length, 2)
})

test('normalizeHits：正文取 snippet（接口已按 query 挑好），不取 summary', () => {
  const snippet = '第四条 商业、旅游、娱乐和商品住宅等各类经营性用地，必须以招标、拍卖或者挂牌方式出让。'
  const summary = '名称招标拍卖挂牌出让国有土地使用权规定 ... 中华人民共和国国土资源部令第11号 ... 2002年05月09日 部门规章 废止 ...'
  const [h] = normalizeHits([R(2, { snippet, summary })])
  assert.equal(h.text, snippet, 'summary 从公文头开始，snippet 才是那句话')
  assert.doesNotMatch(h.text, /废止/)
})

test('normalizeHits：snippet 太短就退回 summary 开头，再截到 300 字', () => {
  const long = '甲'.repeat(900)
  const [h] = normalizeHits([R(2, { snippet: '短', summary: long })])
  assert.equal(h.text.length, SEARCH_LIMITS.summaryChars + 1, '300 字 + 一个省略号')
  assert.ok(h.text.endsWith('…'))
})

test('cleanTitle：剥掉尾巴上拼的站点 URL；过长截断', () => {
  assert.equal(
    cleanTitle('国务院办公厅关于清理整顿各类开发区加强建设用地管理的通知_国务院文件_中国政府网 - https://www'),
    '国务院办公厅关于清理整顿各类开发区加强建设用地管理的通知_国务院文件_中国政府网',
  )
  assert.equal(cleanTitle('a'.repeat(80)).length, 61, '60 字 + 省略号')
  assert.equal(cleanTitle(''), '')
})

test('cleanTitle：接口把标题自己重复拼了一遍就丢掉尾巴那段，但不砍真出处', () => {
  // 实测原样：前面已经说完了，后面又从头念一遍、再被截断
  assert.equal(
    cleanTitle('依法厘清政府债务范围 坚决堵住违法举债渠道——财政部有关负责人就地方政府债务问题答记者问 - 依法厘清政府债务范围 坚决…'),
    '依法厘清政府债务范围 坚决堵住违法举债渠道——财政部有关负责人就地方政府债务问题答记者问',
  )
  // 尾巴是真的另一个信息（发文机关），不许当重复砍掉
  assert.equal(
    cleanTitle('国务院办公厅关于清理整顿各类开发区的通知 - 国务院办公厅'),
    '国务院办公厅关于清理整顿各类开发区的通知 - 国务院办公厅',
  )
})

test('cleanSite：中文站点名照用；裸域名去掉 static/www 这类子域', () => {
  assert.equal(cleanSite('人民网财经'), '人民网财经')
  assert.equal(cleanSite('static.sse.com.cn'), 'sse.com.cn')
  assert.equal(cleanSite('www.mnr.gov.cn'), 'mnr.gov.cn')
  assert.equal(cleanSite(''), '')
})

test('cleanSnippet：按「...」切段、一段一行，内容一段都不丢', () => {
  // 实测原样：四段缝在一起。第一版"只留最完整那段"把三段丢了（193 字洗完剩 34 字），用户否掉
  const out = cleanSnippet('这涉及到生息资本的职能和特点，并进一步延伸到虚拟资本 ... 国债券作为所有权证书是纯粹幻想的虚拟资本'
    + ' ... 人们把虚拟资本的形成叫做收入的资本化 ... [21]526- 529总之，生息资本不过是总剩余价值或总利润的一部分，是资本所有权的果实。')
  const lines = out.split('\n')
  assert.equal(lines.length, 4, '四段都在，各自一行')
  assert.equal(lines[3], '总之，生息资本不过是总剩余价值或总利润的一部分，是资本所有权的果实。', '脚注残留 [21]526- 529 要剥掉')
  assert.match(lines[0], /生息资本的职能和特点/)
  assert.doesNotMatch(out, /\.\.\./, '「...」这种缝合痕迹不许留下')
})

test('cleanSnippet：只丢真正的垃圾段（免责/著录声明），正文全留', () => {
  const t = cleanSnippet('2024 年全国土地成交额为3.68 万亿元，同比下降18%，溢价率为6.21%。'
    + ' ... 城投公司口径统计有偏差；房地产市场及土地市场复苏情况仍待观察。')
  assert.match(t, /3\.68 万亿元/, '正文留着')
  assert.doesNotMatch(t, /口径统计有偏差/, '免责声明整段丢掉')
})

test('cleanSnippet：HTML 表格标签去掉，但书名里层的尖括号留住', () => {
  // 实测原样：整条正文是一张表的标签
  const table = cleanSnippet('</td><td></td></tr><tr><td rowspan="2">《国务院关于加强地方政府债务管理的意见》（国发【2014】43号）</td>'
    + '<td>国务院</td><td>2014年9月</td><td>剥离融资平台公司政府融资职能，融资平台公司不得新增政府债务。')
  assert.doesNotMatch(table, /<\/?t[dr]|rowspan/, '标签不许留在给人看的正文里')
  assert.match(table, /《国务院关于加强地方政府债务管理的意见》/)

  // 用 `<[^>]*>` 通吃会把它洗成"《关于修改 的决定》"——正好丢掉"改的是哪部法"
  const law = cleanSnippet('根据2021年12月24日第13届全国人大常委会第32次会议《关于修改<中华人民共和国工会法>的决定》第3次修正。')
  assert.match(law, /关于修改<中华人民共和国工会法>的决定/)
})

test('cleanSnippet：洗不出东西、或洗得太短就退回原文（宁可难读，不能洗没）', () => {
  assert.equal(cleanSnippet(''), '')
  assert.equal(cleanSnippet('   '), '')
  assert.equal(cleanSnippet('</td></tr>'), '</td></tr>', '全是标签、洗完是空 → 退回原文')
  const short = '第一条 为了规范招标投标活动，保护国家利益。'
  assert.equal(cleanSnippet(short), short, '本来就干净的一句话原样返回')
})

test('cleanSnippet：被截断的段尾留一个省略号（读者要看得见"这儿没说完"）', () => {
  const cut = cleanSnippet('这里，作为虚拟资本到场的股票，是在自己手中没有大量资本的情况下'
    + ' ... 哈维解释说，“股票实际上是一种附属于纯粹的货币所有权的财产权。它实际上是对未来剩余价值生产的一个份额”。')
  const lines = cut.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].endsWith('…'), `第一段被切开，尾巴上要有省略号：${lines[0]}`)
  assert.doesNotMatch(cut, /\.\.\./, '「...」不许留在给人看的正文里')
})

test('cleanSnippet：段尾切在半个连接词上（"…另外"）不留悬空尾巴', () => {
  const t = cleanSnippet('该规定改变了过去以土地征收原用途来确定土地补偿，以年产值倍数法来确定土地补偿费和安置补助费的做法。另外')
  assert.doesNotMatch(t, /另外/)
  assert.ok(t.endsWith('。'), `实际：${t}`)
})

test('normalizeHits：没有 snippet 也没有 summary 就退到标题；站点名缺了就取域名', () => {
  assert.equal(normalizeHits([R(2, { summary: '', snippet: '短' })])[0].text, '短')
  assert.equal(normalizeHits([R(2, { summary: '', snippet: '', title: '只有标题' })])[0].text, '只有标题')
  const [h] = normalizeHits([R(2, { site_name: null, url: 'https://www.mnr.gov.cn/x.html#2' })])
  assert.equal(h.site, 'mnr.gov.cn', '没有站点名就用域名兜底（去掉 www. 这种看着像地址的前缀）')
  assert.equal(h.url, 'https://www.mnr.gov.cn/x.html', '印出去的 URL 不带 #2')
})

test('normalizeHits：原文进 text（喂终稿），洗过的进 shown（给人看）', () => {
  const snippet = '第一段在这儿没有写完，原因是被截断了 ... 第二段才是一句完整的话，能给人读懂，而它本来就在网页里原样如是。'
  const [h] = normalizeHits([R(2, { snippet })])
  assert.equal(h.text, snippet, 'text 一个字都不许动——那是凭据，终稿和记录靠它')
  const lines = h.shown.split('\n')
  assert.equal(lines.length, 2, '两段都留着，一段一行')
  assert.match(lines[0], /第一段在这儿没有写完/)
  assert.equal(lines[1], '第二段才是一句完整的话，能给人读懂，而它本来就在网页里原样如是。')
})

test('pickSearchItems：shown 跟着条目一路走到侧栏才知道的那份数据里', () => {
  const snippet = '甲段只写了一半就断了，因为它被截在这个地方 ... 乙段是完整的一句话，读得通，而且网页里本来就是这么写的。'
  const groups = [{ query: 'q', hits: normalizeHits([R(2, { snippet })]) }]
  const [it] = pickSearchItems(groups)
  assert.equal(it.n, 1)
  assert.match(it.text, /\.\.\./, '原文照旧带着省略号')
  assert.equal(it.shown.split('\n').length, 2)
  assert.match(it.shown, /乙段是完整的一句话，读得通/)
})

// ── 排版 ───────────────────────────────────────────────────────────────────
test('splitQuery：超过接口 128 字上限就按句读切开，一个字都不丢', () => {
  const short = '2019年土地管理法第48条怎么算补偿'
  assert.deepEqual(splitQuery(short), [short], '够短就原样一段')

  const long = '一、清理整顿开发区要纠正越权审批、违规圈占土地、低价出让土地等行为，促进各类开发区健康发展。'
    + '二、严禁低价协议出让土地，协议供地必须提前公布供地方案，协议出让的土地改变为经营性用地的要公示。'
    + '三、加强对开发区建设用地的集中统一管理，严格执行土地利用总体规划和年度计划，不得擅自扩大范围。'
  const parts = splitQuery(long)
  assert.ok(parts.length > 1, '明显超长就该切开')
  for (const p of parts) assert.ok(p.length <= SEARCH_LIMITS.queryChars, `每段都得 ≤128，actual ${p.length}`)
  assert.equal(parts.join(''), long, '切开不许丢字（含标点）')
  assert.ok(parts.every((p) => p.length > 0))

  // 断点太靠前（前面没有句读）就硬切，也得 ≤128
  const noPunct = '甲'.repeat(300)
  const hard = splitQuery(noPunct)
  assert.ok(hard.length >= 2)
  for (const p of hard) assert.ok(p.length <= SEARCH_LIMITS.queryChars)
  assert.equal(hard.join(''), noPunct)

  assert.deepEqual(splitQuery(''), [])
  assert.deepEqual(splitQuery('   '), [])
})

test('formatSearchBlock：一条都没查到就印「没搜到能用的」，不印空', () => {
  const s = formatSearchBlock([{ query: '党章里党的性质怎么写', hits: [] }])
  assert.match(s, /· 党章里党的性质怎么写/)
  assert.match(s, /没搜到能用的/)
  assert.equal(formatSearchBlock([]), '', '一处都没有时整块不出现')
  assert.equal(formatSearchBlock([{ query: '  ', hits: [] }]), '')
})

test('formatSearchBlock：每条先印标题（文件身份），再正文，再 URL；正文不套引号', () => {
  const s = formatSearchBlock([{
    query: '招拍挂哪一年',
    hits: normalizeHits([R(2.1, {
      title: '《招标拍卖挂牌出让国有建设用地使用权规定》（部39号令）详解 - https://www',
      snippet: '2002年5月9日，国土资源部发布了《招标拍卖挂牌出让国有土地使用权规定》（11号令）',
      site_name: '自然资源部',
    })]),
  }])
  assert.match(s, /· 招拍挂哪一年/)
  assert.match(s, /- \[1\] 《招标拍卖挂牌出让国有建设用地使用权规定》（部39号令）详解（自然资源部）/, '标题要和站点一起印、前面带编号，且剥掉尾巴上的 URL')
  assert.match(s, /2002年5月9日，国土资源部发布了/, '正文单独一行')
  assert.match(s, /https:\/\/example\.com\/a$/m, 'URL 单独一行、已剥 #1')
  assert.doesNotMatch(s, /- https:\/\/www/, '标题尾巴上的站点 URL 不许留着')
  assert.doesNotMatch(s, /「2002/, '正文不是原文摘录，不许套引号')
})

test('formatSearchBlock：出错的那组整条不印（查不到 ≠ 没查成）', () => {
  const groups = [
    { query: '查得到的', hits: normalizeHits([R(2.1, { summary: '某条结论' })]) },
    { query: '网络挂了的那条', hits: [], error: 'HTTP 502' },
    { query: '查了确实没有', hits: [] },
  ]
  const s = formatSearchBlock(groups)
  assert.match(s, /· 查得到的/)
  assert.doesNotMatch(s, /网络挂了的那条/, '失败不说成"没搜到"，直接不提这一处')
  assert.match(s, /· 查了确实没有\n {2}- 没搜到能用的/, '真的没匹配到才这么写')
  // 全部出错 → 整块不出现（终稿当作这一轮没联网）
  assert.equal(formatSearchBlock([{ query: '甲', hits: [], error: 'HTTP 402' }]), '')
  assert.equal(selectHits(groups).length, 2, '出错的组不参与统计')
})

test('formatSearchBlock：预算紧时每组先保一条，不会被高分结果整组挤掉', () => {
  const mk = (q, base) => ({
    query: q,
    hits: normalizeHits(Array.from({ length: 3 }, (_, i) => R(2.5 - i * 0.1, { snippet: T(base + i) }))),
  })
  const groups = [mk('甲', 0), mk('乙', 3), mk('丙', 6)]
  const full = formatSearchBlock(groups)
  // 每组最多 3 条
  assert.equal((full.match(/https:\/\/example\.com/g) || []).length, 9)
  // 预算压到只够三条
  const tiny = formatSearchBlock(groups, { maxChars: 120 })
  assert.match(tiny, /· 甲/)
  assert.match(tiny, /· 乙/, '低分组的保底不能被高分组的额外结果挤掉')
  assert.match(tiny, /· 丙/)
  assert.ok((tiny.match(/https:\/\/example\.com/g) || []).length >= 3, '每条 query 至少一条')
  // 统计口径：报出去的条数必须就是印出来的条数（先前报 12 条、实际印 8 条）
  for (const lim of [undefined, { maxChars: 120 }]) {
    const printed = (formatSearchBlock(groups, lim).match(/https:\/\/example\.com/g) || []).length
    assert.equal(selectHits(groups, lim).reduce((n, k) => n + k.length, 0), printed, '日志里的"可用 N 条"要对得上正文')
  }
})

// ── 编号（2026-10-27）─────────────────────────────────────────────────────
// 终稿不再把材料抄进正文，只在该处写 `[n]`，读者点开才看到原话（侧栏渲染成折叠块）。
// 所以编号必须**跨组连续**、且正文与材料块同源同序——差一位，读者点开就是另一件事。
test('材料编号：跨组连续，与 pickSearchItems 同源同序', () => {
  const groups = [
    { query: '甲', hits: normalizeHits([R(2.5, { snippet: T(0) }), R(2.4, { snippet: T(1) })]) },
    { query: '乙', hits: normalizeHits([R(2.3, { snippet: T(2) })]) },
  ]
  const items = pickSearchItems(groups)
  assert.deepEqual(items.map((i) => i.n), [1, 2, 3])
  assert.deepEqual(items.map((i) => i.query), ['甲', '甲', '乙'], '条目记住自己是为哪一问查的')

  const s = formatSearchBlock(groups)
  assert.match(s, /- \[1\] /)
  assert.match(s, /- \[3\] /, '第二组的第一条接着数成 3，不重新从 1 开始')
  for (const it of items) {
    assert.ok(s.includes(`[${it.n}] `), `编号 ${it.n} 要印在标题前`)
    assert.ok(s.includes(it.url), `第 ${it.n} 条的 URL 要印出来（折叠块里要能点）`)
    assert.ok(s.includes(it.text), `第 ${it.n} 条的原话要印出来`)
  }

  // 一条都没查到的组不占编号：否则正文写 [2] 时，点开的是"没搜到能用的"那一组的位置
  const mixed = [{ query: '空的', hits: [] }, { query: '有的', hits: normalizeHits([R(2.5, { snippet: T(0) })]) }]
  assert.deepEqual(pickSearchItems(mixed).map((i) => i.n), [1])
  assert.match(formatSearchBlock(mixed), /· 有的\n {2}- \[1\] /)

  assert.equal(pickSearchItems([]).length, 0)
  assert.equal(pickSearchItems([{ query: '  ', hits: [] }]).length, 0)
})
