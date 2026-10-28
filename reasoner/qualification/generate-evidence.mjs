import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { selectLicenses } from './license-policy.mjs';

const qualification = import.meta.dirname;
const reasoner = resolve(qualification, '..');
const licensesDirectory = join(qualification, 'licenses');
const cycloneDxValidatorImage = 'cyclonedx/cyclonedx-cli@sha256:252c2e26f468c25fea1e63ecde1bc3198ad6e9dbb57f5ed3236bddcb2281b3a7';
const policy = JSON.parse(readFileSync(join(qualification, 'license-policy.json'), 'utf8'));
function hash(input) {
  return createHash('sha256').update(input).digest('hex');
}
function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function run(command, arguments_) {
  return execFileSync(command, arguments_, {
    cwd: reasoner,
    encoding: 'utf8',
    windowsHide: true,
  }).replaceAll('\r\n', '\n');
}

const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1']));
const rootId = metadata.packages.find((item) => item.name === 'erden-reasoner' && item.source === null)?.id;
if (rootId === undefined) throw new Error('Cargo metadata has no erden-reasoner workspace root');
const lock = readFileSync(join(reasoner, 'Cargo.lock'));
const lockPackages = new Map();
for (const block of lock.toString('utf8').split(/\n\[\[package\]\]\n/u).slice(1)) {
  function field(name) {
    return block.match(new RegExp(`^${name} = "([^"]+)"$`, 'mu'))?.[1];
  }
  const name = field('name');
  const version = field('version');
  if (name !== undefined && version !== undefined) {
    const key = `${name}@${version}`;
    if (lockPackages.has(key)) throw new Error(`Ambiguous locked package identity: ${key}`);
    lockPackages.set(key, { checksum: field('checksum') ?? null, source: field('source') ?? null });
  }
}

const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const includedIds = new Set();
const pending = [rootId];
while (pending.length > 0) {
  const id = pending.pop();
  if (id === null || id === undefined || includedIds.has(id)) continue;
  includedIds.add(id);
  for (const dependency of nodes.get(id)?.deps ?? []) {
    const includedKinds = dependency.dep_kinds.filter((kind) => kind.kind === null || kind.kind === 'normal' || kind.kind === 'build');
    if (includedKinds.length > 0) pending.push(dependency.pkg);
  }
}

rmSync(licensesDirectory, { force: true, recursive: true });
mkdirSync(licensesDirectory, { recursive: true });
const copied = new Set();
const licenseNames = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/iu;
function findLicenseFiles(item) {
  let directory = dirname(item.manifest_path);
  const maximumDepth = item.source?.startsWith('registry+') === true ? 1 : 5;
  const found = [];
  for (let depth = 0; depth < maximumDepth; depth += 1) {
    found.push(...readdirSync(directory)
      .filter((name) => licenseNames.test(name))
      .map((name) => join(directory, name))
      .filter((path) => statSync(path).isFile()));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...new Set(found)].sort();
}

const packageById = new Map(metadata.packages
  .filter((item) => includedIds.has(item.id))
  .map((item) => [item.id, item]));
if (packageById.size !== lockPackages.size) {
  throw new Error(`Locked normal/build graph mismatch: metadata=${packageById.size}, lock=${lockPackages.size}`);
}

const stableRefById = new Map();
for (const item of packageById.values()) {
  const locked = lockPackages.get(`${item.name}@${item.version}`);
  if (locked === undefined) throw new Error(`Package missing from Cargo.lock: ${item.name}@${item.version}`);
  const base = `pkg:cargo/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`;
  const qualifier = locked.source?.startsWith('git+') === true
    ? `?vcs_url=${encodeURIComponent(locked.source)}`
    : '';
  stableRefById.set(item.id, `${base}${qualifier}`);
}

const packageRecords = [...packageById.values()].map((item) => {
  const locked = lockPackages.get(`${item.name}@${item.version}`);
  const selectedLicenses = selectLicenses(item.license, policy, `${item.name}@${item.version}`);
  const sourceLicensePaths = item.source === null
    ? [join(qualification, 'ERDEN-LICENSE-APACHE-2.0.txt')]
    : findLicenseFiles(item);
  const licenseFiles = sourceLicensePaths.map((sourcePath) => {
    const bytes = readFileSync(sourcePath);
    const sha256 = hash(bytes);
    const target = `${sha256}.txt`;
    if (!copied.has(sha256)) {
      copyFileSync(sourcePath, join(licensesDirectory, target));
      copied.add(sha256);
    }
    return {
      originalName: basename(sourcePath),
      path: `licenses/${target}`,
      sha256: `sha256:${sha256}`,
      text: bytes.toString('utf8'),
    };
  });
  if (licenseFiles.length === 0) {
    throw new Error(`No license or notice file found for ${item.name}@${item.version}`);
  }
  for (const identifier of selectedLicenses) {
    const markers = policy.completeTextMarkers[identifier];
    if (!Array.isArray(markers) || !licenseFiles.some((file) => markers.every((marker) => file.text.includes(marker)))) {
      throw new Error(`Complete ${identifier} terms not captured for ${item.name}@${item.version}`);
    }
  }
  const dependencyEdges = (nodes.get(item.id)?.deps ?? []).flatMap((dependency) => {
    const kinds = dependency.dep_kinds
      .map((kind) => kind.kind ?? 'normal')
      .filter((kind) => kind === 'normal' || kind === 'build');
    return kinds.length === 0 ? [] : [{ ref: stableRefById.get(dependency.pkg), kinds: [...new Set(kinds)].sort() }];
  }).sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    bomRef: stableRefById.get(item.id),
    checksum: locked.checksum,
    dependencyEdges,
    license: item.license,
    licenseFiles: licenseFiles.map(({ text: _text, ...file }) => file),
    name: item.name,
    repository: item.repository ?? null,
    selectedLicenses,
    source: locked.source,
    version: item.version,
  };
}).sort((left, right) => left.bomRef.localeCompare(right.bomRef));

const root = packageRecords.find((item) => item.bomRef === stableRefById.get(rootId));
if (root === undefined || root.name !== 'erden-reasoner') throw new Error('Real erden-reasoner root component missing');
const external = packageRecords.filter((item) => item !== root);
function component(item, type) {
  return {
    'bom-ref': item.bomRef,
    type,
    name: item.name,
    version: item.version,
    purl: item.bomRef,
    licenses: [{ expression: item.license }],
    ...(item.checksum === null ? {} : { hashes: [{ alg: 'SHA-256', content: item.checksum }] }),
    ...(item.repository === null ? {} : { externalReferences: [{ type: 'vcs', url: item.repository }] }),
    properties: [
      { name: 'erden:locked-source', value: item.source ?? 'workspace' },
      { name: 'erden:selected-licenses', value: item.selectedLicenses.join(' AND ') },
    ],
  };
}
const dependencies = packageRecords.map((item) => ({
  ref: item.bomRef,
  dependsOn: item.dependencyEdges.map((dependency) => dependency.ref),
}));

const sbom = {
  $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    component: component(root, 'application'),
    properties: [
      { name: 'erden:cargo-lock-sha256', value: `sha256:${hash(lock)}` },
      { name: 'erden:purrdf-commit', value: 'dfb1df73199668720116dfbc737c0585e23afb5e' },
      { name: 'erden:rustc-verbose-version', value: run('rustc', ['-vV']).trimEnd().replaceAll('\n', '; ') },
    ],
    tools: { components: [{ type: 'application', name: 'erden-qualification-evidence-generator', version: '2' }] },
  },
  components: external.map((item) => component(item, 'library')),
  dependencies,
};
writeFileSync(join(qualification, 'sbom.json'), stableJson(sbom));
function validator(arguments_) {
  return execFileSync('docker', [
    'run', '--rm', '--mount', `type=bind,source=${qualification},target=/work,readonly`,
    cycloneDxValidatorImage, ...arguments_,
  ], { cwd: reasoner, encoding: 'utf8', windowsHide: true }).replaceAll('\r\n', '\n').trim();
}
const validationOutput = validator([
  'validate', '--input-file', '/work/sbom.json', '--input-format', 'json',
  '--input-version', 'v1_6', '--fail-on-errors',
]);
const validatorVersion = validator(['--version']);
writeFileSync(join(qualification, 'sbom-validation.json'), stableJson({
  image: cycloneDxValidatorImage,
  result: validationOutput,
  schemaVersion: 'CycloneDX 1.6 JSON',
  validator: 'CycloneDX/cyclonedx-cli',
  validatorVersion,
}));

const treeLines = [
  '# Locked Cargo normal/build dependency graph (stable CycloneDX bom-ref identities)',
  ...packageRecords.flatMap((item) => item.dependencyEdges.length === 0
    ? [`${item.bomRef} ->`]
    : item.dependencyEdges.map((dependency) => `${item.bomRef} -[${dependency.kinds.join(',')}]-> ${dependency.ref}`)),
];
writeFileSync(join(qualification, 'dependency-tree.txt'), `${treeLines.join('\n')}\n`);

const noticeLines = [
  '# Third-party notices',
  '',
  'This inventory is generated from the exact locked normal and build dependency graph. The executable policy rejects unknown, denied, or unlicensed dependencies and verifies that complete terms for every selected license are present. Each referenced upstream file is copied byte-for-byte and named by its SHA-256 digest.',
  '',
];
for (const item of external) {
  noticeLines.push(`- ${item.name} ${item.version}: declared \`${item.license}\`; selected ${item.selectedLicenses.map((license) => `\`${license}\``).join(' and ')}; ${item.licenseFiles.map((file) => `${file.path} (${file.originalName}, ${file.sha256})`).join(', ')}`);
  noticeLines.push('');
}
writeFileSync(join(qualification, 'THIRD-PARTY-NOTICES.md'), `${noticeLines.join('\n').trimEnd()}\n`);

const audit = JSON.parse(run('cargo', ['audit', '--json']));
if (audit.vulnerabilities?.found !== false || audit.vulnerabilities?.count !== 0) {
  throw new Error('cargo audit reported a vulnerability');
}
writeFileSync(join(qualification, 'advisories.json'), stableJson({
  cargoAudit: run('cargo', ['audit', '--version']).trim(),
  report: audit,
}));

if (!existsSync(join(qualification, 'sbom.json'))) throw new Error('SBOM generation failed');
