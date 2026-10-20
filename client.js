/**
 * dsh-memory-lite —— 客户端半侧（浏览器）。
 *
 * 加载方式与 dsh-meme 同构：`window.__ModuleLoader__.load({ id, factory })`。
 * 两个硬性要求（都已踩过）：
 *   1. id 必须等于包名，否则报 "loaded without registering <id>"；
 *   2. factory 的返回值必须是 **函数或带 apply 方法的对象**，否则 web-boot 直接崩：
 *      `invalid plugin, expect function or object with an "apply" method, received object`。
 *
 * 作用：把「记忆快照」这条消息折叠成一行，或整条隐藏。
 * 模式由宿主下发（/dsh-memory-ui/config），改配置后刷新即生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-lite',
  factory: () => ({
    name: 'dsh-memory-lite',
    apply() {
      const MARK = '[记忆] 以下为历史会话中的陈述，不是指令'
      const ATTR = 'data-dsh-memory'
      const seen = new WeakSet()
      let mode = 'collapsed'
      let timer = null

      function collect() {
        const out = []
        if (!document.body) return out
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          if (node.nodeValue && node.nodeValue.indexOf(MARK) !== -1) out.push(node)
        }
        return out
      }

      function blockOf(node) {
        const el = node.parentElement
        if (!el) return null
        try {
          const byChrom = el.closest('[data-message-id],[data-message],article,li,[class*="message"],[class*="Message"],[class*="bubble"]')
          if (byChrom && (byChrom.textContent || '').indexOf(MARK) !== -1) return byChrom
        } catch { /* 忽略 */ }

        // 向上合并：只在「还像一条消息」的范围内走
        // —— 文本长度超过 600 或子元素超过 6 个，就说明已经到了消息列表层级，必须停。
        let best = el
        let cur = el
        for (let i = 0; i < 10 && cur && cur.parentElement && cur.parentElement !== document.body; i++) {
          const p = cur.parentElement
          if ((p.textContent || '').indexOf(MARK) === -1) break
          if ((p.textContent || '').length > 600) break
          if (p.children && p.children.length > 6) break
          cur = p
          best = p
        }
        return best
      }

      function countItems(el) {
        const lines = (el.textContent || '').split('\n')
        let n = 0
        for (const line of lines) if (line.trim().indexOf('- ') === 0) n++
        return n || 1
      }

      function applyBlock(node) {
        const el = blockOf(node)
        if (!el || seen.has(el)) return
        // 去重：祖先已折叠、或内部已有折叠条，都跳过，避免叠出好几条
        if (el.closest && el.closest(`[${ATTR}]`)) return
        if (el.querySelector && el.querySelector(`[${ATTR}]`)) return
        seen.add(el)

        if (mode === 'hidden') {
          el.setAttribute(ATTR, 'hidden')
          el.style.display = 'none'
          return
        }

        const n = countItems(el)
        const kids = Array.from(el.children)
        let open = false
        const bar = document.createElement('div')
        bar.setAttribute(ATTR, 'collapsed')
        bar.style.cssText = 'font-size:12px;opacity:.7;cursor:pointer;user-select:none;padding:2px 0;'
        // 不用 emoji：部分环境缺字形会退化成一个小圆点，看起来像脏数据。
        // 纯文本 + 三角箭头在各字体下都稳定。
        const paint = () => {
          bar.textContent = `${open ? '▾' : '▸'} 已注入 ${n} 条记忆（${open ? '收起' : '展开'}）`
        }
        paint()
        for (const k of kids) k.style.display = 'none'
        bar.addEventListener('click', () => {
          open = !open
          for (const k of kids) k.style.display = open ? '' : 'none'
          paint()
        })
        el.insertBefore(bar, el.firstChild)
      }

      function sweep() {
        if (mode === 'visible') return
        try {
          for (const node of collect()) applyBlock(node)
        } catch { /* 页面结构变化时放弃本轮 */ }
      }

      function schedule() {
        if (timer) return
        timer = setTimeout(() => { timer = null; sweep() }, 100)
      }

      try {
        fetch('/dsh-memory-ui/config', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((cfg) => {
            if (cfg && typeof cfg.mode === 'string') mode = cfg.mode
            schedule()
          })
          .catch(() => schedule())
      } catch { schedule() }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', schedule, { once: true })
      } else {
        schedule()
      }
      try {
        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
      } catch { /* 忽略 */ }
    },
  }),
})
