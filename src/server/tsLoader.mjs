import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const TS_CANDIDATE_SUFFIXES = [
  '.ts',
  '.tsx',
  '.mts',
  `${path.sep}index.ts`,
  `${path.sep}index.tsx`,
]

function tryResolveTsFile(basePath) {
  for (const suffix of TS_CANDIDATE_SUFFIXES) {
    const candidate = `${basePath}${suffix}`
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return pathToFileURL(candidate).href
    }
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined
      if (
        code !== 'ERR_MODULE_NOT_FOUND' &&
        code !== 'ERR_UNSUPPORTED_DIR_IMPORT'
      ) {
        throw err
      }

      let basePath = null
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        if (!context.parentURL || !context.parentURL.startsWith('file:')) {
          throw err
        }
        const parentDir = path.dirname(fileURLToPath(context.parentURL))
        basePath = path.resolve(parentDir, specifier)
      } else if (specifier.startsWith('@/')) {
        basePath = path.resolve(SRC_ROOT, specifier.slice(2))
      }

      if (basePath) {
        const resolvedUrl = tryResolveTsFile(basePath)
        if (resolvedUrl) {
          return nextResolve(resolvedUrl, context)
        }
      }

      throw err
    }
  },
})
