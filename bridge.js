// ── 注入到预览页里的桥脚本（在页面上下文里跑） ─────────────
// Host 侧的预览路由把 bridgeMain.toString() 写进每个 HTML 响应，
// 所以这里不能引用模块里的任何变量，只能用页面自己的全局。
export function bridgeMain() {
  const send = (message) => {
    try {
      // 带上当前文档地址：父侧据此判断批注属于哪个页面，跳转之后不会把标记串到别处
      window.parent.postMessage(Object.assign({}, message, {
        __ha: true,
        dir: 'up',
        page: String(window.location.pathname || ''),
      }), '*')
    } catch (error) {
      /* 忽略 */
    }
  }
  let mode = 'idle'
  let marks = []
  let drag = null
  let lastHover = null
  // 当前正在写的那条批注指到的元素：滚动时把新位置报给外层，气泡才能跟着走
  let draftSelector = null
  // 已经选好、框已定住的元素（Ctrl 可多选）。元素按选择器追踪位置，框选区域按文档坐标追踪
  let pinned = []

  const HOVER_CSS = 'position:fixed;display:none;outline:2px solid #4D6BFE;outline-offset:2px;background:rgba(77,107,254,.12);border-radius:3px;box-sizing:border-box;pointer-events:none;'
  // 已经选过东西之后，鼠标下的候选框画得轻一点，避免和定住的选框混在一起
  const HOVER_CSS_DIM = 'position:fixed;display:none;outline:1.5px dashed rgba(77,107,254,.75);outline-offset:2px;background:rgba(77,107,254,.05);border-radius:3px;box-sizing:border-box;pointer-events:none;'

  const layer = document.createElement('div')
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;'
  const pinnedLayer = document.createElement('div')
  pinnedLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;'
  const hoverBox = document.createElement('div')
  hoverBox.style.cssText = HOVER_CSS
  const dragBox = document.createElement('div')
  dragBox.style.cssText = 'position:fixed;display:none;border:1.5px dashed #4D6BFE;background:rgba(77,107,254,.10);box-sizing:border-box;pointer-events:none;'
  const badgeLayer = document.createElement('div')
  badgeLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;'
  layer.append(pinnedLayer, hoverBox, dragBox, badgeLayer)

  const mount = () => {
    if (!layer.isConnected) (document.body || document.documentElement).appendChild(layer)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()

  // ── 自定义选框 ────────────────────────────────────────────────
  // Shift+拖动（或「框选」模式）拉出来的框不是画完就定死的：
  // 框本身可以拖动、八个角可以拉大小、方向键微调、Delete 删掉，
  // 每次改动都按新尺寸重新采样一遍框里的元素再报给外层。
  const marquee = document.createElement('div')
  marquee.setAttribute('data-ha-part', 'move')
  marquee.style.cssText = 'position:fixed;display:none;box-sizing:border-box;border:1.5px dashed #4D6BFE;'
    + 'background:rgba(77,107,254,.10);pointer-events:auto;cursor:move;touch-action:none;'
  const marqueeTag = document.createElement('div')
  marqueeTag.style.cssText = 'position:absolute;left:-2px;top:-20px;padding:2px 6px;border-radius:4px;'
    + 'background:#4D6BFE;color:#fff;font:600 11px/1.3 system-ui,-apple-system,sans-serif;white-space:nowrap;pointer-events:none;'
  const marqueeDel = document.createElement('div')
  marqueeDel.setAttribute('data-ha-part', 'del')
  marqueeDel.setAttribute('title', '删除选框 / Remove box')
  marqueeDel.textContent = '×'
  marqueeDel.style.cssText = 'position:absolute;right:-9px;top:-9px;width:18px;height:18px;border-radius:50%;'
    + 'background:#fff;border:1.5px solid #4D6BFE;color:#4D6BFE;font:600 12px/15px system-ui,-apple-system,sans-serif;'
    + 'text-align:center;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.25);box-sizing:border-box;'
  const HANDLE_CSS = {
    nw: 'left:-5px;top:-5px;cursor:nwse-resize;',
    n: 'left:50%;top:-5px;margin-left:-5px;cursor:ns-resize;',
    ne: 'right:-5px;top:-5px;cursor:nesw-resize;',
    e: 'right:-5px;top:50%;margin-top:-5px;cursor:ew-resize;',
    se: 'right:-5px;bottom:-5px;cursor:nwse-resize;',
    s: 'left:50%;bottom:-5px;margin-left:-5px;cursor:ns-resize;',
    sw: 'left:-5px;bottom:-5px;cursor:nesw-resize;',
    w: 'left:-5px;top:50%;margin-top:-5px;cursor:ew-resize;',
  }
  Object.keys(HANDLE_CSS).forEach((dir) => {
    const dot = document.createElement('div')
    dot.setAttribute('data-ha-part', dir)
    dot.style.cssText = 'position:absolute;width:10px;height:10px;border-radius:2px;background:#fff;'
      + 'border:1.5px solid #4D6BFE;box-sizing:border-box;pointer-events:auto;' + HANDLE_CSS[dir]
    marquee.appendChild(dot)
  })
  marquee.appendChild(marqueeTag)
  marquee.appendChild(marqueeDel)
  layer.appendChild(marquee)

  let boxDrag = null
  let boxSeq = 0
  let areaFrame = 0
  let areaDirty = false

  function viewportRectOfBox() {
    const item = pinned[0]
    if (!item || !item.docRect) return null
    return {
      x: item.docRect.x - window.scrollX,
      y: item.docRect.y - window.scrollY,
      width: item.docRect.width,
      height: item.docRect.height,
    }
  }

  function drawMarquee() {
    const rect = mode === 'idle' ? null : viewportRectOfBox()
    if (!rect) {
      marquee.style.display = 'none'
      return
    }
    marquee.style.display = 'block'
    marquee.style.left = `${Math.round(rect.x)}px`
    marquee.style.top = `${Math.round(rect.y)}px`
    marquee.style.width = `${Math.round(rect.width)}px`
    marquee.style.height = `${Math.round(rect.height)}px`
    marqueeTag.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`
  }

  function currentBoxId() {
    const item = pinned[0]
    return item && item.docRect ? item.boxId || 0 : 0
  }

  function areaPayload(rect) {
    return {
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      items: collectArea(rect),
      boxId: currentBoxId(),
    }
  }

  function flushArea() {
    areaDirty = false
    if (areaFrame) { window.cancelAnimationFrame(areaFrame); areaFrame = 0 }
    const rect = viewportRectOfBox()
    if (!rect || curBoxKind() !== 'area') return
    send({ type: 'area', payload: areaPayload(rect) })
  }

  function curBoxKind() {
    const item = pinned[0]
    return item && item.docRect ? 'area' : ''
  }

  function scheduleArea() {
    areaDirty = true
    if (areaFrame) return
    areaFrame = window.requestAnimationFrame(() => {
      areaFrame = 0
      if (!areaDirty) return
      areaDirty = false
      const rect = viewportRectOfBox()
      if (!rect || curBoxKind() !== 'area') return
      send({ type: 'area', payload: areaPayload(rect) })
    })
  }

  function applyBoxRect(rect) {
    pinned = [{
      docRect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: Math.max(8, rect.width),
        height: Math.max(8, rect.height),
      },
      boxId: currentBoxId() || (boxSeq += 1),
    }]
    drawMarquee()
    scheduleArea()
  }

  function clearBox(notify) {
    boxDrag = null
    pinned = []
    pinnedLayer.textContent = ''
    drawMarquee()
    if (notify) {
      draftSelector = null
      send({ type: 'clear-draft' })
    }
  }

  function updateBoxDrag(x, y) {
    if (!boxDrag) return
    const dx = x - boxDrag.sx
    const dy = y - boxDrag.sy
    const base = boxDrag.rect
    const next = { x: base.x, y: base.y, width: base.width, height: base.height }
    if (boxDrag.kind === 'move') {
      next.x = base.x + dx
      next.y = base.y + dy
    } else {
      const dir = boxDrag.dir
      if (dir.indexOf('w') >= 0) { next.x = base.x + dx; next.width = base.width - dx }
      if (dir.indexOf('e') >= 0) { next.width = base.width + dx }
      if (dir.indexOf('n') >= 0) { next.y = base.y + dy; next.height = base.height - dy }
      if (dir.indexOf('s') >= 0) { next.height = base.height + dy }
      if (next.width < 8) { next.width = 8; if (dir.indexOf('w') >= 0) next.x = base.x + base.width - 8 }
      if (next.height < 8) { next.height = 8; if (dir.indexOf('n') >= 0) next.y = base.y + base.height - 8 }
    }
    applyBoxRect(next)
  }

  // 页面自己的脚本往往在 load 之后才把内容渲染出来（课程列表、图表都是 JS 填的）。
  // 标记如果只在收到消息时画一次，元素那时还不存在，就永远看不到框；所以盯住 DOM，变了一帧内重画。
  let markFrame = 0
  const scheduleRedraw = () => {
    if (markFrame) return
    markFrame = window.requestAnimationFrame(() => {
      markFrame = 0
      renderMarks()
      renderPinned()
      drawMarquee()
      syncDraft()
    })
  }
  try {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (!layer.contains(record.target)) {
          scheduleRedraw()
          return
        }
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  } catch (error) {
    /* 老浏览器没有 MutationObserver 就只靠 scroll/resize 重画 */
  }

  const escapeIdent = (value) => {
    try {
      return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^\w-]/g, '\\$&')
    } catch (error) {
      return String(value)
    }
  }

  // 选择器必须能唯一指回元素：一批结构相同的卡片或按钮里，只靠固定几段 tag+class 会撞车，
  // 之后按选择器回查要么指到别的元素、要么在隐藏区域里画出一个看不见的框。
  // 所以从元素自身开始逐级往上拼，拼到「全页只匹配这一个」为止（上限 12 段，到根还没唯一就返回当前结果）。
  function selectorOf(el) {
    const isUnique = (selector) => {
      try {
        return document.querySelectorAll(selector).length === 1
      } catch (error) {
        return false
      }
    }
    const segmentOf = (node, withIndex) => {
      let segment = node.tagName.toLowerCase()
      const classes = Array.from(node.classList || []).slice(0, 3)
      if (classes.length) segment += `.${classes.map(escapeIdent).join('.')}`
      if (withIndex) {
        const parent = node.parentElement
        if (parent) {
          const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
          if (same.length > 1) segment += `:nth-of-type(${same.indexOf(node) + 1})`
        }
      }
      return segment
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 12) {
      if (node.id && isUnique(`#${escapeIdent(node.id)}`)) {
        parts.unshift(`#${escapeIdent(node.id)}`)
        break
      }
      parts.unshift(segmentOf(node, false))
      if (isUnique(parts.join(' > '))) break
      parts[0] = segmentOf(node, true)
      if (isUnique(parts.join(' > '))) break
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const STYLE_KEYS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'border-radius',
    'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'gap', 'box-shadow',
  ]

  function stylesOf(el) {
    const styles = {}
    try {
      const computed = window.getComputedStyle(el)
      for (const key of STYLE_KEYS) {
        const value = computed.getPropertyValue(key)
        if (value && value !== 'none' && value !== 'normal' && value !== 'auto') styles[key] = value
      }
    } catch (error) {
      /* 忽略 */
    }
    return styles
  }

  function describe(el) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      domId: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      text,
      styles: stylesOf(el),
      rect: rectOf(el),
    }
  }

  function rectOf(el) {
    const rect = el.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }

  function setBox(box, rect) {
    if (!rect) {
      box.style.display = 'none'
      return
    }
    box.style.display = 'block'
    box.style.left = `${rect.x}px`
    box.style.top = `${rect.y}px`
    box.style.width = `${Math.max(0, rect.width)}px`
    box.style.height = `${Math.max(0, rect.height)}px`
  }

  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y)
    if (!el || el === document.documentElement || el === document.body) return null
    if (layer.contains(el)) return null
    return el
  }

  function hoverAt(x, y) {
    const el = hitTest(x, y)
    hoverBox.style.cssText = pinned.length ? HOVER_CSS_DIM : HOVER_CSS
    if (!el) {
      setBox(hoverBox, null)
      lastHover = null
      return
    }
    const selector = selectorOf(el)
    // 已经选中的元素不再画候选框
    if (pinned.some((item) => item.selector === selector)) {
      setBox(hoverBox, null)
      lastHover = el
      return
    }
    if (el === lastHover) {
      setBox(hoverBox, rectOf(el))
      return
    }
    lastHover = el
    setBox(hoverBox, rectOf(el))
  }

  function dragRect() {
    const left = Math.min(drag.x0, drag.x1)
    const top = Math.min(drag.y0, drag.y1)
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(Math.abs(drag.x1 - drag.x0)),
      height: Math.round(Math.abs(drag.y1 - drag.y0)),
    }
  }

  function collectArea(rect) {
    const found = new Map()
    const stepX = Math.max(10, rect.width / 6)
    const stepY = Math.max(10, rect.height / 4)
    for (let y = rect.y; y <= rect.y + rect.height && found.size < 16; y += stepY) {
      for (let x = rect.x; x <= rect.x + rect.width && found.size < 16; x += stepX) {
        const el = hitTest(x, y)
        if (!el) continue
        const info = describe(el)
        if (!found.has(info.selector)) found.set(info.selector, info)
      }
    }
    return Array.from(found.values()).slice(0, 12)
  }

  function infoOf(selector) {
    let el = null
    try {
      el = document.querySelector(selector)
    } catch (error) {
      el = null
    }
    return el ? describe(el) : null
  }

  /** 把已定住的选框画出来：选中的元素跟着页面走；区域选框由 marquee 自己画（可拖、可拉角）。 */
  function renderPinned() {
    pinnedLayer.textContent = ''
    pinned.forEach((item) => {
      if (!item.selector) return
      const info = infoOf(item.selector)
      if (!info) return
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;outline:2px solid #4D6BFE;outline-offset:2px;background:rgba(77,107,254,.14);border-radius:3px;box-sizing:border-box;pointer-events:none;'
      setBox(box, info.rect)
      pinnedLayer.appendChild(box)
    })
    drawMarquee()
  }

  /** 点到的元素上已经有批注？用选择器回匹配元素本身，选择器后来变了也还能认出来。 */
  function markedIds(el) {
    if (!marks.length) return []
    const ids = []
    for (const mark of marks) {
      const selectors = Array.isArray(mark.selectors) && mark.selectors.length
        ? mark.selectors
        : (mark.selector ? [mark.selector] : [])
      for (const selector of selectors) {
        try {
          if (selector && el.matches(selector)) {
            if (mark.id) ids.push(String(mark.id))
            break
          }
        } catch (error) {
          /* 选择器失效就当这个元素没标过 */
        }
      }
    }
    return ids.slice(0, 8)
  }

  function sendPinned(additive, marked) {
    const items = []
    for (const item of pinned) {
      if (!item.selector) continue
      const info = infoOf(item.selector)
      if (info) items.push(info)
    }
    if (!items.length) {
      draftSelector = null
      send({ type: 'clear-draft' })
      return
    }
    const last = items[items.length - 1]
    draftSelector = last.selector
    send({ type: 'multi', items, rect: last.rect, additive, markIds: marked || [] })
  }

  function pick(event) {
    const el = hitTest(event.clientX, event.clientY)
    if (!el) return
    const info = describe(el)
    const additive = Boolean(event.ctrlKey || event.metaKey)
    if (additive) {
      // Ctrl/Cmd 点：把元素加进/移出本次批注
      const index = pinned.findIndex((item) => item.selector === info.selector)
      if (index >= 0) pinned.splice(index, 1)
      else pinned.push({ selector: info.selector })
    } else {
      pinned = [{ selector: info.selector }]
    }
    renderPinned()
    sendPinned(additive, markedIds(el))
  }

  /** 滚动或窗口变化后，把正在批注的元素的新位置报上去。 */
  let syncFrame = 0
  /** 滚动或窗口变化后，把正在批注的元素的新位置报上去。按帧合并，一帧最多一条。 */
  function syncDraft() {
    if (!draftSelector || syncFrame) return
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = 0
      let el = null
      try {
        el = document.querySelector(draftSelector)
      } catch (error) {
        el = null
      }
      if (!el) return
      send({
        type: 'draft-rect',
        rect: rectOf(el),
        selector: draftSelector,
        selectors: pinned.map((item) => item.selector).filter(Boolean),
      })
    })
  }

  function renderMarks() {
    badgeLayer.textContent = ''
    const here = String(window.location.pathname || '')
    // 批注记着自己是在哪个页面标的：在预览里跳到别的页面时，只画属于当前页面的标记
    const visible = marks.filter((mark) => {
      const page = mark && mark.path ? String(mark.path) : ''
      return !page || page === here
    })
    visible.forEach((mark, index) => {
      const selectors = Array.isArray(mark.selectors) && mark.selectors.length
        ? mark.selectors
        : (mark.selector ? [mark.selector] : [])
      for (const selector of selectors) {
        let el = null
        try {
          el = document.querySelector(selector)
        } catch (error) {
          el = null
        }
        if (!el) continue
        const rect = rectOf(el)
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;outline:1.5px solid #4D6BFE;outline-offset:1px;background:rgba(77,107,254,.10);border-radius:3px;box-sizing:border-box;pointer-events:none;'
        setBox(box, rect)
        badgeLayer.appendChild(box)
        const badge = document.createElement('div')
        badge.textContent = String(index + 1)
        badge.style.cssText = 'position:fixed;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#4D6BFE;color:#fff;font:600 11px/18px system-ui,-apple-system,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);box-sizing:border-box;pointer-events:none;'
        badge.style.left = `${rect.x + rect.width - 10}px`
        badge.style.top = `${rect.y - 10}px`
        badgeLayer.appendChild(badge)
      }
    })
  }

  document.addEventListener('mousemove', (event) => {
    if (boxDrag) {
      updateBoxDrag(event.clientX, event.clientY)
      return
    }
    if (mode === 'idle') return
    if (drag) {
      drag.x1 = event.clientX
      drag.y1 = event.clientY
      setBox(dragBox, dragRect())
      return
    }
    hoverAt(event.clientX, event.clientY)
  }, true)

  document.addEventListener('mousedown', (event) => {
    if (mode === 'idle') return
    const part = event.target && event.target.closest ? event.target.closest('[data-ha-part]') : null
    if (part) {
      // 点在选框本体 / 手柄 / 删除按钮上：不进页面选区逻辑，改框
      event.preventDefault()
      event.stopPropagation()
      const kind = part.getAttribute('data-ha-part')
      if (kind === 'del') {
        clearBox(true)
        return
      }
      const rect = viewportRectOfBox()
      if (!rect) return
      boxDrag = { kind: kind === 'move' ? 'move' : 'resize', dir: kind, sx: event.clientX, sy: event.clientY, rect }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (mode === 'rect' || event.shiftKey) {
      drag = { x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY }
      // 开始画新区域，之前定住的选框让位
      pinned = []
      renderPinned()
      setBox(hoverBox, null)
      lastHover = null
    }
  }, true)

  document.addEventListener('mouseup', (event) => {
    if (boxDrag) {
      event.preventDefault()
      event.stopPropagation()
      boxDrag = null
      flushArea()
      return
    }
    if (mode === 'idle') return
    // 页面自己的 mouseup 处理（拖拽结束之类）也别跑
    event.stopPropagation()
    if (!drag) {
      pick(event)
      return
    }
    const rect = dragRect()
    drag = null
    setBox(dragBox, null)
    if (rect.width < 8 || rect.height < 8) {
      if (mode === 'rect') {
        // 框选模式下点了一下没拖：保持原来的框，不当成点选元素
        drawMarquee()
        return
      }
      pick(event)
      return
    }
    draftSelector = null
    // 区域按文档坐标记下，滚动时选框跟着页面走；boxId 让外层知道这是同一条草稿在改尺寸
    boxSeq += 1
    pinned = [{
      docRect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      boxId: boxSeq,
    }]
    drawMarquee()
    send({ type: 'area', payload: areaPayload(rect) })
  }, true)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      send({ type: 'escape' })
      return
    }
    if (mode === 'idle' || curBoxKind() !== 'area') return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      clearBox(true)
      return
    }
    const step = event.shiftKey ? 10 : 1
    let dx = 0
    let dy = 0
    if (event.key === 'ArrowLeft') dx = -step
    else if (event.key === 'ArrowRight') dx = step
    else if (event.key === 'ArrowUp') dy = -step
    else if (event.key === 'ArrowDown') dy = step
    else return
    const rect = viewportRectOfBox()
    if (!rect) return
    event.preventDefault()
    applyBoxRect({ x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height })
    flushArea()
  }, true)

  // 批注模式吃下页面自己的交互：按钮不响应、链接不跳转、表单不提交。
  // 空闲时也不放行链接，否则 iframe 会离开批注页。
  const swallow = (event) => {
    if (mode === 'idle') return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('click', swallow, true)
  document.addEventListener('dblclick', swallow, true)
  document.addEventListener('auxclick', swallow, true)
  document.addEventListener('submit', swallow, true)

  // 指针事件只挡页面自己的处理、不 preventDefault：取消 pointerdown 会让浏览器
  // 不再派发兼容的 mousedown，我们自己的选区逻辑就收不到事件了。
  const blockPointer = (event) => {
    if (mode === 'idle') return
    event.stopImmediatePropagation()
  }
  document.addEventListener('pointerdown', blockPointer, true)
  document.addEventListener('pointerup', blockPointer, true)

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.__ha !== true || data.dir !== 'down') return
    if (data.type === 'mode') {
      mode = data.mode || 'idle'
      if (mode === 'idle') {
        setBox(hoverBox, null)
        setBox(dragBox, null)
        drag = null
        lastHover = null
        draftSelector = null
        pinned = []
        renderPinned()
      }
      drawMarquee()
      send({ type: 'mode-changed', mode })
    } else if (data.type === 'marks') {
      marks = Array.isArray(data.items) ? data.items : []
      renderMarks()
    } else if (data.type === 'clear-pins') {
      pinned = []
      renderPinned()
    } else if (data.type === 'scroll-to-y') {
      const y = Number(data.y)
      if (Number.isFinite(y)) window.scrollTo(0, Math.max(0, y))
    }
  })

  // 滚动位置先记在父侧，文档重建后按它恢复，AI 改完文件不会把人弹回顶部
  let lastScrollSent = 0
  function reportScroll() {
    const now = Date.now()
    if (now - lastScrollSent < 250) return
    lastScrollSent = now
    send({ type: 'scroll-y', y: Math.round(window.scrollY || 0) })
  }

  // 滚动里三件事合成一帧，两千行的页面也不至于每像素都重排
  let scrollFrame = 0
  function onScroll() {
    if (scrollFrame) return
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0
      renderMarks()
      renderPinned()
      drawMarquee()
      syncDraft()
      reportScroll()
    })
  }

  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', () => { renderMarks(); renderPinned(); drawMarquee(); syncDraft() })
  send({ type: 'ready', href: String(window.location.href || '').slice(0, 512) })
}
