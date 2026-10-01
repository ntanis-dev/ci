import assert from 'node:assert/strict'
import test from 'node:test'
import { exactBuildSelector, exactDependencyVersion, exactRegistryTarget } from './version-policy.mjs'

test('accepts exact versions and exact npm aliases', () => {
  for (const target of ['1.2.3', '1.2.3-rc.1', 'npm:probe-image-size@7.3.0', 'npm:@scope/package@2.0.1']) {
    assert.equal(exactRegistryTarget(target), true, target)
  }
})

test('rejects ranges, tags, URLs, and floating npm aliases', () => {
  for (const target of ['^1.2.3', 'latest', 'github:owner/repo#main', 'npm:probe-image-size@^7.3.0', 'npm:@scope/package@latest']) {
    assert.equal(exactRegistryTarget(target), false, target)
  }
})

test('accepts only exact workspace references to a matching repository package', () => {
  const local = new Map([['@product/domain', '0.1.0']])
  assert.equal(exactDependencyVersion('@product/domain', 'workspace:0.1.0', local), true)
  for (const version of ['workspace:*', 'workspace:^0.1.0', 'workspace:0.2.0', 'workspace:../domain', 'file:../domain']) {
    assert.equal(exactDependencyVersion('@product/domain', version, local), false, version)
  }
  assert.equal(exactDependencyVersion('@missing/domain', 'workspace:0.1.0', local), false)
  assert.equal(exactDependencyVersion('external', '1.2.3', local), true)
})

test('quoted YAML build approvals still require exact versions', () => {
  for (const selector of ['esbuild@0.25.9', "'@scope/pkg@1.2.3'", '"@scope/pkg@1.2.3"', "'esbuild@0.25.9 || 0.25.10'"]) {
    assert.equal(exactBuildSelector(selector), true, selector)
  }
  for (const selector of ['esbuild', "'esbuild@*'", "'@scope/pkg@^1.2.3'", "'esbuild@0.25.9 || *'", "'esbuild@0.25.9"]) {
    assert.equal(exactBuildSelector(selector), false, selector)
  }
})
