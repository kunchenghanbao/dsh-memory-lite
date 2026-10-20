/**
 * 抽取结果的解析与清洗。
 * 单独成文件：不依赖宿主包（@deepseek-ai/*），可以在宿主外被 node:test 直接覆盖。
 */

const KINDS = new Set(['decision', 'preference', 'fact', 'entity', 'lesson'])

export function parseItems(text, maxItems = 3) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const obj = JSON.parse(raw.slice(start, end + 1))
    const items = Array.isArray(obj?.items) ? obj.items : []
    return items
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .slice(0, maxItems)
      .map((x) => ({
        kind: KINDS.has(x.kind) ? x.kind : 'fact',
        text: x.text.trim().slice(0, 200),
        tags: Array.isArray(x.tags) ? x.tags.slice(0, 5).map(String) : [],
        confidence: clamp01(x.confidence ?? 0.6),
      }))
  } catch {
    return []
  }
}

export function clamp01(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6
}
