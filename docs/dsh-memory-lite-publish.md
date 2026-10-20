# `dsh-memory-lite` 发布说明

> 状态：**已在 DeepSeek Harness `0.2.1-rc.2` 实机验证通过**，可发布
> 包名：`dsh-memory-lite`（npm 上当前未被占用）
> 插件行 id / 数据目录：`dsh-memory`（历史兼容，不影响使用）

---

## 一、这是什么

给 DSH 补一层**跨会话的事实记忆**：把对话里定下来的约定、决策、偏好沉淀成本地条目，之后每轮按当前消息检索，命中才注入，预算硬上限。

与同类插件的区别：

| | dsh-memory-lite | dsh-recall | dsh-memory |
|---|---|---|---|
| 记录什么 | 提炼后的**结论** | 会话**原文** | 模型自述事实 |
| 检索 | BM25 + 中文 bigram，零依赖 | 三层检索 + 本地模型 | FTS5 |
| 体积 | **~45 KB** | ~14 MB（+23 MB 模型） | ~26 KB |
| 注入 | 每轮按消息检索、预算裁剪 | 门控后注入 | 固定 prompt section |

可与 `dsh-recall` 共存：原文找它，结论查本插件。

---

## 二、安装

```bash
dsh plugin --profile <你的 profile> add dsh-memory-lite
```

装完**重启宿主**（DSH 不热重载 `node_modules` 里的插件代码；`client.js` 也需要重启才会被加载）。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-memory-lite
```

数据保留在 `$DSH_HOME/dsh-memory/`，需要彻底清除请手动删除该目录。

---

## 三、配置

```yaml
- id: dsh-memory
  config:
    enabled: true
    ui: collapsed              # collapsed（默认）/ visible / hidden
    retrieval:
      budgetTokens: 600        # 硬上限
      budgetRatio: 0.03        # 且不超过 contextWindow × 3%
      topK: 6
      halflifeDays: 45
      minConfidence: 0.6
      reinjectAfterTurns: 8    # 同一条记忆多少轮内不重复注入
      source: hook             # hook（默认）/ user
    extraction:
      enabled: true            # false = 只用 /remember 与工具
      minTurnsBetweenExtractions: 3
      model: { provider: '', model: '' }   # 留空 = 跟随当前会话模型
    store:
      maxRecordsPerWorkspace: 2000
```

---

## 四、给模型的能力

| 入口 | 说明 |
|---|---|
| `memory` 工具 | `search` / `remember` / `forget` |
| `/memory` | 记忆库统计 |
| `/remember <文本>` | 手动记录（confidence = 1） |
| 自动注入 | 每轮检索命中 → 以 `source: hook` 的消息追加，预算内、每会话 ≤40 次 |
| 自动抽取 | 每 3 个完成回合，从最近 6 轮抽 ≤3 条事实 |

---

## 五、已验证项（实机，`0.2.1-rc.2` / Windows）

- [x] 插件加载：`apply-done`，无 `apply-throw`
- [x] 工具注册与调用：`remember` / `search` / `forget`
- [x] 自动注入：`inject-ok wk=c:/deepseekwork hits=1/1 turn=51`
- [x] 对话界面不再出现整段记忆（`hook` 来源不进对话流）
- [x] 轨迹界面折叠为 `▸ 已注入 N 条记忆（展开）`，可点开
- [x] 按条去重：8 轮内同一条不重复注入
- [x] 工作区键规范化：`C:\X` 与 `C:/X/` 视为同一工作区
- [x] 单元测试 18 个全绿（存储 / 检索 / 解析）

**未验证**：自动抽取的实机产出（需要连续 3 个完成回合 + 可用路由），代码路径已就位但尚无样本。

---

## 六、发布步骤

```bash
cd dsh-memory
npm test                 # 18 个用例
npm pack                 # 生成 dsh-memory-lite-0.1.0.tgz，先本地装一遍验证
npm publish --access public
```

发布前建议补齐：

1. `repository` / `homepage` / `bugs` 字段（需要 GitHub 仓库地址）；
2. 用 GitHub Actions + npm trusted publishing 发布，拿到 provenance（dshmarket 生态已经默认这个水位）；
3. 提交收录：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 或自建 format 1 索引。

---

## 七、已知边界

- 检索是**词面**匹配（BM25 + 中文 bigram），换词、意译召回弱；语义检索不在本插件范围内。
- 自动抽取依赖当前会话模型；如果模型不可用会静默跳过（不阻塞对话）。
- 折叠依赖 DOM 结构，若界面大改可能失效——失效时退化为原样显示，不会报错。
- `tapIndex` 注入脚本的旧路径在桌面端不可靠，默认关闭。
