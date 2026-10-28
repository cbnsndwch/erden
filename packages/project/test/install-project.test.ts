import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    makeCurrentToolchainService,
    normalizeManifestV1,
    parseLockfile,
    serializeLockfileBytes,
    serializeManifestV1,
    type LockToolchain,
} from '@erden/contracts';
import { encodePackage, PACKAGE_CODEC_LIMITS } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    InstallProjectUnavailableError,
    InstallProjectError,
    DependencyRegistryUnavailableError,
    DependencyResolutionError,
    encodeInstallProjectReport,
    decodeInstallProjectReport,
    decodeLockAvailability,
    decodeMaterializeLockResult,
    decodeRefreshProjectReferenceResult,
    makeFixtureDependencyRegistry,
    unavailableDependencyRegistry,
    makeInstallProjectService,
    makeLocalPackageStore,
    makeNodeProjectDependencyStateFileSystemPort,
    makeProjectDependencyStateService,
    renderInstallProjectError,
    renderInstallProjectReport,
    type InstallProjectStoreShape,
    type LockAvailability,
    type MaterializeLockInput,
    type MaterializeLockResult,
    type PutPackageInput,
    type RefreshProjectReferenceInput,
    type VerifyLockAvailabilityInput,
} from '../src/index.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: digest('a') }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: digest('b') }),
});
const REGISTRY = 'https://registry.example';
const PACKAGE_IRI = 'https://example.test/package-a';

async function createProject(root: string, dependencies: Readonly<Record<string, string>>): Promise<void> {
    const manifest = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/project-b',
        alias: '@example/project-b',
        ownedIriPrefixes: ['https://example.test/project-b#'],
        ...(Object.keys(dependencies).length === 0 ? {} : { registry: REGISTRY }),
        dependencies,
        sources: { ontology: ['ontology.ttl'] },
    });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'), { mode: 0o644 });
    await fs.writeFile(join(root, 'ontology.ttl'), '<urn:root> <urn:p> <urn:o> .\n', { mode: 0o644 });
}

function packageFixture() {
    return encodePackage({
        canonicalIri: PACKAGE_IRI,
        version: '1.0.0',
        dependencies: [],
        validator: TOOLCHAIN.validator,
        reasoner: TOOLCHAIN.reasoner,
        files: [{ path: 'ontology.ttl', bytes: '<urn:a> <urn:p> <urn:o> .\n', executable: false }],
    });
}

interface FakeStoreState {
    readonly availability: LockAvailability;
    readonly puts: string[];
    readonly repairs: string[];
    readonly materializations: number;
}

function fakeStore(
    initial: Readonly<{
        readonly missing?: ReadonlyArray<string>;
        readonly corrupt?: ReadonlyArray<string>;
        readonly busy?: ReadonlyArray<string>;
    }> = {},
): Readonly<{
    readonly service: InstallProjectStoreShape;
    readonly state: () => FakeStoreState;
}> {
    const missing = new Set(initial.missing ?? []);
    const corrupt = new Set(initial.corrupt ?? []);
    const busy = new Set(initial.busy ?? []);
    const puts: string[] = [];
    const repairs: string[] = [];
    let materializations = 0;
    function availability(packages: number): LockAvailability {
        return Object.freeze({
            status: missing.size === 0 && corrupt.size === 0 && busy.size === 0 ? 'available' : 'unavailable',
            packages,
            missing: Object.freeze([...missing].sort()),
            corrupt: Object.freeze([...corrupt].sort()),
            busy: Object.freeze([...busy].sort()),
        });
    }
    return Object.freeze({
        service: Object.freeze({
            refreshProjectReference: ({ lock }: RefreshProjectReferenceInput) =>
                Effect.succeed(
                    Object.freeze({
                        status: 'registered' as const,
                        registrationId: digest('c'),
                        generationSha256: digest('d'),
                        lockSha256: createHash('sha256').update(serializeLockfileBytes(lock)).digest('hex'),
                        packages: lock.packages.length,
                    }),
                ),
            verifyLockAvailability: ({ lock }: VerifyLockAvailabilityInput) =>
                Effect.succeed(availability(lock.packages.length)),
            put: ({ expected }: PutPackageInput) => {
                puts.push(expected.archiveSha256);
                missing.delete(expected.archiveSha256);
                return Effect.succeed(
                    Object.freeze({
                        status: 'stored' as const,
                        archiveSha256: expected.archiveSha256,
                        canonicalIri: expected.canonicalIri,
                        version: expected.version,
                        fileCount: 1,
                    }),
                );
            },
            repair: ({ expected }: PutPackageInput) => {
                repairs.push(expected.archiveSha256);
                corrupt.delete(expected.archiveSha256);
                return Effect.succeed(
                    Object.freeze({
                        status: 'repaired' as const,
                        cleanup: 'clean' as const,
                        archiveSha256: expected.archiveSha256,
                        canonicalIri: expected.canonicalIri,
                        version: expected.version,
                        fileCount: 1,
                    }),
                );
            },
            materialize: ({ lock }: MaterializeLockInput) => {
                materializations += 1;
                return Effect.succeed(
                    Object.freeze({
                        status: 'materialized' as const,
                        cleanup: 'clean' as const,
                        manifestDependencySha256: lock.manifestDependencySha256,
                        packages: lock.packages.length,
                        strategies: Object.freeze({ clone: lock.packages.length, hardlink: 0, copy: 0 }),
                    }),
                );
            },
        }),
        state: () => ({
            availability: availability(missing.size + corrupt.size + busy.size),
            puts: [...puts],
            repairs: [...repairs],
            materializations,
        }),
    });
}

function serviceFixture(
    root: string,
    store: InstallProjectStoreShape,
    registry = (() => {
        const encoded = packageFixture();
        return makeFixtureDependencyRegistry({
            registryOrigin: REGISTRY,
            aliases: [{ alias: '@example/package-a', canonicalIri: PACKAGE_IRI }],
            packages: [
                {
                    canonicalIri: PACKAGE_IRI,
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    manifest: encoded.manifest,
                    archive: encoded.archiveBytes,
                },
            ],
        });
    })(),
) {
    return Object.freeze({
        registry,
        service: makeInstallProjectService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            registry,
            store,
            Object.freeze({ defaultStoreRoot: () => join(root, 'store') }),
        ),
    });
}

describe('fixture dependency registry and InstallProject', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) {
            cleanupTestTempRoot(root);
        }
    });

    it.each([
        ['empty-root', 'INSTALL_PROJECT_MANIFEST_UNAVAILABLE'],
        ['ambiguous-manifest', 'INSTALL_PROJECT_MANIFEST_UNAVAILABLE'],
        ['malformed-manifest', 'INSTALL_PROJECT_MANIFEST_UNAVAILABLE'],
        ['malformed-lock', 'INSTALL_PROJECT_LOCK_INVALID'],
        ['active-transaction', 'INSTALL_PROJECT_TRANSACTION_PENDING'],
    ] as const)('classifies project dependency state %s precisely', async (scenario, expectedCode) => {
        const root = makeTestTempRoot('erden-install-state-classification-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        if (scenario !== 'empty-root') {
            await createProject(projectRoot, {});
            if (scenario === 'ambiguous-manifest') {
                const bytes = await fs.readFile(join(projectRoot, 'erden.config.json'));
                await fs.writeFile(join(projectRoot, 'erden.config.jsonc'), bytes);
            } else if (scenario === 'malformed-manifest') {
                await fs.writeFile(join(projectRoot, 'erden.config.json'), '{ invalid json');
            } else if (scenario === 'malformed-lock') {
                await fs.writeFile(join(projectRoot, 'erden.lock'), 'not: canonical\n');
            } else {
                await fs.writeFile(join(projectRoot, '.erden.dependencies.transaction.json'), '{}\n');
            }
        }
        const failure = await Effect.runPromise(
            serviceFixture(root, fakeStore().service)
                .service.install({
                    from: projectRoot,
                    offline: true,
                })
                .pipe(Effect.flip),
        );
        expect(failure).toMatchObject({ code: expectedCode });
        expect(renderInstallProjectError(failure)).not.toContain(root);
    });

    it('resolves, writes, acquires, and then reuses a matching closure with zero registry calls', async () => {
        const root = makeTestTempRoot('erden-install-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const store = fakeStore({ missing: [encoded.archiveSha256] });
        const fixture = serviceFixture(root, store.service);
        const first = await Effect.runPromise(fixture.service.install({ from: projectRoot }));
        expect(first).toMatchObject({
            lock: { status: 'written' },
            packages: { total: 1, fetched: [encoded.archiveSha256], repaired: [], reused: [] },
            outcome: 'installed',
        });
        expect(fixture.registry.trace().map(({ operation }) => operation)).toEqual([
            'resolve-alias',
            'list-published',
            'fetch-archive',
        ]);
        expect(Object.isFrozen(fixture.registry.trace())).toBe(true);
        fixture.registry.clearTrace();
        const second = await Effect.runPromise(fixture.service.install({ from: projectRoot }));
        expect(second).toMatchObject({
            lock: { status: 'existing' },
            packages: { reused: [encoded.archiveSha256], fetched: [], repaired: [] },
        });
        expect(fixture.registry.trace()).toEqual([]);
        expect(store.state()).toMatchObject({ puts: [encoded.archiveSha256], repairs: [], materializations: 2 });
    });

    it('honors frozen and offline lock truth without registry calls or writes', async () => {
        const root = makeTestTempRoot('erden-install-modes-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const store = fakeStore({ missing: [encoded.archiveSha256] });
        const fixture = serviceFixture(root, store.service);
        await expect(
            Effect.runPromise(fixture.service.install({ from: projectRoot, frozenLockfile: true })),
        ).rejects.toMatchObject({ code: 'INSTALL_PROJECT_FROZEN_LOCK_REQUIRED' });
        await expect(
            Effect.runPromise(fixture.service.install({ from: projectRoot, offline: true })),
        ).rejects.toMatchObject({ code: 'INSTALL_PROJECT_OFFLINE_LOCK_REQUIRED' });
        expect(fixture.registry.trace()).toEqual([]);
        await expect(fs.access(join(projectRoot, 'erden.lock'))).rejects.toBeDefined();
    });

    it('writes a canonical empty lock offline with zero registry calls', async () => {
        const root = makeTestTempRoot('erden-install-empty-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, {});
        const store = fakeStore();
        const fixture = serviceFixture(root, store.service);
        const report = await Effect.runPromise(fixture.service.install({ from: projectRoot, offline: true }));
        expect(report).toMatchObject({
            mode: { offline: true },
            lock: { status: 'written' },
            packages: { total: 0, reused: [], fetched: [], repaired: [] },
        });
        expect(fixture.registry.trace()).toEqual([]);
        expect(await fs.readFile(join(projectRoot, 'erden.lock'), 'utf8')).toContain('lockfileVersion: 1\n');
    });

    it('routes an explicit manifest path through the manifest service contract', async () => {
        const root = makeTestTempRoot('erden-install-explicit-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, {});
        const store = fakeStore();
        const fixture = serviceFixture(root, store.service);
        const report = await Effect.runPromise(
            fixture.service.install({
                manifestPath: join(projectRoot, 'erden.config.json'),
                offline: true,
            }),
        );
        expect(report.project).toEqual({
            canonicalIri: 'https://example.test/project-b',
            alias: '@example/project-b',
        });
        expect(await fs.readFile(join(projectRoot, 'erden.lock'), 'utf8')).toContain('lockfileVersion: 1\n');
    });

    it('deep-snapshots and freezes fixture registry releases on construction and return', async () => {
        const encoded = packageFixture();
        const manifest = structuredClone(encoded.manifest);
        const registry = makeFixtureDependencyRegistry({
            registryOrigin: REGISTRY,
            aliases: [{ alias: '@example/package-a', canonicalIri: PACKAGE_IRI }],
            packages: [
                {
                    canonicalIri: PACKAGE_IRI,
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    manifest,
                    archive: encoded.archiveBytes,
                },
            ],
        });
        (manifest.files[0] as { path: string }).path = 'mutated-after-construction.ttl';
        const releases = await registry.listPublished(REGISTRY, PACKAGE_IRI);
        expect(releases[0]?.manifest.files[0]?.path).toBe('ontology.ttl');
        expect(Object.isFrozen(releases)).toBe(true);
        expect(Object.isFrozen(releases[0])).toBe(true);
        expect(Object.isFrozen(releases[0]?.manifest)).toBe(true);
        expect(Object.isFrozen(releases[0]?.manifest.dependencies)).toBe(true);
        expect(Object.isFrozen(releases[0]?.manifest.files)).toBe(true);
        expect(Object.isFrozen(releases[0]?.manifest.files[0])).toBe(true);
        expect(Object.isFrozen(releases[0]?.manifest.toolchain.validator)).toBe(true);
    });

    it('rejects contradictory availability before offline acquisition or materialization', async () => {
        const root = makeTestTempRoot('erden-install-availability-truth-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const availableStore = fakeStore();
        const initial = serviceFixture(root, availableStore.service);
        await Effect.runPromise(initial.service.install({ from: projectRoot }));
        initial.registry.clearTrace();
        let materializations = 0;
        const contradictoryStore: InstallProjectStoreShape = Object.freeze({
            ...availableStore.service,
            verifyLockAvailability: () =>
                Effect.succeed({
                    status: 'available' as const,
                    packages: 1,
                    missing: [encoded.archiveSha256],
                    corrupt: [],
                    busy: [],
                }),
            materialize: (input: MaterializeLockInput) => {
                materializations += 1;
                return availableStore.service.materialize(input);
            },
        });
        const fixture = serviceFixture(root, contradictoryStore, initial.registry);
        const failure = await Effect.runPromise(
            fixture.service.install({ from: projectRoot, offline: true }).pipe(Effect.flip),
        );
        expect(failure).toMatchObject({
            code: 'INSTALL_PROJECT_STORE_FAILURE',
            message: 'The local package store returned invalid availability truth',
        });
        expect(Object.isFrozen(failure)).toBe(true);
        expect(fixture.registry.trace()).toEqual([]);
        expect(materializations).toBe(0);
    });

    it('uses an immutable initial availability snapshot across awaited acquisition', async () => {
        const root = makeTestTempRoot('erden-install-availability-snapshot-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const missing = [encoded.archiveSha256];
        const corrupt: string[] = [];
        const puts: string[] = [];
        const repairs: string[] = [];
        let checks = 0;
        const store: InstallProjectStoreShape = Object.freeze({
            refreshProjectReference: ({ lock }: RefreshProjectReferenceInput) =>
                Effect.succeed(
                    Object.freeze({
                        status: 'registered' as const,
                        registrationId: digest('c'),
                        generationSha256: digest('d'),
                        lockSha256: createHash('sha256').update(serializeLockfileBytes(lock)).digest('hex'),
                        packages: lock.packages.length,
                    }),
                ),
            verifyLockAvailability: () =>
                Effect.succeed(
                    checks++ === 0
                        ? {
                              status: 'unavailable' as const,
                              packages: 1,
                              missing,
                              corrupt,
                              busy: [],
                          }
                        : {
                              status: 'available' as const,
                              packages: 1,
                              missing: [],
                              corrupt: [],
                              busy: [],
                          },
                ),
            put: ({ expected }: PutPackageInput) => {
                puts.push(expected.archiveSha256);
                return Effect.succeed(
                    Object.freeze({
                        status: 'stored' as const,
                        archiveSha256: expected.archiveSha256,
                        canonicalIri: expected.canonicalIri,
                        version: expected.version,
                        fileCount: 1,
                    }),
                );
            },
            repair: ({ expected }: PutPackageInput) => {
                repairs.push(expected.archiveSha256);
                return Effect.succeed(
                    Object.freeze({
                        status: 'repaired' as const,
                        cleanup: 'clean' as const,
                        archiveSha256: expected.archiveSha256,
                        canonicalIri: expected.canonicalIri,
                        version: expected.version,
                        fileCount: 1,
                    }),
                );
            },
            materialize: ({ lock }: MaterializeLockInput) =>
                Effect.succeed(
                    Object.freeze({
                        status: 'materialized' as const,
                        cleanup: 'clean' as const,
                        manifestDependencySha256: lock.manifestDependencySha256,
                        packages: lock.packages.length,
                        strategies: Object.freeze({ clone: lock.packages.length, hardlink: 0, copy: 0 }),
                    }),
                ),
        });
        const base = serviceFixture(root, store).registry;
        const registry = Object.freeze({
            ...base,
            fetchArchive: async (...args: Parameters<typeof base.fetchArchive>) => {
                missing.splice(0, missing.length);
                corrupt.push(encoded.archiveSha256);
                return await base.fetchArchive(...args);
            },
        });
        const fixture = serviceFixture(root, store, registry);
        const report = await Effect.runPromise(fixture.service.install({ from: projectRoot }));
        expect(report.packages).toMatchObject({ fetched: [encoded.archiveSha256], repaired: [] });
        expect(puts).toEqual([encoded.archiveSha256]);
        expect(repairs).toEqual([]);
    });

    it('enforces exact availability count, status, lock membership, ordering, and disjointness', async () => {
        const root = makeTestTempRoot('erden-install-availability-decoder-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const fixture = serviceFixture(root, fakeStore().service);
        await Effect.runPromise(fixture.service.install({ from: projectRoot }));
        const lock = parseLockfile(await fs.readFile(join(projectRoot, 'erden.lock')));
        const valid = {
            status: 'unavailable' as const,
            packages: 1,
            missing: [encoded.archiveSha256],
            corrupt: [],
            busy: [],
        };
        expect(decodeLockAvailability(lock, valid)).toEqual(valid);
        expect(() => decodeLockAvailability(lock, { ...valid, packages: 0 })).toThrow(InstallProjectError);
        expect(() => decodeLockAvailability(lock, { ...valid, status: 'available' })).toThrow(InstallProjectError);
        expect(() => decodeLockAvailability(lock, { ...valid, missing: [digest('f')] })).toThrow(InstallProjectError);
        expect(() =>
            decodeLockAvailability(lock, {
                ...valid,
                corrupt: [encoded.archiveSha256],
            }),
        ).toThrow(InstallProjectError);
        expect(() =>
            decodeLockAvailability(lock, {
                ...valid,
                missing: [encoded.archiveSha256, encoded.archiveSha256],
            }),
        ).toThrow(InstallProjectError);
        expect(() =>
            decodeLockAvailability(lock, {
                ...valid,
                status: 'unavailable',
                missing: [],
            }),
        ).toThrow(InstallProjectError);
    });

    it('snapshots and authenticates exact materialization truth against the lock', async () => {
        const root = makeTestTempRoot('erden-install-materialization-decoder-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const fixture = serviceFixture(root, fakeStore().service);
        await Effect.runPromise(fixture.service.install({ from: projectRoot }));
        const lock = parseLockfile(await fs.readFile(join(projectRoot, 'erden.lock')));
        const valid = {
            status: 'materialized' as const,
            cleanup: 'clean' as const,
            manifestDependencySha256: lock.manifestDependencySha256,
            packages: 1,
            strategies: { clone: 1, hardlink: 0, copy: 0 },
        };
        const decoded = decodeMaterializeLockResult(lock, valid);
        expect(decoded).toEqual(valid);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.strategies)).toBe(true);
        for (const invalid of [
            { ...valid, manifestDependencySha256: digest('f') },
            { ...valid, packages: 0 },
            { ...valid, status: 'hit', strategies: { clone: 1, hardlink: 0, copy: 0 } },
            { ...valid, strategies: { clone: 0, hardlink: 0, copy: 0 } },
            { ...valid, strategies: { clone: PACKAGE_CODEC_LIMITS.maxEntries + 1, hardlink: 0, copy: 0 } },
            { ...valid, strategies: { clone: -0, hardlink: 0, copy: 0 } },
            { ...valid, extra: true },
            { ...valid, strategies: { clone: 1, hardlink: 0, copy: 0, extra: true } },
        ]) {
            expect(() => decodeMaterializeLockResult(lock, invalid)).toThrow(InstallProjectError);
        }

        let getterInvoked = false;
        const accessorStrategies = { hardlink: 0, copy: 0 } as Record<string, unknown>;
        Object.defineProperty(accessorStrategies, 'clone', {
            enumerable: true,
            get: () => {
                getterInvoked = true;
                throw new Error('C:/private-materialization-accessor');
            },
        });
        expect(() => decodeMaterializeLockResult(lock, { ...valid, strategies: accessorStrategies })).toThrow(
            InstallProjectError,
        );
        expect(getterInvoked).toBe(false);
        expect(() =>
            decodeMaterializeLockResult(
                lock,
                new Proxy(valid, {
                    ownKeys: () => {
                        throw new Error('C:/private-materialization-proxy');
                    },
                }),
            ),
        ).toThrow(InstallProjectError);
    });

    it('snapshots and authenticates project registration truth before store acquisition', async () => {
        const root = makeTestTempRoot('erden-install-registration-decoder-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const fixture = serviceFixture(root, fakeStore().service);
        await Effect.runPromise(fixture.service.install({ from: projectRoot }));
        const lock = parseLockfile(await fs.readFile(join(projectRoot, 'erden.lock')));
        const valid = {
            status: 'registered' as const,
            registrationId: digest('c'),
            generationSha256: digest('d'),
            lockSha256: createHash('sha256').update(serializeLockfileBytes(lock)).digest('hex'),
            packages: lock.packages.length,
        };
        const decoded = decodeRefreshProjectReferenceResult(lock, valid);
        expect(decoded).toEqual(valid);
        expect(Object.isFrozen(decoded)).toBe(true);
        for (const invalid of [
            { ...valid, status: 'unknown' },
            { ...valid, registrationId: digest('C') },
            { ...valid, generationSha256: digest('x') },
            { ...valid, lockSha256: digest('e') },
            { ...valid, packages: lock.packages.length + 1 },
            { ...valid, extra: true },
            new Proxy(valid, {
                ownKeys: () => {
                    throw new Error('D:/private-registration-result');
                },
            }),
        ]) {
            expect(() => decodeRefreshProjectReferenceResult(lock, invalid)).toThrow(InstallProjectError);
        }

        let availabilityCalls = 0;
        const hostileStore: InstallProjectStoreShape = Object.freeze({
            ...fakeStore().service,
            refreshProjectReference: () => Effect.succeed({ ...valid, lockSha256: digest('e') }),
            verifyLockAvailability: ({ lock: currentLock }: VerifyLockAvailabilityInput) => {
                availabilityCalls += 1;
                return Effect.succeed(
                    Object.freeze({
                        status: 'available' as const,
                        packages: currentLock.packages.length,
                        missing: Object.freeze([]),
                        corrupt: Object.freeze([]),
                        busy: Object.freeze([]),
                    }),
                );
            },
        });
        const failure = await Effect.runPromise(
            serviceFixture(root, hostileStore).service.install({ from: projectRoot }).pipe(Effect.flip),
        );
        expect(failure).toMatchObject({
            code: 'INSTALL_PROJECT_STORE_FAILURE',
            message: 'The local package store returned invalid project registration truth',
        });
        expect(availabilityCalls).toBe(0);
        expect(JSON.stringify(failure)).not.toContain(root.replaceAll('\\', '/'));
    });

    it('rejects hostile materialization port results before report construction', async () => {
        const root = makeTestTempRoot('erden-install-materialization-port-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, {});
        const store = fakeStore();
        const base = {
            status: 'hit' as const,
            cleanup: 'clean' as const,
            manifestDependencySha256: digest('a'),
            packages: 0,
            strategies: { clone: 0, hardlink: 0, copy: 0 },
        };
        const invalidResults: unknown[] = [
            base,
            { ...base, packages: 99 },
            { ...base, strategies: { clone: 1, hardlink: 0, copy: 0 } },
            { ...base, status: 'materialized', strategies: { clone: 1, hardlink: 0, copy: 0 } },
            { ...base, extra: true },
            new Proxy(base, {
                getOwnPropertyDescriptor: () => {
                    throw new Error('D:/private-store-result');
                },
            }),
        ];
        for (const invalid of invalidResults) {
            const hostileStore: InstallProjectStoreShape = Object.freeze({
                ...store.service,
                materialize: () => Effect.succeed(invalid as MaterializeLockResult),
            });
            const failure = await Effect.runPromise(
                serviceFixture(root, hostileStore)
                    .service.install({ from: projectRoot, offline: true })
                    .pipe(Effect.flip),
            );
            expect(failure).toBeInstanceOf(InstallProjectError);
            expect(failure).toMatchObject({
                code: 'INSTALL_PROJECT_STORE_FAILURE',
                message: 'The local package store returned invalid materialization truth',
            });
            expect(failure.message).not.toMatch(/private|[A-Z]:\//u);
            expect(Object.isFrozen(failure)).toBe(true);
        }
    });

    it('freezes typed install errors after defining their closed payloads', () => {
        const direct = new InstallProjectError('INSTALL_PROJECT_INVALID_INPUT', 'invalid');
        expect(Object.isFrozen(direct)).toBe(true);
        const unavailable = new InstallProjectUnavailableError({
            status: 'unavailable',
            packages: 1,
            missing: [digest('c')],
            corrupt: [],
            busy: [],
        });
        expect(Object.isFrozen(unavailable)).toBe(true);
        expect(Object.isFrozen(unavailable.availability)).toBe(true);
        expect(Object.isFrozen(unavailable.availability.missing)).toBe(true);
        expect(Object.prototype.propertyIsEnumerable.call(unavailable, 'cause')).toBe(false);
        expect(renderInstallProjectError(unavailable)).toBe(
            [
                'Erden install failed [INSTALL_PROJECT_PACKAGES_UNAVAILABLE]: The exact locked package closure is not locally available',
                `- missing ${digest('c')}`,
                '',
            ].join('\n'),
        );
    });

    it('encodes and renders one deterministic closed install report', async () => {
        const root = makeTestTempRoot('erden-install-report-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, {});
        const service = makeInstallProjectService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            unavailableDependencyRegistry,
            fakeStore().service,
            { defaultStoreRoot: () => join(root, 'store') },
        );
        const report = await Effect.runPromise(service.install({ from: projectRoot, offline: true }));
        const encoded = encodeInstallProjectReport(report);
        expect(encoded.endsWith('\n')).toBe(true);
        expect(JSON.parse(encoded)).toEqual({
            lock: { cleanup: 'clean', sha256: report.lock.sha256, status: 'written' },
            materialization: {
                cleanup: 'clean',
                status: 'materialized',
                strategies: { clone: 0, copy: 0, hardlink: 0 },
            },
            mode: { frozenLockfile: false, offline: true },
            outcome: 'installed',
            packages: { fetched: [], repaired: [], reused: [], total: 0 },
            project: { alias: '@example/project-b', canonicalIri: 'https://example.test/project-b' },
            schema: 'erden.install-report/v1',
        });
        expect(renderInstallProjectReport(report)).toContain('Packages: 0 total, 0 reused, 0 fetched, 0 repaired\n');
        expect(() =>
            decodeInstallProjectReport({
                ...(JSON.parse(encoded) as Record<string, unknown>),
                packages: { ...(JSON.parse(encoded) as { packages: Record<string, unknown> }).packages, total: -0 },
            }),
        ).toThrow('canonical nonnegative');
        const parsed = JSON.parse(encoded) as Record<string, unknown>;
        expect(() =>
            decodeInstallProjectReport({
                ...parsed,
                materialization: {
                    ...(parsed['materialization'] as Record<string, unknown>),
                    status: 'hit',
                    strategies: { clone: 1, copy: 0, hardlink: 0 },
                },
            }),
        ).toThrow('strategy counts');
        const onePackage = {
            ...parsed,
            packages: { total: 1, reused: [digest('c')], fetched: [], repaired: [] },
            materialization: {
                ...(parsed['materialization'] as Record<string, unknown>),
                strategies: { clone: 0, copy: 0, hardlink: 0 },
            },
        };
        expect(() => decodeInstallProjectReport(onePackage)).toThrow('strategy counts');
        expect(() =>
            decodeInstallProjectReport({
                ...onePackage,
                materialization: {
                    ...(onePackage.materialization as Record<string, unknown>),
                    strategies: { clone: PACKAGE_CODEC_LIMITS.maxEntries + 1, copy: 0, hardlink: 0 },
                },
            }),
        ).toThrow('strategy counts');
        expect(() =>
            decodeInstallProjectReport(
                new Proxy(
                    {},
                    {
                        getPrototypeOf: () => {
                            throw new Error('C:/private-install-report');
                        },
                    },
                ),
            ),
        ).toThrow('does not match erden.install-report/v1');
    });

    it('uses a capability-free production registry boundary and classifies every actual demand distinctly', async () => {
        expect(Object.keys(unavailableDependencyRegistry).sort()).toEqual([
            'fetchArchive',
            'listPublished',
            'resolveAlias',
        ]);
        await expect(unavailableDependencyRegistry.resolveAlias(REGISTRY, '@example/package-a')).rejects.toBeInstanceOf(
            DependencyRegistryUnavailableError,
        );
        await expect(unavailableDependencyRegistry.listPublished(REGISTRY, PACKAGE_IRI)).rejects.toBeInstanceOf(
            DependencyRegistryUnavailableError,
        );

        const root = makeTestTempRoot('erden-install-no-transport-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const service = makeInstallProjectService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            unavailableDependencyRegistry,
            fakeStore().service,
            { defaultStoreRoot: () => join(root, 'store') },
        );
        await expect(Effect.runPromise(service.install({ from: projectRoot }))).rejects.toMatchObject({
            code: 'INSTALL_PROJECT_REGISTRY_UNAVAILABLE',
            message: 'No production dependency registry transport is configured',
        });
        await expect(fs.access(join(projectRoot, 'erden.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('maps every hostile registry cause chain to one closed path-free resolution failure', async () => {
        const root = makeTestTempRoot('erden-install-hostile-registry-cause-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        let reflected = 0;
        const statefulPrototype = new Proxy(
            {},
            {
                getPrototypeOf: () => {
                    reflected += 1;
                    if (reflected === 1) {
                        return Object.prototype;
                    }
                    throw new Error('C:/private-registry-prototype');
                },
            },
        );
        const descriptorTrap = new Proxy(
            {},
            {
                getOwnPropertyDescriptor: () => {
                    reflected += 1;
                    throw new Error('D:/private-registry-descriptor');
                },
            },
        );
        const ownKeysTrap = new Proxy(
            {},
            {
                ownKeys: () => {
                    reflected += 1;
                    throw new Error('D:/private-registry-keys');
                },
            },
        );
        let accessorInvoked = false;
        const accessorCause = {};
        Object.defineProperty(accessorCause, 'cause', {
            enumerable: false,
            get: () => {
                accessorInvoked = true;
                throw new Error('D:/private-registry-accessor');
            },
        });
        const cyclicCause: { cause?: unknown } = {};
        cyclicCause.cause = cyclicCause;
        let deepCause: unknown = new DependencyRegistryUnavailableError();
        for (let index = 0; index < 40; index += 1) {
            deepCause = new DependencyResolutionError('catalog-failure', 'catalog failed', deepCause);
        }
        for (const hostile of [statefulPrototype, descriptorTrap, ownKeysTrap, accessorCause, cyclicCause, deepCause]) {
            async function reject(): Promise<never> {
                await Promise.resolve();
                throw hostile;
            }
            const registry = Object.freeze({
                resolveAlias: reject,
                listPublished: reject,
                fetchArchive: reject,
            });
            const failure = await Effect.runPromise(
                makeInstallProjectService(
                    makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
                    makeCurrentToolchainService(() => TOOLCHAIN),
                    registry,
                    fakeStore().service,
                    { defaultStoreRoot: () => join(root, 'store') },
                )
                    .install({ from: projectRoot })
                    .pipe(Effect.flip),
            );
            expect(failure).toBeInstanceOf(InstallProjectError);
            expect(failure).toMatchObject({
                code: 'INSTALL_PROJECT_RESOLUTION_FAILED',
                message: 'The dependency closure could not be resolved',
            });
            expect(failure.message).not.toMatch(/private|[A-Z]:\//u);
            expect(Object.prototype.propertyIsEnumerable.call(failure, 'cause')).toBe(false);
            expect(Object.isFrozen(failure)).toBe(true);
        }
        expect(reflected).toBe(0);
        expect(accessorInvoked).toBe(false);
    });

    it('reuses a matching cached closure through the no-transport registry and gates unavailable content offline', async () => {
        const root = makeTestTempRoot('erden-install-cached-no-transport-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const cached = fakeStore({ missing: [encoded.archiveSha256] });
        const seeded = serviceFixture(root, cached.service);
        await Effect.runPromise(seeded.service.install({ from: projectRoot }));
        const noTransport = makeInstallProjectService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            unavailableDependencyRegistry,
            cached.service,
            { defaultStoreRoot: () => join(root, 'store') },
        );
        const hit = await Effect.runPromise(noTransport.install({ from: projectRoot }));
        expect(hit).toMatchObject({
            lock: { status: 'existing' },
            packages: { reused: [encoded.archiveSha256], fetched: [], repaired: [] },
        });

        const missing = fakeStore({ missing: [encoded.archiveSha256] });
        const unavailable = makeInstallProjectService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            unavailableDependencyRegistry,
            missing.service,
            { defaultStoreRoot: () => join(root, 'store') },
        );
        const offline = await Effect.runPromise(
            unavailable.install({ from: projectRoot, offline: true }).pipe(Effect.flip),
        );
        expect(offline).toMatchObject({
            code: 'INSTALL_PROJECT_PACKAGES_UNAVAILABLE',
            availability: { missing: [encoded.archiveSha256] },
        });
        const online = await Effect.runPromise(unavailable.install({ from: projectRoot }).pipe(Effect.flip));
        expect(online).toMatchObject({ code: 'INSTALL_PROJECT_REGISTRY_UNAVAILABLE' });
    });

    it('returns the complete offline unavailable truth and repairs corrupt objects online', async () => {
        const root = makeTestTempRoot('erden-install-unavailable-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const busyStore = fakeStore({ busy: [encoded.archiveSha256] });
        const first = serviceFixture(root, busyStore.service);
        await expect(Effect.runPromise(first.service.install({ from: projectRoot }))).rejects.toBeInstanceOf(
            InstallProjectUnavailableError,
        );
        first.registry.clearTrace();
        const offlineError = await Effect.runPromise(
            first.service.install({ from: projectRoot, offline: true }).pipe(Effect.flip),
        );
        expect(offlineError).toMatchObject({
            code: 'INSTALL_PROJECT_PACKAGES_UNAVAILABLE',
            availability: { missing: [], corrupt: [], busy: [encoded.archiveSha256] },
        });
        expect(first.registry.trace()).toEqual([]);

        const corruptStore = fakeStore({ corrupt: [encoded.archiveSha256] });
        const second = serviceFixture(root, corruptStore.service);
        const repaired = await Effect.runPromise(second.service.install({ from: projectRoot }));
        expect(repaired.packages).toMatchObject({ repaired: [encoded.archiveSha256], fetched: [] });
        expect(second.registry.trace().map(({ operation }) => operation)).toEqual(['fetch-archive']);
        expect(corruptStore.state().repairs).toEqual([encoded.archiveSha256]);
    });

    it('preserves the newly resolved lock when exact archive acquisition fails', async () => {
        const root = makeTestTempRoot('erden-install-fetch-fail-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const store = fakeStore({ missing: [encoded.archiveSha256] });
        const fixture = serviceFixture(root, store.service);
        const failingRegistry = Object.freeze({
            ...fixture.registry,
            fetchArchive: () => Promise.resolve(null),
        });
        const service = makeInstallProjectService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            failingRegistry,
            store.service,
            { defaultStoreRoot: () => join(root, 'store') },
        );
        await expect(Effect.runPromise(service.install({ from: projectRoot }))).rejects.toMatchObject({
            code: 'INSTALL_PROJECT_REGISTRY_UNAVAILABLE',
        });
        await expect(fs.access(join(projectRoot, 'erden.lock'))).resolves.toBeUndefined();
    });

    it('keeps one Effect-owned archive signal live through ingestion and aborts it on interruption', async () => {
        const root = makeTestTempRoot('erden-install-archive-cancel-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const baseStore = fakeStore({ missing: [encoded.archiveSha256] }).service;
        let enterFetch: (() => void) | undefined;
        const fetched = new Promise<void>((resolve) => {
            enterFetch = resolve;
        });
        let observed: AbortSignal | undefined;
        let aborts = 0;
        const baseRegistry = serviceFixture(root, baseStore).registry;
        const registry = Object.freeze({
            ...baseRegistry,
            fetchArchive: async (
                origin: string,
                locked: Parameters<typeof baseRegistry.fetchArchive>[1],
                signal?: AbortSignal,
            ) => {
                observed = signal;
                signal?.addEventListener(
                    'abort',
                    () => {
                        aborts += 1;
                    },
                    { once: true },
                );
                enterFetch?.();
                return await baseRegistry.fetchArchive(origin, locked, signal);
            },
        });
        const stalledStore: InstallProjectStoreShape = Object.freeze({
            ...baseStore,
            put: () => Effect.never,
        });
        const service = makeInstallProjectService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            registry,
            stalledStore,
            { defaultStoreRoot: () => join(root, 'store') },
        );
        const fiber = Effect.runFork(service.install({ from: projectRoot }));
        await fetched;
        expect(observed?.aborted).toBe(false);
        await Effect.runPromise(Fiber.interrupt(fiber));
        expect(observed?.aborted).toBe(true);
        expect(aborts).toBe(1);
    });

    it('uses the real local store repair transaction for a damaged locked object', async () => {
        const root = makeTestTempRoot('erden-install-real-store-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        await createProject(projectRoot, { '@example/package-a': '^1.0.0' });
        const encoded = packageFixture();
        const store = makeLocalPackageStore();
        const fixture = serviceFixture(root, store);
        const installed = await Effect.runPromise(fixture.service.install({ from: projectRoot, storeRoot }));
        expect(installed.packages).toMatchObject({ fetched: [encoded.archiveSha256], repaired: [] });
        const damaged = join(storeRoot, 'objects', encoded.archiveSha256, 'archive.erdenpkg');
        await fs.chmod(damaged, 0o644);
        await fs.writeFile(damaged, Uint8Array.from([0]));
        fixture.registry.clearTrace();
        const repaired = await Effect.runPromise(fixture.service.install({ from: projectRoot, storeRoot }));
        expect(repaired.packages).toMatchObject({ fetched: [], repaired: [encoded.archiveSha256] });
        expect(fixture.registry.trace().map(({ operation }) => operation)).toEqual(['fetch-archive']);
        await expect(
            Effect.runPromise(store.inspect({ storeRoot, archiveSha256: encoded.archiveSha256 })),
        ).resolves.toMatchObject({ status: 'available', canonicalIri: PACKAGE_IRI });
    });
});
