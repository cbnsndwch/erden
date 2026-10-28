// The reasoner mint: from one reasoner-build workflow run (both clean builds of each of the four targets, and the
// cross-platform determinism comparison), writes everything that pins the release: each platform package's
// package.json and metadata.json, the resolver's anchors (reasoner/distribution/src/artifacts.js), the resolver's
// optional dependencies on the four packages, and the mint record (reasoner/qualification/mint.json). Every input is
// checked first: both builds of each target identical, the uploaded binary the recorded one, the qualified lock and
// toolchain, the pinned builder image on Linux, the adapter crate this checkout's, one source commit for all four, and
// the comparison identical over exactly the minted binaries. The binaries are never committed (reasoner/*/bin/ is
// ignored); the mint copies them into the packages for packing and qualification only.
//
//   node reasoner/qualification/finalize-artifacts.mjs --artifacts <dir with reasoner-<target>/ folders>
//        --determinism <dir with comparison.json> --run-id <id>
//   node reasoner/qualification/finalize-artifacts.mjs --check
//
// `--check` refuses unless the committed packages, anchors, optional dependencies and record are exactly what the
// record describes, and no binary is committed; it verifies each binary that is present. Before the first mint of a
// version (no record) it checks that every anchor is still unpinned.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PACKAGE_VERSION, REASONER_TOOL } from '../distribution/src/index.js';
import { LINUX_BUILDER_IMAGE, RUST_TOOLCHAIN, executableName } from './verify-binary-reproducible.mjs';

const qualification = import.meta.dirname;
const reasoner = resolve(qualification, '..');
const repository = resolve(reasoner, '..');

export const MINT_RECORD = join(qualification, 'mint.json');
const ANCHORS = join(reasoner, 'distribution/src/artifacts.js');
const DISTRIBUTION_MANIFEST = join(reasoner, 'distribution/package.json');

export const PLATFORMS = Object.freeze([
    {
        key: 'linux:x64:glibc',
        directory: 'linux-x64-gnu',
        packageName: '@erden/reasoner-linux-x64-gnu',
        description: 'Erden reasoner for Linux x64 (glibc)',
        runtime: { os: 'linux', cpu: 'x64', libc: 'glibc' },
        target: 'x86_64-unknown-linux-gnu',
        runner: 'ubuntu-24.04',
    },
    {
        key: 'linux:arm64:glibc',
        directory: 'linux-arm64-gnu',
        packageName: '@erden/reasoner-linux-arm64-gnu',
        description: 'Erden reasoner for Linux arm64 (glibc)',
        runtime: { os: 'linux', cpu: 'arm64', libc: 'glibc' },
        target: 'aarch64-unknown-linux-gnu',
        runner: 'ubuntu-24.04-arm',
    },
    {
        key: 'darwin:arm64',
        directory: 'darwin-arm64',
        packageName: '@erden/reasoner-darwin-arm64',
        description: 'Erden reasoner for macOS arm64 (Apple silicon)',
        runtime: { os: 'darwin', cpu: 'arm64' },
        target: 'aarch64-apple-darwin',
        runner: 'macos-15',
    },
    {
        key: 'win32:x64',
        directory: 'win32-x64-msvc',
        packageName: '@erden/reasoner-win32-x64-msvc',
        description: 'Erden reasoner for Windows x64 (MSVC)',
        runtime: { os: 'win32', cpu: 'x64' },
        target: 'x86_64-pc-windows-msvc',
        runner: 'windows-2025',
    },
]);

function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function git(...args) {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}
function fail(message) {
    throw new Error(`Reasoner mint refused: ${message}`);
}
function quoted(value) {
    return value === null ? 'null' : typeof value === 'number' ? String(value) : `'${value}'`;
}

/** The resolver anchors module for `entries` (a platform with null pins is not released). */
export function anchorsModule(entries) {
    const lines = [
        '// Written by reasoner/qualification/finalize-artifacts.mjs from the reasoner-build run recorded in',
        '// reasoner/qualification/mint.json. Do not edit by hand. A platform whose pins are null has no released binary.',
        'export const QUALIFIED_REASONER_ARTIFACTS = Object.freeze({',
    ];
    for (const entry of entries) {
        const runtime = Object.entries(entry.runtime)
            .map(([key, value]) => `${key}: '${value}'`)
            .join(', ');
        lines.push(
            `    '${entry.key}': Object.freeze({`,
            `        packageName: '${entry.packageName}',`,
            `        description: '${entry.description}',`,
            `        runtime: Object.freeze({ ${runtime} }),`,
            `        target: '${entry.target}',`,
            `        binaryPath: 'bin/${executableName(entry.target)}',`,
            `        bytes: ${quoted(entry.bytes)},`,
            `        sha256: ${quoted(entry.sha256)},`,
            `        responseBytes: ${quoted(entry.responseBytes)},`,
            `        responseSha256: ${quoted(entry.responseSha256)},`,
            '    }),',
        );
    }
    lines.push('});', '');
    return lines.join('\n');
}

/** A platform package's manifest, in the shape the resolver accepts. */
export function manifestOf(entry) {
    return `${JSON.stringify(
        {
            name: entry.packageName,
            version: PACKAGE_VERSION,
            description: entry.description,
            license: 'Apache-2.0',
            bin: { 'erden-reasoner': `bin/${executableName(entry.target)}` },
            files: ['bin', 'metadata.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'],
            os: [entry.runtime.os],
            cpu: [entry.runtime.cpu],
            ...(entry.runtime.libc === undefined ? {} : { libc: [entry.runtime.libc] }),
            type: 'module',
            engines: { node: '^24' },
        },
        null,
        4,
    )}\n`;
}

/** A platform package's qualification metadata. */
export function metadataOf(entry) {
    return `${JSON.stringify(
        {
            schemaVersion: 1,
            packageName: entry.packageName,
            packageVersion: PACKAGE_VERSION,
            tool: {
                name: 'erden-reasoner',
                version: PACKAGE_VERSION,
                adapterDigest: REASONER_TOOL.adapterDigest,
                calculusDigest: REASONER_TOOL.calculusDigest,
            },
            runtime: entry.runtime,
            target: entry.target,
            binary: { path: `bin/${executableName(entry.target)}`, bytes: entry.bytes, sha256: entry.sha256 },
            knownAnswer: {
                fixture: 'subclass-type',
                responseBytes: entry.responseBytes,
                responseSha256: entry.responseSha256,
            },
        },
        null,
        2,
    )}\n`;
}

/** Creates a complete source package even when the public extraction has no earlier platform directory. */
export function writePlatformPackage(entry, outputReasoner = reasoner) {
    const directory = join(outputReasoner, entry.directory);
    mkdirSync(join(directory, 'test'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), manifestOf(entry));
    writeFileSync(join(directory, 'metadata.json'), metadataOf(entry));
    writeFileSync(join(directory, 'README.md'), `# ${entry.description}\n\nThe binary is distributed through Erden's GitHub Releases and is never committed.\n`);
    copyFileSync(join(qualification, 'ERDEN-LICENSE-APACHE-2.0.txt'), join(directory, 'LICENSE'));
    copyFileSync(join(repository, 'NOTICE'), join(directory, 'NOTICE'));
    copyFileSync(join(qualification, 'THIRD-PARTY-NOTICES.md'), join(directory, 'THIRD-PARTY-NOTICES.md'));
    writeFileSync(join(directory, 'test/index.test.ts'), "import { testPlatformPackage } from '../../distribution/test/platform.js';\n\ntestPlatformPackage(new URL('../', import.meta.url));\n");
}

/** The resolver's manifest with optional dependencies on the four released platform packages. */
export function distributionManifestOf(current) {
    const manifest = { ...current };
    delete manifest.optionalDependencies;
    const ordered = {};
    for (const [key, value] of Object.entries(manifest)) {
        ordered[key] = value;
        if (key === 'exports') {
            ordered.optionalDependencies = Object.fromEntries(
                PLATFORMS.map((platform) => platform.packageName)
                    .sort()
                    .map((name) => [name, `workspace:${PACKAGE_VERSION}`]),
            );
        }
    }
    return `${JSON.stringify(ordered, null, 4)}\n`;
}

/** Refuses a build record that is not two identical clean builds of the qualified inputs from this adapter crate. */
export function assertBuildRecord(platform, record, binaryBytes, adapterTree) {
    if (record.result !== 'byte-identical' || record.runs?.length !== 2 || record.runs[0].sha256 !== record.runs[1].sha256) {
        fail(`${platform.target}: the two clean builds differ`);
    }
    if (record.target !== platform.target) fail(`${platform.target}: the record is for ${String(record.target)}`);
    if (sha256(binaryBytes) !== record.runs[0].sha256 || binaryBytes.length !== record.runs[0].bytes) {
        fail(`${platform.target}: the uploaded binary is not the built one`);
    }
    if (JSON.stringify(record.toolchain) !== JSON.stringify(RUST_TOOLCHAIN)) fail(`${platform.target}: not the qualified toolchain`);
    if (record.cargoLockDigest !== sha256(readFileSync(join(reasoner, 'Cargo.lock')))) fail(`${platform.target}: not this checkout's Cargo.lock`);
    if (platform.runtime.os === 'linux' && record.builderImage !== LINUX_BUILDER_IMAGE) fail(`${platform.target}: not the pinned builder image`);
    if (record.adapterCrateSourceTree !== adapterTree) fail(`${platform.target}: built from an adapter crate other than this checkout's`);
    if (record.knownAnswer?.fixture !== 'subclass-type' || !Number.isSafeInteger(record.knownAnswer.responseBytes)) {
        fail(`${platform.target}: no known answer`);
    }
}

function entriesOf(targets) {
    return PLATFORMS.map((platform) => {
        const record = targets?.[platform.target];
        return {
            ...platform,
            bytes: record?.runs[0].bytes ?? null,
            sha256: record?.runs[0].sha256 ?? null,
            responseBytes: record?.knownAnswer.responseBytes ?? null,
            responseSha256: record?.knownAnswer.responseSha256 ?? null,
        };
    });
}

function check() {
    const anchors = readFileSync(ANCHORS, 'utf8');
    if (!existsSync(MINT_RECORD)) {
        if (anchors !== anchorsModule(entriesOf(undefined))) fail('the anchors carry pins but no mint record exists');
        console.log(`reasoner ${PACKAGE_VERSION} is not minted yet; every anchor is unpinned`);
        return;
    }
    const record = JSON.parse(readFileSync(MINT_RECORD, 'utf8'));
    if (record.tool?.version !== PACKAGE_VERSION) fail('the mint record is for another version');
    const entries = entriesOf(record.targets);
    if (anchors !== anchorsModule(entries)) fail('the resolver anchors differ from the record');
    for (const entry of entries) {
        if (readFileSync(join(reasoner, entry.directory, 'metadata.json'), 'utf8') !== metadataOf(entry)) {
            fail(`${entry.directory}/metadata.json differs from the record`);
        }
        if (readFileSync(join(reasoner, entry.directory, 'package.json'), 'utf8') !== manifestOf(entry)) {
            fail(`${entry.directory}/package.json differs from the record`);
        }
        const binary = join(reasoner, entry.directory, 'bin', executableName(entry.target));
        if (existsSync(binary)) {
            const bytes = readFileSync(binary);
            if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) fail(`${entry.directory} binary is not the minted one`);
        }
    }
    const distribution = readFileSync(DISTRIBUTION_MANIFEST, 'utf8');
    if (distribution !== distributionManifestOf(JSON.parse(distribution))) fail('the resolver does not depend on exactly the four platform packages');
    const determinism = record.crossPlatformDeterminism;
    if (
        determinism?.result !== 'identical' ||
        JSON.stringify(Object.values(determinism.executables).sort()) !== JSON.stringify(entries.map((entry) => entry.sha256).sort())
    ) {
        fail('the record lacks an identical cross-platform determinism comparison of the minted binaries');
    }
    if (git('rev-parse', 'HEAD:reasoner/erden-reasoner') !== record.adapterCrateSourceTree || sha256(readFileSync(join(reasoner, 'Cargo.lock'))) !== record.cargoLockDigest) {
        fail('the committed adapter crate or lock is not the minted source');
    }
    const committed = PLATFORMS.map((platform) => `reasoner/${platform.directory}/bin`);
    if (git('ls-files', '--', ...committed) !== '') fail('a binary is committed; the packages carry only their pins');
    console.log(`reasoner ${PACKAGE_VERSION} packages, anchors and record agree with the mint`);
}

function mint(values) {
    const comparison = JSON.parse(readFileSync(join(resolve(values.determinism), 'comparison.json'), 'utf8'));
    if (comparison.result !== 'identical' || Object.keys(comparison.platforms ?? {}).length !== PLATFORMS.length) {
        fail('the cross-platform determinism comparison is not identical on all four platforms');
    }
    const adapterTree = git('rev-parse', 'HEAD:reasoner/erden-reasoner');
    const targets = {};
    for (const platform of PLATFORMS) {
        const folder = join(resolve(values.artifacts), `reasoner-${platform.target}`);
        const record = JSON.parse(readFileSync(join(folder, `${platform.target}.json`), 'utf8'));
        const binary = join(folder, platform.target, executableName(platform.target));
        const bytes = readFileSync(binary);
        assertBuildRecord(platform, record, bytes, adapterTree);
        const compared = comparison.platforms[platform.target]?.binary;
        if (compared?.sha256 !== record.runs[0].sha256) {
            fail(`${platform.target}: the determinism comparison ran another binary`);
        }
        const destination = join(reasoner, platform.directory, 'bin', executableName(platform.target));
        mkdirSync(join(reasoner, platform.directory, 'bin'), { recursive: true });
        copyFileSync(binary, destination);
        chmodSync(destination, 0o755);
        targets[platform.target] = { ...record, runner: platform.runner, workflowRunId: Number(values['run-id']) };
    }
    const commits = new Set(Object.values(targets).map((record) => record.qualificationSourceCommit));
    if (commits.size !== 1) fail('the four targets were built from different commits');
    const entries = entriesOf(targets);
    for (const entry of entries) {
        writePlatformPackage(entry);
    }
    writeFileSync(ANCHORS, anchorsModule(entries));
    writeFileSync(DISTRIBUTION_MANIFEST, distributionManifestOf(JSON.parse(readFileSync(DISTRIBUTION_MANIFEST, 'utf8'))));
    const [sourceCommit] = commits;
    writeFileSync(
        MINT_RECORD,
        `${JSON.stringify(
            {
                schemaVersion: 1,
                tool: REASONER_TOOL,
                workflow: '.github/workflows/reasoner-build.yml',
                workflowRunId: Number(values['run-id']),
                sourceCommit,
                adapterCrateSourceTree: adapterTree,
                cargoLockDigest: sha256(readFileSync(join(reasoner, 'Cargo.lock'))),
                toolchain: RUST_TOOLCHAIN,
                linuxBuilderImage: LINUX_BUILDER_IMAGE,
                targets,
                crossPlatformDeterminism: {
                    result: 'identical',
                    requestCount: comparison.requestCount,
                    requestsManifestSha256: comparison.requestsManifestSha256,
                    excludedFields: ['tool.executableDigest'],
                    executables: Object.fromEntries(entries.map((entry) => [entry.target, entry.sha256])),
                },
            },
            null,
            2,
        )}\n`,
    );
    console.log(entries.map((entry) => `${entry.directory}: ${entry.sha256} (${String(entry.bytes)} bytes)`).join('\n'));
}

function main() {
    const { values } = parseArgs({
        options: {
            artifacts: { type: 'string' },
            determinism: { type: 'string' },
            'run-id': { type: 'string' },
            check: { type: 'boolean', default: false },
        },
    });
    if (values.check) return check();
    if (values.artifacts === undefined || values.determinism === undefined || values['run-id'] === undefined) {
        throw new Error('Usage: finalize-artifacts.mjs --artifacts <dir> --determinism <dir> --run-id <id> | --check');
    }
    return mint(values);
}

if (import.meta.main) main();
