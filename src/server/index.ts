import http from 'node:http'
import { resolveCorsHeaders } from './auth'
import {
  ensureBackgroundWorker,
  handleBotApiRequest,
  shutdownRuntime,
} from './botRuntime'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST?.trim() || '127.0.0.1'

ensureBackgroundWorker()

const server = http.createServer(
  async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const cors = resolveCorsHeaders(req)
    try {
      const handled = await handleBotApiRequest(req, res)
      if (!handled) {
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          ...cors.headers,
        })
        res.end(JSON.stringify({ error: 'Route not found' }))
      }
    } catch (error) {
      console.error('[FLARE Backend] Unhandled HTTP request error:', error)
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          ...cors.headers,
        })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  },
)

// TCP keep-alive optimizations for low-latency streaming
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

server.listen(PORT, HOST, () => {
  console.log(
    `[FLARE Backend] Hardened server listening on http://${HOST}:${PORT}`,
  )
})

function gracefulShutdown(signal: string): void {
  console.log(`[FLARE Backend] Received ${signal}, shutting down...`)
  void shutdownRuntime().finally(() => {
    server.close(() => {
      process.exit(0)
    })
  })
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
