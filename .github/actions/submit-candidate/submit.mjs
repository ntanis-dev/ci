import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'

const audience = 'https://api.ntanis.dev/project-releases'
const maximumFiles = 24
const maximumFileBytes = 536_870_912
const maximumCandidateBytes = 1_073_741_824
const input = (name) => process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`]?.trim() ?? ''
const project = input('project')
const version = input('version')
const platform = input('platform')
const architecture = input('architecture')
const platformSigned = input('platform-signed') === 'true'
const includeExtensions = new Set(input('include-extensions').split(',').map((value) => value.trim().toLowerCase()).filter((value) => /^[a-z0-9]{1,24}$/.test(value)))
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
const artifactDirectory = resolve(workspace, input('artifact-directory'))
const relation = relative(workspace, artifactDirectory)
if (!/^[a-z][a-z0-9-]{1,31}$/.test(project) || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(platform) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(architecture) || !includeExtensions.size) throw new Error('Invalid release inputs.')
if (!relation || relation.startsWith('..') || resolve(workspace, relation) !== artifactDirectory) throw new Error('Artifact directory must be a contained repository directory.')

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not accepted: ${relative(workspace, path)}`)
    if (info.isDirectory()) result.push(...await files(path))
    else if (info.isFile() && includeExtensions.has(extname(entry.name).slice(1).toLowerCase())) result.push({ path, size: info.size })
  }
  return result
}

const artifacts = await files(artifactDirectory)
if (!artifacts.length || artifacts.length > maximumFiles) throw new Error(`Expected 1-${maximumFiles} release files.`)
if (new Set(artifacts.map((file) => basename(file.path))).size !== artifacts.length) throw new Error('Release file names must be unique across the candidate.')
if (artifacts.some((file) => file.size < 1 || file.size > maximumFileBytes) || artifacts.reduce((sum, file) => sum + file.size, 0) > maximumCandidateBytes) throw new Error('Release candidate exceeds the storage limit.')

async function oidcToken() {
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!endpoint || !bearer) throw new Error('GitHub OIDC is unavailable.')
  const url = new URL(endpoint)
  url.searchParams.set('audience', audience)
  const response = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })
  const body = await response.json()
  if (!response.ok || typeof body.value !== 'string') throw new Error('Could not obtain GitHub OIDC identity.')
  return body.value
}

for (const artifact of artifacts) {
  const name = basename(artifact.path)
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/.test(name)) throw new Error(`Unsafe artifact file name: ${name}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(artifact.path)) hash.update(chunk)
  const token = await oidcToken()
  const response = await fetch(`https://api.ntanis.dev/v1/releases/candidates/${encodeURIComponent(project)}/artifacts`, {
    method: 'POST', duplex: 'half', body: createReadStream(artifact.path), headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream',
      'x-ntanis-commit': process.env.GITHUB_SHA ?? '', 'x-ntanis-file-name': name,
      'x-ntanis-version': version, 'x-ntanis-platform': platform, 'x-ntanis-architecture': architecture,
      'x-ntanis-format': extname(name).slice(1).toLowerCase() || 'binary', 'x-ntanis-size': String(artifact.size),
      'x-ntanis-sha256': hash.digest('hex'), 'x-ntanis-platform-signed': String(platformSigned)
    }
  })
  if (!response.ok) throw new Error(`Hub rejected ${name}: ${response.status} ${await response.text()}`)
  process.stdout.write(`Submitted ${name} (${artifact.size} bytes).\n`)
}
