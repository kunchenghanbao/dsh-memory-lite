/**
 * 检索：中文按「字 bigram」、英文数字按词；BM25 打分后按规则重排，最后按 token 预算裁剪。
 * 纯函数，无 IO、无依赖，便于单测。
 */

export function tokenize(input) {
  const out = []
  const text = String(input ?? '').toLowerCase()
  for (const m of text.matchAll(/[a-z0-9_.\-]{2,}|[\u3400-\u9fff]+/g)) {
    const t = m[0]
    if (/^[\u3400-\u9fff]+$/.test(t)) {
      if (t.length === 1) out.push(t)
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2))
    } else {
      out.push(t)
    }
  }
  return out
}

/** 中文 1 字 ≈ 1 token，其余 ≈ 0.3，取整；只用于预算，不做账单 */
export function estimateTokens(text) {
  let n = 0
  for (const ch of String(text ?? '')) n += /[\u3400-\u9fff]/.test(ch) ? 1 : 0.3
  return Math.max(1, Math.ceil(n))
}

export function retrieve(records, query, { limit = 6, budgetTokens = 600, halflifeDays = 45 } = {}) {
  const q = tokenize(query)
  if (q.length === 0 || records.length === 0) return []

  const docs = records.map((r) => ({
    r,
    toks: tokenize(`${r.text} ${(r.tags ?? []).join(' ')}`),
  }))
  const N = docs.length
  const avgLen = docs.reduce((a, d) => a + d.toks.length, 0) / N || 1

  const df = new Map()
  for (const d of docs) {
    for (const t of new Set(d.toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }

  const k1 = 1.2
  const b = 0.75
  const scored = []
  for (const d of docs) {
    const tf = new Map()
    for (const t of d.toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    let bm25 = 0
    for (const t of q) {
      const f = tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      bm25 += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.toks.length / avgLen)))
    }
    if (bm25 <= 0) continue
    const days = (Date.now() - Date.parse(d.r.lastUsedAt ?? d.r.createdAt)) / 864e5
    scored.push({
      rec: d.r,
      score:
        0.50 * (bm25 / 1) +
        0.15 * Math.exp(-(Number.isFinite(days) ? days : 0) / halflifeDays) +
        0.10 * Math.min(1, (d.r.uses ?? 0) / 5) +
        0.10 * kindWeight(d.r.kind),
    })
  }
  if (scored.length === 0) return []

  const max = Math.max(...scored.map((s) => s.score)) || 1
  for (const s of scored) s.score = s.score / max
  scored.sort((a, b2) => b2.score - a.score)

  const out = []
  let used = 0
  for (const s of scored) {
    const cost = estimateTokens(s.rec.text)
    if (used + cost > budgetTokens) continue
    used += cost
    out.push(s.rec)
    if (out.length >= limit) break
  }
  return out
}

function kindWeight(kind) {
  const w = { decision: 1.0, preference: 0.9, fact: 0.8, entity: 0.7, lesson: 0.6 }
  return w[kind] ?? 0.8
}
