import { describe, expect, it } from 'vitest';

import {
    LockfileError,
    LOCKFILE_LIMITS,
    checkLockConsistency,
    decodeLockToolchain,
    decodeLockfileValue,
    encodeManifestDependencyProjection,
    manifestDependencyProjectionSha256,
    parseLockfile,
    serializeLockfile,
    type LockToolchain,
    type LockfileV1,
    type ManifestV1,
} from '../src/index.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = {
    validator: { version: '1.0.0', sha256: digest('a') },
    reasoner: { version: '1.0.0', sha256: digest('b') },
};

function emptyValue(): LockfileV1 {
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

function manifest(dependencies: Readonly<Record<string, string>> = {}, registry?: string): ManifestV1 {
    return {
        schemaVersion: 1,
        canonicalIri: 'https://example.test/root',
        alias: '@example/root',
        ownedIriPrefixes: ['https://example.test/root#'],
        sources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
        citationRoots: {},
        dependencies,
        ...(registry === undefined ? {} : { registry }),
    };
}

function nonemptyValue(): LockfileV1 {
    const iri = 'https://example.test/a';
    const dependencies = { [iri]: '^1.0.0' };
    return decodeLockfileValue({
        lockfileVersion: 1,
        registryOrigin: 'https://registry.example',
        manifestDependencySha256: manifestDependencyProjectionSha256({
            canonicalIri: 'https://example.test/root',
            alias: '@example/root',
            registryOrigin: 'https://registry.example',
            dependencies,
        }),
        root: { canonicalIri: 'https://example.test/root', alias: '@example/root' },
        directDependencies: [
            { identifier: iri, requested: '^1.0.0', canonicalIri: iri, version: '1.2.0', archiveSha256: digest('c') },
        ],
        aliasMappings: [],
        packages: [{ canonicalIri: iri, version: '1.2.0', archiveSha256: digest('c'), dependencies: [] }],
        toolchain: TOOLCHAIN,
        counts: { directDependencies: 1, aliasMappings: 0, packages: 1, edges: 0 },
    });
}

describe('erden.lock v1 codec', () => {
    it('returns a deeply frozen canonical toolchain snapshot', () => {
        const mutable = structuredClone(TOOLCHAIN) as unknown as {
            validator: { version: string; sha256: string };
            reasoner: { version: string; sha256: string };
        };
        const decoded = decodeLockToolchain(mutable);
        mutable.validator.version = '2.0.0';
        expect(decoded).toEqual(TOOLCHAIN);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.validator)).toBe(true);
        expect(Object.isFrozen(decoded.reasoner)).toBe(true);
    });

    it('uses UTF-16 code-unit ordering for canonical projections', () => {
        const bmp = 'urn:example:%EE%80%80';
        const astral = 'urn:example:%F0%9F%98%80';
        const text = new TextDecoder().decode(
            encodeManifestDependencyProjection({
                canonicalIri: 'https://example.test/root',
                alias: '@example/root',
                registryOrigin: null,
                dependencies: { [astral]: '2', [bmp]: '1' },
            }),
        );
        expect(text.indexOf(bmp)).toBeLessThan(text.indexOf(astral));
    });

    it('serializes and parses the exact canonical empty lock bytes', () => {
        const lock = emptyValue();
        const text = serializeLockfile(lock);
        expect(text).toBe(`lockfileVersion: 1
registryOrigin: null
manifestDependencySha256: "${lock.manifestDependencySha256}"
root:
  canonicalIri: "https://example.test/root"
  alias: "@example/root"
directDependencies: []
aliasMappings: []
packages: []
toolchain:
  validator:
    version: "1.0.0"
    sha256: "${digest('a')}"
  reasoner:
    version: "1.0.0"
    sha256: "${digest('b')}"
counts:
  directDependencies: 0
  aliasMappings: 0
  packages: 0
  edges: 0
`);
        expect(parseLockfile(text)).toEqual(lock);
        expect(serializeLockfile(parseLockfile(new TextEncoder().encode(text)))).toBe(text);
        expect(Object.isFrozen(lock.toolchain.validator)).toBe(true);
    });

    it('rejects noncanonical, unsafe, duplicate, tagged, aliased, and multi-document YAML', () => {
        const canonical = serializeLockfile(emptyValue());
        const hostiles = [
            `\uFEFF${canonical}`,
            canonical.replaceAll('\n', '\r\n'),
            `# comment\n${canonical}`,
            canonical.replace('lockfileVersion: 1', 'lockfileVersion: 01'),
            canonical.replace('root:', 'root: &root'),
            canonical.replace('alias: "@example/root"', 'alias: !!str "@example/root"'),
            canonical.replace('root:\n', 'root:\n  <<: {}\n'),
            `x: &x {}\n${canonical.replace('root:\n  canonicalIri: "https://example.test/root"\n  alias: "@example/root"', 'root: *x')}`,
            `%YAML 1.2\n---\n${canonical}`,
            canonical.replace('counts:', '__proto__: "bad"\ncounts:'),
            `${canonical}---\nlockfileVersion: 1\n`,
            canonical.replace('counts:', 'root: {}\ncounts:'),
            canonical
                .replace('registryOrigin: null\nmanifestDependencySha256:', 'manifestDependencySha256:')
                .replace('\nroot:', '\nregistryOrigin: null\nroot:'),
            `${canonical}\uD800`,
        ];
        for (const hostile of hostiles) {
            expect(() => parseLockfile(hostile)).toThrow(LockfileError);
        }
        const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(canonical)]);
        expect(() => parseLockfile(bom)).toThrow(LockfileError);
        expect(() => parseLockfile(Uint8Array.of(0xff))).toThrow(LockfileError);
    });

    it(
        'rejects an over-byte-bound multibyte string before UTF-8 allocation or YAML parsing',
        { timeout: 30_000 },
        () => {
            const overByteBound = '\u0800'.repeat(Math.floor(LOCKFILE_LIMITS.maxBytes / 3) + 1);
            expect(() => parseLockfile(overByteBound)).toThrow(
                expect.objectContaining({
                    code: 'lockfile-syntax',
                    message: 'erden.lock exceeds the maximum byte size',
                }),
            );
        },
    );

    it('rejects excess fields, wrong versions, malformed digests, and impossible empty/nonempty states', () => {
        const base = emptyValue();
        const cases: unknown[] = [
            { ...base, extra: true },
            { ...base, lockfileVersion: 2 },
            { ...base, manifestDependencySha256: 'ABC' },
            { ...base, accessToken: 'secret' },
            { ...base, registryOrigin: 'https://registry.example' },
            {
                ...base,
                packages: [
                    {
                        canonicalIri: 'https://example.test/a',
                        version: '1.0.0',
                        archiveSha256: digest('c'),
                        dependencies: [],
                    },
                ],
                counts: { ...base.counts, packages: 1 },
            },
        ];
        for (const value of cases) {
            expect(() => decodeLockfileValue(value)).toThrow(LockfileError);
        }
    });

    it('rejects negative zero counts without changing numeric identity through serialization', () => {
        const base = emptyValue();
        for (const key of ['directDependencies', 'aliasMappings', 'packages', 'edges'] as const) {
            expect(() =>
                decodeLockfileValue({
                    ...base,
                    counts: { ...base.counts, [key]: -0 },
                }),
            ).toThrow(LockfileError);
        }
        const negativeZeroYaml = serializeLockfile(base).replace(
            'directDependencies: 0\n  aliasMappings:',
            'directDependencies: -0\n  aliasMappings:',
        );
        expect(() => parseLockfile(negativeZeroYaml)).toThrow(LockfileError);
    });

    it('rejects a canonical direct identifier retarget even with a recomputed projection', () => {
        const valid = nonemptyValue();
        const identifier = 'https://example.test/a';
        const canonicalIri = 'https://example.test/b';
        const dependencies = { [identifier]: '^1.0.0' };
        expect(() =>
            decodeLockfileValue({
                ...valid,
                manifestDependencySha256: manifestDependencyProjectionSha256({
                    canonicalIri: valid.root.canonicalIri,
                    alias: valid.root.alias,
                    registryOrigin: valid.registryOrigin,
                    dependencies,
                }),
                directDependencies: [{ ...valid.directDependencies[0], identifier, canonicalIri }],
                packages: [{ ...valid.packages[0], canonicalIri }],
            }),
        ).toThrow(expect.objectContaining({ code: 'lockfile-truth' }));
    });

    it('rejects count, edge, cycle, and unreachable graph contradictions', () => {
        const valid = nonemptyValue();
        expect(() => decodeLockfileValue({ ...valid, counts: { ...valid.counts, edges: 1 } })).toThrow(LockfileError);
        expect(() =>
            decodeLockfileValue({
                ...valid,
                packages: [
                    ...valid.packages,
                    {
                        canonicalIri: 'https://example.test/z',
                        version: '1.0.0',
                        archiveSha256: digest('d'),
                        dependencies: [],
                    },
                ],
                counts: { ...valid.counts, packages: 2 },
            }),
        ).toThrow(LockfileError);
        expect(() =>
            decodeLockfileValue({
                ...valid,
                packages: [
                    {
                        ...valid.packages[0],
                        dependencies: [
                            {
                                requested: '*',
                                canonicalIri: valid.packages[0]?.canonicalIri,
                                version: '1.2.0',
                                archiveSha256: digest('c'),
                            },
                        ],
                    },
                ],
                counts: { ...valid.counts, edges: 1 },
            }),
        ).toThrow(LockfileError);
    });

    it('bounds large graphs before traversal and never leaks a raw stack failure', () => {
        const valid = nonemptyValue();
        let packageItemReads = 0;
        const packages = new Proxy(
            Array.from({ length: 4_097 }, () => null),
            {
                getOwnPropertyDescriptor: (target, property) => {
                    if (property !== 'length') {
                        packageItemReads += 1;
                    }
                    return Reflect.getOwnPropertyDescriptor(target, property);
                },
            },
        );
        let failure: unknown;
        try {
            decodeLockfileValue({ ...valid, packages, counts: { ...valid.counts, packages: packages.length } });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(LockfileError);
        expect(failure).not.toBeInstanceOf(RangeError);
        expect(failure).toMatchObject({ code: 'lockfile-truth' });
        expect(packageItemReads).toBe(0);

        for (const [field, limit] of [
            ['directDependencies', LOCKFILE_LIMITS.maxDirectDependencies],
            ['aliasMappings', LOCKFILE_LIMITS.maxAliasMappings],
        ] as const) {
            let itemReads = 0;
            const values = new Proxy(
                Array.from({ length: limit + 1 }, () => null),
                {
                    getOwnPropertyDescriptor: (target, property) => {
                        if (property !== 'length') {
                            itemReads += 1;
                        }
                        return Reflect.getOwnPropertyDescriptor(target, property);
                    },
                },
            );
            expect(() => decodeLockfileValue({ ...valid, [field]: values })).toThrow(
                expect.objectContaining({ code: 'lockfile-truth' }),
            );
            expect(itemReads).toBe(0);
        }

        let edgeItemReads = 0;
        const edges = new Proxy(
            Array.from({ length: LOCKFILE_LIMITS.maxEdges + 1 }, () => null),
            {
                getOwnPropertyDescriptor: (target, property) => {
                    if (property !== 'length') {
                        edgeItemReads += 1;
                    }
                    return Reflect.getOwnPropertyDescriptor(target, property);
                },
            },
        );
        expect(() =>
            decodeLockfileValue({
                ...valid,
                packages: [{ ...valid.packages[0], dependencies: edges }],
                counts: { ...valid.counts, edges: edges.length },
            }),
        ).toThrow(expect.objectContaining({ code: 'lockfile-truth' }));
        expect(edgeItemReads).toBe(0);
        expect(() => parseLockfile(`${'a:\n'.repeat(5_000)}x: 1\n`)).toThrow(LockfileError);
    });

    it('roundtrips a graph at the exact edge bound and a root at the scalar bound', () => {
        const packageCount = 182;
        const selectedPairs: Array<readonly [number, number]> = [];
        for (let source = 0; source < packageCount; source += 1) {
            for (let target = source + 1; target < packageCount; target += 1) {
                selectedPairs.push([source, target]);
            }
        }
        selectedPairs.splice(LOCKFILE_LIMITS.maxEdges);
        const packages = Array.from({ length: packageCount }, (_, index) => {
            const canonicalIri = `https://example.test/p${String(index).padStart(3, '0')}`;
            const dependencies = selectedPairs
                .filter(([source]) => source === index)
                .map(([, target]) => ({
                    requested: '*',
                    canonicalIri: `https://example.test/p${String(target).padStart(3, '0')}`,
                    version: '1.0.0',
                    archiveSha256: digest('c'),
                }));
            return { canonicalIri, version: '1.0.0', archiveSha256: digest('c'), dependencies };
        });
        expect(selectedPairs).toHaveLength(LOCKFILE_LIMITS.maxEdges);
        const identifier = packages[0]?.canonicalIri as string;
        const requested = '*';
        const lock = decodeLockfileValue({
            lockfileVersion: 1,
            registryOrigin: 'https://registry.example',
            manifestDependencySha256: manifestDependencyProjectionSha256({
                canonicalIri: 'https://example.test/root',
                alias: '@example/root',
                registryOrigin: 'https://registry.example',
                dependencies: { [identifier]: requested },
            }),
            root: { canonicalIri: 'https://example.test/root', alias: '@example/root' },
            directDependencies: [
                { identifier, requested, canonicalIri: identifier, version: '1.0.0', archiveSha256: digest('c') },
            ],
            aliasMappings: [],
            packages,
            toolchain: TOOLCHAIN,
            counts: {
                directDependencies: 1,
                aliasMappings: 0,
                packages: packageCount,
                edges: LOCKFILE_LIMITS.maxEdges,
            },
        });
        const text = serializeLockfile(lock);
        expect(parseLockfile(text)).toEqual(lock);

        const longRoot = `https://example.test/${'r'.repeat(LOCKFILE_LIMITS.maxScalarBytes - 'https://example.test/'.length)}`;
        const scalarLock = decodeLockfileValue({
            ...emptyValue(),
            manifestDependencySha256: manifestDependencyProjectionSha256({
                canonicalIri: longRoot,
                alias: '@example/root',
                registryOrigin: null,
                dependencies: {},
            }),
            root: { canonicalIri: longRoot, alias: '@example/root' },
        });
        expect(parseLockfile(serializeLockfile(scalarLock))).toEqual(scalarLock);
        expect(() =>
            decodeLockfileValue({
                ...scalarLock,
                root: { ...scalarLock.root, canonicalIri: `${longRoot}x` },
            }),
        ).toThrow(LockfileError);
    }, 30_000); // About 4 s on a fast Linux host; the 5 s default is too tight for CI runners.

    it('rejects accessors, unsafe prototypes, and noncanonical registry origins as typed errors', () => {
        const base = emptyValue();
        const accessorRoot: Record<string, unknown> = { canonicalIri: base.root.canonicalIri };
        Object.defineProperty(accessorRoot, 'alias', { enumerable: true, get: () => '@example/root' });
        expect(() => decodeLockfileValue({ ...base, root: accessorRoot })).toThrow(LockfileError);
        const classValue = new (class LockLike {
            readonly lockfileVersion = 1;
        })();
        expect(() => decodeLockfileValue(classValue)).toThrow(LockfileError);
        const valid = nonemptyValue();
        expect(() => decodeLockfileValue({ ...valid, registryOrigin: 'https://registry.example/' })).toThrow(
            LockfileError,
        );
        const trappedBytes = new Proxy(new Uint8Array(), {
            get: (target, property, receiver) => {
                if (property === 'byteLength') {
                    throw new Error('D:/byte-secret');
                }
                return Reflect.get(target, property, receiver) as unknown;
            },
        });
        let failure: unknown;
        try {
            parseLockfile(trappedBytes);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(LockfileError);
        expect(JSON.stringify(failure)).not.toContain('byte-secret');

        const transparentProxy = new Proxy(new Uint8Array(), {});
        expect(() => parseLockfile(transparentProxy)).toThrow(LockfileError);
        const buffer = Buffer.from(serializeLockfile(base), 'utf8');
        expect(parseLockfile(buffer)).toEqual(base);
        class Bytes extends Uint8Array {}
        expect(parseLockfile(new Bytes(buffer))).toEqual(base);
        const detached = new Uint8Array(new ArrayBuffer(8));
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        expect(() => parseLockfile(detached)).toThrow(LockfileError);
    });

    it('checks manifest, registry, identity, projection, and toolchain with no external capability', () => {
        const empty = emptyValue();
        expect(checkLockConsistency(manifest({}, undefined), TOOLCHAIN, empty)).toEqual({
            status: 'consistent',
            reasons: [],
        });
        expect(checkLockConsistency(manifest({}, 'https://unused.example/'), TOOLCHAIN, empty)).toEqual({
            status: 'consistent',
            reasons: [],
        });
        const changed = checkLockConsistency(
            manifest({ 'https://example.test/a': '^2' }, 'https://registry.example'),
            TOOLCHAIN,
            nonemptyValue(),
        );
        expect(changed).toEqual({ status: 'stale', reasons: ['dependency-projection-changed'] });
        expect(Object.isFrozen(changed.reasons)).toBe(true);
    });

    it('snapshots consistency inputs and normalizes hostile manifests to path-free typed errors', () => {
        const lock = emptyValue();
        const hostile = new Proxy(manifest(), {
            getPrototypeOf: () => {
                throw new Error('D:/consistency-secret');
            },
        });
        let failure: unknown;
        try {
            checkLockConsistency(hostile, TOOLCHAIN, lock);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(LockfileError);
        expect(JSON.stringify(failure)).not.toContain('consistency-secret');
        expect(Object.keys(failure as object)).not.toContain('cause');

        const symbolic = manifest() as ManifestV1 & { [key: symbol]: unknown };
        symbolic[Symbol('hidden')] = true;
        expect(() => checkLockConsistency(symbolic, TOOLCHAIN, lock)).toThrow(LockfileError);
        expect(() => checkLockConsistency(new Date() as unknown as ManifestV1, TOOLCHAIN, lock)).toThrow(LockfileError);
    });
});
