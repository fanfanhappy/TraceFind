// 本地假嵌入服务：验证云端链路（鉴权、批量、维度）不依赖真实 API Key。
// 用法：node tools/mock-embed-server.mjs [port]
import http from 'node:http'

const port = Number(process.argv[2] ?? 9099)
const DIM = 8
const KEY = 'sk-mock'

// 文本 -> 稳定的 8 维向量（按字符码累加，再做 L2 归一化）
export function embed(text) {
  const vec = new Array(DIM).fill(0)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    vec[i % DIM] += ((code % 31) + 1) / 31
    vec[(i * 3 + 1) % DIM] += ((code % 17) + 1) / 17
  }
  const norm = Math.hypot(...vec) || 1
  return vec.map((value) => value / norm)
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const user = payload?.messages?.find?.((m) => m.role === 'user')?.content ?? ''
      const cited = user.match(/^\[(\d+)\]/gm) ?? []
      const answer = `（mock）已根据 ${cited.length} 段资料作答。资料中提到的要点见 [1]。`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: payload?.model ?? 'mock-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      }))
    })
    return
  }

  if (req.method !== 'POST' || !req.url?.endsWith('/embeddings')) {
    res.writeHead(404).end('not found')
    return
  }

  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    return
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400).end('bad json')
      return
    }
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
    const data = inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: embed(String(text)),
    }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', model: payload.model ?? 'mock', data }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock embeddings on http://127.0.0.1:${port}/v1 (key=${KEY}, dim=${DIM})`)
})
