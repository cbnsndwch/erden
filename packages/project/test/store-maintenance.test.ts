import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    decodeLockfileValue,
    makeCurrentToolchainService,
    makeEmptyLockfile,
    manifestDependencyProjectionSha256,
    normalizeManifestV1,
    serializeLockfileBytes,
    serializeManifestV1,
    type LockToolchain,
} from '@erden/contracts';
import { encodePackage } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    decodeStoreStatusReport,
    decodeStorePruneReport,
    decodeStoreAdminMarker,
    encodeStorePruneReport,
    encodeStoreStatusReport,
    encodeStoreAdminMarker,
    makeLocalPackageStore,
    makeNodeStoreFileSystemPort,
    makeNodeProjectDependencyStateFileSystemPort,
    makeProjectDependencyStateService,
    makeStoreMaintenanceService,
    renderStoreStatusReport,
    StoreMaintenanceError,
    STORE_PRUNE_REACQUISITION_WARNING,
    type StoreIndexInspection,
    type StoreAdminMarker,
} from '../src/index.js';
import {
    buildStoreProjectReferenceMarker,
    encodeStoreProjectReferenceMarker,
    storeProjectReferenceGenerationSha256,
} from '../src/store/marker.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: digest('a') }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: digest('b') }),
});

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

async function projectFixture(root: string) {
    const manifest = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/status-project',
        alias: '@example/status-project',
        ownedIriPrefixes: ['https://example.test/status-project#'],
        dependencies: {},
        sources: { ontology: ['ontology.ttl'] },
    });
    const manifestBytes = new TextEncoder().encode(serializeManifestV1(manifest, 'json'));
    const lock = makeEmptyLockfile(manifest, TOOLCHAIN);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, 'erden.config.json'), manifestBytes, { mode: 0o644 });
    await fs.writeFile(join(root, 'erden.lock'), serializeLockfileBytes(lock), { mode: 0o644 });
    await fs.writeFile(join(root, 'ontology.ttl'), '<urn:s> <urn:p> <urn:o> .\n');
    return { manifest, manifestBytes, lock };
}

async function treeSnapshot(root: string): Promise<string> {
    const entries: string[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
        const names = (await fs.readdir(directory)).sort();
        for (const name of names) {
            const path = join(directory, name);
            const logical = prefix.length === 0 ? name : `${prefix}/${name}`;
            const stats = await fs.lstat(path, { bigint: true });
            if (stats.isDirectory()) {
                entries.push(`${logical}:d:${stats.mode.toString(10)}`);
                await walk(path, logical);
            } else {
                entries.push(
                    `${logical}:f:${stats.mode.toString(10)}:${createHash('sha256')
                        .update(await fs.readFile(path))
                        .digest('hex')}`,
                );
            }
        }
    }
    await walk(root, '');
    return entries.join('\n');
}

async function twoGenerationFixture(root: string) {
    const projectRoot = join(root, 'project');
    const storeRoot = join(root, 'store');
    const fixture = await projectFixture(projectRoot);
    const store = makeLocalPackageStore();
    const first = await Effect.runPromise(
        store.refreshProjectReference({
            storeRoot,
            projectRoot,
            manifestPath: join(projectRoot, 'erden.config.json'),
            manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
            lock: fixture.lock,
        }),
    );
    await fs.appendFile(join(projectRoot, 'erden.config.json'), '\n');
    const secondManifestBytes = await fs.readFile(join(projectRoot, 'erden.config.json'));
    const second = await Effect.runPromise(
        store.refreshProjectReference({
            storeRoot,
            projectRoot,
            manifestPath: join(projectRoot, 'erden.config.json'),
            manifestSha256: createHash('sha256').update(secondManifestBytes).digest('hex'),
            lock: fixture.lock,
        }),
    );
    return { projectRoot, storeRoot, store, first, second };
}

describe('StoreMaintenance', () => {
    it('reports a missing empty store without resolving toolchain or creating filesystem state', async () => {
        const root = makeTestTempRoot('erden-store-status-missing-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        let toolchainCalls = 0;
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => {
                toolchainCalls += 1;
                throw new Error('toolchain must remain dormant');
            }),
            makeLocalPackageStore(),
            { defaultStoreRoot: () => storeRoot },
        );
        const report = await Effect.runPromise(service.status());
        expect(report).toMatchObject({ store: 'missing', transaction: 'idle', outcome: 'healthy' });
        expect(toolchainCalls).toBe(0);
        await expect(fs.access(storeRoot)).rejects.toBeDefined();
    });

    it('reports a real empty-store prune as a decoded non-dry no-op without mutation or prune delegation', async () => {
        const root = makeTestTempRoot('erden-store-prune-empty-real-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const normalStore = makeLocalPackageStore();
        let pruneCalls = 0;
        const guardedStore = Object.freeze({
            ...normalStore,
            pruneStore: (input: Parameters<typeof normalStore.pruneStore>[0]) => {
                pruneCalls += 1;
                return normalStore.pruneStore(input);
            },
        });
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => {
                throw new Error('toolchain must remain dormant');
            }),
            guardedStore,
            { defaultStoreRoot: () => storeRoot },
        );
        const before = await treeSnapshot(root);
        const report = await Effect.runPromise(service.prune({}));
        expect(report).toMatchObject({ dryRun: false, outcome: 'nothing-to-prune' });
        expect(decodeStorePruneReport(JSON.parse(encodeStorePruneReport(report)))).toEqual(report);
        expect(pruneCalls).toBe(0);
        expect(await treeSnapshot(root)).toBe(before);
        await expect(fs.access(storeRoot)).rejects.toBeDefined();
    });

    it('publishes one immutable registration generation and reports the authenticated project current', async () => {
        const root = makeTestTempRoot('erden-store-status-current-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const store = makeLocalPackageStore();
        const input = {
            storeRoot,
            projectRoot,
            manifestPath: join(projectRoot, 'erden.config.json'),
            manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
            lock: fixture.lock,
        };
        const first = await Effect.runPromise(store.refreshProjectReference(input));
        const second = await Effect.runPromise(store.refreshProjectReference(input));
        expect(first.status).toBe('registered');
        expect(second).toEqual({ ...first, status: 'hit' });
        const index = await Effect.runPromise(store.inspectStoreIndex({ storeRoot }));
        expect(index).toMatchObject({ store: 'available', transaction: 'idle' });
        expect(index.registrations).toHaveLength(1);
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            store,
            { defaultStoreRoot: () => storeRoot },
        );
        const report = await Effect.runPromise(service.status());
        expect(report.outcome).toBe('healthy');
        expect(report.registrations.current).toEqual([
            {
                registrationId: first.registrationId,
                generationSha256: first.generationSha256,
                project: { canonicalIri: fixture.manifest.canonicalIri, alias: fixture.manifest.alias },
                lockSha256: first.lockSha256,
                packages: 0,
            },
        ]);
        expect(report.objects).toMatchObject({ total: 0, referenced: [], unreferenced: [], logicalBytes: '0' });
        expect(Object.isFrozen(report)).toBe(true);
        expect(Object.isFrozen(report.registrations.current)).toBe(true);
        expect(decodeStoreStatusReport(JSON.parse(encodeStoreStatusReport(report)))).toEqual(report);
        expect(renderStoreStatusReport(report)).toContain('Erden store: healthy');
    });

    it.each(['moved', 'same-byte-substitution'] as const)(
        'rejects a registration hit whose final generation is %s during terminal authentication',
        async (mutation) => {
            const root = makeTestTempRoot('erden-store-registration-hit-race-');
            roots.push(root);
            const projectRoot = join(root, 'project');
            const storeRoot = join(root, 'store');
            const fixture = await projectFixture(projectRoot);
            const input = {
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            };
            const normalStore = makeLocalPackageStore();
            const registered = await Effect.runPromise(normalStore.refreshProjectReference(input));
            const registrationsRoot = join(storeRoot, 'registrations');
            const finalPath = join(
                registrationsRoot,
                `${registered.registrationId}.${registered.generationSha256}.json`,
            );
            const heldPath = join(root, `held-${mutation}.json`);
            const base = makeNodeStoreFileSystemPort().operations;
            let scans = 0;
            let injected = false;
            const racingStore = makeLocalPackageStore(
                makeNodeStoreFileSystemPort({
                    opendir: async (path, options) => {
                        if (path.toString() === registrationsRoot && ++scans === 3) {
                            injected = true;
                            const bytes = await fs.readFile(finalPath);
                            await fs.rename(finalPath, heldPath);
                            if (mutation === 'same-byte-substitution') {
                                await fs.writeFile(finalPath, bytes, { flag: 'wx', mode: 0o444 });
                                await fs.chmod(finalPath, 0o444);
                            }
                        }
                        return await base.opendir(path, options);
                    },
                }),
            );
            const failure = await Effect.runPromise(racingStore.refreshProjectReference(input).pipe(Effect.flip));
            expect(injected).toBe(true);
            expect(failure).toMatchObject({ code: 'STORE_REFERENCE_INVALID' });
        },
    );

    it('rejects a competing valid registration head that arrives during terminal hit authentication', async () => {
        const root = makeTestTempRoot('erden-store-registration-head-race-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const input = {
            storeRoot,
            projectRoot,
            manifestPath: join(projectRoot, 'erden.config.json'),
            manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
            lock: fixture.lock,
        };
        const normalStore = makeLocalPackageStore();
        const registered = await Effect.runPromise(normalStore.refreshProjectReference(input));
        const competitor = buildStoreProjectReferenceMarker({
            registrationId: registered.registrationId,
            pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
            previous: null,
            projectRoot,
            manifestPath: input.manifestPath,
            project: fixture.lock.root,
            manifestSha256: digest('f'),
            lock: fixture.lock,
        });
        const competitorBytes = encodeStoreProjectReferenceMarker(competitor);
        const competitorGeneration = storeProjectReferenceGenerationSha256(competitor);
        const registrationsRoot = join(storeRoot, 'registrations');
        const competitorPath = join(registrationsRoot, `${registered.registrationId}.${competitorGeneration}.json`);
        const base = makeNodeStoreFileSystemPort().operations;
        let scans = 0;
        let injected = false;
        const racingStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                opendir: async (path, options) => {
                    if (path.toString() === registrationsRoot && ++scans === 2) {
                        injected = true;
                        await fs.writeFile(competitorPath, competitorBytes, { flag: 'wx', mode: 0o444 });
                        await fs.chmod(competitorPath, 0o444);
                    }
                    return await base.opendir(path, options);
                },
            }),
        );
        const failure = await Effect.runPromise(racingStore.refreshProjectReference(input).pipe(Effect.flip));
        expect(injected).toBe(true);
        expect(failure).toMatchObject({ code: 'STORE_REFERENCE_INVALID' });
    });

    it.each(['registration-stage', 'fixed-marker'] as const)(
        'rejects a same-byte replacement of interrupted %s evidence',
        async (target) => {
            const root = makeTestTempRoot('erden-store-registration-recovery-substitution-');
            roots.push(root);
            const projectRoot = join(root, 'project');
            const storeRoot = join(root, 'store');
            const fixture = await projectFixture(projectRoot);
            const input = {
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            };
            const base = makeNodeStoreFileSystemPort().operations;
            const interruptedStore = makeLocalPackageStore(
                makeNodeStoreFileSystemPort({
                    link: async (source, destination) => {
                        if (basename(destination.toString()) !== '.erden.store-admin.transaction.json') {
                            throw Object.assign(new Error('injected publication interruption'), { code: 'EIO' });
                        }
                        await base.link(source, destination);
                    },
                }),
            );
            await expect(Effect.runPromise(interruptedStore.refreshProjectReference(input))).rejects.toMatchObject({
                code: 'STORE_ROLLBACK_UNSAFE',
            });
            const targetPath =
                target === 'fixed-marker'
                    ? join(storeRoot, '.erden.store-admin.transaction.json')
                    : join(
                          storeRoot,
                          'registrations',
                          (await fs.readdir(join(storeRoot, 'registrations'))).find((name) =>
                              name.includes('.stage-'),
                          ) as string,
                      );
            const held = join(root, `${target}.held`);
            const bytes = await fs.readFile(targetPath);
            await fs.rename(targetPath, held);
            await fs.writeFile(targetPath, bytes, { flag: 'wx', mode: 0o444 });
            await fs.chmod(targetPath, 0o444);
            const failure = await Effect.runPromise(
                makeLocalPackageStore().refreshProjectReference(input).pipe(Effect.flip),
            );
            expect(failure).toMatchObject({ code: 'STORE_ROLLBACK_UNSAFE' });
            expect(await fs.readFile(targetPath)).toEqual(bytes);
        },
    );

    it.each(['registration-stage', 'admin-stage', 'fixed-marker'] as const)(
        'reconciles %s removal that completes and then throws during registration publication',
        async (target) => {
            const root = makeTestTempRoot('erden-store-registration-unlink-');
            roots.push(root);
            const projectRoot = join(root, 'project');
            const storeRoot = join(root, 'store');
            const fixture = await projectFixture(projectRoot);
            const base = makeNodeStoreFileSystemPort().operations;
            let injected = false;
            const faultStore = makeLocalPackageStore(
                makeNodeStoreFileSystemPort({
                    rm: async (path, options) => {
                        const name = basename(path.toString());
                        const matches =
                            target === 'registration-stage'
                                ? name.includes('.stage-') && dirname(path.toString()).endsWith('registrations')
                                : target === 'admin-stage'
                                  ? /^\.erden\.store-admin\.stage-/u.test(name)
                                  : name === '.erden.store-admin.transaction.json';
                        await base.rm(path, options);
                        if (!injected && matches) {
                            injected = true;
                            throw Object.assign(new Error('injected unlink-then-throw'), { code: 'EIO' });
                        }
                    },
                }),
            );
            await expect(
                Effect.runPromise(
                    faultStore.refreshProjectReference({
                        storeRoot,
                        projectRoot,
                        manifestPath: join(projectRoot, 'erden.config.json'),
                        manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                        lock: fixture.lock,
                    }),
                ),
            ).resolves.toMatchObject({ status: 'registered' });
            expect(injected).toBe(true);
            expect(await fs.readdir(storeRoot)).toEqual(['registrations']);
        },
    );

    it('rejects a same-byte final-generation substitution during registration cleanup', async () => {
        const root = makeTestTempRoot('erden-store-registration-final-substitution-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const registrationsRoot = join(storeRoot, 'registrations');
        const base = makeNodeStoreFileSystemPort().operations;
        let injected = false;
        const faultStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rm: async (path, options) => {
                    await base.rm(path, options);
                    if (!injected && basename(path.toString()) === '.erden.store-admin.transaction.json') {
                        injected = true;
                        const finalName = (await fs.readdir(registrationsRoot)).find(
                            (name) => !name.startsWith('.'),
                        ) as string;
                        const finalPath = join(registrationsRoot, finalName);
                        const bytes = await fs.readFile(finalPath);
                        await fs.rename(finalPath, join(root, 'held-final-generation.json'));
                        await fs.writeFile(finalPath, bytes, { flag: 'wx', mode: 0o444 });
                        await fs.chmod(finalPath, 0o444);
                    }
                },
            }),
        );
        const failure = await Effect.runPromise(
            faultStore
                .refreshProjectReference({
                    storeRoot,
                    projectRoot,
                    manifestPath: join(projectRoot, 'erden.config.json'),
                    manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                    lock: fixture.lock,
                })
                .pipe(Effect.flip),
        );
        expect(injected).toBe(true);
        expect(failure).toMatchObject({ code: 'STORE_REFERENCE_INVALID' });
    });

    it('rejects a same-byte final-generation substitution at the recovered registration terminal boundary', async () => {
        const root = makeTestTempRoot('erden-store-registration-recovered-final-substitution-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const input = {
            storeRoot,
            projectRoot,
            manifestPath: join(projectRoot, 'erden.config.json'),
            manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
            lock: fixture.lock,
        };
        const registrationsRoot = join(storeRoot, 'registrations');
        const base = makeNodeStoreFileSystemPort().operations;
        let interrupted = false;
        const interruptedStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rm: async (path, options) => {
                    const name = basename(path.toString());
                    if (!interrupted && name.includes('.stage-') && dirname(path.toString()) === registrationsRoot) {
                        interrupted = true;
                        throw Object.assign(new Error('injected registration-stage cleanup interruption'), {
                            code: 'EIO',
                        });
                    }
                    await base.rm(path, options);
                },
            }),
        );
        await expect(Effect.runPromise(interruptedStore.refreshProjectReference(input))).rejects.toMatchObject({
            code: 'STORE_ROLLBACK_UNSAFE',
        });
        expect(interrupted).toBe(true);
        const finalName = (await fs.readdir(registrationsRoot)).find((name) => !name.startsWith('.')) as string;
        const finalPath = join(registrationsRoot, finalName);
        let substituted = false;
        const recoveryStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rm: async (path, options) => {
                    await base.rm(path, options);
                    if (!substituted && basename(path.toString()) === '.erden.store-admin.transaction.json') {
                        substituted = true;
                        const bytes = await fs.readFile(finalPath);
                        await fs.rename(finalPath, join(root, 'held-recovered-final-generation.json'));
                        await fs.writeFile(finalPath, bytes, { flag: 'wx', mode: 0o444 });
                        await fs.chmod(finalPath, 0o444);
                    }
                },
            }),
        );
        const failure = await Effect.runPromise(recoveryStore.refreshProjectReference(input).pipe(Effect.flip));
        expect(substituted).toBe(true);
        expect(failure).toMatchObject({ code: 'STORE_ROLLBACK_UNSAFE' });
    });

    it('classifies a valid final with retained registration publication evidence only as busy', async () => {
        const root = makeTestTempRoot('erden-store-status-registration-busy-exclusive-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const input = {
            storeRoot,
            projectRoot,
            manifestPath: join(projectRoot, 'erden.config.json'),
            manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
            lock: fixture.lock,
        };
        const registrationsRoot = join(storeRoot, 'registrations');
        const base = makeNodeStoreFileSystemPort().operations;
        let interrupted = false;
        const interruptedStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rm: async (path, options) => {
                    const name = basename(path.toString());
                    if (!interrupted && name.includes('.stage-') && dirname(path.toString()) === registrationsRoot) {
                        interrupted = true;
                        throw Object.assign(new Error('injected registration-stage cleanup interruption'), {
                            code: 'EIO',
                        });
                    }
                    await base.rm(path, options);
                },
            }),
        );
        await expect(Effect.runPromise(interruptedStore.refreshProjectReference(input))).rejects.toMatchObject({
            code: 'STORE_ROLLBACK_UNSAFE',
        });
        expect(interrupted).toBe(true);
        const normalStore = makeLocalPackageStore();
        const index = await Effect.runPromise(normalStore.inspectStoreIndex({ storeRoot }));
        expect(index).toMatchObject({ transaction: 'busy' });
        expect(index.registrations).toHaveLength(1);
        expect(index.busyRegistrationIds).toEqual([index.registrations[0]?.registrationId]);
        let toolchainCalls = 0;
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => {
                toolchainCalls += 1;
                throw new Error('excluded busy registration must not resolve toolchain');
            }),
            normalStore,
            { defaultStoreRoot: () => storeRoot },
        );
        const report = await Effect.runPromise(service.status());
        expect(report).toMatchObject({
            transaction: 'busy',
            outcome: 'issues',
            registrations: {
                total: 0,
                current: [],
                superseded: [],
                orphaned: [],
                stale: [],
                corrupt: [],
                busy: index.busyRegistrationIds,
            },
        });
        expect(toolchainCalls).toBe(0);
        expect(decodeStoreStatusReport(JSON.parse(encodeStoreStatusReport(report)))).toEqual(report);
    });

    it('classifies a registration with valid and corrupt generations only as corrupt', async () => {
        const root = makeTestTempRoot('erden-store-status-registration-corrupt-exclusive-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const normalStore = makeLocalPackageStore();
        const registered = await Effect.runPromise(
            normalStore.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        const corruptPath = join(storeRoot, 'registrations', `${registered.registrationId}.${digest('f')}.json`);
        await fs.writeFile(corruptPath, '{}\n', { flag: 'wx', mode: 0o444 });
        await fs.chmod(corruptPath, 0o444);
        const index = await Effect.runPromise(normalStore.inspectStoreIndex({ storeRoot }));
        expect(index.registrations).toHaveLength(1);
        expect(index.corruptRegistrationIds).toEqual([registered.registrationId]);
        let toolchainCalls = 0;
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => {
                toolchainCalls += 1;
                throw new Error('excluded corrupt registration must not resolve toolchain');
            }),
            normalStore,
            { defaultStoreRoot: () => storeRoot },
        );
        const report = await Effect.runPromise(service.status());
        expect(report).toMatchObject({
            transaction: 'idle',
            outcome: 'issues',
            registrations: {
                total: 0,
                current: [],
                superseded: [],
                orphaned: [],
                stale: [],
                corrupt: [registered.registrationId],
                busy: [],
            },
        });
        expect(toolchainCalls).toBe(0);
        expect(decodeStoreStatusReport(JSON.parse(encodeStoreStatusReport(report)))).toEqual(report);
    });

    it('treats a proven-absent project as prunable orphan cleanup rather than a health issue', async () => {
        const root = makeTestTempRoot('erden-store-status-orphan-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const store = makeLocalPackageStore();
        await Effect.runPromise(
            store.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        await fs.rm(projectRoot, { recursive: true });
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            store,
            { defaultStoreRoot: () => storeRoot },
        );
        const report = await Effect.runPromise(service.status());
        expect(report.outcome).toBe('healthy');
        expect(report.registrations.current).toEqual([]);
        expect(report.registrations.orphaned).toHaveLength(1);
        const before = await treeSnapshot(storeRoot);
        const planned = await Effect.runPromise(service.prune({ dryRun: true }));
        const after = await treeSnapshot(storeRoot);
        expect(planned).toMatchObject({
            dryRun: true,
            outcome: 'planned',
            registrations: { total: 1 },
            objects: { total: 0 },
        });
        expect(after).toBe(before);
        const pruned = await Effect.runPromise(service.prune({}));
        expect(pruned).toMatchObject({
            dryRun: false,
            outcome: 'pruned',
            registrations: { total: 1 },
            objects: { total: 0 },
        });
        expect(await fs.readdir(join(storeRoot, 'registrations'))).toEqual([]);
        expect(await fs.readdir(storeRoot)).toEqual(['objects', 'registrations']);
        expect((await Effect.runPromise(service.status())).outcome).toBe('healthy');
    });

    it('prunes every generation of one proven-absent project as orphaned in one clean transaction', async () => {
        const root = makeTestTempRoot('erden-store-prune-multi-generation-orphan-');
        roots.push(root);
        const fixture = await twoGenerationFixture(root);
        expect(fixture.first.status).toBe('registered');
        expect(fixture.second.status).toBe('registered');
        await fs.rm(fixture.projectRoot, { recursive: true });
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            fixture.store,
            { defaultStoreRoot: () => fixture.storeRoot },
        );
        const status = await Effect.runPromise(service.status());
        expect(status).toMatchObject({
            outcome: 'healthy',
            registrations: { total: 2, current: [], superseded: [] },
        });
        expect(status.registrations.orphaned).toHaveLength(2);
        const report = await Effect.runPromise(service.prune({}));
        expect(report).toMatchObject({
            dryRun: false,
            outcome: 'pruned',
            registrations: { total: 2 },
            objects: { total: 0 },
        });
        expect(report.registrations.retired.map(({ generationSha256 }) => generationSha256).sort()).toEqual(
            [fixture.first.generationSha256, fixture.second.generationSha256].sort(),
        );
        expect(await fs.readdir(fixture.storeRoot)).toEqual(['objects', 'registrations']);
        expect(await fs.readdir(join(fixture.storeRoot, 'registrations'))).toEqual([]);
    });

    it('snapshots one absence classification per registration root before publishing a multi-generation prune', async () => {
        const root = makeTestTempRoot('erden-store-prune-root-status-snapshot-');
        roots.push(root);
        const fixture = await twoGenerationFixture(root);
        const capturedProjectStats = await fs.lstat(fixture.projectRoot, { bigint: true });
        await fs.rm(fixture.projectRoot, { recursive: true });
        const base = makeNodeStoreFileSystemPort().operations;
        let markerPublished = false;
        let prePublicationRootStatusCalls = 0;
        const transitioningStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                lstat: (async (path, options) => {
                    if (path.toString() === fixture.projectRoot && !markerPublished) {
                        prePublicationRootStatusCalls += 1;
                        if (prePublicationRootStatusCalls <= 3) {
                            throw Object.assign(new Error('injected proven absence'), { code: 'ENOENT' });
                        }
                        return capturedProjectStats;
                    }
                    return await base.lstat(path, options);
                }) as typeof base.lstat,
                link: async (source, destination) => {
                    await base.link(source, destination);
                    if (basename(destination.toString()) === '.erden.store-admin.transaction.json') {
                        markerPublished = true;
                    }
                },
            }),
        );
        const generations = [fixture.first, fixture.second]
            .map(({ registrationId, generationSha256 }) => ({ registrationId, generationSha256 }))
            .sort((left, right) => {
                const leftKey = `${left.registrationId}.${left.generationSha256}`;
                const rightKey = `${right.registrationId}.${right.generationSha256}`;
                return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
            });
        const result = await Effect.runPromise(
            transitioningStore.pruneStore({
                storeRoot: fixture.storeRoot,
                registrationGenerations: generations,
                archiveSha256s: [],
            }),
        );
        expect(result).toMatchObject({ status: 'pruned', registrations: 2, cleanup: 'clean' });
        expect(markerPublished).toBe(true);
        expect(prePublicationRootStatusCalls).toBe(3);
        expect(await fs.readdir(fixture.storeRoot)).toEqual(['objects', 'registrations']);
        expect(await fs.readdir(join(fixture.storeRoot, 'registrations'))).toEqual([]);
    });

    it('restarts an interrupted multi-generation orphan prune after the first quarantine', async () => {
        const root = makeTestTempRoot('erden-store-prune-multi-generation-restart-');
        roots.push(root);
        const fixture = await twoGenerationFixture(root);
        await fs.rm(fixture.projectRoot, { recursive: true });
        const registrationsRoot = join(fixture.storeRoot, 'registrations');
        const base = makeNodeStoreFileSystemPort().operations;
        let quarantined = false;
        let interrupted = false;
        const faultStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rename: async (source, destination) => {
                    await base.rename(source, destination);
                    if (
                        dirname(destination.toString()) === registrationsRoot &&
                        /^\.[0-9a-f]{64}\.[0-9a-f]{64}\.prune-/u.test(basename(destination.toString()))
                    ) {
                        quarantined = true;
                    }
                },
                opendir: async (path, options) => {
                    if (quarantined && !interrupted && path.toString() === registrationsRoot) {
                        interrupted = true;
                        throw Object.assign(new Error('injected post-quarantine interruption'), { code: 'EIO' });
                    }
                    return await base.opendir(path, options);
                },
            }),
        );
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const toolchains = makeCurrentToolchainService(() => TOOLCHAIN);
        const failedService = makeStoreMaintenanceService(states, toolchains, faultStore, {
            defaultStoreRoot: () => fixture.storeRoot,
        });
        await expect(Effect.runPromise(failedService.prune({}))).rejects.toMatchObject({
            code: 'STORE_MAINTENANCE_PRUNE_BLOCKED',
        });
        expect(quarantined).toBe(true);
        expect(interrupted).toBe(true);
        expect(await fs.readdir(fixture.storeRoot)).toContain('.erden.store-admin.transaction.json');
        expect((await fs.readdir(registrationsRoot)).filter((name) => name.includes('.prune-'))).toHaveLength(1);
        const recoveryService = makeStoreMaintenanceService(states, toolchains, fixture.store, {
            defaultStoreRoot: () => fixture.storeRoot,
        });
        const recovered = await Effect.runPromise(recoveryService.prune({}));
        expect(recovered).toMatchObject({
            dryRun: false,
            outcome: 'pruned',
            registrations: { total: 2 },
            objects: { total: 0 },
        });
        expect(await fs.readdir(fixture.storeRoot)).toEqual(['objects', 'registrations']);
        expect(await fs.readdir(registrationsRoot)).toEqual([]);
    });

    it('keeps an immutable current generation usable after a superseded predecessor is compacted', async () => {
        const root = makeTestTempRoot('erden-store-status-compacted-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const store = makeLocalPackageStore();
        const first = await Effect.runPromise(
            store.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        const nextManifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: fixture.manifest.canonicalIri,
            alias: fixture.manifest.alias,
            ownedIriPrefixes: fixture.manifest.ownedIriPrefixes,
            dependencies: {},
            sources: { ontology: ['ontology.ttl', 'ontology-2.ttl'] },
        });
        const nextBytes = new TextEncoder().encode(serializeManifestV1(nextManifest, 'json'));
        await fs.writeFile(join(projectRoot, 'erden.config.json'), nextBytes);
        await fs.writeFile(join(projectRoot, 'ontology-2.ttl'), '<urn:s2> <urn:p> <urn:o> .\n');
        const second = await Effect.runPromise(
            store.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(nextBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        expect(second.status).toBe('registered');
        await fs.unlink(join(storeRoot, 'registrations', `${first.registrationId}.${first.generationSha256}.json`));
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            store,
            { defaultStoreRoot: () => storeRoot },
        );
        const report = await Effect.runPromise(service.status());
        expect(report).toMatchObject({ outcome: 'healthy', registrations: { total: 1 } });
        expect(report.registrations.current[0]).toMatchObject({ generationSha256: second.generationSha256 });
        const hit = await Effect.runPromise(
            store.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(nextBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        expect(hit).toMatchObject({ status: 'hit', generationSha256: second.generationSha256 });
    });

    it('reports and removes one fully authenticated unreferenced content object', async () => {
        const root = makeTestTempRoot('erden-store-status-unreferenced-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const encoded = encodePackage({
            canonicalIri: 'https://example.test/unreferenced-package',
            version: '1.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:unused> <urn:p> <urn:o> .\n', executable: false }],
        });
        const store = makeLocalPackageStore();
        await Effect.runPromise(
            store.put({
                storeRoot,
                expected: {
                    canonicalIri: 'https://example.test/unreferenced-package',
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    dependencies: [],
                },
                toolchain: TOOLCHAIN,
                archive: encoded.archiveBytes,
            }),
        );
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            store,
            { defaultStoreRoot: () => storeRoot },
        );
        const status = await Effect.runPromise(service.status());
        expect(status.outcome).toBe('healthy');
        expect(status.objects.unreferenced).toEqual([encoded.archiveSha256]);
        const planned = await Effect.runPromise(service.prune({ dryRun: true }));
        expect(planned).toMatchObject({ outcome: 'planned', objects: { total: 1, removed: [encoded.archiveSha256] } });
        const pruned = await Effect.runPromise(service.prune({}));
        expect(pruned).toMatchObject({ outcome: 'pruned', objects: { total: 1, removed: [encoded.archiveSha256] } });
        expect(await fs.readdir(join(storeRoot, 'objects'))).toEqual([]);
        expect(await fs.readdir(storeRoot)).toEqual(['objects', 'registrations']);
    });

    it('reports a real fully-referenced prune as a decoded non-dry no-op without mutation or prune delegation', async () => {
        const root = makeTestTempRoot('erden-store-prune-referenced-real-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const registryOrigin = 'https://registry.example';
        const dependencyAlias = '@example/referenced-package';
        const dependencyIri = 'https://example.test/referenced-package';
        const requested = '^1.0.0';
        const encoded = encodePackage({
            canonicalIri: dependencyIri,
            version: '1.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:referenced> <urn:p> <urn:o> .\n', executable: false }],
        });
        const manifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/referenced-root',
            alias: '@example/referenced-root',
            ownedIriPrefixes: ['https://example.test/referenced-root#'],
            registry: registryOrigin,
            dependencies: { [dependencyAlias]: requested },
            sources: { ontology: ['ontology.ttl'] },
        });
        const manifestBytes = new TextEncoder().encode(serializeManifestV1(manifest, 'json'));
        const lock = decodeLockfileValue({
            lockfileVersion: 1,
            registryOrigin,
            manifestDependencySha256: manifestDependencyProjectionSha256({
                canonicalIri: manifest.canonicalIri,
                alias: manifest.alias,
                registryOrigin,
                dependencies: manifest.dependencies,
            }),
            root: { canonicalIri: manifest.canonicalIri, alias: manifest.alias },
            directDependencies: [
                {
                    identifier: dependencyAlias,
                    requested,
                    canonicalIri: dependencyIri,
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                },
            ],
            aliasMappings: [{ alias: dependencyAlias, canonicalIri: dependencyIri }],
            packages: [
                {
                    canonicalIri: dependencyIri,
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    dependencies: [],
                },
            ],
            toolchain: TOOLCHAIN,
            counts: { directDependencies: 1, aliasMappings: 1, packages: 1, edges: 0 },
        });
        await fs.mkdir(projectRoot, { recursive: true });
        await fs.writeFile(join(projectRoot, 'erden.config.json'), manifestBytes, { mode: 0o644 });
        await fs.writeFile(join(projectRoot, 'erden.lock'), serializeLockfileBytes(lock), { mode: 0o644 });
        await fs.writeFile(join(projectRoot, 'ontology.ttl'), '<urn:root> <urn:p> <urn:o> .\n');
        const normalStore = makeLocalPackageStore();
        await Effect.runPromise(
            normalStore.put({
                storeRoot,
                expected: {
                    canonicalIri: dependencyIri,
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    dependencies: [],
                },
                toolchain: TOOLCHAIN,
                archive: encoded.archiveBytes,
            }),
        );
        await Effect.runPromise(
            normalStore.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
                lock,
            }),
        );
        let pruneCalls = 0;
        const guardedStore = Object.freeze({
            ...normalStore,
            pruneStore: (input: Parameters<typeof normalStore.pruneStore>[0]) => {
                pruneCalls += 1;
                return normalStore.pruneStore(input);
            },
        });
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            guardedStore,
            { defaultStoreRoot: () => storeRoot },
        );
        const status = await Effect.runPromise(service.status());
        expect(status.objects).toMatchObject({ referenced: [encoded.archiveSha256], unreferenced: [] });
        const before = await treeSnapshot(storeRoot);
        const report = await Effect.runPromise(service.prune({}));
        expect(report).toMatchObject({ dryRun: false, outcome: 'nothing-to-prune' });
        expect(decodeStorePruneReport(JSON.parse(encodeStorePruneReport(report)))).toEqual(report);
        expect(pruneCalls).toBe(0);
        expect(await treeSnapshot(storeRoot)).toBe(before);
    });

    it('forward-recovers an object quarantine after partial file deletion', async () => {
        const root = makeTestTempRoot('erden-store-prune-object-recovery-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const encoded = encodePackage({
            canonicalIri: 'https://example.test/interrupted-object',
            version: '1.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:interrupted> <urn:p> <urn:o> .\n', executable: false }],
        });
        const normalStore = makeLocalPackageStore();
        await Effect.runPromise(
            normalStore.put({
                storeRoot,
                expected: {
                    canonicalIri: 'https://example.test/interrupted-object',
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    dependencies: [],
                },
                toolchain: TOOLCHAIN,
                archive: encoded.archiveBytes,
            }),
        );
        let injected = false;
        const faultStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rm: async (path, options) => {
                    if (
                        !injected &&
                        path.toString().includes(`.${encoded.archiveSha256}.prune-`) &&
                        path.toString().endsWith('ontology.ttl')
                    ) {
                        injected = true;
                        throw Object.assign(new Error('injected partial object prune'), { code: 'EIO' });
                    }
                    await fs.rm(path, options);
                },
            }),
        );
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const toolchains = makeCurrentToolchainService(() => TOOLCHAIN);
        const failedService = makeStoreMaintenanceService(states, toolchains, faultStore, {
            defaultStoreRoot: () => storeRoot,
        });
        await expect(Effect.runPromise(failedService.prune({}))).rejects.toMatchObject({
            code: 'STORE_MAINTENANCE_PRUNE_BLOCKED',
        });
        expect(await fs.readdir(storeRoot)).toEqual(
            expect.arrayContaining(['.erden.store-admin.transaction.json', 'objects', 'registrations']),
        );
        const recoveredService = makeStoreMaintenanceService(states, toolchains, normalStore, {
            defaultStoreRoot: () => storeRoot,
        });
        await expect(Effect.runPromise(recoveredService.prune({}))).resolves.toMatchObject({
            outcome: 'pruned',
            objects: { total: 1, removed: [encoded.archiveSha256] },
        });
        expect(await fs.readdir(storeRoot)).toEqual(['objects', 'registrations']);
        expect(await fs.readdir(join(storeRoot, 'objects'))).toEqual([]);
    });

    it('reconciles fixed-marker removal that completes and then throws', async () => {
        const root = makeTestTempRoot('erden-store-prune-marker-unlink-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const normalStore = makeLocalPackageStore();
        const registered = await Effect.runPromise(
            normalStore.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        await fs.rm(projectRoot, { recursive: true });
        let injected = false;
        const faultStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rm: async (path, options) => {
                    await fs.rm(path, options);
                    if (!injected && basename(path.toString()) === '.erden.store-admin.transaction.json') {
                        injected = true;
                        throw Object.assign(new Error('injected unlink-then-throw'), { code: 'EIO' });
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                faultStore.pruneStore({
                    storeRoot,
                    registrationGenerations: [
                        {
                            registrationId: registered.registrationId,
                            generationSha256: registered.generationSha256,
                        },
                    ],
                    archiveSha256s: [],
                }),
            ),
        ).resolves.toMatchObject({ status: 'pruned', registrations: 1, cleanup: 'clean' });
        expect(injected).toBe(true);
        expect(await fs.readdir(storeRoot)).toEqual(['objects', 'registrations']);
    });

    it.each(['prune-stage', 'fixed-marker'] as const)(
        'rejects a same-byte replacement of retained %s evidence',
        async (target) => {
            const root = makeTestTempRoot('erden-store-prune-substitution-');
            roots.push(root);
            const projectRoot = join(root, 'project');
            const storeRoot = join(root, 'store');
            const fixture = await projectFixture(projectRoot);
            const normalStore = makeLocalPackageStore();
            const registered = await Effect.runPromise(
                normalStore.refreshProjectReference({
                    storeRoot,
                    projectRoot,
                    manifestPath: join(projectRoot, 'erden.config.json'),
                    manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                    lock: fixture.lock,
                }),
            );
            await fs.rm(projectRoot, { recursive: true });
            let interrupted = false;
            const faultStore = makeLocalPackageStore(
                makeNodeStoreFileSystemPort({
                    rm: async (path, options) => {
                        if (!interrupted && /^\.[0-9a-f]{64}\.[0-9a-f]{64}\.prune-/u.test(basename(path.toString()))) {
                            interrupted = true;
                            throw Object.assign(new Error('injected prune interruption'), { code: 'EIO' });
                        }
                        await fs.rm(path, options);
                    },
                }),
            );
            await expect(
                Effect.runPromise(
                    faultStore.pruneStore({
                        storeRoot,
                        registrationGenerations: [
                            {
                                registrationId: registered.registrationId,
                                generationSha256: registered.generationSha256,
                            },
                        ],
                        archiveSha256s: [],
                    }),
                ),
            ).rejects.toMatchObject({ code: 'STORE_PRUNE_INTERRUPTED' });
            const targetPath =
                target === 'fixed-marker'
                    ? join(storeRoot, '.erden.store-admin.transaction.json')
                    : join(
                          storeRoot,
                          (await fs.readdir(storeRoot)).find((name) =>
                              /^\.erden\.store-admin\.stage-/u.test(name),
                          ) as string,
                      );
            const bytes = await fs.readFile(targetPath);
            await fs.rename(targetPath, join(root, `${target}.held`));
            await fs.writeFile(targetPath, bytes, { flag: 'wx', mode: 0o444 });
            await fs.chmod(targetPath, 0o444);
            const failure = await Effect.runPromise(
                normalStore
                    .pruneStore({
                        storeRoot,
                        registrationGenerations: [
                            {
                                registrationId: registered.registrationId,
                                generationSha256: registered.generationSha256,
                            },
                        ],
                        archiveSha256s: [],
                    })
                    .pipe(Effect.flip),
            );
            expect(failure).toMatchObject({ code: 'STORE_PRUNE_INTERRUPTED' });
            expect(await fs.readFile(targetPath)).toEqual(bytes);
        },
    );

    it('retains authenticated evidence on interruption and completes the exact prune on restart', async () => {
        const root = makeTestTempRoot('erden-store-prune-recovery-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const normalStore = makeLocalPackageStore();
        await Effect.runPromise(
            normalStore.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        await fs.rm(projectRoot, { recursive: true });
        let failed = false;
        const faultStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rm: async (path, options) => {
                    if (!failed && /^\.[0-9a-f]{64}\.[0-9a-f]{64}\.prune-/u.test(basename(path.toString()))) {
                        failed = true;
                        throw Object.assign(new Error('injected prune interruption'), { code: 'EIO' });
                    }
                    await fs.rm(path, options);
                },
            }),
        );
        const states = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const toolchains = makeCurrentToolchainService(() => TOOLCHAIN);
        const failedService = makeStoreMaintenanceService(states, toolchains, faultStore, {
            defaultStoreRoot: () => storeRoot,
        });
        const failure = await Effect.runPromise(failedService.prune({}).pipe(Effect.flip));
        expect(failure).toMatchObject({ code: 'STORE_MAINTENANCE_PRUNE_BLOCKED' });
        const residue = await fs.readdir(storeRoot);
        expect(residue).toContain('.erden.store-admin.transaction.json');
        expect(residue.some((name) => /^\.erden\.store-admin\.stage-/u.test(name))).toBe(true);

        const encoded = encodePackage({
            canonicalIri: 'https://example.test/blocked-during-prune',
            version: '1.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [{ path: 'ontology.ttl', bytes: '<urn:blocked> <urn:p> <urn:o> .\n', executable: false }],
        });
        const packageInput = {
            storeRoot,
            expected: {
                canonicalIri: 'https://example.test/blocked-during-prune',
                version: '1.0.0',
                archiveSha256: encoded.archiveSha256,
                dependencies: [],
            },
            toolchain: TOOLCHAIN,
            archive: encoded.archiveBytes,
        };
        const liveProjectRoot = join(root, 'live-project');
        const liveFixture = await projectFixture(liveProjectRoot);
        const mutatorFailures = await Promise.all([
            Effect.runPromise(normalStore.put(packageInput).pipe(Effect.flip)),
            Effect.runPromise(normalStore.repair(packageInput).pipe(Effect.flip)),
            Effect.runPromise(
                normalStore
                    .materialize({
                        storeRoot,
                        projectRoot: liveProjectRoot,
                        lock: liveFixture.lock,
                    })
                    .pipe(Effect.flip),
            ),
            Effect.runPromise(
                normalStore
                    .refreshProjectReference({
                        storeRoot,
                        projectRoot: liveProjectRoot,
                        manifestPath: join(liveProjectRoot, 'erden.config.json'),
                        manifestSha256: createHash('sha256').update(liveFixture.manifestBytes).digest('hex'),
                        lock: liveFixture.lock,
                    })
                    .pipe(Effect.flip),
            ),
        ]);
        expect(mutatorFailures.map((error) => error.code)).toEqual([
            'STORE_OBJECT_BUSY',
            'STORE_OBJECT_BUSY',
            'STORE_OBJECT_BUSY',
            'STORE_REFERENCE_BUSY',
        ]);
        expect(await fs.readdir(storeRoot)).toEqual(residue);

        const recoveryService = makeStoreMaintenanceService(states, toolchains, normalStore, {
            defaultStoreRoot: () => storeRoot,
        });
        const recovered = await Effect.runPromise(recoveryService.prune({}));
        expect(recovered).toMatchObject({ outcome: 'pruned', registrations: { total: 1 } });
        expect(await fs.readdir(storeRoot)).toEqual(['objects', 'registrations']);
        expect(await fs.readdir(join(storeRoot, 'registrations'))).toEqual([]);
    });

    it.each(['EACCES', 'ENOSPC'] as const)(
        'preserves an ordinary %s failure when admin-stage creation proves clean absence',
        async (code) => {
            const root = makeTestTempRoot('erden-store-prune-open-failure-');
            roots.push(root);
            const projectRoot = join(root, 'project');
            const storeRoot = join(root, 'store');
            const fixture = await projectFixture(projectRoot);
            const normalStore = makeLocalPackageStore();
            const registered = await Effect.runPromise(
                normalStore.refreshProjectReference({
                    storeRoot,
                    projectRoot,
                    manifestPath: join(projectRoot, 'erden.config.json'),
                    manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                    lock: fixture.lock,
                }),
            );
            await fs.rm(projectRoot, { recursive: true });
            const base = makeNodeStoreFileSystemPort().operations;
            const failingStore = makeLocalPackageStore(
                makeNodeStoreFileSystemPort({
                    open: async (path, flags, mode) => {
                        if (flags === 'wx' && /^\.erden\.store-admin\.stage-/u.test(basename(path.toString()))) {
                            throw Object.assign(new Error('private before-create failure'), { code });
                        }
                        return await base.open(path, flags, mode);
                    },
                }),
            );
            const failure = await Effect.runPromise(
                failingStore
                    .pruneStore({
                        storeRoot,
                        registrationGenerations: [
                            {
                                registrationId: registered.registrationId,
                                generationSha256: registered.generationSha256,
                            },
                        ],
                        archiveSha256s: [],
                    })
                    .pipe(Effect.flip),
            );
            expect(failure).toMatchObject({ code: 'STORE_IO_FAILURE' });
            expect(await fs.readdir(storeRoot)).toEqual(['objects', 'registrations']);
            expect(await fs.readdir(join(storeRoot, 'registrations'))).toEqual([
                `${registered.registrationId}.${registered.generationSha256}.json`,
            ]);
        },
    );

    it('retains an unauthenticated admin stage when exclusive creation creates and then throws', async () => {
        const root = makeTestTempRoot('erden-store-prune-create-then-throw-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const normalStore = makeLocalPackageStore();
        const registered = await Effect.runPromise(
            normalStore.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        await fs.rm(projectRoot, { recursive: true });
        const base = makeNodeStoreFileSystemPort().operations;
        let injected = false;
        const failingStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                open: async (path, flags, mode) => {
                    if (
                        !injected &&
                        flags === 'wx' &&
                        /^\.erden\.store-admin\.stage-/u.test(basename(path.toString()))
                    ) {
                        injected = true;
                        const handle = await base.open(path, flags, mode);
                        await handle.close();
                        throw Object.assign(new Error('private create-then-throw failure'), { code: 'EIO' });
                    }
                    return await base.open(path, flags, mode);
                },
            }),
        );
        const failure = await Effect.runPromise(
            failingStore
                .pruneStore({
                    storeRoot,
                    registrationGenerations: [
                        {
                            registrationId: registered.registrationId,
                            generationSha256: registered.generationSha256,
                        },
                    ],
                    archiveSha256s: [],
                })
                .pipe(Effect.flip),
        );
        expect(failure).toMatchObject({ code: 'STORE_ROLLBACK_UNSAFE' });
        const residue = await fs.readdir(storeRoot);
        expect(residue).not.toContain('.erden.store-admin.transaction.json');
        expect(residue.filter((name) => /^\.erden\.store-admin\.stage-/u.test(name))).toHaveLength(1);
        expect(await Effect.runPromise(normalStore.inspectStoreIndex({ storeRoot }))).toMatchObject({
            transaction: 'busy',
        });
    });

    it('retires only its own stage when another administration marker wins publication', async () => {
        const root = makeTestTempRoot('erden-store-prune-marker-race-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const normalStore = makeLocalPackageStore();
        const registered = await Effect.runPromise(
            normalStore.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        await fs.rm(projectRoot, { recursive: true });
        const ownToken = '0123456789abcdef';
        const winnerToken = 'fedcba9876543210';
        const winnerMarker: StoreAdminMarker = Object.freeze({
            format: 'erden.store-admin-transaction/v1',
            kind: 'registration',
            token: winnerToken,
            stageName: `.${digest('e')}.${digest('f')}.stage-${winnerToken}.json`,
            finalName: `${digest('e')}.${digest('f')}.json`,
            registrationId: digest('e'),
            generationSha256: digest('f'),
            stageIdentity: Object.freeze({
                dev: '1',
                ino: '2',
                mode: '33060',
                size: '1',
                mtimeNs: '1',
                ctimeNs: '1',
                kind: 'file',
            }),
        });
        const winnerBytes = encodeStoreAdminMarker(winnerMarker);
        let injected = false;
        const base = makeNodeStoreFileSystemPort().operations;
        const failingStore = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                token: () => ownToken,
                link: async (source, destination) => {
                    if (!injected && basename(destination.toString()) === '.erden.store-admin.transaction.json') {
                        injected = true;
                        const winnerStage = join(storeRoot, `.erden.store-admin.stage-${winnerToken}.json`);
                        await fs.writeFile(winnerStage, winnerBytes, { mode: 0o444, flag: 'wx' });
                        await fs.link(winnerStage, destination);
                        throw Object.assign(new Error('concurrent marker won'), { code: 'EEXIST' });
                    }
                    await base.link(source, destination);
                },
            }),
        );
        const failure = await Effect.runPromise(
            failingStore
                .pruneStore({
                    storeRoot,
                    registrationGenerations: [
                        {
                            registrationId: registered.registrationId,
                            generationSha256: registered.generationSha256,
                        },
                    ],
                    archiveSha256s: [],
                })
                .pipe(Effect.flip),
        );
        expect(failure).toMatchObject({ code: 'STORE_PRUNE_BLOCKED' });
        const names = await fs.readdir(storeRoot);
        expect(names).toContain('.erden.store-admin.transaction.json');
        expect(names).toContain(`.erden.store-admin.stage-${winnerToken}.json`);
        expect(names).not.toContain(`.erden.store-admin.stage-${ownToken}.json`);
        expect(await Effect.runPromise(normalStore.inspectStoreIndex({ storeRoot }))).toMatchObject({
            transaction: 'busy',
        });
    });

    it('reports a present changed project as a blocking stale issue without exposing its path', async () => {
        const root = makeTestTempRoot('erden-store-status-stale-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const storeRoot = join(root, 'store');
        const fixture = await projectFixture(projectRoot);
        const store = makeLocalPackageStore();
        await Effect.runPromise(
            store.refreshProjectReference({
                storeRoot,
                projectRoot,
                manifestPath: join(projectRoot, 'erden.config.json'),
                manifestSha256: createHash('sha256').update(fixture.manifestBytes).digest('hex'),
                lock: fixture.lock,
            }),
        );
        await fs.appendFile(join(projectRoot, 'erden.config.json'), '\n');
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            store,
            { defaultStoreRoot: () => storeRoot },
        );
        const report = await Effect.runPromise(service.status());
        expect(report.outcome).toBe('issues');
        expect(report.registrations.stale).toHaveLength(1);
        expect(encodeStoreStatusReport(report)).not.toContain(root.replaceAll('\\', '/'));
    });

    it('rejects hostile or contradictory index truth with a frozen typed path-free error', async () => {
        const hostile = new Proxy(
            {},
            {
                getOwnPropertyDescriptor: () => {
                    throw new Error('D:/private-index');
                },
            },
        );
        const service = makeStoreMaintenanceService(
            makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort()),
            makeCurrentToolchainService(() => TOOLCHAIN),
            {
                inspectStoreIndex: () => Effect.succeed(hostile as StoreIndexInspection),
                pruneStore: () => Effect.die('not called'),
            },
            { defaultStoreRoot: () => 'D:\\private-store' },
        );
        const failure = await Effect.runPromise(service.status().pipe(Effect.flip));
        expect(failure).toBeInstanceOf(StoreMaintenanceError);
        expect(failure).toMatchObject({ code: 'STORE_MAINTENANCE_INDEX_UNAVAILABLE' });
        expect(failure.message).not.toMatch(/private|[A-Z]:[\\/]/u);
        expect(Object.isFrozen(failure)).toBe(true);

        const thrown = new Proxy(new Error('D:/private-thrown-proxy'), {
            getPrototypeOf: () => {
                throw new Error('D:/private-thrown-proxy');
            },
            getOwnPropertyDescriptor: () => {
                throw new Error('D:/private-thrown-proxy');
            },
        });
        const hostileInput = new Proxy(
            {},
            {
                getPrototypeOf: () => {
                    throw thrown;
                },
            },
        );
        const storeFailure = await Effect.runPromise(
            makeLocalPackageStore()
                .pruneStore(hostileInput as { storeRoot: string; registrationGenerations: []; archiveSha256s: [] })
                .pipe(Effect.flip),
        );
        expect(storeFailure).toMatchObject({ code: 'STORE_INVALID_INPUT' });
        expect(Object.isFrozen(storeFailure)).toBe(true);
        expect(storeFailure.message).not.toMatch(/private|[A-Z]:[\\/]/u);

        const optionFailure = await Effect.runPromise(
            service
                .prune(
                    new Proxy(
                        {},
                        {
                            ownKeys: () => {
                                throw new Error('D:/private-prune-options');
                            },
                        },
                    ),
                )
                .pipe(Effect.flip),
        );
        expect(optionFailure).toMatchObject({ code: 'STORE_MAINTENANCE_INVALID_INPUT' });
        expect(Object.isFrozen(optionFailure)).toBe(true);
        expect(optionFailure.message).not.toMatch(/private|[A-Z]:[\\/]/u);
    });

    it('rejects impossible canonical reports', () => {
        const missing = {
            schema: 'erden.store-status-report/v1',
            store: 'missing',
            transaction: 'idle',
            registrations: { total: 0, current: [], superseded: [], orphaned: [], stale: [], corrupt: [], busy: [] },
            objects: {
                total: 0,
                referenced: [],
                unreferenced: [],
                missingReferenced: [],
                busy: [],
                corrupt: [],
                logicalBytes: '0',
                unreferencedLogicalBytes: '0',
            },
            outcome: 'healthy',
        } as const;
        const project = {
            canonicalIri: 'https://example.test/report-project',
            alias: '@example/report-project',
        } as const;
        const generation = { registrationId: digest('1'), generationSha256: digest('2'), project } as const;
        const current = { ...generation, lockSha256: digest('3'), packages: 0 } as const;
        const available = {
            ...missing,
            store: 'available' as const,
            registrations: { ...missing.registrations, total: 1, current: [current] },
            objects: {
                ...missing.objects,
                total: 1,
                referenced: [digest('4')],
                logicalBytes: '1',
            },
        };
        const missingForgeries: unknown[] = [
            { ...missing, transaction: 'busy', outcome: 'issues' },
            { ...missing, outcome: 'issues' },
            { ...missing, registrations: { ...missing.registrations, corrupt: [digest('1')] } },
            { ...missing, registrations: { ...missing.registrations, busy: [digest('1')] } },
            { ...missing, registrations: { ...missing.registrations, total: 1, current: [current] } },
            { ...missing, objects: { ...missing.objects, total: 1, referenced: [digest('4')], logicalBytes: '1' } },
            {
                ...missing,
                objects: {
                    ...missing.objects,
                    total: 1,
                    unreferenced: [digest('4')],
                    logicalBytes: '1',
                    unreferencedLogicalBytes: '1',
                },
            },
            { ...missing, objects: { ...missing.objects, missingReferenced: [digest('4')] } },
            { ...missing, objects: { ...missing.objects, total: 1, busy: [digest('4')] }, outcome: 'issues' },
            { ...missing, objects: { ...missing.objects, total: 1, corrupt: [digest('4')] }, outcome: 'issues' },
            { ...missing, objects: { ...missing.objects, logicalBytes: '1' } },
            { ...missing, objects: { ...missing.objects, unreferencedLogicalBytes: '1' } },
        ];
        const classificationForgeries: unknown[] = [
            { ...available, registrations: { ...available.registrations, total: 2, superseded: [generation] } },
            {
                ...available,
                registrations: { ...available.registrations, corrupt: [generation.registrationId] },
                outcome: 'issues',
            },
            {
                ...available,
                registrations: { ...available.registrations, busy: [generation.registrationId] },
                outcome: 'issues',
            },
            {
                ...available,
                registrations: { ...missing.registrations, corrupt: [digest('5')], busy: [digest('5')] },
                outcome: 'issues',
            },
            {
                ...available,
                objects: { ...available.objects, total: 2, unreferenced: [digest('4')], unreferencedLogicalBytes: '1' },
            },
            { ...available, objects: { ...available.objects, missingReferenced: [digest('4')] }, outcome: 'issues' },
            { ...available, objects: { ...available.objects, total: 2, busy: [digest('4')] }, outcome: 'issues' },
            { ...available, objects: { ...available.objects, total: 2, corrupt: [digest('4')] }, outcome: 'issues' },
            { ...available, registrations: { ...available.registrations, total: 0 } },
            { ...available, objects: { ...available.objects, total: 0 } },
            { ...available, objects: { ...available.objects, logicalBytes: '0' } },
            { ...available, outcome: 'issues' },
        ];
        for (const forgery of [...missingForgeries, ...classificationForgeries]) {
            expect(() => decodeStoreStatusReport(forgery)).toThrow(TypeError);
        }
        expect(() =>
            decodeStorePruneReport({
                schema: 'erden.store-prune-report/v1',
                warning: `${STORE_PRUNE_REACQUISITION_WARNING}!`,
                dryRun: true,
                registrations: { total: 0, retired: [] },
                objects: { total: 0, removed: [], logicalBytes: '0' },
                outcome: 'nothing-to-prune',
            }),
        ).toThrow(TypeError);
    });

    it('roundtrips one closed bounded inline prune marker without filesystem mutation', () => {
        const directory = Object.freeze({ dev: '1', ino: '2', mode: '16832', kind: 'directory' as const });
        const marker: StoreAdminMarker = Object.freeze({
            format: 'erden.store-admin-transaction/v1',
            kind: 'prune',
            token: '0123456789abcdef',
            basis: Object.freeze({
                store: directory,
                objects: Object.freeze({ ...directory, ino: '3' }),
                registrations: Object.freeze({ ...directory, ino: '4' }),
                storeEntriesSha256: digest('c'),
                objectsEntriesSha256: digest('d'),
                registrationsEntriesSha256: digest('e'),
            }),
            plan: Object.freeze({ registrations: Object.freeze([]), objects: Object.freeze([]) }),
        });
        const encoded = encodeStoreAdminMarker(marker);
        const decoded = decodeStoreAdminMarker(encoded);
        expect(decoded).toEqual(marker);
        expect(decoded.kind).toBe('prune');
        if (decoded.kind !== 'prune') {
            throw new Error('expected prune marker');
        }
        expect(Object.isFrozen(decoded.plan)).toBe(true);
        const hostile = new Proxy(marker, {
            ownKeys: () => {
                throw new Error('D:/private-marker');
            },
        });
        expect(() => encodeStoreAdminMarker(hostile)).toThrow();
    });
});
