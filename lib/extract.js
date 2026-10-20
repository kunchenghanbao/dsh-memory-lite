import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseItems } from './parse.js'

const SYSTEM = [
  '你是一个记忆抽取器。只输出 JSON，不要解释、不要 Markdown 代码块。',
  '从给定的对话片段中抽取可跨会话复用的「事实 / 决策 / 偏好」，最多 {N} 条。',
  '每条必须是一句陈述句（≤200 字），写清楚主语与结论，禁止「用户可能想要」这类推测。',
  '不要抽取：密钥、令牌、一次性命令输出、寒暄。',
  '没有可抽取的内容就返回 {"items":[]}。',
  '输出格式：{"items":[{"kind":"decision|preference|fact|entity|lesson","text":"…","tags":["…"],"confidence":0.0}]}',
].join('\n')

/** 从会话派生消息里取最近若干轮的纯文本，压到预算内 */
export function transcriptText(session, { maxTurns = 6, maxChars = 12000 } = {}) {
  let messages = []
  try { messages = session?.deriveMessages?.() ?? [] } catch { return '' }
  if (!Array.isArray(messages) || messages.length === 0) return ''

  const lines = []
  for (const msg of messages.slice(-maxTurns * 2)) {
    const role = msg?.role ?? 'unknown'
    const text = blocksToText(msg?.content)
    if (!text) continue
    lines.push(`[${role}] ${text.slice(0, 1200)}`)
  }
  return lines.join('\n').slice(-maxChars)
}

function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b?.type === 'text' ? String(b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** @returns {Promise<Array<{kind,text,tags,confidence}>>} 失败返回空数组，绝不抛 */
// pickModel 由 index.js 的 routeOf 取代：路由可能是显式配置，也可能跟随当前会话
export async function extractMemories(ctx, cfg, { session, maxItems = 3, route = null }) {
  try {
    const llm = ctx.llm
    if (!llm || typeof llm.stream !== 'function') return []

    const sel = route
    if (!sel?.provider || !sel?.model) return []

    const transcript = transcriptText(session, {
      maxTurns: cfg.extraction.windowTurns,
      maxChars: Math.max(2000, cfg.extraction.maxInputTokens * 2),
    })
    if (!transcript) return []

    const options = {
      provider: sel.provider,
      model: sel.model,
      sessionId: 'dsh-memory:extract',
      system: SYSTEM.replace('{N}', String(maxItems)),
      messages: [createUserMessage({
        content: [{ type: 'text', text: `对话片段：\n${transcript}\n\n请输出 JSON。` }],
        source: { kind: 'user' },
      })],
      temperature: 0,
      reasoningEffort: ReasoningEffortId('off'),
      signal: AbortSignal.timeout(60_000),
    }

    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) assembler.push(chunk)

    const text = assembler.blocks()
      .filter((x) => x?.type === 'text')
      .map((x) => String(x.text ?? ''))
      .join('')
      .trim()

    return parseItems(text, maxItems)
  } catch {
    return []
  }
}

export { parseItems }
