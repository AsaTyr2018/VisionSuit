#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , rawDomain] = process.argv

const usage = () => {
  console.error('Usage: node scripts/add-allowed-host.mjs <domain>')
  process.exit(1)
}

if (!rawDomain) {
  usage()
}

const sanitizeDomain = (input) => {
  const trimmed = input.trim()

  if (!trimmed) {
    throw new Error('Domain cannot be empty.')
  }

  const withoutProtocol = trimmed.replace(/^[a-z]+:\/\//i, '')
  const withoutCredentials = withoutProtocol.includes('@')
    ? withoutProtocol.slice(withoutProtocol.lastIndexOf('@') + 1)
    : withoutProtocol
  const [hostCandidate] = withoutCredentials.split(/[/?#]/, 1)

  if (!hostCandidate) {
    throw new Error('Unable to extract host from input. Provide only a domain or hostname.')
  }

  const hostWithoutPort = hostCandidate.split(':')[0]
  const normalized = hostWithoutPort.trim().toLowerCase()

  if (!normalized) {
    throw new Error('Domain resolves to an empty host after normalization.')
  }

  if (!/^[a-z0-9.-]+$/.test(normalized)) {
    throw new Error(
      `Unsupported host "${normalized}". Only alphanumeric characters, dots, and hyphens are allowed.`,
    )
  }

  return normalized
}

let domain

try {
  domain = sanitizeDomain(rawDomain)
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  usage()
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const allowedHostsPath = resolve(repoRoot, 'frontend', 'allowed-hosts.json')

let existingHosts = []

if (existsSync(allowedHostsPath)) {
  try {
    const fileContent = readFileSync(allowedHostsPath, 'utf8')
    const parsed = fileContent.trim().length > 0 ? JSON.parse(fileContent) : []

    if (Array.isArray(parsed)) {
      existingHosts = parsed
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    } else {
      console.warn(
        `Existing allowed hosts file at ${allowedHostsPath} is not an array. Resetting with sanitized domain only.`,
      )
    }
  } catch (error) {
    console.warn(`Failed to parse existing allowed hosts at ${allowedHostsPath}. Resetting file.`, error)
  }
}

const lowerCaseSet = new Set(existingHosts.map((value) => value.toLowerCase()))

if (lowerCaseSet.has(domain)) {
  console.log(`Domain "${domain}" is already present in frontend/allowed-hosts.json.`)
  process.exit(0)
}

const updatedHosts = [...existingHosts, domain]
updatedHosts.sort((a, b) => a.localeCompare(b))

writeFileSync(allowedHostsPath, `${JSON.stringify(updatedHosts, null, 2)}\n`, 'utf8')

console.log(`Added "${domain}" to ${allowedHostsPath}.`)
console.log('Restart the Vite dev server if it is running to apply the updated allow list.')
