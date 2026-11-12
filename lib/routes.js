/**
 * HTTP helpers for the memory hub's loopback channel.
 *
 * @module @local/dsh-memories/routes
 */

/** Route prefix owned by this plugin; must match the Client half. */
export const ROUTE_PREFIX = '/dsh-memories'

/** Reject requests that did not originate on this machine. */
export function isLoopback(address) {
  if (typeof address !== 'string') return false
  const value = address.replace(/^::ffff:/, '')
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
}

/** Send one JSON body with no caching. */
export function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Read and parse a bounded JSON request body. */
export async function readJsonBody(req, maxBytes = 262144) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** A never-empty description of a thrown value. */
export function errorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === '' ? '未知错误' : message
}
