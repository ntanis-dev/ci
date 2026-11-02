// One weekly view of every repository's dependency scan and maintenance, read with the caller's own gh login.
// usage: node scripts/dependency-summary.mjs [--owners ntanis-dev,primed-sh,criticalscripts-shop] [--out summary.md]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const owners = option('--owners', 'ntanis-dev,primed-sh,criticalscripts-shop').split(',')
const gh = (...args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  return result.status === 0 ? result.stdout : null
}
const json = (...args) => {
  const output = gh(...args)
  return output ? JSON.parse(output) : null
}
const latestRun = (repository, workflow) => json('api', `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=1`)?.workflow_runs?.[0] ?? null
const scratch = mkdtempSync(join(tmpdir(), 'dependency-summary-'))
const artifact = (repository, run, name, file) => {
  const directory = join(scratch, `${repository.replace('/', '_')}-${run.id}-${name}`)
  if (gh('run', 'download', String(run.id), '-R', repository, '-n', name, '-D', directory) === null) return null
  const path = join(directory, file)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

const week = Date.now() - 7 * 864e5
const needs = new Map()
const waiting = new Map()
const expiring = new Map()
const fixed = []
const broken = []
const notMigrated = []
const add = (map, key, value, repository) => {
  if (!map.has(key)) map.set(key, { ...value, repositories: new Set() })
  map.get(key).repositories.add(repository)
}
const advisory = (finding) => finding.ids.find((id) => /^(GHSA|CVE|GO|RUSTSEC|PYSEC)-/.test(id)) ?? finding.ids[0]

for (const owner of owners) {
  for (const { nameWithOwner: repository } of json('repo', 'list', owner, '--limit', '300', '--no-archived', '--json', 'nameWithOwner') ?? []) {
    const scan = latestRun(repository, 'osv-scanner.yml')
    if (scan) {
      const result = artifact(repository, scan, 'dependency-scan', 'dependency-scan.json')
      if (!result) {
        notMigrated.push(repository)
        if (scan.conclusion !== 'success') broken.push(`${repository}: dependency scan ${scan.conclusion} without a classification (${scan.html_url})`)
      } else {
        for (const finding of result.findings) {
          const key = `${finding.package}|${advisory(finding)}`
          if (['action', 'decision'].includes(finding.status)) add(needs, key, { package: finding.package, advisory: advisory(finding), severity: finding.severity, reason: finding.reason }, repository)
          else if (finding.status === 'waiting') add(waiting, key, { package: finding.package, advisory: advisory(finding), fix: finding.fix, landsOn: finding.landsOn }, repository)
          else if (finding.status === 'accepted' && Date.parse(finding.until) - Date.now() < 14 * 864e5) add(expiring, key, { package: finding.package, advisory: advisory(finding), until: finding.until }, repository)
        }
      }
    }
    const maintenance = latestRun(repository, 'dependency-maintenance.yml')
    if (maintenance) {
      if (maintenance.conclusion !== 'success') broken.push(`${repository}: dependency maintenance ${maintenance.conclusion} (${maintenance.html_url})`)
      const report = artifact(repository, maintenance, 'dependency-maintenance', 'maintenance.json')
      if (report && Date.parse(maintenance.created_at) > week && (report.updated?.length || report.removed?.length)) fixed.push({ repository, ...report })
    }
  }
}
rmSync(scratch, { recursive: true, force: true })

const list = (set) => [...set].sort().join(', ')
const lines = [`# Dependency summary, ${new Date().toISOString().slice(0, 10)}`, '']
lines.push(`## Needs you (${needs.size + broken.length})`, '')
if (!needs.size && !broken.length) lines.push('Nothing.', '')
for (const item of [...needs.values()].sort((a, b) => a.package.localeCompare(b.package))) lines.push(`- **${item.package}** ${item.advisory} (${item.severity}): ${item.reason}. ${list(item.repositories)}`)
for (const item of broken) lines.push(`- ${item}`)
lines.push('', `## Fixed this week (${fixed.length})`, '')
for (const item of fixed) lines.push(`- ${item.repository}: ${[item.updated?.length ? `updated ${item.updated.join(', ')}` : '', item.removed?.length ? `dropped ${item.removed.length} matured exceptions` : ''].filter(Boolean).join('; ')}`)
lines.push('', `## Waiting for the release age (${waiting.size})`, '')
for (const item of [...waiting.values()].sort((a, b) => String(a.landsOn).localeCompare(String(b.landsOn)))) lines.push(`- ${item.landsOn}: **${item.package}** ${item.fix} (${item.advisory}). ${list(item.repositories)}`)
if (expiring.size) {
  lines.push('', `## Acceptances expiring within two weeks (${expiring.size})`, '')
  for (const item of expiring.values()) lines.push(`- **${item.package}** ${item.advisory} until ${item.until}. ${list(item.repositories)}`)
}
if (notMigrated.length) lines.push('', `## Scans not on the central gate yet (${notMigrated.length})`, '', `- ${notMigrated.sort().join(', ')}`)
const markdown = `${lines.join('\n')}\n`
const out = option('--out')
if (out) writeFileSync(out, markdown)
process.stdout.write(markdown)
