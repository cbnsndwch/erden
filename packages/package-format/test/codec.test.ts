import { createHash } from 'node:crypto';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    encodePackage,
    encodeReferencePackageFixture,
    makePackageCodec,
    PackageCodecError,
    validatePackageArchive,
    validatePackageArchiveStream,
    type PackageCodecErrorCode,
    type PackageCodecLimits,
    type PackageEncodeInput,
} from '../src/index.js';

import { MALICIOUS_ARCHIVES } from './fixtures.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const INPUT: PackageEncodeInput = {
    canonicalIri: 'https://example.test/layers/codec',
    version: '1.0.0',
    dependencies: [],
    validator: { version: '1.0.0', sha256: HASH_A },
    reasoner: { version: '1.0.0', sha256: HASH_B },
    files: [
        { path: 'zeta.ttl', bytes: '<urn:z> <urn:p> <urn:o> .\n', executable: false },
        { path: 'bin\\verify', bytes: '#!/bin/sh\n', executable: true },
        { path: 'ontology/cafe\u0301.ttl', bytes: '<urn:s> <urn:p> <urn:o> .\n', executable: false },
    ],
};

async function* chunks(bytes: Uint8Array, sizes: ReadonlyArray<number>): AsyncIterable<Uint8Array> {
    let offset = 0;
    let index = 0;
    while (offset < bytes.length) {
        yield await Promise.resolve(new Uint8Array());
        const size = sizes[index % sizes.length] ?? 1;
        yield await Promise.resolve(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
        offset += size;
        index += 1;
    }
}

async function expectCodecError(
    operation: Promise<unknown> | Effect.Effect<unknown, PackageCodecError>,
    code: PackageCodecErrorCode,
): Promise<void> {
    try {
        if (Effect.isEffect(operation)) {
            await Effect.runPromise(operation);
        } else {
            await operation;
        }
        throw new Error(`Expected ${code}`);
    } catch (error) {
        if (!(error instanceof PackageCodecError)) {
            throw error;
        }
        expect(error.code).toBe(code);
        expect(Object.keys(error)).not.toContain('cause');
    }
}

describe('production PackageCodec', () => {
    it('encodes the exact oracle bytes independent of logical input order', () => {
        const encoded = encodePackage(INPUT);
        const reversed = encodePackage({ ...INPUT, files: [...INPUT.files].reverse() });
        const oracle = encodeReferencePackageFixture(INPUT);
        expect(Buffer.from(encoded.archiveBytes).equals(Buffer.from(oracle.archiveBytes))).toBe(true);
        expect(reversed.archiveBytes).toEqual(encoded.archiveBytes);
        expect(encoded.archiveSha256).toBe(createHash('sha256').update(encoded.archiveBytes).digest('hex'));
        expect(encoded.manifest).toEqual(oracle.manifest);
        expect(encoded.manifestBytes).toEqual(oracle.manifestBytes);
        const archiveCopy = encoded.archiveBytes;
        archiveCopy[0] = 0;
        const manifestCopy = encoded.manifestBytes;
        manifestCopy[0] = 0;
        expect(encoded.archiveBytes[0]).toBe(0x1f);
        expect(new TextDecoder().decode(encoded.manifestBytes)).toMatch(/^\{/u);
        expect(Object.isFrozen(encoded.manifest.toolchain)).toBe(true);
    });

    it.each([[1], [2, 3, 5, 7, 11], [9, 1, 4, 511, 512, 513], [65_535, 1, 8]])(
        'validates arbitrary chunk boundaries %j without buffering the decompressed archive',
        async (...sizes) => {
            const encoded = encodePackage(INPUT);
            const validated = await validatePackageArchiveStream(chunks(encoded.archiveBytes, sizes));
            expect(validated.archiveSha256).toBe(encoded.archiveSha256);
            expect(validated.manifestSha256).toBe(encoded.manifestSha256);
            expect(validated.manifest).toEqual(encoded.manifest);
            expect(validated.files).toEqual(
                encoded.manifest.files.map((file) => ({ ...file, mode: file.executable ? 0o755 : 0o644 })),
            );
            expect(Object.isFrozen(validated)).toBe(true);
            expect(Object.isFrozen(validated.manifest.files)).toBe(true);
        },
    );

    it('supports the Effect service boundary and snapshots producer chunks', async () => {
        const encoded = encodePackage(INPUT);
        const result = await Effect.runPromise(validatePackageArchive(encoded.archiveBytes));
        expect(result.archiveSha256).toBe(encoded.archiveSha256);
        const service = makePackageCodec();
        const serviceEncoded = await Effect.runPromise(service.encode(INPUT));
        const serviceValidated = await Effect.runPromise(service.validate(serviceEncoded.archiveBytes));
        expect(serviceValidated.archiveSha256).toBe(serviceEncoded.archiveSha256);
    });

    it('returns path-free typed encoder failures with a nonenumerable cause', () => {
        const secret = 'D:/physical-secret/project/ontology.ttl';
        try {
            encodePackage({ ...INPUT, files: [{ path: secret, bytes: 'secret', executable: false }] });
            throw new Error('Expected path refusal');
        } catch (error) {
            if (!(error instanceof PackageCodecError)) {
                throw error;
            }
            expect(error.code).toBe('drive-path');
            expect(error.message).not.toContain('physical-secret');
            expect(JSON.stringify(error)).not.toContain('physical-secret');
            expect(Object.keys(error)).not.toContain('cause');
        }
    });

    it('rejects ill-formed UTF-16 text bytes instead of replacement-encoding them', () => {
        expect(() =>
            encodePackage({
                ...INPUT,
                files: [{ path: 'invalid.txt', bytes: 'before\uD800after', executable: false }],
            }),
        ).toThrow(expect.objectContaining({ code: 'invalid-utf8' }));
    });

    it.each([
        ['traversal', MALICIOUS_ARCHIVES.traversal, 'traversal-path'],
        ['absolute', MALICIOUS_ARCHIVES.absolute, 'archive-root'],
        ['drive', MALICIOUS_ARCHIVES.drive, 'drive-path'],
        ['symlink', MALICIOUS_ARCHIVES.symlink, 'link-entry'],
        ['hardlink', MALICIOUS_ARCHIVES.hardlink, 'link-entry'],
        ['duplicate', MALICIOUS_ARCHIVES.duplicate, 'duplicate-path'],
        ['case conflict', MALICIOUS_ARCHIVES.caseConflict, 'case-conflict'],
        ['file descendant', MALICIOUS_ARCHIVES.fileDescendantConflict, 'conflicting-path'],
        ['device', MALICIOUS_ARCHIVES.device, 'device-entry'],
        ['FIFO', MALICIOUS_ARCHIVES.fifo, 'device-entry'],
        ['PAX', MALICIOUS_ARCHIVES.pax, 'unsupported-entry'],
        ['missing manifest', MALICIOUS_ARCHIVES.missingManifest, 'missing-manifest'],
        ['unsupported version', MALICIOUS_ARCHIVES.unsupportedVersion, 'unsupported-version'],
    ] as const)('rejects oracle attack fixture %s with the same policy', async (_name, archive, code) => {
        await expectCodecError(validatePackageArchiveStream(chunks(archive, [1, 17, 511])), code);
    });

    it.each([
        ['oversized entry', MALICIOUS_ARCHIVES.oversizedEntry, { maxEntryBytes: 4 }, 'limit-entry-size'],
        ['too many entries', MALICIOUS_ARCHIVES.tooManyEntries, { maxEntries: 1 }, 'limit-entries'],
        ['excessive depth', MALICIOUS_ARCHIVES.tooDeep, { maxPathDepth: 2 }, 'limit-depth'],
        [
            'decompressed bomb',
            MALICIOUS_ARCHIVES.decompressionBomb,
            { maxDecompressedBytes: 1024 },
            'limit-decompressed-total',
        ],
        [
            'ratio bomb',
            MALICIOUS_ARCHIVES.decompressionBomb,
            { maxDecompressedBytes: 128 * 1024, maxCompressionRatio: 2 },
            'limit-compression-ratio',
        ],
    ] as const)('matches oracle limit decision for %s', async (_name, archive, limits, code) => {
        await expectCodecError(validatePackageArchiveStream(chunks(archive, [1, 511]), limits), code);
    });

    it('enforces compressed, actual decompressed, entry, and ratio bounds while streaming', async () => {
        const encoded = encodePackage(INPUT);
        await expectCodecError(
            validatePackageArchiveStream(encoded.archiveBytes, { maxCompressedBytes: encoded.archiveBytes.length - 1 }),
            'compressed-limit',
        );
        await expectCodecError(
            validatePackageArchiveStream(encoded.archiveBytes, { maxDecompressedBytes: 1024 }),
            'limit-decompressed-total',
        );
        await expectCodecError(
            validatePackageArchiveStream(encoded.archiveBytes, { maxEntryBytes: 8 }),
            'limit-entry-size',
        );
        await expectCodecError(
            validatePackageArchiveStream(encoded.archiveBytes, { maxCompressionRatio: 0.5 }),
            'limit-compression-ratio',
        );
    });

    it.each([
        ['maxEntries', 0],
        ['maxEntries', -1],
        ['maxEntries', 1.5],
        ['maxEntryBytes', Number.NaN],
        ['maxDecompressedBytes', Number.POSITIVE_INFINITY],
        ['maxCompressedBytes', Number.NEGATIVE_INFINITY],
        ['maxPathDepth', 0],
        ['maxPathBytes', Number.NaN],
        ['maxCompressionRatio', 0],
        ['maxCompressionRatio', Number.POSITIVE_INFINITY],
    ] as const)('rejects invalid %s override before reading', async (key, value) => {
        let pulls = 0;
        const source = (async function* (): AsyncIterable<Uint8Array> {
            pulls += 1;
            yield await Promise.resolve(encodePackage(INPUT).archiveBytes);
        })();
        await expectCodecError(validatePackageArchiveStream(source, { [key]: value }), 'invalid-limits');
        expect(pulls).toBe(0);
    });

    it('rejects unknown or throwing limit fields at the typed direct boundary', async () => {
        const archive = encodePackage(INPUT).archiveBytes;
        await expectCodecError(
            validatePackageArchiveStream(archive, { unknown: 1 } as Partial<PackageCodecLimits>),
            'invalid-limits',
        );
        const limits = Object.defineProperty({}, 'maxEntries', {
            enumerable: true,
            get() {
                throw new Error('D:/limit-secret');
            },
        });
        await expectCodecError(validatePackageArchiveStream(archive, limits), 'source-read');
    });

    it('makes ratio decisions independent of source chunking', async () => {
        const archive = encodePackage(INPUT).archiveBytes;
        const ratio = 0.99;
        const whole = validatePackageArchiveStream(archive, { maxCompressionRatio: ratio });
        const split = validatePackageArchiveStream(chunks(archive, [1]), { maxCompressionRatio: ratio });
        await expectCodecError(whole, 'limit-compression-ratio');
        await expectCodecError(split, 'limit-compression-ratio');
    });

    it('preserves oracle limit precedence for a non-profile compression bomb', async () => {
        await expectCodecError(
            validatePackageArchiveStream(MALICIOUS_ARCHIVES.decompressionBomb, {
                maxDecompressedBytes: 128 * 1024,
                maxCompressionRatio: 2,
            }),
            'limit-compression-ratio',
        );
        await expectCodecError(
            validatePackageArchiveStream(chunks(MALICIOUS_ARCHIVES.decompressionBomb, [1]), {
                maxDecompressedBytes: 1024,
            }),
            'limit-decompressed-total',
        );
    });

    it('rejects every truncation and trailing or concatenated member framing', async () => {
        const archive = encodePackage(INPUT).archiveBytes;
        for (const length of [0, 1, 9, 10, 14, archive.length - 9, archive.length - 1]) {
            await expectCodecError(validatePackageArchiveStream(archive.subarray(0, length)), 'gzip-profile');
        }
        await expectCodecError(
            validatePackageArchiveStream(Buffer.concat([archive, Uint8Array.of(1)])),
            'gzip-profile',
        );
        await expectCodecError(validatePackageArchiveStream(Buffer.concat([archive, archive])), 'gzip-profile');
    });

    it('rejects CRC and ISIZE corruption after consuming the whole member', async () => {
        const archive = Uint8Array.from(encodePackage(INPUT).archiveBytes);
        archive[archive.length - 8] = (archive[archive.length - 8] ?? 0) ^ 1;
        await expectCodecError(validatePackageArchiveStream(archive), 'gzip-profile');
        const isize = Uint8Array.from(encodePackage(INPUT).archiveBytes);
        isize[isize.length - 4] = (isize[isize.length - 4] ?? 0) ^ 1;
        await expectCodecError(validatePackageArchiveStream(isize), 'gzip-profile');
    });

    it('does not let a forged oversized ISIZE bypass the declared decompressed limit', async () => {
        const archive = Buffer.from(encodePackage(INPUT).archiveBytes);
        const actualSize = archive.readUInt32LE(archive.length - 4);
        const limit = actualSize + 1024;
        archive.writeUInt32LE(limit + 1, archive.length - 4);
        await expectCodecError(
            validatePackageArchiveStream(archive, { maxDecompressedBytes: limit }),
            'limit-decompressed-total',
        );
        await expectCodecError(
            validatePackageArchiveStream(chunks(archive, [1]), { maxDecompressedBytes: limit }),
            'limit-decompressed-total',
        );
    });

    it('wraps producer failures without exposing enumerable causes', async () => {
        const sentinel = new Error('physical-secret');
        const source = (async function* (): AsyncIterable<Uint8Array> {
            yield await Promise.resolve(Uint8Array.of(0x1f));
            throw sentinel;
        })();
        await expectCodecError(validatePackageArchiveStream(source), 'source-read');
    });

    it('requires a clean producer EOF after the complete gzip member', async () => {
        const archive = encodePackage(INPUT).archiveBytes;
        const source = (async function* (): AsyncIterable<Uint8Array> {
            yield await Promise.resolve(archive);
            throw new Error('failure after member');
        })();
        await expectCodecError(validatePackageArchiveStream(source), 'source-read');
    });

    it('wraps a throwing async-iterator factory before any read', async () => {
        const source = {
            [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
                throw new Error('D:/physical-secret/archive.tgz');
            },
        };
        await expectCodecError(validatePackageArchiveStream(source), 'source-read');
    });

    it('wraps sink failures at the direct streaming boundary', async () => {
        const archive = encodePackage(INPUT).archiveBytes;
        await expectCodecError(
            validatePackageArchiveStream(
                archive,
                {},
                {
                    startFile: () => Promise.reject(new Error('D:/sink-secret/output')),
                },
            ),
            'sink-write',
        );
    });
});
