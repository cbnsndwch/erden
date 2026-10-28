import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { skipUntilReasonerRelease } from '../../scripts/lib/reasoner-release.mjs';
import { cleanupTestTempRoot, makeTestTempRoot } from '../../scripts/lib/test-temp-root.mjs';

skipUntilReasonerRelease(`reasoner clean install (${String(process.argv[2])})`);

const mode = process.argv[2];
const modes = new Set(['current', 'current-pnpm', 'linux-container', 'linux-container-pnpm']);
if (!modes.has(mode)) {
    throw new Error('Expected current, current-pnpm, linux-container, or linux-container-pnpm');
}
const usesPnpm = mode.endsWith('-pnpm');
const usesContainer = mode.startsWith('linux-container');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temporary = makeTestTempRoot('erden-reasoner-clean-install-');
const artifacts = resolve(temporary, 'artifacts');
mkdirSync(artifacts);

function run(command, args, options = {}) {
    const child = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
    if (child.status !== 0) {
        throw new Error(`${command} failed:\n${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    }
    return child.stdout;
}
function runPackageManager(command, args, cwd) {
    return process.platform === 'win32'
        ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${command} ${args.join(' ')}`], { cwd })
        : run(command, args, { cwd });
}

try {
    runPackageManager(
        'pnpm',
        ['pack', '--json', '--pack-destination', artifacts],
        resolve(root, 'reasoner/distribution'),
    );
    for (const directory of ['darwin-arm64', 'linux-arm64-gnu', 'linux-x64-gnu', 'win32-x64-msvc']) {
        runPackageManager(
            'pnpm',
            ['pack', '--json', '--pack-destination', artifacts],
            resolve(root, `reasoner/${directory}`),
        );
    }
    const packageJson = {
        name: 'erden-reasoner-clean-install-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        packageManager: 'pnpm@10.15.0',
        dependencies: {
            '@erden/reasoner-distribution':
                'file:artifacts/erden-reasoner-distribution-0.2.0+purrdf.0.12.0.dfb1df7.tgz',
        },
        optionalDependencies: {
            '@erden/reasoner-darwin-arm64':
                'file:artifacts/erden-reasoner-darwin-arm64-0.2.0+purrdf.0.12.0.dfb1df7.tgz',
            '@erden/reasoner-linux-arm64-gnu':
                'file:artifacts/erden-reasoner-linux-arm64-gnu-0.2.0+purrdf.0.12.0.dfb1df7.tgz',
            '@erden/reasoner-linux-x64-gnu':
                'file:artifacts/erden-reasoner-linux-x64-gnu-0.2.0+purrdf.0.12.0.dfb1df7.tgz',
            '@erden/reasoner-win32-x64-msvc':
                'file:artifacts/erden-reasoner-win32-x64-msvc-0.2.0+purrdf.0.12.0.dfb1df7.tgz',
        },
    };
    writeFileSync(resolve(temporary, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

    if (!usesContainer) {
        const expected = {
            'win32:x64': 'windows',
            'linux:x64': 'linux',
            'linux:arm64': 'linux-arm64',
            'darwin:arm64': 'darwin-arm64',
        }[`${process.platform}:${process.arch}`];
        if (expected === undefined) {
            throw new Error('Current clean install requires Windows x64, Linux x64 or arm64, or macOS arm64');
        }
        const install = usesPnpm
            ? runPackageManager('pnpm', ['install', '--offline', '--ignore-scripts'], temporary)
            : runPackageManager(
                  'npm',
                  ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
                  temporary,
              );
        if (usesPnpm && !install.includes('pnpm v10.15.0')) {
            throw new Error('pnpm 10.15.0 was not used');
        }
        const verified = run(
            process.execPath,
            [
                resolve(root, 'reasoner/distribution/verify-clean-install.mjs'),
                expected,
                usesPnpm ? 'may-be-present' : 'must-be-absent',
            ],
            { cwd: temporary },
        );
        process.stdout.write(install);
        process.stdout.write(verified);
    } else {
        const image = 'node:24.17.0-bookworm@sha256:733e1c06ada118ed9f6133a31aa1290be6929664026fb28821500437c61f2c6f';
        const mountFixture = `type=bind,source=${temporary},target=/fixture`;
        const mountRepository = `type=bind,source=${root},target=/repo,readonly`;
        for (const directory of ['.corepack', '.home', '.npm-cache']) {
            mkdirSync(resolve(temporary, directory), { mode: 0o700 });
        }
        if (usesPnpm) {
            runPackageManager(
                'corepack',
                ['pack', 'pnpm@10.15.0', '--output', resolve(temporary, 'corepack.tgz')],
                root,
            );
        }
        const install = usesPnpm
            ? 'corepack install -g --cache-only /fixture/corepack.tgz && corepack pnpm --version && corepack pnpm install --offline --ignore-scripts'
            : 'npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false';
        const policy = usesPnpm ? 'may-be-present' : 'must-be-absent';
        const command = `${install} && node /repo/reasoner/distribution/verify-clean-install.mjs linux ${policy} && node /repo/reasoner/distribution/verify-linux-integrity-failures.mjs`;
        const user =
            typeof process.getuid === 'function' && typeof process.getgid === 'function'
                ? ['--user', `${String(process.getuid())}:${String(process.getgid())}`]
                : [];
        const verified = run('docker', [
            'run',
            '--rm',
            '--network',
            'none',
            ...user,
            '--env',
            'COREPACK_HOME=/fixture/.corepack',
            '--env',
            'HOME=/fixture/.home',
            '--env',
            'npm_config_cache=/fixture/.npm-cache',
            '--mount',
            mountFixture,
            '--mount',
            mountRepository,
            '--workdir',
            '/fixture',
            image,
            'sh',
            '-c',
            command,
        ]);
        process.stdout.write(verified);
    }
} finally {
    cleanupTestTempRoot(temporary);
}
