/**
 * 译文引用的原文块：判定"这条引用是不是译文"，以及该拿哪份原文给它做对照。
 *
 * 背景（2026-10-24）：PDF 阅读器里用户读的是译文，划的也是译文里的一句；引用身份
 * `selectedText` 是**整张卡片的原文**。agent 拼 prompt 时原先只用了引文（中文），
 * 原文一直躺在 msg 里没被用上。这里把"要不要挂原文块、挂哪份"拆成纯函数，便于单测。
 *
 * 不做逐句对齐：卡片内没有字符锚点（中文那句 ↔ 英文哪句不可知）。这里只到卡片级，
 * 由模型自己把引文对到英文段上。
 */

/** 原文块最多放多少字（实测卡片级原文 442–3419 字，6000 是硬顶）。 */
export const REF_SOURCE_MAX = 6000

const CJK_RE = /[\u4e00-\u9fff]/

/** 超长截断并明说 —— 静默截断会让模型以为原文就到这里为止。 */
export function clipRefSource(text) {
  const s = String(text || '').trim()
  if (s.length <= REF_SOURCE_MAX) return s
  return s.slice(0, REF_SOURCE_MAX) + '\n…（原文过长，已截断）'
}

/**
 * 这条引用是不是译文引用？
 *
 * 判定顺序：
 *   ① 标注记录里有 `translation` 字段 → 是（权威，老记录也认）；
 *   ② 认不到记录时退一步看语言：引文是中文、引用身份不是中文 → 基本只能是译文。
 *
 * @param {{ref?: object|null, selectedText?: string, material?: string}} p
 *   ref         标注记录（可能为 null：记录被删、或书已换 ID）
 *   selectedText 引用身份里的原文
 *   material    引文块（content 里 `> "…"` 那几行，可能带 `> "` 包装）
 */
export function isTranslatedRef({ ref, selectedText, material } = {}) {
  if (ref && String(ref.translation || '').trim()) return true
  const mat = String(material || '')
  const own = String(selectedText || '')
  return CJK_RE.test(mat) && !!own.trim() && !CJK_RE.test(own)
}

/**
 * 该拿哪份文字当"这段译文的原文"。
 *
 *   · 文字条目 → 标注里的 `context` 是划线附近各 300 字的**英文原文**（比卡片原文更全），用它；
 *   · 扫描件   → `context` 是整张卡片的**中文译文**（不是原文），退回 `selectedText`（OCR 原文）。
 *
 * "context 是不是原文"用中文粗筛：我们译成中文，原文是英/德文，这条在现有数据上成立；
 * 认错了也只是原文块里带着译文，不会把引用身份弄错。
 */
export function refSourceOf({ ref, selectedText } = {}) {
  const ctx = String((ref && ref.context) || '').trim()
  if (ctx && !CJK_RE.test(ctx)) return ctx
  return String(selectedText || '').trim()
}
