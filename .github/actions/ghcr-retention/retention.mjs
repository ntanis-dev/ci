import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const token = process.env['INPUT_GITHUB-TOKEN'] ?? ''
const repository = process.env.GITHUB_REPOSITORY ?? ''
const commit = process.env.GITHUB_SHA ?? ''
const ref = process.env.GITHUB_REF ?? ''
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const [owner, packageName] = repository.split('/')
const deleteVersions = process.env.INPUT_DELETE === 'true'
const keepLatest = Number(process.env['INPUT_KEEP-LATEST'])
const minimumAgeDays = Number(process.env['INPUT_MINIMUM-AGE-DAYS'])

if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(commit) || !/^refs\/heads\/[A-Za-z0-9._/-]{1,180}$/.test(ref)) throw new Error('Invalid repository identity')
if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(packageName) || !Number.isInteger(keepLatest) || keepLatest < 3 || keepLatest > 50 || !Number.isInteger(minimumAgeDays) || minimumAgeDays < 1 || minimumAgeDays > 90) throw new Error('Invalid retention policy')

const request = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'ntanis-ghcr-retention',
      'x-github-api-version': '2022-11-28',
      ...options.headers
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Request failed: ${response.status} ${await response.text()}`)
  return response
}

const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '')
oidcUrl.searchParams.set('audience', 'https://api.ntanis.dev/ghcr-retention')
const oidcResponse = await fetch(oidcUrl, {
  headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ''}` },
  signal: AbortSignal.timeout(30_000)
})
if (!oidcResponse.ok) throw new Error(`OIDC request failed: ${oidcResponse.status}`)
const oidc = await oidcResponse.json()
if (typeof oidc.value !== 'string') throw new Error('OIDC response did not contain a token')

const protectionResponse = await fetch('https://api.ntanis.dev/v1/ghcr-retention', {
  method: 'POST',
  headers: { authorization: `Bearer ${oidc.value}`, 'content-type': 'application/json' },
  body: JSON.stringify({ commit, ref, repository }),
  signal: AbortSignal.timeout(30_000)
})
if (!protectionResponse.ok) throw new Error(`Hub retention request failed: ${protectionResponse.status} ${await protectionResponse.text()}`)
const protection = await protectionResponse.json()
const expectedImageRepository = `ghcr.io/${repository.toLowerCase()}`
if (protection.imageRepository !== expectedImageRepository || !Array.isArray(protection.protectedDigests) || protection.protectedDigests.length > 128 || protection.protectedDigests.some((digest) => !/^sha256:[0-9a-f]{64}$/.test(digest))) throw new Error('Hub returned an invalid retention policy')

const protectedDigests = new Set(protection.protectedDigests)
const inspect = (digest, depth = 0) => {
  if (depth > 2) return
  let manifest
  try {
    manifest = JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${expectedImageRepository}@${digest}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }))
  } catch (error) {
    throw new Error(`Cannot inspect protected image ${digest}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(manifest.manifests) || manifest.manifests.length > 32) return
  for (const child of manifest.manifests) {
    if (typeof child?.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(child.digest)) throw new Error('Protected image contains an invalid child digest')
    if (protectedDigests.has(child.digest)) continue
    protectedDigests.add(child.digest)
    inspect(child.digest, depth + 1)
  }
}
for (const digest of [...protectedDigests]) inspect(digest)

const repositoryResponse = await request(`${api}/repos/${repository}`)
const repositoryMetadata = await repositoryResponse.json()
const ownerType = repositoryMetadata?.owner?.type
if (ownerType !== 'User' && ownerType !== 'Organization') throw new Error('Unsupported package owner type')
const scope = ownerType === 'Organization' ? 'orgs' : 'users'
const packagePath = encodeURIComponent(packageName)
const versions = []
for (let page = 1; page <= 20; page += 1) {
  const response = await request(`${api}/${scope}/${encodeURIComponent(owner)}/packages/container/${packagePath}/versions?per_page=100&page=${page}`)
  const batch = await response.json()
  if (!Array.isArray(batch)) throw new Error('GitHub returned invalid package versions')
  versions.push(...batch)
  if (batch.length < 100) break
  if (page === 20) throw new Error('Package version inventory exceeds the safety limit')
}

const normalized = versions.map((version) => {
  const createdAt = Date.parse(version?.created_at)
  const tags = version?.metadata?.container?.tags
  if (!Number.isSafeInteger(version?.id) || !/^sha256:[0-9a-f]{64}$/.test(version?.name) || !Number.isFinite(createdAt) || !Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) throw new Error('GitHub returned malformed package metadata')
  return { createdAt, digest: version.name, id: version.id, tags }
}).sort((left, right) => right.createdAt - left.createdAt)

const cutoff = Date.now() - minimumAgeDays * 24 * 60 * 60 * 1_000
const candidates = normalized.filter((version, index) => {
  if (index < keepLatest || version.createdAt >= cutoff || protectedDigests.has(version.digest)) return false
  // Human release/channel tags are retention anchors. Commit-addressed tags and
  // untagged build manifests are prunable once they pass the other gates.
  return version.tags.every((tag) => /^[0-9a-f]{40}$/.test(tag))
})
if (candidates.length > 100) throw new Error('More than 100 package versions are eligible; reduce them in bounded runs')

for (const version of candidates) {
  const label = `${version.digest}${version.tags.length ? ` (${version.tags.join(', ')})` : ''}`
  if (!deleteVersions) {
    process.stdout.write(`Would delete ${label}\n`)
    continue
  }
  await request(`${api}/${scope}/${encodeURIComponent(owner)}/packages/container/${packagePath}/versions/${version.id}`, { method: 'DELETE' })
  process.stdout.write(`Deleted ${label}\n`)
}

const summary = [
  '## GHCR retention',
  '',
  `- Package: \`${expectedImageRepository}\``,
  `- Mode: ${deleteVersions ? 'delete' : 'dry run'}`,
  `- Versions inspected: ${normalized.length}`,
  `- Protected deployment/manifest digests: ${protectedDigests.size}`,
  `- Versions eligible: ${candidates.length}`,
  `- Policy: newest ${keepLatest}, younger than ${minimumAgeDays} days, and non-commit tags retained`
].join('\n')
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
process.stdout.write(`${summary}\n`)
