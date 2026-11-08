import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    assertNoPortablePathConflicts,
    decodePackageFileLocation,
    encodePackage,
    extractPackageFileBytes,
    MAX_PACKAGE_FILE_LOCATION_RUNS,
    PackageCodecError,
    PackageFileLocationBuilder,
    packageFileSpan,
    PortablePathConflictTracker,
    validatePackageArchiveStream,
    type PackageEncodeInput,
    type PackageFileLocation,
    type PortablePathRecord,
} from '../src/index.js';

const HASH = 'a'.repeat(64);

function input(files: PackageEncodeInput['files']): PackageEncodeInput {
    return {
        canonicalIri: 'https://example.test/layers/location',
        version: '1.0.0',
        dependencies: [],
        validator: { version: '1.0.0', sha256: HASH },
        reasoner: { version: '1.0.0', sha256: HASH },
        files,
    };
}

function storedBlocks(archive: Uint8Array): Uint8Array {
    const parts: Uint8Array[] = [];
    let offset = 10;
    for (;;) {
        const final = archive[offset] === 1;
        const length = (archive[offset + 1] ?? 0) | ((archive[offset + 2] ?? 0) << 8);
        parts.push(archive.subarray(offset + 5, offset + 5 + length));
        offset += 5 + length;
        if (final) {
            return Buffer.concat(parts);
        }
    }
}

/** The same tar stream under other block lengths, which the reader must accept and report truthfully. */
function reblock(archive: Uint8Array, lengths: ReadonlyArray<number>): Uint8Array {
    const tar = storedBlocks(archive);
    const parts: Uint8Array[] = [archive.subarray(0, 10)];
    let offset = 0;
    let index = 0;
    while (offset < tar.length) {
        const length = Math.min(lengths[index % lengths.length] ?? 1, tar.length - offset);
        index += 1;
        const final = offset + length === tar.length;
        const header = Buffer.alloc(5);
        header[0] = final ? 1 : 0;
        header.writeUInt16LE(length, 1);
        header.writeUInt16LE(~length & 0xffff, 3);
        parts.push(header, tar.subarray(offset, offset + length));
        offset += length;
    }
    parts.push(archive.subarray(archive.length - 8));
    return Buffer.concat(parts);
}

async function locate(archive: Uint8Array): Promise<ReadonlyMap<string, PackageFileLocation>> {
    const builders = new Map<string, PackageFileLocationBuilder>();
    await validatePackageArchiveStream(
        archive,
        {},
        {
            startFile: (path) => {
                builders.set(path, new PackageFileLocationBuilder());
                return Promise.resolve();
            },
            writeFile: (path, bytes, offset) => {
                builders.get(path)?.add(offset, bytes.byteLength);
                return Promise.resolve();
            },
        },
    );
    return new Map([...builders].map(([path, builder]) => [path, builder.finish()]));
}

function expectExact(
    archive: Uint8Array,
    locations: ReadonlyMap<string, PackageFileLocation>,
    files: PackageEncodeInput['files'],
): void {
    for (const file of files) {
        const location = locations.get(file.path);
        if (location === undefined) {
            throw new Error(`No location for ${file.path}`);
        }
        const bytes = typeof file.bytes === 'string' ? new TextEncoder().encode(file.bytes) : file.bytes;
        const decoded = decodePackageFileLocation(
            JSON.parse(JSON.stringify(location)) as unknown,
            bytes.byteLength,
            archive.byteLength,
        );
        const span = packageFileSpan(decoded);
        const view = archive.subarray(span.offset, span.offset + span.length);
        const extracted = extractPackageFileBytes(decoded, bytes.byteLength, view, span.offset);
        expect(Buffer.from(extracted).equals(Buffer.from(bytes)), file.path).toBe(true);
    }
}

const FILES: PackageEncodeInput['files'] = [
    { path: 'a-empty.txt', bytes: new Uint8Array(), executable: false },
    { path: 'b-small.txt', bytes: 'small\n', executable: false },
    { path: 'c-spans-blocks.bin', bytes: randomBytes(3 * 65535 + 17), executable: false },
    { path: 'd-exactly-one-block.bin', bytes: randomBytes(65535), executable: false },
    { path: 'e-empty.txt', bytes: '', executable: true },
    { path: 'f/g-last.txt', bytes: randomBytes(600), executable: false },
];

describe('package file locations', () => {
    it('finds every file in an archive from the encoder', async () => {
        const encoded = encodePackage(input(FILES));
        const archive = encoded.archiveBytes;
        const locations = await locate(archive);
        expectExact(archive, locations, FILES);
        expect(locations.get('a-empty.txt')).toEqual({ offset: 0, runs: [] });
        expect(locations.get('c-spans-blocks.bin')?.runs.length).toBeLessThanOrEqual(3);
    });

    it.each([
        ['small varying blocks', [1, 7, 512, 513, 4096, 3]],
        ['large varying blocks', [65535, 1, 40000, 65534]],
        ['a block for every byte of a header', [1]],
    ])('finds every file under %s', async (_name, lengths) => {
        // Single-byte blocks need a small package to stay within the location limit.
        const files = lengths.length === 1 ? FILES.filter(({ path }) => path < 'c' || path.startsWith('e')) : FILES;
        const archive = reblock(encodePackage(input(files)).archiveBytes, lengths);
        expectExact(archive, await locate(archive), files);
    });

    it('records an empty block inside a file as a zero-length segment', () => {
        const builder = new PackageFileLocationBuilder();
        builder.add(100, 10);
        builder.add(120, 10); // One empty block sits between the two parts: 10 header bytes.
        const location = builder.finish();
        expect(location).toEqual({
            offset: 100,
            runs: [
                [10, 1],
                [0, 1],
                [10, 1],
            ],
        });
        expect(packageFileSpan(location)).toEqual({ offset: 100, length: 30 });
        const buffer = Uint8Array.from({ length: 40 }, (_, index) => index);
        const extracted = extractPackageFileBytes(location, 20, buffer, 100);
        expect([...extracted]).toEqual([
            ...Array.from({ length: 10 }, (_, index) => index),
            ...Array.from({ length: 10 }, (_, index) => index + 20),
        ]);
    });

    it('refuses a gap that is not whole block headers, and more runs than a ticket can carry', () => {
        const builder = new PackageFileLocationBuilder();
        builder.add(100, 10);
        expect(() => {
            builder.add(113, 10);
        }).toThrow(PackageCodecError);
        // Every segment a different length, so no two runs merge.
        const distinct = new PackageFileLocationBuilder();
        expect(() => {
            let offset = 0;
            for (let index = 0; index <= MAX_PACKAGE_FILE_LOCATION_RUNS + 1; index += 1) {
                const length = index + 1;
                distinct.add(offset, length);
                offset += length + 5;
            }
            distinct.finish();
        }).toThrow(PackageCodecError);
    });

    it.each([
        ['a location for an empty file', { offset: 10, runs: [] }, 0],
        ['no runs for a file with bytes', { offset: 10, runs: [] }, 5],
        ['the wrong total', { offset: 10, runs: [[4, 1]] }, 5],
        ['a span past the archive', { offset: 990, runs: [[20, 1]] }, 20],
        ['a segment no block can hold', { offset: 0, runs: [[70000, 1]] }, 70000],
        [
            'non-canonical adjacent runs',
            {
                offset: 0,
                runs: [
                    [2, 1],
                    [2, 1],
                ],
            },
            4,
        ],
        ['a non-integer offset', { offset: 1.5, runs: [[2, 1]] }, 2],
        ['extra fields', { offset: 0, runs: [[2, 1]], extra: true }, 2],
    ])('refuses %s', (_name, location, byteSize) => {
        expect(() => decodePackageFileLocation(location, byteSize, 1000)).toThrow(PackageCodecError);
    });
});

describe('PortablePathConflictTracker', () => {
    const SETS: ReadonlyArray<ReadonlyArray<PortablePathRecord>> = [
        [
            { path: 'a', kind: 'directory' },
            { path: 'a/b', kind: 'file' },
        ],
        [
            { path: 'a', kind: 'file' },
            { path: 'a/b', kind: 'file' },
        ],
        [
            { path: 'a/b', kind: 'file' },
            { path: 'a', kind: 'file' },
        ],
        [
            { path: 'a/b', kind: 'file' },
            { path: 'a', kind: 'directory' },
        ],
        [
            { path: 'x', kind: 'file' },
            { path: 'x', kind: 'file' },
        ],
        [
            { path: 'A.ttl', kind: 'file' },
            { path: 'a.ttl', kind: 'file' },
        ],
        [
            { path: 'café', kind: 'file' },
            { path: 'café', kind: 'file' },
        ],
        [
            { path: 'Σ', kind: 'file' },
            { path: 'ς', kind: 'file' },
        ],
        [
            { path: 'deep/er/a', kind: 'file' },
            { path: 'deep/er', kind: 'directory' },
            { path: 'deep', kind: 'directory' },
            { path: 'other', kind: 'file' },
        ],
    ];

    function outcome(run: () => void): string {
        try {
            run();
            return 'accepted';
        } catch (error) {
            return (error as { code: string }).code;
        }
    }

    it.each(SETS.map((set, index) => [index, set] as const))('decides set %i like the full check', (_index, set) => {
        const tracker = new PortablePathConflictTracker();
        expect(
            outcome(() => {
                for (const record of set) {
                    tracker.add(record);
                }
            }),
        ).toBe(
            outcome(() => {
                assertNoPortablePathConflicts(set);
            }),
        );
    });

    it('stays linear on a package at the entry limit', () => {
        const tracker = new PortablePathConflictTracker();
        const started = performance.now();
        for (let index = 0; index < 10_000; index += 1) {
            tracker.add({ path: `data/${String(index % 100)}/file-${String(index)}.txt`, kind: 'file' });
        }
        expect(performance.now() - started).toBeLessThan(2_000);
    });
});
