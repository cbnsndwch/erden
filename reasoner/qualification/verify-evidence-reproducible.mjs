import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const qualification = import.meta.dirname;
const reasoner = resolve(qualification, '..');
const temporary = mkdtempSync(join(tmpdir(), 'erden-evidence-repro-'));
const generated = new Set([
  'qualification/THIRD-PARTY-NOTICES.md',
  'qualification/advisories.json',
  'qualification/dependency-tree.txt',
  'qualification/evidence-reproducibility.json',
  'qualification/sbom-validation.json',
  'qualification/sbom.json',
]);
function ignoredDirectory(path) {
  return path === 'target' || path.startsWith('target/') ||
    path === 'qualification/licenses' || path.startsWith('qualification/licenses/');
}
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function listFiles(directory, prefix = '') {
  return readdirSync(join(directory, prefix))
    .flatMap((name) => {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      return statSync(join(directory, path)).isDirectory() ? listFiles(directory, path) : [path];
    }).sort();
}

try {
  const checkouts = ['checkout-a', 'checkout-b'].map((name) => join(temporary, name));
  for (const checkout of checkouts) {
    cpSync(reasoner, checkout, {
      recursive: true,
      filter: (source) => {
        const path = relative(reasoner, source).replaceAll('\\', '/');
        return path === '' || (!ignoredDirectory(path) && !generated.has(path));
      },
    });
    execFileSync(process.execPath, ['qualification/generate-evidence.mjs'], {
      cwd: checkout,
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
    });
  }

  const evidencePaths = [
    'qualification/THIRD-PARTY-NOTICES.md',
    'qualification/advisories.json',
    'qualification/dependency-tree.txt',
    'qualification/sbom-validation.json',
    'qualification/sbom.json',
    ...listFiles(join(checkouts[0], 'qualification', 'licenses')).map((path) => `qualification/licenses/${path}`),
  ].sort();
  const artifacts = evidencePaths.map((path) => {
    const left = readFileSync(join(checkouts[0], path));
    const right = readFileSync(join(checkouts[1], path));
    if (!left.equals(right)) throw new Error(`Evidence differs by checkout path: ${path}`);
    return { bytes: left.length, path, sha256: `sha256:${hash(left)}` };
  });
  const relativeCheckoutNames = checkouts.map((path) => basename(path));
  writeFileSync(join(qualification, 'evidence-reproducibility.json'), `${JSON.stringify({
    artifacts,
    checkouts: relativeCheckoutNames,
    result: 'byte-identical',
    schemaVersion: 1,
  }, null, 2)}\n`);
  process.stdout.write(`Verified ${artifacts.length} evidence files from two independent checkout paths.\n`);
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
