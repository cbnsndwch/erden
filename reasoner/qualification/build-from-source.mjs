// Builds this Linux host's erden-reasoner from a committed source the way the mint does (reasoner-build.yml and
// verify-binary-reproducible.mjs): two `git archive` exports of the commit, each built with `cargo build --release
// --locked` in the digest-pinned `rust` builder image (glibc 2.36, the mint's baseline), the recorded
// SOURCE_DATE_EPOCH and path remaps. It installs the binary only when both builds are byte-identical and it passes the
// distribution's known-answer check.
//
// Until the tools release mints this platform (release.yml) there is no pin to verify against, and
// the record written beside the binary names its digest instead. Once the resolver anchors pin this platform, the
// build is installed only if it is byte-identical to the pin, and also into the platform package's `bin/`, where the
// released resolver looks. The container gates (server image, Compose deployment, offline production runtime) run
// this build, since a host `cargo build` links against the host's newer glibc.
//
//   node reasoner/qualification/build-from-source.mjs [--commit <sha>]
//   node reasoner/qualification/build-from-source.mjs --check    (refuses unless the installed build is this source's)
//
// A build already installed from the same build inputs (the adapter crate, the workspace manifest and lock, and the
// toolchain file) is kept without rebuilding.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { QUALIFIED_REASONER_ARTIFACTS, runBundledReasonerKnownAnswer } from '../distribution/src/index.js';
import { PLATFORMS } from './finalize-artifacts.mjs';
import {
  BUILD_LAYOUT,
  DEFAULT_SOURCE_DATE_EPOCH,
  LINUX_BUILDER_IMAGE,
  RUST_TOOLCHAIN,
  assertAdapterMatchesCheckout,
  assertNativeHost,
  buildOnce,
  executableName,
  exportSource,
  git,
  identity,
  sha256,
} from './verify-binary-reproducible.mjs';

const reasoner = resolve(import.meta.dirname, '..');
const repository = resolve(reasoner, '..');

/** Where the source build is installed (git-ignored, inside the Docker build context). */
export const SOURCE_BUILD_DIRECTORY = join(reasoner, 'source-build');
const LINUX_TARGETS = Object.freeze({ x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' });

/** The Linux target this host builds natively in the builder image. */
export function hostLinuxTarget() {
  const target = process.platform === 'linux' ? LINUX_TARGETS[process.arch] : undefined;
  if (target === undefined) throw new Error(`The reasoner source build runs on a Linux x64 or arm64 host, not ${process.platform} ${process.arch}`);
  return target;
}

function paths(target) {
  return {
    binary: join(SOURCE_BUILD_DIRECTORY, target, executableName(target)),
    record: join(SOURCE_BUILD_DIRECTORY, `${target}.json`),
  };
}

/** The git objects a release build of the adapter reads: anything else under `reasoner/` cannot change the binary. */
export function buildInputs(commit) {
  const object = (path) => git(repository, 'rev-parse', `${commit}:${path}`);
  return {
    adapterCrateSourceTree: object('reasoner/erden-reasoner'),
    cargoManifest: object('reasoner/Cargo.toml'),
    cargoLock: object('reasoner/Cargo.lock'),
    rustToolchain: object('reasoner/rust-toolchain.toml'),
  };
}

/**
 * The installed source build of `target` when it was built from this checkout's build inputs (HEAD) and its bytes are
 * the recorded ones; otherwise an error that says how to build it.
 */
export function readInstalledSourceBuild(target = hostLinuxTarget()) {
  const { binary, record: recordPath } = paths(target);
  const rebuild = `run \`pnpm run reasoner:build:linux\` (node reasoner/qualification/build-from-source.mjs)`;
  if (!existsSync(binary) || !existsSync(recordPath)) {
    throw new Error(`No ${target} reasoner source build is installed in ${relative(repository, SOURCE_BUILD_DIRECTORY)}; ${rebuild}`);
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const bytes = readFileSync(binary);
  const inputs = buildInputs('HEAD');
  if (record.result !== 'byte-identical' || record.target !== target || JSON.stringify(record.buildInputs) !== JSON.stringify(inputs)) {
    throw new Error(`The installed ${target} reasoner source build is not of this checkout's reasoner source; ${rebuild}`);
  }
  if (bytes.length !== record.runs[0].bytes || sha256(bytes) !== record.runs[0].sha256) {
    throw new Error(`The installed ${target} reasoner source build does not match its record; ${rebuild}`);
  }
  return { binary, record };
}

/** The platform package path and pin of `target` when the resolver anchors pin it; otherwise undefined. */
function pinnedPackage(target) {
  const platform = PLATFORMS.find((entry) => entry.target === target);
  const anchor = QUALIFIED_REASONER_ARTIFACTS[platform.key];
  if (anchor.sha256 === null) return undefined;
  return { anchor, binary: join(reasoner, platform.directory, anchor.binaryPath) };
}

function matchesPin(path, anchor) {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  return bytes.length === anchor.bytes && sha256(bytes) === anchor.sha256;
}

/** Installs a pinned source build into its platform package; refuses one that is not the pin. */
function installPinned(target, binary) {
  const pinned = pinnedPackage(target);
  if (pinned === undefined) return;
  if (!matchesPin(binary, pinned.anchor)) {
    throw new Error(`The ${target} source build is not the pinned ${pinned.anchor.sha256}; it is not installed`);
  }
  mkdirSync(join(pinned.binary, '..'), { recursive: true });
  copyFileSync(binary, pinned.binary);
  chmodSync(pinned.binary, 0o755);
}

function main() {
  const { values } = parseArgs({ options: { commit: { type: 'string' }, check: { type: 'boolean', default: false } } });
  const target = hostLinuxTarget();
  if (values.check) {
    const { record } = readInstalledSourceBuild(target);
    const pinned = pinnedPackage(target);
    if (pinned !== undefined && !matchesPin(pinned.binary, pinned.anchor)) {
      throw new Error(`The ${target} platform package does not hold the pinned reasoner; run \`pnpm run reasoner:build:linux\``);
    }
    process.stdout.write(`${target}: the installed source build ${record.runs[0].sha256} is of this checkout's reasoner source (built from ${record.qualificationSourceCommit})\n`);
    return;
  }
  const commit = values.commit ?? git(repository, 'rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('The source commit must be a full SHA-1');
  assertNativeHost(target, { platform: process.platform, arch: process.arch });
  assertAdapterMatchesCheckout(repository, commit);
  const { binary, record: recordPath } = paths(target);
  if (values.commit === undefined) {
    try {
      const { binary: installed, record } = readInstalledSourceBuild(target);
      installPinned(target, installed);
      process.stdout.write(`${target}: the installed source build ${record.runs[0].sha256} is of this reasoner source; kept\n`);
      return;
    } catch {
      // Not installed, or of another tree: build it.
    }
  }
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), BUILD_LAYOUT.temporaryPrefix));
  try {
    const sourceA = exportSource(repository, commit, temporary, BUILD_LAYOUT.a.source);
    const sourceB = exportSource(repository, commit, temporary, BUILD_LAYOUT.b.source);
    const lock = sha256(readFileSync(join(sourceA, 'Cargo.lock')));
    if (lock !== sha256(readFileSync(join(sourceB, 'Cargo.lock')))) throw new Error('Archived Cargo.lock differs across exports');
    const a = buildOnce(target, sourceA, join(temporary, BUILD_LAYOUT.a.target), DEFAULT_SOURCE_DATE_EPOCH);
    const b = buildOnce(target, sourceB, join(temporary, BUILD_LAYOUT.b.target), DEFAULT_SOURCE_DATE_EPOCH);
    const runs = [
      identity(a.binary, BUILD_LAYOUT.a.label, BUILD_LAYOUT.a.source),
      identity(b.binary, BUILD_LAYOUT.b.label, BUILD_LAYOUT.b.source),
    ];
    if (runs[0].bytes !== runs[1].bytes || runs[0].sha256 !== runs[1].sha256) {
      throw new Error(`${target} release executable is not byte reproducible: ${runs[0].sha256} vs ${runs[1].sha256}; not installed`);
    }
    const pinned = pinnedPackage(target);
    if (pinned !== undefined && runs[0].sha256 !== pinned.anchor.sha256) {
      throw new Error(`${target} built ${runs[0].sha256}, not the pinned ${pinned.anchor.sha256}; not installed`);
    }
    rmSync(binary, { force: true });
    rmSync(recordPath, { force: true });
    mkdirSync(join(SOURCE_BUILD_DIRECTORY, target), { recursive: true });
    copyFileSync(a.binary, binary);
    chmodSync(binary, 0o755);
    installPinned(target, binary);
    const knownAnswer = runBundledReasonerKnownAnswer({ sourceBuild: binary });
    const record = {
      schemaVersion: 1,
      kind: 'unreleased-source-build',
      qualificationSourceCommit: commit,
      qualificationReasonerCommitTree: git(repository, 'rev-parse', `${commit}:reasoner`),
      buildInputs: buildInputs(commit),
      cargoLockDigest: lock,
      sourceDateEpoch: Number(DEFAULT_SOURCE_DATE_EPOCH),
      toolchain: RUST_TOOLCHAIN,
      host: { platform: process.platform, arch: process.arch },
      target,
      builderImage: LINUX_BUILDER_IMAGE,
      builderPlatform: a.plan.dockerPlatform,
      rustflags: a.plan.rustflagsRecord,
      runs,
      knownAnswer,
      result: 'byte-identical',
    };
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`${target}: built twice from ${commit}, byte-identical ${runs[0].sha256} (${runs[0].bytes} bytes); installed\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
