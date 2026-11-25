import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

function isSafeChildPath(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir)
  const resolvedTarget = path.resolve(targetPath)
  const rel = path.relative(resolvedRoot, resolvedTarget)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function sendFileResponse(
  res: http.ServerResponse,
  filePath: string,
  method: string,
  immutable: boolean,
  extraHeaders: Record<string, string> = {},
): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    const contentType = getContentType(filePath)
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      ...extraHeaders,
    }
    if (path.extname(filePath).toLowerCase() === '.html') {
      headers['X-Robots-Tag'] = 'noindex, nofollow'
    }
    res.writeHead(200, headers)
    if (method === 'HEAD') {
      res.end()
      return true
    }
    const content = fs.readFileSync(filePath)
    res.end(content)
    return true
  } catch {
    return false
  }
}

/**
 * Serves built frontend assets from `dist/` with strict path-traversal containment
 * and SPA history fallback to `dist/index.html` for non-`/api/*` routes.
 */
export function tryServeStaticAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options?: { distDir?: string },
): boolean {
  if (process.env.FLARE_SERVE_STATIC === 'false') {
    return false
  }
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return false
  }

  const rawUrl = req.url ?? '/'
  if (rawUrl.startsWith('/api/') || rawUrl === '/api') {
    return false
  }

  const distDir = path.resolve(
    options?.distDir ?? path.join(process.cwd(), 'dist'),
  )
  if (!fs.existsSync(distDir)) {
    return false
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname)
  } catch {
    return false
  }

  // Block obvious traversal / dotfile attempts before resolving
  if (pathname.includes('\0') || pathname.split('/').some((seg) => seg.startsWith('.'))) {
    return false
  }

  const cleaned = pathname === '/' ? '/index.html' : pathname
  const candidate = path.resolve(distDir, `.${cleaned}`)

  if (isSafeChildPath(distDir, candidate) && fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate)
    if (stat.isFile()) {
      const immutable = cleaned.startsWith('/assets/')
      return sendFileResponse(res, candidate, method, immutable)
    }
  }

  // If the request looks like a missing static asset (has file extension), return 404 instead of HTML
  const lastSegment = pathname.split('/').pop() ?? ''
  if (lastSegment.includes('.') && !lastSegment.endsWith('.html')) {
    return false
  }

  // SPA fallback to dist/index.html for routes like /training, /bot-run, /settings
  const indexHtml = path.join(distDir, 'index.html')
  if (fs.existsSync(indexHtml)) {
    return sendFileResponse(res, indexHtml, method, false)
  }

  return false
}
