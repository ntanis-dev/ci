import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const root = resolve(option('--root') ?? process.cwd())
const today = option('--date') ?? new Date().toISOString().slice(0, 10)
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`Invalid security-expires date: ${value}`)
  }
  return value
}
validDate(today)

const changes = []
const update = (relative, transform) => {
  const path = resolve(root, relative)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const result = transform(source)
  if (result.source !== source) {
    writeFileSync(path, result.source)
    changes.push({ file: relative, removed: result.removed })
  }
}

update('pnpm-workspace.yaml', (source) => {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const removed = []
  let inExclusions = false
  let exclusionStart = -1
  const output = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^minimumReleaseAgeExclude:/.test(line)) {
      inExclusions = true
      exclusionStart = output.length
      output.push(line)
      continue
    }
    if (inExclusions && /^\S/.test(line)) {
      if (!output.slice(exclusionStart + 1).some((candidate) => /^\s*-\s*/.test(candidate))) {
        output[exclusionStart] = 'minimumReleaseAgeExclude: []'
      }
      inExclusions = false
    }
    if (inExclusions) {
      const match = /^(\s*-\s*'[^']+')(?:\s*#\s*security-expires:\s*(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line)
      if (match) {
        if (match[2] && validDate(match[2]) <= today) {
          removed.push(match[1].trim())
          continue
        }
      } else if (/security-expires:/.test(line)) {
        throw new Error(`Malformed security-expires entry in pnpm-workspace.yaml: ${line.trim()}`)
      }
    }
    output.push(line)
  }
  if (inExclusions && !output.slice(exclusionStart + 1).some((candidate) => /^\s*-\s*/.test(candidate))) {
    output[exclusionStart] = 'minimumReleaseAgeExclude: []'
  }
  return { source: output.join(eol), removed }
})

update('pyproject.toml', (source) => {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const tableIndex = lines.findIndex((line) => /^exclude-newer-package\s*=\s*\{.*\}\s*$/.test(line))
  if (tableIndex < 0) return { source, removed: [] }
  const tableLine = lines[tableIndex]
  const entries = [...tableLine.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/g)].map((match) => ({ name: match[1], cutoff: match[2] }))
  const metadataIndex = tableIndex > 0 && /^# security-expires:/.test(lines[tableIndex - 1]) ? tableIndex - 1 : -1
  const expiries = new Map()
  if (metadataIndex >= 0) {
    for (const match of lines[metadataIndex].matchAll(/([A-Za-z0-9_.-]+)\s*=\s*(\d{4}-\d{2}-\d{2})/g)) {
      expiries.set(match[1], validDate(match[2]))
    }
  }
  const removed = []
  const kept = []
  let newestCutoff = ''
  for (const entry of entries) {
    const expiry = expiries.get(entry.name)
    if (expiry && expiry <= today) {
      removed.push(entry.name)
      if (entry.cutoff > newestCutoff) newestCutoff = entry.cutoff
    } else {
      kept.push(entry)
    }
  }
  if (!removed.length) return { source, removed }
  if (metadataIndex >= 0 && kept.length) {
    lines[metadataIndex] = `# security-expires: ${kept.filter((entry) => expiries.has(entry.name)).map((entry) => `${entry.name}=${expiries.get(entry.name)}`).join(', ')}`
  }
  if (kept.length) {
    lines[tableIndex] = `exclude-newer-package = { ${kept.map((entry) => `${entry.name} = "${entry.cutoff}"`).join(', ')} }`
  } else {
    lines.splice(tableIndex, 1)
    if (metadataIndex >= 0) lines.splice(metadataIndex, 1)
  }
  if (newestCutoff) {
    const globalIndex = lines.findIndex((line) => /^exclude-newer\s*=/.test(line))
    if (globalIndex < 0) throw new Error('pyproject.toml: exclude-newer is required when removing a uv exception')
    const current = /^exclude-newer\s*=\s*"([^"]+)"/.exec(lines[globalIndex])?.[1]
    if (current && newestCutoff > current) lines[globalIndex] = `exclude-newer = "${newestCutoff}"`
  }
  return { source: lines.join(eol), removed }
})

console.log(JSON.stringify({ date: today, changes }))
