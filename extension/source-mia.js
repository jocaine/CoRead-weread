/**
 * CoRead 网页阅读源适配器 —— 中文马克思主义文库（www.marxists.org/chinese）
 * AI-021 rev2（用户定调 2026-11）：不做任何 URL 自动归书 / 自动跳转，
 * 由读者手动建书并把页面绑定到书（绑定映射存页面 localStorage），读者自己维护。
 *
 * 页面 → 书 绑定：{ key, bookId, bookTitle, ts, dir }
 *   dir=true ：key 是目录前缀（如 /chinese/lenin/1901-1902/），该目录下所有页归这本书
 *   dir=false：key 是精确页面路径，单页绑定（覆盖目录绑定，取最长/最精确匹配）
 *
 * 建书：读者输入书名 → POST /book-create（receiver 生成 mia_ 书并落 meta.json）。
 * 书名由读者输入，不抓远程页面（旧页面 GB2312/GBK 若按 UTF-8 抓取会乱码）；
 * 章节标题取当前页 DOM 标题（浏览器已正确解码）。
 *
 * 其余职责沿用 rev1：正文足迹缓存 /content、划线共读 /annotation、
 * 划线重绘与删除、跳转落点（coread-scroll 消息 / #coread= hash）、结构探针 /debug。
 */
(function () {
  'use strict';

  const RECEIVER = 'http://127.0.0.1:7239';
  // AI-021 rev4：通用网页阅读源。SITE 表登记可绑定的站点（manifest matches 与
  // receiver 白名单需同步）。文库页/专栏/图文等正文结构各异：先试各站候选
  // 选择器，取不到足够正文再退回通用提取（去导航后取最大文本块）。
  const HOST = String(location.hostname).toLowerCase();
  const SITES = [
    { name: 'marxists', ok: (HOST === 'marxists.org' || HOST.endsWith('.marxists.org')) && /^\/chinese\//.test(location.pathname),
      selectors: [] },
    { name: 'bilibili', ok: HOST === 'www.bilibili.com' || HOST === 'bilibili.com',
      // 候选择器为常见容器，具体以 mia-probe 校准（opus 图文/专栏/视频总结容器各异）
      selectors: ['.opus-detail-content', '.opus-detail', '.article-content', '.rich-text-content', 'article', '#v_content'] },
  ];
  const SITE = SITES.find(function (s) { return s.ok });
  if (!SITE) return;

  // 诊断：注入成功时 <html> 带 data-coread-mia='1'，控制台有日志
  try {
    document.documentElement.setAttribute('data-coread-mia', '1');
    console.log('[CoRead mia] injected @ ' + location.href);
  } catch (e) {}

  const pageUrl = location.href;
  // 页面键：pathname（不带查询/hash），目录绑定与精确绑定都基于它
  const pageKey = location.pathname;
  const dirKey = pageKey.slice(0, pageKey.lastIndexOf('/') + 1);
  const isIndexPage = /index\.html?$/i.test(pageKey);
  // 绑定存 chrome.storage.local（AI-021 rev3）：内容脚本与侧栏共享、可互相监听。
  // 侧栏『未识别当前书籍』区据此显示『绑定当前页面』入口；删书消息仍保留用于即时清理。
  const BIND_KEY = 'miaBindings';

  // ── 小工具 ──────────────────────────────────────────────────────────────
  function qsa(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
    catch (e) { return [] }
  }
  function fnvHex(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, '');
  }
  function makeEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ── 标题清洗（只用于章节标题/建书预填；书名最终由读者定） ────────────────
  const BRAND_RE = /中文马克思主义文库|马克思主义文库|中文马克思文库|Marxists Internet Archive|www\.marxists\.org|marxists\.org|哔哩哔哩|bilibili\.com|_bilibili|B站/gi;
  const TRAIL_RE = /[\s·|｜\-—:：]+$/;
  const LEAD_RE = /^[\s·|｜\-—:：]+/;
  function cleanTitle(t) {
    if (!t) return '';
    let s = String(t).replace(/\u00a0/g, ' ').replace(BRAND_RE, '');
    s = s.replace(TRAIL_RE, '').replace(LEAD_RE, '').trim();
    return s;
  }
  // 章节身份：与绑定无关，纯页面确定性（目录页 = index）
  const chapterUid = fnvHex(pageKey, 0xa5a5a5a5) + fnvHex(pageKey, 0x5a5a5a5a).slice(0, 8);
  function chapterTitleNow() {
    return cleanTitle(document.title) || (isIndexPage ? '目录' : pageKey.split('/').pop() || '页面');
  }

  // ── 绑定存取（chrome.storage.local；内存缓存同步读，落盘异步） ─────────
  let bindingsCache = [];
  function loadBindings() {
    return bindingsCache;
  }
  function saveBindings(list) {
    bindingsCache = Array.isArray(list) ? list : [];
    try { chrome.storage.local.set({ miaBindings: bindingsCache }) } catch (e) {}
  }
  // 从 storage 拉全量绑定并刷新当前页绑定状态（boot 与跨上下文变更时用）
  function refreshBindingsFromStorage(cb) {
    try {
      chrome.storage.local.get('miaBindings', function (items) {
        const arr = items && items.miaBindings;
        if (Array.isArray(arr)) bindingsCache = arr;
        bindingNow = resolveBinding(bindingsCache);
        if (cb) cb();
      });
    } catch (e) { if (cb) cb(); }
  }
  // 解析当前页绑定：精确页 > 最长目录前缀
  function resolveBinding(list) {
    const exact = list.filter(function (b) { return !b.dir && b.key === pageKey });
    if (exact.length) return exact[exact.length - 1];
    const dirs = list.filter(function (b) { return b.dir && pageKey.indexOf(b.key) === 0 }).sort(function (a, b) { return b.key.length - a.key.length });
    return dirs[0] || null;
  }

  // ── 正文提取（沿用 rev1） ───────────────────────────────────────────────
  const JUNK_TAG_RE = /^(script|style|noscript|form|header|footer|nav|aside)$/i;
  const JUNK_CLS_RE = /nav|menu|toc|sidebar|banner|breadcrumb|footer|header|toolbar/i;
  const NAV_LINE_RE = /^(上一页|下一页|回目录|返回目录|目录|首页|主页|上一章|下一章|返回|卷首|封底|封面|书名页)$/;
  let contentEl = null; // 命中站点候选容器时记录（动态页懒加载正文后补渲染划线用）
  function cleanBodyLines(text) {
    const lines = String(text || '').replace(/\u00a0/g, ' ').split('\n').map(function (s) { return s.trim() }).filter(Boolean);
    const kept = [];
    for (const ln of lines) {
      if (ln.length <= 8 && NAV_LINE_RE.test(ln)) continue;
      kept.push(ln);
    }
    return kept.join('\n');
  }
  function extractMainText() {
    if (!document.body) return '';
    // 站点候选容器优先（B 站正文/视频总结与评论区分离，通用提取会抓到评论）
    if (SITE.selectors.length) {
      for (const sel of SITE.selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const t = cleanBodyLines(el.innerText || '');
            if (t.length >= 200) { contentEl = el; return t; }
          }
        } catch (e) {}
      }
    }
    const clone = document.body.cloneNode(true);
    const stack = [clone];
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      const tag = (el.tagName || '').toLowerCase();
      const cls = String(el.className || el.id || '');
      if (JUNK_TAG_RE.test(tag) || JUNK_CLS_RE.test(cls)) {
        if (el.parentNode) el.parentNode.removeChild(el);
        continue;
      }
      if (/^(p|div|td|li|blockquote|table|center|h[1-6])$/i.test(tag) && el.children.length) {
        const own = (el.textContent || '').trim();
        if (own.length < 200) {
          const linkText = qsa('a', el).reduce(function (sum, a) { return sum + (a.textContent || '').length }, 0);
          if (linkText > own.length * 0.5) {
            if (el.parentNode) el.parentNode.removeChild(el);
            continue;
          }
        }
      }
      for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
    }
    return cleanBodyLines(clone.innerText);
  }

  // ── 文本定位 / 划线渲染（沿用 rev1） ────────────────────────────────────
  function buildTextIndex() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const entries = [];
    let compact = '';
    let n;
    while ((n = walker.nextNode())) {
      const parent = n.parentElement;
      if (!parent) continue;
      if (/^(script|style|noscript)$/i.test(parent.tagName)) continue;
      const txt = n.nodeValue || '';
      for (let i = 0; i < txt.length; i++) {
        if (/\s/.test(txt.charAt(i))) continue;
        entries.push({ node: n, off: i });
        compact += txt.charAt(i);
      }
    }
    return { compact: compact, entries: entries };
  }
  function findNeedle(needle) {
    const nc = normalizeText(needle);
    if (!nc) return null;
    const idx = buildTextIndex();
    const at = idx.compact.indexOf(nc);
    if (at < 0) return null;
    const start = idx.entries[at];
    const end = idx.entries[at + nc.length - 1];
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.off);
    range.setEnd(end.node, end.off + 1);
    return range;
  }
  function wrapRangeInMark(range, dataText) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'coread-mia-mark';
      mark.setAttribute('data-text', dataText.slice(0, 400));
      const sc = range.startContainer;
      if (sc === range.endContainer && sc.nodeType === 3) {
        // 快路径：单个文本节点内
        const text = sc.nodeValue || '';
        const start = range.startOffset;
        const end = range.endOffset;
        if (start < 0 || end > text.length) return false;
        const after = sc.splitText(end);
        const mid = sc.splitText(start);
        sc.parentNode.replaceChild(mark, mid);
        mark.appendChild(mid);
        void after;
        return true;
      }
      // 跨节点（行内元素/换行把一段文字切成多个文本节点，此前这里直接放弃不画）：
      // 把范围内容整体抽出来包进 <mark> 再插回，整段都有颜色
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
      return true;
    } catch (e) {
      console.error('[CoRead web] wrapRange failed', e);
      return false;
    }
  }

  // ── receiver 通讯 ───────────────────────────────────────────────────────
  async function postJson(pathname, body) {
    try {
      const resp = await fetch(RECEIVER + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return resp.ok ? resp.json() : null;
    } catch (e) { return null; }
  }
  async function getJson(pathname) {
    try {
      const resp = await fetch(RECEIVER + pathname);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  }

  // ── UI 样式 / toast / 悬浮胶囊 ─────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = 'mark.coread-mia-mark{background:#ffe08a !important;color:inherit !important;cursor:pointer;border-radius:2px;box-shadow:none}mark.coread-mia-mark:hover{background:#ffd54d !important}' +
    '.coread-mia-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;background:#222;color:#fff;padding:8px 14px;border-radius:6px;font-size:13px;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
    '.coread-mia-ui{position:fixed;z-index:2147483646;font-family:sans-serif}' +
    '.coread-mia-ui button{border:none;color:#fff;padding:6px 12px;border-radius:6px;font-size:13px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)}' +
    '.coread-mia-float{display:flex;gap:6px}' +
    '.coread-mia-float .cm-btn{display:block;background:#b8860b;border:none;padding:6px 11px}.coread-mia-float .cm-btn:hover{background:#a07500}' +
    '.coread-mia-pill{position:fixed;right:14px;bottom:14px;background:#b8860b;color:#fff;border:none;border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);font-family:sans-serif;z-index:2147483645;max-width:46vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.coread-mia-pill:hover{background:#a07500}' +
    '.coread-mia-dlg{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-family:sans-serif}' +
    '.coread-mia-dlg .box{background:#fff;color:#222;border-radius:10px;padding:12px 14px;width:min(92vw,440px);max-height:min(86vh,640px);overflow-y:auto;box-shadow:0 6px 24px rgba(0,0,0,.4);font-size:13.5px}' +
    '.coread-mia-dlg h3{margin:0 0 10px;font-size:15px}' +
    '.coread-mia-dlg label{display:block;margin:8px 0 3px;font-size:12.5px;color:#555}' +
    '.coread-mia-dlg input[type=text],.coread-mia-dlg select{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px}' +
    '.coread-mia-dlg .row{display:flex;gap:12px;margin:6px 0}' +
    '.coread-mia-dlg .row label{display:flex;align-items:center;gap:4px;margin:0;color:#222;font-size:13px}' +
    '.coread-mia-dlg .btns{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}' +
    '.coread-mia-dlg button{padding:6px 14px;border:none;border-radius:6px;font-size:13px;cursor:pointer}' +
    '.coread-mia-dlg .ok{background:#b8860b;color:#fff}.coread-mia-dlg .ok:hover{background:#a07500}' +
    '.coread-mia-dlg .cancel{background:#eee;color:#333}.coread-mia-dlg .danger{background:#c0392b;color:#fff}' +
    '.coread-mia-hint{font-size:12px;color:#888;margin-top:6px;line-height:1.5}' +
    '.cm-head{margin-bottom:2px}' +
    '.cm-title{font-size:15px;font-weight:700;color:#333}' +
    '.cm-addr{margin-top:3px;font-size:11px;color:#999;word-break:break-all;line-height:1.4}' +
    '.cm-sec-label{font-size:11.5px;font-weight:700;color:#8a6d00;margin:10px 0 4px}' +
    '.cm-cards{display:grid;grid-template-columns:1fr 1fr;gap:6px}' +
    '.cm-card{display:flex;flex-direction:column;gap:5px;border:1px solid #e0e0e0;border-radius:8px;padding:8px 10px;cursor:pointer;transition:border-color .12s,background .12s}' +
    '.cm-card:hover{border-color:#c9b37a}' +
    '.cm-card input{accent-color:#b8860b}' +
    '.cm-card.on{border-color:#b8860b;background:#fffaf0}' +
    '.cm-card-dis{opacity:.55;pointer-events:none}' +
    '.cm-card-body{display:flex;flex-direction:column;gap:2px;min-width:0}' +
    '.cm-card-title{font-size:13px;font-weight:600;color:#333}' +
    '.cm-card-desc{font-size:11.5px;color:#888;line-height:1.45}' +
    '.cm-field{margin-top:6px}' +
    '.cm-chip{margin-top:8px;font-size:11px;color:#666;background:#f6f6f6;border-radius:6px;padding:4px 8px;word-break:break-all;line-height:1.4}' +
    '.cm-tip{margin-top:6px;font-size:11.5px;color:#7a5c00;background:#fffaf0;border:1px dashed #ecd9a0;border-radius:6px;padding:5px 9px;line-height:1.5}';
  document.head.appendChild(style);

  // 单实例 toast：新提示先移除旧元素（旧实现共用一个移除定时器，
  // 连续提示会取消上一个的移除计划，导致旧 toast 永久残留不消失）
  let toastEl = null;
  let toastTimer = 0;
  function toast(msg) {
    clearTimeout(toastTimer);
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    const t = makeEl('div', 'coread-mia-toast', msg);
    toastEl = t;
    document.body.appendChild(t);
    toastTimer = setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
      if (toastEl === t) toastEl = null;
    }, 2600);
  }

  // ── 绑定对话框 ──────────────────────────────────────────────────────────
  let dialogEl = null;
  let bindingNow = null; // 当前页绑定（可能来自目录前缀）；boot 后由 storage 载入

  async function createBook(title) {
    const j = await postJson('/book-create', { bookTitle: title, source: 'mia' });
    return j && j.bookId ? { bookId: j.bookId, bookTitle: j.bookTitle } : null;
  }
  async function existingMiaBooks() {
    const j = await getJson('/books');
    if (!j || !Array.isArray(j.books)) return [];
    return j.books.filter(function (b) {
      return /^mia_[0-9a-f]{20}$/.test(b.base) || /^mia_/.test(b.base);
    }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) });
  }
  function setBindingEntry(entry) {
    bindingsCache = bindingsCache.filter(function (b) { return b.key !== entry.key });
    // 同一本书若曾以更宽范围绑定过（比如先绑了整目录又只想绑单页），不删旧目录绑定：
    // 单页精确绑定在解析时优先于目录绑定，旧目录绑定仍服务其他页。
    bindingsCache.push(entry);
    saveBindings(bindingsCache);
  }
  function removeBindingFor(key) {
    bindingsCache = bindingsCache.filter(function (b) { return b.key !== key });
    saveBindings(bindingsCache);
  }
  function bindingScopeOf(entry) {
    return entry && entry.dir ? dirKey + (isIndexPage ? '（本页是目录页）' : '（含本目录全部章节页）') : '仅本页';
  }

  async function openBindDialog() {
    if (dialogEl) closeDialog();
    const box = makeEl('div', 'box');

    // ── 头部：动作 + 当前页面地址 ──────────────────────────────────────────
    const head = makeEl('div', 'cm-head');
    head.appendChild(makeEl('div', 'cm-title', '加入一本书'));
    const addr = makeEl('div', 'cm-addr', pageKey);
    addr.title = '当前页面：' + pageUrl;
    head.appendChild(addr);
    box.appendChild(head);

    // ── ① 这本书 ──────────────────────────────────────────────────────────
    let miaBooks = [];
    try { miaBooks = await existingMiaBooks() } catch (e) {}
    box.appendChild(makeEl('div', 'cm-sec-label', '① 这本书'));
    const rowBook = makeEl('div', 'cm-cards');

    const cardA = makeEl('label', 'cm-card');
    const radioA = makeEl('input'); radioA.type = 'radio'; radioA.name = 'cm-book-src'; radioA.value = 'exist';
    const bodyA = makeEl('span', 'cm-card-body');
    bodyA.appendChild(makeEl('span', 'cm-card-title', '加入已有的书'));
    bodyA.appendChild(makeEl('span', 'cm-card-desc', miaBooks.length ? '继续划线、讨论' : '暂无书籍，可新建一本'));
    cardA.appendChild(radioA); cardA.appendChild(bodyA);
    rowBook.appendChild(cardA);

    const cardB = makeEl('label', 'cm-card');
    const radioB = makeEl('input'); radioB.type = 'radio'; radioB.name = 'cm-book-src'; radioB.value = 'new';
    const bodyB = makeEl('span', 'cm-card-body');
    bodyB.appendChild(makeEl('span', 'cm-card-title', '创建一本新书'));
    bodyB.appendChild(makeEl('span', 'cm-card-desc', '首次阅读这本书，为它创建一本新书'));
    cardB.appendChild(radioB); cardB.appendChild(bodyB);
    rowBook.appendChild(cardB);
    box.appendChild(rowBook);

    // 加入已有书 → 下拉
    const wrapSel = makeEl('div', 'cm-field');
    const sel = makeEl('select');
    const optPh = makeEl('option', null, '选择一本书…');
    optPh.value = '';
    sel.appendChild(optPh);
    for (const b of miaBooks) {
      const o = makeEl('option', null, '《' + (b.bookTitle || b.base) + '》');
      o.value = b.base;
      sel.appendChild(o);
    }
    wrapSel.appendChild(sel);
    box.appendChild(wrapSel);

    // 创建新书 → 书名
    const wrapInp = makeEl('div', 'cm-field');
    const inp = makeEl('input');
    inp.type = 'text';
    inp.placeholder = '书名（例如：怎么办？）';
    wrapInp.appendChild(inp);
    box.appendChild(wrapInp);

    // ── ② 绑定范围 ─────────────────────────────────────────────────────────
    box.appendChild(makeEl('div', 'cm-sec-label', '② 绑定范围'));
    const rowScope = makeEl('div', 'cm-cards');

    const cardDir = makeEl('label', 'cm-card');
    const radioDir = makeEl('input'); radioDir.type = 'radio'; radioDir.name = 'cm-scope'; radioDir.value = 'dir';
    const bodyDir = makeEl('span', 'cm-card-body');
    bodyDir.appendChild(makeEl('span', 'cm-card-title', '整个目录'));
    bodyDir.appendChild(makeEl('span', 'cm-card-desc', '本目录下所有页面均属于这本书，翻章时无需重复绑定'));
    cardDir.appendChild(radioDir); cardDir.appendChild(bodyDir);
    rowScope.appendChild(cardDir);

    const cardPage = makeEl('label', 'cm-card');
    const radioPage = makeEl('input'); radioPage.type = 'radio'; radioPage.name = 'cm-scope'; radioPage.value = 'page';
    const bodyPage = makeEl('span', 'cm-card-body');
    bodyPage.appendChild(makeEl('span', 'cm-card-title', '仅本页'));
    bodyPage.appendChild(makeEl('span', 'cm-card-desc', '仅当前页面属于这本书'));
    cardPage.appendChild(radioPage); cardPage.appendChild(bodyPage);
    rowScope.appendChild(cardPage);
    box.appendChild(rowScope);

    // 覆盖路径预览 + 建议（随范围选择更新）
    const chip = makeEl('div', 'cm-chip');
    box.appendChild(chip);
    const tip = makeEl('div', 'cm-tip');
    box.appendChild(tip);
    function renderScope() {
      const dir = radioDir.checked;
      cardDir.className = dir ? 'cm-card on' : 'cm-card';
      cardPage.className = dir ? 'cm-card' : 'cm-card on';
      chip.textContent = dir
        ? ('覆盖范围：' + dirKey + '（含子页面）')
        : ('仅覆盖：…/' + pageKey.split('/').slice(-2).join('/'));
      if (dir && !isIndexPage) {
        tip.textContent = '同一来源的多个页面（如一部著作的分章）可一次加入：选「整个目录」即覆盖该路径下所有页面。';
      } else if (dir && isIndexPage) {
        tip.textContent = '目录页：选「整个目录」将一次加入本目录下的全部章节页。';
      } else {
        tip.textContent = '仅绑定本页；相关页面之后可再绑定，或改用「整个目录」。';
      }
    }
    radioDir.addEventListener('change', renderScope);
    radioPage.addEventListener('change', renderScope);

    // ── 书源字段显隐 ──────────────────────────────────────────────────────
    function syncBookSrc() {
      const useNew = radioB.checked;
      wrapInp.hidden = !useNew;
      wrapSel.hidden = useNew;
      cardA.className = 'cm-card' + (radioA.checked ? ' on' : '') + (miaBooks.length ? '' : ' cm-card-dis');
      cardB.className = 'cm-card' + (radioB.checked ? ' on' : '');
      if (useNew) inp.focus();
    }
    radioA.addEventListener('change', syncBookSrc);
    radioB.addEventListener('change', syncBookSrc);

    // ── 初始状态 ───────────────────────────────────────────────────────────
    const boundInList = bindingNow && miaBooks.some(function (b) { return b.base === bindingNow.bookId });
    // 这本书：有当前绑定且书还在 → 已有；书没了 → 新书并预填原名；无绑定 → 有书可选已有，没书只能新建
    if (bindingNow && !boundInList) {
      radioB.checked = true;
      inp.value = bindingNow.bookTitle || '';
    } else if (bindingNow && boundInList) {
      radioA.checked = true;
      sel.value = bindingNow.bookId;
      inp.value = bindingNow.bookTitle || '';
    } else if (miaBooks.length) {
      radioA.checked = true;
      inp.value = cleanTitle(document.title).slice(0, 60);
    } else {
      radioB.checked = true;
      inp.value = cleanTitle(document.title).slice(0, 60);
    }
    if (!inp.value) inp.value = cleanTitle(document.title).slice(0, 60);
    // 范围：沿用现有绑定；否则目录页默认整个目录，章节/单篇页默认仅本页（防误绑上级目录）
    if (bindingNow) {
      (bindingNow.dir ? radioDir : radioPage).checked = true;
    } else {
      (isIndexPage ? radioDir : radioPage).checked = true;
    }
    syncBookSrc();
    renderScope();
    if (bindingNow) sel.value = boundInList ? bindingNow.bookId : '';

    // ── 操作 ──────────────────────────────────────────────────────────────
    const btns = makeEl('div', 'btns');
    if (bindingNow) {
      const unbind = makeEl('button', 'danger', '解除绑定');
      unbind.style.marginRight = 'auto';
      unbind.addEventListener('click', function () {
        removeBindingFor(bindingNow.dir ? dirKey : pageKey);
        bindingNow = null;
        closeDialog();
        refreshPill();
        toast('已解除绑定');
      });
      btns.appendChild(unbind);
    }
    const cancel = makeEl('button', 'cancel', '取消');
    cancel.addEventListener('click', closeDialog);
    const ok = makeEl('button', 'ok', bindingNow ? '保存修改' : '绑定这本书');
    ok.addEventListener('click', async function () {
      const scopeDir = radioDir.checked;
      let bookId = '';
      let bookTitle = '';
      if (radioA.checked) {
        bookId = sel.value || '';
        if (!bookId) { toast('请先选择一本书，或切换为「创建一本新书」'); return; }
        const hit = miaBooks.find(function (b) { return b.base === bookId });
        bookTitle = hit ? hit.bookTitle || '' : '';
      } else {
        const title = inp.value.trim();
        if (!title) { toast('请填写书名'); return; }
        const created = await createBook(title.slice(0, 200));
        if (!created) { toast('创建书籍失败：CoRead 本机服务未启动'); return; }
        bookId = created.bookId;
        bookTitle = created.bookTitle;
      }
      const key = scopeDir ? dirKey : pageKey;
      setBindingEntry({ key: key, bookId: bookId, bookTitle: bookTitle, dir: scopeDir, ts: Date.now() });
      bindingNow = resolveBinding(bindingsCache);
      closeDialog();
      refreshPill();
      try {
        chrome.runtime.sendMessage({ action: 'coreadManualBook', bookId: bookId, bookTitle: bookTitle });
      } catch (e) {}
      toast(scopeDir ? ('整个目录已归入《' + (bookTitle || bookId) + '》') : ('本页已归入《' + (bookTitle || bookId) + '》'));
      afterBind();
    });
    btns.appendChild(cancel);
    btns.appendChild(ok);
    box.appendChild(btns);

    dialogEl = makeEl('div', 'coread-mia-dlg');
    dialogEl.appendChild(box);
    dialogEl.addEventListener('mousedown', function (e) { if (e.target === dialogEl) closeDialog() });
    document.body.appendChild(dialogEl);
  }
  function closeDialog() {
    if (dialogEl) {
      if (dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
      dialogEl = null;
    }
  }

  // ── 悬浮胶囊：绑定入口 / 显示当前绑定 ────────────────────────────────────
  // 显隐策略（AI-021 rev3）：胶囊只在已绑定页面右下角常驻（显示书名，点击改绑/解除）；
  // 未绑定页面不显示任何浮层——绑定入口在侧栏『未识别当前书籍』区（sidebar.js）。
  let pill = null;
  function refreshPill() {
    bindingNow = resolveBinding(bindingsCache);
    if (!pill) {
      pill = makeEl('button', 'coread-mia-pill');
      pill.type = 'button';
      pill.addEventListener('click', openBindDialog);
      const host = document.body || document.documentElement;
      if (!host) { pill = null; return; }
      try { host.appendChild(pill) } catch (e) {
        pill = null;
        console.error('[CoRead mia] pill append failed:', e);
        return;
      }
    }
    pill.textContent = bindingNow ? '📚 ' + (bindingNow.bookTitle || bindingNow.bookId) : '📚 绑定到书';
    pill.title = bindingNow ? ('本页属于《' + (bindingNow.bookTitle || bindingNow.bookId) + '》（' + bindingScopeOf(bindingNow) + '），点击调整') : '将本页加入一本书（划线共读前需先加入）';
    pill.style.display = bindingNow ? '' : 'none';
  }

  // ── 划线共读 ────────────────────────────────────────────────────────────
  let floatBtn = null;
  function hideFloat() {
    if (floatBtn && floatBtn.parentNode) floatBtn.parentNode.removeChild(floatBtn);
    floatBtn = null;
  }
  function floatAction(e, fn) {
    e.preventDefault();
    e.stopPropagation();
    hideFloat();
    fn();
  }
  function showFloat(rect, mode) {
    hideFloat();
    floatBtn = makeEl('div', 'coread-mia-ui coread-mia-float');
    if (mode === 'bind') {
      // 未绑定：只给加入书的入口
      const btn = makeEl('button', 'cm-btn', '📚 加入一本书');
      btn.title = '本页尚未加入任何书：先选择一本书，之后划线即可共读';
      btn.addEventListener('click', function (e) { floatAction(e, openBindDialog) });
      floatBtn.appendChild(btn);
    } else {
      // 已绑定：共读 + 在已有引用里搜索这段文字
      const btnRead = makeEl('button', 'cm-btn', '📌 共读');
      btnRead.title = '设为当前引用，在侧栏与 AI 共读这一段';
      btnRead.addEventListener('click', function (e) { floatAction(e, onShareClick) });
      floatBtn.appendChild(btnRead);
      const btnSearch = makeEl('button', 'cm-btn', '🔍 查引用');
      btnSearch.title = '在本书已有引用与划线中搜索这段文字（侧栏引用列表）';
      btnSearch.addEventListener('click', function (e) { floatAction(e, onSearchRefClick) });
      floatBtn.appendChild(btnSearch);
    }
    document.body.appendChild(floatBtn);
    const pad = 6;
    const w = floatBtn.offsetWidth || 170;
    const h = floatBtn.offsetHeight || 30;
    let left = rect.left;
    let top = rect.bottom + pad;
    if (top + h + pad > window.innerHeight) top = Math.max(pad, rect.top - h - pad);
    if (left + w + pad > window.innerWidth) left = window.innerWidth - w - pad;
    if (left < pad) left = pad;
    floatBtn.style.left = left + 'px';
    floatBtn.style.top = top + 'px';
  }
  let lastSelText = '';
  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideFloat(); return; }
    const text = String(sel.toString() || '').trim();
    if (!text || text.length < 2 || text.length > 5000) { hideFloat(); return; }
    const anc = sel.getRangeAt(0).commonAncestorContainer;
    const host = anc.nodeType === 1 ? anc : anc.parentElement;
    if (host && host.closest && host.closest('.coread-mia-ui,.coread-mia-dlg')) { hideFloat(); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hideFloat(); return; }
    lastSelText = text;
    showFloat(rect, bindingNow ? 'read' : 'bind');
  }
  function onSearchRefClick() {
    const text = lastSelText || '';
    if (!text) return;
    try { chrome.storage.local.set({ pendingRefSearch: { query: text, ts: Date.now() } }) } catch (e) {}
    try { chrome.runtime.sendMessage({ action: 'coreadOpenRefSearch', query: text }) } catch (e) {}
    try { window.getSelection().removeAllRanges() } catch (e) {}
    toast('已在侧栏引用列表中搜索这段文字');
  }
  async function onShareClick() {
    const text = lastSelText || '';
    if (!text) return;
    const bind = resolveBinding(bindingsCache);
    if (!bind) { openBindDialog(); return; }
    const list = await getJson('/annotations?bookId=' + encodeURIComponent(bind.bookId));
    if (Array.isArray(list)) {
      const norm = normalizeText(text);
      for (const it of list) {
        if (it.chapterUid === chapterUid && normalizeText(it.selectedText) === norm) {
          toast('该段已在引用列表中');
          try { window.getSelection().removeAllRanges() } catch (e) {}
          return;
        }
      }
    }
    const j = await postJson('/annotation', {
      bookId: bind.bookId,
      bookTitle: bind.bookTitle || '',
      chapter: chapterTitleNow(),
      chapterUid: chapterUid,
      selectedText: text,
      setRef: true,
      sourceUrl: pageUrl,
      source: 'mia',
    });
    try { window.getSelection().removeAllRanges() } catch (e) {}
    if (j) {
      toast('已设为当前引用，可在侧栏提问');
      renderMarks();
    } else {
      toast('CoRead 本机服务未启动（127.0.0.1:7239）');
    }
  }

  // ── 划线重绘与删除 ───────────────────────────────────────────────────────
  async function renderMarks() {
    if (!document.body) return;
    const bind = resolveBinding(bindingsCache);
    for (const m of qsa('mark.coread-mia-mark')) {
      if (m.parentNode) m.parentNode.replaceChild(document.createTextNode(m.textContent || ''), m);
    }
    if (!bind) return;
    const list = await getJson('/annotations?bookId=' + encodeURIComponent(bind.bookId));
    if (!Array.isArray(list)) return;
    for (const it of list) {
      if (!it.selectedText || it.chapterUid !== chapterUid) continue;
      const range = findNeedle(it.selectedText);
      if (range) wrapRangeInMark(range, normalizeText(it.selectedText));
    }
  }
  document.addEventListener('click', function (e) {
    const mark = e.target && e.target.closest ? e.target.closest('mark.coread-mia-mark') : null;
    if (!mark) return;
    const text = mark.textContent || '';
    if (!text.trim()) return;
    if (!window.confirm('删除这条划线引用？\n\n' + text.slice(0, 80))) return;
    const bind = resolveBinding(bindingsCache);
    if (!bind) return;
    postJson('/annotation-delete', { bookId: bind.bookId, selectedText: text, chapterUid: chapterUid }).then(function (j) {
      if (j) { renderMarks(); toast('已删除引用'); }
    });
  });

  // ── 正文足迹缓存（绑定后每次访问都打点，进度门控的『读过』依据） ──────────
  let cachedThisSession = false;
  async function cacheChapter() {
    if (cachedThisSession) return;
    const bind = resolveBinding(bindingsCache);
    if (!bind) return;
    const main = MAIN;
    if (main.length < 200) return;
    cachedThisSession = true;
    try { sessionStorage.setItem('coread-cached-' + chapterUid, '1') } catch (e) {}
    await postJson('/content', {
      bookId: bind.bookId,
      chapterUid: chapterUid,
      chapter: chapterTitleNow(),
      bookTitle: bind.bookTitle || '',
      text: main,
      sourceUrl: pageUrl,
    });
  }

  // ── 跳转落点：消息 / #coread= hash ───────────────────────────────────────
  function scrollToText(text) {
    if (!text) return false;
    const range = findNeedle(text);
    if (!range) return false;
    range.startContainer.parentElement.scrollIntoView({ block: 'center' });
    try {
      if (CSS.highlights) {
        const hl = new Highlight(range);
        CSS.highlights.set('coread-mia-flash', hl);
        setTimeout(function () { CSS.highlights.delete('coread-mia-flash') }, 2500);
      }
    } catch (e) {}
    return true;
  }
  function parseHashJump() {
    const m = location.hash.match(/^#coread=(.+)$/);
    if (!m) return;
    try {
      const text = decodeURIComponent(m[1]);
      setTimeout(function () { if (!scrollToText(text)) toast('本页未找到该引用原文'); }, 350);
    } catch (e) {}
  }
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.action === 'coread-scroll') {
      sendResponse({ ok: scrollToText(msg.text || '') });
    } else if (msg && msg.action === 'coread-render') {
      renderMarks().then(function () { sendResponse({ ok: true }) });
      return true;
    } else if (msg && msg.action === 'coreadBookDeleted') {
      // 侧栏删除书后：清理该书全部页面绑定，防止下次访问把书重建出来
      const base = String((msg && msg.base) || '');
      if (base) {
        bindingsCache = bindingsCache.filter(function (b) { return b.bookId !== base });
        saveBindings(bindingsCache);
        bindingNow = resolveBinding(bindingsCache);
        refreshPill();
      }
    } else if (msg && msg.action === 'coreadBindingQuery') {
      // 侧栏询问：当前页是否已绑定（决定是否显示绑定入口）
      const b = resolveBinding(bindingsCache);
      sendResponse({ ok: true, pageUrl: pageUrl, bound: !!b, bookId: b ? b.bookId : '', bookTitle: b ? b.bookTitle || '' : '', key: b ? b.key : '', dir: b ? !!b.dir : false });
    } else if (msg && msg.action === 'coreadOpenBindDialog') {
      // 侧栏『绑定当前页面』按钮：在页面打开绑定对话框
      openBindDialog();
      sendResponse({ ok: true });
    }
    return undefined;
  });

  // ── 结构探针（真实页面校准用） ───────────────────────────────────────────
  function probePost() {
    try {
      const key = 'coread-probe-' + pageKey;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      const heads = [];
      for (const h of qsa('h1,h2,h3')) {
        const t = (h.textContent || '').trim();
        if (t && t.length < 120) heads.push(t);
        if (heads.length >= 6) break;
      }
      const navTexts = [];
      for (const a of qsa('a')) {
        const t = (a.textContent || '').trim();
        if (t && t.length <= 10 && /目录|上一页|下一页|返回/.test(t)) navTexts.push(t + '=>' + (a.getAttribute('href') || ''));
        if (navTexts.length >= 8) break;
      }
      postJson('/debug', {
        source: 'web-probe',
        site: SITE.name,
        stage: 'load',
        url: pageUrl.slice(0, 200),
        pageKey: pageKey,
        bound: bindingNow ? { key: bindingNow.key, bookId: bindingNow.bookId, bookTitle: bindingNow.bookTitle, dir: !!bindingNow.dir } : null,
        chapterUid: chapterUid,
        rawTitle: String(document.title).slice(0, 120),
        charset: document.characterSet,
        mainLen: MAIN.length,
        mainHead: MAIN.slice(0, 140),
        heads: heads,
        navLinks: navTexts,
        bindingsCount: bindingsCache.length,
      });
    } catch (e) {}
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────
  let MAIN = '';
  function afterBind() {
    cacheChapter();
    renderMarks();
  }
  function boot() {
    try {
      console.log('[CoRead mia] boot @ ' + location.href);
      bootInner();
    } catch (e) {
      console.error('[CoRead mia] boot error:', e);
    }
  }
  function bootInner() {
    MAIN = extractMainText();
    refreshPill();
    cacheChapter();
    renderMarks();
    // 懒加载兜底：命中候选容器的动态页（B 站等）正文可能晚于脚本到达，
    // 容器变化静默 1.2s 后若有绑定则重绘划线（只观察正文容器，不碰评论区等高频区）
    if (contentEl) {
      let oTimer = 0;
      try {
        const obs = new MutationObserver(function () {
          clearTimeout(oTimer);
          oTimer = setTimeout(function () {
            if (resolveBinding(bindingsCache)) renderMarks();
          }, 1200);
        });
        obs.observe(contentEl, { childList: true, subtree: true, characterData: false });
      } catch (e) {}
    }
    document.addEventListener('mouseup', function () {
      setTimeout(onSelectionChange, 10);
    });
    document.addEventListener('selectionchange', function () {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) hideFloat();
    });
    document.addEventListener('mousedown', function (e) {
      if (!(e.target && e.target.closest && e.target.closest('.coread-mia-ui,.coread-mia-dlg'))) hideFloat();
    });
    window.addEventListener('scroll', hideFloat, true);
    window.addEventListener('resize', hideFloat);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDialog(); });
    parseHashJump();
    setTimeout(probePost, 2200);
    // 绑定载入 + 跨上下文（其它 tab / 侧栏）变更监听
    refreshBindingsFromStorage(function () {
      refreshPill();
      cacheChapter();
      renderMarks();
    });
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local' || !changes || !changes.miaBindings) return;
        const arr = changes.miaBindings.newValue;
        if (Array.isArray(arr)) bindingsCache = arr;
        bindingNow = resolveBinding(bindingsCache);
        refreshPill();
        cacheChapter();
        renderMarks();
      });
    } catch (e) {}
  }

  // 注：绑定读取发生在脚本解析时（localStorage）。同一会话内其它 tab 的绑定变更
  // 在下次页面加载时生效；本 tab 内的绑定/解除立即生效。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // 兜底：布局/帧就绪偏晚的页面，load 后仍未出胶囊则补一次（不重复挂监听）
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!pill && document.body) {
        console.log('[CoRead mia] late retry');
        refreshPill();
        renderMarks();
        cacheChapter();
      }
    }, 400);
  });
})();