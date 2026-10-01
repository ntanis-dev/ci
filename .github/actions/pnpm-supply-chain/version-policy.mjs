export const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

export const exactSelector = (selector) => {
  const separator = selector.startsWith('@') ? selector.indexOf('@', 1) : selector.indexOf('@')
  return separator > 0 && packageName.test(selector.slice(0, separator)) && exactVersion.test(selector.slice(separator + 1))
}

export const exactRegistryTarget = (target) => exactVersion.test(target) || (typeof target === 'string' && target.startsWith('npm:') && exactSelector(target.slice(4)))

export const exactBuildSelector = (selector) => {
  if ((selector.startsWith("'") && selector.endsWith("'")) || (selector.startsWith('"') && selector.endsWith('"'))) selector = selector.slice(1, -1)
  const parts = selector.split(/\s+\|\|\s+/)
  return parts.length > 0 && exactSelector(parts[0]) && parts.slice(1).every((version) => exactVersion.test(version))
}

/** workspace: prevents registry substitution for a missing local package. */
export const exactDependencyVersion = (name, version, localVersions) => {
  if (exactVersion.test(version)) return true
  if (typeof version !== 'string' || !version.startsWith('workspace:')) return false
  const expected = version.slice('workspace:'.length)
  return exactVersion.test(expected) && localVersions.get(name) === expected
}
