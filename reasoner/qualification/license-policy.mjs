export function licenseIdentifiers(expression) {
  return expression.match(/[A-Za-z0-9][A-Za-z0-9.-]*/gu)
    ?.filter((token) => !['AND', 'OR', 'WITH'].includes(token)) ?? [];
}

export function selectLicenses(expression, policy, component) {
  if (typeof expression !== 'string' || expression.length === 0) {
    throw new Error(`Unlicensed package: ${component}`);
  }
  for (const identifier of licenseIdentifiers(expression)) {
    if (policy.deniedIdentifiers.includes(identifier)) {
      throw new Error(`Denied license ${identifier}: ${component}`);
    }
    if (!policy.allowedIdentifiers.includes(identifier)) {
      throw new Error(`Unknown license ${identifier}: ${component}`);
    }
  }
  const selected = policy.selections[expression];
  if (!Array.isArray(selected) || selected.length === 0) {
    throw new Error(`License expression has no approved selection: ${expression}`);
  }
  return selected;
}
