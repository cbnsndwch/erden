// Builds one reasoner target twice, from two separate `git archive` exports of the qualification source commit, on
// a native host for that target, and proves the two release executables byte-identical. Linux targets build in the
// pinned `rust` image (its own architecture's variant, never emulated); Windows and macOS build with the host's
// rustup toolchain. The record and binary it writes are the inputs a mint copies into the platform packages.
//
//   node reasoner/qualification/verify-binary-reproducible.mjs <target> --out <directory>
//        [--commit <sha>] [--source-date-epoch <seconds>]
//
// `--commit` defaults to the accepted qualification commit. Like the PowerShell mint, the script refuses a commit
// whose `reasoner/erden-reasoner` differs from the checkout, so a changed adapter is never answered with a build of
// older source. Each export is made with line-ending conversion off and must match the commit's blobs byte for byte,
// and an exported Cargo.lock must hash to the accepted record's digest when the commit carries the accepted lock.
// Native builds run in the export with Cargo, rustc and C-compiler variables cleared, refuse any Cargo
// configuration file that would apply, and record the linker identity (Xcode and its SDK, or MSVC) with the result.
//
// `verify-binary-reproducible.ps1` remains the local Windows-host mint for the two x64 packages.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, copyFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { REASONER_TOOL } from '../distribution/src/index.js';

export const LINUX_BUILDER_IMAGE = 'rust@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc';
export const RUST_TOOLCHAIN = Object.freeze({
  rustc: '1.96.0',
  commit: 'ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96',
  llvm: '22.1.2',
});
export const DEFAULT_SOURCE_DATE_EPOCH = '1785703783';
/** The mint's temporary layout: two `git archive` exports, each built into its own clean target directory. */
export const BUILD_LAYOUT = Object.freeze({
  temporaryPrefix: 'erden-binary-repro-',
  a: Object.freeze({ source: 'git-archive-a', target: 'target-a', label: 'clean-target-a' }),
  b: Object.freeze({ source: 'git-archive-b', target: 'target-b', label: 'clean-target-b' }),
});
/** The memory cap of one builder container (`docker run --memory`, no swap). */
export const BUILDER_MEMORY = '8g';
const REMAP_RECORD = '--remap-path-prefix=<reasoner>=/erden-reasoner --remap-path-prefix=<cargo-home>=/cargo';
const LINUX_RUSTFLAGS =
  '-C link-arg=-Wl,--build-id=none --remap-path-prefix=/work=/erden-reasoner --remap-path-prefix=/usr/local/cargo=/cargo';

const TARGETS = Object.freeze({
  'x86_64-unknown-linux-gnu': { host: { platform: 'linux', arch: 'x64' }, builder: 'docker', dockerPlatform: 'linux/amd64' },
  'aarch64-unknown-linux-gnu': { host: { platform: 'linux', arch: 'arm64' }, builder: 'docker', dockerPlatform: 'linux/arm64' },
  'x86_64-pc-windows-msvc': { host: { platform: 'win32', arch: 'x64' }, builder: 'native', linkerFlags: '-C link-arg=/Brepro ' },
  'aarch64-apple-darwin': { host: { platform: 'darwin', arch: 'arm64' }, builder: 'native', linkerFlags: '' },
});
export const REPRODUCIBLE_TARGETS = Object.freeze(Object.keys(TARGETS));

export function executableName(target) {
  return target.endsWith('-windows-msvc') ? 'erden-reasoner.exe' : 'erden-reasoner';
}

/** Refuses an unknown target or a host that would need emulation or cross-linking; returns how the target builds. */
export function assertNativeHost(target, host) {
  const definition = Object.hasOwn(TARGETS, target) ? TARGETS[target] : undefined;
  if (definition === undefined) {
    throw new Error(`Unsupported target ${target}; supported: ${REPRODUCIBLE_TARGETS.join(', ')}`);
  }
  if (host.platform !== definition.host.platform || host.arch !== definition.host.arch) {
    throw new Error(
      `${target} builds only on a native ${definition.host.platform} ${definition.host.arch} host; ` +
        `this host is ${host.platform} ${host.arch} (no emulation or cross-linking)`,
    );
  }
  return definition;
}

/** Pure description of one clean build; `paths` matters only for native builds. */
export function planBuild(target, host, paths = {}, sourceDateEpoch = DEFAULT_SOURCE_DATE_EPOCH) {
  const definition = assertNativeHost(target, host);
  const binaryRelativePath = `${target}/release/${executableName(target)}`;
  if (definition.builder === 'docker') {
    return {
      kind: 'docker',
      image: LINUX_BUILDER_IMAGE,
      dockerPlatform: definition.dockerPlatform,
      command:
        `export CARGO_TARGET_DIR=/target CARGO_INCREMENTAL=0 SOURCE_DATE_EPOCH=${sourceDateEpoch}; ` +
        `export RUSTFLAGS="${LINUX_RUSTFLAGS}"; ` +
        `cargo build --release --locked --target ${target} --bin erden-reasoner`,
      rustflagsRecord: LINUX_RUSTFLAGS,
      binaryRelativePath,
    };
  }
  const { sourceDirectory, cargoHome } = paths;
  if (typeof sourceDirectory !== 'string' || typeof cargoHome !== 'string') {
    throw new Error('A native build needs the exported source directory and the Cargo home');
  }
  return {
    kind: 'native',
    env: {
      CARGO_INCREMENTAL: '0',
      SOURCE_DATE_EPOCH: sourceDateEpoch,
      RUSTFLAGS:
        `${definition.linkerFlags}--remap-path-prefix=${sourceDirectory}=/erden-reasoner ` +
        `--remap-path-prefix=${cargoHome}=/cargo`,
    },
    args: [
      'run', RUST_TOOLCHAIN.rustc, 'cargo', 'build', '--release', '--locked', '--target', target,
      '--bin', 'erden-reasoner', '--manifest-path', join(sourceDirectory, 'Cargo.toml'),
    ],
    rustflagsRecord: `${definition.linkerFlags}${REMAP_RECORD}`,
    binaryRelativePath,
  };
}

// Ambient variables that change what Cargo, rustc or the C compiler behind `blake3` produce. Only CARGO_HOME, which
// the remap covers, survives; MACOSX_DEPLOYMENT_TARGET is cleared so rustc's own default applies.
const AMBIENT_BUILD_VARIABLE =
  /^(?:CARGO|CARGO_(?!HOME$).+|RUSTC(?:_.+)?|RUSTDOC(?:_.+)?|RUSTDOCFLAGS|RUSTFLAGS|CRATE_CC_NO_DEFAULTS|MACOSX_DEPLOYMENT_TARGET|(?:HOST_|TARGET_)?(?:CC|CXX|AR|RANLIB|CFLAGS|CXXFLAGS|CPPFLAGS|ASMFLAGS|LDFLAGS)(?:_.+)?)$/iu;

/** The environment for one native build: the ambient one without build-changing variables, plus the plan's. */
export function nativeBuildEnvironment(ambient, plan, targetDirectory) {
  const kept = Object.entries(ambient).filter(([name]) => !AMBIENT_BUILD_VARIABLE.test(name));
  return { ...Object.fromEntries(kept), ...plan.env, CARGO_TARGET_DIR: targetDirectory };
}

/** Cargo configuration files a build of `sourceDirectory` would read: its ancestors' `.cargo` and the Cargo home. */
export function cargoConfigurationFiles(sourceDirectory, cargoHome) {
  const candidates = [];
  for (let directory = sourceDirectory; ; directory = dirname(directory)) {
    candidates.push(join(directory, '.cargo', 'config'), join(directory, '.cargo', 'config.toml'));
    if (dirname(directory) === directory) break;
  }
  candidates.push(join(cargoHome, 'config'), join(cargoHome, 'config.toml'));
  return [...new Set(candidates)].filter((path) => existsSync(path));
}

function run(command, args, options = {}) {
  const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options });
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${child.error?.message ?? child.status}):\n${child.stderr ?? ''}`);
  }
  return child.stdout;
}

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function identity(path, label, sourcePath) {
  return { label, sourcePath, bytes: statSync(path).size, sha256: sha256(readFileSync(path)) };
}

function assertToolchain(versionOutput) {
  const field = (name) => new RegExp(`^${name}: (.+)$`, 'mu').exec(versionOutput)?.[1]?.trim();
  const actual = { rustc: field('release'), commit: field('commit-hash'), llvm: field('LLVM version') };
  if (JSON.stringify(actual) !== JSON.stringify(RUST_TOOLCHAIN)) {
    throw new Error(`Rust toolchain ${JSON.stringify(actual)} is not the qualified ${JSON.stringify(RUST_TOOLCHAIN)}`);
  }
}

/** Every line of a probe's output (stdout, then stderr) with surrounding whitespace removed. */
function probe(command, args) {
  const child = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${child.error?.message ?? child.status}); cannot record the linker`);
  }
  return `${child.stdout}\n${child.stderr}`.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
}

/** The identity of the tools that link a native target, which the runner label alone does not pin. */
function nativeLinkerIdentity(target) {
  if (target.endsWith('-apple-darwin')) {
    const [sdkVersion] = probe('xcrun', ['--sdk', 'macosx', '--show-sdk-version']);
    const [sdkBuild] = probe('xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']);
    return complete({
      xcode: probe('xcodebuild', ['-version']).join(' ').replace(/ (Build version .+)$/u, ' ($1)'),
      sdk: `macosx ${sdkVersion} (${sdkBuild})`,
      // rustc links Apple targets through `cc`, which runs Xcode's `ld`.
      cc: probe('cc', ['--version'])[0],
      ld: probe('xcrun', ['ld', '-v']).find((line) => line.startsWith('@(#)PROGRAM:ld')),
    });
  }
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  const [installation] = JSON.parse(
    run(vswhere, [
      '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json',
    ]),
  );
  if (installation === undefined) throw new Error('No Visual Studio installation with the MSVC x64 tools was found');
  const tools = join(installation.installationPath, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt');
  return complete({ visualStudio: installation.installationVersion, msvcTools: readFileSync(tools, 'utf8').trim() });
}

function complete(identity) {
  const missing = Object.entries(identity).filter(([, value]) => typeof value !== 'string' || value === '');
  if (missing.length > 0) throw new Error(`Cannot record the linker: no ${missing.map(([name]) => name).join(', ')}`);
  return identity;
}

export function assertAdapterMatchesCheckout(repository, commit) {
  if (spawnSync('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`]).status !== 0) {
    throw new Error(`Source commit ${commit} is unavailable; in a shallow clone, fetch that exact commit first`);
  }
  const changed = [
    ...git(repository, 'diff', '--name-only', commit, '--', 'reasoner/erden-reasoner').split('\n'),
    ...git(repository, 'ls-files', '--others', '--exclude-standard', '--', 'reasoner/erden-reasoner').split('\n'),
  ].filter((line) => line !== '');
  if (changed.length > 0) {
    throw new Error(
      `The working adapter crate differs from ${commit}, so its build would not be this checkout's reasoner. ` +
        `Commit the change and pass that commit with --commit:\n${changed.join('\n')}`,
    );
  }
}

// `git archive` writes files as a checkout would, so line-ending settings change the exported bytes: on a Windows
// runner `core.autocrlf=true` turned every text file into CRLF. Both settings are pinned off for the export, and the
// export is then compared with the commit byte for byte, which also catches `eol`, `export-ignore` or `export-subst`
// attributes from the tree, `info/attributes` or a global attributes file.
const EXPORT_CONFIGURATION = Object.freeze(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);

export function exportSource(repository, commit, root, label) {
  const directory = join(root, label);
  const archive = join(root, `${label}.tar`);
  mkdirSync(directory);
  run('git', [...EXPORT_CONFIGURATION, '-C', repository, 'archive', '--format=tar', `--output=${archive}`, commit, 'reasoner']);
  // Relative operands: GNU tar on Windows would read `C:` in an absolute path as a remote host.
  run('tar', ['-xf', `${label}.tar`, '-C', label], { cwd: root });
  const source = join(directory, 'reasoner');
  if (!existsSync(join(source, 'Cargo.lock'))) throw new Error(`Exported source ${label} is incomplete`);
  assertExportMatchesCommit(repository, commit, directory, label);
  return source;
}

/** Refuses an export whose files are not exactly the commit's `reasoner` blobs: same paths, same raw bytes. */
export function assertExportMatchesCommit(repository, commit, exportRoot, label) {
  const expected = new Map();
  for (const entry of run('git', ['-C', repository, 'ls-tree', '-r', '-z', '--full-tree', commit, '--', 'reasoner']).split('\0')) {
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
      `Exported source ${label} is not byte-identical to ${commit} (line-ending conversion or export attributes?):\n` +
        [...differing.map((path) => `differs: ${path}`), ...missing.map((path) => `missing: ${path}`)].join('\n'),
    );
  }
}

/**
 * Refuses an exported Cargo.lock that does not hash to the accepted record's digest when the built commit carries
 * the accepted lock: the accepted commit itself, or a commit whose `reasoner/Cargo.lock` is the same blob.
 */
export function assertLockMatchesAcceptedRecord(repository, commit, accepted, exportedLockDigest) {
  const { cargoLockDigest, qualificationSourceCommit } = accepted;
  if (typeof cargoLockDigest !== 'string') return;
  const acceptedCommitAvailable =
    typeof qualificationSourceCommit === 'string' &&
    spawnSync('git', ['-C', repository, 'cat-file', '-e', `${qualificationSourceCommit}^{commit}`]).status === 0;
  const carriesAcceptedLock =
    commit === qualificationSourceCommit ||
    (acceptedCommitAvailable &&
      git(repository, 'rev-parse', `${commit}:reasoner/Cargo.lock`) ===
        git(repository, 'rev-parse', `${qualificationSourceCommit}:reasoner/Cargo.lock`));
  if (carriesAcceptedLock && exportedLockDigest !== cargoLockDigest) {
    throw new Error(
      `The exported Cargo.lock is ${exportedLockDigest}, but ${commit} carries the accepted lock, which ` +
        `binary-reproducibility.json records as ${cargoLockDigest}`,
    );
  }
}

function dockerUser() {
  return typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
}

export function buildOnce(target, source, targetDirectory, sourceDateEpoch) {
  const host = { platform: process.platform, arch: process.arch };
  mkdirSync(targetDirectory);
  if (TARGETS[target].builder === 'docker') {
    const plan = planBuild(target, host, {}, sourceDateEpoch);
    // The build runs as root so Cargo keeps the image's /usr/local/cargo home (part of the remapped, accepted
    // flags); handing the target directory back afterwards cannot change the finished executable.
    const owner = dockerUser();
    const handBack = owner === undefined ? '' : ` && chown -R ${owner} /target`;
    const output = run('docker', [
      'run', '--rm', '--platform', plan.dockerPlatform, '--memory', BUILDER_MEMORY, '--memory-swap', BUILDER_MEMORY,
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
    throw new Error(`Cargo configuration would reach the build: ${configuration.join(', ')}; move it aside or use a clean CARGO_HOME`);
  }
  const env = nativeBuildEnvironment(process.env, plan, targetDirectory);
  // Run in the export so no configuration of the checkout's directories applies.
  assertToolchain(run('rustup', ['run', RUST_TOOLCHAIN.rustc, 'rustc', '-vV'], { env, cwd: source }));
  run('rustup', plan.args, { env, cwd: source, stdio: ['ignore', 'pipe', 'inherit'] });
  return { plan, binary: join(targetDirectory, plan.binaryRelativePath) };
}

/**
 * Runs the shipped known-answer request against a freshly built binary, naming the tool the resolver ships
 * (`REASONER_TOOL`), and returns the response anchors the resolver will check.
 */
function knownAnswer(binary, executableDigest, reasoner) {
  const fixture = JSON.parse(readFileSync(join(reasoner, 'distribution/fixtures/known-answer.request.json'), 'utf8'));
  const request = {
    ...fixture,
    requiredTool: {
      adapterDigest: REASONER_TOOL.adapterDigest,
      calculusDigest: REASONER_TOOL.calculusDigest,
      executableDigest,
      name: REASONER_TOOL.name,
      version: REASONER_TOOL.version,
    },
  };
  const child = spawnSync(binary, [], { encoding: 'utf8', input: `${JSON.stringify(request)}\n`, timeout: 10_000, windowsHide: true });
  const output = child.stdout ?? '';
  const response = child.status === 0 && child.stderr === '' ? JSON.parse(output) : undefined;
  if (
    response?.result?.outcome !== 'decided' ||
    response.result.completeness !== 'complete' ||
    response.result.consistency !== 'consistent' ||
    response.result.certificate?.checked !== true
  ) {
    throw new Error(`Known-answer request failed on the built binary: status ${child.status}\n${child.stderr}`);
  }
  return { fixture: 'subclass-type', responseBytes: Buffer.byteLength(output), responseSha256: sha256(output) };
}

export function git(repository, ...args) {
  return run('git', ['-C', repository, ...args]).trim();
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
    throw new Error(`Usage: verify-binary-reproducible.mjs <${REPRODUCIBLE_TARGETS.join('|')}> --out <directory>`);
  }
  const reasoner = resolve(import.meta.dirname, '..');
  const repository = resolve(reasoner, '..');
  const accepted = JSON.parse(readFileSync(join(reasoner, 'qualification/binary-reproducibility.json'), 'utf8'));
  const commit = values.commit ?? accepted.qualificationSourceCommit;
  const sourceDateEpoch = values['source-date-epoch'];
  if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9]+$/u.test(sourceDateEpoch)) {
    throw new Error('The source commit must be a full SHA-1 and the epoch a whole number of seconds');
  }
  const { builder } = assertNativeHost(target, { platform: process.platform, arch: process.arch });
  assertAdapterMatchesCheckout(repository, commit);
  const linker = builder === 'native' ? nativeLinkerIdentity(target) : undefined;
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), BUILD_LAYOUT.temporaryPrefix));
  try {
    const sourceA = exportSource(repository, commit, temporary, BUILD_LAYOUT.a.source);
    const sourceB = exportSource(repository, commit, temporary, BUILD_LAYOUT.b.source);
    const lockA = sha256(readFileSync(join(sourceA, 'Cargo.lock')));
    if (lockA !== sha256(readFileSync(join(sourceB, 'Cargo.lock')))) throw new Error('Archived Cargo.lock differs across exports');
    assertLockMatchesAcceptedRecord(repository, commit, accepted, lockA);
    const a = buildOnce(target, sourceA, join(temporary, BUILD_LAYOUT.a.target), sourceDateEpoch);
    const b = buildOnce(target, sourceB, join(temporary, BUILD_LAYOUT.b.target), sourceDateEpoch);
    const runs = [
      identity(a.binary, BUILD_LAYOUT.a.label, BUILD_LAYOUT.a.source),
      identity(b.binary, BUILD_LAYOUT.b.label, BUILD_LAYOUT.b.source),
    ];
    if (runs[0].bytes !== runs[1].bytes || runs[0].sha256 !== runs[1].sha256) {
      throw new Error(`${target} release executable is not byte reproducible: ${runs[0].sha256} vs ${runs[1].sha256}`);
    }
    const binaryDirectory = join(out, target);
    mkdirSync(binaryDirectory, { recursive: true });
    const binary = join(binaryDirectory, executableName(target));
    copyFileSync(a.binary, binary);
    const record = {
      schemaVersion: 1,
      qualificationSourceCommit: commit,
      qualificationReasonerCommitTree: git(repository, 'rev-parse', `${commit}:reasoner`),
      adapterCrateSourceTree: git(repository, 'rev-parse', `${commit}:reasoner/erden-reasoner`),
      cargoLockDigest: lockA,
      sourceDateEpoch: Number(sourceDateEpoch),
      toolchain: RUST_TOOLCHAIN,
      host: { platform: process.platform, arch: process.arch },
      target,
      ...(a.plan.kind === 'docker' ? { builderImage: a.plan.image, builderPlatform: a.plan.dockerPlatform } : { linker }),
      rustflags: a.plan.rustflagsRecord,
      runs,
      knownAnswer: knownAnswer(binary, runs[0].sha256, reasoner),
      result: 'byte-identical',
    };
    writeFileSync(join(out, `${target}.json`), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`${target}: ${runs[0].sha256} (${runs[0].bytes} bytes); both clean builds match\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
