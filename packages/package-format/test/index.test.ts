import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    ARCHIVE_ROOT,
    assertNoPortablePathConflicts,
    encodeReferencePackageFixture,
    encodeUnsafeTarGzipFixture,
    gzipReferenceBytes,
    GENERATED_MANIFEST_ARCHIVE_PATH,
    GENERATED_MANIFEST_PATH,
    isPackageFormatVersionCompatible,
    makePackageIgnorePolicy,
    normalizePackagePath,
    PACKAGE_FORMAT_VERSION,
    PackageFixtureError,
    PackageFormatVersion,
    TAR_BLOCK_SIZE,
    validateReferenceArchiveFixture,
    type PackageFixtureErrorCode,
    type ReferencePackageInput,
    type ReferenceResolvedDependency,
} from '../src/index.js';

import { MALICIOUS_ARCHIVES } from './fixtures.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const ZETA_DEPENDENCY: ReferenceResolvedDependency = {
    requested: '^2.0.0',
    canonicalIri: 'https://example.test/packages/zeta',
    version: '2.1.0',
    archiveSha256: HASH_B,
};

const GOLDEN_INPUT: ReferencePackageInput = {
    canonicalIri: 'https://example.test/packages/demo',
    version: '1.2.3',
    dependencies: [
        ZETA_DEPENDENCY,
        {
            requested: '1.0.0',
            canonicalIri: 'https://example.test/packages/alpha',
            version: '1.0.0',
            archiveSha256: HASH_A,
        },
    ],
    validator: { version: '1.9.8', sha256: HASH_C },
    reasoner: { version: '0.1.0', sha256: HASH_D },
    files: [
        { path: 'zeta.txt', bytes: 'last\n' },
        { path: 'scripts\\check.sh', bytes: '#!/bin/sh\nexit 0\n', executable: true },
        { path: 'ontology/cafe\u0301.ttl', bytes: '<urn:s> <urn:p> <urn:o> .\n' },
        { path: 'ignored-by-erden.ttl', bytes: 'excluded\n' },
        { path: 'ignored-by-git.ttl', bytes: 'included because .erdenignore wins\n' },
        { path: 'important.tmp', bytes: 'included by negation\n' },
        { path: 'build/generated.ttl', bytes: 'excluded directory\n' },
        { path: '.git/config', bytes: 'host-specific git metadata\n' },
        { path: '.gitignore', bytes: 'ignored-by-git.ttl\n' },
        { path: '.erdenignore', bytes: 'ignored-by-erden.ttl\nbuild/\n*.tmp\n!important.tmp\n' },
    ],
};
const fixtureManifest = encodeReferencePackageFixture(GOLDEN_INPUT).manifest;

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function expectFixtureError(operation: () => unknown, code: PackageFixtureErrorCode): void {
    try {
        operation();
        throw new Error(`Expected package fixture error ${code}`);
    } catch (error) {
        if (!(error instanceof PackageFixtureError)) {
            throw error;
        }
        expect(error.code).toBe(code);
    }
}

function decodeTextField(header: Uint8Array, offset: number, width: number): string {
    const bytes = header.subarray(offset, offset + width);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(bytes.subarray(0, end === -1 ? bytes.length : end));
}

function decodeOctalField(header: Uint8Array, offset: number, width: number): number {
    return Number.parseInt(decodeTextField(header, offset, width).trim(), 8);
}

interface HeaderSummary {
    readonly path: string;
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
    readonly size: number;
    readonly mtime: number;
    readonly typeFlag: string;
    readonly uname: string;
    readonly gname: string;
}

function summarizeHeaders(archive: Uint8Array): ReadonlyArray<HeaderSummary> {
    const tar = gunzipSync(archive);
    const headers: HeaderSummary[] = [];
    let offset = 0;
    while (
        offset + TAR_BLOCK_SIZE <= tar.length &&
        tar.subarray(offset, offset + TAR_BLOCK_SIZE).some((byte) => byte !== 0)
    ) {
        const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
        const name = decodeTextField(header, 0, 100);
        const prefix = decodeTextField(header, 345, 155);
        const size = decodeOctalField(header, 124, 12);
        headers.push({
            path: prefix.length === 0 ? name : `${prefix}/${name}`,
            mode: decodeOctalField(header, 100, 8),
            uid: decodeOctalField(header, 108, 8),
            gid: decodeOctalField(header, 116, 8),
            size,
            mtime: decodeOctalField(header, 136, 12),
            typeFlag: String.fromCharCode(header[156] ?? 0),
            uname: decodeTextField(header, 265, 32),
            gname: decodeTextField(header, 297, 32),
        });
        offset += TAR_BLOCK_SIZE + size + ((TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE);
    }
    return headers;
}

function repairHeaderChecksum(header: Uint8Array): void {
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, '0')), 148);
    header[154] = 0;
    header[155] = 0x20;
}

function mutateFirstHeader(archive: Uint8Array, mutate: (header: Uint8Array) => void): Uint8Array {
    const tar = Uint8Array.from(gunzipSync(archive));
    const header = tar.subarray(0, TAR_BLOCK_SIZE);
    mutate(header);
    repairHeaderChecksum(header);
    return gzipReferenceBytes(tar);
}

function encodeManifestArchive(manifest: unknown): Uint8Array {
    return encodeUnsafeTarGzipFixture([
        { path: 'package/', typeFlag: '5', mode: 0o755 },
        { path: 'package/.erden/', typeFlag: '5', mode: 0o755 },
        { path: GENERATED_MANIFEST_ARCHIVE_PATH, bytes: `${JSON.stringify(manifest, null, 2)}\n` },
    ]);
}

describe('@erden/package-format V1 contract', () => {
    it('pins the root, generated manifest, and exact version compatibility', () => {
        const decode = Schema.decodeUnknownSync(PackageFormatVersion);
        expect([
            PACKAGE_FORMAT_VERSION,
            ARCHIVE_ROOT,
            GENERATED_MANIFEST_PATH,
            GENERATED_MANIFEST_ARCHIVE_PATH,
        ]).toEqual([1, 'package/', '.erden/package-manifest.json', 'package/.erden/package-manifest.json']);
        expect(decode(1)).toBe(1);
        expect(() => decode(2)).toThrow();
        expect([
            isPackageFormatVersionCompatible(0),
            isPackageFormatVersionCompatible(1),
            isPackageFormatVersionCompatible(2),
        ]).toEqual([false, true, false]);
    });

    it('normalizes source separators and Unicode to portable NFC paths', () => {
        expect(normalizePackagePath('ontology\\nested\\cafe\u0301.ttl')).toBe('ontology/nested/caf\u00e9.ttl');
    });

    it.each([
        ['', 'empty-path'],
        ['/absolute.ttl', 'absolute-path'],
        ['\\\\server\\share\\file.ttl', 'absolute-path'],
        ['C:\\file.ttl', 'drive-path'],
        ['../escape.ttl', 'traversal-path'],
        ['a/./b.ttl', 'non-normalized-path'],
        ['a//b.ttl', 'non-normalized-path'],
        ['CON', 'reserved-name'],
        ['aux.txt', 'reserved-name'],
        ['COM1', 'reserved-name'],
        ['com9.txt', 'reserved-name'],
        ['COM\u00b9.log', 'reserved-name'],
        ['LPT\u00b2', 'reserved-name'],
        ['lpt\u00b3.txt', 'reserved-name'],
        ['CONIN$', 'reserved-name'],
        ['conout$.txt', 'reserved-name'],
        ['trailing.', 'reserved-name'],
        ['trailing ', 'reserved-name'],
        ['bad?.ttl', 'reserved-name'],
        ['bad\uD800.ttl', 'invalid-utf8'],
    ] as const)('rejects nonportable path %j as %s', (path, code) => {
        expectFixtureError(() => normalizePackagePath(path), code);
    });

    it('rejects duplicate, Unicode, case, and file-descendant conflicts', () => {
        expectFixtureError(() => {
            assertNoPortablePathConflicts([
                { path: 'same', kind: 'file' },
                { path: 'same', kind: 'file' },
            ]);
        }, 'duplicate-path');
        expectFixtureError(() => {
            assertNoPortablePathConflicts([
                { path: 'caf\u00e9', kind: 'file' },
                { path: 'cafe\u0301', kind: 'file' },
            ]);
        }, 'unicode-conflict');
        expectFixtureError(() => {
            assertNoPortablePathConflicts([
                { path: 'README', kind: 'file' },
                { path: 'readme', kind: 'file' },
            ]);
        }, 'case-conflict');
        expectFixtureError(() => {
            assertNoPortablePathConflicts([
                { path: '\u03a3.ttl', kind: 'file' },
                { path: '\u03c2.ttl', kind: 'file' },
            ]);
        }, 'case-conflict');
        expectFixtureError(() => {
            assertNoPortablePathConflicts([
                { path: 'node', kind: 'file' },
                { path: 'node/child', kind: 'file' },
            ]);
        }, 'conflicting-path');
    });

    it('uses .erdenignore before .gitignore and excludes control metadata', () => {
        const fixture = encodeReferencePackageFixture(GOLDEN_INPUT);
        expect(fixture.selectedIgnoreFile).toBe('.erdenignore');
        expect(fixture.manifest.files.map(({ path }) => path)).toEqual([
            'ignored-by-git.ttl',
            'important.tmp',
            'ontology/caf\u00e9.ttl',
            'scripts/check.sh',
            'zeta.txt',
        ]);
    });

    it('falls back to .gitignore and preserves ignored-parent semantics', () => {
        const fixture = encodeReferencePackageFixture({
            ...GOLDEN_INPUT,
            dependencies: [],
            files: [
                { path: '.gitignore', bytes: 'drop/\n!drop/keep.ttl\n*.log\n' },
                { path: 'drop/keep.ttl', bytes: 'excluded\n' },
                { path: 'trace.log', bytes: 'excluded\n' },
                { path: 'keep.ttl', bytes: 'included\n' },
            ],
        });
        expect(fixture.selectedIgnoreFile).toBe('.gitignore');
        expect(fixture.manifest.files.map(({ path }) => path)).toEqual(['keep.ttl']);
    });

    it('exposes one immutable ignore policy shared by filesystem packers and the oracle', () => {
        const erden = new TextEncoder().encode('build/\n*.tmp\n!important.tmp\n');
        const git = new TextEncoder().encode('ignored-by-git.ttl\n');
        const policy = makePackageIgnorePolicy({ erdenIgnore: erden, gitIgnore: git });

        erden.fill(0);
        expect(policy.selectedIgnoreFile).toBe('.erdenignore');
        expect(policy.isAlwaysExcluded('.erdenignore')).toBe(true);
        expect(policy.isAlwaysExcluded('.git/config')).toBe(true);
        expect(policy.isAlwaysExcluded('.erden/install.json')).toBe(true);
        expect(policy.isIgnored('build/generated.ttl')).toBe(true);
        expect(policy.isIgnored('ordinary.tmp')).toBe(true);
        expect(policy.isIgnored('important.tmp')).toBe(false);
        expect(policy.isIgnored('ignored-by-git.ttl')).toBe(false);
        expect(Object.isFrozen(policy)).toBe(true);
    });

    it('keeps the shared ignore decoder strict and snapshots hostile byte input', () => {
        expectFixtureError(
            () =>
                makePackageIgnorePolicy({
                    erdenIgnore: Uint8Array.of(0xff),
                }),
            'invalid-utf8',
        );
        expect(() =>
            makePackageIgnorePolicy({
                erdenIgnore: new Proxy(new Uint8Array(), {}),
            }),
        ).toThrow(PackageFixtureError);
    });

    it('rejects generated-manifest input and every source link/device kind', () => {
        expectFixtureError(
            () =>
                encodeReferencePackageFixture({
                    ...GOLDEN_INPUT,
                    files: [{ path: GENERATED_MANIFEST_PATH, bytes: '{}' }],
                }),
            'generated-path',
        );
        for (const kind of ['symlink', 'hardlink'] as const) {
            expectFixtureError(
                () =>
                    encodeReferencePackageFixture({
                        ...GOLDEN_INPUT,
                        files: [{ path: kind, kind, linkTarget: '../outside' }],
                    }),
                'link-entry',
            );
        }
        expectFixtureError(
            () => encodeReferencePackageFixture({ ...GOLDEN_INPUT, files: [{ path: 'device', kind: 'device' }] }),
            'device-entry',
        );
    });

    it('uses npm semver prerelease and build-metadata range semantics for resolved edges', () => {
        const prerelease = { ...ZETA_DEPENDENCY, requested: '*', version: '1.0.0-beta.1' };
        expectFixtureError(
            () =>
                encodeReferencePackageFixture({
                    ...GOLDEN_INPUT,
                    dependencies: [prerelease],
                }),
            'manifest-integrity',
        );
        expect(() =>
            encodeReferencePackageFixture({
                ...GOLDEN_INPUT,
                dependencies: [{ ...prerelease, requested: '>=1.0.0-beta.1 <1.0.0' }],
            }),
        ).not.toThrow();
        const built = encodeReferencePackageFixture({
            ...GOLDEN_INPUT,
            version: '1.2.3+tested',
            validator: { ...GOLDEN_INPUT.validator, version: '1.9.8+tested' },
            dependencies: [{ ...ZETA_DEPENDENCY, requested: '1.0.0', version: '1.0.0+tested' }],
        });
        expect(built.manifest.version).toBe('1.2.3+tested');
        expect(built.manifest.toolchain.validator.version).toBe('1.9.8+tested');
        expect(built.manifest.dependencies[0]?.version).toBe('1.0.0+tested');
        const boundaryVersion = `1.0.0+${'a'.repeat(250)}`;
        const boundary = encodeReferencePackageFixture({
            ...GOLDEN_INPUT,
            dependencies: [{ ...ZETA_DEPENDENCY, requested: '1.0.0', version: boundaryVersion }],
        });
        expect(boundary.manifest.dependencies[0]?.version).toBe(boundaryVersion);
        for (const requested of ['=>1.0.0', ' 1.0.0', '1.0.0 ']) {
            expectFixtureError(
                () =>
                    encodeReferencePackageFixture({
                        ...GOLDEN_INPUT,
                        dependencies: [{ ...ZETA_DEPENDENCY, requested, version: '1.0.0' }],
                    }),
                'manifest-integrity',
            );
        }
    });

    it.each([
        ['empty package IRI', { ...GOLDEN_INPUT, canonicalIri: '' }],
        ['relative package IRI', { ...GOLDEN_INPUT, canonicalIri: 'relative/package' }],
        ['noncanonical package IRI', { ...GOLDEN_INPUT, canonicalIri: 'HTTPS://EXAMPLE.TEST:443/packages/demo' }],
        ['nonexact package version', { ...GOLDEN_INPUT, version: '^1.2.3' }],
        ['oversized package version', { ...GOLDEN_INPUT, version: `1.2.3+${'a'.repeat(300)}` }],
        [
            'nonexact validator version',
            { ...GOLDEN_INPUT, validator: { ...GOLDEN_INPUT.validator, version: 'robot@1.9.8' } },
        ],
        [
            'oversized validator version',
            { ...GOLDEN_INPUT, validator: { ...GOLDEN_INPUT.validator, version: `1.9.8+${'a'.repeat(300)}` } },
        ],
        [
            'invalid reasoner digest',
            { ...GOLDEN_INPUT, reasoner: { ...GOLDEN_INPUT.reasoner, sha256: HASH_D.toUpperCase() } },
        ],
        ['dependency range mismatch', { ...GOLDEN_INPUT, dependencies: [{ ...ZETA_DEPENDENCY, version: '3.0.0' }] }],
        ['empty dependency request', { ...GOLDEN_INPUT, dependencies: [{ ...ZETA_DEPENDENCY, requested: '' }] }],
        ['nonexact dependency version', { ...GOLDEN_INPUT, dependencies: [{ ...ZETA_DEPENDENCY, version: '2.1' }] }],
        [
            'oversized dependency version',
            { ...GOLDEN_INPUT, dependencies: [{ ...ZETA_DEPENDENCY, version: `2.1.0+${'a'.repeat(300)}` }] },
        ],
        [
            'relative dependency IRI',
            { ...GOLDEN_INPUT, dependencies: [{ ...ZETA_DEPENDENCY, canonicalIri: 'relative/dependency' }] },
        ],
        [
            'invalid dependency digest',
            { ...GOLDEN_INPUT, dependencies: [{ ...ZETA_DEPENDENCY, archiveSha256: '0'.repeat(63) }] },
        ],
        [
            'self dependency',
            { ...GOLDEN_INPUT, dependencies: [{ ...ZETA_DEPENDENCY, canonicalIri: GOLDEN_INPUT.canonicalIri }] },
        ],
        [
            'duplicate dependency identity',
            { ...GOLDEN_INPUT, dependencies: [ZETA_DEPENDENCY, { ...ZETA_DEPENDENCY, requested: '~2.1.0' }] },
        ],
    ] as const)('rejects encoder input with %s', (_name, input) => {
        expectFixtureError(() => encodeReferencePackageFixture(input), 'manifest-integrity');
    });

    it('rejects required manifest fields in the validator and encoder', () => {
        const fixture = encodeReferencePackageFixture(GOLDEN_INPUT);
        const { version: omittedVersion, ...missingVersion } = fixture.manifest;
        expect(omittedVersion).toBe('1.2.3');
        expectFixtureError(
            () => validateReferenceArchiveFixture(encodeManifestArchive(missingVersion)),
            'manifest-integrity',
        );

        const missingReasoner = {
            canonicalIri: GOLDEN_INPUT.canonicalIri,
            version: GOLDEN_INPUT.version,
            dependencies: GOLDEN_INPUT.dependencies,
            validator: GOLDEN_INPUT.validator,
            files: GOLDEN_INPUT.files,
        };
        expectFixtureError(() => {
            Reflect.apply(encodeReferencePackageFixture, undefined, [missingReasoner]);
        }, 'manifest-integrity');
    });

    it.each([
        [
            'relative canonical IRI',
            (manifest: typeof fixtureManifest) => ({ ...manifest, canonicalIri: 'relative/package' }),
        ],
        ['nonexact package version', (manifest: typeof fixtureManifest) => ({ ...manifest, version: '^1.2.3' })],
        [
            'nonexact tool version',
            (manifest: typeof fixtureManifest) => ({
                ...manifest,
                toolchain: {
                    ...manifest.toolchain,
                    validator: { ...manifest.toolchain.validator, version: 'robot@1.9.8' },
                },
            }),
        ],
        [
            'invalid tool digest',
            (manifest: typeof fixtureManifest) => ({
                ...manifest,
                toolchain: {
                    ...manifest.toolchain,
                    reasoner: { ...manifest.toolchain.reasoner, sha256: HASH_D.toUpperCase() },
                },
            }),
        ],
        [
            'incoherent dependency range',
            (manifest: typeof fixtureManifest) => ({
                ...manifest,
                dependencies: [{ ...ZETA_DEPENDENCY, version: '3.0.0' }],
            }),
        ],
        [
            'duplicate dependency identity',
            (manifest: typeof fixtureManifest) => ({
                ...manifest,
                dependencies: [ZETA_DEPENDENCY, { ...ZETA_DEPENDENCY, requested: '~2.1.0' }],
            }),
        ],
    ] as const)('shares the %s rejection with the archive validator', (_name, mutate) => {
        expectFixtureError(
            () => validateReferenceArchiveFixture(encodeManifestArchive(mutate(fixtureManifest))),
            'manifest-integrity',
        );
    });
});

describe('deterministic reference archive', () => {
    it('matches golden hashes and normalized USTAR/gzip metadata', () => {
        const fixture = encodeReferencePackageFixture(GOLDEN_INPUT);
        const reordered = encodeReferencePackageFixture({ ...GOLDEN_INPUT, files: [...GOLDEN_INPUT.files].reverse() });
        const headers = summarizeHeaders(fixture.archiveBytes);
        const paths = headers.map(({ path }) => path);

        expect(fixture.archiveBytes).toEqual(reordered.archiveBytes);
        expect(fixture.archiveSha256).toBe('723dece4b69924733b2f6c23da77601dc7a37ea7d3345e8574212b6c0fccd0f3');
        expect(fixture.manifestSha256).toBe('4f52751370fe9480c3911c9de4e99c5e4404c549f7c913e45b9b1e87291d7ab3');
        expect(fixture.archiveSha256).toBe(sha256(fixture.archiveBytes));
        expect(fixture.manifestSha256).toBe(sha256(fixture.manifestBytes));
        expect([...fixture.archiveBytes.subarray(0, 10)]).toEqual([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);
        expect(fixture.manifest.files.some(({ path }) => path === GENERATED_MANIFEST_PATH)).toBe(false);
        expect(new TextDecoder().decode(fixture.manifestBytes)).not.toContain(fixture.archiveSha256);
        expect(paths).toEqual([
            'package/',
            'package/.erden/',
            'package/.erden/package-manifest.json',
            'package/ignored-by-git.ttl',
            'package/important.tmp',
            'package/ontology/',
            'package/ontology/caf\u00e9.ttl',
            'package/scripts/',
            'package/scripts/check.sh',
            'package/zeta.txt',
        ]);
        expect(paths).not.toContain('package/package/');
        expect(
            headers.every(
                ({ uid, gid, mtime, uname, gname }) =>
                    uid === 0 && gid === 0 && mtime === 0 && uname === '' && gname === '',
            ),
        ).toBe(true);
        expect(
            headers.filter(({ typeFlag }) => typeFlag === '5').every(({ mode, size }) => mode === 0o755 && size === 0),
        ).toBe(true);
        expect(headers.find(({ path }) => path === 'package/scripts/check.sh')?.mode).toBe(0o755);
        expect(Buffer.from(fixture.archiveBytes).includes(Buffer.from(process.cwd(), 'utf8'))).toBe(false);

        const validated = validateReferenceArchiveFixture(fixture.archiveBytes);
        expect(validated.archiveSha256).toBe(fixture.archiveSha256);
        expect(validated.manifest).toEqual(fixture.manifest);
        expect(validated.files).toEqual(fixture.manifest.files);
    });

    it.each([
        [
            'unused header tail',
            (header: Uint8Array) => {
                header[500] = 1;
            },
            'invalid-header',
        ],
        [
            'hidden name bytes',
            (header: Uint8Array) => {
                header[20] = 0x78;
            },
            'invalid-header',
        ],
        [
            'noncanonical octal padding',
            (header: Uint8Array) => {
                header[100] = 0x20;
            },
            'invalid-header',
        ],
        [
            'NUL regular-file type',
            (header: Uint8Array) => {
                header[156] = 0;
            },
            'unsupported-entry',
        ],
        [
            'noncanonical magic',
            (header: Uint8Array) => {
                header[262] = 0x78;
            },
            'invalid-header',
        ],
        [
            'noncanonical version',
            (header: Uint8Array) => {
                header[263] = 0x31;
            },
            'invalid-header',
        ],
        [
            'noncanonical name/prefix split',
            (header: Uint8Array) => {
                header.fill(0, 0, 100);
                header.set(new TextEncoder().encode('package'), 345);
            },
            'invalid-header',
        ],
    ] as const)('rejects a corrected-checksum %s mutation', (_name, mutate, code) => {
        const fixture = encodeReferencePackageFixture(GOLDEN_INPUT);
        expectFixtureError(
            () => validateReferenceArchiveFixture(mutateFirstHeader(fixture.archiveBytes, mutate)),
            code,
        );
    });

    it('rejects a noncanonical checksum field even when its numeric checksum is correct', () => {
        const fixture = encodeReferencePackageFixture(GOLDEN_INPUT);
        const tar = Uint8Array.from(gunzipSync(fixture.archiveBytes));
        const header = tar.subarray(0, TAR_BLOCK_SIZE);
        repairHeaderChecksum(header);
        header[148] = 0x20;
        expectFixtureError(() => validateReferenceArchiveFixture(gzipReferenceBytes(tar)), 'invalid-header');
    });
});

describe('malicious and incompatible archive fixtures', () => {
    it.each([
        ['traversal', MALICIOUS_ARCHIVES.traversal, {}, 'traversal-path'],
        ['absolute', MALICIOUS_ARCHIVES.absolute, {}, 'archive-root'],
        ['drive', MALICIOUS_ARCHIVES.drive, {}, 'drive-path'],
        ['symlink', MALICIOUS_ARCHIVES.symlink, {}, 'link-entry'],
        ['hardlink', MALICIOUS_ARCHIVES.hardlink, {}, 'link-entry'],
        ['duplicate', MALICIOUS_ARCHIVES.duplicate, {}, 'duplicate-path'],
        ['case conflict', MALICIOUS_ARCHIVES.caseConflict, {}, 'case-conflict'],
        ['file/descendant conflict', MALICIOUS_ARCHIVES.fileDescendantConflict, {}, 'conflicting-path'],
        ['device', MALICIOUS_ARCHIVES.device, {}, 'device-entry'],
        ['FIFO', MALICIOUS_ARCHIVES.fifo, {}, 'device-entry'],
        ['PAX extension', MALICIOUS_ARCHIVES.pax, {}, 'unsupported-entry'],
        ['oversized entry', MALICIOUS_ARCHIVES.oversizedEntry, { maxEntryBytes: 4 }, 'limit-entry-size'],
        ['too many entries', MALICIOUS_ARCHIVES.tooManyEntries, { maxEntries: 1 }, 'limit-entries'],
        ['excessive depth', MALICIOUS_ARCHIVES.tooDeep, { maxPathDepth: 2 }, 'limit-depth'],
        ['missing manifest', MALICIOUS_ARCHIVES.missingManifest, {}, 'missing-manifest'],
        ['unsupported version', MALICIOUS_ARCHIVES.unsupportedVersion, {}, 'unsupported-version'],
        [
            'decompressed-total bomb',
            MALICIOUS_ARCHIVES.decompressionBomb,
            { maxDecompressedBytes: 1024 },
            'limit-decompressed-total',
        ],
        [
            'compression-ratio bomb',
            MALICIOUS_ARCHIVES.decompressionBomb,
            { maxDecompressedBytes: 128 * 1024, maxCompressionRatio: 2 },
            'limit-compression-ratio',
        ],
    ] as const)('rejects the %s fixture before extraction', (_name, archive, limits, code) => {
        expectFixtureError(() => validateReferenceArchiveFixture(archive, limits), code);
    });
});
