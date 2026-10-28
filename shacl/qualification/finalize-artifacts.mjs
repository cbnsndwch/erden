// The mint: copies the binaries of one shacl-build workflow run into the four platform packages, byte for byte, and
// writes everything that pins them: each package's metadata.json, the resolver's anchors
// (shacl/distribution/src/artifacts.js), and shacl/qualification/binary-reproducibility.json. Every input is checked
// first: both clean builds of each target identical, the known answer present, the Cargo.lock the qualified one, the
// source commit's shacl/ tree the one recorded, and the binary the one the record names.
//
//   node shacl/qualification/finalize-artifacts.mjs --artifacts <dir with shacl-<target>/ folders> --run-id <id>
//        --determinism <dir with comparison.json>
//   node shacl/qualification/finalize-artifacts.mjs --check
//
// `--check` refuses unless the committed packages, anchors and record are exactly what the record describes (a CI
// gate, with no artifacts needed), and unless no binary is committed. The binaries are never committed (shacl/*/bin/
// is ignored): the mint writes them into the packages for packing and qualification only. `--check` verifies each
// binary that is present (built by build-from-source.mjs, or later installed from the tools release, TS-6).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { CARGO_LOCK_SHA256, LINUX_BUILDER_IMAGE, RUST_TOOLCHAIN, executableName } from './verify-binary-reproducible.mjs';

const qualification = import.meta.dirname;
const shacl = resolve(qualification, '..');
const repository = resolve(shacl, '..');
export const PACKAGE_VERSION = '0.1.0+purrdf.3.0.1';

export const PLATFORMS = Object.freeze([
    {
        key: 'linux:x64:glibc',
        directory: 'linux-x64-gnu',
        packageName: '@erden/shacl-linux-x64-gnu',
        description: 'Qualified Erden SHACL engine for Linux x64 (glibc)',
        runtime: { os: 'linux', cpu: 'x64', libc: 'glibc' },
        target: 'x86_64-unknown-linux-gnu',
        runner: 'ubuntu-24.04',
    },
    {
        key: 'linux:arm64:glibc',
        directory: 'linux-arm64-gnu',
        packageName: '@erden/shacl-linux-arm64-gnu',
        description: 'Qualified Erden SHACL engine for Linux arm64 (glibc)',
        runtime: { os: 'linux', cpu: 'arm64', libc: 'glibc' },
        target: 'aarch64-unknown-linux-gnu',
        runner: 'ubuntu-24.04-arm',
    },
    {
        key: 'darwin:arm64',
        directory: 'darwin-arm64',
        packageName: '@erden/shacl-darwin-arm64',
        description: 'Qualified Erden SHACL engine for macOS arm64 (Apple silicon)',
        runtime: { os: 'darwin', cpu: 'arm64' },
        target: 'aarch64-apple-darwin',
        runner: 'macos-15',
    },
    {
        key: 'win32:x64',
        directory: 'win32-x64-msvc',
        packageName: '@erden/shacl-win32-x64-msvc',
        description: 'Qualified Erden SHACL engine for Windows x64 (MSVC)',
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
    throw new Error(`erden-shacl mint refused: ${message}`);
}

function anchorsModule(entries, engine, fixtureDigest) {
    const lines = [
        '// Written by shacl/qualification/finalize-artifacts.mjs from the shacl-build run recorded in',
        '// shacl/qualification/binary-reproducibility.json. Do not edit by hand.',
        `export const PACKAGE_VERSION = '${PACKAGE_VERSION}';`,
        `export const ENGINE_DIGEST = '${engine}';`,
        `export const KNOWN_ANSWER_FIXTURE_DIGEST = '${fixtureDigest}';`,
        'export const QUALIFIED_ARTIFACTS = Object.freeze({',
    ];
    for (const entry of entries) {
        lines.push(
            `    '${entry.key}': Object.freeze({`,
            `        packageName: '${entry.packageName}',`,
            `        description: '${entry.description}',`,
            `        runtime: Object.freeze(${JSON.stringify(entry.runtime).replaceAll('"', "'").replaceAll(',', ', ').replaceAll(':', ': ').replace('{', '{ ').replace(/\}$/u, ' }')}),`,
            `        target: '${entry.target}',`,
            `        binaryPath: 'bin/${executableName(entry.target)}',`,
            `        bytes: ${entry.bytes === null ? 'null' : String(entry.bytes)},`,
            `        sha256: ${entry.sha256 === null ? 'null' : `'${entry.sha256}'`},`,
            `        responseBytes: ${entry.responseBytes === null ? 'null' : String(entry.responseBytes)},`,
            `        responseSha256: ${entry.responseSha256 === null ? 'null' : `'${entry.responseSha256}'`},`,
            '    }),',
        );
    }
    lines.push('});', '');
    return lines.join('\n');
}

function metadataOf(entry, engine) {
    return `${JSON.stringify(
        {
            schemaVersion: 1,
            packageName: entry.packageName,
            packageVersion: PACKAGE_VERSION,
            tool: { name: 'erden-shacl', version: PACKAGE_VERSION, engineDigest: engine },
            runtime: entry.runtime,
            target: entry.target,
            binary: { path: `bin/${executableName(entry.target)}`, bytes: entry.bytes, sha256: entry.sha256 },
            knownAnswer: { fixture: 'core-and-sparql', responseBytes: entry.responseBytes, responseSha256: entry.responseSha256 },
        },
        null,
        2,
    )}\n`;
}

function main() {
    const { values } = parseArgs({ options: { artifacts: { type: 'string' }, 'run-id': { type: 'string' }, check: { type: 'boolean', default: false }, determinism: { type: 'string' } } });
    const fixture = readFileSync(join(shacl, 'distribution/fixtures/known-answer.request.json'), 'utf8');
    const engine = JSON.parse(fixture).requiredTool.engineDigest;
    if (values.check) {
        const record = JSON.parse(readFileSync(join(qualification, 'binary-reproducibility.json'), 'utf8'));
        const entries = PLATFORMS.map((platform) => {
            const built = record.targets[platform.target];
            const binary = join(shacl, platform.directory, 'bin', executableName(platform.target));
            if (built.runs.length !== 2 || built.runs[0].sha256 !== built.runs[1].sha256 || built.runs[0].bytes !== built.runs[1].bytes) {
                fail(`${platform.target}: the record does not hold two identical clean builds`);
            }
            // A binary is present only when built from source (build-from-source.mjs) or installed from a release.
            if (existsSync(binary)) {
                const bytes = readFileSync(binary);
                if (sha256(bytes) !== built.runs[0].sha256 || bytes.length !== built.runs[0].bytes) fail(`${platform.directory} binary is not the minted one`);
            }
            return { ...platform, bytes: built.runs[0].bytes, sha256: built.runs[0].sha256, responseBytes: built.knownAnswer.responseBytes, responseSha256: built.knownAnswer.responseSha256 };
        });
        if (readFileSync(join(shacl, 'distribution/src/artifacts.js'), 'utf8') !== anchorsModule(entries, engine, sha256(fixture))) fail('the resolver anchors differ from the record');
        for (const entry of entries) {
            if (readFileSync(join(shacl, entry.directory, 'metadata.json'), 'utf8') !== metadataOf(entry, engine)) fail(`${entry.directory}/metadata.json differs from the record`);
        }
        const determinism = record.crossPlatformDeterminism;
        if (
            determinism?.result !== 'identical' ||
            JSON.stringify(Object.values(determinism.executables).sort()) !== JSON.stringify(entries.map((entry) => entry.sha256).sort())
        ) {
            fail('the record lacks an identical cross-platform determinism comparison of the minted binaries');
        }
        if (git('rev-parse', 'HEAD:shacl/erden-shacl') !== record.crateSourceTree || sha256(readFileSync(join(shacl, 'Cargo.lock'))) !== record.cargoLockDigest) {
            fail('the committed crate or lock is not the minted source');
        }
        const committed = PLATFORMS.map((platform) => `shacl/${platform.directory}/bin`);
        if (git('ls-files', '--', ...committed) !== '') fail('a binary is committed; the packages carry only their pins');
        console.log('erden-shacl packages, anchors and record agree with the mint');
        return;
    }
    if (values.artifacts === undefined || values['run-id'] === undefined || values.determinism === undefined) {
        throw new Error('Usage: finalize-artifacts.mjs --artifacts <dir> --run-id <id> --determinism <dir> | --check');
    }
    const comparison = JSON.parse(readFileSync(join(resolve(values.determinism), 'comparison.json'), 'utf8'));
    if (comparison.identical !== true || comparison.platforms.length !== PLATFORMS.length || comparison.differences.length !== 0) {
        fail('the cross-platform determinism comparison is not identical on all four platforms');
    }
    const targets = {};
    const entries = PLATFORMS.map((platform) => {
        const folder = join(resolve(values.artifacts), `shacl-${platform.target}`);
        const record = JSON.parse(readFileSync(join(folder, `${platform.target}.json`), 'utf8'));
        const binary = join(folder, platform.target, executableName(platform.target));
        const bytes = readFileSync(binary);
        if (record.result !== 'byte-identical' || record.runs.length !== 2 || record.runs[0].sha256 !== record.runs[1].sha256) fail(`${platform.target}: the two clean builds differ`);
        if (sha256(bytes) !== record.runs[0].sha256) fail(`${platform.target}: the uploaded binary is not the built one`);
        if (record.cargoLockDigest !== CARGO_LOCK_SHA256 || JSON.stringify(record.toolchain) !== JSON.stringify(RUST_TOOLCHAIN)) fail(`${platform.target}: not the qualified lock or toolchain`);
        if (platform.runtime.os === 'linux' && record.builderImage !== LINUX_BUILDER_IMAGE) fail(`${platform.target}: not the pinned builder image`);
        // The source commit is GitHub's pull-request merge commit; its crate tree must be this checkout's.
        if (record.crateSourceTree !== git('rev-parse', 'HEAD:shacl/erden-shacl')) {
            fail(`${platform.target}: built from a crate other than this checkout's`);
        }
        const destination = join(shacl, platform.directory, 'bin', executableName(platform.target));
        mkdirSync(join(shacl, platform.directory, 'bin'), { recursive: true });
        copyFileSync(binary, destination);
        // Every binary is committed as 100755, Windows's too: pnpm marks package bins executable on install, so any
        // other mode would leave the checkout modified after `pnpm install`.
        chmodSync(destination, 0o755);
        targets[platform.target] = { ...record, runner: platform.runner, workflowRunId: Number(values['run-id']), package: `shacl/${platform.directory}/bin/${executableName(platform.target)}` };
        return { ...platform, bytes: statSync(destination).size, sha256: record.runs[0].sha256, responseBytes: record.knownAnswer.responseBytes, responseSha256: record.knownAnswer.responseSha256 };
    });
    const commits = new Set(Object.values(targets).map((record) => record.sourceCommit));
    if (commits.size !== 1) fail('the four targets were built from different commits');
    for (const entry of entries) writeFileSync(join(shacl, entry.directory, 'metadata.json'), metadataOf(entry, engine));
    writeFileSync(join(shacl, 'distribution/src/artifacts.js'), anchorsModule(entries, engine, sha256(fixture)));
    const [sourceCommit] = commits;
    const minted = new Set(entries.map((entry) => entry.sha256));
    const compared = new Set(comparison.platforms.map((platform) => platform.executableDigest));
    if (compared.size !== minted.size || ![...compared].every((digest) => minted.has(digest))) {
        fail('the determinism comparison ran binaries other than the minted ones');
    }
    writeFileSync(
        join(qualification, 'binary-reproducibility.json'),
        `${JSON.stringify(
            {
                schemaVersion: 1,
                tool: { name: 'erden-shacl', version: PACKAGE_VERSION, engineDigest: engine },
                workflow: '.github/workflows/shacl-build.yml',
                workflowRunId: Number(values['run-id']),
                sourceCommit,
                sourceCommitNote: 'pull request merge commit on GitHub; its shacl/ tree is the recorded one',
                crateSourceTree: targets['x86_64-unknown-linux-gnu'].crateSourceTree,
                cargoLockDigest: CARGO_LOCK_SHA256,
                toolchain: RUST_TOOLCHAIN,
                linuxBuilderImage: LINUX_BUILDER_IMAGE,
                targets,
                crossPlatformDeterminism: {
                    result: 'identical',
                    requests: comparison.requests,
                    excludedFields: ['tool.executableDigest'],
                    executables: Object.fromEntries(entries.map((entry) => [entry.target, entry.sha256])),
                },
            },
            null,
            2,
        )}\n`,
    );
    if (!existsSync(join(shacl, 'distribution/src/artifacts.js'))) fail('anchors not written');
    console.log(entries.map((entry) => `${entry.directory}: ${entry.sha256} (${String(entry.bytes)} bytes)`).join('\n'));
}

if (import.meta.main) main();
