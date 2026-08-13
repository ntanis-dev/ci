export const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const packageName = String.raw`(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*`
const exactNpmAlias = new RegExp(`^npm:${packageName}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`)

export const exactRegistryTarget = (target) => {
  if (exactVersion.test(target)) return true
  const alias = exactNpmAlias.exec(target)
  return Boolean(alias && exactVersion.test(alias[1]))
}

export const exactSelector = (selector) => {
  const separator = selector.startsWith('@') ? selector.indexOf('@', 1) : selector.indexOf('@')
  return separator > 0 && exactVersion.test(selector.slice(separator + 1))
}

export const exactBuildSelector = (selector) => {
  const parts = selector.split(/\s+\|\|\s+/)
  return parts.length > 0 && exactSelector(parts[0]) && parts.slice(1).every((version) => exactVersion.test(version))
}
