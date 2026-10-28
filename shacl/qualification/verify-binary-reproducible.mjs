// Builds one erden-shacl target twice, from two separate `git archive` exports of the source commit, on a native host
// for that target, and proves the two release executables byte-identical. The reasoner's model
// (reasoner/qualification/verify-binary-reproducible.mjs) with this crate's paths, toolchain and builder image; the
// target table, the ambient-variable scrub and the Cargo-configuration refusal are imported from it, so both programs
// are built under the same rules.
//
//   node shacl/qualification/verify-binary-reproducible.mjs <target> --out <directory> [--commit <sha>]
//        [--source-date-epoch <seconds>]
//
// Linux targets build in the digest-pinned `rust:1.98.0-bookworm` image (its own architecture, never emulated);
// Windows and macOS with the host's rustup 1.98.0. Each export is made with line-ending conversion off and must match
// the commit's `shacl/` blobs byte for byte; the exported Cargo.lock must hash to the digest the engine identity names.
// The binary answers the known-answer request before the record is written.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import {
    assertNativeHost,
    cargoConfigurationFiles,
    nativeBuildEnvironment,
} from '../../reasoner/qualification/verify-binary-reproducible.mjs';

export const LINUX_BUILDER_IMAGE = 'rust@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922';
export const RUST_TOOLCHAIN = Object.freeze({
    rustc: '1.98.0',
    commit: '88d9e12ae178fab0fb5cc050a94da85685d449ea',
    llvm: '22.1.8',
});
export const CARGO_LOCK_SHA256 = 'sha256:4f85d22854b0747423c286fd019533a6caf08a9dc3d4770ddbb637d307713244';
export const DEFAULT_SOURCE_DATE_EPOCH = '1785703783';
/**
 * Where the two clean builds live under one fresh temporary directory. build-from-source.mjs repeats build A exactly:
 * on macOS a native build with a different layout (`git-archive` and `target`, two bytes shorter) came out at the
 * pinned size but with other bytes, while the mint's random temporary suffix never changed them.
 */
export const BUILD_LAYOUT = Object.freeze({
    temporaryPrefix: 'erden-shacl-repro-',
    a: Object.freeze({ source: 'git-archive-a', target: 'target-a' }),
    b: Object.freeze({ source: 'git-archive-b', target: 'target-b' }),
});
const LINUX_RUSTFLAGS =
    '-C link-arg=-Wl,--build-id=none --remap-path-prefix=/work=/erden-shacl --remap-path-prefix=/usr/local/cargo=/cargo';
const REMAP_RECORD = '--remap-path-prefix=<shacl>=/erden-shacl --remap-path-prefix=<cargo-home>=/cargo';
const LINKER_FLAGS = Object.freeze({ 'x86_64-pc-windows-msvc': '-C link-arg=/Brepro ', 'aarch64-apple-darwin': '' });
const DOCKER_PLATFORM = Object.freeze({
    'x86_64-unknown-linux-gnu': 'linux/amd64',
    'aarch64-unknown-linux-gnu': 'linux/arm64',
});

export function executableName(target) {
    return target.endsWith('-windows-msvc') ? 'erden-shacl.exe' : 'erden-shacl';
}

/** Pure description of one clean build; `paths` matters only for native builds. */
export function planBuild(target, host, paths = {}, sourceDateEpoch = DEFAULT_SOURCE_DATE_EPOCH) {
    const definition = assertNativeHost(target, host);
    const binaryRelativePath = `${target}/release/${executableName(target)}`;
    if (definition.builder === 'docker') {
        return {
            kind: 'docker',
            image: LINUX_BUILDER_IMAGE,
            dockerPlatform: DOCKER_PLATFORM[target],
            command:
                `export CARGO_TARGET_DIR=/target CARGO_INCREMENTAL=0 SOURCE_DATE_EPOCH=${sourceDateEpoch}; ` +
                `export RUSTFLAGS="${LINUX_RUSTFLAGS}"; ` +
                `cargo build --release --locked --target ${target} --bin erden-shacl`,
            rustflagsRecord: LINUX_RUSTFLAGS,
            binaryRelativePath,
        };
    }
    const { sourceDirectory, cargoHome } = paths;
    if (typeof sourceDirectory !== 'string' || typeof cargoHome !== 'string') {
        throw new Error('A native build needs the exported source directory and the Cargo home');
    }
    const linkerFlags = LINKER_FLAGS[target] ?? '';
    return {
        kind: 'native',
        env: {
            CARGO_INCREMENTAL: '0',
            SOURCE_DATE_EPOCH: sourceDateEpoch,
            RUSTFLAGS: `${linkerFlags}--remap-path-prefix=${sourceDirectory}=/erden-shacl --remap-path-prefix=${cargoHome}=/cargo`,
        },
        args: [
            'run', RUST_TOOLCHAIN.rustc, 'cargo', 'build', '--release', '--locked', '--target', target,
            '--bin', 'erden-shacl', '--manifest-path', join(sourceDirectory, 'Cargo.toml'),
        ],
        rustflagsRecord: `${linkerFlags}${REMAP_RECORD}`,
        binaryRelativePath,
    };
}

function run(command, args, options = {}) {
    const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options });
    if (child.error !== undefined || child.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed (${child.error?.message ?? child.status}):\n${child.stderr ?? ''}`);
    }
    return child.stdout;
}
function git(repository, ...args) {
    return run('git', ['-C', repository, ...args]).trim();
}
function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertToolchain(versionOutput) {
    const field = (name) => new RegExp(`^${name}: (.+)$`, 'mu').exec(versionOutput)?.[1]?.trim();
    const actual = { rustc: field('release'), commit: field('commit-hash'), llvm: field('LLVM version') };
    if (JSON.stringify(actual) !== JSON.stringify(RUST_TOOLCHAIN)) {
        throw new Error(`Rust toolchain ${JSON.stringify(actual)} is not the qualified ${JSON.stringify(RUST_TOOLCHAIN)}`);
    }
}

const EXPORT_CONFIGURATION = Object.freeze(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);

/** Refuses an export whose files are not exactly the commit's `shacl/` blobs. */
function assertExportMatchesCommit(repository, commit, exportRoot, label) {
    const expected = new Map();
    for (const entry of run('git', ['-C', repository, 'ls-tree', '-r', '-z', '--full-tree', commit, '--', 'shacl']).split('\0')) {
        if (entry === '') continue;
        const tab = entry.indexOf('\t');
        const [mode, type, id] = entry.slice(0, tab).split(' ');
        const path = entry.slice(tab + 1);
        if (type !== 'blob' || mode === '120000') throw new Error(`Cannot verify the export of ${path} (${mode} ${type})`);
        expected.set(path, id);
    }
    const exported = readdirSync(exportRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => !entry.isDirectory())
        .map((entry) => {
            const path = relative(exportRoot, join(entry.parentPath, entry.name)).split(sep).join('/');
            if (!entry.isFile()) throw new Error(`Exported source ${label} has a non-regular file: ${path}`);
            return path;
        })
        .sort();
    const ids =
        exported.length === 0
            ? []
            : run('git', ['-C', repository, 'hash-object', '--no-filters', '--stdin-paths'], {
                  input: `${exported.map((path) => join(exportRoot, path)).join('\n')}\n`,
              })
                  .trim()
                  .split(/\r?\n/u);
    const differing = exported.filter((path, index) => expected.get(path) !== ids[index]);
    const missing = [...expected.keys()].filter((path) => !exported.includes(path)).sort();
    if (differing.length > 0 || missing.length > 0) {
        throw new Error(
            `Exported source ${label} is not byte-identical to ${commit}:\n` +
                [...differing.map((path) => `differs: ${path}`), ...missing.map((path) => `missing: ${path}`)].join('\n'),
        );
    }
}

export function exportSource(repository, commit, root, label) {
    const directory = join(root, label);
    mkdirSync(directory);
    run('git', [...EXPORT_CONFIGURATION, '-C', repository, 'archive', '--format=tar', `--output=${join(root, `${label}.tar`)}`, commit, 'shacl']);
    run('tar', ['-xf', `${label}.tar`, '-C', label], { cwd: root });
    assertExportMatchesCommit(repository, commit, directory, label);
    const source = join(directory, 'shacl');
    if (!existsSync(join(source, 'Cargo.lock'))) throw new Error(`Exported source ${label} is incomplete`);
    return source;
}

export function buildOnce(target, source, targetDirectory, sourceDateEpoch) {
    const host = { platform: process.platform, arch: process.arch };
    mkdirSync(targetDirectory);
    if (assertNativeHost(target, host).builder === 'docker') {
        const plan = planBuild(target, host, {}, sourceDateEpoch);
        const owner = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
        const handBack = owner === undefined ? '' : ` && chown -R ${owner} /target`;
        const output = run('docker', [
            'run', '--rm', '--platform', plan.dockerPlatform,
            '--mount', `type=bind,source=${source},target=/work,readonly`,
            '--mount', `type=bind,source=${targetDirectory},target=/target`,
            '--workdir', '/work', plan.image,
            'sh', '-c', `rustc -vV && ${plan.command}${handBack}`,
        ]);
        assertToolchain(output);
        return { plan, binary: join(targetDirectory, plan.binaryRelativePath) };
    }
    const cargoHome = realpathSync(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
    const plan = planBuild(target, host, { sourceDirectory: source, cargoHome }, sourceDateEpoch);
    const configuration = cargoConfigurationFiles(source, cargoHome);
    if (configuration.length > 0) {
        throw new Error(`Cargo configuration would reach the build: ${configuration.join(', ')}`);
    }
    const env = nativeBuildEnvironment(process.env, plan, targetDirectory);
    assertToolchain(run('rustup', ['run', RUST_TOOLCHAIN.rustc, 'rustc', '-vV'], { env, cwd: source }));
    run('rustup', plan.args, { env, cwd: source, stdio: ['ignore', 'pipe', 'inherit'] });
    return { plan, binary: join(targetDirectory, plan.binaryRelativePath) };
}

/** The committed known-answer request against a fresh binary: the anchors a platform package records. */
export function knownAnswer(binary, executableDigest, shacl) {
    const template = readFileSync(join(shacl, 'distribution/fixtures/known-answer.request.json'), 'utf8');
    const request = JSON.parse(template);
    request.requiredTool.executableDigest = executableDigest;
    const child = spawnSync(binary, [], { encoding: 'utf8', input: `${JSON.stringify(request)}\n`, timeout: 30_000, windowsHide: true });
    const output = child.stdout ?? '';
    const answer = child.status === 0 && child.stderr === '' ? JSON.parse(output) : undefined;
    if (answer?.outcome !== 'validated' || answer.tool?.executableDigest !== executableDigest) {
        throw new Error(`Known-answer request failed on the built binary: status ${child.status}\n${child.stderr}`);
    }
    return { fixture: 'core-and-sparql', responseBytes: Buffer.byteLength(output), responseSha256: sha256(output) };
}

function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            out: { type: 'string' },
            commit: { type: 'string' },
            'source-date-epoch': { type: 'string', default: DEFAULT_SOURCE_DATE_EPOCH },
        },
    });
    const [target] = positionals;
    if (target === undefined || values.out === undefined || positionals.length !== 1) {
        throw new Error('Usage: verify-binary-reproducible.mjs <target> --out <directory> [--commit <sha>]');
    }
    const shacl = resolve(import.meta.dirname, '..');
    const repository = resolve(shacl, '..');
    const commit = values.commit ?? git(repository, 'rev-parse', 'HEAD');
    const sourceDateEpoch = values['source-date-epoch'];
    if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9]+$/u.test(sourceDateEpoch)) {
        throw new Error('The source commit must be a full SHA-1 and the epoch a whole number of seconds');
    }
    assertNativeHost(target, { platform: process.platform, arch: process.arch });
    const changed = git(repository, 'diff', '--name-only', commit, '--', 'shacl/erden-shacl', 'shacl/Cargo.toml', 'shacl/Cargo.lock');
    if (changed !== '') {
        throw new Error(`The working crate differs from ${commit}; commit it and pass that commit:\n${changed}`);
    }
    const out = resolve(values.out);
    mkdirSync(out, { recursive: true });
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), BUILD_LAYOUT.temporaryPrefix));
    try {
        const sourceA = exportSource(repository, commit, temporary, BUILD_LAYOUT.a.source);
        const sourceB = exportSource(repository, commit, temporary, BUILD_LAYOUT.b.source);
        const lock = sha256(readFileSync(join(sourceA, 'Cargo.lock')));
        if (lock !== sha256(readFileSync(join(sourceB, 'Cargo.lock'))) || lock !== CARGO_LOCK_SHA256) {
            throw new Error(`The exported Cargo.lock is ${lock}, not the qualified ${CARGO_LOCK_SHA256}`);
        }
        const a = buildOnce(target, sourceA, join(temporary, BUILD_LAYOUT.a.target), sourceDateEpoch);
        const b = buildOnce(target, sourceB, join(temporary, BUILD_LAYOUT.b.target), sourceDateEpoch);
        const runs = [a, b].map((build, index) => ({
            label: `clean-target-${'ab'[index]}`,
            sourcePath: `git-archive-${'ab'[index]}`,
            bytes: statSync(build.binary).size,
            sha256: sha256(readFileSync(build.binary)),
        }));
        if (runs[0].sha256 !== runs[1].sha256 || runs[0].bytes !== runs[1].bytes) {
            throw new Error(`${target} release executable is not byte reproducible: ${runs[0].sha256} vs ${runs[1].sha256}`);
        }
        mkdirSync(join(out, target), { recursive: true });
        const binary = join(out, target, executableName(target));
        copyFileSync(a.binary, binary);
        const record = {
            schemaVersion: 1,
            sourceCommit: commit,
            shaclCommitTree: git(repository, 'rev-parse', `${commit}:shacl`),
            crateSourceTree: git(repository, 'rev-parse', `${commit}:shacl/erden-shacl`),
            cargoLockDigest: lock,
            sourceDateEpoch: Number(sourceDateEpoch),
            toolchain: RUST_TOOLCHAIN,
            host: { platform: process.platform, arch: process.arch },
            target,
            ...(a.plan.kind === 'docker' ? { builderImage: a.plan.image, builderPlatform: a.plan.dockerPlatform } : {}),
            rustflags: a.plan.rustflagsRecord,
            runs,
            knownAnswer: knownAnswer(binary, runs[0].sha256, shacl),
            result: 'byte-identical',
        };
        writeFileSync(join(out, `${target}.json`), `${JSON.stringify(record, null, 2)}\n`);
        process.stdout.write(`${target}: ${runs[0].sha256} (${runs[0].bytes} bytes); both clean builds match\n`);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) main();
