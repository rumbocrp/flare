import http from 'node:http'
import {
  ensureBackgroundWorker,
  handleBotApiRequest,
  stopBackgroundWorker,
} from './botRuntime'

const PORT = Number(process.env.PORT ?? 3001)

ensureBackgroundWorker()

const server = http.createServer(
  async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const handled = await handleBotApiRequest(req, res)
      if (!handled) {
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ error: 'Route not found' }))
      }
    } catch (error) {
      console.error('[FLARE Backend] Unhandled HTTP request error:', error)
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  },
)

// TCP keep-alive optimizations for low-latency streaming
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

server.listen(PORT, () => {
  console.log(
    `[FLARE Backend] Optimized server listening on http://localhost:${PORT}`,
  )
})

function gracefulShutdown(signal: string): void {
  console.log(`[FLARE Backend] Received ${signal}, shutting down...`)
  stopBackgroundWorker()
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
