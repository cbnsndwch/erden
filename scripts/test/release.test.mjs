import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { collectEntries, gzipBytes, tarBytes, writeArchive, zipBytes } from '../../release/lib/archive.mjs';
import { normalizeDeployedWorkspace } from '../../release/lib/deploy.mjs';
import { declaredLicense, writeNpmNotices } from '../../release/lib/notices.mjs';
import { RELEASE_PLATFORMS, archiveName, assertPinned, hostPlatform, sha256 } from '../../release/lib/platforms.mjs';
import { pinDifferences, pinsOf } from '../../release/pins.mjs';

const root = resolve(import.meta.dirname, '../..');
const YAML = createRequire(join(root, 'packages/contracts/package.json'))('yaml');

function temporary(prefix) {
    return mkdtempSync(join(tmpdir(), `erden-release-${prefix}-`));
}

function deploymentFixture(context, buildPath) {
    const directory = temporary('locked-deploy');
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = join(directory, 'source');
    const lib = join(directory, 'lib');
    function manifest(path, value) {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'package.json'), JSON.stringify(value));
    }
    mkdirSync(source);
    writeFileSync(join(source, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    const cli = {
        name: '@erden/cli',
        version: '0.1.0',
        license: 'Apache-2.0',
        dependencies: { '@erden/client': 'workspace:0.0.0', effect: '4.0.0-rc.111' },
    };
    const client = { name: '@erden/client', version: '0.0.0', license: 'Apache-2.0' };
    manifest(join(source, 'apps/cli'), cli);
    manifest(join(source, 'packages/client'), client);
    manifest(lib, {
        ...cli,
        dependencies: { '@erden/client': `@erden/client@file://${buildPath}/client`, effect: '4.0.0-rc.111' },
        pnpm: { patchedDependencies: { unused: `${buildPath}/patch` } },
    });
    manifest(join(lib, 'node_modules/@erden/client'), client);
    manifest(join(lib, 'node_modules/effect'), { name: 'effect', version: '4.0.0-rc.111', license: 'MIT' });
    writeFileSync(join(lib, 'pnpm-lock.yaml'), `temporary: ${buildPath}\n`);
    return {
        source,
        lib,
        manifest,
        lockfile: { packages: { 'effect@4.0.0-rc.111': { resolution: { integrity: 'fixture' } } } },
    };
}

test('locked deployment produces portable metadata independent of its temporary build path', (context) => {
    const first = deploymentFixture(context, '/build/a');
    const second = deploymentFixture(context, '/build/b');
    for (const fixture of [first, second]) {
        normalizeDeployedWorkspace(fixture.source, fixture.lib, fixture.lockfile);
        const manifest = JSON.parse(readFileSync(join(fixture.lib, 'package.json'), 'utf8'));
        assert.deepEqual(manifest.dependencies, { '@erden/client': '0.0.0', effect: '4.0.0-rc.111' });
        assert.equal(manifest.pnpm, undefined);
        assert.equal(existsSync(join(fixture.lib, 'pnpm-lock.yaml')), false);
    }
    assert.equal(
        readFileSync(join(first.lib, 'package.json'), 'utf8'),
        readFileSync(join(second.lib, 'package.json'), 'utf8'),
    );
});

test('locked deployment rejects a dependency version absent from the committed graph', (context) => {
    const fixture = deploymentFixture(context, '/build/a');
    fixture.manifest(join(fixture.lib, 'node_modules/effect'), { name: 'effect', version: '5.0.0', license: 'MIT' });
    assert.throws(
        () => normalizeDeployedWorkspace(fixture.source, fixture.lib, fixture.lockfile),
        /effect@5.0.0 outside its source lockfile/u,
    );
});

test('locked deployment refuses proprietary workspace packages before archiving', (context) => {
    const fixture = deploymentFixture(context, '/build/a');
    const application = { name: '@erden/application', version: '0.0.0', license: 'UNLICENSED' };
    fixture.manifest(join(fixture.source, 'packages/application'), application);
    fixture.manifest(join(fixture.lib, 'node_modules/@erden/application'), application);
    assert.throws(
        () => normalizeDeployedWorkspace(fixture.source, fixture.lib, fixture.lockfile),
        /non-open.*@erden\/application/u,
    );
});

function tree() {
    const directory = temporary('tree');
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'lib', 'node_modules', 'deep', 'a'.repeat(60), 'b'.repeat(60)), { recursive: true });
    writeFileSync(join(directory, 'bin', 'erden'), '#!/bin/sh\n');
    chmodSync(join(directory, 'bin', 'erden'), 0o775);
    writeFileSync(join(directory, 'LICENSE'), 'license\n');
    writeFileSync(join(directory, 'lib', 'node_modules', 'deep', 'a'.repeat(60), 'b'.repeat(60), 'index.js'), 'x\n');
    return directory;
}

test('archives of the same tree are byte-identical, sorted, with fixed owners, modes and times', () => {
    const directory = tree();
    const out = temporary('out');
    try {
        const first = writeArchive(directory, 'erden-1.0.0-linux-x64', join(out, 'a.tar.gz'), 1_700_000_000);
        chmodSync(join(directory, 'LICENSE'), 0o600);
        const second = writeArchive(directory, 'erden-1.0.0-linux-x64', join(out, 'b.tar.gz'), 1_700_000_000);
        assert.deepEqual(first, second);
        const listing = spawnSync('tar', ['-tvzf', join(out, 'a.tar.gz')], { encoding: 'utf8' });
        assert.equal(listing.status, 0, listing.stderr);
        const lines = listing.stdout.trim().split('\n');
        assert.match(
            lines.find((line) => line.endsWith('bin/erden')),
            /^-rwxr-xr-x 0\/0 /u,
        );
        assert.match(
            lines.find((line) => line.endsWith('/LICENSE')),
            /^-rw-r--r-- 0\/0 /u,
        );
        assert.ok(
            lines.some((line) => line.endsWith(`${'b'.repeat(60)}/index.js`)),
            'a long path survives as a pax record',
        );
        const gzip = readFileSync(join(out, 'a.tar.gz'));
        assert.deepEqual([...gzip.subarray(4, 10)], [0, 0, 0, 0, 2, 255]);
        const zip = zipBytes(collectEntries(directory, 'erden-1.0.0-win32-x64'), 1_700_000_000);
        assert.deepEqual(zip, zipBytes(collectEntries(directory, 'erden-1.0.0-win32-x64'), 1_700_000_000));
        assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
        assert.equal(
            gzipBytes(tarBytes(collectEntries(directory, 'p'), 1)).equals(
                gzipBytes(tarBytes(collectEntries(directory, 'p'), 2)),
            ),
            false,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
    }
});

test('an archive refuses symbolic links', () => {
    const directory = tree();
    try {
        symlinkSync('LICENSE', join(directory, 'link'));
        assert.throws(() => collectEntries(directory, 'p'), /symbolic link/u);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a pinned input is refused when one byte or its size differs', () => {
    const directory = temporary('pin');
    try {
        const path = join(directory, 'node.tar.xz');
        writeFileSync(path, 'runtime');
        const pin = { bytes: 7, sha256: sha256(Buffer.from('runtime')) };
        assertPinned(path, pin, 'Node.js');
        writeFileSync(path, 'runtimf');
        assert.throws(() => assertPinned(path, pin, 'Node.js'), /Node\.js is not the pinned file/u);
        writeFileSync(path, 'runtime!');
        assert.throws(() => assertPinned(path, pin, 'Node.js'), /is not the pinned file/u);
        assert.throws(() => assertPinned(path, { bytes: null, sha256: null }, 'The reasoner'), /has no pin/u);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('the Node.js runtime pins name the official archive of each of the four platforms', () => {
    const runtime = JSON.parse(readFileSync(join(root, 'release/node-runtime.json'), 'utf8'));
    assert.equal(runtime.version, readFileSync(join(root, '.node-version'), 'utf8').trim());
    assert.deepEqual(Object.keys(runtime.platforms).sort(), Object.keys(RELEASE_PLATFORMS).sort());
    for (const [platform, pin] of Object.entries(runtime.platforms)) {
        assert.match(pin.sha256, /^sha256:[0-9a-f]{64}$/u, platform);
        assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0, platform);
        assert.ok(pin.file.startsWith(`node-v${runtime.version}-`), platform);
    }
    assert.equal(hostPlatform({ platform: 'linux', arch: 'x64' }), 'linux-x64');
    assert.equal(hostPlatform({ platform: 'darwin', arch: 'x64' }), undefined);
    assert.equal(archiveName('1.0.0', 'win32-x64'), 'erden-1.0.0-win32-x64.zip');
});

function record(platform, digest = 'a') {
    return {
        version: '1.0.0',
        platform,
        sourceCommit: 'c'.repeat(40),
        sourceDateEpoch: 1_700_000_000,
        node: { version: '24.17.0' },
        archive: { file: archiveName('1.0.0', platform), bytes: 10, sha256: `sha256:${digest.repeat(64)}` },
        engines: { reasoner: { sha256: `sha256:${'1'.repeat(64)}` }, shacl: { sha256: `sha256:${'2'.repeat(64)}` } },
    };
}

test('a release accepts only the pinned archives and engines, on all four platforms', () => {
    const records = Object.fromEntries(Object.keys(RELEASE_PLATFORMS).map((platform) => [platform, record(platform)]));
    const pins = pinsOf(records);
    assert.equal(pins.complete, true);
    assert.deepEqual(pinDifferences(pins, records, { release: true }), []);
    const changed = { ...records, 'linux-x64': record('linux-x64', 'b') };
    assert.match(
        pinDifferences(pins, changed, { release: true })[0],
        /^linux-x64: erden-1\.0\.0-linux-x64\.tar\.gz is sha256:b+ /u,
    );
    const engine = {
        ...records,
        'darwin-arm64': {
            ...record('darwin-arm64'),
            engines: { ...record('darwin-arm64').engines, shacl: { sha256: `sha256:${'3'.repeat(64)}` } },
        },
    };
    assert.match(pinDifferences(pins, engine, { release: true }).join('\n'), /darwin-arm64: the shacl is/u);
    const { 'win32-x64': _, ...three } = records;
    assert.match(pinDifferences(pins, three, { release: true }).join('\n'), /win32-x64: not built/u);
    assert.throws(() => pinsOf(three), /No build for win32-x64/u);
    const partial = pinsOf({ 'linux-x64': records['linux-x64'] }, { allowPartial: true });
    assert.deepEqual(pinDifferences(partial, { 'linux-x64': records['linux-x64'] }), []);
    assert.match(
        pinDifferences(partial, { 'linux-x64': records['linux-x64'] }, { release: true }).join('\n'),
        /fewer than four/u,
    );
    assert.throws(
        () => pinsOf({ ...records, 'linux-x64': { ...records['linux-x64'], sourceDateEpoch: 1 } }),
        /disagree on sourceDateEpoch/u,
    );
});

test('third-party notices list every package with its license files and refuse unknown licenses', () => {
    const directory = temporary('notices');
    const policy = JSON.parse(readFileSync(join(root, 'release/license-policy.json'), 'utf8'));
    try {
        const modules = join(directory, 'node_modules');
        mkdirSync(join(modules, 'left', 'node_modules', 'nested'), { recursive: true });
        mkdirSync(join(modules, '@erden', 'cli'), { recursive: true });
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'MIT' }),
        );
        writeFileSync(join(modules, 'left', 'LICENSE'), 'MIT text\n');
        writeFileSync(
            join(modules, 'left', 'node_modules', 'nested', 'package.json'),
            JSON.stringify({ name: 'nested', version: '2.0.0', license: { type: 'ISC' } }),
        );
        writeFileSync(join(modules, 'left', 'node_modules', 'nested', 'LICENCE.md'), 'ISC text\n');
        writeFileSync(
            join(modules, '@erden', 'cli', 'package.json'),
            JSON.stringify({ name: '@erden/cli', version: '0.0.0', license: 'Apache-2.0' }),
        );
        assert.equal(writeNpmNotices(modules, join(directory, 'out'), policy), 2);
        const notices = readFileSync(join(directory, 'out', 'npm', 'THIRD-PARTY-NOTICES.md'), 'utf8');
        assert.match(
            notices,
            /- left 1\.0\.0: declared `MIT`; selected `MIT`; licenses\/[0-9a-f]{64}\.txt \(LICENSE, /u,
        );
        assert.match(notices, /- nested 2\.0\.0: declared `ISC`/u);
        assert.doesNotMatch(notices, /@erden/u);
        assert.equal(declaredLicense({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] }), 'MIT OR Apache-2.0');
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'SSPL-1.0' }),
        );
        assert.throws(
            () => writeNpmNotices(modules, join(directory, 'out2'), policy),
            /Denied license SSPL-1\.0: left 1\.0\.0/u,
        );
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'WTFPL' }),
        );
        assert.throws(() => writeNpmNotices(modules, join(directory, 'out3'), policy), /Unknown license WTFPL/u);
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'MIT' }),
        );
        rmSync(join(modules, 'left', 'LICENSE'));
        assert.throws(
            () => writeNpmNotices(modules, join(directory, 'out4'), policy),
            /No license file in left 1\.0\.0/u,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

/**
 * Evaluates a workflow `if:` that is a conjunction of `github.<path> == <literal>` terms (the only form the publish
 * guard uses) against a `github` context; anything else is refused, so the guard cannot grow untested.
 */
function evaluateGuard(expression, github) {
    const body = expression
        .trim()
        .replace(/^\$\{\{/u, '')
        .replace(/\}\}$/u, '');
    return body.split('&&').every((term) => {
        const match = /^\s*github\.([\w.]+) == ('[^']*'|true|false)\s*$/u.exec(term);
        if (match === null) {
            throw new Error(`Unsupported guard term: ${term}`);
        }
        const actual = match[1].split('.').reduce((value, key) => value?.[key], github);
        const expected = match[2].startsWith("'") ? match[2].slice(1, -1) : match[2] === 'true';
        return actual === expected;
    });
}

test('the release workflow pins every action, and only its publish job, in the public repository, can write', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.push.tags, ['v*']);
    for (const [name, job] of Object.entries(workflow.jobs)) {
        if (name === 'publish') {
            assert.deepEqual(job.permissions, { contents: 'write' });
            const publishes = evaluateGuard.bind(undefined, job.if);
            const tag = {
                event_name: 'push',
                repository: 'cbnsndwch/erden',
                event: { repository: { private: false } },
            };
            assert.equal(publishes(tag), true);
            assert.equal(
                publishes({ ...tag, event: { repository: { private: true } } }),
                false,
                'the private repository',
            );
            assert.equal(publishes({ ...tag, repository: 'someone/erden' }), false, 'a fork');
            assert.equal(publishes({ ...tag, event_name: 'workflow_dispatch' }), false, 'a mint');
        } else {
            assert.equal(job.permissions, undefined, `${name} must not raise permissions`);
        }
        if (typeof job.uses === 'string') {
            assert.match(job.uses, /^\.\/\.github\/workflows\/[a-z-]+\.yml$/u, name);
        }
        for (const step of job.steps ?? []) {
            if (step.uses !== undefined) {
                assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, `${name}: ${step.uses}`);
            }
        }
    }
    for (const engine of ['reasoner-build.yml', 'shacl-build.yml']) {
        const called = YAML.parse(readFileSync(join(root, '.github/workflows', engine), 'utf8'));
        assert.equal(called.on.workflow_call.inputs.commit.type, 'string', engine);
    }
});
