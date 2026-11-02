// Classifies OSV-Scanner findings so a scan fails only when someone has to act:
//   accepted - listed in ntanis-dev/ci accepted-advisories.json and not yet expired
//   waiting  - the fixed release is younger than the two-week release age; it lands on the reported date
//   action   - a fixed release has passed the release age but is not applied
//   decision - no fixed release exists, or an acceptance expired
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RELEASE_AGE_DAYS = 14
export const POLICY_URL = 'https://raw.githubusercontent.com/ntanis-dev/ci/main/accepted-advisories.json'
const DAY = 864e5
const LEVELS = ['low', 'moderate', 'high', 'critical']

export function compareVersions(left, right) {
  const split = (value) => {
    const text = String(value).replace(/^v/, '')
    const dash = text.indexOf('-')
    return { release: (dash < 0 ? text : text.slice(0, dash)).split(/[.+]/), pre: dash < 0 ? '' : text.slice(dash + 1) }
  }
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < Math.max(a.release.length, b.release.length); index += 1) {
    const x = a.release[index] ?? '0'
    const y = b.release[index] ?? '0'
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (x !== y) return x < y ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  return a.pre < b.pre ? -1 : 1
}

const samePackage = (a, b) => String(a.name).toLowerCase() === String(b.name).toLowerCase()
  && String(a.ecosystem ?? '').split(':')[0] === String(b.ecosystem ?? '').split(':')[0]

// The lowest fixed release of the affected range that contains the installed version.
export function fixFor(vulnerability, pkg) {
  const fixes = []
  for (const affected of vulnerability.affected ?? []) {
    if (affected.package && !samePackage(affected.package, pkg)) continue
    for (const range of affected.ranges ?? []) {
      if (!['SEMVER', 'ECOSYSTEM'].includes(range.type)) continue
      let introduced = null
      for (const event of range.events ?? []) {
        if (event.introduced !== undefined) introduced = event.introduced
        else if (event.fixed !== undefined) {
          const inside = introduced !== null && (introduced === '0' || compareVersions(pkg.version, introduced) >= 0)
          if (inside && compareVersions(pkg.version, event.fixed) < 0) fixes.push(event.fixed)
          introduced = null
        } else introduced = null
      }
    }
  }
  return fixes.sort(compareVersions)[0] ?? null
}

export function severityOf(group, vulnerabilities) {
  const named = vulnerabilities.map((item) => String(item.database_specific?.severity ?? '').toLowerCase()).filter((level) => LEVELS.includes(level))
  if (named.length) return named.sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a))[0]
  const score = Number.parseFloat(group?.max_severity)
  if (Number.isFinite(score) && score > 0) return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : 'low'
  return 'unknown'
}

// Unknown severities count as critical, so a missing rating never lets a finding through.
export const meetsThreshold = (severity, threshold) => threshold !== 'none'
  && (severity === 'unknown' ? 3 : LEVELS.indexOf(severity)) >= LEVELS.indexOf(threshold)

const goEscape = (path) => path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)
const published = new Map()
export function registryPublishedAt(ecosystem, name, version, request = fetch) {
  const key = `${ecosystem}|${name}|${version}`
  if (!published.has(key)) published.set(key, lookupPublishedAt(ecosystem, name, version, request).catch(() => null))
  return published.get(key)
}
async function lookupPublishedAt(ecosystem, name, version, request) {
  const json = async (url) => {
    const response = await request(url, { headers: { accept: 'application/json', 'user-agent': 'ntanis-dev-ci-dependency-gate' } })
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    return response.json()
  }
  const base = String(ecosystem).split(':')[0]
  let time
  if (base === 'npm') time = (await json(`https://registry.npmjs.org/${name.replace('/', '%2f')}`)).time?.[version]
  // The go directive and toolchain line are reported as stdlib/toolchain; their releases are toolchain modules.
  else if (base === 'Go' && ['stdlib', 'toolchain'].includes(name)) time = (await json(`https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go${version.replace(/^v/, '')}.linux-amd64.info`)).Time
  else if (base === 'Go') time = (await json(`https://proxy.golang.org/${goEscape(name)}/@v/${version.startsWith('v') ? version : `v${version}`}.info`)).Time
  else if (base === 'PyPI') time = (await json(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`)).urls?.[0]?.upload_time_iso_8601
  else if (base === 'crates.io') time = (await json(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`)).version?.created_at
  const date = time ? new Date(time) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

const relativeSource = (path, root) => {
  const absolute = isAbsolute(String(path)) ? String(path) : resolve(root, String(path))
  return relative(resolve(root), absolute).replaceAll('\\', '/')
}
const excluded = (source, exclude) => exclude.some((prefix) => {
  const clean = prefix.replace(/^\.?\//, '').replace(/\/+$/, '')
  return clean && (source === clean || source.startsWith(`${clean}/`))
})

export async function classify(osv, { policy = { advisories: [] }, now = new Date(), publishedAt = registryPublishedAt, root = '.', exclude = [] } = {}) {
  const today = now.toISOString().slice(0, 10)
  const findings = []
  for (const result of osv?.results ?? []) {
    const source = relativeSource(result.source?.path ?? '', root)
    if (excluded(source, exclude)) continue
    for (const entry of result.packages ?? []) {
      const pkg = entry.package ?? {}
      const vulnerabilities = new Map((entry.vulnerabilities ?? []).map((item) => [item.id, item]))
      const groups = entry.groups?.length ? entry.groups : [...vulnerabilities.keys()].map((id) => ({ ids: [id] }))
      for (const group of groups) {
        const members = (group.ids ?? []).map((id) => vulnerabilities.get(id)).filter(Boolean)
        const ids = [...new Set([...(group.ids ?? []), ...(group.aliases ?? []), ...members.flatMap((item) => item.aliases ?? [])])]
        const fix = members.map((item) => fixFor(item, pkg)).filter(Boolean).sort(compareVersions).at(-1) ?? null
        const finding = { source, ecosystem: pkg.ecosystem, package: pkg.name, version: pkg.version, ids, severity: severityOf(group, members), fix }
        const accepted = (policy.advisories ?? []).find((item) => ids.includes(item.id) && (!item.package || String(item.package).toLowerCase() === String(pkg.name).toLowerCase()))
        if (accepted && accepted.until > today) Object.assign(finding, { status: 'accepted', until: accepted.until, reason: accepted.reason })
        else if (accepted) Object.assign(finding, { status: 'decision', reason: `acceptance expired on ${accepted.until}` })
        else if (!fix) Object.assign(finding, { status: 'decision', reason: 'no fixed release' })
        else {
          const date = await publishedAt(pkg.ecosystem, pkg.name, fix)
          if (!date) Object.assign(finding, { status: 'action', reason: `fixed in ${fix}; its release date could not be checked` })
          else {
            const lands = new Date(date.getTime() + RELEASE_AGE_DAYS * DAY)
            finding.fixPublished = date.toISOString().slice(0, 10)
            if (lands > now) Object.assign(finding, { status: 'waiting', landsOn: `${lands.toISOString().slice(0, 16).replace('T', ' ')} UTC` })
            else Object.assign(finding, { status: 'action', reason: `fixed in ${fix}, released ${finding.fixPublished}` })
          }
        }
        findings.push(finding)
      }
    }
  }
  return findings
}

const cell = (value) => String(value ?? '').replaceAll('|', '\\|')
export function summarize(findings, threshold) {
  const merged = new Map()
  for (const finding of findings) {
    const key = `${finding.status}|${finding.package}@${finding.version}|${finding.ids[0]}`
    if (merged.has(key)) merged.get(key).sources.add(finding.source)
    else merged.set(key, { ...finding, sources: new Set([finding.source]) })
  }
  const rows = [...merged.values()]
  const pick = (status) => rows.filter((row) => row.status === status)
  const failing = rows.filter((row) => ['action', 'decision'].includes(row.status) && meetsThreshold(row.severity, threshold))
  const lines = ['## Dependency scan', '', `${failing.length} to act on, ${pick('waiting').length} waiting for the two-week release age, ${pick('accepted').length} accepted.`, '']
  const table = (title, header, items, render) => {
    if (!items.length) return
    lines.push(`### ${title}`, '', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`)
    for (const item of items) lines.push(`| ${render(item).map(cell).join(' | ')} |`)
    lines.push('')
  }
  const advisory = (row) => row.ids.filter((id) => id.startsWith('GHSA-') || id.startsWith('CVE-') || id.startsWith('GO-') || id.startsWith('RUSTSEC-') || id.startsWith('PYSEC-')).slice(0, 2).join(', ') || row.ids[0]
  table('Needs action or a decision', ['Package', 'Advisory', 'Severity', 'Why', 'Where'], [...pick('action'), ...pick('decision')],
    (row) => [`${row.package} ${row.version}`, advisory(row), row.severity, row.reason, [...row.sources].join(', ')])
  table('Waiting for the release age', ['Package', 'Advisory', 'Severity', 'Fix', 'Lands', 'Where'], pick('waiting'),
    (row) => [`${row.package} ${row.version}`, advisory(row), row.severity, row.fix, row.landsOn, [...row.sources].join(', ')])
  table('Accepted', ['Package', 'Advisory', 'Until', 'Reason'], pick('accepted'),
    (row) => [`${row.package} ${row.version}`, advisory(row), row.until, row.reason])
  return { markdown: lines.join('\n'), failing: failing.length }
}

async function main() {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name)
    return index < 0 ? fallback : process.argv[index + 1]
  }
  const threshold = option('--threshold', 'low')
  if (![...LEVELS, 'none'].includes(threshold)) throw new Error(`--threshold must be one of ${[...LEVELS, 'none'].join(', ')}`)
  const osvPath = option('--osv')
  const osv = osvPath && existsSync(osvPath) ? JSON.parse(readFileSync(osvPath, 'utf8')) : { results: [] }
  const policyFile = option('--policy')
  const policy = policyFile
    ? JSON.parse(readFileSync(policyFile, 'utf8'))
    : await fetch(POLICY_URL, { headers: { 'user-agent': 'ntanis-dev-ci-dependency-gate' } }).then((response) => {
      if (!response.ok) throw new Error(`accepted advisories: HTTP ${response.status}`)
      return response.json()
    })
  const exclude = String(process.env.DEPENDENCY_GATE_EXCLUDE ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const now = option('--now') ? new Date(option('--now')) : new Date()
  const findings = await classify(osv, { policy, now, root: option('--root', '.'), exclude })
  const { markdown, failing } = summarize(findings, threshold)
  const resultPath = option('--result')
  if (resultPath) writeFileSync(resultPath, `${JSON.stringify({ generatedAt: now.toISOString(), repository: process.env.GITHUB_REPOSITORY ?? null, sha: process.env.GITHUB_SHA ?? null, threshold, failing, findings }, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  console.log(markdown)
  if (failing) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(2)
  })
}
