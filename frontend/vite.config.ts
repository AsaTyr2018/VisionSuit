import { createHash, webcrypto } from 'node:crypto'
import { defineConfig } from 'vite'
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

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: parsePort(process.env.FRONTEND_PORT),
  },
})
