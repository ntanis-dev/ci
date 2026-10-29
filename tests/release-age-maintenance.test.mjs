import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const cleanup = resolve(root, '.github/actions/release-age-maintenance/cleanup.mjs')
const validator = resolve(root, '.github/actions/pnpm-supply-chain/check.mjs')
const temporary = resolve(root, 'tests/.tmp-release-age')
const prepare = (name) => {
  const directory = resolve(temporary, name)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  return directory
}
const run = (directory, date = '2026-10-29') => spawnSync(process.execPath, [cleanup, '--root', directory, '--date', date], { encoding: 'utf8' })
const write = (directory, name, source) => {
  const path = resolve(directory, name)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, source)
}
const read = (directory, name) => readFileSync(resolve(directory, name), 'utf8')

test('pnpm cleanup removes only expired dated entries and empties the list safely', () => {
  const directory = prepare('pnpm-mixed')
  write(directory, 'pnpm-workspace.yaml', `overrides:\n  fast-uri: 3.1.9\nminimumReleaseAgeExclude:\n  - 'fast-uri@3.1.9' # security-expires: 2026-10-28\n  - 'undici@7.30.1' # security-expires: 2026-11-03\n  - 'zod@4.6.6'\nallowBuilds:\n  esbuild: true\n`)
  const result = run(directory)
  assert.equal(result.status, 0, result.stderr)
  const source = read(directory, 'pnpm-workspace.yaml')
  assert.ok(!source.includes('fast-uri@3.1.9\' # security-expires'))
  assert.ok(source.includes("- 'undici@7.30.1' # security-expires: 2026-11-03"))
  assert.ok(source.includes("- 'zod@4.6.6'"))
  assert.ok(source.includes('fast-uri: 3.1.9'))
  const second = run(directory, '2026-11-03')
  assert.equal(second.status, 0, second.stderr)
  const remaining = read(directory, 'pnpm-workspace.yaml')
  assert.ok(remaining.includes("- 'zod@4.6.6'"), 'undated legacy entries stay untouched')
})

test('pnpm cleanup uses an empty list after every dated entry expires', () => {
  const directory = prepare('pnpm-empty')
  write(directory, 'pnpm-workspace.yaml', `minimumReleaseAgeExclude:\n  - 'fast-uri@3.1.9' # security-expires: 2026-10-28\nallowBuilds:\n  esbuild: true\n`)
  const result = run(directory)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(read(directory, 'pnpm-workspace.yaml').includes('minimumReleaseAgeExclude: []'))
})

test('uv cleanup advances the global cutoff and preserves future exceptions', () => {
  const directory = prepare('uv-mixed')
  const source = `[tool.uv]\nexclude-newer = "2026-09-17T00:00:00Z"\n# security-expires: certifi=2026-11-03, filelock=2026-11-05\nexclude-newer-package = { certifi = "2026-10-20T03:00:00Z", filelock = "2026-10-17T17:00:00Z" }\nrequired-version = "==0.12.2"\n`
  write(directory, 'pyproject.toml', source)
  const result = run(directory, '2026-11-03')
  assert.equal(result.status, 0, result.stderr)
  const updated = read(directory, 'pyproject.toml')
  assert.ok(updated.includes('exclude-newer = "2026-10-20T03:00:00Z"'))
  assert.ok(updated.includes('# security-expires: filelock=2026-11-05'))
  assert.ok(updated.includes('exclude-newer-package = { filelock = "2026-10-17T17:00:00Z" }'))
  assert.ok(!updated.includes('certifi ='))
  const second = run(directory, '2026-11-05')
  assert.equal(second.status, 0, second.stderr)
  const emptied = read(directory, 'pyproject.toml')
  assert.ok(!emptied.includes('exclude-newer-package'))
  assert.ok(!emptied.includes('# security-expires:'))
  assert.ok(emptied.includes('required-version = "==0.12.2"'))
})

test('malformed expiry metadata fails without changing the source', () => {
  const directory = prepare('invalid')
  const source = 'minimumReleaseAgeExclude:\n  - \'fast-uri@3.1.9\' # security-expires: tomorrow\n'
  write(directory, 'pnpm-workspace.yaml', source)
  const result = run(directory)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Malformed security-expires entry/)
  assert.equal(read(directory, 'pnpm-workspace.yaml'), source)
})

const validatorFixture = (directory, exclusion) => {
  write(directory, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', packageManager: 'pnpm@11.15.1' }))
  write(directory, 'pnpm-lock.yaml', `lockfileVersion: '9.0'\npackages:\n  '${exclusion}':\n    resolution: {}\n`)
  write(directory, 'pnpm-workspace.yaml', `minimumReleaseAge: 20160\nminimumReleaseAgeIgnoreMissingTime: false\nminimumReleaseAgeStrict: true\ntrustLockfile: false\nblockExoticSubdeps: true\nsaveExact: true\nstrictDepBuilds: true\nverifyDepsBeforeRun: error\nminimumReleaseAgeExclude:\n  - '${exclusion}'\n`)
  write(directory, '.npmrc', 'ignore-scripts=true\nsave-exact=true\n')
  write(directory, 'renovate.json', '{}\n')
  write(directory, 'SECURITY.md', '# Security\n')
  write(directory, '.github/CODEOWNERS', '* @ntanis-dev\n')
  write(directory, '.github/workflows/osv-scanner.yml', 'on:\n  schedule:\n    - cron: "17 5 * * 1"\njobs:\n  scan:\n    steps:\n      - run: echo "fail-on-vuln: true"\n')
}

test('central validator accepts security-expires metadata and rejects malformed entries', () => {
  const valid = prepare('validator-valid')
  validatorFixture(valid, 'fast-uri@3.1.9')
  const validWorkspace = resolve(valid, 'pnpm-workspace.yaml')
  writeFileSync(validWorkspace, readFileSync(validWorkspace, 'utf8').replace("- 'fast-uri@3.1.9'", "- 'fast-uri@3.1.9' # security-expires: 2026-11-02"))
  // The validator reads GITHUB_WORKSPACE before the working directory; on Actions that is the real checkout, not the fixture.
  const environment = { ...process.env, GITHUB_WORKSPACE: '' }
  const accepted = spawnSync(process.execPath, [validator], { cwd: valid, encoding: 'utf8', env: environment })
  assert.equal(accepted.status, 0, accepted.stderr)
  const invalid = prepare('validator-invalid')
  validatorFixture(invalid, 'fast-uri@3.1.9')
  const invalidWorkspace = resolve(invalid, 'pnpm-workspace.yaml')
  writeFileSync(invalidWorkspace, readFileSync(invalidWorkspace, 'utf8').replace("- 'fast-uri@3.1.9'", "- 'fast-uri@3.1.9' # security-expires: tomorrow"))
  const rejected = spawnSync(process.execPath, [validator], { cwd: invalid, encoding: 'utf8', env: environment })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /optional security-expires date/)
})

test('workflow is repository-local, bounded and stages only exception files', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/release-age-maintenance.yml'), 'utf8')
  assert.match(workflow, /contents: write/)
  assert.match(workflow, /timeout-minutes: 20/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /git add -u -- pnpm-workspace.yaml pyproject.toml uv.lock/)
  assert.doesNotMatch(workflow, /secrets\.|\bPAT\b|personal.access.token/i)
})

test.after(() => rmSync(temporary, { recursive: true, force: true }))
