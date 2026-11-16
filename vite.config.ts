import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type BotRuntimeModule = {
  handleBotApiRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>
}

function flareBackendPlugin(): Plugin {
  return {
    name: 'flare-backend-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith('/api/')) {
          try {
            const mod = (await server.ssrLoadModule(
              '/src/server/botRuntime.ts',
            )) as BotRuntimeModule
            const handled = await mod.handleBotApiRequest(req, res)
            if (handled) return
          } catch (err) {
            console.error('[FLARE Vite Backend Middleware Error]', err)
          }
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react(), flareBackendPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
