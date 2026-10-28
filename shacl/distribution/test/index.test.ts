import { createHash } from 'node:crypto';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    BundledShaclEngineError,
    ERROR_CODES,
    inspectBundledShaclEngine,
    PACKAGE_VERSION,
    QUALIFIED_SHACL_ARTIFACTS,
    resolveBundledShaclEngine,
    runBundledShaclEngineKnownAnswer,
    SHACL_ENGINE_DIGEST,
    SUPPORTED_PLATFORMS,
} from '../src/index.js';

const root = resolve(import.meta.dirname, '..', '..', '..');
const runtimes = {
    linux: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    linuxArm64: { platform: 'linux', arch: 'arm64', libc: 'glibc' },
    darwinArm64: { platform: 'darwin', arch: 'arm64' },
    windows: { platform: 'win32', arch: 'x64' },
} as const;
type PlatformName = keyof typeof runtimes;
const platformNames = Object.keys(runtimes) as ReadonlyArray<PlatformName>;
const directories: Readonly<Record<PlatformName | 'distribution', string>> = {
    distribution: resolve(root, 'shacl/distribution'),
    linux: resolve(root, 'shacl/linux-x64-gnu'),
    linuxArm64: resolve(root, 'shacl/linux-arm64-gnu'),
    darwinArm64: resolve(root, 'shacl/darwin-arm64'),
    windows: resolve(root, 'shacl/win32-x64-msvc'),
};
const binaries: Readonly<Record<PlatformName, string>> = {
    linux: 'bin/erden-shacl',
    linuxArm64: 'bin/erden-shacl',
    darwinArm64: 'bin/erden-shacl',
    windows: 'bin/erden-shacl.exe',
};
const current = platformNames.find(
    (name) => runtimes[name].platform === process.platform && runtimes[name].arch === process.arch,
);

let temporaryRoot = '';

function keyOf(name: PlatformName): string {
    const runtime = runtimes[name];
    return 'libc' in runtime
        ? `${runtime.platform}:${runtime.arch}:${runtime.libc}`
        : `${runtime.platform}:${runtime.arch}`;
}
function anchorOf(name: PlatformName) {
    const anchor = QUALIFIED_SHACL_ARTIFACTS[keyOf(name)];
    if (anchor === undefined) {
        throw new Error(`No anchor for ${keyOf(name)}`);
    }
    return anchor;
}
// The binaries are never committed. A platform's real binary is present only once
// shacl/qualification/build-from-source.mjs has installed it (this host's platform) or the tools release ships it
// (release.yml); tests that need it are skipped without it.
function present(name: PlatformName): boolean {
    return existsSync(resolve(directories[name], binaries[name]));
}
const PRESENCE_NOTE = 'skipped without the binary: build-from-source.mjs, or the TS-6 release';

/**
 * Copies a platform package. Without its real binary, the copy gets a placeholder of the pinned size: every refusal
 * before the digest check reaches it, and the digest check refuses it.
 */
function copyPackage(name: PlatformName, mutation: (directory: string) => void = () => undefined): string {
    const destination = resolve(temporaryRoot, `${name}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(destination);
    for (const file of ['package.json', 'metadata.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
        cpSync(resolve(directories[name], file), resolve(destination, file));
    }
    if (present(name)) {
        cpSync(resolve(directories[name], 'bin'), resolve(destination, 'bin'), { recursive: true });
    } else {
        mkdirSync(resolve(destination, 'bin'));
        writeFileSync(resolve(destination, binaries[name]), Buffer.alloc(anchorOf(name).bytes ?? 0), { mode: 0o755 });
    }
    mutation(destination);
    return destination;
}
function editJson(path: string, edit: (value: Record<string, unknown>) => void) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    edit(value);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function expectRefusal(operation: () => unknown, code: string) {
    let caught: unknown;
    try {
        operation();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(BundledShaclEngineError);
    expect((caught as BundledShaclEngineError).code).toBe(code);
}
function unreachable(): never {
    throw new Error('the locator must not run');
}

beforeAll(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'erden-shacl-distribution-'));
});
afterAll(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('the minted anchors', () => {
    it('pin all four platforms to the committed packages and metadata', () => {
        expect(Object.keys(QUALIFIED_SHACL_ARTIFACTS).sort()).toEqual(platformNames.map(keyOf).sort());
        expect([...SUPPORTED_PLATFORMS].sort()).toEqual([
            'darwin arm64',
            'linux arm64 (glibc)',
            'linux x64 (glibc)',
            'win32 x64',
        ]);
        for (const name of platformNames) {
            const anchor = anchorOf(name);
            const metadata = JSON.parse(readFileSync(resolve(directories[name], 'metadata.json'), 'utf8')) as {
                binary: unknown;
                tool: unknown;
            };
            expect(metadata.binary).toEqual({ path: binaries[name], bytes: anchor.bytes, sha256: anchor.sha256 });
            expect(metadata.tool).toEqual({
                name: 'erden-shacl',
                version: PACKAGE_VERSION,
                engineDigest: SHACL_ENGINE_DIGEST,
            });
        }
    });

    for (const name of platformNames) {
        it.skipIf(!present(name))(`match the ${name} package's binary byte for byte (${PRESENCE_NOTE})`, () => {
            const anchor = anchorOf(name);
            const binary = readFileSync(resolve(directories[name], binaries[name]));
            expect(binary.byteLength).toBe(anchor.bytes);
            expect(`sha256:${createHash('sha256').update(binary).digest('hex')}`).toBe(anchor.sha256);
        });
    }

    it('agree with the reproducibility record and the engine identity the binary was built with', () => {
        const record = JSON.parse(
            readFileSync(resolve(root, 'shacl/qualification/binary-reproducibility.json'), 'utf8'),
        ) as { targets: Record<string, { runs: Array<{ sha256: string; bytes: number }> }>; tool: unknown };
        expect(record.tool).toEqual({
            name: 'erden-shacl',
            version: PACKAGE_VERSION,
            engineDigest: SHACL_ENGINE_DIGEST,
        });
        for (const name of platformNames) {
            const anchor = anchorOf(name);
            const runs = record.targets[anchor.target]?.runs ?? [];
            expect(runs.length, name).toBe(2);
            for (const run of runs) {
                expect({ sha256: run.sha256, bytes: run.bytes }, name).toEqual({
                    sha256: anchor.sha256,
                    bytes: anchor.bytes,
                });
            }
        }
    });

    it('contain no lifecycle, download, network or native-addon mechanism', () => {
        for (const directory of Object.values(directories)) {
            const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as {
                scripts?: unknown;
            };
            expect(manifest.scripts).toBeUndefined();
        }
        const source = readFileSync(resolve(directories.distribution, 'src/index.js'), 'utf8');
        expect(source).not.toMatch(/node:https|node:http|\bfetch\s*\(|\bdownload\b/iu);
    });
});

describe('fail-closed resolution', () => {
    it('refuses unsupported platforms and C libraries without consulting packages', () => {
        expectRefusal(
            () =>
                resolveBundledShaclEngine({ runtime: { platform: 'darwin', arch: 'x64' }, locatePackage: unreachable }),
            ERROR_CODES.unsupportedPlatform,
        );
        expectRefusal(
            () =>
                resolveBundledShaclEngine({
                    runtime: { platform: 'linux', arch: 'x64', libc: 'unknown' },
                    locatePackage: unreachable,
                }),
            ERROR_CODES.unsupportedLibc,
        );
        const refused = inspectBundledShaclEngine({ runtime: { platform: 'freebsd', arch: 'x64' } });
        expect(refused).toMatchObject({ availability: 'unavailable', failureCode: ERROR_CODES.unsupportedPlatform });
        expect(refused.supportedPlatforms).toEqual(SUPPORTED_PLATFORMS);
    });

    // A Windows host keeps no executable bits, so it resolves only the Windows package from a copy.
    for (const name of platformNames.filter((item) => process.platform !== 'win32' || item === 'windows')) {
        it.skipIf(!present(name))(`resolves ${name} from a copy of its package (${PRESENCE_NOTE})`, () => {
            const directory = copyPackage(name);
            const resolved = resolveBundledShaclEngine({ runtime: runtimes[name], locatePackage: () => directory });
            expect(basename(resolved.path)).toBe(basename(binaries[name]));
            expect(resolved.tool).toEqual({
                name: 'erden-shacl',
                version: PACKAGE_VERSION,
                engineDigest: SHACL_ENGINE_DIGEST,
                executableDigest: anchorOf(name).sha256,
            });
        });
    }

    it('refuses a placeholder of the pinned size by its digest', () => {
        const placeholder = copyPackage('windows', (directory) => {
            writeFileSync(resolve(directory, binaries.windows), Buffer.alloc(anchorOf('windows').bytes ?? 0));
        });
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => placeholder }),
            ERROR_CODES.binaryDigestMismatch,
        );
    });

    it('refuses missing, ambiguous and wrong-platform packages', () => {
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => undefined }),
            ERROR_CODES.packageMissing,
        );
        const windows = copyPackage('windows');
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => [windows, windows] }),
            ERROR_CODES.ambiguousPackage,
        );
        const darwin = copyPackage('darwinArm64');
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => darwin }),
            ERROR_CODES.wrongTarget,
        );
    });

    it('refuses damaged, shortened, missing, non-regular and non-executable binaries', () => {
        // The Windows package, whose runtime has no executable bit to check, so these run on every host.
        const damaged = copyPackage('windows', (directory) => {
            const path = resolve(directory, 'bin/erden-shacl.exe');
            const bytes = readFileSync(path);
            bytes[100] = (bytes[100] ?? 0) ^ 0xff;
            writeFileSync(path, bytes);
        });
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => damaged }),
            ERROR_CODES.binaryDigestMismatch,
        );
        const doctor = inspectBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => damaged });
        expect(doctor).toMatchObject({ availability: 'unavailable', failureCode: 'BINARY_DIGEST_MISMATCH' });
        expect(doctor.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        const shortened = copyPackage('windows', (directory) => {
            writeFileSync(resolve(directory, 'bin/erden-shacl.exe'), Buffer.alloc(10));
        });
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => shortened }),
            ERROR_CODES.binarySizeMismatch,
        );
        const missing = copyPackage('windows', (directory) => {
            rmSync(resolve(directory, 'bin/erden-shacl.exe'));
        });
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => missing }),
            ERROR_CODES.binaryMissing,
        );
        const directoryBinary = copyPackage('windows', (directory) => {
            rmSync(resolve(directory, 'bin/erden-shacl.exe'));
            mkdirSync(resolve(directory, 'bin/erden-shacl.exe'));
        });
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => directoryBinary }),
            ERROR_CODES.binaryNotRegular,
        );
        if (process.platform !== 'win32') {
            const plain = copyPackage('linux', (directory) => {
                const path = resolve(directory, 'bin/erden-shacl');
                chmodSync(path, 0o644);
            });
            expectRefusal(
                () => resolveBundledShaclEngine({ runtime: runtimes.linux, locatePackage: () => plain }),
                ERROR_CODES.binaryNotExecutable,
            );
            const linked = copyPackage('linux', (directory) => {
                const path = resolve(directory, 'bin/erden-shacl');
                const target = resolve(directory, 'bin/target');
                writeFileSync(target, readFileSync(path), { mode: 0o755 });
                rmSync(path);
                symlinkSync(target, path);
            });
            expectRefusal(
                () => resolveBundledShaclEngine({ runtime: runtimes.linux, locatePackage: () => linked }),
                ERROR_CODES.symlinkDisallowed,
            );
        }
    });

    it('refuses tampered metadata: version, target, engine digest, path escape and extra keys', () => {
        const cases: ReadonlyArray<readonly [string, (value: Record<string, unknown>) => void, string]> = [
            ['version', (value) => void (value.packageVersion = '0.1.1'), ERROR_CODES.versionMismatch],
            ['target', (value) => void (value.target = 'x86_64-unknown-linux-gnu'), ERROR_CODES.wrongTarget],
            [
                'engine digest',
                (value) =>
                    void (value.tool = {
                        name: 'erden-shacl',
                        version: PACKAGE_VERSION,
                        engineDigest: `sha256:${'1'.repeat(64)}`,
                    }),
                ERROR_CODES.metadataInvalid,
            ],
            [
                'path escape',
                (value) =>
                    void (value.binary = {
                        ...(value.binary as Record<string, unknown>),
                        path: '../outside/erden-shacl.exe',
                    }),
                ERROR_CODES.pathEscape,
            ],
            ['extra key', (value) => void (value.extra = true), ERROR_CODES.metadataInvalid],
        ];
        for (const [label, edit, code] of cases) {
            const directory = copyPackage('windows', (packageRoot) => {
                editJson(resolve(packageRoot, 'metadata.json'), edit);
            });
            const doctor = inspectBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => directory });
            expect(doctor.failureCode, label).toBe(code);
        }
        const manifest = copyPackage('windows', (packageRoot) => {
            editJson(resolve(packageRoot, 'package.json'), (value) => void (value.scripts = { install: 'x' }));
        });
        expectRefusal(
            () => resolveBundledShaclEngine({ runtime: runtimes.windows, locatePackage: () => manifest }),
            ERROR_CODES.metadataInvalid,
        );
    });
});

describe.runIf(current !== undefined)('the bundled engine on this platform', () => {
    it.skipIf(current === undefined || !present(current))(
        `resolves through the installed workspace package and passes the pinned known answer (${PRESENCE_NOTE})`,
        () => {
            const doctor = inspectBundledShaclEngine({ runSelfTest: true });
            expect(doctor).toMatchObject({
                availability: 'available',
                actualPlatformPackage: anchorOf(current ?? 'linux').packageName,
                selfTest: { status: 'passed' },
            });
            const answer = runBundledShaclEngineKnownAnswer();
            expect(answer.responseBytes).toBe(anchorOf(current ?? 'linux').responseBytes);
            expect(answer.responseDigest).toBe(anchorOf(current ?? 'linux').responseSha256);
        },
    );
});
