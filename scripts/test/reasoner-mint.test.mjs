import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';

import { PACKAGE_VERSION, REASONER_TOOL } from '../../reasoner/distribution/src/index.js';
import {
    PLATFORMS,
    anchorsModule,
    assertBuildRecord,
    distributionManifestOf,
    manifestOf,
    metadataOf,
    writePlatformPackage,
} from '../../reasoner/qualification/finalize-artifacts.mjs';
import { LINUX_BUILDER_IMAGE, RUST_TOOLCHAIN } from '../../reasoner/qualification/verify-binary-reproducible.mjs';
import { OPEN_WORKSPACE_PROFILE, platformManifest, withMintedReasoner } from '../lib/workspace-guard.mjs';

const root = resolve(import.meta.dirname, '../..');
const linux = PLATFORMS.find((platform) => platform.target === 'x86_64-unknown-linux-gnu');

function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function record(binary, changes = {}) {
    const run = { bytes: binary.length, sha256: sha256(binary) };
    return {
        result: 'byte-identical',
        target: linux.target,
        runs: [run, run],
        toolchain: RUST_TOOLCHAIN,
        cargoLockDigest: sha256(readFileSync(resolve(root, 'reasoner/Cargo.lock'))),
        builderImage: LINUX_BUILDER_IMAGE,
        adapterCrateSourceTree: 'tree',
        knownAnswer: { fixture: 'subclass-type', responseBytes: 10, responseSha256: sha256('answer') },
        ...changes,
    };
}

test('the committed anchors are unpinned before the first mint, or agree with its verified record', () => {
    if (existsSync(resolve(root, 'reasoner/qualification/mint.json'))) {
        const checked = spawnSync(
            process.execPath,
            [resolve(root, 'reasoner/qualification/finalize-artifacts.mjs'), '--check'],
            { encoding: 'utf8' },
        );
        assert.equal(checked.status, 0, checked.stderr || checked.stdout);
        return;
    }
    const unpinned = PLATFORMS.map((platform) => ({
        ...platform,
        bytes: null,
        sha256: null,
        responseBytes: null,
        responseSha256: null,
    }));
    assert.equal(
        readFileSync(resolve(root, 'reasoner/distribution/src/artifacts.js'), 'utf8'),
        anchorsModule(unpinned),
    );
});

test('a first mint creates complete Apache source packages without the old platform directories', (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'erden-first-mint-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const profile = withMintedReasoner(OPEN_WORKSPACE_PROFILE);
    const sourceIgnore = existsSync(join(root, 'scripts/open-tree/root/.gitignore'))
        ? join(root, 'scripts/open-tree/root/.gitignore')
        : join(root, '.gitignore');
    writeFileSync(join(directory, '.gitignore'), readFileSync(sourceIgnore));
    execFileSync('git', ['-C', directory, 'init', '-q']);
    for (const platform of PLATFORMS) {
        const entry = {
            ...platform,
            bytes: 3,
            sha256: sha256('bin'),
            responseBytes: 10,
            responseSha256: sha256('answer'),
        };
        const output = join(directory, 'reasoner', platform.directory);
        mkdirSync(join(output, 'test'), { recursive: true });
        writeFileSync(join(output, 'test/index.test.ts'), 'stale old-release expectations');
        writePlatformPackage(entry, join(directory, 'reasoner'));
        const manifest = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));
        assert.deepEqual(manifest, platformManifest(profile.platformPackages.get(`reasoner/${platform.directory}`)));
        for (const file of manifest.files.filter((file) => file !== 'bin')) {
            assert.ok(existsSync(join(output, file)), `${platform.directory} is missing ${file}`);
        }
        assert.equal(
            readFileSync(join(output, 'LICENSE'), 'utf8'),
            readFileSync(join(root, 'reasoner/qualification/ERDEN-LICENSE-APACHE-2.0.txt'), 'utf8'),
        );
        assert.match(readFileSync(join(output, 'NOTICE'), 'utf8'), /Apache License/u);
        assert.match(readFileSync(join(output, 'test/index.test.ts'), 'utf8'), /testPlatformPackage/u);
        assert.equal(existsSync(join(output, 'bin')), false);
        const binary = join(
            output,
            'bin',
            platform.target.endsWith('windows-msvc') ? 'erden-reasoner.exe' : 'erden-reasoner',
        );
        mkdirSync(join(output, 'bin'));
        writeFileSync(binary, 'not an executable; fixture only');
        assert.equal(
            spawnSync('git', ['-C', directory, 'check-ignore', '--no-index', binary]).status,
            0,
            `${platform.directory} must ignore binaries`,
        );
    }
    execFileSync('git', ['-C', directory, 'add', '-A']);
    assert.equal(
        execFileSync('git', ['-C', directory, 'ls-files', '--', 'reasoner/*/bin/*'], { encoding: 'utf8' }),
        '',
    );
});

test('the mint writes platform packages in the shape the resolver accepts, naming the shipped tool', () => {
    const entry = { ...linux, bytes: 3, sha256: sha256('bin'), responseBytes: 10, responseSha256: sha256('answer') };
    const manifest = JSON.parse(manifestOf(entry));
    assert.deepEqual(Object.keys(manifest), [
        'name',
        'version',
        'description',
        'license',
        'bin',
        'files',
        'os',
        'cpu',
        'libc',
        'type',
        'engines',
    ]);
    assert.equal(manifest.version, PACKAGE_VERSION);
    const metadata = JSON.parse(metadataOf(entry));
    assert.deepEqual(metadata.tool, {
        name: 'erden-reasoner',
        version: PACKAGE_VERSION,
        adapterDigest: REASONER_TOOL.adapterDigest,
        calculusDigest: REASONER_TOOL.calculusDigest,
    });
    assert.deepEqual(metadata.binary, { path: 'bin/erden-reasoner', bytes: 3, sha256: sha256('bin') });
    const distribution = JSON.parse(
        distributionManifestOf(JSON.parse(readFileSync(resolve(root, 'reasoner/distribution/package.json'), 'utf8'))),
    );
    assert.deepEqual(
        distribution.optionalDependencies,
        Object.fromEntries(
            PLATFORMS.map((platform) => platform.packageName)
                .sort()
                .map((name) => [name, `workspace:${PACKAGE_VERSION}`]),
        ),
    );
});

test('the mint refuses a build that is not two identical clean builds of the qualified inputs', () => {
    const binary = Buffer.from('reasoner');
    assertBuildRecord(linux, record(binary), binary, 'tree');
    const other = { bytes: 8, sha256: sha256('other') };
    for (const [changes, pattern] of [
        [{ runs: [record(binary).runs[0], other] }, /two clean builds differ/u],
        [{ toolchain: { ...RUST_TOOLCHAIN, rustc: '0' } }, /not the qualified toolchain/u],
        [{ builderImage: 'rust:latest' }, /not the pinned builder image/u],
        [{ adapterCrateSourceTree: 'another' }, /an adapter crate other than this checkout's/u],
        [{ cargoLockDigest: sha256('lock') }, /not this checkout's Cargo\.lock/u],
    ]) {
        assert.throws(() => assertBuildRecord(linux, record(binary, changes), binary, 'tree'), pattern);
    }
    assert.throws(
        () => assertBuildRecord(linux, record(binary), Buffer.from('swapped!'), 'tree'),
        /not the built one/u,
    );
});
