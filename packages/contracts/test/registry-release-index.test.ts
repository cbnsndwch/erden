import { describe, expect, it } from 'vitest';

import {
    REGISTRY_RELEASE_INDEX_LIMITS,
    decodeRegistryAliasResolutionWire,
    decodeRegistryExactVersion,
    decodeRegistryIndexRelease,
    decodeRegistryIndexReleaseWire,
    decodeRegistryReleaseIndexEntryWire,
    decodeRegistryReleaseIndexPageWire,
    encodeRegistryAliasResolution,
    encodeRegistryIndexRelease,
    encodeRegistryReleaseIndexEntry,
    encodeRegistryReleaseIndexPage,
    type RegistryIndexDependency,
    type RegistryIndexRelease,
} from '../src/index.js';

const ORIGIN = 'https://registry.example.test';
const IRI = 'https://example.test/layer';
const ALIAS = '@example/layer';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const TOOLCHAIN = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: SHA_A }),
    reasoner: Object.freeze({ version: '2.0.0+calculus.1', sha256: SHA_B }),
});
function dependency(canonicalIri: string, version = '1.0.0'): RegistryIndexDependency {
    return {
        requested: `=${version}`,
        canonicalIri,
        version,
        archiveSha256: SHA_A,
    };
}
function release(version: string, dependencies: ReadonlyArray<RegistryIndexDependency> = []): RegistryIndexRelease {
    return {
        version,
        archiveSha256: version.includes('2') ? SHA_B : SHA_A,
        toolchain: {
            validator: { ...TOOLCHAIN.validator },
            reasoner: { ...TOOLCHAIN.reasoner },
        },
        dependencies: dependencies.map((edge) => ({ ...edge })),
    };
}
function maximalExactVersion(suffix: string): string {
    const prefix = '1.0.0+';
    return `${prefix}${'a'.repeat(256 - prefix.length - suffix.length)}${suffix}`;
}
function maximalCanonicalIri(index: number, length = 1024): string {
    const prefix = 'https://example.test/dependency/';
    const suffix = String(index).padStart(4, '0');
    return `${prefix}${'a'.repeat(length - prefix.length - suffix.length)}${suffix}`;
}
const maximalRange = `${'1.0.0 || '.repeat(113)}1.0.0`;
function maximalRelease(version = maximalExactVersion('z')): RegistryIndexRelease {
    return {
        version,
        archiveSha256: SHA_A,
        toolchain: {
            validator: { version: maximalExactVersion('v'), sha256: SHA_A },
            reasoner: { version: maximalExactVersion('r'), sha256: SHA_B },
        },
        dependencies: Array.from({ length: REGISTRY_RELEASE_INDEX_LIMITS.maxDependenciesPerRelease }, (_, index) => ({
            requested: maximalRange,
            canonicalIri: maximalCanonicalIri(index),
            version: maximalExactVersion('d'),
            archiveSha256: SHA_A,
        })),
    };
}

describe('compact registry release index', () => {
    it('encodes deterministic canonical compact documents with exact identity envelopes', () => {
        const item = decodeRegistryIndexRelease(release('1.2.3+build.7'));
        const page = {
            schema: 'erden.registry-release-index-page/v1' as const,
            registryOrigin: ORIGIN,
            canonicalIri: IRI,
            watermark: 'w_1',
            pageOrdinal: 0,
            releaseCount: 1,
            releases: [item],
            nextCursor: null,
        };
        const pageBytes = encodeRegistryReleaseIndexPage(page);
        expect(new TextDecoder().decode(pageBytes).endsWith('\n')).toBe(true);
        expect(decodeRegistryReleaseIndexPageWire(pageBytes)).toEqual(page);
        expect(encodeRegistryReleaseIndexPage(decodeRegistryReleaseIndexPageWire(pageBytes))).toEqual(pageBytes);
        const text = new TextDecoder().decode(pageBytes);
        for (const forbidden of [
            'files',
            'visibility',
            'publishedAt',
            'preferredAlias',
            'byteSize',
            'manifestSha256',
            'closure',
            'projectId',
        ]) {
            expect(text).not.toContain(forbidden);
        }

        const exact = {
            schema: 'erden.registry-release-index-entry/v1' as const,
            registryOrigin: ORIGIN,
            canonicalIri: IRI,
            release: item,
        };
        expect(decodeRegistryReleaseIndexEntryWire(encodeRegistryReleaseIndexEntry(exact))).toEqual(exact);
        const alias = {
            schema: 'erden.registry-alias-resolution/v1' as const,
            registryOrigin: ORIGIN,
            alias: ALIAS,
            canonicalIri: IRI,
        };
        expect(decodeRegistryAliasResolutionWire(encodeRegistryAliasResolution(alias))).toEqual(alias);
    });
    it('rejects duplicate keys, noncanonical bytes, trailing data, extras, sparse arrays, accessors, and reused records', () => {
        const canonical = encodeRegistryIndexRelease(release('1.0.0'));
        const text = new TextDecoder().decode(canonical).trimEnd();
        expect(() => decodeRegistryReleaseIndexPageWire(new TextEncoder().encode('{}\n'))).toThrow();
        const duplicate = `{"archiveSha256":"${SHA_A}","archiveSha256":"${SHA_A}","dependencies":[],"toolchain":{"reasoner":{"sha256":"${SHA_B}","version":"2.0.0"},"validator":{"sha256":"${SHA_A}","version":"1.0.0"}},"version":"1.0.0"}\n`;
        expect(() => decodeRegistryIndexReleaseWire(new TextEncoder().encode(duplicate))).toThrow();
        expect(() => decodeRegistryIndexReleaseWire(new TextEncoder().encode(`${text} \n`))).toThrow();
        expect(() => decodeRegistryIndexReleaseWire(new TextEncoder().encode(`${text}\n{}\n`))).toThrow();

        const extra = { ...release('1.0.0'), files: [] };
        expect(() => decodeRegistryIndexRelease(extra)).toThrow();
        const sparse = release('1.0.0') as unknown as { dependencies: RegistryIndexDependency[] };
        sparse.dependencies = new Array<RegistryIndexDependency>(1);
        expect(() => decodeRegistryIndexRelease(sparse)).toThrow();
        let reads = 0;
        const accessor = release('1.0.0');
        Object.defineProperty(accessor, 'version', {
            enumerable: true,
            get: () => {
                reads += 1;
                return '1.0.0';
            },
        });
        expect(() => decodeRegistryIndexRelease(accessor)).toThrow();
        expect(reads).toBe(0);
        const edge = dependency('https://example.test/dependency');
        const reused = release('1.0.0') as unknown as { dependencies: RegistryIndexDependency[] };
        reused.dependencies = [edge, edge];
        expect(() => decodeRegistryIndexRelease(reused)).toThrow();

        let byteLengthReads = 0;
        const hostileBytes = encodeRegistryIndexRelease(release('1.0.0'));
        Object.defineProperty(hostileBytes, 'byteLength', {
            configurable: true,
            get: () => {
                byteLengthReads += 1;
                throw new Error('hostile-byte-length-secret');
            },
        });
        let hostileByteError: unknown;
        try {
            decodeRegistryIndexReleaseWire(hostileBytes);
        } catch (error) {
            hostileByteError = error;
        }
        expect(hostileByteError).toMatchObject({ code: 'REGISTRY_INDEX_INPUT_INVALID' });
        expect(String(hostileByteError)).not.toContain('hostile-byte-length-secret');
        expect(byteLengthReads).toBe(0);

        const hostileProxy = new Proxy(encodeRegistryIndexRelease(release('1.0.0')), {
            getPrototypeOf: () => {
                throw new Error('hostile-byte-proxy-secret');
            },
        });
        let hostileProxyError: unknown;
        try {
            decodeRegistryIndexReleaseWire(hostileProxy);
        } catch (error) {
            hostileProxyError = error;
        }
        expect(hostileProxyError).toMatchObject({ code: 'REGISTRY_INDEX_INPUT_INVALID' });
        expect(String(hostileProxyError)).not.toContain('hostile-byte-proxy-secret');
    });
    it('preserves exact build variants and rejects non-exact or noncanonical versions', () => {
        for (const version of ['1.2.3+build.7', '1.2.3-alpha.1+build.7', '0.0.0']) {
            expect(decodeRegistryExactVersion(version)).toBe(version);
        }
        for (const version of ['', 'v1.2.3', '=1.2.3', '^1.2.3', ' 1.2.3', '01.2.3', '1.2.3 ']) {
            expect(() => decodeRegistryExactVersion(version)).toThrow();
        }
        expect(() => decodeRegistryExactVersion(`1.0.0+${'a'.repeat(1_017)}`)).toThrow();
    });
    it('derives a conservative maximum item bound that fits the committed caps', () => {
        const scalar = 6 * 1_024;
        const dependencyBytes = 64 + scalar + scalar + 1_024 + 66;
        const toolchainBytes = 2 * 64 + 2 * 1_024 + 78;
        const releaseBytes = 1_024 * dependencyBytes + 1_023 + toolchainBytes + 64 + 1_024 + 64;
        expect(dependencyBytes).toBe(13_442);
        expect(toolchainBytes).toBe(2_254);
        expect(releaseBytes).toBe(REGISTRY_RELEASE_INDEX_LIMITS.derivedMaximumReleaseBytes);
        expect(releaseBytes).toBeLessThan(REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseEncodedBytes);
        expect(releaseBytes + 6_144 + 1_024 + 256 + 113).toBeLessThan(
            REGISTRY_RELEASE_INDEX_LIMITS.maxPageEncodedBytes,
        );
        expect(maximalRange.length).toBe(1_022);
        const generated = maximalRelease();
        expect(generated.version.length).toBe(256);
        expect(new TextEncoder().encode(generated.dependencies[0]?.canonicalIri).byteLength).toBe(1_024);
        const actual = encodeRegistryIndexRelease(generated).byteLength;
        expect(actual).toBeLessThanOrEqual(releaseBytes);
        expect(actual).toBeLessThan(REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseEncodedBytes);
    });
    it('accepts the exact 1,024-edge boundary and rejects +1 before reading a tail accessor', () => {
        const edges = Array.from({ length: REGISTRY_RELEASE_INDEX_LIMITS.maxDependenciesPerRelease }, (_, index) =>
            dependency(`https://example.test/dependency/${String(index).padStart(4, '0')}`),
        );
        const item = decodeRegistryIndexRelease(release('1.0.0', edges));
        expect(item.dependencies).toHaveLength(1_024);
        expect(encodeRegistryIndexRelease(item).byteLength).toBeLessThan(
            REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseEncodedBytes,
        );

        let reads = 0;
        const oversized = [...edges, dependency('https://example.test/tail')];
        Object.defineProperty(oversized, '1024', {
            enumerable: true,
            get: () => {
                reads += 1;
                return dependency('https://example.test/tail');
            },
        });
        const oversizedRelease = release('1.0.0') as unknown as { dependencies: RegistryIndexDependency[] };
        oversizedRelease.dependencies = oversized;
        expect(() => decodeRegistryIndexRelease(oversizedRelease)).toThrow();
        expect(reads).toBe(0);
    });
});
