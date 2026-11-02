// Weekly dependency maintenance helpers. Every change stays inside the two-week release age: matured exceptions are
// dropped, and packages are updated only through pnpm, whose own minimumReleaseAge decides what may enter the lockfile.
//   exemptions --root <dir> --report <file>    drop minimumReleaseAgeExclude entries that are two weeks old
//   overrides --result <scan.json> --root <dir> --report <file>  move overrides that pin a vulnerable version
//   packages --result <scan.json> --report <file>  print the npm packages whose mature fix is not applied
//   message --report <file> --after <scan.json>    print the commit message for what changed
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RELEASE_AGE_DAYS, registryPublishedAt } from '../dependency-gate/gate.mjs'

const DAY = 864e5
const ENTRY = /^(\s*-\s*)'([^']+)'(?:\s*#\s*security-expires:\s*(\d{4}-\d{2}-\d{2}))?\s*$/
const PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i

const splitSelector = (selector) => {
  const at = selector.lastIndexOf('@')
  return at > 0 ? { name: selector.slice(0, at), version: selector.slice(at + 1) } : null
}

export async function dropMaturedExemptions(source, { now = new Date(), publishedAt = registryPublishedAt } = {}) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:\s*$/.test(line))
  if (start < 0) return { source, removed: [] }
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end += 1
  while (end > start + 1 && lines[end - 1] === '') end -= 1
  // Each comment block describes the entries that follow it, up to the next comment block.
  const groups = []
  for (const line of lines.slice(start + 1, end)) {
    const comment = /^\s*#/.test(line)
    if (comment && (!groups.length || groups.at(-1).entries.length)) groups.push({ comments: [line], entries: [] })
    else if (comment) groups.at(-1).comments.push(line)
    else {
      if (!groups.length) groups.push({ comments: [], entries: [] })
      groups.at(-1).entries.push(line)
    }
  }
  const today = now.toISOString().slice(0, 10)
  const removed = []
  const kept = []
  for (const group of groups) {
    const entries = []
    for (const line of group.entries) {
      const match = ENTRY.exec(line)
      const selector = match && splitSelector(match[2])
      let mature = false
      if (match?.[3]) mature = match[3] <= today
      else if (selector) {
        const date = await publishedAt('npm', selector.name, selector.version)
        mature = Boolean(date) && date.getTime() + RELEASE_AGE_DAYS * DAY <= now.getTime()
      }
      if (mature) removed.push(match[2])
      else entries.push(line)
    }
    if (entries.length) kept.push(...group.comments, ...entries)
  }
  if (!removed.length) return { source, removed }
  let head = lines.slice(0, start)
  let block = ['minimumReleaseAgeExclude:', ...kept]
  if (!kept.length) {
    // Without entries the key goes too, with the comment directly above it when that comment is about the exceptions.
    let above = head.length
    while (above > 0 && /^#/.test(head[above - 1])) above -= 1
    if (head.slice(above).some((line) => /exception/i.test(line))) head = head.slice(0, above)
    block = []
  }
  return { source: [...head, ...block, ...lines.slice(end)].join(eol), removed }
}

// An existing override that pins the vulnerable version moves to the mature fix of the same major, since pnpm update
// cannot move past it. Overrides are never added, and a fix in another major is left for a decision.
export function retargetOverrides(source, result) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^overrides:\s*$/.test(line))
  const retargeted = []
  if (start < 0) return { source, retargeted }
  const fixes = (result?.findings ?? []).filter((item) => item.status === 'action' && item.fix && String(item.ecosystem).split(':')[0] === 'npm')
  for (let index = start + 1; index < lines.length && (lines[index] === '' || /^\s/.test(lines[index])); index += 1) {
    const match = /^(\s+)('?)([^':\s][^':]*?)\2:\s*('?)([^'\s#]+)\4(\s*(?:#.*)?)$/.exec(lines[index])
    if (!match) continue
    const [, indent, keyQuote, key, valueQuote, target, rest] = match
    const name = key.lastIndexOf('@') > 0 ? key.slice(0, key.lastIndexOf('@')) : key
    const finding = fixes.find((item) => item.package === name && item.version === target)
    if (!finding || finding.fix.replace(/^v/, '').split('.')[0] !== target.split('.')[0]) continue
    lines[index] = `${indent}${keyQuote}${key}${keyQuote}: ${valueQuote}${finding.fix}${valueQuote}${rest}`
    retargeted.push({ override: key, from: target, to: finding.fix, package: name })
  }
  return { source: lines.join(eol), retargeted }
}

export function packagesToUpdate(result) {
  const names = new Set()
  for (const finding of result?.findings ?? []) {
    if (finding.status !== 'action' || String(finding.ecosystem).split(':')[0] !== 'npm') continue
    if (!/(^|\/)pnpm-lock\.yaml$/.test(finding.source) || !PACKAGE_NAME.test(finding.package)) continue
    names.add(finding.package)
  }
  return [...names].sort()
}

export function commitMessage(report, after) {
  const lines = []
  if (report.retargeted?.length) lines.push(`- Move ${report.retargeted.map((item) => `the ${item.override} override from ${item.from} to ${item.to}`).join(', ')}: the overridden version has an advisory and the fix is two weeks old.`)
  if (report.updated?.length) lines.push(`- Update ${report.updated.join(', ')} to the newest releases their declared ranges allow that are two weeks old, which carry the fixes the dependency scan reported.`)
  if (report.removed?.length) lines.push(`- Drop the release-age exceptions that are now two weeks old: ${report.removed.join(', ')}. The frozen install accepts them without one.`)
  if (report.notices) lines.push('- Regenerate the third-party notices for the new lockfile.')
  const open = (after?.findings ?? []).filter((item) => item.status !== 'accepted')
  if (open.length) lines.push(`- Still open after this change: ${open.filter((item) => item.status === 'waiting').length} waiting for the release age, ${open.filter((item) => item.status !== 'waiting').length} needing action or a decision.`)
  const wrap = (text) => text.replace(/(.{1,76})(\s+|$)/g, '$1\n').trimEnd().split('\n').map((line, index) => (index ? `  ${line}` : line)).join('\n')
  return `Apply mature dependency fixes\n\n${lines.map(wrap).join('\n')}\n`
}

const readJson = (path, fallback) => (path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback)

async function main() {
  const [command] = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name)
    return index < 0 ? fallback : process.argv[index + 1]
  }
  const reportPath = option('--report')
  const report = readJson(reportPath, { updated: [], removed: [], notices: false })
  if (command === 'exemptions') {
    const path = resolve(option('--root', '.'), 'pnpm-workspace.yaml')
    const result = await dropMaturedExemptions(readFileSync(path, 'utf8'))
    if (result.removed.length) writeFileSync(path, result.source)
    report.removed = result.removed
    console.log(result.removed.length ? `Dropped matured release-age exceptions: ${result.removed.join(', ')}` : 'No release-age exception has matured.')
  } else if (command === 'overrides') {
    const path = resolve(option('--root', '.'), 'pnpm-workspace.yaml')
    const result = retargetOverrides(readFileSync(path, 'utf8'), readJson(option('--result'), {}))
    if (result.retargeted.length) writeFileSync(path, result.source)
    report.retargeted = result.retargeted
    process.stdout.write(result.retargeted.length ? 'changed' : '')
  } else if (command === 'packages') {
    const retargeted = new Set((report.retargeted ?? []).map((item) => item.package))
    report.updated = packagesToUpdate(readJson(option('--result'), {})).filter((name) => !retargeted.has(name))
    process.stdout.write(report.updated.join(' '))
  } else if (command === 'notices') {
    report.notices = true
  } else if (command === 'message') {
    process.stdout.write(commitMessage(report, readJson(option('--after'), {})))
    return
  } else throw new Error(`unknown command ${command}`)
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
