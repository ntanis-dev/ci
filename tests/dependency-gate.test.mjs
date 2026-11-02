import assert from 'node:assert/strict'
import test from 'node:test'
import { classify, compareVersions, fixFor, meetsThreshold, summarize } from '../.github/actions/dependency-gate/gate.mjs'
import { commitMessage, dropMaturedExemptions, packagesToUpdate } from '../.github/actions/dependency-maintenance/maintenance.mjs'

const now = new Date('2026-11-02T12:00:00Z')
const days = (count) => new Date(now.getTime() - count * 864e5)
const vulnerability = (id, fixed, severity = 'MODERATE', introduced = '0') => ({
  id,
  aliases: [`CVE-${id.slice(5, 9)}`],
  database_specific: { severity },
  affected: [{ package: { ecosystem: 'npm', name: 'pkg' }, ranges: [{ type: 'SEMVER', events: fixed ? [{ introduced }, { fixed }] : [{ introduced }] }] }],
})
const scan = (...vulnerabilities) => ({
  results: [{
    source: { path: '/work/repo/pnpm-lock.yaml', type: 'lockfile' },
    packages: [{ package: { name: 'pkg', version: '1.2.3', ecosystem: 'npm' }, vulnerabilities, groups: vulnerabilities.map((item) => ({ ids: [item.id], max_severity: '5.3' })) }],
  }],
})
const published = (map) => async (ecosystem, name, version) => map[version] ?? null

test('versions compare numerically, with pre-releases before their release', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('v0.52.0', '0.52.0'), 0)
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0'), -1)
  assert.equal(compareVersions('6.16.0', '6.16.1'), -1)
})

test('the fix is the fixed release of the range that contains the installed version', () => {
  const item = { affected: [{ package: { ecosystem: 'npm', name: 'pkg' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.5' }, { introduced: '1.1.0' }, { fixed: '1.2.7' }, { introduced: '2.0.0' }, { fixed: '2.0.4' }] }] }] }
  assert.equal(fixFor(item, { name: 'pkg', ecosystem: 'npm', version: '1.2.3' }), '1.2.7')
  assert.equal(fixFor(item, { name: 'pkg', ecosystem: 'npm', version: '1.0.9' }), null)
  assert.equal(fixFor(item, { name: 'other', ecosystem: 'npm', version: '1.2.3' }), null)
})

test('a fix younger than two weeks waits with its landing date, a mature one needs action', async () => {
  const [waiting] = await classify(scan(vulnerability('GHSA-aaaa-aaaa-aaaa', '1.2.4')), { now, root: '/work/repo', publishedAt: published({ '1.2.4': days(3) }) })
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.source, 'pnpm-lock.yaml')
  assert.equal(waiting.landsOn, '2026-11-13 12:00 UTC')
  const [action] = await classify(scan(vulnerability('GHSA-aaaa-aaaa-aaaa', '1.2.4')), { now, root: '/work/repo', publishedAt: published({ '1.2.4': days(20) }) })
  assert.equal(action.status, 'action')
  const [unknown] = await classify(scan(vulnerability('GHSA-aaaa-aaaa-aaaa', '1.2.4')), { now, root: '/work/repo', publishedAt: published({}) })
  assert.equal(unknown.status, 'action', 'an unknown release date fails closed')
})

test('accepted advisories pass until they expire, and a missing fix needs a decision', async () => {
  const policy = { advisories: [{ id: 'GHSA-bbbb-bbbb-bbbb', package: 'pkg', until: '2026-12-07', reason: 'tooling only' }, { id: 'CVE-cccc', until: '2026-11-01', reason: 'old' }] }
  const findings = await classify(scan(vulnerability('GHSA-bbbb-bbbb-bbbb', null), vulnerability('GHSA-cccc-cccc-cccc', '1.2.4'), vulnerability('GHSA-dddd-dddd-dddd', null)), { now, root: '/work/repo', policy, publishedAt: published({}) })
  assert.deepEqual(findings.map((item) => item.status), ['accepted', 'decision', 'decision'])
  assert.match(findings[1].reason, /expired on 2026-11-01/)
  assert.equal(findings[2].reason, 'no fixed release')
})

test('excluded paths are not classified', async () => {
  const osv = scan(vulnerability('GHSA-aaaa-aaaa-aaaa', null))
  osv.results[0].source.path = '/work/repo/research/snapshot/package-lock.json'
  assert.equal((await classify(osv, { now, root: '/work/repo', exclude: ['research/'] })).length, 0)
  assert.equal((await classify(osv, { now, root: '/work/repo', exclude: ['research/snap'] })).length, 1)
})

test('only findings to act on at or above the threshold fail; unknown severity always counts', async () => {
  const findings = await classify(scan(vulnerability('GHSA-aaaa-aaaa-aaaa', '1.2.4'), vulnerability('GHSA-eeee-eeee-eeee', '1.2.5', 'HIGH')), { now, root: '/work/repo', publishedAt: published({ '1.2.4': days(30), '1.2.5': days(2) }) })
  assert.equal(summarize(findings, 'low').failing, 1)
  assert.equal(summarize(findings, 'high').failing, 0)
  assert.equal(summarize(findings, 'none').failing, 0)
  assert.equal(meetsThreshold('unknown', 'critical'), true)
  assert.match(summarize(findings, 'low').markdown, /Waiting for the release age[\s\S]*1\.2\.5/)
})

test('maintenance drops matured exceptions with their comments and keeps young ones', async () => {
  const source = [
    'minimumReleaseAge: 20160',
    '# Exact security releases; remove these exceptions once they are 14 days old.',
    'minimumReleaseAgeExclude:',
    "  - 'old@1.0.0'",
    "  - 'young@2.0.0'",
    '  # GHSA-zzzz: drop this once it is two weeks old.',
    "  - '@scope/pkg@3.0.0'",
    "  - 'tagged@1.0.0' # security-expires: 2026-11-01",
    'trustLockfile: false',
    '',
  ].join('\r\n')
  const ages = { '1.0.0': days(30), '2.0.0': days(3), '3.0.0': days(15) }
  const result = await dropMaturedExemptions(source, { now, publishedAt: published(ages) })
  assert.deepEqual(result.removed, ['old@1.0.0', '@scope/pkg@3.0.0', 'tagged@1.0.0'])
  assert.equal(result.source, ['minimumReleaseAge: 20160', '# Exact security releases; remove these exceptions once they are 14 days old.', 'minimumReleaseAgeExclude:', "  - 'young@2.0.0'", 'trustLockfile: false', ''].join('\r\n'))
})

test('maintenance removes the exception list and its comment once every entry matured', async () => {
  const source = "saveExact: true\n# Exact security releases; remove these exceptions once they are 14 days old.\nminimumReleaseAgeExclude:\n  - 'old@1.0.0'\ntrustLockfile: false\n"
  const result = await dropMaturedExemptions(source, { now, publishedAt: published({ '1.0.0': days(30) }) })
  assert.equal(result.source, 'saveExact: true\ntrustLockfile: false\n')
})

test('maintenance updates only npm packages in pnpm lockfiles whose mature fix is missing', () => {
  const result = { findings: [
    { status: 'action', ecosystem: 'npm', package: 'qs', source: 'pnpm-lock.yaml' },
    { status: 'action', ecosystem: 'npm', package: '@hono/node-server', source: 'apps/web/pnpm-lock.yaml' },
    { status: 'waiting', ecosystem: 'npm', package: 'vite', source: 'pnpm-lock.yaml' },
    { status: 'action', ecosystem: 'npm', package: 'left-pad', source: 'tools/package-lock.json' },
    { status: 'action', ecosystem: 'npm', package: 'bad; rm -rf /', source: 'pnpm-lock.yaml' },
    { status: 'action', ecosystem: 'Go', package: 'golang.org/x/net', source: 'go.mod' },
  ] }
  assert.deepEqual(packagesToUpdate(result), ['@hono/node-server', 'qs'])
})

test('the maintenance commit message says what changed and what is still open', () => {
  const message = commitMessage({ updated: ['qs'], removed: ['qs@6.16.1'], notices: true }, { findings: [{ status: 'waiting' }, { status: 'accepted' }, { status: 'decision' }] })
  assert.match(message, /^Apply mature dependency fixes\n\n- Update qs /)
  assert.ok(message.split('\n').every((line) => line.length <= 78), 'body lines are wrapped')
  const flat = message.replace(/\s+/g, ' ')
  assert.match(flat, /Drop the release-age exceptions that are now two weeks old: qs@6\.16\.1/)
  assert.match(flat, /1 waiting for the release age, 1 needing action or a decision/)
})
