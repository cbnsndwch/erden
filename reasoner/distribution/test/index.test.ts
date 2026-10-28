import { spawnSync } from 'node:child_process';
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
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    BundledReasonerError,
    ERROR_CODES,
    inspectBundledReasoner,
    PACKAGE_VERSION,
    QUALIFIED_REASONER_ARTIFACTS,
    REASONER_RELEASED,
    REASONER_TOOL,
    resolveBundledReasoner,
    resolveBundledReasonerArtifact,
    runBundledReasonerKnownAnswer,
    SOURCE_BUILD,
    SUPPORTED_PLATFORMS,
    TOOL_VERSION,
} from '../src/index.js';

/**
 * Tests of released pins skip until the first mint. Source checkouts carry pins and support files for every
 * platform, but only their native executable is installed by build-from-source.mjs. Negative tests may use a
 * same-size placeholder for an absent foreign binary; native known-answer tests always use the real executable.
 */
const UNRELEASED = !REASONER_RELEASED;

const root = resolve(import.meta.dirname, '..', '..', '..');
const packageDirectories = {
    distribution: resolve(root, 'reasoner/distribution'),
    linux: resolve(root, 'reasoner/linux-x64-gnu'),
    windows: resolve(root, 'reasoner/win32-x64-msvc'),
    linuxArm64: resolve(root, 'reasoner/linux-arm64-gnu'),
    darwinArm64: resolve(root, 'reasoner/darwin-arm64'),
} as const;
const runtimes = {
    linux: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    windows: { platform: 'win32', arch: 'x64' },
    linuxArm64: { platform: 'linux', arch: 'arm64', libc: 'glibc' },
    darwinArm64: { platform: 'darwin', arch: 'arm64' },
} as const;
type PlatformName = keyof typeof runtimes;
const platformNames = Object.keys(runtimes) as ReadonlyArray<PlatformName>;
/**
 * The committed 0.2.0 platform packages are not part of every checkout; their packing tests run where they are
 * present.
 */
const PLATFORM_PACKAGES_PRESENT = platformNames.every((name) => existsSync(packageDirectories[name]));
const platformPackages: Readonly<Record<PlatformName, string>> = {
    linux: '@erden/reasoner-linux-x64-gnu',
    windows: '@erden/reasoner-win32-x64-msvc',
    linuxArm64: '@erden/reasoner-linux-arm64-gnu',
    darwinArm64: '@erden/reasoner-darwin-arm64',
};
/** The platform this test runs on; every supported runtime has its own package. */
const current: PlatformName = (() => {
    const found = platformNames.find(
        (name) => runtimes[name].platform === process.platform && runtimes[name].arch === process.arch,
    );
    if (found === undefined) {
        throw new Error(`No bundled reasoner for ${process.platform} ${process.arch}`);
    }
    return found;
})();
function artifactOf(name: PlatformName) {
    const runtime = runtimes[name];
    const key =
        'libc' in runtime
            ? `${runtime.platform}:${runtime.arch}:${runtime.libc}`
            : `${runtime.platform}:${runtime.arch}`;
    const artifact = QUALIFIED_REASONER_ARTIFACTS[key];
    if (artifact === undefined) {
        throw new Error(`No anchor for ${key}`);
    }
    return artifact;
}

interface PackedPackage {
    readonly directory: string;
    readonly filename: string;
    readonly tarball: string;
    readonly version: string;
}

let temporaryRoot = '';
let packed: Record<keyof typeof packageDirectories, PackedPackage>;

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function run(command: string, args: ReadonlyArray<string>, cwd?: string) {
    const child = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (child.status !== 0) {
        throw new Error(`${command} failed: ${child.stderr || child.stdout}`);
    }
    return child.stdout;
}
function isPackRecord(value: unknown): value is {
    filename: string;
    version: string;
} {
    return (
        typeof value === 'object' &&
        value !== null &&
        'filename' in value &&
        typeof value.filename === 'string' &&
        'version' in value &&
        typeof value.version === 'string'
    );
}

function packPackage(name: keyof typeof packageDirectories, destination: string): PackedPackage {
    mkdirSync(destination, { recursive: true });
    const packageManager = 'pnpm';
    const args = ['pack', '--json', '--pack-destination', destination];
    const child =
        process.platform === 'win32'
            ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${packageManager} ${args.join(' ')}`], {
                  cwd: packageDirectories[name],
                  encoding: 'utf8',
              })
            : spawnSync(packageManager, args, { cwd: packageDirectories[name], encoding: 'utf8' });
    if (child.status !== 0) {
        throw new Error(`npm pack failed: ${child.stderr || child.stdout}`);
    }
    const result: unknown = JSON.parse(child.stdout);
    const record = Array.isArray(result) ? (result as ReadonlyArray<unknown>)[0] : result;
    if (!isPackRecord(record)) {
        throw new Error('npm pack returned no artifact');
    }
    const tarball = resolve(destination, record.filename);
    const extraction = resolve(destination, 'extracted');
    mkdirSync(extraction);
    run('tar', ['-xf', tarball, '-C', extraction]);
    return { directory: resolve(extraction, 'package'), filename: record.filename, tarball, version: record.version };
}

function entries(tarball: string): ReadonlyArray<string> {
    return run('tar', ['-tf', tarball]).trim().split(/\r?\n/u).sort();
}
function writeJson(path: string, value: unknown) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function mutatePackage(name: PlatformName, mutation: (directory: string) => void): string {
    const destination = resolve(temporaryRoot, `mutation-${name}-${Math.random().toString(16).slice(2)}`);
    cpSync(packed[name].directory, destination, { recursive: true });
    const binary = resolve(destination, artifactOf(name).binaryPath);
    if (!existsSync(binary)) {
        mkdirSync(resolve(destination, 'bin'), { recursive: true });
        writeFileSync(binary, Buffer.alloc(artifactOf(name).bytes ?? 0), { mode: 0o755 });
    }
    mutation(destination);
    return destination;
}
function mutateDistribution(mutation: (directory: string) => void): string {
    const destination = resolve(temporaryRoot, `mutation-distribution-${Math.random().toString(16).slice(2)}`);
    cpSync(packed.distribution.directory, destination, { recursive: true });
    mutation(destination);
    return destination;
}
async function importDistribution(directory: string): Promise<typeof import('../src/index.js')> {
    const loaded: unknown = await import(
        `${pathToFileURL(resolve(directory, 'src/index.js')).href}?test=${Math.random().toString(16).slice(2)}`
    );
    return loaded as typeof import('../src/index.js');
}
function locate(directory: string) {
    return () => directory;
}
function expectedError(operation: () => unknown, code: string) {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(BundledReasonerError);
        expect((error as BundledReasonerError).code).toBe(code);
        return;
    }
    throw new Error(`Expected ${code}`);
}

beforeAll(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'erden-reasoner-distribution-'));
    const names = ['distribution', ...(PLATFORM_PACKAGES_PRESENT ? platformNames : [])] as const;
    packed = Object.fromEntries(
        names.map((name) => [name, packPackage(name, resolve(temporaryRoot, `pack-${name}`))]),
    ) as typeof packed;
}, 60_000);

afterAll(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('real npm package artifacts', () => {
    it.skipIf(UNRELEASED)('preserves the exact build-metadata version in every packed manifest', () => {
        for (const artifact of Object.values(packed)) {
            expect(artifact.version).toBe(PACKAGE_VERSION);
            const manifest = JSON.parse(readFileSync(resolve(artifact.directory, 'package.json'), 'utf8')) as {
                version: string;
            };
            expect(manifest.version).toBe(PACKAGE_VERSION);
        }
        const resolver = JSON.parse(readFileSync(resolve(packed.distribution.directory, 'package.json'), 'utf8')) as {
            optionalDependencies: Record<string, string>;
        };
        expect(resolver.optionalDependencies).toEqual(
            Object.fromEntries(Object.values(platformPackages).map((name) => [name, PACKAGE_VERSION])),
        );
    });

    it('packs exactly the audited resolver allowlist', () => {
        expect(entries(packed.distribution.tarball)).toEqual([
            'package/LICENSE',
            'package/NOTICE',
            'package/README.md',
            'package/fixtures/known-answer.request.json',
            'package/package.json',
            'package/src/artifacts.js',
            'package/src/index.d.ts',
            'package/src/index.js',
        ]);
    });

    it.skipIf(!PLATFORM_PACKAGES_PRESENT)('packs source pins and only executables that are installed', () => {
        for (const name of platformNames) {
            const binaryPath = name === 'windows' ? 'bin/erden-reasoner.exe' : 'bin/erden-reasoner';
            const installed = existsSync(resolve(packageDirectories[name], binaryPath));
            expect(entries(packed[name].tarball)).toEqual([
                'package/LICENSE',
                'package/NOTICE',
                'package/README.md',
                'package/THIRD-PARTY-NOTICES.md',
                ...(installed ? [`package/${binaryPath}`] : []),
                'package/metadata.json',
                'package/package.json',
            ]);
            if (installed && name !== 'windows') {
                const mode = run('tar', ['-tvf', packed[name].tarball])
                    .split(/\r?\n/u)
                    .find((line) => line.endsWith(`package/${binaryPath}`));
                expect(mode, name).toMatch(/^-rwxr-xr-x\s/u);
            }
        }
    });

    it('produces deterministic tarballs and deterministic qualification metadata', () => {
        for (const name of Object.keys(packed) as ReadonlyArray<keyof typeof packed>) {
            const second = packPackage(name, resolve(temporaryRoot, `second-${name}`));
            expect(sha256(second.tarball)).toBe(sha256(packed[name].tarball));
        }
    }, 60_000);

    it('contains no lifecycle, download, network, or native-addon mechanism', () => {
        for (const artifact of Object.values(packed)) {
            const manifest = JSON.parse(readFileSync(resolve(artifact.directory, 'package.json'), 'utf8')) as {
                scripts?: unknown;
            };
            expect(manifest.scripts).toBeUndefined();
            expect(entries(artifact.tarball).some((entry) => entry.endsWith('.node'))).toBe(false);
        }
        const source = readFileSync(resolve(packed.distribution.directory, 'src/index.js'), 'utf8');
        expect(source).not.toMatch(/node:https|node:http|\bfetch\s*\(|\bdownload\b/iu);
    });
});

describe('fail-closed resolution from real extracted tarballs', () => {
    it.skipIf(UNRELEASED)(
        'does not select an incompatible platform package even when pnpm linked every workspace member',
        () => {
            for (const name of platformNames.filter((item) => item !== current)) {
                expect(
                    existsSync(resolve(packageDirectories.distribution, 'node_modules', platformPackages[name])),
                ).toBe(true);
            }
            const doctor = inspectBundledReasoner();
            expect(doctor.availability).toBe('available');
            expect(doctor.actualPlatformPackage).toBe(platformPackages[current]);
        },
    );

    it.skipIf(UNRELEASED)(
        'selects exactly the compatible current platform and ignores an incompatible workspace member',
        () => {
            const runtime = runtimes[current];
            const expectedName = platformPackages[current];
            const path = resolveBundledReasoner({
                runtime,
                locatePackage: (name) => {
                    expect(name).toBe(expectedName);
                    return packed[current].directory;
                },
            });
            expect(basename(path)).toBe(current === 'windows' ? 'erden-reasoner.exe' : 'erden-reasoner');
        },
    );

    it('reports unsupported platform and libc without consulting installed packages', () => {
        function unreachable(): never {
            throw new Error('locator must not run');
        }
        expectedError(
            () => resolveBundledReasoner({ runtime: { platform: 'darwin', arch: 'x64' }, locatePackage: unreachable }),
            ERROR_CODES.unsupportedPlatform,
        );
        expectedError(
            () =>
                resolveBundledReasoner({
                    runtime: { platform: 'linux', arch: 'x64', libc: 'musl' },
                    locatePackage: unreachable,
                }),
            ERROR_CODES.unsupportedLibc,
        );
        expect(
            inspectBundledReasoner({
                runtime: { platform: 'linux', arch: 'ppc64', libc: 'glibc' },
                locatePackage: unreachable,
            }).failureCode,
        ).toBe(ERROR_CODES.unsupportedPlatform);
    });

    it('names the refused runtime and every supported platform when refusing', () => {
        function unreachable(): never {
            throw new Error('locator must not run');
        }
        const supported = Object.values(QUALIFIED_REASONER_ARTIFACTS).map(({ runtime }) =>
            runtime.libc === undefined
                ? `${runtime.os} ${runtime.cpu}`
                : `${runtime.os} ${runtime.cpu} (${runtime.libc})`,
        );
        expect([...supported].sort()).toEqual([
            'darwin arm64',
            'linux arm64 (glibc)',
            'linux x64 (glibc)',
            'win32 x64',
        ]);
        const refused = [
            { platform: 'darwin', arch: 'x64' },
            { platform: 'win32', arch: 'arm64' },
            { platform: 'freebsd', arch: 'x64' },
        ];
        for (const runtime of refused) {
            let error: unknown;
            try {
                resolveBundledReasoner({ runtime, locatePackage: unreachable });
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(BundledReasonerError);
            const refusal = error as BundledReasonerError;
            expect(refusal.code).toBe(ERROR_CODES.unsupportedPlatform);
            expect(refusal.message).toContain(`${runtime.platform} ${runtime.arch}`);
            for (const platform of supported) {
                expect(refusal.message).toContain(platform);
            }
            expect(refusal.details.supported).toEqual(supported);
        }
        expect(SUPPORTED_PLATFORMS).toEqual(supported);
    });

    it.each(['x64', 'arm64'])('names the refused Linux %s runtime when its C library is not glibc', (arch) => {
        // detectRuntime reports every non-glibc Linux (musl included) as libc 'unknown'.
        let error: unknown;
        try {
            resolveBundledReasoner({
                runtime: { platform: 'linux', arch, libc: 'unknown' },
                locatePackage: () => {
                    throw new Error('locator must not run');
                },
            });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(BundledReasonerError);
        const refusal = error as BundledReasonerError;
        expect(refusal.code).toBe(ERROR_CODES.unsupportedLibc);
        expect(refusal.message).toBe(
            `No qualified bundled reasoner exists for linux ${arch} without glibc; supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
        );
        expect(refusal.details.supported).toEqual(SUPPORTED_PLATFORMS);
    });

    it.skipIf(UNRELEASED)(
        'carries the supported platforms into an unavailable inspection only for a refused runtime',
        () => {
            const refused = inspectBundledReasoner({ runtime: { platform: 'darwin', arch: 'x64' } });
            expect(refused).toMatchObject({
                availability: 'unavailable',
                failureCode: ERROR_CODES.unsupportedPlatform,
            });
            expect(refused.supportedPlatforms).toEqual(SUPPORTED_PLATFORMS);
            const missing = inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: () => undefined });
            expect(missing).toMatchObject({ availability: 'unavailable', failureCode: ERROR_CODES.packageMissing });
            expect(missing.supportedPlatforms).toBeUndefined();
        },
    );

    it.skipIf(UNRELEASED)('rejects missing and ambiguous compatible packages', () => {
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: () => undefined }),
            ERROR_CODES.packageMissing,
        );
        expectedError(
            () =>
                resolveBundledReasoner({
                    runtime: runtimes.windows,
                    locatePackage: () => [packed.windows.directory, packed.windows.directory],
                }),
            ERROR_CODES.ambiguousPackage,
        );
    });

    it.skipIf(UNRELEASED)('rejects missing, non-regular, shortened, and same-size damaged binaries', () => {
        const missing = mutatePackage('windows', (directory) => {
            rmSync(resolve(directory, 'bin/erden-reasoner.exe'));
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(missing) }),
            ERROR_CODES.binaryMissing,
        );
        const directory = mutatePackage('windows', (packageRoot) => {
            rmSync(resolve(packageRoot, 'bin/erden-reasoner.exe'));
            mkdirSync(resolve(packageRoot, 'bin/erden-reasoner.exe'));
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(directory) }),
            ERROR_CODES.binaryNotRegular,
        );
        const shortened = mutatePackage('windows', (packageRoot) => {
            writeFileSync(resolve(packageRoot, 'bin/erden-reasoner.exe'), Buffer.alloc(10));
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(shortened) }),
            ERROR_CODES.binarySizeMismatch,
        );
        const damaged = mutatePackage('windows', (packageRoot) => {
            const path = resolve(packageRoot, 'bin/erden-reasoner.exe');
            const bytes = readFileSync(path);
            bytes[0] = (bytes[0] ?? 0) ^ 0xff;
            writeFileSync(path, bytes);
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(damaged) }),
            ERROR_CODES.binaryDigestMismatch,
        );
        const damagedDoctor = inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(damaged) });
        expect(damagedDoctor).toMatchObject({
            availability: 'unavailable',
            failureCode: 'BINARY_DIGEST_MISMATCH',
            actualPlatformPackage: '@erden/reasoner-win32-x64-msvc',
            packageVersion: PACKAGE_VERSION,
            toolVersion: PACKAGE_VERSION,
            target: 'x86_64-pc-windows-msvc',
            size: artifactOf('windows').bytes,
        });
        expect(damagedDoctor.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    });

    it.skipIf(UNRELEASED)('rejects wrong target, wrong package/tool version, and path escape metadata', () => {
        const wrongTarget = mutatePackage('windows', (directory) => {
            const path = resolve(directory, 'metadata.json');
            const metadata = JSON.parse(readFileSync(path, 'utf8')) as { target: string };
            metadata.target = 'x86_64-unknown-linux-gnu';
            writeJson(path, metadata);
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(wrongTarget) }),
            ERROR_CODES.wrongTarget,
        );
        expect(inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(wrongTarget) })).toMatchObject(
            {
                availability: 'unavailable',
                failureCode: 'WRONG_TARGET',
                actualPlatformPackage: '@erden/reasoner-win32-x64-msvc',
                packageVersion: PACKAGE_VERSION,
                toolVersion: PACKAGE_VERSION,
                target: 'x86_64-unknown-linux-gnu',
            },
        );
        const wrongManifestRuntime = mutatePackage('windows', (directory) => {
            const path = resolve(directory, 'package.json');
            const manifest = JSON.parse(readFileSync(path, 'utf8')) as { os: Array<string> };
            manifest.os = ['linux'];
            writeJson(path, manifest);
        });
        expect(
            inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(wrongManifestRuntime) }),
        ).toMatchObject({
            availability: 'unavailable',
            failureCode: 'WRONG_TARGET',
            actualPlatformPackage: '@erden/reasoner-win32-x64-msvc',
            packageVersion: PACKAGE_VERSION,
            toolVersion: PACKAGE_VERSION,
            target: 'x86_64-pc-windows-msvc',
        });
        const wrongVersion = mutatePackage('windows', (directory) => {
            const path = resolve(directory, 'package.json');
            const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string };
            manifest.version = '0.1.1';
            writeJson(path, manifest);
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(wrongVersion) }),
            ERROR_CODES.versionMismatch,
        );
        const wrongToolVersion = mutatePackage('windows', (directory) => {
            const path = resolve(directory, 'metadata.json');
            const metadata = JSON.parse(readFileSync(path, 'utf8')) as { tool: { version: string } };
            metadata.tool.version = '0.1.1';
            writeJson(path, metadata);
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(wrongToolVersion) }),
            ERROR_CODES.versionMismatch,
        );
        const escaped = mutatePackage('windows', (directory) => {
            const path = resolve(directory, 'metadata.json');
            const metadata = JSON.parse(readFileSync(path, 'utf8')) as { binary: { path: string } };
            metadata.binary.path = '../../outside.exe';
            writeJson(path, metadata);
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(escaped) }),
            ERROR_CODES.pathEscape,
        );
    });

    it.skipIf(UNRELEASED)('rejects missing and malformed qualification metadata', () => {
        const missing = mutatePackage('windows', (directory) => {
            rmSync(resolve(directory, 'metadata.json'));
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(missing) }),
            ERROR_CODES.metadataInvalid,
        );
        const malformed = mutatePackage('windows', (directory) => {
            writeFileSync(resolve(directory, 'metadata.json'), '{');
        });
        expectedError(
            () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(malformed) }),
            ERROR_CODES.metadataInvalid,
        );
    });

    it.skipIf(UNRELEASED)(
        'turns every non-string binary path shape into typed resolver and doctor failures before path operations',
        () => {
            for (const invalidPath of [{}, 7]) {
                const malformed = mutatePackage('windows', (directory) => {
                    const path = resolve(directory, 'metadata.json');
                    const metadata = JSON.parse(readFileSync(path, 'utf8')) as { binary: { path: unknown } };
                    metadata.binary.path = invalidPath;
                    writeJson(path, metadata);
                });
                expectedError(
                    () => resolveBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(malformed) }),
                    ERROR_CODES.metadataInvalid,
                );
                expect(
                    inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(malformed) }),
                ).toMatchObject({
                    availability: 'unavailable',
                    failureCode: 'PACKAGE_METADATA_INVALID',
                    actualPlatformPackage: '@erden/reasoner-win32-x64-msvc',
                    packageVersion: PACKAGE_VERSION,
                    toolVersion: PACKAGE_VERSION,
                    target: 'x86_64-pc-windows-msvc',
                });
            }
        },
    );

    it.skipIf(UNRELEASED)('keeps doctor total for malformed top-level and nested installed JSON shapes', () => {
        const metadataMutations: ReadonlyArray<(metadata: Record<string, unknown>) => unknown> = [
            () => null,
            () => 7,
            () => ({}),
            (metadata) => ({ ...metadata, tool: null }),
            (metadata) => ({ ...metadata, runtime: null }),
            (metadata) => ({ ...metadata, binary: null }),
            (metadata) => ({ ...metadata, knownAnswer: null }),
        ];
        for (const mutate of metadataMutations) {
            const malformed = mutatePackage('windows', (directory) => {
                const path = resolve(directory, 'metadata.json');
                const metadata = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
                writeJson(path, mutate(metadata));
            });
            expect(() =>
                inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(malformed) }),
            ).not.toThrow();
            expect(
                inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(malformed) }).failureCode,
            ).toBe(ERROR_CODES.metadataInvalid);
        }
        for (const malformedManifest of [null, 7, {}]) {
            const malformed = mutatePackage('windows', (directory) => {
                writeJson(resolve(directory, 'package.json'), malformedManifest);
            });
            expect(() =>
                inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(malformed) }),
            ).not.toThrow();
            expect(
                inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: locate(malformed) }).failureCode,
            ).toBe(ERROR_CODES.metadataInvalid);
        }
    });

    it.skipIf(UNRELEASED || process.platform === 'win32')(
        'lstat-rejects a declared binary symlink before following it',
        () => {
            const linked = mutatePackage('linux', (directory) => {
                const path = resolve(directory, 'bin/erden-reasoner');
                rmSync(path);
                symlinkSync('/bin/true', path);
            });
            expectedError(
                () => resolveBundledReasoner({ runtime: runtimes.linux, locatePackage: locate(linked) }),
                ERROR_CODES.symlinkDisallowed,
            );
        },
    );

    describe.skipIf(UNRELEASED || process.platform === 'win32')('executable permission', () => {
        it.each(['linux', 'linuxArm64', 'darwinArm64'] as const)(
            'rejects a %s binary that is not executable',
            (name) => {
                const nonExecutable = mutatePackage(name, (directory) => {
                    chmodSync(resolve(directory, 'bin/erden-reasoner'), 0o644);
                });
                expectedError(
                    () => resolveBundledReasoner({ runtime: runtimes[name], locatePackage: locate(nonExecutable) }),
                    ERROR_CODES.binaryNotExecutable,
                );
            },
        );
    });
});

describe('structured doctor and committed known answer', () => {
    it.skipIf(UNRELEASED)(
        'runs the real qualified current-platform binary through the committed protocol fixture',
        () => {
            const result = runBundledReasonerKnownAnswer({
                runtime: runtimes[current],
                locatePackage: locate(packed[current].directory),
            });
            expect(result).toMatchObject({
                fixture: 'subclass-type',
                status: 'passed',
                responseBytes: artifactOf(current).responseBytes,
            });
            const doctor = inspectBundledReasoner({
                runtime: runtimes[current],
                locatePackage: locate(packed[current].directory),
                runSelfTest: true,
            });
            expect(doctor).toMatchObject({
                availability: 'available',
                packageVersion: PACKAGE_VERSION,
                toolVersion: PACKAGE_VERSION,
                selfTest: { status: 'passed' },
            });
            const artifact = resolveBundledReasonerArtifact({
                runtime: runtimes[current],
                locatePackage: locate(packed[current].directory),
            });
            expect(artifact.path).toBe(doctor.path);
            expect(artifact.requiredTool).toEqual({
                name: 'erden-reasoner',
                version: PACKAGE_VERSION,
                executableDigest: doctor.digest,
                adapterDigest: REASONER_TOOL.adapterDigest,
                calculusDigest: REASONER_TOOL.calculusDigest,
            });
            expect(doctor.requiredTool).toEqual(artifact.requiredTool);
            expect(Object.isFrozen(artifact)).toBe(true);
            expect(Object.isFrozen(artifact.requiredTool)).toBe(true);
        },
    );

    it.skipIf(UNRELEASED)(
        'turns every malformed packed known-answer fixture into a typed, context-complete doctor failure',
        async () => {
            const anchor = artifactOf(current);
            const expected = {
                packageName: anchor.packageName,
                target: anchor.target,
                size: anchor.bytes,
                digest: anchor.sha256,
            };
            function fixture(directory: string) {
                return resolve(directory, 'fixtures/known-answer.request.json');
            }
            const mutations: ReadonlyArray<(directory: string) => void> = [
                (directory) => {
                    rmSync(fixture(directory));
                },
                (directory) => {
                    writeFileSync(fixture(directory), '{');
                },
                (directory) => {
                    writeJson(fixture(directory), null);
                },
                (directory) => {
                    writeJson(fixture(directory), 7);
                },
                (directory) => {
                    writeJson(fixture(directory), { kind: 'ReasonerRequest' });
                },
                (directory) => {
                    rmSync(fixture(directory));
                    mkdirSync(fixture(directory));
                },
            ];

            for (const mutate of mutations) {
                const directory = mutateDistribution(mutate);
                const distribution = await importDistribution(directory);
                const options = { runtime: runtimes[current], locatePackage: locate(packed[current].directory) };
                expect(() => distribution.runBundledReasonerKnownAnswer(options)).toThrow(
                    distribution.BundledReasonerError,
                );
                try {
                    distribution.runBundledReasonerKnownAnswer(options);
                } catch (error) {
                    expect((error as InstanceType<typeof distribution.BundledReasonerError>).code).toBe(
                        distribution.ERROR_CODES.selfTestFailed,
                    );
                }
                expect(() => distribution.inspectBundledReasoner({ ...options, runSelfTest: true })).not.toThrow();
                expect(distribution.inspectBundledReasoner({ ...options, runSelfTest: true })).toMatchObject({
                    availability: 'unavailable',
                    expectedPlatformPackage: expected.packageName,
                    actualPlatformPackage: expected.packageName,
                    packageVersion: PACKAGE_VERSION,
                    toolVersion: PACKAGE_VERSION,
                    size: expected.size,
                    digest: expected.digest,
                    target: expected.target,
                    failureCode: 'SELF_TEST_FAILED',
                    selfTest: { status: 'failed', failureCode: 'SELF_TEST_FAILED' },
                });
            }
        },
    );

    it.skipIf(UNRELEASED || process.platform === 'win32')(
        'rejects a symbolic-link packed known-answer fixture with a typed, context-complete failure',
        async () => {
            const directory = mutateDistribution((copy) => {
                const path = resolve(copy, 'fixtures/known-answer.request.json');
                rmSync(path);
                symlinkSync(resolve(packed.distribution.directory, 'fixtures/known-answer.request.json'), path);
            });
            const distribution = await importDistribution(directory);
            const options = { runtime: runtimes[current], locatePackage: locate(packed[current].directory) };
            expect(() => distribution.runBundledReasonerKnownAnswer(options)).toThrow(
                distribution.BundledReasonerError,
            );
            expect(distribution.inspectBundledReasoner({ ...options, runSelfTest: true })).toMatchObject({
                availability: 'unavailable',
                actualPlatformPackage: platformPackages[current],
                packageVersion: PACKAGE_VERSION,
                toolVersion: PACKAGE_VERSION,
                size: artifactOf(current).bytes,
                digest: artifactOf(current).sha256,
                target: artifactOf(current).target,
                failureCode: 'SELF_TEST_FAILED',
            });
        },
    );

    it.skipIf(UNRELEASED)('returns deterministic unavailable doctor data instead of throwing', () => {
        expect(inspectBundledReasoner({ runtime: runtimes.windows, locatePackage: () => undefined })).toEqual({
            availability: 'unavailable',
            expectedPlatformPackage: '@erden/reasoner-win32-x64-msvc',
            actualPlatformPackage: undefined,
            packageVersion: undefined,
            toolVersion: undefined,
            path: undefined,
            size: undefined,
            digest: undefined,
            target: undefined,
            requiredTool: undefined,
            failureCode: 'PACKAGE_MISSING',
            selfTest: { status: 'failed', failureCode: 'PACKAGE_MISSING' },
        });
    });

    it('keeps the known-answer request byte-identical to the committed protocol fixture', () => {
        expect(readFileSync(resolve(root, 'reasoner/distribution/fixtures/known-answer.request.json'))).toEqual(
            readFileSync(resolve(root, 'reasoner/protocol/fixtures/known-answer/subclass-type.request.json')),
        );
    });

    // This legacy handoff may still describe the private server's earlier release. The public tools do not use it.
    const handoffVersion = JSON.parse(
        readFileSync(resolve(packageDirectories.distribution, 'server-image-handoff.json'), 'utf8'),
    ) as { packageVersion: string };
    it.skipIf(UNRELEASED || handoffVersion.packageVersion !== PACKAGE_VERSION)(
        'checks a server-image handoff for the current release',
        () => {
            const handoff = JSON.parse(
                readFileSync(resolve(packageDirectories.distribution, 'server-image-handoff.json'), 'utf8'),
            ) as {
                status: string;
                sourcePackage: string;
                bytes: number;
                sha256: string;
            };
            const metadata = JSON.parse(readFileSync(resolve(packageDirectories.linux, 'metadata.json'), 'utf8')) as {
                binary: { bytes: number; sha256: string };
            };
            expect(handoff).toMatchObject({
                status: 'integrated-and-qualified',
                sourcePackage: '@erden/reasoner-linux-x64-gnu',
            });
            expect({ bytes: handoff.bytes, sha256: handoff.sha256 }).toEqual({
                bytes: metadata.binary.bytes,
                sha256: metadata.binary.sha256,
            });
        },
    );
});

describe.skipIf(REASONER_RELEASED)('an unreleased version runs a reasoner built from source', () => {
    const built = resolve(
        root,
        'reasoner/target/release',
        process.platform === 'win32' ? 'erden-reasoner.exe' : 'erden-reasoner',
    );
    const configured = process.env.ERDEN_REASONER_BIN;
    const binary = configured !== undefined && configured !== '' ? configured : built;

    it('names the release workflow and the build command when no source build exists', () => {
        const absent = resolve(temporaryRoot, 'no-such-build', 'erden-reasoner');
        expectedError(() => resolveBundledReasoner({ sourceBuild: absent }), ERROR_CODES.sourceBuildMissing);
        try {
            resolveBundledReasoner({ sourceBuild: absent });
        } catch (error) {
            expect((error as BundledReasonerError).message).toContain('release.yml');
            expect((error as BundledReasonerError).message).toContain('pnpm run reasoner:build');
        }
        expect(inspectBundledReasoner({ sourceBuild: absent, runSelfTest: true })).toMatchObject({
            availability: 'unavailable',
            expectedPlatformPackage: SOURCE_BUILD,
            failureCode: ERROR_CODES.sourceBuildMissing,
            selfTest: { status: 'failed', failureCode: ERROR_CODES.sourceBuildMissing },
        });
        // A relative path is never resolved against the working directory.
        expectedError(
            () => resolveBundledReasoner({ sourceBuild: 'target/release/erden-reasoner' }),
            ERROR_CODES.sourceBuildMissing,
        );
    });

    it('refuses a source build that is a link, not a regular file, or not executable', () => {
        const directory = resolve(temporaryRoot, `source-build-${Math.random().toString(16).slice(2)}`);
        mkdirSync(directory, { recursive: true });
        const target = resolve(directory, 'real');
        writeFileSync(target, 'not a reasoner\n', { mode: 0o755 });
        if (process.platform !== 'win32') {
            const link = resolve(directory, 'link');
            symlinkSync(target, link);
            expectedError(() => resolveBundledReasoner({ sourceBuild: link }), ERROR_CODES.symlinkDisallowed);
            chmodSync(target, 0o644);
            expectedError(() => resolveBundledReasoner({ sourceBuild: target }), ERROR_CODES.binaryNotExecutable);
        }
        expectedError(() => resolveBundledReasoner({ sourceBuild: directory }), ERROR_CODES.binaryNotRegular);
    });

    it.skipIf(process.platform === 'win32')(
        'fails the known-answer test of a program that does not answer as this reasoner',
        () => {
            const fake = resolve(temporaryRoot, `fake-${Math.random().toString(16).slice(2)}`);
            writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "{}"\n', { mode: 0o755 });
            expect(inspectBundledReasoner({ sourceBuild: fake, runSelfTest: true })).toMatchObject({
                availability: 'unavailable',
                expectedPlatformPackage: SOURCE_BUILD,
                failureCode: ERROR_CODES.selfTestFailed,
                selfTest: { status: 'failed', failureCode: ERROR_CODES.selfTestFailed },
            });
            // Resolution alone does not run it: the identity a request names is what the program must answer with.
            expect(resolveBundledReasonerArtifact({ sourceBuild: fake }).requiredTool.version).toBe(TOOL_VERSION);
        },
    );

    it.skipIf(!existsSync(binary))('runs the source build with the identity it answers with', () => {
        const digest = `sha256:${sha256(binary)}`;
        const artifact = resolveBundledReasonerArtifact({ sourceBuild: binary });
        expect(artifact.requiredTool).toMatchObject({
            name: 'erden-reasoner',
            version: TOOL_VERSION,
            executableDigest: digest,
        });
        expect(runBundledReasonerKnownAnswer({ sourceBuild: binary })).toMatchObject({
            fixture: 'subclass-type',
            status: 'passed',
        });
        expect(inspectBundledReasoner({ sourceBuild: binary, runSelfTest: true })).toMatchObject({
            availability: 'available',
            expectedPlatformPackage: SOURCE_BUILD,
            actualPlatformPackage: SOURCE_BUILD,
            packageVersion: PACKAGE_VERSION,
            toolVersion: TOOL_VERSION,
            digest,
            selfTest: { status: 'passed' },
        });
    });
});
