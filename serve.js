// 预览路由：把会话工作区里的文件按原路径发给浏览器，HTML 响应里补一段批注桥。
// 这一层只做三件事：定位会话目录、挡住越界路径、认对 Content-Type。
import { readFileSync, statSync } from 'node:fs'
import { bridgeMain } from './bridge.js'

/** Host 半边注册的路由前缀；客户端按同一个前缀拼 iframe 地址（client.js 的 ROUTE_PREFIX）。 */
export const ROUTE_PREFIX = '/html-annotate'
/** 桥脚本单独走固定地址，页面之间来回跳也只加载一次。 */
export const BRIDGE_PATH = `${ROUTE_PREFIX}/bridge.js`

const MIME_BY_EXT = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
}

/**
 * 桥脚本正文：把 bridge.js 的源码原样取来、去掉 export 再调用一次。
 * 直接读文件而不是用 bridgeMain.toString()，这样改 bridge.js 只要刷新页面就生效，不用重启 DSH。
 */
let bridgeCache = { at: 0, source: '' }
export function bridgeSource() {
  try {
    const file = new URL('./bridge.js', import.meta.url)
    const info = statSync(file)
    if (info.mtimeMs !== bridgeCache.at) {
      const text = readFileSync(file, 'utf8').replace(/^export function bridgeMain/m, 'function bridgeMain')
      bridgeCache = { at: info.mtimeMs, source: `${text}\n;(bridgeMain)();` }
    }
    if (bridgeCache.source) return bridgeCache.source
  } catch (error) {
    /* 读不到就退回序列化，至少还能跑 */
  }
  return `(${bridgeMain.toString()})();`
}

/** 扩展名 → Content-Type；认不出来按二进制发。 */
export function mimeForPath(path) {
  const text = String(path || '')
  const dot = text.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  return MIME_BY_EXT[text.slice(dot + 1).toLowerCase()] || 'application/octet-stream'
}

/**
 * URL 里的路径段 → 会话内相对路径。
 * 只要安全的单段名字：空段、`.`、`..`、带斜杠或反斜杠的一律拒绝，
 * 否则 `readBytes` 虽然允许读工作区外的文件，这里就是越狱入口。
 */
export function safeRelativePath(segments) {
  const out = []
  for (const raw of Array.isArray(segments) ? segments : []) {
    let segment
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    if (!segment || segment === '.' || segment === '..') return undefined
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\u0000')) return undefined
    out.push(segment)
  }
  return out.length ? out.join('/') : undefined
}

/** 把 HTML 字节解成文本：UTF-8 优先，中文老页面退回 GB18030。 */
export function decodeHtml(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2))
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2))
  const body = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(body)
    } catch {
      return new TextDecoder('utf-8').decode(body)
    }
  }
}

/** 页面自带的 charset 会和我们发出去的不一致，统一换成 UTF-8，再把桥挂到 </body> 前。 */
export function prepareHtml(html) {
  let out = String(html || '').replace(/<meta[^>]+charset[^>]*>/gi, '')
  const meta = '<meta charset="utf-8">'
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (tag) => tag + meta)
  else out = meta + out
  const bridge = `<script src="${BRIDGE_PATH}"></script>`
  if (/<\/body\s*>/i.test(out)) return out.replace(/<\/body\s*>/i, `${bridge}</body>`)
  return out + bridge
}


// ── 多格式渲染 ───────────────────────────────────────────────────
// 预览路由不只发 HTML：Markdown / 纯文本 / 代码 / CSV / JSON / SVG / 图片
// 都在这里转成一个可批注的 HTML 壳，再交给同一个桥脚本。
// 每个块都带 data-ha-src="L起-L止"，批注里就能直接写出源码行号。

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESC_MAP[ch])
}

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])
const CSV_EXTS = new Set(['csv', 'tsv'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico'])
const CODE_EXTS = new Set([
  'txt', 'log', 'text', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'properties',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'sql', 'graphql', 'proto', 'dockerfile', 'makefile',
])

function extOf(path) {
  const text = String(path || '')
  const base = text.slice(text.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile' || base === 'license' || base === 'readme') return base
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1)
}

/** 文件 → 渲染方式：html / markdown / table / code / svg / image / other。 */
export function docKind(path) {
  const ext = extOf(path)
  if (ext === 'html' || ext === 'htm') return 'html'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (CSV_EXTS.has(ext)) return 'table'
  if (ext === 'svg') return 'svg'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (CODE_EXTS.has(ext)) return 'code'
  return 'other'
}

export function isSupportedDoc(path) {
  return docKind(path) !== 'other'
}

/* ── 极简 Markdown：够预览和批注用，块级元素带源码行号 ── */
function inlineMd(text) {
  let out = esc(text)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return out
}

const srcAttr = (from, to) => ` data-ha-src="L${from}${to > from ? `-L${to}` : ''}"`

/** Markdown → { html, lines }。行号按源文件的物理行算。 */
export function renderMarkdown(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line)
  const isTableSep = (line) => /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(line) && line.includes('-')

  while (i < lines.length) {
    const line = lines[i]
    const startLine = i + 1

    if (!line.trim()) { i += 1; continue }

    // 代码块
    const fence = line.match(/^\s*(```|~~~)(.*)$/)
    if (fence) {
      const marker = fence[1]
      const lang = (fence[2] || '').trim()
      const body = []
      i += 1
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) { body.push(lines[i]); i += 1 }
      const endLine = Math.min(i + 1, lines.length)
      i += 1
      out.push(`<pre${srcAttr(startLine, endLine)} data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}${srcAttr(startLine, startLine)}>${inlineMd(heading[2].trim())}</h${level}>`)
      i += 1
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push(`<hr${srcAttr(startLine, startLine)}>`)
      i += 1
      continue
    }

    // 表格
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const split = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
      const head = split(line)
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) { rows.push(split(lines[i])); i += 1 }
      const endLine = startLine + 1 + rows.length
      const thead = `<thead${srcAttr(startLine, startLine + 1)}><tr>${head.map((cell) => `<th>${inlineMd(cell)}</th>`).join('')}</tr></thead>`
      const tbody = rows.map((row, index) => `<tr${srcAttr(startLine + 2 + index, startLine + 2 + index)}>${row.map((cell) => `<td>${inlineMd(cell)}</td>`).join('')}</tr>`).join('')
      out.push(`<table>${thead}<tbody>${tbody}</tbody></table>`)
      void endLine
      continue
    }

    // 引用
    if (/^\s*>/.test(line)) {
      const body = []
      let j = i
      while (j < lines.length && /^\s*>/.test(lines[j])) { body.push(lines[j].replace(/^\s*>\s?/, '')); j += 1 }
      out.push(`<blockquote${srcAttr(startLine, j)}>${inlineMd(body.join(' '))}</blockquote>`)
      i = j
      continue
    }

    // 列表
    const bullet = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      const ordered = /\d/.test(bullet[1])
      const items = []
      let j = i
      while (j < lines.length) {
        const item = lines[j].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (!item) break
        items.push(`<li${srcAttr(j + 1, j + 1)}>${inlineMd(item[2])}</li>`)
        j += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}${srcAttr(startLine, j)}>${items.join('')}</${tag}>`)
      i = j
      continue
    }

    // 普通段落：吃到空行或下一个块起始
    const para = [line]
    let j = i + 1
    while (j < lines.length && lines[j].trim() && !/^(#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[j]) && !lines[j].trimStart().startsWith('```')) {
      para.push(lines[j]); j += 1
    }
    out.push(`<p${srcAttr(startLine, j)}>${inlineMd(para.join(' '))}</p>`)
    i = j
  }

  return { html: out.join('\n'), lines: lines.length }
}

/** 代码 / 纯文本：一行一个块，选中一行就带出它的源码行号。 */
export function renderCode(text, options) {
  const opts = options || {}
  const all = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const max = opts.maxLines || 4000
  const shown = all.slice(0, max)
  const rows = shown.map((line, index) => {
    const n = index + 1
    return `<div class="ha-ln${line.trim() ? '' : ' ha-ln-empty'}"${srcAttr(n, n)}>`
      + `<span class="ha-no">${n}</span><span class="ha-tx">${esc(line) || ' '}</span></div>`
  })
  if (all.length > max) rows.push(`<div class="ha-cut">… 余下 ${all.length - max} 行未显示</div>`)
  return { html: `<div class="ha-code">${rows.join('')}</div>`, lines: all.length }
}

/** CSV / TSV：解析成表格，行带行号，框选能落到单元格。 */
export function renderTable(text, delimiter) {
  const sep = delimiter || ','
  const parsed = []
  let row = []
  let cell = ''
  let quoted = false
  const src = String(text || '').replace(/\r\n?/g, '\n')
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === sep) { row.push(cell); cell = ''; continue }
    if (ch === '\n') { row.push(cell); parsed.push(row); row = []; cell = ''; continue }
    cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); parsed.push(row) }

  const maxRows = 400
  const head = parsed[0] || []
  const body = parsed.slice(1, maxRows + 1)
  const thead = `<thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
  const tbody = body.map((cells, index) => `<tr${srcAttr(index + 2, index + 2)}>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
  const cut = parsed.length > maxRows + 1 ? `<p class="ha-cut">… 余下 ${parsed.length - maxRows - 1} 行未显示</p>` : ''
  return { html: `<div class="ha-tablewrap"><table>${thead}<tbody>${tbody}</tbody></table></div>${cut}`, lines: parsed.length }
}

/** JSON 试着格式化成代码；解析不了就按原文。 */
export function renderJsonLike(text) {
  const raw = String(text || '')
  try {
    return renderCode(JSON.stringify(JSON.parse(raw), null, 2))
  } catch {
    return renderCode(raw)
  }
}

const DOC_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#fff;color:#1f2430;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.ha-doc{max-width:900px;margin:0 auto;padding:28px 32px 80px}
.ha-doc h1,.ha-doc h2,.ha-doc h3,.ha-doc h4,.ha-doc h5,.ha-doc h6{line-height:1.3;margin:1.4em 0 .6em;font-weight:650}
.ha-doc h1{font-size:1.9em;border-bottom:1px solid #e6e8ee;padding-bottom:.3em}
.ha-doc h2{font-size:1.5em;border-bottom:1px solid #eef0f4;padding-bottom:.25em}
.ha-doc h3{font-size:1.22em}
.ha-doc p{margin:.85em 0}
.ha-doc a{color:#3b5bdb;text-decoration:none}
.ha-doc a:hover{text-decoration:underline}
.ha-doc ul,.ha-doc ol{padding-left:1.6em;margin:.7em 0}
.ha-doc li{margin:.25em 0}
.ha-doc blockquote{margin:.9em 0;padding:.1em 1em;border-left:3px solid #d5dbe6;color:#5b6472}
.ha-doc hr{border:0;border-top:1px solid #e6e8ee;margin:1.6em 0}
.ha-doc code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f3f5f9;padding:.12em .38em;border-radius:4px}
.ha-doc pre{background:#f6f8fb;border:1px solid #e8ebf1;border-radius:8px;padding:12px 14px;overflow:auto;margin:1em 0}
.ha-doc pre code{background:none;padding:0;font-size:12.5px}
.ha-doc table{border-collapse:collapse;width:100%;margin:1em 0;font-size:14px}
.ha-doc th,.ha-doc td{border:1px solid #e6e8ee;padding:7px 10px;text-align:left;vertical-align:top}
.ha-doc th{background:#f7f8fb;font-weight:600}
.ha-doc img{max-width:100%;height:auto}
.ha-code{max-width:1100px;margin:0 auto;padding:20px 24px 80px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ha-ln{display:flex;gap:12px;white-space:pre;border-radius:3px}
.ha-ln:hover{background:#f2f5fb}
.ha-no{flex:0 0 auto;min-width:3em;text-align:right;color:#a8b1c0;user-select:none;-webkit-user-select:none}
.ha-tx{flex:1 1 auto;overflow-wrap:normal}
.ha-cut{color:#8b95a6;margin:14px 0 0;font:13px/1.6 system-ui,sans-serif}
.ha-tablewrap{max-width:1100px;margin:0 auto;padding:22px 24px 10px;overflow:auto}
.ha-tablewrap table{border-collapse:collapse;font-size:13.5px}
.ha-tablewrap th,.ha-tablewrap td{border:1px solid #e0e4ec;padding:6px 10px;text-align:left;white-space:pre-wrap}
.ha-tablewrap th{background:#f5f7fb;position:sticky;top:0}
body.ha-kind-image{background:#12141a;display:grid;place-items:center;min-height:100vh;padding:16px}
body.ha-kind-image img{max-width:100%;max-height:calc(100vh - 32px);box-shadow:0 10px 40px rgba(0,0,0,.5);border-radius:2px}
body.ha-kind-svg{padding:20px;background:#fff;display:grid;place-items:center;min-height:100vh}
body.ha-kind-svg svg{max-width:100%;height:auto}
::selection{background:#cdd8ff}
@media (prefers-color-scheme: dark){
  body{background:#15171d;color:#e7eaf0}
  .ha-doc h1,.ha-doc h2{border-color:#2a2e38}
  .ha-doc blockquote{border-color:#33405a;color:#aab3c2}
  .ha-doc code{background:#232833}
  .ha-doc pre{background:#1b1f27;border-color:#272c36}
  .ha-doc th{background:#1d222b}
  .ha-doc th,.ha-doc td{border-color:#2a2f3a}
  .ha-ln:hover{background:#222834}
  .ha-no{color:#5c6575}
  .ha-tablewrap th,.ha-tablewrap td{border-color:#2a2f3a}
  .ha-tablewrap th{background:#1d222b}
  body.ha-kind-image{background:#0c0e12}
  body.ha-kind-svg{background:#15171d}
  ::selection{background:#2f3f6b}
}
`

/** 把渲染结果包成一份完整文档；桥脚本由 prepareHtml 统一挂上。 */
export function shellHtml(options) {
  const opts = options || {}
  const kind = opts.kind || 'doc'
  return '<!DOCTYPE html>\n<html lang="zh">\n<head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(opts.title || '')}</title>`
    + `<style>${DOC_CSS}</style>`
    + '</head>\n'
    + `<body class="ha-kind-${esc(kind)}">${opts.body || ''}`
    + '</body>\n</html>'
}

function send(res, status, type, body, method, headers) {
  try {
    res.statusCode = status
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    for (const [name, value] of Object.entries(headers || {})) res.setHeader(name, value)
    if (method === 'HEAD' || body === undefined || body === null) res.end()
    else res.end(body)
  } catch {
    // 浏览器已经断开，写不出去就算了
  }
}

/** 路由处理器：`/html-annotate/s/<sessionId>/<文件相对路径>`。 */
export function createPreviewHandler(deps) {
  const sessions = deps && deps.sessions
  const workspaceFiles = deps && deps.workspaceFiles
  const connection = deps && deps.connection

  return async function previewHandler(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', method)
      return
    }
    // 和 DSH 自己的 Web 路由用同一套信任检查，别单开一个没门槛的入口
    if (connection && typeof connection.requestRejection === 'function') {
      let rejection
      try {
        rejection = await connection.requestRejection(req)
      } catch {
        rejection = 403
      }
      if (rejection === 401 || rejection === 403) {
        send(res, rejection, 'text/plain; charset=utf-8', rejection === 401 ? 'Unauthorized' : 'Forbidden', method)
        return
      }
    }

    let pathname
    let search
    try {
      const parsedUrl = new URL(String((req && req.url) || '/'), 'http://html-annotate.invalid')
      pathname = parsedUrl.pathname
      search = parsedUrl.searchParams
    } catch {
      send(res, 400, 'text/plain; charset=utf-8', 'Bad Request', method)
      return
    }
    if (pathname === BRIDGE_PATH) {
      send(res, 200, 'text/javascript; charset=utf-8', bridgeSource(), method)
      return
    }

    const segments = pathname.split('/').filter((part) => part !== '')
    if (segments[0] !== 'html-annotate') {
      send(res, 404, 'text/plain; charset=utf-8', 'Not Found', method)
      return
    }
    if (segments.length === 1) {
      send(res, 200, 'text/plain; charset=utf-8', 'html-annotate preview route\n', method)
      return
    }
    if (segments[1] !== 's' || segments.length < 4) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not Found', method)
      return
    }

    let sessionId
    try {
      sessionId = decodeURIComponent(segments[2])
    } catch {
      send(res, 400, 'text/plain; charset=utf-8', 'Bad Request', method)
      return
    }
    const relative = safeRelativePath(segments.slice(3))
    if (!relative) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not Found', method)
      return
    }

    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    const cwd = session && session.header ? session.header.cwd : ''
    if (!cwd) {
      send(res, 404, 'text/plain; charset=utf-8', 'Session not found', method)
      return
    }
    if (!workspaceFiles || typeof workspaceFiles.readBytes !== 'function') {
      send(res, 503, 'text/plain; charset=utf-8', 'File service unavailable', method)
      return
    }

    let read
    try {
      read = await workspaceFiles.readBytes({ sessionId, workspaceRoot: cwd }, relative, {}, new AbortController().signal)
    } catch {
      send(res, 404, 'text/plain; charset=utf-8', `Cannot read ${relative}`, method)
      return
    }
    const data = read && read.data
    if (!(data instanceof Uint8Array) || data.length === 0) {
      send(res, 404, 'text/plain; charset=utf-8', `Cannot read ${relative}`, method)
      return
    }

    const kind = docKind(relative)
    const name = relative.split('/').pop() || relative

    // 资源直出：页面里引用的图片、字体、样式表都走这里（?raw=1）
    if (search && search.get('raw') === '1') {
      const headers = kind === 'image' ? { 'Access-Control-Allow-Origin': '*' } : undefined
      send(res, 200, mimeForPath(relative), data, method, headers)
      return
    }

    if (kind === 'html') {
      send(res, 200, 'text/html; charset=utf-8', prepareHtml(decodeHtml(data)), method)
      return
    }

    if (kind === 'image') {
      const body = `<img id="ha-image" src="${esc(pathname)}?raw=1" alt="${esc(name)}">`
      send(res, 200, 'text/html; charset=utf-8',
        prepareHtml(shellHtml({ title: name, kind: 'image', body })), method)
      return
    }

    if (kind === 'svg') {
      // 内联 SVG：里面每个图形都能被点选、被框选
      const svg = decodeHtml(data)
      const body = svg.length > 800000 ? `<div class="ha-doc"><p class="ha-cut">SVG 过大（${svg.length} 字节），只按源码显示。</p></div>` : `<div class="ha-svg">${svg}</div>`
      send(res, 200, 'text/html; charset=utf-8',
        prepareHtml(shellHtml({ title: name, kind: 'svg', body })), method)
      return
    }

    if (kind === 'markdown' || kind === 'table' || kind === 'code') {
      let text = decodeHtml(data)
      if (text.length > 400000) text = `${text.slice(0, 400000)}\n\n… 文件过大，只显示前 400000 个字符`
      let body = ''
      if (kind === 'markdown') body = `<article class="ha-doc">${renderMarkdown(text).html}</article>`
      else if (kind === 'table') body = `<div class="ha-doc">${renderTable(text, extOf(relative) === 'tsv' ? '\t' : ',').html}</div>`
      else {
        const ext = extOf(relative)
        body = (ext === 'json' || ext === 'jsonc') ? renderJsonLike(text).html : renderCode(text).html
      }
      send(res, 200, 'text/html; charset=utf-8',
        prepareHtml(shellHtml({ title: name, kind, body })), method)
      return
    }

    send(res, 200, mimeForPath(relative), data, method)
  }
}
