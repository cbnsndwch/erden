// Builds this platform's erden-shacl from the committed crate and installs it into its platform package, but only when
// the build is byte-identical to the pinned mint (the size and SHA-256 in shacl/distribution/src/artifacts.js). The
// binaries are never committed; until the tools release ships the minted ones (release.yml), this
// is how a checkout or a CI job gets the engine.
//
//   node shacl/qualification/build-from-source.mjs [--commit <sha>]
//   node shacl/qualification/build-from-source.mjs --check     (refuses unless the pinned binary is installed)
//
// One clean build with the mint's plan and directory layout (verify-binary-reproducible.mjs, its build A): the
// digest-pinned builder image on Linux, rustup 1.98.0 on Windows and macOS, `cargo build --release --locked`, the
// recorded SOURCE_DATE_EPOCH and path remaps.
// An installed binary that already matches its pin is kept without rebuilding.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

import { QUALIFIED_SHACL_ARTIFACTS } from '../distribution/src/index.js';
import { PLATFORMS } from './finalize-artifacts.mjs';
import {
    BUILD_LAYOUT,
    CARGO_LOCK_SHA256,
    DEFAULT_SOURCE_DATE_EPOCH,
    buildOnce,
    executableName,
    exportSource,
} from './verify-binary-reproducible.mjs';

const shacl = resolve(import.meta.dirname, '..');
const repository = resolve(shacl, '..');

function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function git(...args) {
    return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}
function matchesPin(path, anchor) {
    if (!existsSync(path)) return false;
    const bytes = readFileSync(path);
    return bytes.length === anchor.bytes && sha256(bytes) === anchor.sha256;
}

function main() {
    const { values } = parseArgs({ options: { commit: { type: 'string' }, check: { type: 'boolean', default: false } } });
    const platform = PLATFORMS.find((entry) => entry.runtime.os === process.platform && entry.runtime.cpu === process.arch);
    if (platform === undefined) throw new Error(`erden-shacl has no qualified target for ${process.platform}/${process.arch}`);
    const anchor = QUALIFIED_SHACL_ARTIFACTS[platform.key];
    const destination = join(shacl, platform.directory, 'bin', executableName(platform.target));
    if (matchesPin(destination, anchor)) {
        process.stdout.write(`${platform.target}: the installed binary is the pinned ${anchor.sha256}\n`);
        return;
    }
    if (values.check) {
        process.stderr.write(
            `The ${platform.target} erden-shacl binary is not installed, or is not the pinned one. Build it once with ` +
                '`pnpm run build:shacl` (Docker on Linux, rustup 1.98.0 on macOS and Windows); the tools release (TS-6) ' +
                'will ship it instead.\n',
        );
        process.exitCode = 1;
        return;
    }
    const commit = values.commit ?? git('rev-parse', 'HEAD');
    const changed = git('diff', '--name-only', commit, '--', 'shacl/erden-shacl', 'shacl/Cargo.toml', 'shacl/Cargo.lock');
    if (changed !== '') throw new Error(`The working crate differs from ${commit}; commit it first:\n${changed}`);
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), BUILD_LAYOUT.temporaryPrefix));
    try {
        const source = exportSource(repository, commit, temporary, BUILD_LAYOUT.a.source);
        const lock = sha256(readFileSync(join(source, 'Cargo.lock')));
        if (lock !== CARGO_LOCK_SHA256) throw new Error(`The exported Cargo.lock is ${lock}, not the qualified ${CARGO_LOCK_SHA256}`);
        const build = buildOnce(platform.target, source, join(temporary, BUILD_LAYOUT.a.target), DEFAULT_SOURCE_DATE_EPOCH);
        if (!matchesPin(build.binary, anchor)) {
            const bytes = readFileSync(build.binary);
            throw new Error(
                `The ${platform.target} build from ${commit} is ${sha256(bytes)} (${String(bytes.length)} bytes), not the pinned ` +
                    `${anchor.sha256} (${String(anchor.bytes)} bytes); it is not installed`,
            );
        }
        mkdirSync(join(shacl, platform.directory, 'bin'), { recursive: true });
        copyFileSync(build.binary, destination);
        chmodSync(destination, 0o755);
        process.stdout.write(`${platform.target}: built from ${commit}, byte-identical to the pinned ${anchor.sha256}; installed\n`);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) main();
