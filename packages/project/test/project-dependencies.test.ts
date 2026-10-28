import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    makeCurrentToolchainService,
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    normalizeManifestV1,
    serializeLockfileBytes,
    serializeManifestV1,
    type LockToolchain,
    type ManifestV1,
    type RegistryReleaseIndexReaderShape,
} from '@erden/contracts';
import { encodePackage } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    InstallProjectError,
    ProjectDependenciesCommittedError,
    DependencyResolutionError,
    decodeInstallProjectReport,
    decodeProjectDependenciesReport,
    decodeProjectDependencyUpdateReport,
    encodeProjectDependenciesReport,
    encodeProjectDependencyUpdateReport,
    makeDependencyResolver,
    makeDependencyResolverFromReleaseIndex,
    makeFixtureDependencyRegistry,
    makeProjectDependenciesService,
    makeProjectDependencyStateService,
    makeNodeProjectDependencyStateFileSystemPort,
    makeNodeProjectDependenciesServiceFromReleaseIndex,
    renderProjectDependenciesError,
    renderProjectDependencyUpdateError,
    unavailableDependencyRegistry,
    type DependencyArchiveReaderShape,
    type InstallCommittedStateServiceShape,
    type InstallCommittedStateInput,
} from '../src/index.js';

const roots: string[] = [];
function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: digest('a') }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: digest('b') }),
});
const REGISTRY = 'https://registry.example';
const A = 'https://example.test/a';

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

function packageA() {
    return encodePackage({
        canonicalIri: A,
        version: '1.0.0',
        dependencies: [],
        validator: TOOLCHAIN.validator,
        reasoner: TOOLCHAIN.reasoner,
        files: [{ path: 'ontology.ttl', bytes: '<urn:a> <urn:p> <urn:o> .\n', executable: false }],
    });
}

function registryFixture() {
    const encoded = packageA();
    return makeFixtureDependencyRegistry({
        registryOrigin: REGISTRY,
        aliases: [
            { alias: '@example/a', canonicalIri: A },
            { alias: '@other/a', canonicalIri: A },
        ],
        packages: [
            {
                canonicalIri: A,
                version: '1.0.0',
                archiveSha256: encoded.archiveSha256,
                manifest: encoded.manifest,
                archive: encoded.archiveBytes,
            },
        ],
    });
}

async function createProject(
    manifest: ManifestV1,
    lock = makeEmptyLockfile(manifest, TOOLCHAIN),
    manifestFile = 'erden.config.json',
    manifestFormat: 'json' | 'jsonc' | 'yaml' | 'toml' = 'json',
    manifestPrefix = '',
) {
    const root = makeTestTempRoot('erden-project-dependencies-');
    roots.push(root);
    await fs.writeFile(join(root, manifestFile), `${manifestPrefix}${serializeManifestV1(manifest, manifestFormat)}`, {
        mode: 0o644,
    });
    await fs.writeFile(join(root, 'erden.lock'), serializeLockfileBytes(lock), { mode: 0o644 });
    await fs.writeFile(join(root, 'ontology.ttl'), '<urn:root> <urn:p> <urn:o> .\n', { mode: 0o644 });
    return root;
}

function baseManifest(dependencies: Readonly<Record<string, string>> = {}, registry = true): ManifestV1 {
    return normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/root',
        alias: '@example/root',
        ownedIriPrefixes: ['https://example.test/root#'],
        ...(registry ? { registry: REGISTRY } : {}),
        sources: { ontology: ['ontology.ttl'] },
        dependencies,
    });
}

function fakeInstaller(fail = false) {
    const calls: InstallCommittedStateInput[] = [];
    const service: InstallCommittedStateServiceShape = Object.freeze({
        installCommitted: (input: InstallCommittedStateInput) => {
            calls.push(input);
            if (fail) {
                return Effect.fail(new InstallProjectError('INSTALL_PROJECT_STORE_FAILURE', 'injected store failure'));
            }
            if (input.state.lockInspection.status !== 'available') {
                return Effect.die('missing lock');
            }
            const lock = input.state.lockInspection.lock;
            return Effect.succeed(
                decodeInstallProjectReport({
                    schema: 'erden.install-report/v1',
                    project: {
                        canonicalIri: input.state.project.manifest.canonicalIri,
                        alias: input.state.project.manifest.alias,
                    },
                    mode: { offline: false, frozenLockfile: false },
                    lock: { status: input.lockStatus, cleanup: 'clean', sha256: createHashFor(lock) },
                    packages: {
                        total: lock.packages.length,
                        reused: lock.packages
                            .map(({ archiveSha256 }: { archiveSha256: string }) => archiveSha256)
                            .sort(),
                        fetched: [],
                        repaired: [],
                    },
                    materialization: {
                        status: 'hit',
                        cleanup: 'clean',
                        strategies: { clone: 0, hardlink: 0, copy: 0 },
                    },
                    outcome: 'installed',
                }),
            );
        },
    });
    return { service, calls };
}

function createHashFor(lock: Parameters<typeof serializeLockfileBytes>[0]): string {
    return createHash('sha256').update(serializeLockfileBytes(lock)).digest('hex');
}

describe('ProjectDependencies add/remove lifecycle', () => {
    it('adds through only compact alias and bounded release-page reads', async () => {
        const manifest = baseManifest();
        const root = await createProject(manifest);
        const archive = packageA();
        const calls: string[] = [];
        const index = Object.freeze<RegistryReleaseIndexReaderShape>({
            resolveAlias: (registryOrigin, alias) => {
                calls.push(`alias:${registryOrigin}:${alias}`);
                return Promise.resolve(
                    Object.freeze({
                        schema: 'erden.registry-alias-resolution/v1' as const,
                        registryOrigin,
                        alias,
                        canonicalIri: A,
                    }),
                );
            },
            listPage: (registryOrigin, canonicalIri, cursor) => {
                calls.push(`page:${registryOrigin}:${canonicalIri}:${cursor ?? 'first'}`);
                return Promise.resolve(
                    Object.freeze({
                        schema: 'erden.registry-release-index-page/v1' as const,
                        registryOrigin,
                        canonicalIri,
                        watermark: 'w_1',
                        pageOrdinal: 0,
                        releaseCount: 1,
                        releases: Object.freeze([
                            Object.freeze({
                                version: '1.0.0',
                                archiveSha256: archive.archiveSha256,
                                toolchain: TOOLCHAIN,
                                dependencies: Object.freeze([]),
                            }),
                        ]),
                        nextCursor: null,
                    }),
                );
            },
            getExactRelease: () => Promise.resolve(null),
        });
        const installer = fakeInstaller();
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolverFromReleaseIndex(index),
            installer.service,
        );
        const report = await Effect.runPromise(service.add({ identifier: '@example/a', range: '^1.0.0', from: root }));
        expect(report).toMatchObject({
            operation: 'add',
            resolution: 'full-graph',
            state: { status: 'written' },
            dependency: { canonicalIri: A },
            packageChanges: [{ afterSha256: archive.archiveSha256 }],
        });
        expect(calls).toEqual([`alias:${REGISTRY}:@example/a`, `page:${REGISTRY}:${A}:first`]);
    });

    it('adds through full-graph resolution, commits the pair, then installs it', async () => {
        const manifest = baseManifest();
        const root = await createProject(manifest);
        const registry = registryFixture();
        const installer = fakeInstaller();
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const service = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            installer.service,
        );
        const report = await Effect.runPromise(service.add({ identifier: '@example/a', range: '^1.0.0', from: root }));
        expect(report).toMatchObject({
            operation: 'add',
            resolution: 'full-graph',
            state: { status: 'written' },
            dependency: { identifier: '@example/a', previousRange: null, nextRange: '^1.0.0', canonicalIri: A },
            warnings: ['full-graph-reresolved'],
            outcome: 'installed',
        });
        expect(report.packageChanges).toHaveLength(1);
        expect(installer.calls).toHaveLength(1);
        const current = await Effect.runPromise(states.inspect({ from: root, toolchain: TOOLCHAIN }));
        expect(current.project.manifest.dependencies).toEqual({ '@example/a': '^1.0.0' });
        expect(current.lockInspection.status).toBe('available');
        expect(() =>
            decodeProjectDependenciesReport({ ...report, state: { ...report.state, status: 'unchanged' } }),
        ).toThrow(/contradictory/u);
        const lifecycleBases = [
            {
                resolution: 'existing-lock' as const,
                previousRange: '^1.0.0',
                nextRange: '^1.0.0',
                packageChanges: [] as const,
            },
            {
                resolution: 'full-graph' as const,
                previousRange: null,
                nextRange: '^1.0.0',
                packageChanges: report.packageChanges,
            },
            {
                resolution: 'pruned-exact' as const,
                previousRange: '^1.0.0',
                nextRange: null,
                packageChanges: [
                    {
                        canonicalIri: A,
                        beforeVersion: '1.0.0',
                        beforeSha256: report.packageChanges[0]?.afterSha256 ?? null,
                        afterVersion: null,
                        afterSha256: null,
                    },
                ],
            },
        ];
        for (const base of lifecycleBases) {
            for (const operation of ['add', 'remove'] as const) {
                for (const status of ['unchanged', 'written'] as const) {
                    for (const lockStatus of ['existing', 'written'] as const) {
                        const candidate = {
                            ...report,
                            operation,
                            dependency: {
                                ...report.dependency,
                                previousRange: base.previousRange,
                                nextRange: base.nextRange,
                            },
                            state: { ...report.state, status },
                            resolution: base.resolution,
                            packageChanges: base.packageChanges,
                            installation: {
                                ...report.installation,
                                mode: { offline: false, frozenLockfile: false },
                                lock: { ...report.installation.lock, status: lockStatus },
                            },
                            warnings: base.resolution === 'full-graph' ? ['full-graph-reresolved' as const] : [],
                        };
                        const expected =
                            base.resolution === 'existing-lock'
                                ? operation === 'add' && status === 'unchanged' && lockStatus === 'existing'
                                : base.resolution === 'full-graph'
                                  ? operation === 'add' && status === 'written' && lockStatus === 'written'
                                  : operation === 'remove' && status === 'written' && lockStatus === 'written';
                        if (expected) {
                            expect(decodeProjectDependenciesReport(candidate).resolution).toBe(base.resolution);
                        } else {
                            expect(() => decodeProjectDependenciesReport(candidate)).toThrow(/contradictory/u);
                        }
                    }
                }
            }
        }
        const existing = {
            ...report,
            operation: 'add' as const,
            dependency: { ...report.dependency, previousRange: '^1.0.0', nextRange: '^1.0.0' },
            state: { ...report.state, status: 'unchanged' as const },
            resolution: 'existing-lock' as const,
            packageChanges: [],
            installation: {
                ...report.installation,
                mode: { offline: false, frozenLockfile: false },
                lock: { ...report.installation.lock, status: 'existing' as const },
            },
            warnings: [],
        };
        expect(() =>
            decodeProjectDependenciesReport({
                ...existing,
                dependency: { ...existing.dependency, previousRange: null },
            }),
        ).toThrow(/contradictory/u);
        expect(() =>
            decodeProjectDependenciesReport({ ...existing, dependency: { ...existing.dependency, nextRange: '*' } }),
        ).toThrow(/contradictory/u);
        expect(() => decodeProjectDependenciesReport({ ...existing, packageChanges: report.packageChanges })).toThrow(
            /contradictory/u,
        );
        for (const mode of [
            { offline: true, frozenLockfile: false },
            { offline: false, frozenLockfile: true },
        ]) {
            expect(() =>
                decodeProjectDependenciesReport({
                    ...existing,
                    installation: { ...existing.installation, mode },
                }),
            ).toThrow(/contradictory/u);
        }
        expect(encodeProjectDependenciesReport(report)).toMatch(/^\{"dependency":/u);
    });

    it('updates the full graph through a manifest-preserving paired lock commit', async () => {
        const a1 = packageA();
        const a2 = encodePackage({
            canonicalIri: A,
            version: '2.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:a> <urn:version> "2" .\n', executable: false }],
        });
        function fixture(packages: ReadonlyArray<typeof a1>) {
            return makeFixtureDependencyRegistry({
                registryOrigin: REGISTRY,
                aliases: [{ alias: '@example/a', canonicalIri: A }],
                packages: packages.map((encoded) => ({
                    canonicalIri: encoded.manifest.canonicalIri,
                    version: encoded.manifest.version,
                    archiveSha256: encoded.archiveSha256,
                    manifest: encoded.manifest,
                    archive: encoded.archiveBytes,
                })),
            });
        }
        const manifest = baseManifest({ '@example/a': '*' });
        const oldLock = (
            await Effect.runPromise(makeDependencyResolver(fixture([a1])).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(
            manifest,
            oldLock,
            'erden.config.jsonc',
            'jsonc',
            '// preserved update presentation\n',
        );
        const manifestBefore = await fs.stat(join(root, 'erden.config.jsonc'), { bigint: true });
        const manifestBytes = await fs.readFile(join(root, 'erden.config.jsonc'));
        const installer = fakeInstaller();
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(fixture([a1, a2])),
            installer.service,
        );
        const report = await Effect.runPromise(service.update({ from: root }));
        expect(report).toMatchObject({
            strategy: 'full-graph',
            target: null,
            state: { status: 'written' },
            outcome: 'updated',
        });
        expect(report.packageChanges).toEqual([
            {
                canonicalIri: A,
                beforeVersion: '1.0.0',
                beforeSha256: a1.archiveSha256,
                afterVersion: '2.0.0',
                afterSha256: a2.archiveSha256,
            },
        ]);
        expect(await fs.readFile(join(root, 'erden.config.jsonc'))).toEqual(manifestBytes);
        const manifestAfter = await fs.stat(join(root, 'erden.config.jsonc'), { bigint: true });
        expect([manifestAfter.dev, manifestAfter.ino, manifestAfter.mode]).toEqual([
            manifestBefore.dev,
            manifestBefore.ino,
            manifestBefore.mode,
        ]);
        expect(installer.calls[0]).toMatchObject({ lockStatus: 'written' });
        expect(JSON.parse(encodeProjectDependencyUpdateReport(report))).toMatchObject({ outcome: 'updated' });
        expect(() => decodeProjectDependencyUpdateReport({ ...report, outcome: 'unchanged' })).toThrow(
            /contradictory/u,
        );
        expect(() =>
            decodeProjectDependencyUpdateReport({
                ...report,
                target: { identifier: '@example/a', canonicalIri: A },
            }),
        ).toThrow(/contradictory/u);
        expect(() => decodeProjectDependencyUpdateReport({ ...report, packageChanges: [] })).toThrow(/contradictory/u);
        expect(() =>
            decodeProjectDependencyUpdateReport({
                ...report,
                packageChanges: [
                    {
                        canonicalIri: A,
                        beforeVersion: null,
                        beforeSha256: null,
                        afterVersion: report.packageChanges[0]?.afterVersion ?? null,
                        afterSha256: report.packageChanges[0]?.afterSha256 ?? null,
                    },
                ],
            }),
        ).toThrow(/advance at least one/u);
        expect(() =>
            decodeProjectDependencyUpdateReport({
                ...report,
                packageChanges: [
                    {
                        canonicalIri: A,
                        beforeVersion: report.packageChanges[0]?.beforeVersion ?? null,
                        beforeSha256: report.packageChanges[0]?.beforeSha256 ?? null,
                        afterVersion: null,
                        afterSha256: null,
                    },
                ],
            }),
        ).toThrow(/advance at least one/u);
        expect(() =>
            decodeProjectDependencyUpdateReport({
                ...report,
                installation: {
                    ...report.installation,
                    packages: { total: 0, reused: [], fetched: [], repaired: [] },
                },
            }),
        ).toThrow(/exact identity change/u);
        expect(() =>
            decodeProjectDependencyUpdateReport({
                ...report,
                installation: {
                    ...report.installation,
                    packages: { total: 1, reused: ['f'.repeat(64)], fetched: [], repaired: [] },
                },
            }),
        ).toThrow(/exact identity change/u);
        expect(() =>
            decodeProjectDependencyUpdateReport({
                ...report,
                packageChanges: [
                    {
                        ...report.packageChanges[0],
                        beforeVersion: '3.0.0',
                        beforeSha256: 'f'.repeat(64),
                    },
                ],
            }),
        ).toThrow(/exact identity change/u);
        const exactAdvancement = report.packageChanges[0];
        expect(exactAdvancement).toBeDefined();
        if (exactAdvancement === undefined) {
            throw new TypeError('expected one exact package advancement');
        }
        const addedDigest = 'e'.repeat(64);
        expect(
            decodeProjectDependencyUpdateReport({
                ...report,
                packageChanges: [
                    exactAdvancement,
                    {
                        canonicalIri: 'https://example.test/b',
                        beforeVersion: null,
                        beforeSha256: null,
                        afterVersion: '1.0.0',
                        afterSha256: addedDigest,
                    },
                ],
                installation: {
                    ...report.installation,
                    packages: {
                        total: 2,
                        reused: [...report.installation.packages.reused, addedDigest].sort(),
                        fetched: [],
                        repaired: [],
                    },
                },
            }).packageChanges,
        ).toHaveLength(2);
        expect(
            decodeProjectDependencyUpdateReport({
                ...report,
                packageChanges: [
                    exactAdvancement,
                    {
                        canonicalIri: 'https://example.test/b',
                        beforeVersion: '1.0.0',
                        beforeSha256: 'd'.repeat(64),
                        afterVersion: null,
                        afterSha256: null,
                    },
                ],
            }).packageChanges,
        ).toHaveLength(2);
        const targetedReport = decodeProjectDependencyUpdateReport({
            ...report,
            strategy: 'targeted-frozen',
            target: { identifier: '@example/a', canonicalIri: A },
        });
        expect(targetedReport.strategy).toBe('targeted-frozen');
        expect(() =>
            decodeProjectDependencyUpdateReport({
                ...targetedReport,
                packageChanges: [
                    {
                        ...targetedReport.packageChanges[0],
                        beforeVersion: targetedReport.packageChanges[0]?.afterVersion,
                        beforeSha256: 'f'.repeat(64),
                    },
                ],
            }),
        ).toThrow(/exact identity change/u);
        expect(() =>
            decodeProjectDependencyUpdateReport(
                new Proxy(report, {
                    get: () => {
                        throw new Error('D:/private/update-report');
                    },
                }),
            ),
        ).toThrow(/dependency-update report/u);
    });

    it('heals an unchanged exact target without a state write and requires its authored key exactly', async () => {
        const manifest = baseManifest({ '@example/a': '*' });
        const registry = registryFixture();
        const lock = (
            await Effect.runPromise(makeDependencyResolver(registry).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, lock);
        const beforeManifest = await fs.stat(join(root, 'erden.config.json'), { bigint: true });
        const beforeLock = await fs.stat(join(root, 'erden.lock'), { bigint: true });
        const installer = fakeInstaller();
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            installer.service,
        );
        const report = await Effect.runPromise(service.update({ identifier: '@example/a', from: root }));
        expect(report).toMatchObject({
            strategy: 'targeted-frozen',
            target: { identifier: '@example/a', canonicalIri: A },
            state: { status: 'unchanged' },
            packageChanges: [],
            outcome: 'unchanged',
        });
        const afterManifest = await fs.stat(join(root, 'erden.config.json'), { bigint: true });
        const afterLock = await fs.stat(join(root, 'erden.lock'), { bigint: true });
        expect([afterManifest.dev, afterManifest.ino, afterLock.dev, afterLock.ino]).toEqual([
            beforeManifest.dev,
            beforeManifest.ino,
            beforeLock.dev,
            beforeLock.ino,
        ]);
        expect(installer.calls[0]).toMatchObject({ lockStatus: 'existing' });
        await expect(Effect.runPromise(service.update({ identifier: A, from: root }))).rejects.toMatchObject({
            code: 'PROJECT_DEPENDENCIES_NOT_FOUND',
        });
    });

    it('maps frozen resolver conflicts to bounded update diagnostics and preserves the pair', async () => {
        const manifest = baseManifest({ '@example/a': '*' });
        const registry = registryFixture();
        const lock = (
            await Effect.runPromise(makeDependencyResolver(registry).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, lock);
        const manifestBytes = await fs.readFile(join(root, 'erden.config.json'));
        const lockBytes = await fs.readFile(join(root, 'erden.lock'));
        const resolver = Object.freeze({
            resolve: () =>
                Effect.fail(
                    new DependencyResolutionError('frozen-shared-conflict', 'injected', undefined, undefined, [A]),
                ),
        });
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            resolver,
            fakeInstaller().service,
        );
        const failure = await Effect.runPromise(
            service.update({ identifier: '@example/a', from: root }).pipe(Effect.flip),
        );
        expect(failure).toMatchObject({
            code: 'PROJECT_DEPENDENCIES_UPDATE_FROZEN_CONFLICT',
            frozenCanonicalIris: [A],
        });
        expect(renderProjectDependencyUpdateError(failure)).toContain(`Frozen shared package: ${A}`);
        expect(await fs.readFile(join(root, 'erden.config.json'))).toEqual(manifestBytes);
        expect(await fs.readFile(join(root, 'erden.lock'))).toEqual(lockBytes);
    });

    it('updates an empty closure without catalog access and retains a changed lock after install failure', async () => {
        const emptyManifest = baseManifest({}, false);
        const emptyRoot = await createProject(emptyManifest);
        const untouchedRegistry = {
            resolveAlias: () => Promise.reject(new Error('empty update must not resolve aliases')),
            listPublished: () => Promise.reject(new Error('empty update must not list releases')),
        };
        const emptyInstaller = fakeInstaller();
        const emptyService = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(untouchedRegistry),
            emptyInstaller.service,
        );
        await expect(Effect.runPromise(emptyService.update({ from: emptyRoot }))).resolves.toMatchObject({
            strategy: 'full-graph',
            state: { status: 'unchanged' },
            outcome: 'unchanged',
        });
        expect(emptyInstaller.calls).toHaveLength(1);

        const a1 = packageA();
        const a2 = encodePackage({
            canonicalIri: A,
            version: '2.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:a> <urn:version> "2" .\n', executable: false }],
        });
        function fixture(packages: ReadonlyArray<typeof a1>) {
            return makeFixtureDependencyRegistry({
                registryOrigin: REGISTRY,
                aliases: [{ alias: '@example/a', canonicalIri: A }],
                packages: packages.map((encoded) => ({
                    canonicalIri: encoded.manifest.canonicalIri,
                    version: encoded.manifest.version,
                    archiveSha256: encoded.archiveSha256,
                    manifest: encoded.manifest,
                    archive: encoded.archiveBytes,
                })),
            });
        }
        const manifest = baseManifest({ '@example/a': '*' });
        const oldLock = (
            await Effect.runPromise(makeDependencyResolver(fixture([a1])).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, oldLock);
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(fixture([a1, a2])),
            fakeInstaller(true).service,
        );
        const committedFailure = await Effect.runPromise(service.update({ from: root }).pipe(Effect.flip));
        expect(committedFailure).toBeInstanceOf(ProjectDependenciesCommittedError);
        expect(committedFailure).toMatchObject({ code: 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED' });
        const committed = (committedFailure as ProjectDependenciesCommittedError).committed;
        expect(committed.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(committed.lockSha256).toMatch(/^[0-9a-f]{64}$/u);
        const current = await Effect.runPromise(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()).inspect({
                from: root,
                toolchain: TOOLCHAIN,
            }),
        );
        expect(
            current.lockInspection.status === 'available' ? current.lockInspection.lock.packages[0]?.version : null,
        ).toBe('2.0.0');
        expect(current.project.manifest.dependencies).toEqual({ '@example/a': '*' });
    });

    it.each([
        ['erden.config.json', 'json'],
        ['erden.config.jsonc', 'jsonc'],
        ['erden.config.yml', 'yaml'],
        ['erden.config.yaml', 'yaml'],
        ['erden.config.toml', 'toml'],
    ] as const)('rewrites dependency intent canonically in %s', async (manifestFile, manifestFormat) => {
        const manifest = baseManifest();
        const prefix = manifestFormat === 'jsonc' ? '// this presentation is intentionally replaced\n' : '';
        const root = await createProject(
            manifest,
            makeEmptyLockfile(manifest, TOOLCHAIN),
            manifestFile,
            manifestFormat,
            prefix,
        );
        const registry = registryFixture();
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            fakeInstaller().service,
        );
        const report = await Effect.runPromise(service.add({ identifier: '@example/a', range: '*', from: root }));
        const expected = baseManifest({ '@example/a': '*' });
        expect(await fs.readFile(join(root, manifestFile), 'utf8')).toBe(serializeManifestV1(expected, manifestFormat));
        expect(report.state.manifestFormat).toBe(manifestFormat);
        expect(report.warnings).toEqual(
            manifestFormat === 'jsonc'
                ? ['full-graph-reresolved', 'jsonc-presentation-lost']
                : ['full-graph-reresolved'],
        );
    });

    it('heals an exact existing pair without resolution or state writes', async () => {
        const manifest = baseManifest({ '@example/a': '^1.0.0' });
        const registry = registryFixture();
        const lock = (
            await Effect.runPromise(makeDependencyResolver(registry).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, lock);
        registry.clearTrace();
        const beforeManifest = await fs.stat(join(root, 'erden.config.json'), { bigint: true });
        const beforeLock = await fs.stat(join(root, 'erden.lock'), { bigint: true });
        const installer = fakeInstaller();
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            installer.service,
        );
        const report = await Effect.runPromise(service.add({ identifier: '@example/a', range: '^1.0.0', from: root }));
        expect(report).toMatchObject({
            state: { status: 'unchanged' },
            resolution: 'existing-lock',
            packageChanges: [],
        });
        expect(registry.trace()).toEqual([]);
        const afterManifest = await fs.stat(join(root, 'erden.config.json'), { bigint: true });
        const afterLock = await fs.stat(join(root, 'erden.lock'), { bigint: true });
        expect([afterManifest.dev, afterManifest.ino, afterLock.dev, afterLock.ino]).toEqual([
            beforeManifest.dev,
            beforeManifest.ino,
            beforeLock.dev,
            beforeLock.ino,
        ]);
        expect(installer.calls).toHaveLength(1);
    });

    it('visibly reports unrelated exact-version changes from deliberate full-graph resolution', async () => {
        function encoded(canonicalIri: string, version: string) {
            return encodePackage({
                canonicalIri,
                version,
                dependencies: [],
                validator: TOOLCHAIN.validator,
                reasoner: TOOLCHAIN.reasoner,
                files: [
                    {
                        path: 'ontology.ttl',
                        bytes: `<${canonicalIri}> <urn:version> "${version}" .\n`,
                        executable: false,
                    },
                ],
            });
        }
        const a1 = encoded(A, '1.0.0');
        const a2 = encoded(A, '2.0.0');
        const b1 = encoded('https://example.test/b', '1.0.0');
        function registry(
            packages: ReadonlyArray<typeof a1>,
            aliases: ReadonlyArray<{
                alias: string;
                canonicalIri: string;
            }>,
        ) {
            return makeFixtureDependencyRegistry({
                registryOrigin: REGISTRY,
                aliases,
                packages: packages.map((item) => ({
                    canonicalIri: item.manifest.canonicalIri,
                    version: item.manifest.version,
                    archiveSha256: item.archiveSha256,
                    manifest: item.manifest,
                    archive: item.archiveBytes,
                })),
            });
        }
        const manifest = baseManifest({ '@example/a': '*' });
        const oldRegistry = registry([a1], [{ alias: '@example/a', canonicalIri: A }]);
        const oldLock = (
            await Effect.runPromise(makeDependencyResolver(oldRegistry).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, oldLock);
        const currentRegistry = registry(
            [a1, a2, b1],
            [
                { alias: '@example/a', canonicalIri: A },
                { alias: '@example/b', canonicalIri: 'https://example.test/b' },
            ],
        );
        const installer = fakeInstaller();
        const service = makeProjectDependenciesService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(currentRegistry),
            installer.service,
        );
        const report = await Effect.runPromise(service.add({ identifier: '@example/b', range: '*', from: root }));
        expect(report.packageChanges).toEqual([
            {
                canonicalIri: A,
                beforeVersion: '1.0.0',
                beforeSha256: a1.archiveSha256,
                afterVersion: '2.0.0',
                afterSha256: a2.archiveSha256,
            },
            {
                canonicalIri: 'https://example.test/b',
                beforeVersion: null,
                beforeSha256: null,
                afterVersion: '1.0.0',
                afterSha256: b1.archiveSha256,
            },
        ]);
        expect(report.resolution).toBe('full-graph');
        expect(report.warnings).toContain('full-graph-reresolved');
    });

    it('rejects missing registry and duplicate canonical authorship before mutation', async () => {
        const noRegistry = baseManifest({}, false);
        const root = await createProject(noRegistry);
        const registry = registryFixture();
        const installer = fakeInstaller();
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const service = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            installer.service,
        );
        await expect(
            Effect.runPromise(service.add({ identifier: '@example/a', range: '*', from: root })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCIES_REGISTRY_REQUIRED' });
        expect(
            (await Effect.runPromise(states.inspect({ from: root, toolchain: TOOLCHAIN }))).project.manifest
                .dependencies,
        ).toEqual({});

        const configured = baseManifest();
        const configuredRoot = await createProject(configured);
        const unavailable = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(unavailableDependencyRegistry),
            installer.service,
        );
        await expect(
            Effect.runPromise(unavailable.add({ identifier: '@example/a', range: '*', from: configuredRoot })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCIES_REGISTRY_UNAVAILABLE' });
        expect(
            (await Effect.runPromise(states.inspect({ from: configuredRoot, toolchain: TOOLCHAIN }))).project.manifest
                .dependencies,
        ).toEqual({});

        const directManifest = baseManifest({ [A]: '*' });
        const directLock = (
            await Effect.runPromise(
                makeDependencyResolver(registry).resolve({ manifest: directManifest, toolchain: TOOLCHAIN }),
            )
        ).lock;
        const directRoot = await createProject(directManifest, directLock);
        await expect(
            Effect.runPromise(service.add({ identifier: '@other/a', range: '*', from: directRoot })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCIES_DUPLICATE_CANONICAL' });
        expect(
            (await Effect.runPromise(states.inspect({ from: directRoot, toolchain: TOOLCHAIN }))).project.manifest
                .dependencies,
        ).toEqual({ [A]: '*' });
    });

    it('removes by exact key without resolver calls and prunes the exact lock graph', async () => {
        const manifest = baseManifest({ '@example/a': '^1.0.0' });
        const registry = registryFixture();
        const lock = (
            await Effect.runPromise(makeDependencyResolver(registry).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, lock);
        registry.clearTrace();
        const installer = fakeInstaller();
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const service = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            {
                resolve: () => Effect.die('remove must not resolve'),
            },
            installer.service,
        );
        const report = await Effect.runPromise(service.remove({ identifier: '@example/a', from: root }));
        expect(report).toMatchObject({
            operation: 'remove',
            resolution: 'pruned-exact',
            dependency: { canonicalIri: A },
        });
        const current = await Effect.runPromise(states.inspect({ from: root, toolchain: TOOLCHAIN }));
        expect(current.project.manifest.dependencies).toEqual({});
        expect(current.lockInspection.status === 'available' ? current.lockInspection.lock.packages : null).toEqual([]);
        expect(registry.trace()).toEqual([]);
    });

    it('keeps compact registry transport out of remove and update when retained archives are missing', async () => {
        const B = 'https://example.test/b';
        const currentToolchain = Effect.runSync(nodeCurrentToolchainService.inspect());
        const encodedA = encodePackage({
            canonicalIri: A,
            version: '1.0.0',
            dependencies: [],
            validator: currentToolchain.validator,
            reasoner: currentToolchain.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:a> <urn:p> <urn:o> .\n', executable: false }],
        });
        const encodedB = encodePackage({
            canonicalIri: B,
            version: '1.0.0',
            dependencies: [],
            validator: currentToolchain.validator,
            reasoner: currentToolchain.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:b> <urn:p> <urn:o> .\n', executable: false }],
        });
        const registry = makeFixtureDependencyRegistry({
            registryOrigin: REGISTRY,
            aliases: [
                { alias: '@example/a', canonicalIri: A },
                { alias: '@example/b', canonicalIri: B },
            ],
            packages: [encodedA, encodedB].map((encoded) => ({
                canonicalIri: encoded.manifest.canonicalIri,
                version: encoded.manifest.version,
                archiveSha256: encoded.archiveSha256,
                manifest: encoded.manifest,
                archive: encoded.archiveBytes,
            })),
        });
        const initialManifest = baseManifest({ '@example/a': '*', '@example/b': '*' });
        const initialLock = (
            await Effect.runPromise(
                makeDependencyResolver(registry).resolve({ manifest: initialManifest, toolchain: currentToolchain }),
            )
        ).lock;
        const root = await createProject(initialManifest, initialLock);
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        expect(
            (await Effect.runPromise(states.inspect({ from: root, toolchain: currentToolchain }))).lockInspection,
        ).toMatchObject({ status: 'available' });
        const storeRoot = join(root, 'missing-store');
        const calls = { compact: 0, archive: 0 };
        const index = Object.freeze<RegistryReleaseIndexReaderShape>({
            resolveAlias: () => {
                calls.compact += 1;
                return Promise.reject(new Error('remove/update must not resolve aliases'));
            },
            listPage: () => {
                calls.compact += 1;
                return Promise.reject(new Error('remove/update must not list release pages'));
            },
            getExactRelease: () => {
                calls.compact += 1;
                return Promise.reject(new Error('remove/update must not read exact releases'));
            },
        });
        const archives = Object.freeze<DependencyArchiveReaderShape>({
            fetchArchive: () => {
                calls.archive += 1;
                return Promise.reject(new Error('remove/update must not download archives'));
            },
        });
        const service = makeNodeProjectDependenciesServiceFromReleaseIndex(index, archives);

        const removeFailure = await Effect.runPromise(
            service
                .remove({
                    identifier: '@example/a',
                    from: root,
                    storeRoot,
                })
                .pipe(Effect.flip),
        );
        expect(removeFailure).toBeInstanceOf(ProjectDependenciesCommittedError);
        expect(removeFailure).toMatchObject({ code: 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED' });
        expect(renderProjectDependenciesError(removeFailure)).toContain('run erden install');
        expect(Object.isFrozen(removeFailure)).toBe(true);
        expect(calls).toEqual({ compact: 0, archive: 0 });

        const expectedManifest = baseManifest({ '@example/b': '*' });
        const expectedLock = (
            await Effect.runPromise(
                makeDependencyResolver(registry).resolve({ manifest: expectedManifest, toolchain: currentToolchain }),
            )
        ).lock;
        const expectedManifestBytes = Buffer.from(serializeManifestV1(expectedManifest, 'json'));
        const expectedLockBytes = Buffer.from(serializeLockfileBytes(expectedLock));
        expect(await fs.readFile(join(root, 'erden.config.json'))).toEqual(expectedManifestBytes);
        expect(await fs.readFile(join(root, 'erden.lock'))).toEqual(expectedLockBytes);
        expect((removeFailure as ProjectDependenciesCommittedError).committed).toEqual({
            manifestSha256: createHash('sha256').update(expectedManifestBytes).digest('hex'),
            lockSha256: createHash('sha256').update(expectedLockBytes).digest('hex'),
        });

        const updateFailure = await Effect.runPromise(service.update({ from: root, storeRoot }).pipe(Effect.flip));
        expect(updateFailure).toMatchObject({ code: 'PROJECT_DEPENDENCIES_REGISTRY_UNAVAILABLE' });
        expect(calls).toEqual({ compact: 0, archive: 0 });
        expect(await fs.readFile(join(root, 'erden.config.json'))).toEqual(expectedManifestBytes);
        expect(await fs.readFile(join(root, 'erden.lock'))).toEqual(expectedLockBytes);
    });

    it('resolves a canonical remove only when uniquely authored and rechecks planning failures', async () => {
        const manifest = baseManifest({ '@example/a': '*', '@other/a': '*' });
        const registry = registryFixture();
        const lock = (
            await Effect.runPromise(makeDependencyResolver(registry).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, lock);
        const base = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        let rechecks = 0;
        const states = Object.freeze({
            inspect: base.inspect,
            write: base.write,
            recheck: (input: Parameters<typeof base.recheck>[0]) => {
                rechecks += 1;
                return base.recheck(input);
            },
        });
        const service = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            {
                resolve: () => Effect.die('remove must not resolve'),
            },
            fakeInstaller().service,
        );
        await expect(Effect.runPromise(service.remove({ identifier: A, from: root }))).rejects.toMatchObject({
            code: 'PROJECT_DEPENDENCIES_AMBIGUOUS_IDENTIFIER',
        });
        await expect(
            Effect.runPromise(service.remove({ identifier: '@example/missing', from: root })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCIES_NOT_FOUND' });
        expect(rechecks).toBe(2);
        expect(
            (await Effect.runPromise(base.inspect({ from: root, toolchain: TOOLCHAIN }))).project.manifest.dependencies,
        ).toEqual({ '@example/a': '*', '@other/a': '*' });
    });

    it('closes hostile options and injected install reports at the application boundary', async () => {
        const manifest = baseManifest();
        const root = await createProject(manifest);
        const registry = registryFixture();
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        let getterReads = 0;
        const hostileOptions = Object.defineProperty({}, 'identifier', {
            enumerable: true,
            get: () => {
                getterReads += 1;
                throw new Error('D:/private/options');
            },
        });
        const service = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            fakeInstaller().service,
        );
        const optionFailure = await Effect.runPromise(service.remove(hostileOptions as never).pipe(Effect.flip));
        expect(optionFailure).toMatchObject({ code: 'PROJECT_DEPENDENCIES_INVALID_INPUT' });
        expect(getterReads).toBe(0);
        expect(renderProjectDependenciesError(optionFailure)).not.toContain('D:/private');
        const updateOptionFailure = await Effect.runPromise(service.update(hostileOptions as never).pipe(Effect.flip));
        expect(updateOptionFailure).toMatchObject({ code: 'PROJECT_DEPENDENCIES_INVALID_INPUT' });
        expect(getterReads).toBe(0);
        expect(renderProjectDependencyUpdateError(updateOptionFailure)).not.toContain('D:/private');
        expect(
            renderProjectDependenciesError(
                new Proxy(optionFailure, {
                    getPrototypeOf: () => {
                        throw new Error('D:/private/error');
                    },
                }),
            ),
        ).toBe(
            'Erden dependency change failed [PROJECT_DEPENDENCIES_STATE_UNAVAILABLE]: The project dependency change could not complete\n',
        );

        const hostileInstaller: InstallCommittedStateServiceShape = Object.freeze({
            installCommitted: () =>
                Effect.succeed(
                    new Proxy(
                        {},
                        {
                            getPrototypeOf: () => {
                                throw new Error('D:/private/install-report');
                            },
                        },
                    ) as never,
                ),
        });
        const hostileService = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            hostileInstaller,
        );
        const committedFailure = await Effect.runPromise(
            hostileService.add({ identifier: '@example/a', range: '*', from: root }).pipe(Effect.flip),
        );
        expect(committedFailure).toMatchObject({ code: 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED' });
        expect(renderProjectDependenciesError(committedFailure)).not.toContain('D:/private');
        expect(
            (await Effect.runPromise(states.inspect({ from: root, toolchain: TOOLCHAIN }))).project.manifest
                .dependencies,
        ).toEqual({ '@example/a': '*' });
    });

    it('uses typed not-found and retains a committed pair when installation fails', async () => {
        const manifest = baseManifest({ '@example/a': '^1.0.0' });
        const registry = registryFixture();
        const lock = (
            await Effect.runPromise(makeDependencyResolver(registry).resolve({ manifest, toolchain: TOOLCHAIN }))
        ).lock;
        const root = await createProject(manifest, lock);
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const failing = fakeInstaller(true);
        const service = makeProjectDependenciesService(
            states,
            makeCurrentToolchainService(() => TOOLCHAIN),
            makeDependencyResolver(registry),
            failing.service,
        );
        await expect(
            Effect.runPromise(service.remove({ identifier: '@example/missing', from: root })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCIES_NOT_FOUND' });
        const failure = await Effect.runPromise(
            service.remove({ identifier: '@example/a', from: root }).pipe(Effect.flip),
        );
        expect(failure).toMatchObject({ code: 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED' });
        expect(renderProjectDependenciesError(failure)).toContain('run erden install');
        const current = await Effect.runPromise(states.inspect({ from: root, toolchain: TOOLCHAIN }));
        expect(current.project.manifest.dependencies).toEqual({});
        expect(Object.isFrozen(failure)).toBe(true);
    });
});
