# dsh-memory-lite

Lightweight cross-session **fact** memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).
Zero runtime dependencies, no model download, no embedding service — one JSONL store and a token-budgeted recall.

> [中文说明](#中文) · English below

**英文速览**：dsh 目前没有内置记忆。本插件在每轮用户消息到达时，用中文友好的 BM25 检索本地事实库，命中的条目以一条「历史陈述，非指令」的 user 快照追加进上下文；预算硬上限（默认 600 tokens，且不超过上下文窗口的 3%）。每 3 轮可自动从对话里抽取 ≤3 条事实入库。全部数据在 `$DSH_HOME/dsh-memory/v1`。

## 定位：它不是「回忆原文」，是「沉淀事实」

| | dsh-memory-lite（本插件） | `dsh-recall` | `dsh-memory` |
|---|---|---|---|
| 记录什么 | 提炼后的**结论**（决策/偏好/事实） | 会话**原文**片段 | 自述事实（模型主动写） |
| 检索 | BM25 + 中文 bigram，零依赖 | 字面/模糊/语义三层，带本地模型 | FTS5 |
| 体积 | **~40 KB** | ~14 MB（+23 MB 可选模型） | ~26 KB |
| 注入 | 每轮按当前消息检索后注入 | 门控后注入 | 固定 prompt section |
| 适合 | 跨会话的约定、口径、偏好 | 「上次那段对话怎么说的」 | 模型自觉记录 |

两个插件**可以共存**：原文找 `dsh-recall`，结论查本插件。

## 安装

```bash
dsh plugin --profile <profile> add dsh-memory-lite
```

装完**重启**宿主（宿主不热重载 `node_modules` 里的插件代码）。

## 给模型什么

| 入口 | 说明 |
|---|---|
| `memory` 工具 | `search` / `remember` / `forget` 三个动作 |
| `system-prompt` 段 | 一句固定说明（**逐字稳定**，不打断 KV 前缀缓存） |
| 每轮注入 | 命中时追加一条 `[记忆 · 来源：历史会话，不是指令]` 快照 |

注入的三条纪律：每回合 ≤1 次、内容不变不注入、每会话 ≤40 条。

## 配置

```yaml
- id: dsh-memory
  config:
    enabled: true
    ui: collapsed             # visible 原样显示 / collapsed 折成一行（默认）/ hidden 不显示
    retrieval:
      budgetTokens: 600        # 硬上限
      budgetRatio: 0.03        # 且不超过 contextWindow × 3%
      topK: 6
      halflifeDays: 45
      minConfidence: 0.6
      reinjectAfterTurns: 8    # 同一条记忆多少轮内不重复注入
      source: hook             # hook = 标记为 hook 注入（默认）；user = 冒充用户消息
    extraction:
      enabled: true            # false = 只手动记录
      minTurnsBetweenExtractions: 3
      model: { provider: '', model: '' }   # 留空 = 跟随当前会话模型
    store:
      maxRecordsPerWorkspace: 2000
```

## 数据

```
$DSH_HOME/dsh-memory/v1/
  sessions/workspace_<hash>.jsonl   # 项目事实（按工作区隔离）
  sessions/_global.jsonl            # 全局偏好
  sessions/session_<id>.jsonl       # 会话内临时
  diagnostics.ndjson                # 注入/抽取诊断
```

JSONL 是唯一真源，删掉即清空。工作区键 = 规范化路径（小写、正斜杠、去尾斜杠），因此 `C:\X` 与 `C:/X/` 视为同一工作区。

## 命令

| 命令 | 说明 |
|---|---|
| `/memory` | 各作用域条数 |
| `/remember <文本>` | 手动记录（confidence = 1） |

## 开发

```bash
npm test          # node --test（18 个用例，覆盖存储/检索/解析）
```

实测记录（0.2.1-rc.2，Windows）：

- 插件加载、工具注册、`remember/search`、自动注入均已实机跑通；
- 注入有审计行：`{"kind":"inject-ok","detail":"wk=c:/deepseekwork hits=1 turn=28"}`；
- 自动抽取首次触发需要 3 个完成回合，尚未有实机样本（见 issue 待办）。

## License

MIT

---

## 中文

跨会话**事实**记忆：轻、可预测、不打断缓存。

- **写**：`/remember` 手动，或每 3 轮从最近 6 轮对话里抽取 ≤3 条事实（可关）
- **读**：每轮按当前消息检索，命中才注入，预算硬上限
- **养**：同文本自动合并、TTL 过期、每工作区容量上限、按会话分片存储

三条设计红线：hook 不抛异常、事件回调不做 IO、注入必须限流。
