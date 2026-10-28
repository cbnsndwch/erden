import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { writeArchive } from '../../release/lib/archive.mjs';
import { RELEASE_PLATFORMS, archiveName, sha256 } from '../../release/lib/platforms.mjs';
import { installScriptDifferences, installScripts } from '../../release/write-install-scripts.mjs';

const root = resolve(import.meta.dirname, '../..');
const VERSION = '1.0.0';

/** A release archive for `platform` holding a launcher that prints a marker, and pins naming it. */
function fixture(platform = 'linux-x64', withAlias = true) {
    const directory = mkdtempSync(join(tmpdir(), 'erden-install-test-'));
    const tree = join(directory, 'tree');
    mkdirSync(join(tree, 'bin'), { recursive: true });
    writeFileSync(join(tree, 'bin', 'erden'), '#!/bin/sh\necho installed-erden "$@"\n');
    chmodSync(join(tree, 'bin', 'erden'), 0o755);
    if (withAlias) {
        writeFileSync(join(tree, 'bin', 'den'), '#!/bin/sh\necho installed-erden "$@"\n');
        chmodSync(join(tree, 'bin', 'den'), 0o755);
    }
    const file = archiveName(VERSION, platform);
    const archive = join(directory, file);
    const pin = { file, ...writeArchive(tree, `erden-${VERSION}-${platform}`, archive, 1_700_000_000) };
    const archives = Object.fromEntries(
        Object.keys(RELEASE_PLATFORMS).map((name) => [
            name,
            name === platform ? pin : { file: archiveName(VERSION, name), bytes: 1, sha256: sha256('other') },
        ]),
    );
    const pins = { version: VERSION, archives };
    const script = join(directory, 'install.sh');
    writeFileSync(script, installScripts(pins)['install.sh']);
    const home = join(directory, 'home');
    mkdirSync(home);
    const shims = join(directory, 'shims');
    mkdirSync(shims);
    return { directory, archive, script, home, shims, pins, file };
}

/** A PATH shim: `uname` answers as `system`/`machine`, `curl` copies `served` to its -o target and logs its arguments. */
function shim(context, { system = 'Linux', machine = 'x86_64', served, musl = false } = {}) {
    writeFileSync(
        join(context.shims, 'uname'),
        `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
    );
    writeFileSync(
        join(context.shims, 'curl'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(context.directory, 'curl.log')}"\n` +
            (served === undefined
                ? 'exit 7\n'
                : `while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp "${served}" "$2"; fi; shift; done\n`),
    );
    writeFileSync(
        join(context.shims, 'ldd'),
        `#!/bin/sh\necho '${musl ? 'musl libc (x86_64)' : 'ldd (GNU libc) 2.39'}'\n`,
    );
    for (const name of ['uname', 'curl', 'ldd']) {
        chmodSync(join(context.shims, name), 0o755);
    }
}

function install(context, args) {
    return spawnSync('sh', [context.script, ...args], {
        encoding: 'utf8',
        env: { PATH: `${context.shims}:/usr/bin:/bin`, HOME: context.home },
    });
}

function leftovers(context) {
    const data = join(context.home, '.local', 'share', 'erden');
    return existsSync(data) ? readdirSync(data) : [];
}

describe('install.sh', { skip: process.platform === 'win32' }, () => {
    it('installs a local archive with no network request and links erden into ~/.local/bin', () => {
        const context = fixture();
        try {
            shim(context);
            const result = install(context, ['--archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            const target = join(context.home, '.local', 'share', 'erden', VERSION);
            const link = join(context.home, '.local', 'bin', 'erden');
            assert.ok(lstatSync(link).isSymbolicLink());
            assert.equal(readlinkSync(link), join(target, 'bin', 'erden'));
            assert.equal(spawnSync(link, ['doctor'], { encoding: 'utf8' }).stdout, 'installed-erden doctor\n');
            const alias = join(context.home, '.local', 'bin', 'den');
            assert.ok(lstatSync(alias).isSymbolicLink());
            assert.equal(readlinkSync(alias), join(target, 'bin', 'den'));
            assert.equal(spawnSync(alias, ['doctor'], { encoding: 'utf8' }).stdout, 'installed-erden doctor\n');
            assert.equal(existsSync(join(context.directory, 'curl.log')), false, 'an --archive install made a request');
            assert.deepEqual(leftovers(context), [VERSION]);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('refuses a digest-valid archive missing den before installing it', () => {
        const context = fixture('linux-x64', false);
        try {
            shim(context);
            const result = install(context, ['--archive', context.archive]);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /does not hold bin\/den/u);
            assert.deepEqual(leftovers(context), []);
            assert.equal(existsSync(join(context.home, '.local', 'bin', 'erden')), false);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('downloads from the release with a generic User-Agent and checks the digest', () => {
        const context = fixture();
        try {
            shim(context, { served: context.archive });
            const result = install(context, []);
            assert.equal(result.status, 0, result.stderr);
            const request = readFileSync(join(context.directory, 'curl.log'), 'utf8');
            assert.match(request, /-A erden-install\/1 /u);
            assert.match(
                request,
                new RegExp(`https://github\\.com/cbnsndwch/erden/releases/download/v1\\.0\\.0/${context.file}`, 'u'),
            );
            assert.ok(existsSync(join(context.home, '.local', 'share', 'erden', VERSION, 'bin', 'erden')));
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('refuses an archive with another digest, a partial download and a failed download, leaving nothing installed', () => {
        const context = fixture();
        try {
            const swapped = join(context.directory, 'swapped.tar.gz');
            const bytes = readFileSync(context.archive);
            bytes[bytes.length - 1] ^= 1;
            writeFileSync(swapped, bytes);
            shim(context);
            let result = install(context, ['--archive', swapped]);
            assert.equal(result.status, 1);
            assert.match(
                result.stderr,
                /SHA-256 is not the one erden-1\.0\.0-linux-x64\.tar\.gz was released with; nothing was installed/u,
            );
            const partial = join(context.directory, 'partial.tar.gz');
            writeFileSync(partial, readFileSync(context.archive).subarray(0, 100));
            shim(context, { served: partial });
            result = install(context, []);
            assert.equal(result.status, 1);
            assert.match(
                result.stderr,
                /is 100 bytes, not the \d+ bytes of erden-1\.0\.0-linux-x64\.tar\.gz \(a partial or different download\)/u,
            );
            shim(context);
            result = install(context, []);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /could not download https:/u);
            assert.deepEqual(leftovers(context), []);
            assert.equal(existsSync(join(context.home, '.local', 'bin', 'erden')), false);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('refuses unsupported platforms before anything is downloaded', () => {
        const context = fixture();
        try {
            for (const [options, pattern] of [
                [{ system: 'FreeBSD' }, /unsupported platform: FreeBSD x86_64/u],
                [{ system: 'Darwin', machine: 'x86_64' }, /unsupported platform: darwin-x64/u],
                [{ machine: 'riscv64' }, /unsupported platform: linux-riscv64/u],
                [{ musl: true }, /unsupported platform: linux-x64 with musl/u],
            ]) {
                shim(context, { ...options, served: context.archive });
                const result = install(context, []);
                assert.equal(result.status, 1, JSON.stringify(options));
                assert.match(result.stderr, pattern);
            }
            assert.equal(existsSync(join(context.directory, 'curl.log')), false);
            assert.deepEqual(leftovers(context), []);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('installs the macOS arm64 archive on macOS arm64', () => {
        const context = fixture('darwin-arm64');
        try {
            shim(context, { system: 'Darwin', machine: 'arm64' });
            const result = install(context, ['--archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            assert.ok(existsSync(join(context.home, '.local', 'share', 'erden', VERSION, 'bin', 'erden')));
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });
});

const POWERSHELL = ['pwsh', 'powershell'].find(
    (name) =>
        spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status ===
        0,
);

/**
 * install.ps1 for a win32-x64 zip. Off Windows the script refuses the platform first, so the digest and install paths
 * run in a copy whose platform check is forced, with the user's data folder under a temporary home.
 */
function powershellFixture() {
    const context = fixture('win32-x64');
    const windows = process.platform === 'win32';
    const tree = join(context.directory, 'tree');
    writeFileSync(join(tree, 'bin', 'erden.cmd'), '@echo off\r\necho installed-erden %*\r\n');
    writeFileSync(join(tree, 'bin', 'den.cmd'), '@echo off\r\necho installed-erden %*\r\n');
    const pin = {
        file: context.file,
        ...writeArchive(tree, `erden-${VERSION}-win32-x64`, context.archive, 1_700_000_000),
    };
    const pins = { ...context.pins, archives: { ...context.pins.archives, 'win32-x64': pin } };
    const script = join(context.directory, 'install.ps1');
    const text = installScripts(pins)['install.ps1'];
    writeFileSync(script, text);
    const forced = join(context.directory, 'install-forced.ps1');
    writeFileSync(forced, text.replace("if (-not $isWindowsHost -or $architecture -ne 'X64') {", 'if ($false) {'));
    const env = { ...process.env, LOCALAPPDATA: context.home };
    const programs = join(context.home, 'Programs', 'Erden');
    function run(file, args) {
        return spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
            encoding: 'utf8',
            env,
        });
    }
    return { ...context, script, forced: windows ? script : forced, programs, run };
}

describe('install.ps1', { skip: POWERSHELL === undefined ? 'no PowerShell on this host' : false }, () => {
    it(
        'refuses a platform other than Windows x64',
        { skip: process.platform === 'win32' && process.arch === 'x64' },
        () => {
            const context = powershellFixture();
            try {
                const result = context.run(context.script, ['-Archive', context.archive]);
                assert.equal(result.status, 1);
                assert.match(result.stderr, /unsupported platform: .*install\.ps1 installs win32-x64/u);
                assert.equal(existsSync(context.programs), false);
            } finally {
                rmSync(context.directory, { recursive: true, force: true });
            }
        },
    );

    it('installs a local archive after its digest check and refuses another or a partial one', () => {
        const context = powershellFixture();
        try {
            const bytes = readFileSync(context.archive);
            const swapped = join(context.directory, 'swapped.zip');
            const swappedBytes = Buffer.from(bytes);
            swappedBytes[swappedBytes.length - 1] ^= 1;
            writeFileSync(swapped, swappedBytes);
            let result = context.run(context.forced, ['-Archive', swapped]);
            assert.equal(result.status, 1);
            assert.match(
                result.stderr,
                /SHA-256 is not the one erden-1\.0\.0-win32-x64\.zip was released with; nothing was installed/u,
            );
            const partial = join(context.directory, 'partial.zip');
            writeFileSync(partial, bytes.subarray(0, 100));
            result = context.run(context.forced, ['-Archive', partial]);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /is 100 bytes, not the \d+ bytes of erden-1\.0\.0-win32-x64\.zip/u);
            assert.deepEqual(existsSync(context.programs) ? readdirSync(context.programs) : [], []);
            result = context.run(context.forced, ['-Archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /Installed Erden 1\.0\.0 to /u);
            assert.ok(existsSync(join(context.programs, VERSION, 'bin', 'erden.cmd')));
            assert.ok(existsSync(join(context.programs, VERSION, 'bin', 'den.cmd')));
            assert.deepEqual(readdirSync(context.programs), [VERSION]);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });
});

describe('the install scripts and the pins', () => {
    it('carry the version and every archive digest and are refused when stale', () => {
        const { directory, pins } = fixture();
        try {
            const scripts = installScripts(pins);
            assert.match(
                scripts['install.sh'],
                new RegExp(`^linux_x64_sha256='${pins.archives['linux-x64'].sha256.slice(7)}'$`, 'mu'),
            );
            assert.match(scripts['install.ps1'], /^\$win32X64File = 'erden-1\.0\.0-win32-x64\.zip'$/mu);
            assert.doesNotMatch(`${scripts['install.sh']}${scripts['install.ps1']}`, /@@/u);
            const copy = join(directory, 'release');
            mkdirSync(copy);
            for (const name of ['install.template.sh', 'install.template.ps1']) {
                writeFileSync(join(copy, name), readFileSync(join(root, 'release', name)));
            }
            assert.deepEqual(installScriptDifferences(pins, copy), [
                'release/install.sh is missing',
                'release/install.ps1 is missing',
            ]);
            writeFileSync(join(copy, 'install.sh'), scripts['install.sh']);
            writeFileSync(
                join(copy, 'install.ps1'),
                scripts['install.ps1'].replace(/'[0-9a-f]{64}'/u, `'${'0'.repeat(64)}'`),
            );
            assert.deepEqual(installScriptDifferences(pins, copy), [
                'release/install.ps1 is not the one release/pins/1.0.0.json gives',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('committed install scripts are the ones their pins give', () => {
        const pinsDirectory = join(root, 'release', 'pins');
        const committed = existsSync(join(root, 'release', 'install.sh'));
        if (!existsSync(pinsDirectory)) {
            assert.equal(committed, false, 'install scripts are committed with no pins');
            return;
        }
        const version = readFileSync(join(root, 'release', 'install.sh'), 'utf8').match(/^version='([^']+)'$/mu)?.[1];
        const pins = JSON.parse(readFileSync(join(pinsDirectory, `${String(version)}.json`), 'utf8'));
        assert.deepEqual(installScriptDifferences(pins), []);
    });
});
