import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const input = (name) => process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`]?.trim() ?? ''
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
const sourceDirectory = resolve(workspace, input('source-directory'))
const outputDirectory = resolve(workspace, input('output-directory'))
const patterns = input('include-files').split(',').map((item) => item.trim()).filter(Boolean)

function contained(path) {
  const relation = relative(workspace, path)
  return !relation.startsWith('..') && resolve(workspace, relation || '.') === path
}

if (!contained(sourceDirectory) || !contained(outputDirectory) || sourceDirectory === outputDirectory) throw new Error('Staging directories must be distinct and contained by the workspace.')
if (patterns.length < 1 || patterns.length > 16 || patterns.some((item) => !/^[A-Za-z0-9*][A-Za-z0-9._+*-]{0,159}$/.test(item))) throw new Error('Invalid include-files patterns.')

function matches(pattern, name) {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${source}$`, 'i').test(name)
}

const selected = []
for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
  const path = resolve(sourceDirectory, entry.name)
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`Top-level symlinks are not accepted: ${entry.name}`)
  if (info.isFile() && patterns.some((pattern) => matches(pattern, entry.name))) selected.push({ name: entry.name, path })
}
if (!selected.length) throw new Error('No explicit release files matched include-files.')
await mkdir(outputDirectory, { recursive: false })
for (const file of selected) await copyFile(file.path, resolve(outputDirectory, file.name), constants.COPYFILE_EXCL)
process.stdout.write(`Staged ${selected.length} explicit release file(s).\n`)
