import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * JSONL 追加式存储。
 * 真源是磁盘上的行，内存索引只是重放结果；坏行跳过，不阻断启动。
 * 写：永远只写「会话分片」或 `_global`，避免多进程同时追加同一文件。
 */
export class MemoryStore {
  constructor(root) {
    this.root = root
    this.dir = join(root, 'sessions')
    mkdirSync(this.dir, { recursive: true })
    this.index = new Map()
    this.loaded = false
    this.writes = 0
  }

  /**
   * workspace 键 = 规范化后的路径本身（不哈希）。
   * 之前哈希只对「分隔符与大小写」一种写法稳定，宿主里 `exec.cwd`、`header.cwd`、
   * `process.cwd()` 三种来源写法不一致时会算出不同键，记忆就"写进去、读不到"。
   * 现在统一成小写正斜杠、去尾斜杠，且键可读、可排查。
   */
  workspaceKey(cwd) {
    return String(cwd ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
  }

  #ensure() {
    if (this.loaded) return
    this.loaded = true
    let files = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(this.dir, f))
    } catch { /* 目录不存在：空库 */ }
    for (const file of files) this.#replay(file)
  }

  #replay(file) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const op = JSON.parse(line)
        if (op.op === 'upsert' && op.rec?.id) this.index.set(op.rec.id, op.rec)
        else if (op.op === 'del' && op.id) this.index.delete(op.id)
      } catch { /* 跳过坏行 */ }
    }
  }

  put(input) {
    this.#ensure()
    const now = new Date().toISOString()
    const text = String(input.text ?? '').trim()
    if (!text) throw new Error('empty memory text')

    const hash = hashText(text)
    // 同指纹直接合并，避免同一条事实反复入库
    for (const rec of this.index.values()) {
      if (rec.hash === hash) {
        rec.uses += 1
        rec.confidence = Math.max(rec.confidence ?? 0, input.confidence ?? 0.6)
        rec.lastUsedAt = now
        this.#append(shardOf(rec), { op: 'upsert', rec })
        return rec
      }
    }

    const rec = {
      id: 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: input.kind ?? 'fact',
      scope: input.scope ?? 'workspace',
      workspaceKey: input.wk ?? '',
      sessionId: input.source?.sessionId ?? '',
      text,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 5).map(String) : [],
      source: input.source ?? {},
      createdAt: now,
      lastUsedAt: now,
      uses: 0,
      confidence: clamp01(input.confidence ?? 0.6),
      ttlDays: Number.isFinite(input.ttlDays) ? input.ttlDays : 90,
      hash,
    }
    this.#append(shardOf(rec), { op: 'upsert', rec })
    this.index.set(rec.id, rec)
    return rec
  }

  remove(id) {
    this.#ensure()
    const rec = this.index.get(id)
    if (!rec) return false
    this.index.delete(id)
    this.#append(shardOf(rec), { op: 'del', id })
    return true
  }

  touch(ids) {
    this.#ensure()
    const now = new Date().toISOString()
    for (const id of ids) {
      const rec = this.index.get(id)
      if (!rec) continue
      rec.uses += 1
      rec.lastUsedAt = now
    }
  }

  /** 按作用域取候选；过期条目当场过滤 */
  all({ wk, sid }) {
    this.#ensure()
    const now = Date.now()
    const out = []
    for (const rec of this.index.values()) {
      if (rec.ttlDays > 0 && now - Date.parse(rec.createdAt) > rec.ttlDays * 864e5) continue
      if (rec.scope === 'global') out.push(rec)
      else if (rec.scope === 'workspace' && rec.workspaceKey === wk) out.push(rec)
      else if (rec.scope === 'session' && sid && rec.sessionId === sid) out.push(rec)
    }
    return out
  }

  /** 每个 workspace 超量时按（命中次数, 最近使用）淘汰，并落一条 del */
  prune(maxPerWorkspace = 0) {
    this.#ensure()
    const max = Number(maxPerWorkspace)
    if (!Number.isFinite(max) || max <= 0) return 0

    const byWs = new Map()
    for (const rec of this.index.values()) {
      if (rec.scope !== 'workspace') continue
      const list = byWs.get(rec.workspaceKey) ?? []
      list.push(rec)
      byWs.set(rec.workspaceKey, list)
    }

    let removed = 0
    for (const list of byWs.values()) {
      if (list.length <= max) continue
      list.sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0)
        || Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt))
      for (const rec of list.slice(max)) {
        this.index.delete(rec.id)
        this.#append(shardOf(rec), { op: 'del', id: rec.id })
        removed += 1
      }
    }
    if (removed > 0) this.diagnose('prune', `removed ${removed}`)
    return removed
  }

  stats() {
    this.#ensure()
    const by = { global: 0, workspace: 0, session: 0 }
    for (const r of this.index.values()) by[r.scope] = (by[r.scope] ?? 0) + 1
    return `记忆库：global ${by.global} / workspace ${by.workspace} / session ${by.session}（共 ${this.index.size}）`
  }

  diagnose(kind, detail) {
    try {
      mkdirSync(this.root, { recursive: true })
      appendFileSync(
        join(this.root, 'diagnostics.ndjson'),
        JSON.stringify({ at: new Date().toISOString(), kind, detail: String(detail).slice(0, 500) }) + '\n',
      )
    } catch { /* 诊断失败绝不影响主流程 */ }
  }

  #append(shard, op) {
    try {
      const file = join(this.dir, shard.replace(/[^\w.-]/g, '_') + '.jsonl')
      appendFileSync(file, JSON.stringify(op) + '\n')
      this.writes += 1
    } catch (error) {
      this.diagnose('store-write', error instanceof Error ? error.message : String(error))
    }
  }
}

export function shardOf(rec) {
  if (rec.scope === 'session' && rec.sessionId) return 'session_' + rec.sessionId
  if (rec.scope === 'global') return '_global'
  // 键现在是可读路径，文件名仍用短哈希：避免冒号/斜杠进文件名
  const key = String(rec.workspaceKey || 'unknown')
  return 'workspace_' + createHash('sha1').update(key).digest('hex').slice(0, 16)
}

function clamp01(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6
}

function hashText(text) {
  return 'sha256:' + createHash('sha256')
    .update(String(text).toLowerCase().replace(/[\s\p{P}]/gu, ''))
    .digest('hex').slice(0, 32)
}

export { existsSync }
