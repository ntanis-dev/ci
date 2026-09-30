import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/project-container-service.yml', import.meta.url), 'utf8')
const source = workflow.match(/          node - <<'NODE'\r?\n([\s\S]*?)          NODE/)[1].replace(/^          /gm, '')

function validate({ image = 'ghcr.io/criticalscripts-shop/web/store', context = '.', dockerfile = 'store/Dockerfile', setup } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ntanis-container-test-'))
  try {
    mkdirSync(join(root, 'store'))
    writeFileSync(join(root, '.dockerignore'), '.git\n')
    writeFileSync(join(root, 'store', 'Dockerfile'), 'FROM node@sha256:' + 'a'.repeat(64) + '\n')
    writeFileSync(join(root, 'Dockerfile'), 'FROM node@sha256:' + 'a'.repeat(64) + '\n')
    writeFileSync(join(root, 'ntanis.project.json'), JSON.stringify({
      schemaVersion: 3, project: { id: 'criticalscripts' },
      hosting: { components: [{ id: 'store', deployment: 'automatic', imageRepository: image }] },
      secrets: [
        { name: 'STORE_PUBLIC_CONFIG', purpose: 'Public settings', type: 'configuration', required: true, components: ['store'] },
        { name: 'DISCORD_TOKEN', purpose: 'Community only', type: 'secret', required: true, components: ['community'] }
      ]
    }))
    setup?.(root)
    const output = join(root, 'output')
    const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', source], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'criticalscripts-shop/web', COMPONENT: 'store', PROJECT: 'criticalscripts', BUILD_CONTEXT: context, DOCKERFILE: dockerfile }
    })
    return { ...result, output: result.status === 0 ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) : {} }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('component image and Dockerfile remain tied to the authenticated repository', () => {
  const result = validate()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output['image-repository'], 'ghcr.io/criticalscripts-shop/web/store')
  assert.equal(result.output.dockerfile, 'store/Dockerfile')
  const environment = JSON.parse(Buffer.from(result.output['environment-b64'], 'base64'))
  assert.deepEqual(environment.map((entry) => entry.name), ['STORE_PUBLIC_CONFIG'])
})

test('legacy root image and Dockerfile remain supported', () => {
  const result = validate({ image: 'ghcr.io/criticalscripts-shop/web', dockerfile: 'Dockerfile' })
  assert.equal(result.status, 0, result.stderr)
})

test('rejects sibling and prefix-confusable image destinations', () => {
  for (const image of ['ghcr.io/criticalscripts-shop/other/store', 'ghcr.io/criticalscripts-shop/web-extra/store', 'ghcr.io/criticalscripts-shop/web/community', 'ghcr.io/criticalscripts-shop/web/store/extra']) {
    assert.notEqual(validate({ image }).status, 0, image)
  }
})

test('rejects traversal, absolute paths, shell syntax and Dockerfiles outside context', () => {
  for (const dockerfile of ['../Dockerfile', '/tmp/Dockerfile', 'store/../../Dockerfile', 'store/$(touch injected)', 'store//Dockerfile']) {
    assert.notEqual(validate({ dockerfile }).status, 0, dockerfile)
  }
  assert.notEqual(validate({ context: 'store', dockerfile: 'Dockerfile', setup: (root) => writeFileSync(join(root, 'store', '.dockerignore'), '.git') }).status, 0)
})

test('rejects a build context symlink escaping the checked-out repository', () => {
  const result = validate({ context: 'escape', setup: (root) => symlinkSync(resolve(root, '..'), join(root, 'escape'), 'junction') })
  assert.notEqual(result.status, 0)
})

test('component builds use separate concurrency keys and shell-quoted paths', () => {
  assert.match(workflow, /ntanis-container-\$\{\{ inputs.project \}\}-\$\{\{ inputs.component \}\}/)
  assert.ok(workflow.includes('--file "$DOCKERFILE"'))
  assert.ok(workflow.includes('"$BUILD_CONTEXT"'))
})
