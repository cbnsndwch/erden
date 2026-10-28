import { constants, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeLockfileValue, manifestDependencyProjectionSha256, type LockToolchain } from '@erden/contracts';
import { encodePackage, PACKAGE_CODEC_LIMITS } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    buildInstallMarker,
    encodeInstallMarker,
    makeLocalPackageStore,
    makeInstalledClosureReader,
    makeNodeStoreFileSystemPort,
} from '../src/index.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = {
    validator: { version: '1.0.0', sha256: digest('a') },
    reasoner: { version: '1.0.0', sha256: digest('b') },
};
const A = 'https://example.test/a';
const B = 'https://example.test/b';

function fixture() {
    const b = encodePackage({
        canonicalIri: B,
        version: '1.0.0',
        dependencies: [],
        validator: TOOLCHAIN.validator,
        reasoner: TOOLCHAIN.reasoner,
        files: [{ path: 'b.ttl', bytes: '<urn:b> <urn:p> <urn:o> .\n', executable: false }],
    });
    const edge = { requested: '^1.0.0', canonicalIri: B, version: '1.0.0', archiveSha256: b.archiveSha256 };
    const a = encodePackage({
        canonicalIri: A,
        version: '1.0.0',
        dependencies: [edge],
        validator: TOOLCHAIN.validator,
        reasoner: TOOLCHAIN.reasoner,
        files: [
            { path: 'ontology/a.ttl', bytes: '<urn:a> <urn:p> <urn:o> .\n', executable: false },
            { path: 'bin/check', bytes: '#!/bin/sh\nexit 0\n', executable: true },
        ],
    });
    const lock = decodeLockfileValue({
        lockfileVersion: 1,
        registryOrigin: 'https://registry.example',
        manifestDependencySha256: manifestDependencyProjectionSha256({
            canonicalIri: 'https://example.test/root',
            alias: '@example/root',
            registryOrigin: 'https://registry.example',
            dependencies: { '@example/a': '^1.0.0' },
        }),
        root: { canonicalIri: 'https://example.test/root', alias: '@example/root' },
        directDependencies: [
            {
                identifier: '@example/a',
                requested: '^1.0.0',
                canonicalIri: A,
                version: '1.0.0',
                archiveSha256: a.archiveSha256,
            },
        ],
        aliasMappings: [{ alias: '@example/a', canonicalIri: A }],
        packages: [
            { canonicalIri: A, version: '1.0.0', archiveSha256: a.archiveSha256, dependencies: [edge] },
            { canonicalIri: B, version: '1.0.0', archiveSha256: b.archiveSha256, dependencies: [] },
        ],
        toolchain: TOOLCHAIN,
        counts: { directDependencies: 1, aliasMappings: 1, packages: 2, edges: 1 },
    });
    return { a, b, lock };
}

function emptyLock() {
    return decodeLockfileValue({
        lockfileVersion: 1,
        registryOrigin: null,
        manifestDependencySha256: manifestDependencyProjectionSha256({
            canonicalIri: 'https://example.test/root',
            alias: '@example/root',
            registryOrigin: null,
            dependencies: {},
        }),
        root: { canonicalIri: 'https://example.test/root', alias: '@example/root' },
        directDependencies: [],
        aliasMappings: [],
        packages: [],
        toolchain: TOOLCHAIN,
        counts: { directDependencies: 0, aliasMappings: 0, packages: 0, edges: 0 },
    });
}

function availabilityFixture() {
    const records = ['c', 'd', 'e'].map((name) => {
        const canonicalIri = `https://example.test/${name}`;
        const encoded = encodePackage({
            canonicalIri,
            version: '1.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [{ path: `${name}.ttl`, bytes: `<urn:${name}> <urn:p> <urn:o> .\n`, executable: false }],
        });
        return { canonicalIri, encoded };
    });
    const dependencyMap = Object.fromEntries(records.map(({ canonicalIri }) => [canonicalIri, '*']));
    const packages = records.map(({ canonicalIri, encoded }) => ({
        canonicalIri,
        version: '1.0.0',
        archiveSha256: encoded.archiveSha256,
        dependencies: [],
    }));
    const lock = decodeLockfileValue({
        lockfileVersion: 1,
        registryOrigin: 'https://registry.example',
        manifestDependencySha256: manifestDependencyProjectionSha256({
            canonicalIri: 'https://example.test/root',
            alias: '@example/root',
            registryOrigin: 'https://registry.example',
            dependencies: dependencyMap,
        }),
        root: { canonicalIri: 'https://example.test/root', alias: '@example/root' },
        directDependencies: packages.map((node) => ({
            identifier: node.canonicalIri,
            requested: '*',
            canonicalIri: node.canonicalIri,
            version: node.version,
            archiveSha256: node.archiveSha256,
        })),
        aliasMappings: [],
        packages,
        toolchain: TOOLCHAIN,
        counts: { directDependencies: 3, aliasMappings: 0, packages: 3, edges: 0 },
    });
    return { records, lock };
}

describe('LocalPackageStore', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) {
            cleanupTestTempRoot(root);
        }
    });

    it('ingests, verifies, materializes, and resolves an exact transitive lock offline', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const service = makeLocalPackageStore();
        for (const [encoded, expected] of [
            [a, lock.packages[0]],
            [b, lock.packages[1]],
        ] as const) {
            if (expected === undefined) {
                throw new Error('fixture package');
            }
            const stored = await Effect.runPromise(
                service.put({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: encoded.archiveBytes,
                }),
            );
            expect(stored.status).toBe('stored');
            const hit = await Effect.runPromise(
                service.put({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: encoded.archiveBytes,
                }),
            );
            expect(hit.status).toBe('hit');
        }
        await expect(Effect.runPromise(service.verifyLockAvailability({ storeRoot, lock }))).resolves.toMatchObject({
            status: 'available',
            packages: 2,
            missing: [],
            corrupt: [],
            busy: [],
        });
        const materialized = await Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }));
        expect(materialized.status).toBe('materialized');
        expect(materialized.strategies.clone + materialized.strategies.hardlink + materialized.strategies.copy).toBe(5);
        await expect(Effect.runPromise(service.inspectInstall({ projectRoot, lock }))).resolves.toMatchObject({
            status: 'available',
            packages: 2,
        });
        const layer = await Effect.runPromise(service.pathForLayer({ projectRoot, lock, identifier: '@example/a' }));
        expect(layer.canonicalIri).toBe(A);
        expect(await fs.readFile(join(layer.path, 'ontology', 'a.ttl'), 'utf8')).toContain('<urn:a>');
        const closure = await Effect.runPromise(service.resolveInstalledClosure({ projectRoot, lock }));
        expect(closure.layers.map(({ canonicalIri }) => canonicalIri)).toEqual(
            lock.packages.map(({ canonicalIri }) => canonicalIri),
        );
        expect(closure.layers[0]?.identifiers).toContain('@example/a');
        expect(Object.isFrozen(closure)).toBe(true);
        expect(Object.isFrozen(closure.layers)).toBe(true);
        expect(Object.isFrozen(closure.layers[0]?.identifiers)).toBe(true);
        expect(Object.isFrozen(closure.layers[0]?.files)).toBe(true);
        expect(closure.layers[0]?.files.map(({ path }) => path)).toEqual([
            '.erden/package-manifest.json',
            'bin/check',
            'ontology/a.ttl',
        ]);
        expect(closure.layers[0]?.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true);
        const reader = makeInstalledClosureReader();
        const authenticatedClosure = await Effect.runPromise(reader.resolve({ projectRoot, lock }));
        const authenticatedFile = await Effect.runPromise(
            reader.readFile({
                closure: authenticatedClosure,
                canonicalIri: A,
                path: 'ontology/a.ttl',
            }),
        );
        expect(new TextDecoder().decode(authenticatedFile.bytes)).toContain('<urn:a>');
        expect(Object.isFrozen(authenticatedFile)).toBe(true);
        await expect(Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }))).resolves.toMatchObject({
            status: 'hit',
        });
    });

    it('authenticates, quarantines, and replaces one corrupt object transactionally', async () => {
        const root = makeTestTempRoot('erden-store-repair-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const service = makeLocalPackageStore();
        await Effect.runPromise(
            service.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes }),
        );
        const damaged = join(storeRoot, 'objects', expected.archiveSha256, 'package', 'ontology', 'a.ttl');
        await fs.chmod(damaged, 0o644);
        await fs.writeFile(damaged, '<urn:x> <urn:p> <urn:o> .\n');
        await expect(Effect.runPromise(service.verifyLockAvailability({ storeRoot, lock }))).resolves.toMatchObject({
            status: 'unavailable',
            corrupt: [expected.archiveSha256],
        });
        const repaired = await Effect.runPromise(
            service.repair({
                storeRoot,
                expected,
                toolchain: lock.toolchain,
                archive: a.archiveBytes,
            }),
        );
        expect(repaired).toMatchObject({ status: 'repaired', cleanup: 'clean', archiveSha256: expected.archiveSha256 });
        expect(Object.isFrozen(repaired)).toBe(true);
        expect(await fs.readdir(join(storeRoot, 'objects'))).toContain(expected.archiveSha256);
        await expect(
            Effect.runPromise(service.inspect({ storeRoot, archiveSha256: expected.archiveSha256 })),
        ).resolves.toMatchObject({
            status: 'available',
            canonicalIri: expected.canonicalIri,
            version: expected.version,
        });
        expect(await fs.readFile(damaged, 'utf8')).toContain('<urn:a>');
        expect((await fs.readdir(join(storeRoot, 'objects'))).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('preserves the authenticated corrupt object when replacement validation fails', async () => {
        const root = makeTestTempRoot('erden-store-repair-invalid-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, b, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const service = makeLocalPackageStore();
        await Effect.runPromise(
            service.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes }),
        );
        const damaged = join(storeRoot, 'objects', expected.archiveSha256, 'package', 'ontology', 'a.ttl');
        await fs.chmod(damaged, 0o644);
        const damagedBytes = '<urn:x> <urn:p> <urn:o> .\n';
        await fs.writeFile(damaged, damagedBytes);
        await expect(
            Effect.runPromise(
                service.repair({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: b.archiveBytes,
                }),
            ),
        ).rejects.toMatchObject({ code: 'STORE_ARCHIVE_DIGEST_MISMATCH' });
        expect(await fs.readFile(damaged, 'utf8')).toBe(damagedBytes);
        await expect(
            Effect.runPromise(service.inspect({ storeRoot, archiveSha256: expected.archiveSha256 })),
        ).resolves.toMatchObject({ status: 'repair-required' });
        expect((await fs.readdir(join(storeRoot, 'objects'))).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('restores the corrupt object when a post-quarantine precommit verification fails', async () => {
        const root = makeTestTempRoot('erden-store-repair-restore-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const base = makeLocalPackageStore();
        await Effect.runPromise(base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes }));
        const damaged = join(storeRoot, 'objects', expected.archiveSha256, 'package', 'ontology', 'a.ttl');
        await fs.chmod(damaged, 0o644);
        const damagedBytes = '<urn:x> <urn:p> <urn:o> .\n';
        await fs.writeFile(damaged, damagedBytes);
        let quarantined = false;
        let failed = false;
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rename: async (source, destination) => {
                    await fs.rename(source, destination);
                    if (String(source).endsWith(expected.archiveSha256) && String(destination).includes('.backup-')) {
                        quarantined = true;
                    }
                },
                open: async (path, flags, mode) => {
                    if (
                        quarantined &&
                        !failed &&
                        String(path).includes('.stage-') &&
                        String(path).endsWith('object.json') &&
                        flags === 'r'
                    ) {
                        failed = true;
                        throw Object.assign(new Error('post-quarantine verification failed'), { code: 'EIO' });
                    }
                    return await fs.open(path, flags, mode);
                },
            }),
        );
        await expect(
            Effect.runPromise(
                service.repair({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: a.archiveBytes,
                }),
            ),
        ).rejects.toMatchObject({ code: 'STORE_IO_FAILURE' });
        expect(quarantined).toBe(true);
        expect(failed).toBe(true);
        expect(await fs.readFile(damaged, 'utf8')).toBe(damagedBytes);
        await expect(
            Effect.runPromise(base.inspect({ storeRoot, archiveSha256: expected.archiveSha256 })),
        ).resolves.toMatchObject({ status: 'repair-required' });
        expect((await fs.readdir(join(storeRoot, 'objects'))).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('reconciles repaired-object publication and reports authenticated cleanup debt', async () => {
        const root = makeTestTempRoot('erden-store-repair-commit-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const base = makeLocalPackageStore();
        await Effect.runPromise(base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes }));
        const damaged = join(storeRoot, 'objects', expected.archiveSha256, 'package', 'ontology', 'a.ttl');
        await fs.chmod(damaged, 0o644);
        await fs.writeFile(damaged, '<urn:x> <urn:p> <urn:o> .\n');
        let movedThenThrew = false;
        const moved = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rename: async (source, destination) => {
                    await fs.rename(source, destination);
                    if (
                        !movedThenThrew &&
                        String(source).includes('.stage-') &&
                        String(destination).endsWith(expected.archiveSha256)
                    ) {
                        movedThenThrew = true;
                        throw Object.assign(new Error('publication moved then threw'), { code: 'EIO' });
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                moved.repair({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: a.archiveBytes,
                }),
            ),
        ).resolves.toMatchObject({ status: 'repaired', cleanup: 'clean' });
        expect(movedThenThrew).toBe(true);

        await fs.chmod(damaged, 0o644);
        await fs.writeFile(damaged, '<urn:y> <urn:p> <urn:o> .\n');
        const debt = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rmdir: async (path) => {
                    if (String(path).includes('.backup-')) {
                        throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
                    }
                    await fs.rmdir(path);
                },
            }),
        );
        await expect(
            Effect.runPromise(
                debt.repair({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: a.archiveBytes,
                }),
            ),
        ).resolves.toMatchObject({ status: 'repaired', cleanup: 'cleanup-residue-retained' });
        expect((await fs.readdir(join(storeRoot, 'objects'))).some((name) => name.includes('.backup-'))).toBe(true);
    });

    it('rejects a repair stage that loses its exact canonical transaction spelling', async () => {
        const root = makeTestTempRoot('erden-store-repair-stage-alias-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const base = makeLocalPackageStore();
        await Effect.runPromise(base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes }));
        const damaged = join(storeRoot, 'objects', expected.archiveSha256, 'package', 'ontology', 'a.ttl');
        await fs.chmod(damaged, 0o644);
        const damagedBytes = '<urn:x> <urn:p> <urn:o> .\n';
        await fs.writeFile(damaged, damagedBytes);
        let aliased = false;
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                chmod: async (path, mode) => {
                    await fs.chmod(path, mode);
                    if (!aliased && mode === 0o555 && basename(String(path)).includes('.stage-')) {
                        aliased = true;
                        const hop = `${String(path)}.case-hop`;
                        await fs.rename(path, hop);
                        await fs.rename(hop, join(dirname(String(path)), basename(String(path)).toUpperCase()));
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                service.repair({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: a.archiveBytes,
                }),
            ),
        ).rejects.toBeInstanceOf(Error);
        expect(aliased).toBe(true);
        expect(await fs.readFile(damaged, 'utf8')).toBe(damagedBytes);
        expect((await fs.readdir(join(storeRoot, 'objects'))).some((name) => name.includes('.STAGE-'))).toBe(true);
    });

    it('retains evidence and fails rollback-unsafe when a quarantine loses canonical spelling', async () => {
        const root = makeTestTempRoot('erden-store-repair-backup-alias-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const base = makeLocalPackageStore();
        await Effect.runPromise(base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes }));
        const damaged = join(storeRoot, 'objects', expected.archiveSha256, 'package', 'ontology', 'a.ttl');
        await fs.chmod(damaged, 0o644);
        await fs.writeFile(damaged, '<urn:x> <urn:p> <urn:o> .\n');
        let aliased = false;
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rename: async (source, destination) => {
                    await fs.rename(source, destination);
                    if (!aliased && String(destination).includes('.backup-')) {
                        aliased = true;
                        const hop = `${String(destination)}.case-hop`;
                        await fs.rename(destination, hop);
                        await fs.rename(
                            hop,
                            join(dirname(String(destination)), basename(String(destination)).toUpperCase()),
                        );
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                service.repair({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: a.archiveBytes,
                }),
            ),
        ).rejects.toMatchObject({ code: 'STORE_ROLLBACK_UNSAFE' });
        expect(aliased).toBe(true);
        const names = await fs.readdir(join(storeRoot, 'objects'));
        expect(names.some((name) => name.includes('.BACKUP-'))).toBe(true);
        expect(names.some((name) => name.includes('.stage-'))).toBe(true);
    });

    it('reports the complete deterministic missing closure without writing or fetching', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const { lock } = fixture();
        const service = makeLocalPackageStore();
        const result = await Effect.runPromise(
            service.verifyLockAvailability({ storeRoot: join(root, 'missing'), lock }),
        );
        expect(result.status).toBe('unavailable');
        expect(result.missing).toEqual([...lock.packages.map(({ archiveSha256 }) => archiveSha256)].sort());
        await expect(fs.access(join(root, 'missing'))).rejects.toBeDefined();
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.missing)).toBe(true);
    });

    it('preflights lock-node identity and reports a valid wrong object as corrupt before project writes', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, lock } = fixture();
        const service = makeLocalPackageStore();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        await Effect.runPromise(
            service.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes }),
        );
        const forgedIri = 'https://example.test/forged';
        const forged = decodeLockfileValue({
            ...lock,
            manifestDependencySha256: manifestDependencyProjectionSha256({
                canonicalIri: 'https://example.test/root',
                alias: '@example/root',
                registryOrigin: 'https://registry.example',
                dependencies: { [forgedIri]: '^1.0.0' },
            }),
            directDependencies: [
                {
                    ...lock.directDependencies[0],
                    identifier: forgedIri,
                    canonicalIri: forgedIri,
                },
            ],
            aliasMappings: [],
            packages: [{ ...expected, canonicalIri: forgedIri, dependencies: [] }],
            counts: { directDependencies: 1, aliasMappings: 0, packages: 1, edges: 0 },
        });
        const availability = await Effect.runPromise(service.verifyLockAvailability({ storeRoot, lock: forged }));
        expect(availability).toMatchObject({ status: 'unavailable', corrupt: [expected.archiveSha256] });
        await expect(
            Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock: forged })),
        ).rejects.toMatchObject({
            code: 'STORE_REPAIR_REQUIRED',
        });
        await expect(fs.access(join(projectRoot, '.erden'))).rejects.toBeDefined();
    });

    it('transactionally replaces a valid old install and restores it when the new swap fails', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const service = makeLocalPackageStore();
        for (const [encoded, expected] of [
            [a, lock.packages[0]],
            [b, lock.packages[1]],
        ] as const) {
            if (expected === undefined) {
                throw new Error('fixture package');
            }
            await Effect.runPromise(
                service.put({ storeRoot, expected, toolchain: lock.toolchain, archive: encoded.archiveBytes }),
            );
        }
        await Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }));
        const next = emptyLock();
        let failed = false;
        const failing = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rename: async (source, destination) => {
                    if (!failed && String(source).includes('.erden.stage-') && String(destination).endsWith('.erden')) {
                        failed = true;
                        throw Object.assign(new Error('injected swap failure'), { code: 'EIO' });
                    }
                    await fs.rename(source, destination);
                },
            }),
        );
        await expect(
            Effect.runPromise(failing.materialize({ storeRoot, projectRoot, lock: next })),
        ).rejects.toMatchObject({
            code: 'STORE_IO_FAILURE',
        });
        await expect(Effect.runPromise(service.inspectInstall({ projectRoot, lock }))).resolves.toMatchObject({
            status: 'available',
        });
        expect((await fs.readdir(projectRoot)).filter((name) => name.startsWith('.erden.'))).toEqual([]);
        await expect(
            Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock: next })),
        ).resolves.toMatchObject({
            status: 'materialized',
            packages: 0,
        });
        await expect(Effect.runPromise(service.inspectInstall({ projectRoot, lock: next }))).resolves.toMatchObject({
            status: 'available',
        });
    });

    it('cleans an ordinary wrong-digest ingest without making the object busy', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const wrong = { ...expected, archiveSha256: digest('d') };
        const service = makeLocalPackageStore();
        await expect(
            Effect.runPromise(
                service.put({ storeRoot, expected: wrong, toolchain: lock.toolchain, archive: a.archiveBytes }),
            ),
        ).rejects.toMatchObject({ code: 'STORE_ARCHIVE_DIGEST_MISMATCH' });
        expect(await fs.readdir(join(storeRoot, 'objects'))).toEqual([]);
        await expect(
            Effect.runPromise(service.inspect({ storeRoot, archiveSha256: wrong.archiveSha256 })),
        ).resolves.toMatchObject({ status: 'missing' });
    });

    it('reconciles a final object rename that moved and then threw', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        let injected = false;
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rename: async (source, destination) => {
                    await fs.rename(source, destination);
                    if (
                        !injected &&
                        String(source).includes('.stage-') &&
                        String(destination).endsWith(expected.archiveSha256)
                    ) {
                        injected = true;
                        throw Object.assign(new Error('moved then threw'), { code: 'EIO' });
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(service.put({ storeRoot, expected, toolchain: lock.toolchain, archive: a.archiveBytes })),
        ).resolves.toMatchObject({ status: 'stored' });
        await expect(
            Effect.runPromise(service.inspect({ storeRoot, archiveSha256: expected.archiveSha256 })),
        ).resolves.toMatchObject({ status: 'available' });
    });

    it('rolls back an interrupted put observed during the final stage verification', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        let releaseRead: (() => void) | undefined;
        let observeRead: (() => void) | undefined;
        const readReached = new Promise<void>((resolve) => {
            observeRead = resolve;
        });
        const readRelease = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        let paused = false;
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                open: async (path, flags, mode) => {
                    const handle = await fs.open(path, flags, mode);
                    if (
                        !paused &&
                        String(path).includes('.stage-') &&
                        String(path).endsWith('object.json') &&
                        flags === 'r'
                    ) {
                        paused = true;
                        observeRead?.();
                        await readRelease;
                    }
                    return handle;
                },
            }),
        );
        const fiber = Effect.runFork(
            service.put({
                storeRoot,
                expected,
                toolchain: lock.toolchain,
                archive: a.archiveBytes,
            }),
        );
        await readReached;
        const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
        releaseRead?.();
        await interrupted;
        await expect(fs.access(join(storeRoot, 'objects', expected.archiveSha256))).rejects.toBeDefined();
        expect(await fs.readdir(join(storeRoot, 'objects'))).toEqual([]);
        await expect(
            Effect.runPromise(service.inspect({ storeRoot, archiveSha256: expected.archiveSha256 })),
        ).resolves.toMatchObject({ status: 'missing' });
    });

    it('rejects case-aliased final object, install, and store transaction names on every platform', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const first = lock.packages[0];
        const second = lock.packages[1];
        if (first === undefined || second === undefined) {
            throw new Error('fixture package');
        }
        const service = makeLocalPackageStore();
        await Effect.runPromise(
            service.put({ storeRoot, expected: first, toolchain: lock.toolchain, archive: a.archiveBytes }),
        );
        const objectRoot = join(storeRoot, 'objects', first.archiveSha256);
        const aliasedObjectRoot = join(storeRoot, 'objects', first.archiveSha256.toUpperCase());
        await fs.rename(objectRoot, aliasedObjectRoot);
        await expect(
            Effect.runPromise(service.inspect({ storeRoot, archiveSha256: first.archiveSha256 })),
        ).rejects.toMatchObject({ code: 'STORE_REPAIR_REQUIRED' });
        await expect(Effect.runPromise(service.verifyLockAvailability({ storeRoot, lock }))).rejects.toMatchObject({
            code: 'STORE_REPAIR_REQUIRED',
        });
        await expect(
            Effect.runPromise(
                service.put({ storeRoot, expected: first, toolchain: lock.toolchain, archive: a.archiveBytes }),
            ),
        ).rejects.toMatchObject({ code: 'STORE_REPAIR_REQUIRED' });
        await fs.rename(aliasedObjectRoot, objectRoot);
        await Effect.runPromise(
            service.put({ storeRoot, expected: second, toolchain: lock.toolchain, archive: b.archiveBytes }),
        );
        await Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }));
        const installRoot = join(projectRoot, '.erden');
        const aliasedInstallRoot = join(projectRoot, '.ERDEN');
        await fs.rename(installRoot, aliasedInstallRoot);
        await expect(Effect.runPromise(service.inspectInstall({ projectRoot, lock }))).rejects.toMatchObject({
            code: 'INSTALL_REPAIR_REQUIRED',
        });
        await expect(
            Effect.runPromise(service.pathForLayer({ projectRoot, lock, identifier: A })),
        ).rejects.toMatchObject({ code: 'INSTALL_REPAIR_REQUIRED' });
        await expect(Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }))).rejects.toMatchObject({
            code: 'INSTALL_REPAIR_REQUIRED',
        });

        const stageStore = join(root, 'stage-store');
        await fs.mkdir(join(stageStore, 'objects'), { recursive: true, mode: 0o700 });
        await fs.chmod(stageStore, 0o700);
        await fs.chmod(join(stageStore, 'objects'), 0o700);
        const aliasedStage = `.${first.archiveSha256.toUpperCase()}.stage-0123456789abcdef`;
        await fs.mkdir(join(stageStore, 'objects', aliasedStage));
        await expect(
            Effect.runPromise(service.inspect({ storeRoot: stageStore, archiveSha256: first.archiveSha256 })),
        ).rejects.toMatchObject({ code: 'STORE_REPAIR_REQUIRED' });
    });

    it('rejects canonical object and install entries that disappear during their final parent scan', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const first = lock.packages[0];
        const second = lock.packages[1];
        if (first === undefined || second === undefined) {
            throw new Error('fixture package');
        }
        const base = makeLocalPackageStore();
        await Effect.runPromise(
            base.put({ storeRoot, expected: first, toolchain: lock.toolchain, archive: a.archiveBytes }),
        );
        const objectsRoot = join(storeRoot, 'objects');
        const objectRoot = join(objectsRoot, first.archiveSha256);
        const movedObject = join(objectsRoot, 'foreign-object');
        let objectScans = 0;
        const objectService = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                opendir: async (path, options) => {
                    if (String(path) === objectsRoot && ++objectScans === 3) {
                        await fs.rename(objectRoot, movedObject);
                    }
                    return await fs.opendir(path, options);
                },
            }),
        );
        await expect(
            Effect.runPromise(objectService.inspect({ storeRoot, archiveSha256: first.archiveSha256 })),
        ).rejects.toMatchObject({ code: 'STORE_REPAIR_REQUIRED' });
        await expect(fs.access(objectRoot)).rejects.toBeDefined();
        await fs.rename(movedObject, objectRoot);

        await Effect.runPromise(
            base.put({ storeRoot, expected: second, toolchain: lock.toolchain, archive: b.archiveBytes }),
        );
        await Effect.runPromise(base.materialize({ storeRoot, projectRoot, lock }));
        const installRoot = join(projectRoot, '.erden');
        const movedInstall = join(projectRoot, 'foreign-install');
        let projectScans = 0;
        const installService = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                opendir: async (path, options) => {
                    if (String(path) === projectRoot && ++projectScans === 2) {
                        await fs.rename(installRoot, movedInstall);
                    }
                    return await fs.opendir(path, options);
                },
            }),
        );
        await expect(
            Effect.runPromise(installService.pathForLayer({ projectRoot, lock, identifier: A })),
        ).rejects.toMatchObject({ code: 'INSTALL_REPAIR_REQUIRED' });
        await expect(fs.access(installRoot)).rejects.toBeDefined();
    });

    it('rejects symlinked project roots before materialization writes', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const realProject = join(root, 'real-project');
        const projectRoot = join(root, 'project-link');
        const storeRoot = join(root, 'store');
        await fs.mkdir(realProject);
        await fs.mkdir(storeRoot, { mode: 0o700 });
        await fs.chmod(storeRoot, 0o700);
        await fs.symlink(realProject, projectRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const service = makeLocalPackageStore();
        await expect(
            Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock: emptyLock() })),
        ).rejects.toBeInstanceOf(Error);
        await expect(fs.access(join(realProject, '.erden'))).rejects.toBeDefined();
    });

    it('rejects an empty install whose layers container is a file', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const projectRoot = join(root, 'project');
        const installRoot = join(projectRoot, '.erden');
        await fs.mkdir(installRoot, { recursive: true, mode: 0o755 });
        const lock = emptyLock();
        const marker = buildInstallMarker(lock, new Map());
        await fs.writeFile(join(installRoot, 'install.json'), encodeInstallMarker(marker), { mode: 0o444 });
        await fs.writeFile(join(installRoot, 'layers'), '', { mode: 0o444 });
        await fs.chmod(join(installRoot, 'install.json'), 0o444);
        await fs.chmod(join(installRoot, 'layers'), 0o444);
        await fs.chmod(installRoot, 0o555);
        await expect(
            Effect.runPromise(makeLocalPackageStore().inspectInstall({ projectRoot, lock })),
        ).resolves.toMatchObject({
            status: 'repair-required',
        });
    });

    it('bounds a forged object marker before allocating its sparse file size', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const archiveSha256 = digest('d');
        const objectRoot = join(storeRoot, 'objects', archiveSha256);
        await fs.mkdir(join(objectRoot, 'package'), { recursive: true, mode: 0o755 });
        await fs.writeFile(join(objectRoot, 'archive.erdenpkg'), 'x');
        const handle = await fs.open(join(objectRoot, 'object.json'), 'w');
        await handle.truncate(16 * 1024 * 1024 + 1);
        await handle.close();
        await fs.chmod(storeRoot, 0o700);
        await fs.chmod(join(storeRoot, 'objects'), 0o700);
        await fs.chmod(objectRoot, 0o555);
        await expect(
            Effect.runPromise(makeLocalPackageStore().inspect({ storeRoot, archiveSha256 })),
        ).resolves.toMatchObject({
            status: 'repair-required',
        });
    });

    it('recovers an authenticated backup-only crash and rejects noncanonical transaction residue', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const service = makeLocalPackageStore();
        for (const [encoded, expected] of [
            [a, lock.packages[0]],
            [b, lock.packages[1]],
        ] as const) {
            if (expected === undefined) {
                throw new Error('fixture package');
            }
            await Effect.runPromise(
                service.put({ storeRoot, expected, toolchain: lock.toolchain, archive: encoded.archiveBytes }),
            );
        }
        await Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }));
        await fs.rename(join(projectRoot, '.erden'), join(projectRoot, '.erden.backup-0123456789abcdef'));
        await expect(Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }))).resolves.toMatchObject({
            status: 'hit',
            cleanup: 'clean',
        });
        await fs.mkdir(join(projectRoot, '.ERDEN.STAGE-0123456789abcdef'));
        await expect(Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }))).rejects.toMatchObject({
            code: 'INSTALL_REPAIR_REQUIRED',
        });
    });

    it('reports postcommit cleanup debt while retaining the fully authenticated new install', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const base = makeLocalPackageStore();
        for (const [encoded, expected] of [
            [a, lock.packages[0]],
            [b, lock.packages[1]],
        ] as const) {
            if (expected === undefined) {
                throw new Error('fixture package');
            }
            await Effect.runPromise(
                base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: encoded.archiveBytes }),
            );
        }
        await Effect.runPromise(base.materialize({ storeRoot, projectRoot, lock }));
        const next = emptyLock();
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rmdir: async (path) => {
                    if (String(path).includes('.erden.backup-')) {
                        throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
                    }
                    await fs.rmdir(path);
                },
            }),
        );
        await expect(
            Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock: next })),
        ).resolves.toMatchObject({
            status: 'materialized',
            cleanup: 'cleanup-residue-retained',
            packages: 0,
        });
        await expect(Effect.runPromise(base.inspectInstall({ projectRoot, lock: next }))).resolves.toMatchObject({
            status: 'available',
        });
    });

    it('rejects same-inode same-length layer drift introduced while a later layer is read', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const base = makeLocalPackageStore();
        for (const [encoded, expected] of [
            [a, lock.packages[0]],
            [b, lock.packages[1]],
        ] as const) {
            if (expected === undefined) {
                throw new Error('fixture package');
            }
            await Effect.runPromise(
                base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: encoded.archiveBytes }),
            );
        }
        await Effect.runPromise(base.materialize({ storeRoot, projectRoot, lock }));
        const aLayer = await Effect.runPromise(base.pathForLayer({ projectRoot, lock, identifier: A }));
        const aFile = join(aLayer.path, 'ontology', 'a.ttl');
        let changed = false;
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                open: async (path, flags, mode) => {
                    if (!changed && String(path).endsWith('b.ttl') && flags === 'r') {
                        changed = true;
                        await fs.chmod(aFile, 0o644);
                        const handle = await fs.open(aFile, 'r+');
                        try {
                            await handle.write(new TextEncoder().encode('<urn:x>'), 0, 7, 0);
                            await handle.sync();
                        } finally {
                            await handle.close();
                        }
                        await fs.chmod(aFile, 0o444);
                    }
                    return await fs.open(path, flags, mode);
                },
            }),
        );
        await expect(
            Effect.runPromise(service.pathForLayer({ projectRoot, lock, identifier: A })),
        ).rejects.toMatchObject({
            code: 'INSTALL_REPAIR_REQUIRED',
        });
        expect(changed).toBe(true);
    });

    it('restores the authenticated old install on final stage verification failure and interruption after backup', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { a, b, lock } = fixture();
        const base = makeLocalPackageStore();
        for (const [encoded, expected] of [
            [a, lock.packages[0]],
            [b, lock.packages[1]],
        ] as const) {
            if (expected === undefined) {
                throw new Error('fixture package');
            }
            await Effect.runPromise(
                base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: encoded.archiveBytes }),
            );
        }
        await Effect.runPromise(base.materialize({ storeRoot, projectRoot, lock }));
        const next = emptyLock();
        let failed = false;
        const failing = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                open: async (path, flags, mode) => {
                    if (
                        !failed &&
                        String(path).includes('.erden.stage-') &&
                        String(path).endsWith('install.json') &&
                        flags === 'r'
                    ) {
                        failed = true;
                        throw Object.assign(new Error('final stage verification failed'), { code: 'EIO' });
                    }
                    return await fs.open(path, flags, mode);
                },
            }),
        );
        await expect(
            Effect.runPromise(failing.materialize({ storeRoot, projectRoot, lock: next })),
        ).rejects.toMatchObject({
            code: 'STORE_IO_FAILURE',
        });
        await expect(Effect.runPromise(base.inspectInstall({ projectRoot, lock }))).resolves.toMatchObject({
            status: 'available',
        });

        let releaseBackup: (() => void) | undefined;
        let observeBackup: (() => void) | undefined;
        const backupReached = new Promise<void>((resolve) => {
            observeBackup = resolve;
        });
        const backupRelease = new Promise<void>((resolve) => {
            releaseBackup = resolve;
        });
        const interrupting = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                rename: async (source, destination) => {
                    await fs.rename(source, destination);
                    if (String(source).endsWith('.erden') && String(destination).includes('.erden.backup-')) {
                        observeBackup?.();
                        await backupRelease;
                    }
                },
            }),
        );
        const fiber = Effect.runFork(interrupting.materialize({ storeRoot, projectRoot, lock: next }));
        await backupReached;
        const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
        releaseBackup?.();
        await interrupted;
        await expect(Effect.runPromise(base.inspectInstall({ projectRoot, lock }))).resolves.toMatchObject({
            status: 'available',
        });
    });

    it('preserves unauthenticated stage residue when mkdir creates and then throws for put and materialize', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const { a, lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const storeRoot = join(root, 'store');
        let storeInjected = false;
        const storeService = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                mkdir: async (path, options) => {
                    await fs.mkdir(path, options);
                    if (!storeInjected && String(path).includes('.stage-')) {
                        storeInjected = true;
                        throw Object.assign(new Error('created then threw'), { code: 'EIO' });
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                storeService.put({
                    storeRoot,
                    expected,
                    toolchain: lock.toolchain,
                    archive: a.archiveBytes,
                }),
            ),
        ).rejects.toMatchObject({ code: 'STORE_ROLLBACK_UNSAFE' });
        expect((await fs.readdir(join(storeRoot, 'objects'))).some((name) => name.includes('.stage-'))).toBe(true);

        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        let installInjected = false;
        const installService = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                mkdir: async (path, options) => {
                    await fs.mkdir(path, options);
                    if (!installInjected && String(path).includes('.erden.stage-')) {
                        installInjected = true;
                        throw Object.assign(new Error('created then threw'), { code: 'EIO' });
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                installService.materialize({
                    storeRoot: join(root, 'unused-store'),
                    projectRoot,
                    lock: emptyLock(),
                }),
            ),
        ).rejects.toMatchObject({ code: 'INSTALL_ROLLBACK_UNSAFE' });
        expect((await fs.readdir(projectRoot)).some((name) => name.startsWith('.erden.stage-'))).toBe(true);
    });

    it('materializes identical authenticated bytes through clone, hardlink, and copy strategies', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const { a, b, lock } = fixture();
        const base = makeLocalPackageStore();
        for (const [encoded, expected] of [
            [a, lock.packages[0]],
            [b, lock.packages[1]],
        ] as const) {
            if (expected === undefined) {
                throw new Error('fixture package');
            }
            await Effect.runPromise(
                base.put({ storeRoot, expected, toolchain: lock.toolchain, archive: encoded.archiveBytes }),
            );
        }
        const outputs: Uint8Array[] = [];
        for (const strategy of ['clone', 'hardlink', 'copy'] as const) {
            const projectRoot = join(root, strategy);
            await fs.mkdir(projectRoot);
            const service =
                strategy === 'clone'
                    ? makeLocalPackageStore(
                          makeNodeStoreFileSystemPort({
                              copyFile: async (source, destination, flags) => {
                                  const selected =
                                      ((flags ?? 0) & constants.COPYFILE_FICLONE_FORCE) === 0
                                          ? flags
                                          : constants.COPYFILE_EXCL;
                                  await fs.copyFile(source, destination, selected);
                              },
                          }),
                      )
                    : strategy === 'hardlink'
                      ? makeLocalPackageStore(
                            makeNodeStoreFileSystemPort({
                                copyFile: async () => {
                                    await Promise.resolve();
                                    throw Object.assign(new Error('clone unavailable'), { code: 'ENOTSUP' });
                                },
                            }),
                        )
                      : makeLocalPackageStore(
                            makeNodeStoreFileSystemPort({
                                copyFile: async (source, destination, flags) => {
                                    if (((flags ?? 0) & constants.COPYFILE_FICLONE_FORCE) !== 0) {
                                        throw Object.assign(new Error('clone unavailable'), { code: 'ENOTSUP' });
                                    }
                                    await fs.copyFile(source, destination, flags);
                                },
                                link: async () => {
                                    await Promise.resolve();
                                    throw Object.assign(new Error('hardlink unavailable'), { code: 'EXDEV' });
                                },
                            }),
                        );
            const result = await Effect.runPromise(service.materialize({ storeRoot, projectRoot, lock }));
            expect(result.strategies[strategy]).toBeGreaterThan(0);
            expect(Object.values(result.strategies).reduce((sum, count) => sum + count, 0)).toBe(5);
            const layer = await Effect.runPromise(service.pathForLayer({ projectRoot, lock, identifier: A }));
            outputs.push(await fs.readFile(join(layer.path, 'ontology', 'a.ttl')));
        }
        expect(outputs).toHaveLength(3);
        expect(new Set(outputs.map((bytes) => Buffer.from(bytes).toString('hex'))).size).toBe(1);
        const storeFile = join(storeRoot, 'objects', a.archiveSha256, 'package', 'ontology', 'a.ttl');
        const copyLayer = await Effect.runPromise(
            base.pathForLayer({ projectRoot: join(root, 'copy'), lock, identifier: A }),
        );
        const copyLayerFile = join(copyLayer.path, 'ontology', 'a.ttl');
        const originalStoreBytes = await fs.readFile(storeFile);
        await fs.chmod(copyLayerFile, 0o644);
        await fs.writeFile(copyLayerFile, '<urn:x> <urn:p> <urn:o> .\n');
        expect(await fs.readFile(storeFile)).toEqual(originalStoreBytes);
    });

    it('aggregates corrupt, busy, and missing store objects deterministically and detects installed tampering', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const { records, lock } = availabilityFixture();
        const first = records[0];
        const second = records[1];
        const third = records[2];
        const expected = lock.packages[0];
        if (first === undefined || second === undefined || third === undefined || expected === undefined) {
            throw new Error('availability fixture');
        }
        const service = makeLocalPackageStore();
        await Effect.runPromise(
            service.put({
                storeRoot,
                expected,
                toolchain: lock.toolchain,
                archive: first.encoded.archiveBytes,
            }),
        );
        const corruptFile = join(storeRoot, 'objects', expected.archiveSha256, 'package', 'c.ttl');
        await fs.chmod(corruptFile, 0o644);
        await fs.writeFile(corruptFile, '<urn:x> <urn:p> <urn:o> .\n');
        await fs.mkdir(join(storeRoot, 'objects', `.${second.encoded.archiveSha256}.stage-0123456789abcdef`));
        await expect(Effect.runPromise(service.verifyLockAvailability({ storeRoot, lock }))).resolves.toEqual({
            status: 'unavailable',
            packages: 3,
            missing: [third.encoded.archiveSha256],
            corrupt: [first.encoded.archiveSha256],
            busy: [second.encoded.archiveSha256],
        });

        const { a, b, lock: installedLock } = fixture();
        const installedStore = join(root, 'installed-store');
        for (const [encoded, node] of [
            [a, installedLock.packages[0]],
            [b, installedLock.packages[1]],
        ] as const) {
            if (node === undefined) {
                throw new Error('fixture package');
            }
            await Effect.runPromise(
                service.put({
                    storeRoot: installedStore,
                    expected: node,
                    toolchain: installedLock.toolchain,
                    archive: encoded.archiveBytes,
                }),
            );
        }
        await Effect.runPromise(service.materialize({ storeRoot: installedStore, projectRoot, lock: installedLock }));
        const installedLayer = await Effect.runPromise(
            service.pathForLayer({ projectRoot, lock: installedLock, identifier: B }),
        );
        const installedFile = join(installedLayer.path, 'b.ttl');
        await fs.chmod(installedFile, 0o644);
        await fs.writeFile(installedFile, '<urn:x> <urn:p> <urn:o> .\n');
        await expect(
            Effect.runPromise(service.inspectInstall({ projectRoot, lock: installedLock })),
        ).resolves.toMatchObject({ status: 'repair-required' });
        await expect(
            Effect.runPromise(service.pathForLayer({ projectRoot, lock: installedLock, identifier: B })),
        ).rejects.toMatchObject({ code: 'INSTALL_REPAIR_REQUIRED' });
    });

    it('materializes the canonical empty lock without an existing store under a restrictive umask', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const storeRoot = join(root, 'absent-store');
        const projectRoot = join(root, 'project');
        await fs.mkdir(projectRoot);
        const lock = emptyLock();
        const previousUmask = process.umask(0o077);
        try {
            await expect(
                Effect.runPromise(makeLocalPackageStore().materialize({ storeRoot, projectRoot, lock })),
            ).resolves.toMatchObject({
                status: 'materialized',
                packages: 0,
                strategies: { clone: 0, hardlink: 0, copy: 0 },
            });
        } finally {
            process.umask(previousUmask);
        }
        await expect(fs.access(storeRoot)).rejects.toBeDefined();
        await expect(
            Effect.runPromise(makeLocalPackageStore().inspectInstall({ projectRoot, lock })),
        ).resolves.toMatchObject({ status: 'available', packages: 0 });
        if (process.platform !== 'win32') {
            expect((await fs.lstat(join(projectRoot, '.erden'))).mode & 0o7777).toBe(0o555);
            expect((await fs.lstat(join(projectRoot, '.erden', 'layers'))).mode & 0o7777).toBe(0o555);
            expect((await fs.lstat(join(projectRoot, '.erden', 'install.json'))).mode & 0o7777).toBe(0o444);
        }
    });

    it('checks direct and streamed archive chunk bounds before copying or writing them', async () => {
        const root = makeTestTempRoot('erden-store-');
        roots.push(root);
        const { lock } = fixture();
        const expected = lock.packages[0];
        if (expected === undefined) {
            throw new Error('fixture package');
        }
        const oversized = new Proxy(new Uint8Array(), {
            get: (_target, property) => {
                if (property === 'byteLength') {
                    return PACKAGE_CODEC_LIMITS.maxCompressedBytes + 1;
                }
                if (property === 'then') {
                    return undefined;
                }
                throw new Error('oversized archive must be rejected before copying');
            },
        });
        let writes = 0;
        const service = makeLocalPackageStore(
            makeNodeStoreFileSystemPort({
                write: async (...parameters) => {
                    writes += 1;
                    return await parameters[0].write(parameters[1], parameters[2], parameters[3], null);
                },
            }),
        );
        const directError = await Effect.runPromise(
            service.put({
                storeRoot: join(root, 'direct'),
                expected,
                toolchain: lock.toolchain,
                archive: oversized,
            }),
        ).then(
            () => undefined,
            (error: unknown) => error,
        );
        const streamed = {
            async *[Symbol.asyncIterator]() {
                await Promise.resolve();
                yield oversized;
            },
        };
        const streamedError = await Effect.runPromise(
            service.put({
                storeRoot: join(root, 'streamed'),
                expected,
                toolchain: lock.toolchain,
                archive: streamed,
            }),
        ).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(directError).toMatchObject({
            code: 'STORE_INVALID_INPUT',
            message: 'The package archive exceeds the closed compressed-byte bound',
        });
        expect(streamedError).toMatchObject({
            code: 'STORE_INVALID_INPUT',
            message: 'The package archive exceeds the closed compressed-byte bound',
        });
        expect(writes).toBe(0);
        expect(await fs.readdir(join(root, 'streamed', 'objects'))).toEqual([]);
    });
});
