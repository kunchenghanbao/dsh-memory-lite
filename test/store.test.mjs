import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, shardOf } from '../lib/store.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))

test('workspaceKey 规范化：分隔符与尾斜杠不影响结果', () => {
  const s = new MemoryStore(tmp())
  assert.equal(s.workspaceKey('C:\\DeepseekWork'), 'c:/deepseekwork')
  assert.equal(s.workspaceKey('C:/DeepseekWork/'), 'c:/deepseekwork')
  assert.equal(s.workspaceKey('  C:\\DeepseekWork\\\\  '), 'c:/deepseekwork')
})

test('写入后可读，且作用域过滤正确', () => {
  const root = tmp()
  const s = new MemoryStore(root)
  const wk = s.workspaceKey('C:/proj')

  s.put({ text: '项目用 pnpm。', kind: 'decision', wk, confidence: 0.9 })
  s.put({ text: '用户偏好中文。', scope: 'global', confidence: 0.8 })

  assert.equal(s.all({ wk }).length, 2)
  assert.equal(s.all({ wk: 'c:/other' }).length, 1, 'global 永远可见，其他工作区不可见')
  assert.equal(s.all({ wk: null }).length, 1)
})

test('同文本二次写入合并而非新增', () => {
  const s = new MemoryStore(tmp())
  const wk = 'c:/x'
  const a = s.put({ text: '构建产物放 dist/。', wk })
  const b = s.put({ text: '构建产物放 dist/。  ', wk })   // 归一化后同指纹
  assert.equal(a.id, b.id)
  assert.equal(b.uses, 1)
  assert.equal(s.all({ wk }).length, 1)
})

test('remove 删除后不可见', () => {
  const s = new MemoryStore(tmp())
  const rec = s.put({ text: '临时事实。', wk: 'c:/x' })
  assert.equal(s.remove(rec.id), true)
  assert.equal(s.remove(rec.id), false)
  assert.equal(s.all({ wk: 'c:/x' }).length, 0)
})

test('prune 按工作区上限淘汰最不常用的', () => {
  const s = new MemoryStore(tmp())
  const wk = 'c:/x'
  for (let i = 0; i < 6; i++) s.put({ text: `事实 ${i}`, wk })
  assert.equal(s.all({ wk }).length, 6)
  assert.equal(s.prune(2), 4)
  assert.equal(s.all({ wk }).length, 2)
})

test('重启后从 JSONL 重放（持久化）', () => {
  const root = tmp()
  const wk = 'c:/x'
  const s1 = new MemoryStore(root)
  s1.put({ text: '重启后仍应存在。', wk })

  const s2 = new MemoryStore(root)
  assert.equal(s2.all({ wk }).length, 1)
  assert.equal(s2.all({ wk })[0].text, '重启后仍应存在。')
  rmSync(root, { recursive: true, force: true })
})

test('分片文件名不含路径分隔符与冒号', () => {
  const name = shardOf({ scope: 'workspace', workspaceKey: 'c:/work/x' })
  assert.match(name, /^workspace_[0-9a-f]{16}$/)
})
