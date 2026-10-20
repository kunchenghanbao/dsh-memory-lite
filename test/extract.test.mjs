import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseItems } from '../lib/parse.js'

test('解析标准 JSON 输出', () => {
  const items = parseItems('{"items":[{"kind":"decision","text":"用 pnpm。","tags":["pnpm"],"confidence":0.9}]}', 3)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'decision')
  assert.equal(items[0].text, '用 pnpm。')
  assert.equal(items[0].confidence, 0.9)
})

test('容忍模型包了 Markdown 代码块或前后废话', () => {
  const raw = '好的，结果如下：\n```json\n{"items":[{"text":"约定：产物放 dist/。","confidence":0.7}]}\n```\n以上。'
  const items = parseItems(raw, 3)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'fact', '缺失 kind 时回落成 fact')
  assert.match(items[0].text, /dist\//)
})

test('非法 JSON / 空数组 / 超量都安全', () => {
  assert.deepEqual(parseItems('not json', 3), [])
  assert.deepEqual(parseItems('{"items":[]}', 3), [])
  assert.equal(parseItems('{"items":[{"text":"a"},{"text":"b"},{"text":"c"},{"text":"d"}]}', 2).length, 2)
})

test('confidence 越界被夹到 0..1，text 截断到 200 字', () => {
  const long = 'x'.repeat(500)
  const items = parseItems(JSON.stringify({ items: [{ text: long, confidence: 9 }] }), 3)
  assert.equal(items[0].confidence, 1)
  assert.equal(items[0].text.length, 200)
})
