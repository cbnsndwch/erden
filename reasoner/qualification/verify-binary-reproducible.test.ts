import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  LINUX_BUILDER_IMAGE,
  REPRODUCIBLE_TARGETS,
  nativeBuildEnvironment,
  planBuild,
} from './verify-binary-reproducible.mjs';

const qualification = import.meta.dirname;
interface RecordedPlatform { readonly builderImage?: string; readonly rustflags: string; readonly target: string }
const recorded = JSON.parse(readFileSync(join(qualification, 'binary-reproducibility.json'), 'utf8')) as {
  readonly linux: RecordedPlatform;
  readonly windows: RecordedPlatform;
};
const ps1 = readFileSync(join(qualification, 'verify-binary-reproducible.ps1'), 'utf8');

describe('Unix reproducible build plan', () => {
  test('supports every shipped or planned target', () => {
    expect([...REPRODUCIBLE_TARGETS].sort()).toEqual([
      'aarch64-apple-darwin',
      'aarch64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
      'x86_64-unknown-linux-gnu',
    ]);
  });

  test('Linux x64 repeats the accepted container build exactly', () => {
    const plan = planBuild('x86_64-unknown-linux-gnu', { platform: 'linux', arch: 'x64' });
    expect(plan.kind).toBe('docker');
    if (plan.kind !== 'docker') return;
    expect(plan.image).toBe(recorded.linux.builderImage);
    expect(plan.image).toBe(LINUX_BUILDER_IMAGE);
    expect(plan.dockerPlatform).toBe('linux/amd64');
    expect(plan.rustflagsRecord).toBe(recorded.linux.rustflags);
    const accepted = /\$command = '([^']+)'/u.exec(ps1)?.[1];
    expect(plan.command).toBe(accepted);
    expect(plan.binaryRelativePath).toBe('x86_64-unknown-linux-gnu/release/erden-reasoner');
  });

  test('Linux arm64 uses the same pinned image and flags with only the target changed', () => {
    const x64 = planBuild('x86_64-unknown-linux-gnu', { platform: 'linux', arch: 'x64' });
    const arm64 = planBuild('aarch64-unknown-linux-gnu', { platform: 'linux', arch: 'arm64' });
    expect(arm64.kind).toBe('docker');
    if (arm64.kind !== 'docker' || x64.kind !== 'docker') return;
    expect(arm64.image).toBe(x64.image);
    expect(arm64.dockerPlatform).toBe('linux/arm64');
    expect(arm64.rustflagsRecord).toBe(x64.rustflagsRecord);
    expect(arm64.command).toBe(x64.command.replace('x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'));
  });

  test('Windows repeats the accepted native flags', () => {
    const plan = planBuild(
      'x86_64-pc-windows-msvc',
      { platform: 'win32', arch: 'x64' },
      { sourceDirectory: 'C:\\t\\a\\reasoner', cargoHome: 'C:\\Users\\u\\.cargo' },
    );
    expect(plan.kind).toBe('native');
    if (plan.kind !== 'native') return;
    expect(plan.rustflagsRecord).toBe(recorded.windows.rustflags);
    expect(plan.env.RUSTFLAGS).toBe(
      '-C link-arg=/Brepro --remap-path-prefix=C:\\t\\a\\reasoner=/erden-reasoner --remap-path-prefix=C:\\Users\\u\\.cargo=/cargo',
    );
    expect(plan.env).toMatchObject({ CARGO_INCREMENTAL: '0', SOURCE_DATE_EPOCH: '1785703783' });
    expect(plan.args).toEqual([
      'run', '1.96.0', 'cargo', 'build', '--release', '--locked', '--target', 'x86_64-pc-windows-msvc',
      '--bin', 'erden-reasoner', '--manifest-path', join('C:\\t\\a\\reasoner', 'Cargo.toml'),
    ]);
    expect(plan.binaryRelativePath).toBe('x86_64-pc-windows-msvc/release/erden-reasoner.exe');
  });

  test('macOS arm64 builds natively with remapped source and Cargo paths', () => {
    const plan = planBuild(
      'aarch64-apple-darwin',
      { platform: 'darwin', arch: 'arm64' },
      { sourceDirectory: '/tmp/a/reasoner', cargoHome: '/Users/u/.cargo' },
    );
    expect(plan.kind).toBe('native');
    if (plan.kind !== 'native') return;
    expect(plan.env.RUSTFLAGS).toBe('--remap-path-prefix=/tmp/a/reasoner=/erden-reasoner --remap-path-prefix=/Users/u/.cargo=/cargo');
    expect(plan.rustflagsRecord).toBe('--remap-path-prefix=<reasoner>=/erden-reasoner --remap-path-prefix=<cargo-home>=/cargo');
    expect(plan.binaryRelativePath).toBe('aarch64-apple-darwin/release/erden-reasoner');
  });

  test('refuses to build a target on a host that would need emulation or cross-linking', () => {
    expect(() => planBuild('aarch64-unknown-linux-gnu', { platform: 'linux', arch: 'x64' })).toThrow(
      /aarch64-unknown-linux-gnu builds only on a native linux arm64 host/u,
    );
    expect(() => planBuild('aarch64-apple-darwin', { platform: 'linux', arch: 'arm64' })).toThrow(/native darwin arm64/u);
    expect(() => planBuild('x86_64-apple-darwin', { platform: 'darwin', arch: 'x64' })).toThrow(
      /Unsupported target x86_64-apple-darwin; supported: /u,
    );
  });
});

describe('native build environment', () => {
  test('clears every Cargo, rustc and C-compiler variable except the remapped Cargo home', () => {
    const plan = planBuild(
      'aarch64-apple-darwin',
      { platform: 'darwin', arch: 'arm64' },
      { sourceDirectory: '/tmp/a/reasoner', cargoHome: '/Users/u/.cargo' },
    );
    if (plan.kind !== 'native') throw new Error('expected a native plan');
    const ambient = {
      ...AMBIENT_EXTRA,
      PATH: '/usr/bin',
      HOME: '/Users/u',
      CARGO_HOME: '/Users/u/.cargo',
      DEVELOPER_DIR: '/Applications/Xcode.app',
      PROCESSOR_ARCHITECTURE: 'ARM64',
      CCACHE_DIR: '/c',
    };
    expect(nativeBuildEnvironment(ambient, plan, '/tmp/target-a')).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/u',
      CARGO_HOME: '/Users/u/.cargo',
      DEVELOPER_DIR: '/Applications/Xcode.app',
      PROCESSOR_ARCHITECTURE: 'ARM64',
      CCACHE_DIR: '/c',
      ...plan.env,
      CARGO_TARGET_DIR: '/tmp/target-a',
    });
  });
});

const AMBIENT_EXTRA = {
  CARGO: '/usr/bin/cargo',
  CARGO_BUILD_TARGET: 'x86_64-apple-darwin',
  CARGO_ENCODED_RUSTFLAGS: '-Copt-level=0',
  CARGO_PROFILE_RELEASE_OPT_LEVEL: '0',
  CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS: '-Cdebuginfo=2',
  RUSTC: '/opt/rustc',
  RUSTC_WORKSPACE_WRAPPER: 'w',
  RUSTDOCFLAGS: '-x',
  RUSTFLAGS: '-Copt-level=0',
  CXX: 'clang++',
  AR_aarch64_apple_darwin: 'llvm-ar',
  TARGET_CFLAGS: '-g',
  HOST_CC: 'gcc',
  CRATE_CC_NO_DEFAULTS: '1',
  cflags: '-O0',
  MACOSX_DEPLOYMENT_TARGET: '14.0',
};

// #region Native hosts, end to end
// These run the real script under a faked process.platform/arch against a throwaway git repository, with stub
// rustup, Xcode and Visual Studio tools on PATH, so the native code path runs without a macOS or Windows host.

const RUSTC_VERSION =
  'rustc 1.96.0 (ac68faa20 2026-01-01)\\nbinary: rustc\\ncommit-hash: ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96\\n' +
  'commit-date: 2026-01-01\\nhost: stub\\nrelease: 1.96.0\\nLLVM version: 22.1.2\\n';
const DECIDED = '{"result":{"outcome":"decided","completeness":"complete","consistency":"consistent","certificate":{"checked":true}}}';
const AMBIENT = {
  CARGO_PROFILE_RELEASE_LTO: 'fat',
  CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER: '/opt/other/ld',
  RUSTC_WRAPPER: 'sccache',
  CC: 'gcc-13',
  CFLAGS: '-O0',
  MACOSX_DEPLOYMENT_TARGET: '14.0',
};

const STUB_LOCK = '# stub lock\n';
const STUB_LOCK_DIGEST = `sha256:${createHash('sha256').update(STUB_LOCK).digest('hex')}`;

interface Sandbox {
  readonly root: string;
  readonly repository: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly out: string;
  readonly commit: string;
}

function put(path: string, content: string, executable = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}

function gitIn(repository: string, ...args: string[]): string {
  const child = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', env: withoutGit(process.env) });
  if (child.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${child.stderr}`);
  return child.stdout.trim();
}

function withoutGit(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')));
}

function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'erden-native-build-test-')));
  const repository = join(root, 'repository');
  const reasoner = join(repository, 'reasoner');
  put(join(reasoner, 'qualification/verify-binary-reproducible.mjs'), readFileSync(join(qualification, 'verify-binary-reproducible.mjs'), 'utf8'));
  put(join(reasoner, 'Cargo.lock'), STUB_LOCK);
  put(join(reasoner, 'erden-reasoner/src/main.rs'), 'fn main() {}\n');
  put(
    join(reasoner, 'distribution/src/index.js'),
    "export const REASONER_TOOL = Object.freeze({ name: 'erden-reasoner', version: '0', adapterDigest: 'sha256:a', calculusDigest: 'sha256:c' });\n",
  );
  put(join(reasoner, 'distribution/fixtures/known-answer.request.json'), '{}\n');
  gitIn(root, 'init', '--quiet', repository);
  gitIn(repository, 'add', '.');
  gitIn(repository, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--no-gpg-sign', '-m', 'source');
  const commit = gitIn(repository, 'rev-parse', 'HEAD');
  put(
    join(reasoner, 'qualification/binary-reproducibility.json'),
    JSON.stringify({ qualificationSourceCommit: commit, cargoLockDigest: STUB_LOCK_DIGEST }),
  );

  const bin = join(root, 'bin');
  const stubReasoner = join(root, 'stub-reasoner');
  put(stubReasoner, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${DECIDED}'\n`, true);
  const ambientChecks = Object.keys(AMBIENT)
    .map((name) => `if [ -n "\${${name}-}" ]; then echo "ambient ${name} reached cargo" >&2; exit 3; fi`)
    .join('\n');
  put(
    join(bin, 'rustup'),
    `#!/bin/sh
set -eu
case "$3" in
  rustc) printf '${RUSTC_VERSION}'; exit 0 ;;
  cargo) ;;
  *) echo "unexpected rustup $*" >&2; exit 2 ;;
esac
${ambientChecks}
case "$(pwd)" in */git-archive-?/reasoner) ;; *) echo "cargo ran outside the export: $(pwd)" >&2; exit 4 ;; esac
target=""; previous=""
for argument in "$@"; do if [ "$previous" = "--target" ]; then target="$argument"; fi; previous="$argument"; done
case "$target" in *windows*) name=erden-reasoner.exe ;; *) name=erden-reasoner ;; esac
mkdir -p "$CARGO_TARGET_DIR/$target/release"
cp '${stubReasoner}' "$CARGO_TARGET_DIR/$target/release/$name"
`,
    true,
  );
  put(join(bin, 'xcodebuild'), `#!/bin/sh\nprintf 'Xcode 16.4\\nBuild version 16F6\\n'\n`, true);
  put(
    join(bin, 'xcrun'),
    `#!/bin/sh
case "$*" in
  "--sdk macosx --show-sdk-version") echo 15.5 ;;
  "--sdk macosx --show-sdk-build-version") echo 24F74 ;;
  "ld -v") printf '@(#)PROGRAM:ld PROJECT:ld-1167.5\\nBUILD 01:45:05 Apr 30 2025\\n' >&2 ;;
  *) echo "unexpected xcrun $*" >&2; exit 2 ;;
esac
`,
    true,
  );
  put(join(bin, 'cc'), `#!/bin/sh\nprintf 'Apple clang version 17.0.0 (clang-1700.0.13.5)\\nTarget: arm64-apple-darwin24.5.0\\n'\n`, true);
  const programs = join(root, 'programs');
  const visualStudio = join(root, 'visual-studio');
  put(
    join(programs, 'Microsoft Visual Studio/Installer/vswhere.exe'),
    `#!/bin/sh\nprintf '%s' '${JSON.stringify([{ installationPath: visualStudio, installationVersion: '17.14.36310.24' }])}'\n`,
    true,
  );
  put(join(visualStudio, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), '14.44.35207\r\n');
  const temporary = join(root, 'tmp');
  const cargoHome = join(root, 'cargo-home');
  mkdirSync(temporary);
  mkdirSync(cargoHome);
  return {
    root,
    repository,
    commit,
    out: join(root, 'out'),
    environment: {
      ...withoutGit(process.env),
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CARGO_HOME: cargoHome,
      'ProgramFiles(x86)': programs,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
    },
  };
}

function runAs(box: Sandbox, host: { platform: string; arch: string }, target: string, environment: NodeJS.ProcessEnv = {}) {
  const fake = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(host.platform)} });
Object.defineProperty(process, 'arch', { value: ${JSON.stringify(host.arch)} });`;
  return spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(fake)}`,
      join(box.repository, 'reasoner/qualification/verify-binary-reproducible.mjs'),
      target,
      '--out',
      box.out,
    ],
    { encoding: 'utf8', env: { ...box.environment, ...environment }, timeout: 60_000 },
  );
}

const sandboxes: string[] = [];
function sandbox(): Sandbox {
  const box = makeSandbox();
  sandboxes.push(box.root);
  return box;
}
afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('native builds run end to end', () => {
  test('macOS arm64 builds both exports and records the Xcode linker identity', () => {
    const box = sandbox();
    const child = runAs(box, { platform: 'darwin', arch: 'arm64' }, 'aarch64-apple-darwin', AMBIENT);
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const record = JSON.parse(readFileSync(join(box.out, 'aarch64-apple-darwin.json'), 'utf8'));
    expect(record).toMatchObject({
      qualificationSourceCommit: box.commit,
      host: { platform: 'darwin', arch: 'arm64' },
      target: 'aarch64-apple-darwin',
      linker: {
        xcode: 'Xcode 16.4 (Build version 16F6)',
        sdk: 'macosx 15.5 (24F74)',
        cc: 'Apple clang version 17.0.0 (clang-1700.0.13.5)',
        ld: '@(#)PROGRAM:ld PROJECT:ld-1167.5',
      },
      result: 'byte-identical',
    });
    expect(record.runs[0].sha256).toBe(record.runs[1].sha256);
    expect(existsSync(join(box.out, 'aarch64-apple-darwin/erden-reasoner'))).toBe(true);
  });

  test('Windows x64 builds both exports and records the MSVC linker identity', () => {
    const box = sandbox();
    const child = runAs(box, { platform: 'win32', arch: 'x64' }, 'x86_64-pc-windows-msvc', AMBIENT);
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const record = JSON.parse(readFileSync(join(box.out, 'x86_64-pc-windows-msvc.json'), 'utf8'));
    expect(record).toMatchObject({
      host: { platform: 'win32', arch: 'x64' },
      linker: { visualStudio: '17.14.36310.24', msvcTools: '14.44.35207' },
      result: 'byte-identical',
    });
    expect(existsSync(join(box.out, 'x86_64-pc-windows-msvc/erden-reasoner.exe'))).toBe(true);
  });

  test.each([
    ['an edited file', 'erden-reasoner/src/main.rs', 'fn main() { println!("changed"); }\n'],
    ['an untracked file', 'erden-reasoner/src/extra.rs', '// new\n'],
  ])('refuses to build a commit whose adapter crate differs from the checkout (%s)', (_label, file, content) => {
    const box = sandbox();
    put(join(box.repository, 'reasoner', file), content);
    const child = runAs(box, { platform: 'darwin', arch: 'arm64' }, 'aarch64-apple-darwin');
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(`The working adapter crate differs from ${box.commit}`);
    expect(child.stderr).toContain(`reasoner/${file}`);
    expect(existsSync(box.out)).toBe(false);
  });

  test('exports LF bytes even where the repository converts line endings on checkout', () => {
    // The windows-2025 runner has core.autocrlf=true; its first 0.2.0 build exported a CRLF Cargo.lock.
    const box = sandbox();
    gitIn(box.repository, 'config', 'core.autocrlf', 'true');
    gitIn(box.repository, 'config', 'core.eol', 'crlf');
    const child = runAs(box, { platform: 'win32', arch: 'x64' }, 'x86_64-pc-windows-msvc');
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const record = JSON.parse(readFileSync(join(box.out, 'x86_64-pc-windows-msvc.json'), 'utf8'));
    expect(record.cargoLockDigest).toBe(STUB_LOCK_DIGEST);
  });

  test.each([
    ['an eol attribute', '*.lock text eol=crlf', 'differs: reasoner/Cargo.lock'],
    ['an export-ignore attribute', 'main.rs export-ignore', 'missing: reasoner/erden-reasoner/src/main.rs'],
  ])('refuses an export that is not byte-identical to the commit (%s)', (_label, attribute, problem) => {
    const box = sandbox();
    put(join(box.repository, '.git/info/attributes'), `${attribute}\n`);
    const child = runAs(box, { platform: 'win32', arch: 'x64' }, 'x86_64-pc-windows-msvc');
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(`Exported source git-archive-a is not byte-identical to ${box.commit}`);
    expect(child.stderr).toContain(problem);
    expect(existsSync(join(box.out, 'x86_64-pc-windows-msvc.json'))).toBe(false);
  });

  test('refuses an exported Cargo.lock that the accepted record does not describe', () => {
    const box = sandbox();
    const wrong = `sha256:${'0'.repeat(64)}`;
    put(
      join(box.repository, 'reasoner/qualification/binary-reproducibility.json'),
      JSON.stringify({ qualificationSourceCommit: box.commit, cargoLockDigest: wrong }),
    );
    const child = runAs(box, { platform: 'darwin', arch: 'arm64' }, 'aarch64-apple-darwin');
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(`The exported Cargo.lock is ${STUB_LOCK_DIGEST}`);
    expect(child.stderr).toContain(`records as ${wrong}`);
  });

  test.each([
    ['the Cargo home', (box: Sandbox) => join(String(box.environment.CARGO_HOME), 'config.toml')],
    ['an ancestor of the export', (box: Sandbox) => join(box.root, '.cargo/config.toml')],
  ])('refuses ambient Cargo configuration in %s', (_label, locate) => {
    const box = sandbox();
    const config = locate(box);
    put(config, '[profile.release]\nlto = "fat"\n');
    const child = runAs(box, { platform: 'darwin', arch: 'arm64' }, 'aarch64-apple-darwin');
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(`Cargo configuration would reach the build: ${config}`);
  });
});

describe('reasoner-build workflow', () => {
  const workflow = readFileSync(join(qualification, '../../.github/workflows/reasoner-build.yml'), 'utf8');

  test('the PowerShell mint exports with line-ending conversion off and checks the export like the Unix script', () => {
    expect(ps1).toContain('git -c core.autocrlf=false -c core.eol=lf -C $repository archive');
    expect(ps1).toContain('Assert-ExportMatchesCommit $exportRoot $Label');
    expect(ps1).toContain('hash-object --no-filters --stdin-paths');
    expect(ps1).toContain('$lockDigest -ne $accepted.cargoLockDigest');
  });

  test('builds the checked-out commit, or one chosen at dispatch, never the fixed qualification commit', () => {
    expect(workflow).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+commit:/u);
    expect(workflow).toContain('COMMIT: ${{ inputs.commit || github.sha }}');
    expect(workflow).toMatch(/verify-binary-reproducible\.mjs \$\{\{ matrix\.target \}\} --commit "\$COMMIT" --out reasoner-build/u);
  });
});
// #endregion
