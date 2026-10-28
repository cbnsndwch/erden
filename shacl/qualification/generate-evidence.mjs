// Writes the dependency and license evidence of `erden-shacl` from the exact locked normal and build graph:
// `sbom.json` (CycloneDX 1.6), `dependency-tree.txt`, `THIRD-PARTY-NOTICES.md` and `licenses/` (every upstream
// license file byte for byte, named by its SHA-256), and `advisories.json` when `cargo audit` is installed.
//
//   node shacl/qualification/generate-evidence.mjs [--check]
//
// `--check` regenerates into memory and fails if any committed file differs. The license policy is the reasoner's
// rule set (`reasoner/qualification/license-policy.mjs`) applied to `shacl/qualification/license-policy.json`, which
// adds PurRDF 3.x's `MIT OR Apache-2.0 OR MulanPSL-2.0` with the election `MIT` and refuses MulanPSL-only terms.
// Derived from `reasoner/qualification/generate-evidence.mjs`; the two crates' evidence stays separate.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { selectLicenses } from '../../reasoner/qualification/license-policy.mjs';

const qualification = import.meta.dirname;
const workspace = resolve(qualification, '..');
const policy = JSON.parse(readFileSync(join(qualification, 'license-policy.json'), 'utf8'));
const check = process.argv.includes('--check');

function hash(input) {
    return createHash('sha256').update(input).digest('hex');
}
function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
function run(command, args) {
    return execFileSync(command, args, { cwd: workspace, encoding: 'utf8', windowsHide: true }).replaceAll('\r\n', '\n');
}

// The four shipped targets; `Cargo.lock` also locks crates only other targets build (UEFI, WASI, WebAssembly).
export const TARGETS = Object.freeze([
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc',
    'aarch64-apple-darwin',
]);
const metadata = JSON.parse(
    run('cargo', [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        ...TARGETS.flatMap((target) => ['--filter-platform', target]),
    ]),
);
const rootId = metadata.packages.find((item) => item.name === 'erden-shacl' && item.source === null)?.id;
if (rootId === undefined) throw new Error('Cargo metadata has no erden-shacl workspace root');
const lock = readFileSync(join(workspace, 'Cargo.lock'));
const lockPackages = new Map();
for (const block of lock.toString('utf8').split(/\n\[\[package\]\]\n/u).slice(1)) {
    const field = (name) => block.match(new RegExp(`^${name} = "([^"]+)"$`, 'mu'))?.[1];
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
    if (id === undefined || includedIds.has(id)) continue;
    includedIds.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
        if (dependency.dep_kinds.some((kind) => kind.kind === null || kind.kind === 'normal' || kind.kind === 'build')) {
            pending.push(dependency.pkg);
        }
    }
}

const licenseNames = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/iu;
function findLicenseFiles(item) {
    let directory = dirname(item.manifest_path);
    const found = [];
    const maximumDepth = item.source?.startsWith('registry+') === true ? 1 : 5;
    for (let depth = 0; depth < maximumDepth; depth += 1) {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (licenseNames.test(name) && statSync(path).isFile()) found.push(path);
            // PurRDF ships its license texts, third-party ones included, under a `licenses/` directory.
            if (/^licen[cs]es$/iu.test(name) && statSync(path).isDirectory()) {
                for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
                    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
                }
            }
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return [...new Set(found)].sort();
}

const packageById = new Map(metadata.packages.filter((item) => includedIds.has(item.id)).map((item) => [item.id, item]));
const unbuilt = [...lockPackages.keys()]
    .filter((key) => ![...packageById.values()].some((item) => `${item.name}@${item.version}` === key))
    .sort();
const stableRefById = new Map(
    [...packageById.values()].map((item) => [
        item.id,
        `pkg:cargo/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
    ]),
);

const files = new Map();
const licenseTexts = new Map();
const records = [...packageById.values()]
    .map((item) => {
        const locked = lockPackages.get(`${item.name}@${item.version}`);
        if (locked === undefined) throw new Error(`Package missing from Cargo.lock: ${item.name}@${item.version}`);
        const selectedLicenses = selectLicenses(item.license, policy, `${item.name}@${item.version}`);
        const sources =
            item.source === null
                ? [join(workspace, '..', 'reasoner', 'qualification', 'ERDEN-LICENSE-APACHE-2.0.txt')]
                : findLicenseFiles(item);
        const licenseFiles = sources.map((sourcePath) => {
            const bytes = readFileSync(sourcePath);
            const digest = hash(bytes);
            licenseTexts.set(`licenses/${digest}.txt`, bytes);
            return {
                originalName: basename(sourcePath),
                path: `licenses/${digest}.txt`,
                sha256: `sha256:${digest}`,
                text: bytes.toString('utf8'),
            };
        });
        if (licenseFiles.length === 0) throw new Error(`No license file found for ${item.name}@${item.version}`);
        for (const identifier of selectedLicenses) {
            const markers = policy.completeTextMarkers[identifier];
            if (!Array.isArray(markers) || !licenseFiles.some((file) => markers.every((marker) => file.text.includes(marker)))) {
                throw new Error(`Complete ${identifier} terms not captured for ${item.name}@${item.version}`);
            }
        }
        const dependencyEdges = (nodes.get(item.id)?.deps ?? [])
            .flatMap((dependency) => {
                const kinds = dependency.dep_kinds
                    .map((kind) => kind.kind ?? 'normal')
                    .filter((kind) => kind === 'normal' || kind === 'build');
                return kinds.length === 0 ? [] : [{ ref: stableRefById.get(dependency.pkg), kinds: [...new Set(kinds)].sort() }];
            })
            .sort((left, right) => left.ref.localeCompare(right.ref));
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
    })
    .sort((left, right) => left.bomRef.localeCompare(right.bomRef));

const root = records.find((item) => item.bomRef === stableRefById.get(rootId));
const external = records.filter((item) => item !== root);
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
files.set(
    'sbom.json',
    stableJson({
        $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        metadata: {
            component: component(root, 'application'),
            properties: [
                { name: 'erden:cargo-lock-sha256', value: `sha256:${hash(lock)}` },
                { name: 'erden:purrdf-shapes-commit', value: 'dcd24b1cc56cd7ac24cbe0d38dcf5a89022eaccf' },
            ],
            tools: { components: [{ type: 'application', name: 'erden-shacl-evidence-generator', version: '1' }] },
        },
        components: external.map((item) => component(item, 'library')),
        dependencies: records.map((item) => ({ ref: item.bomRef, dependsOn: item.dependencyEdges.map((edge) => edge.ref) })),
    }),
);
files.set(
    'dependency-tree.txt',
    `${[
        `# Locked Cargo normal/build dependency graph of erden-shacl for ${TARGETS.join(', ')} (stable CycloneDX bom-ref identities)`,
        `# Locked but built by none of these targets: ${unbuilt.join(' ')}`,
        ...records.flatMap((item) =>
            item.dependencyEdges.length === 0
                ? [`${item.bomRef} ->`]
                : item.dependencyEdges.map((edge) => `${item.bomRef} -[${edge.kinds.join(',')}]-> ${edge.ref}`),
        ),
    ].join('\n')}\n`,
);
const notices = [
    '# Third-party notices for erden-shacl',
    '',
    'Generated by `shacl/qualification/generate-evidence.mjs` from the exact locked normal and build dependency graph. The license policy rejects unknown, denied or unlicensed dependencies and checks that the complete terms of every selected license are present. PurRDF 3.x is offered under `MIT OR Apache-2.0 OR MulanPSL-2.0`; Erden uses it under MIT (from MIT OR Apache-2.0). Each referenced upstream file is in `licenses/`, copied byte for byte and named by its SHA-256.',
    '',
];
for (const item of external) {
    notices.push(
        `- ${item.name} ${item.version}: declared \`${item.license}\`; selected ${item.selectedLicenses.map((license) => `\`${license}\``).join(' and ')}; ${item.licenseFiles.map((file) => `${file.path} (${file.originalName}, ${file.sha256})`).join(', ')}`,
        '',
    );
}
files.set('THIRD-PARTY-NOTICES.md', `${notices.join('\n').trimEnd()}\n`);

const audit = spawnSync('cargo', ['audit', '--version'], { cwd: workspace, encoding: 'utf8' });
if (audit.status === 0) {
    const report = JSON.parse(run('cargo', ['audit', '--json']));
    if (report.vulnerabilities?.found !== false) throw new Error('cargo audit reported a vulnerability');
    files.set('advisories.json', stableJson({ cargoAudit: audit.stdout.trim(), report }));
}

let differs = [];
if (check) {
    for (const [name, text] of files) {
        let committed = '';
        try {
            committed = readFileSync(join(qualification, name), 'utf8');
        } catch {
            committed = '';
        }
        if (name !== 'advisories.json' && committed !== text) differs.push(name);
    }
    for (const [path, bytes] of licenseTexts) {
        try {
            if (!readFileSync(join(qualification, path)).equals(bytes)) differs.push(path);
        } catch {
            differs.push(path);
        }
    }
    const committedLicenses = readdirSync(join(qualification, 'licenses')).map((name) => `licenses/${name}`);
    differs.push(...committedLicenses.filter((path) => !licenseTexts.has(path)));
    if (differs.length > 0) {
        throw new Error(`Committed evidence differs from the locked graph:\n${differs.join('\n')}`);
    }
    process.stdout.write(`erden-shacl evidence matches the locked graph (${external.length} crates)\n`);
} else {
    rmSync(join(qualification, 'licenses'), { force: true, recursive: true });
    mkdirSync(join(qualification, 'licenses'), { recursive: true });
    for (const [path, bytes] of licenseTexts) writeFileSync(join(qualification, path), bytes);
    for (const [name, text] of files) writeFileSync(join(qualification, name), text);
    process.stdout.write(`wrote erden-shacl evidence for ${external.length} crates\n`);
}
