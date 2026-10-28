// Builds one platform's CLI archive twice, each from its own `git archive` export of the commit, and refuses unless
// the two are byte-identical. Each build installs the export offline from the lockfile, builds the runtime packages,
// deploys `@erden/cli` with its locked production dependencies (`pnpm deploy --prod`, hoisted, so the tree has no links),
// drops pnpm's install-time state files, and adds the pinned Node.js runtime, a launcher, both engine binaries at
// their platform packages' `bin/` paths, LICENSE, NOTICE and THIRD-PARTY-NOTICES/. The Node.js archive and the engine
// binaries are checked against their pins first. The first build's tree is then run as a user would (smoke.mjs)
// before it is archived, so a run that wrote into the tree would differ from the second build.
//
// Usage: node release/build-cli-archive.mjs --node <official archive> --reasoner <binary> --shacl <binary>
//            --out <directory> [--commit <sha>] [--source-date-epoch <seconds>]
import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { writeArchive } from './lib/archive.mjs';
import { normalizeDeployedWorkspace, prepareLockedDeployment } from './lib/deploy.mjs';
import { copyEngineNotices, writeNpmNotices } from './lib/notices.mjs';
import { RELEASE_PLATFORMS, archiveName, assertPinned, hostPlatform } from './lib/platforms.mjs';
import { smokeTest } from './lib/smoke.mjs';

const release = import.meta.dirname;
const repository = resolve(release, '..');
const windows = process.platform === 'win32';

function run(command, args, options = {}) {
    const child = windows
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], {
              encoding: 'utf8',
              windowsHide: true,
              maxBuffer: 1 << 28,
              ...options,
          })
        : spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
    if (child.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed (${String(child.status)}): ${child.stderr}${child.stdout}`,
        );
    }
    return child.stdout;
}

function git(...args) {
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', repository, ...args], {
        encoding: 'utf8',
        windowsHide: true,
    }).trim();
}

/** The commit's tree as `git archive` writes it, extracted into `directory`. */
function exportSource(commit, directory) {
    mkdirSync(directory, { recursive: true });
    const archive = join(directory, '..', `${basename(directory)}.tar`);
    git('archive', '--format=tar', `--output=${archive}`, commit);
    run('tar', ['-xf', basename(archive), '-C', basename(directory)], { cwd: dirname(directory) });
    rmSync(archive);
}

/** pnpm's files that record when or how the install ran, and the link farm a launcher never uses. */
function dropInstallState(nodeModules) {
    for (const name of readdirSync(nodeModules)) {
        if (
            name === '.bin' ||
            name === '.modules.yaml' ||
            name === '.pnpm' ||
            name.startsWith('.pnpm-workspace-state')
        ) {
            rmSync(join(nodeModules, name), { recursive: true, force: true });
        }
    }
    for (const entry of readdirSync(nodeModules, { withFileTypes: true, recursive: true })) {
        if (entry.isDirectory() && entry.name === '.bin') {
            rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
        }
    }
}

/** The Node.js executable and its LICENSE from the official archive, extracted with the system tar. */
function extractNode(nodeArchive, runtime, directory) {
    mkdirSync(directory, { recursive: true });
    copyFileSync(nodeArchive, join(directory, basename(nodeArchive)));
    run('tar', ['-xf', basename(nodeArchive)], { cwd: directory });
    const top = join(directory, runtime.file.replace(/\.(?:tar\.(?:gz|xz)|zip)$/u, ''));
    return { executable: join(top, runtime.executable), license: join(top, 'LICENSE') };
}

const POSIX_LAUNCHER = `#!/bin/sh
# Runs the Erden CLI with the Node.js runtime this archive ships. Links to this file are followed to find it.
set -e
self=$0
while [ -L "$self" ]; do
    link=$(readlink "$self")
    case $link in
        /*) self=$link ;;
        *) self=$(dirname "$self")/$link ;;
    esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$root/node/node" "$root/lib/dist/bin.js" "$@"
`;

const WINDOWS_LAUNCHER = `@echo off\r
rem Runs the Erden CLI with the Node.js runtime this archive ships.\r
"%~dp0..\\node\\node.exe" "%~dp0..\\lib\\dist\\bin.js" %*\r
`;

/** One build of the archive tree from an export, at `stage`. */
function buildStage(source, stage, inputs) {
    run('pnpm', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'], { cwd: source });
    run('pnpm', ['run', 'build:runtime'], { cwd: source });
    const lib = join(stage, 'lib');
    const deployment = prepareLockedDeployment(source);
    // Project the shared lockfile instead of legacy deploy's unlocked resolution. Only this temporary export's
    // injection setting changes; the dependency graph stays fixed. Unused workspace patches do not apply here.
    const deploy = [
        'deploy',
        '--prod',
        '--offline',
        '--ignore-scripts',
        '--config.node-linker=hoisted',
        '--config.inject-workspace-packages=true',
    ];
    run('pnpm', ['--filter', '@erden/cli', ...deploy, '--config.allow-unused-patches=true', lib], { cwd: source });
    const nodeModules = join(lib, 'node_modules');
    dropInstallState(nodeModules);
    normalizeDeployedWorkspace(source, lib, deployment.lockfile);
    for (const engine of inputs.engines) {
        const packageRoot = join(nodeModules, ...engine.packageName.split('/'));
        const metadata = JSON.parse(readFileSync(join(packageRoot, 'metadata.json'), 'utf8'));
        if (metadata.binary?.sha256 !== engine.pin.sha256 || metadata.binary?.bytes !== engine.pin.bytes) {
            throw new Error(`${engine.packageName}/metadata.json does not pin the binary its resolver pins`);
        }
        const destination = join(packageRoot, engine.pin.binaryPath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(engine.binary, destination);
        chmodSync(destination, 0o755);
    }
    const node = extractNode(inputs.nodeArchive, inputs.nodeRuntime, join(dirname(stage), 'node-runtime'));
    mkdirSync(join(stage, 'node'));
    const nodeExecutable = join(stage, 'node', basename(inputs.nodeRuntime.executable));
    copyFileSync(node.executable, nodeExecutable);
    chmodSync(nodeExecutable, 0o755);
    mkdirSync(join(stage, 'bin'));
    for (const name of ['erden', 'den']) {
        if (inputs.platform.os === 'win32') {
            writeFileSync(join(stage, 'bin', `${name}.cmd`), WINDOWS_LAUNCHER);
        } else {
            writeFileSync(join(stage, 'bin', name), POSIX_LAUNCHER);
            chmodSync(join(stage, 'bin', name), 0o755);
        }
    }
    copyFileSync(join(source, 'LICENSE'), join(stage, 'LICENSE'));
    copyFileSync(join(source, 'NOTICE'), join(stage, 'NOTICE'));
    const notices = join(stage, 'THIRD-PARTY-NOTICES');
    const policy = JSON.parse(readFileSync(join(source, 'release/license-policy.json'), 'utf8'));
    const packages = writeNpmNotices(nodeModules, notices, policy);
    mkdirSync(join(notices, 'node.js'));
    copyFileSync(node.license, join(notices, 'node.js', 'LICENSE'));
    copyEngineNotices(join(source, 'reasoner/qualification'), notices, 'erden-reasoner');
    copyEngineNotices(join(source, 'shacl/qualification'), notices, 'erden-shacl');
    return { packages, dependencyLockDigest: deployment.digest };
}

/** The engine pins of the exported tree for a platform; refuses a platform an engine has no pins for. */
async function enginePins(source, platform) {
    const reasoner = await import(pathToFileURL(join(source, 'reasoner/distribution/src/artifacts.js')).href);
    const shacl = await import(pathToFileURL(join(source, 'shacl/distribution/src/artifacts.js')).href);
    const pins = {
        reasoner: reasoner.QUALIFIED_REASONER_ARTIFACTS[platform.engineKey],
        shacl: shacl.QUALIFIED_ARTIFACTS[platform.engineKey],
    };
    for (const [name, pin] of Object.entries(pins)) {
        if (pin?.sha256 === null || pin?.sha256 === undefined) {
            throw new Error(`The ${name} has no pins for ${platform.engineKey}; mint the engine first`);
        }
    }
    return pins;
}

async function main() {
    const { values } = parseArgs({
        options: {
            node: { type: 'string' },
            reasoner: { type: 'string' },
            shacl: { type: 'string' },
            out: { type: 'string' },
            commit: { type: 'string', default: 'HEAD' },
            'source-date-epoch': { type: 'string' },
        },
    });
    for (const name of ['node', 'reasoner', 'shacl', 'out']) {
        if (values[name] === undefined) {
            throw new Error(`--${name} is required`);
        }
    }
    const platformName = hostPlatform();
    if (platformName === undefined) {
        throw new Error(`No release platform for ${process.platform} ${process.arch}`);
    }
    const platform = RELEASE_PLATFORMS[platformName];
    const commit = git('rev-parse', '--verify', `${values.commit}^{commit}`);
    const epoch = Number(
        values['source-date-epoch'] ?? process.env.SOURCE_DATE_EPOCH ?? git('show', '-s', '--format=%ct', commit),
    );
    if (!Number.isSafeInteger(epoch) || epoch < 315532800) {
        throw new Error('The source date epoch must be 1980 or later');
    }
    const version = JSON.parse(git('show', `${commit}:apps/cli/package.json`)).version;
    const nodeRuntimes = JSON.parse(git('show', `${commit}:release/node-runtime.json`));
    const nodeRuntime = nodeRuntimes.platforms[platformName];
    assertPinned(values.node, nodeRuntime, `Node.js ${nodeRuntimes.version} for ${platformName}`);
    const out = resolve(values.out);
    mkdirSync(out, { recursive: true });
    const name = archiveName(version, platformName);
    const prefix = name.replace(/\.(?:tar\.gz|zip)$/u, '');
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'erden-cli-archive-'));
    try {
        const runs = [];
        let smoke;
        let pins;
        for (const label of ['a', 'b']) {
            const source = join(temporary, label, 'source');
            exportSource(commit, source);
            pins ??= await enginePins(source, platform);
            const engines = [
                { packageName: pins.reasoner.packageName, pin: pins.reasoner, binary: values.reasoner },
                { packageName: pins.shacl.packageName, pin: pins.shacl, binary: values.shacl },
            ];
            for (const engine of engines) {
                assertPinned(engine.binary, engine.pin, engine.packageName);
            }
            const stage = join(temporary, label, prefix);
            const { packages, dependencyLockDigest } = buildStage(source, stage, {
                engines,
                nodeArchive: resolve(values.node),
                nodeRuntime,
                platform,
            });
            if (label === 'a') {
                smoke = smokeTest(stage, join(source, 'examples/erden-demo'));
            }
            const archive = join(temporary, label, name);
            runs.push({ label, packages, dependencyLockDigest, ...writeArchive(stage, prefix, archive, epoch) });
        }
        if (runs[0].sha256 !== runs[1].sha256 || runs[0].bytes !== runs[1].bytes) {
            throw new Error(`${name} is not reproducible: ${runs[0].sha256} vs ${runs[1].sha256}`);
        }
        copyFileSync(join(temporary, 'a', name), join(out, name));
        const record = {
            schema: 'erden.cli-archive-build/v1',
            version,
            platform: platformName,
            sourceCommit: commit,
            sourceDateEpoch: epoch,
            archive: { file: name, bytes: runs[0].bytes, sha256: runs[0].sha256 },
            node: { version: nodeRuntimes.version, file: nodeRuntime.file, sha256: nodeRuntime.sha256 },
            dependencyLockDigest: runs[0].dependencyLockDigest,
            engines: {
                reasoner: { packageName: pins.reasoner.packageName, sha256: pins.reasoner.sha256 },
                shacl: { packageName: pins.shacl.packageName, sha256: pins.shacl.sha256 },
            },
            npmPackages: runs[0].packages,
            runs: runs.map(({ label, bytes, sha256 }) => ({ label, bytes, sha256 })),
            smoke,
            result: 'byte-identical',
        };
        writeFileSync(join(out, `${platformName}.json`), `${JSON.stringify(record, null, 2)}\n`);
        process.stdout.write(`${name}: ${runs[0].sha256} (${String(runs[0].bytes)} bytes); both builds match\n`);
    } finally {
        if (existsSync(temporary)) {
            rmSync(temporary, { recursive: true, force: true });
        }
    }
}

if (import.meta.main) {
    await main();
}
