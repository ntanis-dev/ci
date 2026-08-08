import { createHash } from 'node:crypto'
import { open, lstat, readdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'

const api = 'https://api.ntanis.dev/v1/releases/candidates'
const audience = 'https://api.ntanis.dev/project-releases'
const chunkBytes = 8 * 1024 * 1024
const chunkConcurrency = 4
const maximumFiles = 24
const maximumFileBytes = 1024 * 1024 * 1024
const maximumCandidateBytes = 4 * 1024 * 1024 * 1024
const input = (name) => process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`]?.trim() ?? ''
const project = input('project')
const version = input('version')
const commit = (process.env.GITHUB_SHA ?? '').toLowerCase()
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
const artifactDirectory = resolve(workspace, input('artifact-directory'))
const relation = relative(workspace, artifactDirectory)

if (!/^[a-z][a-z0-9-]{1,31}$/.test(project) || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release inputs.')
if (!relation || relation.startsWith('..') || resolve(workspace, relation) !== artifactDirectory) throw new Error('Artifact directory must be contained by the workspace.')

let matrix
try { matrix = JSON.parse(input('build-matrix')) } catch { throw new Error('Build matrix is not valid JSON.') }
if (!Array.isArray(matrix) || matrix.length < 1 || matrix.length > 8) throw new Error('Build matrix must contain 1-8 targets.')

function target(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid build matrix target.')
  const platform = String(value.platform ?? '').toLowerCase()
  const architecture = String(value.architecture ?? '').toLowerCase()
  const platformSigned = value.platformSigned === true
  const formats = String(value.includeExtensions ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  const includeFiles = String(value.includeFiles ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(platform) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(architecture) || formats.length < 1 || formats.length > 8 || formats.some((item) => !/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(item)) || new Set(formats).size !== formats.length) throw new Error('Invalid build matrix target.')
  if (includeFiles.length < 1 || includeFiles.length > 16 || includeFiles.some((item) => !/^[A-Za-z0-9*][A-Za-z0-9._+*-]{0,159}$/.test(item))) throw new Error('Each build target must declare 1-16 safe includeFiles patterns.')
  return { architecture, formats, includeFiles, platform, platformSigned }
}

const targets = matrix.map(target)
if (new Set(targets.map((item) => `${item.platform}:${item.architecture}`)).size !== targets.length) throw new Error('Build matrix target keys must be unique.')

function matches(pattern, name) {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${source}$`, 'i').test(name)
}

async function files(directory, formats, patterns) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not accepted: ${relative(workspace, path)}`)
    if (info.isFile() && formats.has(extname(entry.name).slice(1).toLowerCase()) && patterns.some((pattern) => matches(pattern, entry.name))) result.push({ path, size: info.size })
  }
  return result
}

const artifacts = []
for (const item of targets) {
  const formats = new Set(item.formats)
  const directory = targets.length === 1 ? artifactDirectory : resolve(artifactDirectory, `candidate-${item.platform}-${item.architecture}`)
  const relation = relative(artifactDirectory, directory)
  if (relation.startsWith('..') || resolve(artifactDirectory, relation) !== directory) throw new Error('Unsafe candidate target path.')
  const found = await files(directory, formats, item.includeFiles)
  for (const format of formats) if (!found.some((file) => extname(file.path).slice(1).toLowerCase() === format)) throw new Error(`Missing required ${item.platform}/${item.architecture} .${format} artifact.`)
  for (const file of found) {
    const fileName = basename(file.path)
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/.test(fileName)) throw new Error(`Unsafe artifact file name: ${fileName}`)
    const handle = await open(file.path, 'r')
    const hash = createHash('sha256')
    try {
      const buffer = Buffer.allocUnsafe(chunkBytes)
      for (let position = 0; position < file.size; position += chunkBytes) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, file.size - position), position)
        hash.update(buffer.subarray(0, bytesRead))
      }
    } finally { await handle.close() }
    artifacts.push({
      architecture: item.architecture, chunkCount: Math.ceil(file.size / chunkBytes), fileName,
      format: extname(fileName).slice(1).toLowerCase(), path: file.path, platform: item.platform,
      platformSigned: item.platformSigned, sha256: hash.digest('hex'), sizeBytes: file.size
    })
  }
}

if (!artifacts.length || artifacts.length > maximumFiles) throw new Error(`Expected 1-${maximumFiles} release files.`)
if (new Set(artifacts.map((file) => `${file.platform}:${file.architecture}:${file.fileName}`)).size !== artifacts.length) throw new Error('Release file names must be unique within a target.')
if (artifacts.some((file) => file.sizeBytes < 1 || file.sizeBytes > maximumFileBytes) || artifacts.reduce((sum, file) => sum + file.sizeBytes, 0) > maximumCandidateBytes) throw new Error('Release candidate exceeds the storage limit.')

let cachedToken
let cachedExpiry = 0
async function oidcToken(force = false) {
  if (!force && cachedToken && Date.now() < cachedExpiry - 60_000) return cachedToken
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!endpoint || !bearer) throw new Error('GitHub OIDC is unavailable.')
  const url = new URL(endpoint)
  url.searchParams.set('audience', audience)
  const response = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })
  const body = await response.json()
  if (!response.ok || typeof body.value !== 'string') throw new Error('Could not obtain GitHub OIDC identity.')
  cachedToken = body.value
  try { cachedExpiry = Number(JSON.parse(Buffer.from(body.value.split('.')[1], 'base64url').toString()).exp) * 1000 } catch { cachedExpiry = Date.now() + 240_000 }
  return cachedToken
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
async function hub(path, options = {}) {
  let last
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const token = await oidcToken(attempt > 0 && last?.status === 401)
      const response = await fetch(`${api}/${encodeURIComponent(project)}${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(90_000), headers: { ...options.headers, authorization: `Bearer ${token}` } })
      if (response.ok) return response
      const detail = await response.text()
      last = { status: response.status, detail }
      if (response.status !== 401 && response.status !== 408 && response.status !== 429 && response.status < 500) throw new Error(`Hub rejected request: ${response.status} ${detail}`)
    } catch (error) {
      if (attempt === 3) throw error
      if (last && last.status < 500 && ![401, 408, 429].includes(last.status)) throw error
    }
    await delay(1000 * 2 ** attempt)
  }
  throw new Error(`Hub request failed: ${last?.status ?? 'network'} ${last?.detail ?? ''}`)
}

const manifest = { commit, version, artifacts: artifacts.map(({ path: _path, ...artifact }) => artifact) }
const manifestResponse = await hub('/manifest', { method: 'POST', body: JSON.stringify(manifest), headers: { 'content-type': 'application/json' } })
const candidate = await manifestResponse.json()
if (!candidate?.candidateId || !Array.isArray(candidate.artifacts)) throw new Error('Hub returned an invalid candidate response.')
if (candidate.status === 'ready') {
  process.stdout.write(`Candidate ${candidate.candidateId} is already complete.\n`)
  process.exit(0)
}

for (const local of artifacts) {
  const remote = candidate.artifacts.find((item) => item.platform === local.platform && item.architecture === local.architecture && item.fileName === local.fileName && item.sha256 === local.sha256 && Number(item.sizeBytes) === local.sizeBytes)
  if (!remote?.id) throw new Error(`Hub manifest mapping is missing ${local.fileName}.`)
  if (remote.uploaded) continue
  const handle = await open(local.path, 'r')
  try {
    for (let first = 0; first < local.chunkCount; first += chunkConcurrency) {
      const requests = []
      for (let index = first; index < Math.min(first + chunkConcurrency, local.chunkCount); index += 1) {
        const position = index * chunkBytes
        const body = Buffer.allocUnsafe(Math.min(chunkBytes, local.sizeBytes - position))
        const { bytesRead } = await handle.read(body, 0, body.length, position)
        if (bytesRead !== body.length) throw new Error(`Could not read complete chunk ${index} for ${local.fileName}.`)
        const chunkSha256 = createHash('sha256').update(body).digest('hex')
        requests.push(hub(`/${candidate.candidateId}/artifacts/${remote.id}/chunks/${index}`, {
          method: 'PUT', body, headers: { 'content-type': 'application/octet-stream', 'x-ntanis-commit': commit, 'x-ntanis-chunk-size': String(bytesRead), 'x-ntanis-chunk-sha256': chunkSha256 }
        }))
      }
      await Promise.all(requests)
    }
  } finally { await handle.close() }
  await hub(`/${candidate.candidateId}/artifacts/${remote.id}/complete`, { method: 'POST', body: JSON.stringify({ commit, chunkCount: local.chunkCount }), headers: { 'content-type': 'application/json' } })
  process.stdout.write(`Verified ${local.fileName} (${local.sizeBytes} bytes).\n`)
}

await hub(`/${candidate.candidateId}/finalize`, { method: 'POST', body: JSON.stringify({ commit }), headers: { 'content-type': 'application/json' } })
process.stdout.write(`Candidate ${candidate.candidateId} is complete and ready for review.\n`)
