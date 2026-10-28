import { createHash, type Hash } from 'node:crypto';

import { Effect } from 'effect';

import {
    ARCHIVE_ROOT,
    assertNoPortablePathConflicts,
    comparePortablePaths,
    GENERATED_MANIFEST_ARCHIVE_PATH,
    GENERATED_MANIFEST_PATH,
    normalizePackagePath,
    PackageFixtureError,
    REFERENCE_EXTRACTION_LIMITS,
    TAR_BLOCK_SIZE,
    type PackageFixtureErrorCode,
    type ReferenceExtractionLimits,
} from './contract.js';
import { fromAbortablePackagePromise } from './effect.js';
import { PackageCodecError } from './errors.js';
import {
    decodeCanonicalPackageManifest,
    encodeCanonicalPackageManifest,
    encodeReferencePackageFixture,
    sha256PackageBytes,
    type PackageManifestFile,
    type PackageManifestV1,
    type ReferencePackageInput,
    type ReferenceResolvedDependency,
    type ReferenceToolRequirement,
} from './reference-fixture.js';

export const MAX_PACKAGE_COMPRESSED_BYTES = 513 * 1024 * 1024;

export interface PackageCodecLimits extends ReferenceExtractionLimits {
    readonly maxCompressedBytes: number;
}

export const PACKAGE_CODEC_LIMITS: PackageCodecLimits = Object.freeze({
    ...REFERENCE_EXTRACTION_LIMITS,
    maxCompressedBytes: MAX_PACKAGE_COMPRESSED_BYTES,
});

export interface PackageLogicalFile {
    readonly path: string;
    readonly bytes: string | Uint8Array;
    readonly executable: boolean;
}

export interface PackageEncodeInput {
    readonly canonicalIri: string;
    readonly version: string;
    readonly dependencies: ReadonlyArray<ReferenceResolvedDependency>;
    readonly validator: ReferenceToolRequirement;
    readonly reasoner: ReferenceToolRequirement;
    readonly files: ReadonlyArray<PackageLogicalFile>;
}

export interface EncodedPackage {
    readonly archiveBytes: Uint8Array;
    readonly archiveSha256: string;
    readonly manifest: PackageManifestV1;
    readonly manifestBytes: Uint8Array;
    readonly manifestSha256: string;
}

export interface ValidatedPackageFile extends PackageManifestFile {
    readonly mode: 0o644 | 0o755;
}

export interface ValidatedPackageArchive {
    readonly archiveSha256: string;
    readonly manifestSha256: string;
    readonly compressedBytes: number;
    readonly decompressedBytes: number;
    readonly manifest: PackageManifestV1;
    readonly files: ReadonlyArray<ValidatedPackageFile>;
}

export type PackageArchiveSource = Uint8Array | AsyncIterable<Uint8Array>;

interface ParsedEntry {
    readonly path: string;
    readonly kind: 'directory' | 'file';
    readonly mode: number;
    readonly byteSize: number;
    readonly sha256: string;
    readonly capturedBytes?: Uint8Array;
}

export interface PackageArchiveSink {
    readonly directory?: (path: string) => Promise<void>;
    readonly startFile?: (path: string, mode: 0o644 | 0o755) => Promise<void>;
    readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
    readonly endFile?: (path: string, byteSize: number, sha256: string) => Promise<void>;
}

const EMPTY_BYTES = new Uint8Array();
const GZIP_HEADER = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff);
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function codecError(error: unknown): PackageCodecError {
    if (error instanceof PackageCodecError) {
        return error;
    }
    if (error instanceof PackageFixtureError) {
        return new PackageCodecError(error.code, `Package data violates the ${error.code} rule`, error);
    }
    return new PackageCodecError('source-read', 'Package archive input could not be read', error);
}

function freezeDependency(value: ReferenceResolvedDependency): ReferenceResolvedDependency {
    return Object.freeze({
        requested: value.requested,
        canonicalIri: value.canonicalIri,
        version: value.version,
        archiveSha256: value.archiveSha256,
    });
}

function freezeTool(value: ReferenceToolRequirement): ReferenceToolRequirement {
    return Object.freeze({
        version: value.version,
        sha256: value.sha256,
    });
}

function freezeManifest(manifest: PackageManifestV1): PackageManifestV1 {
    return Object.freeze({
        formatVersion: manifest.formatVersion,
        archiveRoot: manifest.archiveRoot,
        generatedManifestPath: manifest.generatedManifestPath,
        canonicalIri: manifest.canonicalIri,
        version: manifest.version,
        dependencies: Object.freeze(manifest.dependencies.map(freezeDependency)),
        toolchain: Object.freeze({
            validator: freezeTool(manifest.toolchain.validator),
            reasoner: freezeTool(manifest.toolchain.reasoner),
        }),
        files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))),
    });
}

function copyEncodeInput(input: PackageEncodeInput): ReferencePackageInput {
    return {
        canonicalIri: input.canonicalIri,
        version: input.version,
        dependencies: input.dependencies.map(freezeDependency),
        validator: freezeTool(input.validator),
        reasoner: freezeTool(input.reasoner),
        files: input.files.map((file) => {
            if (typeof file.bytes === 'string' && UNPAIRED_SURROGATE.test(file.bytes)) {
                throw new PackageCodecError('invalid-utf8', 'Package text bytes contain an unpaired UTF-16 surrogate');
            }
            return {
                path: file.path,
                bytes: typeof file.bytes === 'string' ? file.bytes : Uint8Array.from(file.bytes),
                executable: file.executable,
            };
        }),
    };
}

export function encodePackage(input: PackageEncodeInput): EncodedPackage {
    try {
        const fixture = encodeReferencePackageFixture(copyEncodeInput(input));
        const archiveBytes = Uint8Array.from(fixture.archiveBytes);
        const manifestBytes = Uint8Array.from(fixture.manifestBytes);
        return Object.freeze({
            get archiveBytes(): Uint8Array {
                return Uint8Array.from(archiveBytes);
            },
            archiveSha256: fixture.archiveSha256,
            manifest: freezeManifest(fixture.manifest),
            get manifestBytes(): Uint8Array {
                return Uint8Array.from(manifestBytes);
            },
            manifestSha256: fixture.manifestSha256,
        });
    } catch (error) {
        throw codecError(error);
    }
}

function sourceIterable(source: PackageArchiveSource): AsyncIterable<Uint8Array> {
    return source instanceof Uint8Array
        ? (async function* (): AsyncIterable<Uint8Array> {
              yield await Promise.resolve(source);
          })()
        : source;
}

class BoundedArchiveReader {
    readonly #iterator: AsyncIterator<Uint8Array>;
    readonly #limit: number;
    readonly #signal: AbortSignal | undefined;
    readonly #hash = createHash('sha256');
    #queue: Uint8Array[] = [];
    #queueOffset = 0;
    #queueBytes = 0;
    #done = false;
    #total = 0;
    #tail = EMPTY_BYTES;

    constructor(source: PackageArchiveSource, limit: number, signal?: AbortSignal) {
        try {
            this.#iterator = sourceIterable(source)[Symbol.asyncIterator]();
        } catch (error) {
            throw new PackageCodecError('source-read', 'Package archive input could not be opened', error);
        }
        this.#limit = limit;
        this.#signal = signal;
    }

    get totalBytes(): number {
        return this.#total;
    }

    async #pull(): Promise<void> {
        while (!this.#done && this.#queueBytes === 0) {
            let result: IteratorResult<Uint8Array>;
            try {
                if (this.#signal?.aborted === true) {
                    throw new PackageCodecError('source-read', 'Package archive reading was interrupted');
                }
                const next = this.#iterator.next();
                result =
                    this.#signal === undefined
                        ? await next
                        : await new Promise<IteratorResult<Uint8Array>>((resolvePromise, rejectPromise) => {
                              function abort(): void {
                                  rejectPromise(
                                      new PackageCodecError('source-read', 'Package archive reading was interrupted'),
                                  );
                              }
                              this.#signal?.addEventListener('abort', abort, { once: true });
                              void next
                                  .then(resolvePromise, rejectPromise)
                                  .finally(() => this.#signal?.removeEventListener('abort', abort));
                          });
            } catch (error) {
                throw new PackageCodecError('source-read', 'Package archive input could not be read', error);
            }
            if (result.done) {
                this.#done = true;
                return;
            }
            if (!(result.value instanceof Uint8Array)) {
                throw new PackageCodecError('source-read', 'Package archive input yielded a non-byte chunk');
            }
            if (result.value.length === 0) {
                continue;
            }
            if (this.#total + result.value.length > this.#limit) {
                throw new PackageCodecError('compressed-limit', 'Package archive exceeds the compressed-byte limit');
            }
            const chunk = Uint8Array.from(result.value);
            this.#total += chunk.length;
            this.#hash.update(chunk);
            this.#tail = Uint8Array.from(Buffer.concat([this.#tail, chunk]).subarray(-8));
            this.#queue.push(chunk);
            this.#queueBytes += chunk.length;
        }
    }

    async readExact(length: number, label: string): Promise<Uint8Array> {
        const output = new Uint8Array(length);
        let written = 0;
        while (written < length) {
            await this.#pull();
            if (this.#queueBytes === 0) {
                throw new PackageCodecError('gzip-profile', `${label} is truncated`);
            }
            const chunk = this.#queue[0];
            if (chunk === undefined) {
                throw new PackageCodecError('gzip-profile', `${label} is truncated`);
            }
            const available = chunk.length - this.#queueOffset;
            const take = Math.min(available, length - written);
            output.set(chunk.subarray(this.#queueOffset, this.#queueOffset + take), written);
            written += take;
            this.#queueOffset += take;
            this.#queueBytes -= take;
            if (this.#queueOffset === chunk.length) {
                this.#queue.shift();
                this.#queueOffset = 0;
            }
        }
        return output;
    }

    async finish(): Promise<string> {
        await this.#pull();
        if (this.#queueBytes !== 0) {
            throw new PackageCodecError('gzip-profile', 'Gzip member has trailing or concatenated data');
        }
        return this.#hash.digest('hex');
    }

    async drainAndTail(): Promise<Uint8Array> {
        this.#queue = [];
        this.#queueOffset = 0;
        this.#queueBytes = 0;
        while (!this.#done) {
            await this.#pull();
            this.#queue = [];
            this.#queueOffset = 0;
            this.#queueBytes = 0;
        }
        return this.#tail;
    }

    async close(): Promise<void> {
        try {
            await this.#iterator.return?.();
        } catch {
            // A producer cleanup failure cannot replace the deterministic codec failure.
        }
    }
}

function isZeroBlock(bytes: Uint8Array): boolean {
    return bytes.every((byte) => byte === 0);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function callSink(operation: (() => Promise<void>) | undefined): Promise<void> {
    if (operation === undefined) {
        return;
    }
    try {
        await operation();
    } catch (error) {
        if (error instanceof PackageCodecError) {
            throw error;
        }
        throw new PackageCodecError('sink-write', 'Package archive sink could not accept validated bytes', error);
    }
}

function decodeFixedString(bytes: Uint8Array, label: string): string {
    const end = bytes.indexOf(0);
    if (end !== -1 && !isZeroBlock(bytes.subarray(end))) {
        throw new PackageCodecError('invalid-header', `${label} has hidden bytes after its first NUL`);
    }
    try {
        return fatalUtf8Decoder.decode(bytes.subarray(0, end === -1 ? bytes.length : end));
    } catch (error) {
        throw new PackageCodecError('invalid-utf8', `${label} contains invalid UTF-8`, error);
    }
}

function readCanonicalOctal(bytes: Uint8Array, label: string): number {
    if (
        bytes.length < 2 ||
        bytes.at(-1) !== 0 ||
        !bytes.subarray(0, -1).every((byte) => byte >= 0x30 && byte <= 0x37)
    ) {
        throw new PackageCodecError('invalid-header', `${label} is not zero-padded canonical octal`);
    }
    const parsed = Number.parseInt(new TextDecoder().decode(bytes.subarray(0, -1)), 8);
    if (!Number.isSafeInteger(parsed)) {
        throw new PackageCodecError('invalid-header', `${label} is outside the safe integer range`);
    }
    return parsed;
}

function assertHeaderChecksum(header: Uint8Array): void {
    const field = header.subarray(148, 156);
    if (field[6] !== 0 || field[7] !== 0x20 || !field.subarray(0, 6).every((byte) => byte >= 0x30 && byte <= 0x37)) {
        throw new PackageCodecError('invalid-header', 'Checksum is not in canonical V1 form');
    }
    const expected = Number.parseInt(new TextDecoder().decode(field.subarray(0, 6)), 8);
    let actual = 0;
    for (let index = 0; index < header.length; index += 1) {
        actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    if (actual !== expected) {
        throw new PackageCodecError('invalid-header', 'USTAR header checksum mismatch');
    }
}

function assertExactBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
    if (!equalBytes(actual, expected)) {
        throw new PackageCodecError('invalid-header', `${label} is not in canonical V1 form`);
    }
}

function splitUstarPath(path: string): Readonly<{
    name: string;
    prefix: string;
}> {
    if (Buffer.byteLength(path) <= 100) {
        return { name: path, prefix: '' };
    }
    const trailingSlash = path.endsWith('/') ? '/' : '';
    const body = trailingSlash.length === 0 ? path : path.slice(0, -1);
    for (let index = body.lastIndexOf('/'); index > 0; index = body.lastIndexOf('/', index - 1)) {
        const prefix = body.slice(0, index);
        const name = `${body.slice(index + 1)}${trailingSlash}`;
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
            return { name, prefix };
        }
    }
    throw new PackageCodecError('limit-path-size', 'Archive path is not representable by the V1 USTAR profile');
}

interface ActiveFile {
    readonly path: string;
    readonly mode: 0o644 | 0o755;
    readonly size: number;
    readonly hash: Hash;
    readonly captured: Uint8Array[] | undefined;
    remaining: number;
}

class StreamingTarParser {
    readonly #limits: PackageCodecLimits;
    readonly #sink: PackageArchiveSink;
    #buffer: Uint8Array = EMPTY_BYTES;
    #entries: ParsedEntry[] = [];
    #active: ActiveFile | undefined;
    #padding = 0;
    #zeroBlocks = 0;
    #terminated = false;
    #previousArchivePath: string | undefined;
    #declaredEntryBytes = 0;

    constructor(limits: PackageCodecLimits, sink: PackageArchiveSink) {
        this.#limits = limits;
        this.#sink = sink;
    }

    get entries(): ReadonlyArray<ParsedEntry> {
        return this.#entries;
    }

    async write(chunk: Uint8Array): Promise<void> {
        if (chunk.length === 0) {
            return;
        }
        if (this.#terminated) {
            throw new PackageCodecError('invalid-header', 'Tar archive has data after its two-block terminator');
        }
        this.#buffer = Uint8Array.from(this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]));
        await this.#drain();
    }

    async #drain(): Promise<void> {
        while (this.#buffer.length > 0) {
            if (this.#active !== undefined) {
                if (this.#active.remaining > 0) {
                    const length = Math.min(this.#active.remaining, this.#buffer.length);
                    const bytes = this.#buffer.subarray(0, length);
                    const active = this.#active;
                    active.hash.update(bytes);
                    active.captured?.push(Uint8Array.from(bytes));
                    const writeFile = this.#sink.writeFile;
                    await callSink(writeFile === undefined ? undefined : () => writeFile(active.path, bytes));
                    active.remaining -= length;
                    this.#buffer = this.#buffer.subarray(length);
                    if (this.#active.remaining > 0) {
                        return;
                    }
                }
                const active = this.#active;
                const digest = active.hash.digest('hex');
                const capturedBytes = active.captured === undefined ? undefined : Buffer.concat(active.captured);
                this.#entries.push({
                    path: active.path,
                    kind: 'file',
                    mode: active.mode,
                    byteSize: active.size,
                    sha256: digest,
                    ...(capturedBytes === undefined ? {} : { capturedBytes }),
                });
                const endFile = this.#sink.endFile;
                await callSink(endFile === undefined ? undefined : () => endFile(active.path, active.size, digest));
                this.#active = undefined;
                this.#padding = (TAR_BLOCK_SIZE - (active.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
            }
            if (this.#padding > 0) {
                if (this.#buffer.length < this.#padding) {
                    return;
                }
                if (!isZeroBlock(this.#buffer.subarray(0, this.#padding))) {
                    throw new PackageCodecError('invalid-header', 'USTAR file padding is nonzero');
                }
                this.#buffer = this.#buffer.subarray(this.#padding);
                this.#padding = 0;
                continue;
            }
            if (this.#buffer.length < TAR_BLOCK_SIZE) {
                return;
            }
            const header = this.#buffer.subarray(0, TAR_BLOCK_SIZE);
            this.#buffer = this.#buffer.subarray(TAR_BLOCK_SIZE);
            if (isZeroBlock(header)) {
                this.#zeroBlocks += 1;
                if (this.#zeroBlocks === 2) {
                    this.#terminated = true;
                    if (this.#buffer.length !== 0) {
                        throw new PackageCodecError(
                            'invalid-header',
                            'Tar archive has data after its two-block terminator',
                        );
                    }
                }
                continue;
            }
            if (this.#zeroBlocks !== 0) {
                throw new PackageCodecError('invalid-header', 'Tar terminator contains only one zero block');
            }
            await this.#startEntry(header);
        }
    }

    async #startEntry(header: Uint8Array): Promise<void> {
        if (this.#entries.length >= this.#limits.maxEntries) {
            throw new PackageCodecError('limit-entries', 'Archive exceeds the entry limit');
        }
        assertHeaderChecksum(header);
        assertExactBytes(header.subarray(257, 263), Uint8Array.of(0x75, 0x73, 0x74, 0x61, 0x72, 0), 'USTAR magic');
        assertExactBytes(header.subarray(263, 265), Uint8Array.of(0x30, 0x30), 'USTAR version');
        if (!isZeroBlock(header.subarray(500))) {
            throw new PackageCodecError('invalid-header', 'USTAR unused header tail is not zero');
        }
        const name = decodeFixedString(header.subarray(0, 100), 'name');
        const prefix = decodeFixedString(header.subarray(345, 500), 'prefix');
        const archivePath = prefix.length === 0 ? name : `${prefix}/${name}`;
        const typeFlag = String.fromCharCode(header[156] ?? 0);
        const size = readCanonicalOctal(header.subarray(124, 136), 'size');
        const mode = readCanonicalOctal(header.subarray(100, 108), 'mode');
        const metadata = [
            readCanonicalOctal(header.subarray(108, 116), 'uid'),
            readCanonicalOctal(header.subarray(116, 124), 'gid'),
            readCanonicalOctal(header.subarray(136, 148), 'mtime'),
            readCanonicalOctal(header.subarray(329, 337), 'device major'),
            readCanonicalOctal(header.subarray(337, 345), 'device minor'),
        ];
        const uname = decodeFixedString(header.subarray(265, 297), 'uname');
        const gname = decodeFixedString(header.subarray(297, 329), 'gname');
        const linkTarget = decodeFixedString(header.subarray(157, 257), 'link name');
        if (metadata.some((value) => value !== 0) || uname !== '' || gname !== '') {
            throw new PackageCodecError('invalid-header', 'Archive entry has host-dependent USTAR metadata');
        }
        if (size > this.#limits.maxEntryBytes) {
            throw new PackageCodecError('limit-entry-size', 'Archive entry exceeds the byte limit');
        }
        this.#declaredEntryBytes += size;
        if (this.#declaredEntryBytes > this.#limits.maxDecompressedBytes) {
            throw new PackageCodecError(
                'limit-decompressed-total',
                'Archive entries exceed the decompressed-byte limit',
            );
        }
        if (typeFlag === '1' || typeFlag === '2') {
            throw new PackageCodecError('link-entry', 'Archive links are forbidden');
        }
        if (typeFlag === '3' || typeFlag === '4' || typeFlag === '6') {
            throw new PackageCodecError('device-entry', 'Archive device and FIFO entries are forbidden');
        }
        if (typeFlag !== '0' && typeFlag !== '5') {
            throw new PackageCodecError('unsupported-entry', 'Archive entry type is forbidden');
        }
        if (linkTarget !== '') {
            throw new PackageCodecError('invalid-header', 'Non-link archive entry has a link target');
        }
        if (archivePath !== ARCHIVE_ROOT && !archivePath.startsWith(ARCHIVE_ROOT)) {
            throw new PackageCodecError('archive-root', `Archive entry is outside ${ARCHIVE_ROOT}`);
        }
        const split = splitUstarPath(archivePath);
        if (split.name !== name || split.prefix !== prefix) {
            throw new PackageCodecError('invalid-header', 'Archive path does not use its canonical USTAR split');
        }
        const directory = typeFlag === '5';
        if (directory && !archivePath.endsWith('/')) {
            throw new PackageCodecError('invalid-header', 'Directory entry lacks a trailing slash');
        }
        if (directory && (size !== 0 || mode !== 0o755)) {
            throw new PackageCodecError('invalid-header', 'Directory entry is not normalized');
        }
        if (!directory && mode !== 0o644 && mode !== 0o755) {
            throw new PackageCodecError('invalid-header', 'Regular-file mode is not normalized');
        }
        if (
            this.#previousArchivePath !== undefined &&
            comparePortablePaths(this.#previousArchivePath, archivePath) > 0
        ) {
            throw new PackageCodecError('invalid-header', 'Tar entries are not in lexical order');
        }
        this.#previousArchivePath = archivePath;
        const withSlash = archivePath === ARCHIVE_ROOT ? '' : archivePath.slice(ARCHIVE_ROOT.length);
        const relative = directory && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
        if (relative.length > 0) {
            let normalized: string;
            try {
                normalized = normalizePackagePath(relative);
            } catch (error) {
                throw codecError(error);
            }
            if (normalized !== relative) {
                throw new PackageCodecError('non-normalized-path', 'Archive path is not in canonical NFC/slash form');
            }
        }
        if (relative.split('/').filter(Boolean).length > this.#limits.maxPathDepth) {
            throw new PackageCodecError('limit-depth', 'Archive path exceeds the depth limit');
        }
        if (Buffer.byteLength(relative) > this.#limits.maxPathBytes) {
            throw new PackageCodecError('limit-path-size', 'Archive path exceeds the byte limit');
        }
        const path = relative.length === 0 ? '.' : relative;
        try {
            assertNoPortablePathConflicts([
                ...this.#entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
                { path, kind: directory ? ('directory' as const) : ('file' as const) },
            ]);
        } catch (error) {
            throw codecError(error);
        }
        if (directory) {
            this.#entries.push({ path, kind: 'directory', mode, byteSize: 0, sha256: sha256PackageBytes(EMPTY_BYTES) });
            const directorySink = this.#sink.directory;
            await callSink(directorySink === undefined ? undefined : () => directorySink(path));
            return;
        }
        const fileMode = mode as 0o644 | 0o755;
        const startFile = this.#sink.startFile;
        await callSink(startFile === undefined ? undefined : () => startFile(path, fileMode));
        this.#active = {
            path,
            mode: fileMode,
            size,
            remaining: size,
            hash: createHash('sha256'),
            captured: path === GENERATED_MANIFEST_PATH ? [] : undefined,
        };
    }

    finish(): ReadonlyArray<ParsedEntry> {
        if (this.#active !== undefined || this.#padding !== 0 || !this.#terminated || this.#buffer.length !== 0) {
            throw new PackageCodecError('invalid-header', 'Tar archive is truncated or lacks its exact terminator');
        }
        try {
            assertNoPortablePathConflicts(this.#entries.map(({ path, kind }) => ({ path, kind })));
        } catch (error) {
            throw codecError(error);
        }
        return this.#entries;
    }
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});

function updateCrc32(current: number, bytes: Uint8Array): number {
    let value = current;
    for (const byte of bytes) {
        value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
    }
    return value >>> 0;
}

function littleEndianUint32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function collectExpectedDirectories(paths: ReadonlyArray<string>): ReadonlySet<string> {
    const directories = new Set<string>(['.']);
    for (const path of paths) {
        const segments = path.split('/');
        for (let length = 1; length < segments.length; length += 1) {
            directories.add(segments.slice(0, length).join('/'));
        }
    }
    return directories;
}

function validateManifestClosure(entries: ReadonlyArray<ParsedEntry>): Readonly<{
    manifest: PackageManifestV1;
    manifestSha256: string;
    files: ReadonlyArray<ValidatedPackageFile>;
}> {
    const manifestEntry = entries.find(({ kind, path }) => kind === 'file' && path === GENERATED_MANIFEST_PATH);
    if (manifestEntry?.capturedBytes === undefined) {
        throw new PackageCodecError('missing-manifest', `Archive lacks ${GENERATED_MANIFEST_ARCHIVE_PATH}`);
    }
    let manifest: PackageManifestV1;
    try {
        manifest = decodeCanonicalPackageManifest(manifestEntry.capturedBytes);
    } catch (error) {
        throw codecError(error);
    }
    if (
        manifestEntry.mode !== 0o644 ||
        !equalBytes(manifestEntry.capturedBytes, encodeCanonicalPackageManifest(manifest))
    ) {
        throw new PackageCodecError('manifest-integrity', 'Generated manifest bytes or mode are not canonical');
    }
    const files = new Map(entries.filter(({ kind }) => kind === 'file').map((entry) => [entry.path, entry]));
    const expectedPaths = new Set<string>([GENERATED_MANIFEST_PATH]);
    const validated: ValidatedPackageFile[] = [];
    let previous: string | undefined;
    for (const record of manifest.files) {
        let normalized: string;
        try {
            normalized = normalizePackagePath(record.path);
        } catch (error) {
            throw codecError(error);
        }
        if (
            normalized !== record.path ||
            (previous !== undefined && comparePortablePaths(previous, record.path) >= 0)
        ) {
            throw new PackageCodecError('manifest-integrity', 'Manifest files are not uniquely sorted');
        }
        const entry = files.get(record.path);
        const expectedMode = record.executable ? 0o755 : 0o644;
        if (
            entry === undefined ||
            entry.byteSize !== record.byteSize ||
            entry.sha256 !== record.sha256 ||
            entry.mode !== expectedMode
        ) {
            throw new PackageCodecError('manifest-integrity', 'Manifest file integrity does not match the archive');
        }
        expectedPaths.add(record.path);
        validated.push(Object.freeze({ ...record, mode: expectedMode }));
        previous = record.path;
    }
    for (const path of files.keys()) {
        if (!expectedPaths.has(path)) {
            throw new PackageCodecError('manifest-integrity', 'Archive contains an unmanifested file');
        }
    }
    const expectedDirectories = collectExpectedDirectories([...expectedPaths]);
    const actualDirectories = entries.filter(({ kind }) => kind === 'directory');
    if (
        actualDirectories.length !== expectedDirectories.size ||
        actualDirectories.some(({ path }) => !expectedDirectories.has(path))
    ) {
        throw new PackageCodecError('manifest-integrity', 'Archive directory closure is not canonical');
    }
    return Object.freeze({
        manifest: freezeManifest(manifest),
        manifestSha256: manifestEntry.sha256,
        files: Object.freeze(validated),
    });
}

const INTEGER_LIMIT_KEYS = [
    'maxEntries',
    'maxEntryBytes',
    'maxDecompressedBytes',
    'maxPathDepth',
    'maxPathBytes',
    'maxCompressedBytes',
] as const;

function normalizeCodecLimits(overrides: Partial<PackageCodecLimits>): PackageCodecLimits {
    const allowed = new Set<string>([...INTEGER_LIMIT_KEYS, 'maxCompressionRatio']);
    if (Object.keys(overrides).some((key) => !allowed.has(key))) {
        throw new PackageCodecError('invalid-limits', 'Package codec limits contain an unknown field');
    }
    const limits = { ...PACKAGE_CODEC_LIMITS, ...overrides };
    for (const key of INTEGER_LIMIT_KEYS) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
            throw new PackageCodecError('invalid-limits', `Package codec limit ${key} must be a positive safe integer`);
        }
    }
    if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio <= 0) {
        throw new PackageCodecError('invalid-limits', 'Package codec compression ratio must be positive and finite');
    }
    return Object.freeze(limits);
}

async function rejectProfileAfterBounds(
    reader: BoundedArchiveReader,
    limits: PackageCodecLimits,
    message: string,
): Promise<never> {
    const tail = await reader.drainAndTail();
    if (reader.totalBytes >= 18 && tail.length === 8) {
        const declaredSize = littleEndianUint32(tail, 4);
        if (declaredSize > limits.maxDecompressedBytes) {
            throw new PackageCodecError('limit-decompressed-total', 'Gzip ISIZE exceeds the decompressed-byte limit');
        }
        if (declaredSize / reader.totalBytes > limits.maxCompressionRatio) {
            throw new PackageCodecError(
                'limit-compression-ratio',
                'Package archive exceeds the compression-ratio limit',
            );
        }
    }
    throw new PackageCodecError('gzip-profile', message);
}

async function validatePackageArchiveStreamInternal(
    source: PackageArchiveSource,
    overrides: Partial<PackageCodecLimits> = {},
    sink: PackageArchiveSink = {},
    signal?: AbortSignal,
): Promise<ValidatedPackageArchive> {
    const limits = normalizeCodecLimits(overrides);
    const reader = new BoundedArchiveReader(source, limits.maxCompressedBytes, signal);
    try {
        const parser = new StreamingTarParser(limits, sink);
        const header = await reader.readExact(GZIP_HEADER.length, 'Gzip header');
        if (!equalBytes(header, GZIP_HEADER)) {
            return await rejectProfileAfterBounds(reader, limits, 'Gzip member does not use the V1 fixed header');
        }
        let decompressed = 0;
        let crc = 0xffffffff;
        let final = false;
        while (!final) {
            const blockHeader = await reader.readExact(5, 'Stored DEFLATE block header');
            if ((blockHeader[0] ?? 0xff) > 1) {
                return await rejectProfileAfterBounds(
                    reader,
                    limits,
                    'Gzip member does not use byte-aligned stored DEFLATE blocks',
                );
            }
            final = blockHeader[0] === 1;
            const length = (blockHeader[1] ?? 0) | ((blockHeader[2] ?? 0) << 8);
            const complement = (blockHeader[3] ?? 0) | ((blockHeader[4] ?? 0) << 8);
            if ((~length & 0xffff) !== complement) {
                throw new PackageCodecError('gzip-profile', 'Stored DEFLATE length complement is invalid');
            }
            const bytes = await reader.readExact(length, 'Stored DEFLATE block');
            decompressed += bytes.length;
            if (decompressed > limits.maxDecompressedBytes) {
                throw new PackageCodecError(
                    'limit-decompressed-total',
                    'Package archive exceeds the decompressed-byte limit',
                );
            }
            crc = updateCrc32(crc, bytes);
            await parser.write(bytes);
        }
        const footer = await reader.readExact(8, 'Gzip footer');
        const archiveSha256 = await reader.finish();
        const expectedCrc = littleEndianUint32(footer, 0);
        const expectedSize = littleEndianUint32(footer, 4);
        if (expectedSize > limits.maxDecompressedBytes) {
            throw new PackageCodecError('limit-decompressed-total', 'Gzip ISIZE exceeds the decompressed-byte limit');
        }
        if (
            expectedSize / reader.totalBytes > limits.maxCompressionRatio ||
            decompressed / reader.totalBytes > limits.maxCompressionRatio
        ) {
            throw new PackageCodecError(
                'limit-compression-ratio',
                'Package archive exceeds the compression-ratio limit',
            );
        }
        if ((crc ^ 0xffffffff) >>> 0 !== expectedCrc) {
            throw new PackageCodecError('gzip-profile', 'Gzip CRC-32 does not match decompressed bytes');
        }
        if (decompressed >>> 0 !== expectedSize) {
            throw new PackageCodecError('gzip-profile', 'Gzip ISIZE does not match decompressed bytes');
        }
        const entries = parser.finish();
        const closure = validateManifestClosure(entries);
        return Object.freeze({
            archiveSha256,
            manifestSha256: closure.manifestSha256,
            compressedBytes: reader.totalBytes,
            decompressedBytes: decompressed,
            manifest: closure.manifest,
            files: closure.files,
        });
    } catch (error) {
        throw codecError(error);
    } finally {
        await reader.close();
    }
}

export async function validatePackageArchiveStream(
    source: PackageArchiveSource,
    overrides: Partial<PackageCodecLimits> = {},
    sink: PackageArchiveSink = {},
    signal?: AbortSignal,
): Promise<ValidatedPackageArchive> {
    try {
        return await validatePackageArchiveStreamInternal(source, overrides, sink, signal);
    } catch (error) {
        throw codecError(error);
    }
}

export function validatePackageArchive(
    source: PackageArchiveSource,
    overrides: Partial<PackageCodecLimits> = {},
): Effect.Effect<ValidatedPackageArchive, PackageCodecError> {
    return fromAbortablePackagePromise(
        (signal) => validatePackageArchiveStream(source, overrides, {}, signal),
        codecError,
    );
}

export function packageCodecErrorCode(error: unknown): PackageFixtureErrorCode | undefined {
    return error instanceof PackageCodecError &&
        error.code !== 'invalid-limits' &&
        error.code !== 'compressed-limit' &&
        error.code !== 'source-read' &&
        error.code !== 'sink-write' &&
        error.code !== 'destination-conflict' &&
        error.code !== 'destination-unsafe' &&
        error.code !== 'extraction-io' &&
        error.code !== 'extraction-rollback-unsafe'
        ? error.code
        : undefined;
}
