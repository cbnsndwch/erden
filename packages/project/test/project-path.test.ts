import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    makeCurrentToolchainService,
    makeEmptyLockfile,
    normalizeManifestV1,
    serializeLockfileBytes,
    serializeManifestV1,
    type LoadedManifestV1,
    type LockToolchain,
} from '@erden/contracts';
import { encodePackage } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    ProjectPathError,
    LocalPackageStoreError,
    decodeProjectPathReport,
    encodeProjectPathReport,
    makeDependencyResolver,
    makeFixtureDependencyRegistry,
    makeProjectPathService,
    nodeProjectDependencyStateService,
    renderProjectPathError,
    renderProjectPathReport,
    type PathForLayerInput,
    type ProjectPathStateShape,
    type ProjectPathStoreShape,
    type ProjectLockInspection,
} from '../src/index.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: digest('a') }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: digest('b') }),
});
const PACKAGE_IRI = 'https://example.test/package-a';
const REGISTRY = 'https://registry.example';
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

async function fixture() {
    const manifest = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/project-b',
        alias: '@example/project-b',
        ownedIriPrefixes: ['https://example.test/project-b#'],
        registry: REGISTRY,
        dependencies: { '@example/package-a': '^1.0.0' },
        sources: { ontology: ['ontology.ttl'] },
    });
    const archive = encodePackage({
        canonicalIri: PACKAGE_IRI,
        version: '1.0.0',
        dependencies: [],
        validator: TOOLCHAIN.validator,
        reasoner: TOOLCHAIN.reasoner,
        files: [{ path: 'ontology.ttl', bytes: '<urn:a> <urn:p> <urn:o> .\n', executable: false }],
    });
    const registry = makeFixtureDependencyRegistry({
        registryOrigin: REGISTRY,
        aliases: [{ alias: '@example/package-a', canonicalIri: PACKAGE_IRI }],
        packages: [
            {
                canonicalIri: PACKAGE_IRI,
                version: '1.0.0',
                archiveSha256: archive.archiveSha256,
                manifest: archive.manifest,
                archive: archive.archiveBytes,
            },
        ],
    });
    const lock = (await Effect.runPromise(makeDependencyResolver(registry).resolve({ manifest, toolchain: TOOLCHAIN })))
        .lock;
    const root = resolve('project-b');
    const project: LoadedManifestV1 = Object.freeze({
        format: 'json',
        filePath: join(root, 'erden.config.json'),
        projectRoot: root,
        manifest,
        resolvedSources: Object.freeze({
            ontology: Object.freeze([join(root, 'ontology.ttl')]),
            shapes: Object.freeze([]),
            competencyQuestions: Object.freeze([]),
        }),
        resolvedCitationRoots: Object.freeze({}),
    });
    return { project, lock, archive };
}

function stateReader(
    project: LoadedManifestV1,
    lockInspection: ProjectLockInspection,
    onInspect: () => void = () => undefined,
    onRecheck: () => void = () => undefined,
): ProjectPathStateShape {
    const revision = Object.freeze({ schema: 'erden.project-dependency-state-revision/v1' as const });
    return Object.freeze({
        inspect: () => {
            onInspect();
            return Effect.succeed(
                Object.freeze({
                    project,
                    manifestBytes: new TextEncoder().encode('{}\n'),
                    lockInspection,
                    revision,
                }),
            );
        },
        recheck: () => {
            onRecheck();
            return Effect.void;
        },
    });
}

describe('ProjectPath', () => {
    it.each([
        ['empty-root', 'PROJECT_PATH_MANIFEST_UNAVAILABLE'],
        ['ambiguous-manifest', 'PROJECT_PATH_MANIFEST_UNAVAILABLE'],
        ['malformed-manifest', 'PROJECT_PATH_MANIFEST_UNAVAILABLE'],
        ['malformed-lock', 'PROJECT_PATH_LOCK_INVALID'],
        ['active-transaction', 'PROJECT_PATH_LOCK_INVALID'],
    ] as const)('classifies project dependency state %s precisely', async (scenario, expectedCode) => {
        const root = makeTestTempRoot('erden-path-state-classification-');
        roots.push(root);
        if (scenario !== 'empty-root') {
            const manifest = normalizeManifestV1({
                schemaVersion: 1,
                canonicalIri: 'https://example.test/path-state',
                alias: '@example/path-state',
                ownedIriPrefixes: ['https://example.test/path-state#'],
                sources: { ontology: ['ontology.ttl'] },
            });
            await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'), { mode: 0o644 });
            await fs.writeFile(join(root, 'ontology.ttl'), '<urn:s> <urn:p> <urn:o> .\n', { mode: 0o644 });
            await fs.writeFile(
                join(root, 'erden.lock'),
                serializeLockfileBytes(makeEmptyLockfile(manifest, TOOLCHAIN)),
                { mode: 0o644 },
            );
            if (scenario === 'ambiguous-manifest') {
                await fs.writeFile(join(root, 'erden.config.jsonc'), serializeManifestV1(manifest, 'jsonc'));
            } else if (scenario === 'malformed-manifest') {
                await fs.writeFile(join(root, 'erden.config.json'), '{ invalid json');
            } else if (scenario === 'malformed-lock') {
                await fs.writeFile(join(root, 'erden.lock'), 'not: canonical\n');
            } else {
                await fs.writeFile(join(root, '.erden.dependencies.transaction.json'), '{}\n');
            }
        }
        const service = makeProjectPathService(
            nodeProjectDependencyStateService,
            makeCurrentToolchainService(() => TOOLCHAIN),
            Object.freeze({ pathForLayer: () => Effect.die('store must not be called') }),
        );
        const failure = await Effect.runPromise(
            service.path({ identifier: PACKAGE_IRI, from: root }).pipe(Effect.flip),
        );
        expect(failure).toMatchObject({ code: expectedCode });
        expect(renderProjectPathError(failure)).not.toContain(root);
    });

    it('authenticates the manifest, lock, toolchain, and layer exactly once', async () => {
        const { project, lock, archive } = await fixture();
        const calls: string[] = [];
        const inspection: ProjectLockInspection = Object.freeze({
            status: 'available',
            lock,
            canonicalBytes: serializeLockfileBytes(lock),
            reasons: Object.freeze([]),
        });
        const physicalPath = join(project.projectRoot, '.erden', 'layers', archive.archiveSha256);
        const store: ProjectPathStoreShape = Object.freeze({
            pathForLayer: (input: PathForLayerInput) => {
                calls.push(`store:${input.identifier}`);
                return Effect.succeed(
                    Object.freeze({
                        identifier: input.identifier,
                        canonicalIri: PACKAGE_IRI,
                        version: '1.0.0',
                        archiveSha256: archive.archiveSha256,
                        path: physicalPath,
                    }),
                );
            },
        });
        const service = makeProjectPathService(
            stateReader(
                project,
                inspection,
                () => calls.push('state'),
                () => calls.push('recheck'),
            ),
            makeCurrentToolchainService(() => {
                calls.push('toolchain');
                return TOOLCHAIN;
            }),
            store,
        );
        const report = await Effect.runPromise(
            service.path({
                identifier: '@example/package-a',
                manifestPath: project.filePath,
            }),
        );
        expect(calls).toEqual(['toolchain', 'state', 'store:@example/package-a', 'recheck']);
        expect(report).toEqual({
            schema: 'erden.path-report/v1',
            project: { canonicalIri: project.manifest.canonicalIri, alias: project.manifest.alias },
            layer: {
                identifier: '@example/package-a',
                canonicalIri: PACKAGE_IRI,
                version: '1.0.0',
                archiveSha256: archive.archiveSha256,
                path: physicalPath,
            },
            outcome: 'resolved',
        });
        expect(Object.isFrozen(report)).toBe(true);
        expect(Object.isFrozen(report.layer)).toBe(true);
        expect(renderProjectPathReport(report)).toBe(`${physicalPath}\n`);
        expect(encodeProjectPathReport(report)).toBe(
            `${JSON.stringify({
                layer: {
                    archiveSha256: report.layer.archiveSha256,
                    canonicalIri: report.layer.canonicalIri,
                    identifier: report.layer.identifier,
                    path: report.layer.path,
                    version: report.layer.version,
                },
                outcome: 'resolved',
                project: { alias: report.project.alias, canonicalIri: report.project.canonicalIri },
                schema: 'erden.path-report/v1',
            })}\n`,
        );
        expect(decodeProjectPathReport(JSON.parse(encodeProjectPathReport(report)))).toEqual(report);
        expect(() =>
            decodeProjectPathReport({
                ...report,
                layer: { ...report.layer, path: `${physicalPath}\nunsafe` },
            }),
        ).toThrow('unsafe physical path');
        expect(() =>
            decodeProjectPathReport(
                new Proxy(
                    {},
                    {
                        getPrototypeOf: () => {
                            throw new Error('C:/private-path-report');
                        },
                    },
                ),
            ),
        ).toThrow('Invalid erden.path-report/v1 document');
    });

    it.each(['missing', 'stale'] as const)('fails before store access for a %s lock', async (status) => {
        const { project, lock } = await fixture();
        let storeCalls = 0;
        const inspection: ProjectLockInspection =
            status === 'missing'
                ? Object.freeze({ status, lock: null, canonicalBytes: null, reasons: Object.freeze([]) })
                : Object.freeze({
                      status,
                      lock,
                      canonicalBytes: serializeLockfileBytes(lock),
                      reasons: Object.freeze(['dependency-projection-changed' as const]),
                  });
        const service = makeProjectPathService(
            stateReader(project, inspection),
            makeCurrentToolchainService(() => TOOLCHAIN),
            Object.freeze({
                pathForLayer: () => {
                    storeCalls += 1;
                    return Effect.die('must not run');
                },
            }),
        );
        const failure = await Effect.runPromise(
            service.path({ identifier: PACKAGE_IRI, from: project.projectRoot }).pipe(Effect.flip),
        );
        expect(failure).toBeInstanceOf(ProjectPathError);
        expect(failure).toMatchObject({
            code: status === 'missing' ? 'PROJECT_PATH_LOCK_REQUIRED' : 'PROJECT_PATH_LOCK_STALE',
        });
        expect(Object.isFrozen(failure)).toBe(true);
        expect(renderProjectPathError(failure)).not.toContain(project.projectRoot);
        expect(storeCalls).toBe(0);
    });

    it('rejects hostile options and hostile store truth through typed path-free failures', async () => {
        const { project, lock } = await fixture();
        let manifestCalls = 0;
        const service = makeProjectPathService(
            stateReader(
                project,
                Object.freeze({
                    status: 'available' as const,
                    lock,
                    canonicalBytes: serializeLockfileBytes(lock),
                    reasons: Object.freeze([]),
                }),
                () => {
                    manifestCalls += 1;
                },
            ),
            makeCurrentToolchainService(() => TOOLCHAIN),
            Object.freeze({
                pathForLayer: () =>
                    Effect.succeed(
                        Object.defineProperty(
                            {
                                identifier: '@example/package-a',
                                canonicalIri: PACKAGE_IRI,
                                version: '1.0.0',
                                archiveSha256: lock.packages[0]?.archiveSha256,
                            },
                            'path',
                            {
                                enumerable: true,
                                get: () => {
                                    throw new Error('C:/private-layer');
                                },
                            },
                        ) as never,
                    ),
            }),
        );
        const hostile = new Proxy(
            { identifier: PACKAGE_IRI },
            {
                getPrototypeOf: () => {
                    throw new Error('C:/private-options');
                },
            },
        );
        const invalid = await Effect.runPromise(service.path(hostile).pipe(Effect.flip));
        expect(invalid).toMatchObject({ code: 'PROJECT_PATH_INVALID_INPUT' });
        expect(renderProjectPathError(invalid)).not.toMatch(/private|C:\//u);
        expect(manifestCalls).toBe(0);

        const storeFailure = await Effect.runPromise(
            service.path({ identifier: '@example/package-a', from: project.projectRoot }).pipe(Effect.flip),
        );
        expect(storeFailure).toMatchObject({ code: 'PROJECT_PATH_STORE_FAILURE' });
        expect(renderProjectPathError(storeFailure)).not.toMatch(/private|C:\//u);
    });

    it.each([
        ['LAYER_NOT_FOUND', 'PROJECT_PATH_LAYER_NOT_FOUND'],
        ['INSTALL_MISSING', 'PROJECT_PATH_INSTALL_UNAVAILABLE'],
        ['INSTALL_BUSY', 'PROJECT_PATH_INSTALL_UNAVAILABLE'],
        ['INSTALL_REPAIR_REQUIRED', 'PROJECT_PATH_INSTALL_UNAVAILABLE'],
        ['STORE_IO_FAILURE', 'PROJECT_PATH_STORE_FAILURE'],
    ] as const)('maps authenticated store status %s without exposing its cause', async (storeCode, expectedCode) => {
        const { project, lock } = await fixture();
        const service = makeProjectPathService(
            stateReader(
                project,
                Object.freeze({
                    status: 'available' as const,
                    lock,
                    canonicalBytes: serializeLockfileBytes(lock),
                    reasons: Object.freeze([]),
                }),
            ),
            makeCurrentToolchainService(() => TOOLCHAIN),
            Object.freeze({
                pathForLayer: () => Effect.fail(new LocalPackageStoreError(storeCode, 'C:/private-store-cause')),
            }),
        );
        const failure = await Effect.runPromise(
            service.path({ identifier: PACKAGE_IRI, from: project.projectRoot }).pipe(Effect.flip),
        );
        expect(failure).toMatchObject({ code: expectedCode });
        expect(renderProjectPathError(failure)).not.toContain('private-store');
    });

    it('normalizes hostile manifest truth before lock access and propagates interruption', async () => {
        const { project, lock } = await fixture();
        let lockCalls = 0;
        const hostileState = stateReader(
            new Proxy(project, {
                getPrototypeOf: () => {
                    throw new Error('C:/private-manifest');
                },
            }),
            Object.freeze({
                status: 'available',
                lock,
                canonicalBytes: serializeLockfileBytes(lock),
                reasons: Object.freeze([]),
            }),
            () => {
                lockCalls += 1;
            },
        );
        const invalid = await Effect.runPromise(
            makeProjectPathService(
                hostileState,
                makeCurrentToolchainService(() => TOOLCHAIN),
                Object.freeze({ pathForLayer: () => Effect.die('unused') }),
            )
                .path({ identifier: PACKAGE_IRI, from: project.projectRoot })
                .pipe(Effect.flip),
        );
        expect(invalid).toMatchObject({ code: 'PROJECT_PATH_MANIFEST_UNAVAILABLE' });
        expect(renderProjectPathError(invalid)).not.toContain('private-manifest');
        expect(lockCalls).toBe(1);

        let storeCalls = 0;
        const service = makeProjectPathService(
            stateReader(
                project,
                Object.freeze({
                    status: 'available' as const,
                    lock,
                    canonicalBytes: serializeLockfileBytes(lock),
                    reasons: Object.freeze([]),
                }),
            ),
            makeCurrentToolchainService(() => TOOLCHAIN),
            Object.freeze({
                pathForLayer: () => {
                    storeCalls += 1;
                    return Effect.never;
                },
            }),
        );
        const fiber = Effect.runFork(service.path({ identifier: PACKAGE_IRI, from: project.projectRoot }));
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
        await Effect.runPromise(Fiber.interrupt(fiber));
        expect(storeCalls).toBe(1);
    });
});
