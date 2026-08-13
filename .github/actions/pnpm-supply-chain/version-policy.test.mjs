import assert from 'node:assert/strict'
import test from 'node:test'
import { exactRegistryTarget } from './version-policy.mjs'

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
