// serve.js 的离线测试：预览路由的路径校验、HTML 注入、MIME 与编码识别
const test = require('node:test')
const assert = require('node:assert')

let serve = null
test('载入 serve.js', async () => {
  serve = await import('../serve.js')
  assert.ok(serve, 'serve.js 载入失败')
})

test('safeRelativePath：只放行安全的单段路径', () => {
  assert.strictEqual(serve.safeRelativePath(['pages', 'teacher-home.html']), 'pages/teacher-home.html')
  assert.strictEqual(serve.safeRelativePath(['a b.html']), 'a b.html')
  // 穿越、编码后的穿越、空段、绝对路径风格的一律拒绝
  assert.strictEqual(serve.safeRelativePath(['..', 'etc', 'passwd']), undefined)
  assert.strictEqual(serve.safeRelativePath(['%2e%2e', 'x']), undefined)
  assert.strictEqual(serve.safeRelativePath(['a/b']), undefined)
  assert.strictEqual(serve.safeRelativePath(['a\\b']), undefined)
  assert.strictEqual(serve.safeRelativePath(['%2F']), undefined)
  assert.strictEqual(serve.safeRelativePath([]), undefined)
})

test('prepareHtml：换掉 charset，桥脚本挂在 </body> 前', () => {
  const out = serve.prepareHtml('<html><head><meta charset="gbk"></head><body><p>x</p></body></html>')
  assert.ok(out.includes('<meta charset="utf-8">'), '应补 utf-8 meta')
  assert.ok(!/charset="gbk"/.test(out), '旧 charset 应移除')
  assert.ok(out.indexOf('html-annotate/bridge.js') < out.indexOf('</body>'), '桥应挂进 body 里')
  // 没有 head / body 的碎片也要能挂上
  assert.ok(serve.prepareHtml('<p>x</p>').includes('html-annotate/bridge.js'))
})

test('mimeForPath：常见扩展名与兜底', () => {
  assert.strictEqual(serve.mimeForPath('pages/x.html'), 'text/html; charset=utf-8')
  assert.strictEqual(serve.mimeForPath('a/b.css'), 'text/css; charset=utf-8')
  assert.strictEqual(serve.mimeForPath('a/b.mjs'), 'text/javascript; charset=utf-8')
  assert.strictEqual(serve.mimeForPath('img/logo.PNG'), 'image/png')
  assert.strictEqual(serve.mimeForPath('noext'), 'application/octet-stream')
})

test('decodeHtml：GB18030 老页面能解出中文', () => {
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
  assert.strictEqual(serve.decodeHtml(gbk), '中文')
})

/** 造一个够用的 req/res 对，直接调路由处理器。 */
function fakeExchange(url, method) {
  const headers = {}
  let body = ''
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name.toLowerCase()] = value },
    end(chunk) {
      if (chunk === undefined) return
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8')
    },
  }
  return {
    req: { url, method: method || 'GET', headers: { host: '127.0.0.1:62957' } },
    res,
    headers,
    get body() { return body },
  }
}

test('路由：越界路径直接 404，读不到文件 404', async () => {
  const handler = serve.createPreviewHandler({
    sessions: { get: (id) => (id === 's1' ? { header: { cwd: '/workspace' } } : undefined) },
    workspaceFiles: { readBytes: async () => { throw new Error('nope') } },
  })
  const crossed = fakeExchange('/html-annotate/s/s1/%2e%2e/%2e%2e/etc/passwd')
  await handler(crossed.req, crossed.res)
  assert.strictEqual(crossed.res.statusCode, 404)

  const missing = fakeExchange('/html-annotate/s/s1/pages/x.html')
  await handler(missing.req, missing.res)
  assert.strictEqual(missing.res.statusCode, 404)

  const noSession = fakeExchange('/html-annotate/s/s2/pages/x.html')
  await handler(noSession.req, noSession.res)
  assert.strictEqual(noSession.res.statusCode, 404)
})

test('路由：HTML 响应注入桥，其他文件按 MIME 原样发', async () => {
  const files = {
    'pages/home.html': Buffer.from('<html><head></head><body>hi</body></html>'),
    'assets/app.css': Buffer.from('body{color:red}'),
  }
  const handler = serve.createPreviewHandler({
    sessions: { get: () => ({ header: { cwd: '/workspace' } }) },
    workspaceFiles: {
      readBytes: async (scope, path) => {
        const found = files[path]
        if (!found) throw new Error('missing')
        return { absolutePath: '/workspace/' + path, version: 'v1', offset: 0, data: new Uint8Array(found), eof: true }
      },
    },
  })
  const html = fakeExchange('/html-annotate/s/s1/pages/home.html')
  await handler(html.req, html.res)
  assert.strictEqual(html.res.statusCode, 200)
  assert.ok(html.body.includes('html-annotate/bridge.js'), 'HTML 应带桥脚本')

  // .css 现在按代码页渲染（可框选某一行），样式表本体走 ?raw=1
  const css = fakeExchange('/html-annotate/s/s1/assets/app.css')
  await handler(css.req, css.res)
  assert.strictEqual(css.res.statusCode, 200)
  assert.strictEqual(css.headers['content-type'], 'text/html; charset=utf-8')
  assert.ok(css.body.includes('ha-ln'), 'CSS 应渲染成带行号的代码页')
  assert.ok(css.body.includes('body{color:red}'))

  const raw = fakeExchange('/html-annotate/s/s1/assets/app.css?raw=1')
  await handler(raw.req, raw.res)
  assert.strictEqual(raw.headers['content-type'], 'text/css; charset=utf-8')
  assert.strictEqual(raw.body, 'body{color:red}')
})

test('路由：Markdown / CSV / 图片 各自渲染成可批注的页面', async () => {
  const files = {
    'notes/todo.md': Buffer.from('# 标题\n\n- 一\n- 二\n\n```js\nlet a = 1\n```\n'),
    'data/list.csv': Buffer.from('name,qty\napple,3\npear,5\n'),
    'img/cover.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  }
  const handler = serve.createPreviewHandler({
    sessions: { get: () => ({ header: { cwd: '/workspace' } }) },
    workspaceFiles: {
      readBytes: async (scope, path) => {
        const found = files[path]
        if (!found) throw new Error('missing')
        return { absolutePath: '/workspace/' + path, version: 'v1', offset: 0, data: new Uint8Array(found), eof: true }
      },
    },
  })

  const md = fakeExchange('/html-annotate/s/s1/notes/todo.md')
  await handler(md.req, md.res)
  assert.ok(md.body.includes('<h1 data-ha-src="L1">'), '标题应带源码行号')
  assert.ok(md.body.includes('<li data-ha-src="L3">'), '列表项应带源码行号')
  assert.ok(md.body.includes('data-lang="js"'), '代码块应保留语言')
  assert.ok(md.body.includes('html-annotate/bridge.js'), 'Markdown 页也要挂桥')

  const csv = fakeExchange('/html-annotate/s/s1/data/list.csv')
  await handler(csv.req, csv.res)
  assert.ok(csv.body.includes('<th>name</th>'), 'CSV 应渲染成表头')
  assert.ok(csv.body.includes('<tr data-ha-src="L2">'), '数据行应带行号')

  const img = fakeExchange('/html-annotate/s/s1/img/cover.png')
  await handler(img.req, img.res)
  assert.ok(img.body.includes('<img id="ha-image"'), '图片应包进可批注的壳')
  assert.ok(img.body.includes('?raw=1'), '图片本体走 raw 通道')

  const rawImg = fakeExchange('/html-annotate/s/s1/img/cover.png?raw=1')
  await handler(rawImg.req, rawImg.res)
  assert.strictEqual(rawImg.headers['content-type'], 'image/png')
  assert.strictEqual(rawImg.headers['access-control-allow-origin'], '*')
})

test('路由：桥脚本按脚本发，HEAD 不回 body', async () => {
  const handler = serve.createPreviewHandler({ sessions: { get: () => null }, workspaceFiles: {} })
  const bridge = fakeExchange('/html-annotate/bridge.js')
  await handler(bridge.req, bridge.res)
  assert.strictEqual(bridge.res.statusCode, 200)
  assert.ok(bridge.body.includes('__ha'), '桥脚本应包含上行走廊标记')

  const head = fakeExchange('/html-annotate/bridge.js', 'HEAD')
  await handler(head.req, head.res)
  assert.strictEqual(head.res.statusCode, 200)
  assert.strictEqual(head.body, '')
})
