import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const hasTools = spawnSync('bash', ['-c', 'command -v jq']).status === 0
const options = { skip: !hasTools && 'bash and jq are required' }

// The status-polling loop of each deploy workflow, run against canned Hub responses.
const loops = Object.fromEntries(['project-container-service', 'project-kubernetes-service'].map((name) => {
  const workflow = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = workflow.indexOf('          for _ in $(seq 1')
  const end = workflow.indexOf('\n          done\n', start) + '\n          done\n'.length
  assert.ok(start > 0 && end > start, name)
  return [name, workflow.slice(start, end).replace(/^          /gm, '') + "echo 'Timed out waiting for the Kubernetes deployment.' >&2\nexit 1\n"]
}))

function poll(loop, responses) {
  // Stubs for what the surrounding step defines: the token, the Hub call and the clock.
  const script = [
    'set -euo pipefail',
    'oidc_token() { echo token; }',
    'sleep() { :; }',
    // The counter lives in a file: curl runs in a command substitution, a subshell.
    'echo 0 > "$RESPONSES.count"',
    // Past the last canned response, Hub keeps answering with it.
    'next() { local n line; n=$(( $(cat "$RESPONSES.count") + 1 )); echo "$n" > "$RESPONSES.count"; line="$(sed -n "${n}p" "$RESPONSES")"; [[ -n "$line" ]] || line="$(tail -n 1 "$RESPONSES")"; printf "%s\n" "$line"; }',
    'hub_post() { next > "$3"; }',
    'curl() { next; }',
    'PROJECT=example COMPONENT=web GITHUB_SHA=0000000000000000000000000000000000000000 HEALTH_POLL_COUNT=3 request_id=request',
    'response="$(mktemp)"',
    loop
  ].join('\n')
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, RESPONSES: responses }
  })
}

function run(loop, statuses) {
  const root = mkdtempSync(join(tmpdir(), 'ntanis-deploy-wait-'))
  try {
    const file = join(root, 'responses').replaceAll('\\', '/')
    writeFileSync(file, statuses.map((status) => JSON.stringify({ deploymentRequest: status })).join('\n') + '\n')
    return poll(loop, file)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

for (const [name, loop] of Object.entries(loops)) {
  test(`${name} ends green, with a warning, when Hub holds the deployment for required settings`, options, () => {
    const result = run(loop, [
      { status: 'queued', missing_environment: [] },
      { status: 'queued', missing_environment: ['AUTH_SECRET', 'DISCORD_BOT_TOKEN'] }
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /::warning title=Deployment held for required settings::.*AUTH_SECRET, DISCORD_BOT_TOKEN/)
  })

  test(`${name} keeps waiting for a queued deployment that is not held, and times out as before`, options, () => {
    const result = run(loop, [{ status: 'queued', missing_environment: [] }, { status: 'deploying', missing_environment: [] }, { status: 'queued' }])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Timed out waiting for the Kubernetes deployment/)
    assert.doesNotMatch(result.stdout, /::warning/)
  })

  test(`${name} still ends on healthy and on failed`, options, () => {
    assert.equal(run(loop, [{ status: 'queued', missing_environment: [] }, { status: 'healthy' }]).status, 0)
    const failed = run(loop, [{ status: 'failed', failure_code: 'rollout_crash_loop' }])
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /rollout_crash_loop/)
  })
}
