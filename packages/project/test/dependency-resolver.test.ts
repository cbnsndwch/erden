import { Effect, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    REGISTRY_RELEASE_INDEX_LIMITS,
    type LockToolchain,
    type ManifestV1,
    type RegistryIndexRelease,
    type RegistryReleaseIndexPageV1,
    type RegistryReleaseIndexReaderShape,
} from '@erden/contracts';
import { encodePackage, type PackageManifestV1, type ReferenceResolvedDependency } from '@erden/package-format';

import {
    DependencyResolutionError,
    makeDependencyResolver,
    makeDependencyResolverFromReleaseIndex,
    type DependencyCatalogShape,
    type PublishedPackageRecord,
} from '../src/index.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: digest('a') }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: digest('b') }),
});

function manifest(
    dependencies: Readonly<Record<string, string>>,
    registry: string | null = 'https://registry.example',
): ManifestV1 {
    return {
        schemaVersion: 1,
        canonicalIri: 'https://example.test/root',
        alias: '@example/root',
        ownedIriPrefixes: ['https://example.test/root#'],
        sources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
        citationRoots: {},
        dependencies,
        ...(registry === null ? {} : { registry }),
    };
}

function published(
    canonicalIri: string,
    version: string,
    dependencies: ReadonlyArray<ReferenceResolvedDependency> = [],
    archiveSha256?: string,
    toolchain: LockToolchain = TOOLCHAIN,
): PublishedPackageRecord {
    const encoded = encodePackage({
        canonicalIri,
        version,
        dependencies,
        validator: toolchain.validator,
        reasoner: toolchain.reasoner,
        files: [],
    });
    return {
        canonicalIri,
        version,
        archiveSha256: archiveSha256 ?? encoded.archiveSha256,
        manifest: encoded.manifest,
    };
}

function publishedManifest(
    canonicalIri: string,
    dependencies: ReadonlyArray<ReferenceResolvedDependency>,
): PublishedPackageRecord {
    return {
        canonicalIri,
        version: '1.0.0',
        archiveSha256: digest('c'),
        manifest: {
            formatVersion: 1,
            archiveRoot: 'package/',
            generatedManifestPath: '.erden/package-manifest.json',
            canonicalIri,
            version: '1.0.0',
            dependencies,
            toolchain: TOOLCHAIN,
            files: [],
        } satisfies PackageManifestV1,
    };
}

interface FixtureCatalog extends DependencyCatalogShape {
    readonly aliasCalls: string[];
    readonly releaseCalls: string[];
}

function catalog(
    aliases: Readonly<Record<string, string>>,
    releases: Readonly<Record<string, ReadonlyArray<PublishedPackageRecord>>>,
): FixtureCatalog {
    const aliasCalls: string[] = [];
    const releaseCalls: string[] = [];
    return {
        aliasCalls,
        releaseCalls,
        resolveAlias: (_origin, alias) => {
            aliasCalls.push(alias);
            const canonicalIri = aliases[alias];
            return Promise.resolve(canonicalIri === undefined ? null : { alias, canonicalIri });
        },
        listPublished: (_origin, canonicalIri) => {
            releaseCalls.push(canonicalIri);
            return Promise.resolve([...(releases[canonicalIri] ?? [])]);
        },
    };
}

async function resolve(
    inputManifest: ManifestV1,
    fixtureCatalog: DependencyCatalogShape,
    options: Partial<Parameters<ReturnType<typeof makeDependencyResolver>['resolve']>[0]> = {},
) {
    return await Effect.runPromise(
        makeDependencyResolver(fixtureCatalog).resolve({
            manifest: inputManifest,
            toolchain: TOOLCHAIN,
            ...options,
        }),
    );
}

function compact(record: PublishedPackageRecord): RegistryIndexRelease {
    return {
        version: record.version,
        archiveSha256: record.archiveSha256,
        toolchain: record.manifest.toolchain,
        dependencies: record.manifest.dependencies,
    };
}

function indexPage(
    canonicalIri: string,
    releases: ReadonlyArray<RegistryIndexRelease>,
    pageOrdinal: number,
    releaseCount: number,
    nextCursor: string | null,
): RegistryReleaseIndexPageV1 {
    return {
        schema: 'erden.registry-release-index-page/v1',
        registryOrigin: 'https://registry.example',
        canonicalIri,
        watermark: 'w_1',
        pageOrdinal,
        releaseCount,
        releases,
        nextCursor,
    };
}

function maximalExactVersion(suffix: string): string {
    const prefix = '1.0.0+';
    return `${prefix}${'a'.repeat(256 - prefix.length - suffix.length)}${suffix}`;
}

function maximalCompactIri(index: number): string {
    const prefix = 'https://example.test/dependency/';
    const suffix = String(index).padStart(4, '0');
    return `${prefix}${'a'.repeat(1024 - prefix.length - suffix.length)}${suffix}`;
}

function maximalCompactRelease(version: string): RegistryIndexRelease {
    return {
        version,
        archiveSha256: digest('a'),
        toolchain: TOOLCHAIN,
        dependencies: Array.from({ length: REGISTRY_RELEASE_INDEX_LIMITS.maxDependenciesPerRelease }, (_, index) => ({
            requested: `${'1.0.0 || '.repeat(113)}1.0.0`,
            canonicalIri: maximalCompactIri(index),
            version: maximalExactVersion('d'),
            archiveSha256: digest('a'),
        })),
    };
}

describe('DependencyResolver', () => {
    it('returns the canonical empty lock without registry or catalog access', async () => {
        const fixture = catalog({}, {});
        const first = await resolve(manifest({}, null), fixture);
        const second = await resolve(manifest({}, 'https://unused.example'), fixture);
        expect(first.status).toBe('resolved');
        expect(first.lock.registryOrigin).toBeNull();
        expect(first.lock.directDependencies).toEqual([]);
        expect(first.lock.packages).toEqual([]);
        expect(first.lock.counts).toEqual({ directDependencies: 0, aliasMappings: 0, packages: 0, edges: 0 });
        expect(first.lockfileText).toBe(second.lockfileText);
        expect(fixture.aliasCalls).toEqual([]);
        expect(fixture.releaseCalls).toEqual([]);
        expect(Object.isFrozen(first.lock)).toBe(true);
    });

    it('requires a registry only for a nonempty dependency map', async () => {
        const fixture = catalog({}, {});
        await expect(resolve(manifest({ '@example/a': '^1.0.0' }, null), fixture)).rejects.toMatchObject({
            code: 'registry-required',
        });
        expect(fixture.aliasCalls).toEqual([]);
        expect(fixture.releaseCalls).toEqual([]);
    });

    it('coalesces compatible alias and canonical constraints while retaining both authored entries', async () => {
        const iri = 'https://example.test/a';
        const a1 = published(iri, '1.5.0');
        const fixture = catalog({ '@example/a': iri }, { [iri]: [a1] });
        const result = await resolve(manifest({ [iri]: '<2', '@example/a': '>=1' }), fixture);
        expect(result.lock.directDependencies).toEqual([
            expect.objectContaining({ identifier: '@example/a', canonicalIri: iri, version: '1.5.0' }),
            expect.objectContaining({ identifier: iri, canonicalIri: iri, version: '1.5.0' }),
        ]);
        expect(result.lock.aliasMappings).toEqual([{ alias: '@example/a', canonicalIri: iri }]);
        expect(result.lock.packages).toHaveLength(1);
    });

    it('backtracks from the highest dead end to the highest complete solution', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        const b1 = published(bIri, '1.0.0', [], digest('1'));
        const b2 = published(bIri, '2.0.0', [], digest('2'));
        const a1 = published(aIri, '1.0.0', [
            { requested: '^1.0.0', canonicalIri: bIri, version: b1.version, archiveSha256: b1.archiveSha256 },
        ]);
        const a2 = published(aIri, '2.0.0', [
            { requested: '^2.0.0', canonicalIri: bIri, version: b2.version, archiveSha256: b2.archiveSha256 },
        ]);
        const fixture = catalog({}, { [aIri]: [a1, a2], [bIri]: [b2, b1] });
        const result = await resolve(manifest({ [aIri]: '*', [bIri]: '^1' }), fixture);
        expect(result.lock.packages.map(({ canonicalIri, version }) => [canonicalIri, version])).toEqual([
            [aIri, '1.0.0'],
            [bIri, '1.0.0'],
        ]);
    });

    it('selects the highest target release compatible with exact non-target closure pins', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        const cIri = 'https://example.test/c';
        const c1 = published(cIri, '1.0.0', [], digest('1'));
        const c2 = published(cIri, '2.0.0', [], digest('2'));
        const a1 = published(
            aIri,
            '1.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c1.version, archiveSha256: c1.archiveSha256 }],
            digest('a'),
        );
        const a2 = published(
            aIri,
            '2.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c1.version, archiveSha256: c1.archiveSha256 }],
            digest('b'),
        );
        const a3 = published(
            aIri,
            '3.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c2.version, archiveSha256: c2.archiveSha256 }],
            digest('c'),
        );
        const b1 = published(
            bIri,
            '1.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c1.version, archiveSha256: c1.archiveSha256 }],
            digest('d'),
        );
        const b2 = published(
            bIri,
            '2.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c2.version, archiveSha256: c2.archiveSha256 }],
            digest('e'),
        );
        const input = manifest({ '@example/a': '*', '@example/b': '*' });
        const oldCatalog = catalog(
            { '@example/a': aIri, '@example/b': bIri },
            {
                [aIri]: [a1],
                [bIri]: [b1],
                [cIri]: [c1],
            },
        );
        const existing = (await resolve(input, oldCatalog)).lock;
        const updated = await resolve(
            input,
            catalog(
                { '@example/a': aIri, '@example/b': bIri },
                {
                    [aIri]: [a3, a2],
                    [bIri]: [b2],
                    [cIri]: [c2],
                },
            ),
            {
                existingLock: existing,
                selection: { kind: 'update-targeted-frozen', identifier: '@example/a' },
            },
        );
        expect(updated.lock.packages.map(({ canonicalIri, version }) => [canonicalIri, version])).toEqual([
            [aIri, '2.0.0'],
            [bIri, '1.0.0'],
            [cIri, '1.0.0'],
        ]);
    });

    it('reports a sorted frozen-shared conflict only when the pinned target remains current', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        const cIri = 'https://example.test/c';
        const c1 = published(cIri, '1.0.0', [], digest('1'));
        const c2 = published(cIri, '2.0.0', [], digest('2'));
        const a1 = published(
            aIri,
            '1.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c1.version, archiveSha256: c1.archiveSha256 }],
            digest('a'),
        );
        const a2 = published(
            aIri,
            '2.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c2.version, archiveSha256: c2.archiveSha256 }],
            digest('b'),
        );
        const b1 = published(
            bIri,
            '1.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c1.version, archiveSha256: c1.archiveSha256 }],
            digest('c'),
        );
        const b2 = published(
            bIri,
            '2.0.0',
            [{ requested: '*', canonicalIri: cIri, version: c2.version, archiveSha256: c2.archiveSha256 }],
            digest('d'),
        );
        const input = manifest({ '@example/a': '*', '@example/b': '*' });
        const existing = (
            await resolve(
                input,
                catalog(
                    { '@example/a': aIri, '@example/b': bIri },
                    {
                        [aIri]: [a1],
                        [bIri]: [b1],
                        [cIri]: [c1],
                    },
                ),
            )
        ).lock;
        const failure = await resolve(
            input,
            catalog(
                { '@example/a': aIri, '@example/b': bIri },
                {
                    [aIri]: [a2],
                    [bIri]: [b2],
                    [cIri]: [c2],
                },
            ),
            {
                existingLock: existing,
                selection: { kind: 'update-targeted-frozen', identifier: '@example/a' },
            },
        ).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(failure).toMatchObject({
            code: 'frozen-shared-conflict',
            frozenCanonicalIris: [bIri, cIri],
        });
        expect(Object.isFrozen((failure as DependencyResolutionError).frozenCanonicalIris)).toBe(true);
    });

    it('seeds authenticated current releases, never downgrades, and rejects same-version identity drift', async () => {
        const iri = 'https://example.test/a';
        const current = published(iri, '2.0.0', [], digest('a'));
        const input = manifest({ [iri]: '*' });
        const existing = (await resolve(input, catalog({}, { [iri]: [current] }))).lock;
        const seeded = await resolve(input, catalog({}, { [iri]: [published(iri, '1.0.0', [], digest('1'))] }), {
            existingLock: existing,
            selection: { kind: 'update-full-graph' },
        });
        expect(seeded.lock.packages[0]).toMatchObject({ version: '2.0.0', archiveSha256: digest('a') });

        await expect(
            resolve(input, catalog({}, { [iri]: [published(iri, '2.0.0', [], digest('b'))] }), {
                existingLock: existing,
                selection: { kind: 'update-full-graph' },
            }),
        ).rejects.toMatchObject({ code: 'catalog-identity-mismatch' });
    });

    it('requires a closed update policy and an exact authored targeted identifier', async () => {
        const iri = 'https://example.test/a';
        const input = manifest({ '@example/a': '*' });
        const releases = catalog({ '@example/a': iri }, { [iri]: [published(iri, '1.0.0')] });
        const existing = (await resolve(input, releases)).lock;
        await expect(
            resolve(input, releases, {
                existingLock: existing,
                selection: { kind: 'update-targeted-frozen', identifier: iri },
            }),
        ).rejects.toMatchObject({ code: 'invalid-resolver-input' });
        await expect(
            resolve(input, releases, {
                existingLock: existing,
                selection: { kind: 'update-full-graph', extra: true } as never,
            }),
        ).rejects.toMatchObject({ code: 'invalid-resolver-input' });
    });

    it('uses normal prerelease rules and a deterministic build-metadata tie break', async () => {
        const iri = 'https://example.test/a';
        const releases = [published(iri, '2.0.0-beta.2'), published(iri, '1.0.0+a'), published(iri, '1.0.0+z')];
        const stable = await resolve(manifest({ [iri]: '*' }), catalog({}, { [iri]: releases }));
        expect(stable.lock.packages[0]?.version).toBe('1.0.0+z');
        const prerelease = await resolve(
            manifest({ [iri]: '>=2.0.0-beta.1 <2.0.0' }),
            catalog({}, { [iri]: releases }),
        );
        expect(prerelease.lock.packages[0]?.version).toBe('2.0.0-beta.2');
    });

    it('produces identical lock bytes from legacy full manifests and visible compact index pages', async () => {
        const iri = 'https://example.test/a';
        const records = Array.from({ length: 33 }, (_, index) =>
            published(iri, index === 32 ? '1.0.0+build.z' : `0.${String(31 - index)}.0`),
        ).sort((left, right) => (left.version === '1.0.0+build.z' ? -1 : right.version === '1.0.0+build.z' ? 1 : 0));
        const legacy = await resolve(
            manifest({ '@example/a': '*' }),
            catalog({ '@example/a': iri }, { [iri]: records }),
        );
        const calls: string[] = [];
        const index: RegistryReleaseIndexReaderShape = {
            resolveAlias: (_origin, alias) => {
                calls.push(`alias:${alias}`);
                return Promise.resolve({
                    schema: 'erden.registry-alias-resolution/v1',
                    registryOrigin: 'https://registry.example',
                    alias,
                    canonicalIri: iri,
                });
            },
            listPage: (_origin, canonicalIri, cursor) => {
                calls.push(`page:${cursor ?? 'first'}`);
                return Promise.resolve(
                    cursor === null
                        ? indexPage(canonicalIri, records.slice(0, 32).map(compact), 0, 33, 'cursor_1')
                        : indexPage(canonicalIri, records.slice(32).map(compact), 1, 33, null),
                );
            },
            getExactRelease: () => Promise.resolve(null),
        };
        const indexed = await Effect.runPromise(
            makeDependencyResolverFromReleaseIndex(index).resolve({
                manifest: manifest({ '@example/a': '*' }),
                toolchain: TOOLCHAIN,
            }),
        );
        expect(indexed.lockfileText).toBe(legacy.lockfileText);
        expect(calls).toEqual(['alias:@example/a', 'page:first', 'page:cursor_1']);
    });

    it('charges every compact page to the shared remote-operation budget', async () => {
        const iri = 'https://example.test/a';
        const values = Array.from({ length: 33 }, (_, index) => compact(published(iri, `1.${String(32 - index)}.0`)));
        let pages = 0;
        const index: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: (_origin, canonicalIri, cursor) => {
                pages += 1;
                return Promise.resolve(
                    cursor === null
                        ? indexPage(canonicalIri, values.slice(0, 32), 0, 33, 'cursor_1')
                        : indexPage(canonicalIri, values.slice(32), 1, 33, null),
                );
            },
            getExactRelease: () => Promise.resolve(null),
        };
        await expect(
            Effect.runPromise(
                makeDependencyResolverFromReleaseIndex(index).resolve({
                    manifest: manifest({ [iri]: '*' }),
                    toolchain: TOOLCHAIN,
                    limits: { maxCatalogCalls: 1 },
                }),
            ),
        ).rejects.toMatchObject({ code: 'search-exhausted' });
        expect(pages).toBe(1);
    });

    it('rejects repeated/nonprogressing compact cursors and page context substitution', async () => {
        const iri = 'https://example.test/a';
        const first = compact(published(iri, '2.0.0'));
        const second = compact(published(iri, '1.0.0'));
        const repeated: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: (_origin, canonicalIri, cursor) =>
                Promise.resolve(
                    cursor === null
                        ? indexPage(canonicalIri, [first], 0, 2, 'cursor_1')
                        : indexPage(canonicalIri, [second], 1, 2, 'cursor_1'),
                ),
            getExactRelease: () => Promise.resolve(null),
        };
        await expect(
            Effect.runPromise(
                makeDependencyResolverFromReleaseIndex(repeated).resolve({
                    manifest: manifest({ [iri]: '*' }),
                    toolchain: TOOLCHAIN,
                }),
            ),
        ).rejects.toMatchObject({ code: 'catalog-incoherent' });

        const substituted: RegistryReleaseIndexReaderShape = {
            ...repeated,
            listPage: () => Promise.resolve(indexPage('https://example.test/substituted', [first], 0, 1, null)),
        };
        await expect(
            Effect.runPromise(
                makeDependencyResolverFromReleaseIndex(substituted).resolve({
                    manifest: manifest({ [iri]: '*' }),
                    toolchain: TOOLCHAIN,
                }),
            ),
        ).rejects.toMatchObject({ code: 'catalog-incoherent' });
    });

    it('rejects every compact pagination context, progress, and terminal-count mismatch', async () => {
        const iri = 'https://example.test/a';
        const first = compact(published(iri, '2.0.0'));
        const second = compact(published(iri, '1.0.0'));
        const cases: ReadonlyArray<
            Readonly<{
                readonly name: string;
                readonly next: RegistryReleaseIndexReaderShape['listPage'];
            }>
        > = [
            {
                name: 'missing continuation',
                next: () => Promise.resolve(null),
            },
            {
                name: 'ordinal substitution',
                next: (_origin, canonicalIri) => Promise.resolve(indexPage(canonicalIri, [second], 2, 2, null)),
            },
            {
                name: 'watermark substitution',
                next: (_origin, canonicalIri) =>
                    Promise.resolve({
                        ...indexPage(canonicalIri, [second], 1, 2, null),
                        watermark: 'w_2',
                    }),
            },
            {
                name: 'release-count substitution',
                next: (_origin, canonicalIri) => Promise.resolve(indexPage(canonicalIri, [second], 1, 3, null)),
            },
            {
                name: 'cross-page overlap',
                next: (_origin, canonicalIri) => Promise.resolve(indexPage(canonicalIri, [first], 1, 2, null)),
            },
            {
                name: 'terminal count mismatch',
                next: (_origin, canonicalIri) => Promise.resolve(indexPage(canonicalIri, [second], 1, 3, null)),
            },
        ];
        for (const scenario of cases) {
            let calls = 0;
            const index: RegistryReleaseIndexReaderShape = {
                resolveAlias: () => Promise.resolve(null),
                listPage: (origin, canonicalIri, cursor, signal) => {
                    calls += 1;
                    return cursor === null
                        ? Promise.resolve(
                              indexPage(
                                  canonicalIri,
                                  [first],
                                  0,
                                  scenario.name === 'terminal count mismatch' ? 3 : 2,
                                  'cursor_1',
                              ),
                          )
                        : scenario.next(origin, canonicalIri, cursor, signal);
                },
                getExactRelease: () => Promise.resolve(null),
            };
            await expect(
                Effect.runPromise(
                    makeDependencyResolverFromReleaseIndex(index).resolve({
                        manifest: manifest({ [iri]: '*' }),
                        toolchain: TOOLCHAIN,
                    }),
                ),
                scenario.name,
            ).rejects.toMatchObject({ code: 'catalog-incoherent' });
            expect(calls, scenario.name).toBe(2);
        }
    });

    it('enforces compact page-count and decoded-metadata budgets before further calls', async () => {
        const iri = 'https://example.test/a';
        let pageCalls = 0;
        const endless: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: (_origin, canonicalIri) => {
                const ordinal = pageCalls;
                pageCalls += 1;
                return Promise.resolve(
                    indexPage(
                        canonicalIri,
                        [compact(published(iri, `1.${String(2_048 - ordinal)}.0`))],
                        ordinal,
                        2_048,
                        `cursor_${String(ordinal + 1)}`,
                    ),
                );
            },
            getExactRelease: () => Promise.resolve(null),
        };
        await expect(
            Effect.runPromise(
                makeDependencyResolverFromReleaseIndex(endless).resolve({
                    manifest: manifest({ [iri]: '*' }),
                    toolchain: TOOLCHAIN,
                }),
            ),
        ).rejects.toMatchObject({ code: 'resolution-limit' });
        expect(pageCalls).toBe(64);

        let metadataCalls = 0;
        const onePage: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: (_origin, canonicalIri) => {
                metadataCalls += 1;
                return Promise.resolve(indexPage(canonicalIri, [compact(published(iri, '1.0.0'))], 0, 1, null));
            },
            getExactRelease: () => Promise.resolve(null),
        };
        await expect(
            Effect.runPromise(
                makeDependencyResolverFromReleaseIndex(onePage).resolve({
                    manifest: manifest({ [iri]: '*' }),
                    toolchain: TOOLCHAIN,
                    limits: { maxCatalogMetadataBytes: 1 },
                }),
            ),
        ).rejects.toMatchObject({ code: 'resolution-limit' });
        expect(metadataCalls).toBe(1);
    });

    it('rejects an individually valid compact release aggregate over the page byte cap', async () => {
        const iri = 'https://example.test/a';
        const releases = Array.from({ length: 7 }, (_, index) =>
            maximalCompactRelease(maximalExactVersion(String(7 - index))),
        );
        let calls = 0;
        const index: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: (_origin, canonicalIri) => {
                calls += 1;
                return Promise.resolve(indexPage(canonicalIri, releases, 0, releases.length, null));
            },
            getExactRelease: () => Promise.resolve(null),
        };
        await expect(
            Effect.runPromise(
                makeDependencyResolverFromReleaseIndex(index).resolve({
                    manifest: manifest({ [iri]: '*' }),
                    toolchain: TOOLCHAIN,
                }),
            ),
        ).rejects.toMatchObject({ code: 'catalog-incoherent' });
        expect(calls).toBe(1);
    }, 30_000);

    it('rejects hostile compact port values without invoking their accessors', async () => {
        const iri = 'https://example.test/a';
        let reads = 0;
        const hostile = indexPage(iri, [compact(published(iri, '1.0.0'))], 0, 1, null);
        Object.defineProperty(hostile, 'pageOrdinal', {
            enumerable: true,
            get: () => {
                reads += 1;
                return 0;
            },
        });
        const index: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: () => Promise.resolve(hostile),
            getExactRelease: () => Promise.resolve(null),
        };
        await expect(
            Effect.runPromise(
                makeDependencyResolverFromReleaseIndex(index).resolve({
                    manifest: manifest({ [iri]: '*' }),
                    toolchain: TOOLCHAIN,
                }),
            ),
        ).rejects.toMatchObject({ code: 'catalog-incoherent' });
        expect(reads).toBe(0);
    });

    it('aborts an active compact-index call on interruption and starts no later page', async () => {
        const iri = 'https://example.test/a';
        let calls = 0;
        let aborted = false;
        let startedResolve!: () => void;
        const started = new Promise<void>((resolveStarted) => {
            startedResolve = resolveStarted;
        });
        const index: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: (_origin, _canonicalIri, _cursor, signal) => {
                calls += 1;
                startedResolve();
                return new Promise((_resolvePage, rejectPage) => {
                    signal?.addEventListener(
                        'abort',
                        () => {
                            aborted = true;
                            rejectPage(new Error('aborted'));
                        },
                        { once: true },
                    );
                });
            },
            getExactRelease: () => Promise.resolve(null),
        };
        const fiber = Effect.runFork(
            makeDependencyResolverFromReleaseIndex(index).resolve({
                manifest: manifest({ [iri]: '*' }),
                toolchain: TOOLCHAIN,
            }),
        );
        await started;
        await Effect.runPromise(Fiber.interrupt(fiber));
        expect(aborted).toBe(true);
        expect(calls).toBe(1);
    });

    it('starts no later page when a signal-ignoring compact-index call resolves after interruption', async () => {
        const iri = 'https://example.test/a';
        let calls = 0;
        let resolveFirst!: (page: RegistryReleaseIndexPageV1) => void;
        let startedResolve!: () => void;
        let abortedResolve!: () => void;
        const started = new Promise<void>((resolveStarted) => {
            startedResolve = resolveStarted;
        });
        const aborted = new Promise<void>((resolveAborted) => {
            abortedResolve = resolveAborted;
        });
        const index: RegistryReleaseIndexReaderShape = {
            resolveAlias: () => Promise.resolve(null),
            listPage: (_origin, _canonicalIri, _cursor, signal) => {
                calls += 1;
                if (calls > 1) {
                    return Promise.reject(new Error('a later page must not start'));
                }
                startedResolve();
                signal?.addEventListener('abort', abortedResolve, { once: true });
                return new Promise((resolvePage) => {
                    resolveFirst = resolvePage;
                });
            },
            getExactRelease: () => Promise.resolve(null),
        };
        const fiber = Effect.runFork(
            makeDependencyResolverFromReleaseIndex(index).resolve({
                manifest: manifest({ [iri]: '*' }),
                toolchain: TOOLCHAIN,
            }),
        );
        await started;
        const interruption = Effect.runPromise(Fiber.interrupt(fiber));
        await aborted;
        resolveFirst(indexPage(iri, [compact(published(iri, '2.0.0'))], 0, 2, 'cursor_1'));
        await interruption;
        await Promise.resolve();
        expect(calls).toBe(1);
    });

    it('rejects alias retargeting before release discovery and permits an empty lock to adopt a registry', async () => {
        const oldIri = 'https://example.test/old';
        const nextIri = 'https://example.test/next';
        const first = await resolve(
            manifest({ '@example/a': '*' }),
            catalog({ '@example/a': oldIri }, { [oldIri]: [published(oldIri, '1.0.0')] }),
        );
        const changed = catalog({ '@example/a': nextIri }, { [nextIri]: [published(nextIri, '1.0.0')] });
        await expect(
            resolve(manifest({ '@example/a': '*' }), changed, { existingLock: first.lock }),
        ).rejects.toMatchObject({
            code: 'alias-retarget',
        });
        expect(changed.releaseCalls).toEqual([]);

        const empty = await resolve(manifest({}, null), catalog({}, {}));
        const adopted = await resolve(
            manifest({ [oldIri]: '*' }),
            catalog({}, { [oldIri]: [published(oldIri, '1.0.0')] }),
            { existingLock: empty.lock },
        );
        expect(adopted.lock.registryOrigin).toBe('https://registry.example');
    });

    it('reports deterministic exact constraint provenance for an unsatisfiable one-version conflict', async () => {
        const iri = 'https://example.test/a';
        const fixture = catalog({ '@example/a': iri }, { [iri]: [published(iri, '1.0.0'), published(iri, '2.0.0')] });
        const error = await resolve(manifest({ '@example/a': '^1', [iri]: '^2' }), fixture).then(
            () => undefined,
            (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(DependencyResolutionError);
        expect(error).toMatchObject({ code: 'version-conflict' });
        expect((error as DependencyResolutionError).conflict).toEqual({
            canonicalIri: iri,
            depth: 0,
            constraints: [
                {
                    source: { kind: 'root', identifier: '@example/a' },
                    requested: '^1',
                    exactVersion: null,
                    archiveSha256: null,
                },
                {
                    source: { kind: 'root', identifier: iri },
                    requested: '^2',
                    exactVersion: null,
                    archiveSha256: null,
                },
            ],
        });
        expect(new TextEncoder().encode((error as Error).message).byteLength).toBeLessThanOrEqual(64 * 1_024);
        expect(Object.keys(error as object)).not.toContain('cause');
    });

    it('preserves the deepest nested contradiction and every exact edge constraint across unwind', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        const cIri = 'https://example.test/c';
        const c1 = published(cIri, '1.0.0', [], digest('c'));
        const c2 = published(cIri, '2.0.0', [], digest('d'));
        const a = published(aIri, '1.0.0', [
            { requested: '^1.0.0', canonicalIri: cIri, version: c1.version, archiveSha256: c1.archiveSha256 },
        ]);
        const b = published(bIri, '1.0.0', [
            { requested: '^2.0.0', canonicalIri: cIri, version: c2.version, archiveSha256: c2.archiveSha256 },
        ]);
        const input = manifest({ [bIri]: '*', [aIri]: '*' });
        const firstError = await resolve(input, catalog({}, { [cIri]: [c2, c1], [bIri]: [b], [aIri]: [a] })).then(
            () => undefined,
            (failure: unknown) => failure,
        );
        const secondError = await resolve(input, catalog({}, { [aIri]: [a], [cIri]: [c1, c2], [bIri]: [b] })).then(
            () => undefined,
            (failure: unknown) => failure,
        );
        expect(firstError).toBeInstanceOf(DependencyResolutionError);
        expect(secondError).toBeInstanceOf(DependencyResolutionError);
        expect((firstError as DependencyResolutionError).message).toBe(
            (secondError as DependencyResolutionError).message,
        );
        expect((firstError as DependencyResolutionError).conflict).toEqual({
            canonicalIri: cIri,
            depth: 1,
            constraints: [
                {
                    source: { kind: 'package-edge', fromCanonicalIri: aIri, fromVersion: '1.0.0' },
                    requested: '^1.0.0',
                    exactVersion: '1.0.0',
                    archiveSha256: digest('c'),
                },
                {
                    source: { kind: 'package-edge', fromCanonicalIri: bIri, fromVersion: '1.0.0' },
                    requested: '^2.0.0',
                    exactVersion: '2.0.0',
                    archiveSha256: digest('d'),
                },
            ],
        });
        expect(Object.isFrozen((firstError as DependencyResolutionError).conflict?.constraints)).toBe(true);
    });

    it('rejects cycles and root self-dependencies with stable logical paths', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        const a = published(
            aIri,
            '1.0.0',
            [{ requested: '*', canonicalIri: bIri, version: '1.0.0', archiveSha256: digest('b') }],
            digest('a'),
        );
        const b = published(
            bIri,
            '1.0.0',
            [{ requested: '*', canonicalIri: aIri, version: '1.0.0', archiveSha256: digest('a') }],
            digest('b'),
        );
        await expect(
            resolve(manifest({ [aIri]: '*' }), catalog({}, { [aIri]: [a], [bIri]: [b] })),
        ).rejects.toMatchObject({
            code: 'dependency-cycle',
            message: `The selected package graph cycles (2 edges): ${aIri} -> ${bIri} -> ${aIri}`,
        });

        const rootEdge = published(aIri, '1.0.0', [
            {
                requested: '*',
                canonicalIri: 'https://example.test/root',
                version: '1.0.0',
                archiveSha256: digest('c'),
            },
        ]);
        await expect(resolve(manifest({ [aIri]: '*' }), catalog({}, { [aIri]: [rootEdge] }))).rejects.toMatchObject({
            code: 'self-dependency',
        });

        const validPackage = published(aIri, '1.0.0', [], digest('a'));
        const packageSelf: PublishedPackageRecord = {
            ...validPackage,
            manifest: {
                ...validPackage.manifest,
                dependencies: [{ requested: '*', canonicalIri: aIri, version: '1.0.0', archiveSha256: digest('a') }],
            },
        };
        await expect(resolve(manifest({ [aIri]: '*' }), catalog({}, { [aIri]: [packageSelf] }))).rejects.toMatchObject({
            code: 'catalog-incoherent',
        });
    });

    it('bounds the complete cycle diagnostic and reports the exact omitted edge count', async () => {
        const packageCount = 70;
        const iris = Array.from(
            { length: packageCount },
            (_, index) => `https://example.test/${'x'.repeat(970)}${String(index).padStart(2, '0')}`,
        );
        const records: Record<string, ReadonlyArray<PublishedPackageRecord>> = {};
        for (let index = 0; index < packageCount; index += 1) {
            const canonicalIri = iris[index] as string;
            const nextIri = iris[(index + 1) % packageCount] as string;
            records[canonicalIri] = [
                publishedManifest(canonicalIri, [
                    {
                        requested: '1.0.0',
                        canonicalIri: nextIri,
                        version: '1.0.0',
                        archiveSha256: digest('c'),
                    },
                ]),
            ];
        }
        const failure = await resolve(manifest({ [iris[0] as string]: '*' }), catalog({}, records)).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(failure).toMatchObject({
            code: 'dependency-cycle',
            message: `The selected package graph contains a cycle at ${iris[0] as string} with ${String(packageCount)} edges`,
        });
        expect(new TextEncoder().encode((failure as Error).message).byteLength).toBeLessThanOrEqual(64 * 1_024);
    });

    it('backtracks from a cyclic highest assignment and restores every mutable branch record', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        const b = published(
            bIri,
            '1.0.0',
            [
                {
                    requested: '2.0.0',
                    canonicalIri: aIri,
                    version: '2.0.0',
                    archiveSha256: digest('2'),
                },
            ],
            digest('b'),
        );
        const high = published(
            aIri,
            '2.0.0',
            [
                {
                    requested: '1.0.0',
                    canonicalIri: bIri,
                    version: '1.0.0',
                    archiveSha256: digest('b'),
                },
            ],
            digest('2'),
        );
        const low = published(aIri, '1.0.0', [], digest('1'));
        const input = manifest({ [aIri]: '*' });
        const first = await resolve(input, catalog({}, { [aIri]: [high, low], [bIri]: [b] }));
        const second = await resolve(input, catalog({}, { [bIri]: [b], [aIri]: [low, high] }));
        expect(first.lock.packages).toEqual([
            expect.objectContaining({ canonicalIri: aIri, version: '1.0.0', dependencies: [] }),
        ]);
        expect(first.lockfileText).toBe(second.lockfileText);
    });

    it('fails closed on missing releases, toolchain mismatch, exact edge pins, and catalog failures', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        await expect(resolve(manifest({ [aIri]: '*' }), catalog({}, {}))).rejects.toMatchObject({
            code: 'missing-version',
        });
        const otherToolchain: LockToolchain = {
            validator: { version: '2.0.0', sha256: digest('d') },
            reasoner: TOOLCHAIN.reasoner,
        };
        await expect(
            resolve(
                manifest({ [aIri]: '*' }),
                catalog({}, { [aIri]: [published(aIri, '1.0.0', [], undefined, otherToolchain)] }),
            ),
        ).rejects.toMatchObject({ code: 'toolchain-incompatible' });

        const b = published(bIri, '1.0.0', [], digest('b'));
        const a = published(aIri, '1.0.0', [
            {
                requested: '*',
                canonicalIri: bIri,
                version: '1.0.0',
                archiveSha256: digest('c'),
            },
        ]);
        await expect(
            resolve(manifest({ [aIri]: '*' }), catalog({}, { [aIri]: [a], [bIri]: [b] })),
        ).rejects.toMatchObject({
            code: 'version-conflict',
        });

        const failureCatalog: DependencyCatalogShape = {
            resolveAlias: () => Promise.resolve(null),
            listPublished: () => Promise.reject(new Error('D:/physical-secret')),
        };
        const error = await resolve(manifest({ [aIri]: '*' }), failureCatalog).then(
            () => undefined,
            (failure: unknown) => failure,
        );
        expect(error).toMatchObject({ code: 'catalog-failure', message: 'The dependency catalog operation failed' });
        expect(JSON.stringify(error)).not.toContain('physical-secret');
        expect(Object.keys(error as object)).not.toContain('cause');
    });

    it('classifies a published edge that violates npm prerelease range semantics as catalog incoherence', async () => {
        const aIri = 'https://example.test/a';
        const bIri = 'https://example.test/b';
        const record = publishedManifest(aIri, [
            {
                requested: '*',
                canonicalIri: bIri,
                version: '1.0.0-beta.1',
                archiveSha256: digest('b'),
            },
        ]);
        await expect(resolve(manifest({ [aIri]: '*' }), catalog({}, { [aIri]: [record] }))).rejects.toMatchObject({
            code: 'catalog-incoherent',
        });
    });

    it('rejects sparse, accessor-bearing, extra-field, duplicate, and mismatched catalog records', async () => {
        const iri = 'https://example.test/a';
        const validRecord = published(iri, '1.0.0');
        const invalidSets: unknown[] = [];
        invalidSets.push(new Array(1));
        const extra = [validRecord] as PublishedPackageRecord[] & { extra?: boolean };
        extra.extra = true;
        invalidSets.push(extra);
        const accessor: PublishedPackageRecord[] = [];
        Object.defineProperty(accessor, '0', { enumerable: true, configurable: true, get: () => validRecord });
        Object.defineProperty(accessor, 'length', { value: 1 });
        invalidSets.push(accessor);
        invalidSets.push([validRecord, validRecord]);
        invalidSets.push([{ ...validRecord, canonicalIri: 'https://example.test/other' }]);
        for (const releaseSet of invalidSets) {
            const hostile: DependencyCatalogShape = {
                resolveAlias: () => Promise.resolve(null),
                listPublished: () => Promise.resolve(releaseSet as ReadonlyArray<PublishedPackageRecord>),
            };
            await expect(resolve(manifest({ [iri]: '*' }), hostile)).rejects.toMatchObject({
                code: 'catalog-incoherent',
            });
        }
    });

    it('classifies every trapping catalog response as catalog incoherence without exposing its cause', async () => {
        const iri = 'https://example.test/a';
        const record = published(iri, '1.0.0');
        const trappingArrays: ReadonlyArray<ReadonlyArray<PublishedPackageRecord>> = [
            new Proxy([record], {
                getPrototypeOf: () => {
                    throw new Error('D:/prototype-secret');
                },
            }),
            new Proxy([record], {
                ownKeys: () => {
                    throw new Error('D:/keys-secret');
                },
            }),
            new Proxy([record], {
                getOwnPropertyDescriptor: () => {
                    throw new Error('D:/descriptor-secret');
                },
            }),
        ];
        for (const releases of trappingArrays) {
            const failure = await resolve(manifest({ [iri]: '*' }), {
                resolveAlias: () => Promise.resolve(null),
                listPublished: () => Promise.resolve(releases),
            }).then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(failure).toMatchObject({ code: 'catalog-incoherent' });
            expect(JSON.stringify(failure)).not.toContain('secret');
        }

        const aliasFailure = await resolve(manifest({ '@example/a': '*' }), {
            resolveAlias: () =>
                Promise.resolve(
                    new Proxy(
                        {},
                        {
                            getPrototypeOf: () => {
                                throw new Error('D:/alias-secret');
                            },
                        },
                    ) as never,
                ),
            listPublished: () => Promise.resolve([]),
        }).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(aliasFailure).toMatchObject({ code: 'catalog-incoherent' });
        expect(JSON.stringify(aliasFailure)).not.toContain('alias-secret');
    });

    it('rejects hidden, symbolic, accessor, sparse, and augmented fields anywhere in catalog manifests', async () => {
        const iri = 'https://example.test/a';
        const base = published(iri, '1.0.0');
        const hostileManifests: unknown[] = [];

        const symbolic = structuredClone(base.manifest) as unknown as object & { [key: symbol]: unknown };
        symbolic[Symbol('hidden')] = 'secret';
        hostileManifests.push(symbolic);

        const hidden = structuredClone(base.manifest) as object;
        Object.defineProperty(hidden, 'hidden', { value: 'secret', enumerable: false });
        hostileManifests.push(hidden);

        const accessor = structuredClone(base.manifest) as { toolchain: Record<string, unknown> };
        Object.defineProperty(accessor.toolchain, 'validator', {
            enumerable: true,
            get: () => base.manifest.toolchain.validator,
        });
        hostileManifests.push(accessor);

        const augmented = structuredClone(base.manifest) as unknown as { files: unknown[] };
        Object.defineProperty(augmented.files, 'extra', { value: true, enumerable: true });
        hostileManifests.push(augmented);

        const sparse = structuredClone(base.manifest) as unknown as { dependencies: unknown[] };
        sparse.dependencies = new Array(1);
        hostileManifests.push(sparse);

        for (const hostileManifest of hostileManifests) {
            const record = { ...base, manifest: hostileManifest } as PublishedPackageRecord;
            const failure = await resolve(manifest({ [iri]: '*' }), catalog({}, { [iri]: [record] })).then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(failure).toMatchObject({ code: 'catalog-incoherent' });
            expect(JSON.stringify(failure)).not.toContain('secret');
        }
    });

    it('is invariant to catalog order and manifest insertion order', async () => {
        const astral = 'https://example.test/%F0%9F%98%80';
        const bmp = 'https://example.test/%EE%80%80';
        const records = { [astral]: [published(astral, '1.0.0')], [bmp]: [published(bmp, '1.0.0')] };
        const first = await resolve(manifest({ [bmp]: '*', [astral]: '*' }), catalog({}, records));
        const second = await resolve(
            manifest({ [astral]: '*', [bmp]: '*' }),
            catalog(
                {},
                {
                    [bmp]: [...records[bmp]].reverse(),
                    [astral]: [...records[astral]].reverse(),
                },
            ),
        );
        expect(first.lockfileText).toBe(second.lockfileText);
        expect(first.lock.packages.map(({ canonicalIri }) => canonicalIri)).toEqual([bmp, astral]);
    });

    it('applies direct and catalog collection bounds before reading tail values', async () => {
        let manifestTailReads = 0;
        const dependencies: Record<string, string> = {};
        for (let index = 0; index < 1_024; index += 1) {
            dependencies[`https://example.test/p${String(index).padStart(4, '0')}`] = '*';
        }
        Object.defineProperty(dependencies, 'https://example.test/tail', {
            enumerable: true,
            get: () => {
                manifestTailReads += 1;
                throw new Error('D:/manifest-tail-secret');
            },
        });
        const untouched = catalog({}, {});
        await expect(resolve(manifest(dependencies), untouched)).rejects.toMatchObject({ code: 'resolution-limit' });
        expect(manifestTailReads).toBe(0);
        expect(untouched.aliasCalls).toEqual([]);
        expect(untouched.releaseCalls).toEqual([]);

        const iri = 'https://example.test/a';
        const base = publishedManifest(iri, []);
        let catalogTailReads = 0;
        const oversizedDependencies = new Array(16_385);
        Object.defineProperty(oversizedDependencies, '16384', {
            configurable: true,
            enumerable: true,
            get: () => {
                catalogTailReads += 1;
                throw new Error('D:/catalog-tail-secret');
            },
        });
        const hostile = {
            ...base,
            manifest: { ...base.manifest, dependencies: oversizedDependencies },
        } as unknown as PublishedPackageRecord;
        const failure = await resolve(manifest({ [iri]: '*' }), catalog({}, { [iri]: [hostile] })).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(failure).toMatchObject({ code: 'catalog-incoherent' });
        expect(catalogTailReads).toBe(0);
        expect(JSON.stringify(failure)).not.toContain('secret');
    });

    it('caps constraint fan-in before producing conflict evidence', async () => {
        const iri = 'https://example.test/a';
        const aliases = {
            '@example/a': '*',
            '@example/b': '*',
            '@example/c': '*',
        };
        const fixture = catalog(
            {
                '@example/a': iri,
                '@example/b': iri,
                '@example/c': iri,
            },
            { [iri]: [published(iri, '1.0.0')] },
        );
        await expect(
            resolve(manifest(aliases), fixture, {
                limits: { maxConstraintsPerPackage: 2 },
            }),
        ).rejects.toMatchObject({ code: 'resolution-limit' });
        expect(fixture.releaseCalls).toEqual([]);
    });

    it('resolves a depth-4096 chain with linear retained provenance', { timeout: 60_000 }, async () => {
        const packageCount = 4_096;
        const iris = Array.from(
            { length: packageCount },
            (_, index) => `https://example.test/p${String(index).padStart(4, '0')}`,
        );
        const records = new Map<string, PublishedPackageRecord>();
        for (let index = packageCount - 1; index >= 0; index -= 1) {
            const canonicalIri = iris[index] as string;
            const nextIri = iris[index + 1];
            records.set(
                canonicalIri,
                publishedManifest(
                    canonicalIri,
                    nextIri === undefined
                        ? []
                        : [
                              {
                                  requested: '1.0.0',
                                  canonicalIri: nextIri,
                                  version: '1.0.0',
                                  archiveSha256: digest('c'),
                              },
                          ],
                ),
            );
        }
        const fixture: DependencyCatalogShape = {
            resolveAlias: () => Promise.resolve(null),
            listPublished: (_origin, canonicalIri) =>
                Promise.resolve([records.get(canonicalIri) as PublishedPackageRecord]),
        };
        const result = await resolve(manifest({ [iris[0] as string]: '*' }), fixture, {
            limits: { maxCatalogCalls: packageCount, maxSearchStates: packageCount },
        });
        expect(result.lock.counts).toMatchObject({ packages: packageCount, edges: packageCount - 1 });
        expect(result.lock.packages.at(-1)?.dependencies).toEqual([]);
    });

    it('copies bounds and fails closed on invalid or exhausted limits', async () => {
        const iri = 'https://example.test/a';
        const fixture = catalog({}, { [iri]: [published(iri, '1.0.0')] });
        for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(
                resolve(manifest({ [iri]: '*' }), fixture, {
                    limits: { maxSearchStates: value },
                }),
            ).rejects.toMatchObject({ code: 'invalid-resolver-input' });
        }
        const mutable = { maxSearchStates: 1 };
        const promise = resolve(manifest({ [iri]: '*' }), fixture, { limits: mutable });
        mutable.maxSearchStates = 0;
        await expect(promise).resolves.toMatchObject({ status: 'resolved' });

        const accessorLimits: Record<string, unknown> = {};
        Object.defineProperty(accessorLimits, 'maxSearchStates', { enumerable: true, get: () => 1 });
        await expect(
            resolve(manifest({ [iri]: '*' }), fixture, {
                limits: accessorLimits,
            }),
        ).rejects.toMatchObject({ code: 'invalid-resolver-input' });

        const aliases = Object.fromEntries(
            Array.from({ length: 1_025 }, (_, index) => [`@example/p${String(index).padStart(4, '0')}`, '*']),
        );
        const untouched = catalog({}, {});
        await expect(
            resolve(manifest(aliases), untouched, {
                limits: { maxDirectDependencies: 1_025, maxAliasLookups: 1_025 },
            }),
        ).rejects.toMatchObject({ code: 'invalid-resolver-input' });
        expect(untouched.aliasCalls).toEqual([]);
        expect(untouched.releaseCalls).toEqual([]);
    });

    it('snapshots the manifest and deeply freezes the complete result graph', async () => {
        const iri = 'https://example.test/a';
        const dependencies: Record<string, string> = { [iri]: '*' };
        const inputManifest = manifest(dependencies);
        const fixture: DependencyCatalogShape = {
            resolveAlias: () => Promise.resolve(null),
            listPublished: () => {
                dependencies[iri] = '^9.0.0';
                return Promise.resolve([published(iri, '1.0.0')]);
            },
        };
        const result = await resolve(inputManifest, fixture);
        expect(result.lock.directDependencies[0]?.requested).toBe('*');
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.lock.packages)).toBe(true);
        expect(Object.isFrozen(result.lock.packages[0]?.dependencies)).toBe(true);
    });
});
