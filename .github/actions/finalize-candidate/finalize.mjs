const api = 'https://api.ntanis.dev/v1/releases/candidates'
const audience = 'https://api.ntanis.dev/project-releases'
const input = (name) => process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`]?.trim() ?? ''
const project = input('project')
const commit = (process.env.GITHUB_SHA ?? '').toLowerCase()
if (!/^[a-z][a-z0-9-]{1,31}$/.test(project) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release inputs.')

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

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
let last
for (let attempt = 0; attempt < 4; attempt += 1) {
  const token = await oidcToken()
  const response = await fetch(`${api}/${encodeURIComponent(project)}/finalize`, {
    method: 'POST', body: JSON.stringify({ commit }), signal: AbortSignal.timeout(90_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  })
  if (response.ok) {
    const body = await response.json()
    if (!body?.candidate?.id || body.candidate.status !== 'ready') throw new Error('Hub returned an invalid finalization response.')
    process.stdout.write(`Candidate ${body.candidate.id} is complete and ready for owner review.\n`)
    process.exit(0)
  }
  const detail = await response.text()
  last = { detail, status: response.status }
  if (![401, 408, 429].includes(response.status) && response.status < 500) throw new Error(`Hub rejected finalization: ${response.status} ${detail}`)
  await delay(1000 * 2 ** attempt)
}
throw new Error(`Hub finalization failed: ${last?.status ?? 'network'} ${last?.detail ?? ''}`)
