import { PackageCodecError } from './errors.js';

/**
 * Where a file's bytes sit inside a V1 archive. The gzip member holds byte-aligned stored DEFLATE blocks, so a file's
 * bytes are uncompressed at known offsets, interrupted only by each block's 5-byte header. `offset` is the first byte
 * of the file in the archive, and `runs` lists the file's segments as `[bytes, count]`: `count` consecutive segments of
 * `bytes`, each followed by one block header except the last. A valid archive may use any block lengths, so these are
 * the positions a parse found, never ones computed from a block size. A zero-length segment stands for an empty block
 * between two parts of a file.
 */
export interface PackageFileLocation {
    readonly offset: number;
    readonly runs: ReadonlyArray<readonly [bytes: number, count: number]>;
}

export interface PackageFileSpan {
    readonly offset: number;
    readonly length: number;
}

export const STORED_BLOCK_HEADER_BYTES = 5;

/**
 * A file with more runs than this is refused at capture. The encoder writes at most three for a file, a part of a
 * block, whole blocks, and a part of a block; a ticket naming a location must fit the registry Worker's ticket limit.
 */
export const MAX_PACKAGE_FILE_LOCATION_RUNS = 2_048;

const EMPTY_LOCATION: PackageFileLocation = Object.freeze({ offset: 0, runs: Object.freeze([]) });

function invalidLocation(): PackageCodecError {
    return new PackageCodecError('invalid-location', 'Package file location does not describe the archive');
}

function isCount(input: unknown, minimum: number): input is number {
    return typeof input === 'number' && Number.isSafeInteger(input) && input >= minimum;
}

/** Collects the pieces of one file, in archive order, as the codec reports them. */
export class PackageFileLocationBuilder {
    #offset: number | undefined;
    #end = 0;
    readonly #runs: Array<[number, number]> = [];
    #open = 0;

    add(offset: number, length: number): void {
        if (length === 0) {
            return;
        }
        if (this.#offset === undefined) {
            this.#offset = offset;
            this.#open = length;
            this.#end = offset + length;
            return;
        }
        if (offset === this.#end) {
            this.#open += length;
            this.#end += length;
            return;
        }
        const gap = offset - this.#end;
        if (gap <= 0 || gap % STORED_BLOCK_HEADER_BYTES !== 0) {
            throw invalidLocation();
        }
        this.#close();
        for (let empty = gap / STORED_BLOCK_HEADER_BYTES - 1; empty > 0; empty -= 1) {
            this.#push(0);
        }
        this.#open = length;
        this.#end = offset + length;
    }

    #push(bytes: number): void {
        const last = this.#runs.at(-1);
        if (last?.[0] === bytes) {
            last[1] += 1;
            return;
        }
        if (this.#runs.length === MAX_PACKAGE_FILE_LOCATION_RUNS) {
            throw invalidLocation();
        }
        this.#runs.push([bytes, 1]);
    }

    #close(): void {
        this.#push(this.#open);
        this.#open = 0;
    }

    finish(): PackageFileLocation {
        if (this.#offset === undefined) {
            return EMPTY_LOCATION;
        }
        this.#close();
        return Object.freeze({
            offset: this.#offset,
            runs: Object.freeze(this.#runs.map(([bytes, count]) => Object.freeze([bytes, count] as const))),
        });
    }
}

/** The one contiguous range of the archive holding a non-empty file, its block headers included. */
export function packageFileSpan(location: PackageFileLocation): PackageFileSpan {
    let length = 0;
    let segments = 0;
    for (const [bytes, count] of location.runs) {
        length += bytes * count;
        segments += count;
    }
    return Object.freeze({
        offset: location.offset,
        length: length + STORED_BLOCK_HEADER_BYTES * Math.max(0, segments - 1),
    });
}

/** Checks a stored location against the file and the archive it claims to be inside. */
export function decodePackageFileLocation(input: unknown, byteSize: number, archiveBytes: number): PackageFileLocation {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw invalidLocation();
    }
    const value = input as Readonly<Record<string, unknown>>;
    const names = Object.keys(value).sort();
    if (names.length !== 2 || names[0] !== 'offset' || names[1] !== 'runs') {
        throw invalidLocation();
    }
    const { offset, runs } = value;
    if (
        !isCount(offset, 0) ||
        !Array.isArray(runs) ||
        runs.length > MAX_PACKAGE_FILE_LOCATION_RUNS ||
        (byteSize === 0) !== (runs.length === 0) ||
        (byteSize === 0 && offset !== 0)
    ) {
        throw invalidLocation();
    }
    let total = 0;
    let previous: number | undefined;
    const decoded = runs.map((run: unknown) => {
        if (!Array.isArray(run) || run.length !== 2 || !isCount(run[0], 0) || !isCount(run[1], 1)) {
            throw invalidLocation();
        }
        const [bytes, count] = run as [number, number];
        if (bytes === previous || bytes > 0xffff) {
            throw invalidLocation();
        }
        previous = bytes;
        total += bytes * count;
        return Object.freeze([bytes, count] as const);
    });
    if (total !== byteSize) {
        throw invalidLocation();
    }
    const location = Object.freeze({ offset, runs: Object.freeze(decoded) });
    const span = packageFileSpan(location);
    if (span.offset + span.length > archiveBytes) {
        throw invalidLocation();
    }
    return location;
}

/** The file's bytes, from a buffer that starts `bufferOffset` bytes into the archive and covers the file's span. */
export function extractPackageFileBytes(
    location: PackageFileLocation,
    byteSize: number,
    buffer: Uint8Array,
    bufferOffset: number,
): Uint8Array {
    const output = new Uint8Array(byteSize);
    let source = location.offset - bufferOffset;
    let target = 0;
    for (const [bytes, count] of location.runs) {
        for (let index = 0; index < count; index += 1) {
            if (source < 0 || source + bytes > buffer.byteLength) {
                throw invalidLocation();
            }
            output.set(buffer.subarray(source, source + bytes), target);
            target += bytes;
            source += bytes + STORED_BLOCK_HEADER_BYTES;
        }
    }
    return output;
}
