import { createHash, webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type ProxyOptions, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'

type SupportedDataView =
  | ArrayBuffer
  | DataView
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array
  | Buffer

type HashCapableCrypto = typeof webcrypto & {
  hash?: (
    algorithm: string | { name?: string },
    data: SupportedDataView | string,
  ) => Promise<ArrayBuffer> | ArrayBuffer | Buffer | string
}

const ensureNodeCryptoHashPolyfill = () => {
  const globalScope = globalThis as typeof globalThis & { crypto?: HashCapableCrypto }
  const cryptoGlobal = (globalScope.crypto ?? (webcrypto as unknown)) as HashCapableCrypto | undefined

  if (!cryptoGlobal) {
    return
  }

  if (typeof cryptoGlobal.hash !== 'function') {
    const normalizeAlgorithm = (algorithm: string | { name?: string }) => {
      if (typeof algorithm === 'string') {
        return algorithm.trim().toUpperCase()
      }

      if (algorithm && typeof algorithm === 'object' && 'name' in algorithm && algorithm.name) {
        return String(algorithm.name).trim().toUpperCase()
      }

      throw new TypeError('Unsupported algorithm supplied to crypto.hash polyfill')
    }

    const toBuffer = (data: SupportedDataView | string) => {
      if (typeof data === 'string') {
        return Buffer.from(data)
      }

      if (data instanceof ArrayBuffer) {
        return Buffer.from(data)
      }

      if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      }

      throw new TypeError('Unsupported data supplied to crypto.hash polyfill')
    }

    cryptoGlobal.hash = async (algorithm: string | { name?: string }, data: SupportedDataView | string) => {
      const normalized = normalizeAlgorithm(algorithm)

      const mappedAlgorithm = (() => {
        switch (normalized) {
          case 'SHA-1':
            return 'sha1'
          case 'SHA-256':
            return 'sha256'
          case 'SHA-384':
            return 'sha384'
          case 'SHA-512':
            return 'sha512'
          default:
            throw new TypeError(`Unsupported algorithm: ${normalized}`)
        }
      })()

      const digest = createHash(mappedAlgorithm).update(toBuffer(data)).digest()
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength)
    }
  }

  if (!globalScope.crypto) {
    globalScope.crypto = cryptoGlobal
  }
}

ensureNodeCryptoHashPolyfill()

const parsePort = (value?: string) => {
  if (!value) {
    return 5173
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? 5173 : parsed
}

const loadAllowedHosts = () => {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const configPath = resolve(currentDir, 'allowed-hosts.json')

  if (!existsSync(configPath)) {
    return [] as string[]
  }

  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)

    if (!Array.isArray(parsed)) {
      console.warn(
        `Expected an array in ${configPath} but received ${typeof parsed}. Ignoring custom allowed hosts.`,
      )
      return []
    }

    const normalized = parsed
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value): value is string => value.length > 0)

    const unique = Array.from(new Set(normalized))
    return unique
  } catch (error) {
    console.warn(`Failed to read custom allowed hosts from ${configPath}:`, error)
    return []
  }
}

const allowedHosts = loadAllowedHosts()

const resolveApiProxy = (env: Record<string, string>) => {
  const rawApiUrl = env.VITE_API_URL?.trim() ?? process.env.VITE_API_URL?.trim() ?? ''
  const normalizedApiUrl = rawApiUrl.trim()

  const sameOriginTokens = new Set(['', '/', '@origin', 'origin', 'same-origin', 'relative'])
  const useSameOrigin = sameOriginTokens.has(normalizedApiUrl.toLowerCase())
  const isAbsolute = /^https?:\/\//i.test(normalizedApiUrl)
  const isRelative = !isAbsolute && normalizedApiUrl.length > 0 && !useSameOrigin

  if (!useSameOrigin && !isRelative) {
    return undefined
  }

  const proxyTarget = env.DEV_API_PROXY_TARGET?.trim() ?? process.env.DEV_API_PROXY_TARGET?.trim() ?? 'http://127.0.0.1:4000'

  const proxyKey = (() => {
    if (useSameOrigin || normalizedApiUrl.length === 0) {
      return '/api'
    }

    if (normalizedApiUrl.startsWith('/')) {
      return normalizedApiUrl.replace(/\/$/, '') || '/api'
    }

    return `/${normalizedApiUrl.replace(/\/$/, '')}`
  })()

  return {
    [proxyKey]: {
      target: proxyTarget,
      changeOrigin: true,
    } satisfies ProxyOptions,
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxy = resolveApiProxy(env)

  const serverConfig: UserConfig['server'] = {
    host: '0.0.0.0',
    port: parsePort(env.FRONTEND_PORT ?? process.env.FRONTEND_PORT),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(proxy ? { proxy } : {}),
  }

  return {
    plugins: [react()],
    server: serverConfig,
  }
})
