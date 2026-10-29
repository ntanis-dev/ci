import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(root, '.github/workflows')
const read = (name) => readFileSync(resolve(directory, name), 'utf8').replace(/\r\n/g, '\n')
const workflows = readdirSync(directory).filter((name) => name.endsWith('.yml'))

// The job blocks of a workflow: id -> text (a job starts at two spaces of indentation under `jobs:`).
const jobs = (source) => {
  const body = source.split(/\njobs:\n/)[1] ?? ''
  const found = {}
  let id = null
  for (const line of body.split('\n')) {
    const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (start) {
      id = start[1]
      found[id] = ''
    } else if (id) found[id] += line + '\n'
  }
  return found
}

test('every job of every workflow sets timeout-minutes, so none can run for the default six hours', () => {
  for (const name of workflows)
    for (const [id, block] of Object.entries(jobs(read(name))))
      assert.match(block, /^ {4}timeout-minutes: \S+/m, `${name} job ${id} has no timeout-minutes`)
})

test('a reusable workflow takes its timeouts as inputs with a default, and uses only inputs it declares', () => {
  for (const name of workflows) {
    const source = read(name)
    if (!/^ {2}workflow_call:/m.test(source)) continue
    for (const [, input] of source.matchAll(/inputs\.([a-z-]*timeout-minutes)/g)) {
      const declared = new RegExp(`^ {6}${input}:\\n(?: {8}.*\\n)*? {8}default: \\d+\\n`, 'm')
      assert.match(source, declared, `${name} uses inputs.${input} without declaring it with a numeric default`)
    }
  }
})

test('the container deploy timeout follows the health poll budget: always longer than the wait, never past six hours', () => {
  const source = read('project-container-service.yml')
  const line = /'deploy-timeout-minutes=' \+ (.+?) \+ '\\n'\)/.exec(source)
  assert.ok(line, 'the contract step must output deploy-timeout-minutes')
  const minutes = new Function('healthPollCount', `return ${line[1]}`)
  const budget = /Math\.ceil\(\(Math\.min\(18000, Math\.max\(480, \(startupSeconds \+ 120\) \* replicas\)\) \+ 600\) \/ 10\)/
  assert.match(source, budget, 'the poll count formula changed; check the deploy timeout against it')
  // The smallest, a typical and the largest budget the contract allows (108 to 1860 polls of 10 seconds).
  for (const polls of [108, 168, 222, 1860]) {
    const wait = (polls * 10) / 60
    assert.ok(minutes(polls) >= wait + 10, `${polls} polls wait up to ${wait} minutes but the job stops at ${minutes(polls)}`)
    assert.ok(minutes(polls) <= 360, `${polls} polls would exceed the six hour limit of a job`)
  }
  assert.match(source, /timeout-minutes: \$\{\{ fromJSON\(needs\.build\.outputs\.deploy-timeout-minutes\) \}\}/)
})

test('the Kubernetes service deploy timeout covers its fixed health wait of 60 polls', () => {
  const source = read('project-kubernetes-service.yml')
  assert.match(source, /seq 1 60/)
  const declared = /deploy-timeout-minutes:\n(?: {8}.*\n)*? {8}default: (\d+)/.exec(source)
  assert.ok(declared && Number(declared[1]) >= 60 * 15 / 60 + 5, 'the deploy timeout must exceed 60 polls of up to 15 seconds')
})
