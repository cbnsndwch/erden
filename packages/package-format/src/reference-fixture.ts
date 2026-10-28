import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { satisfies, valid, validRange } from 'semver';

import {
    ARCHIVE_ROOT,
    assertNoPortablePathConflicts,
    comparePortablePaths,
    GENERATED_MANIFEST_ARCHIVE_PATH,
    GENERATED_MANIFEST_PATH,
    isPackageFormatVersionCompatible,
    normalizePackagePath,
    PACKAGE_FORMAT_VERSION,
    PackageFixtureError,
    REFERENCE_EXTRACTION_LIMITS,
    TAR_BLOCK_SIZE,
    type PackageFixtureErrorCode,
    type PortablePathRecord,
    type ReferenceExtractionLimits,
} from './contract.js';
import { makePackageIgnorePolicy } from './ignore.js';

export type ReferenceFileKind = 'device' | 'file' | 'hardlink' | 'symlink';

export interface ReferenceFixtureFile {
    readonly path: string;
    readonly bytes?: string | Uint8Array;
    readonly executable?: boolean;
    readonly kind?: ReferenceFileKind;
    readonly linkTarget?: string;
}

export interface ReferenceResolvedDependency {
    readonly requested: string;
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
}

export interface ReferenceToolRequirement {
    readonly version: string;
    readonly sha256: string;
}

export interface ReferencePackageInput {
    readonly canonicalIri: string;
    readonly version: string;
    readonly dependencies: ReadonlyArray<ReferenceResolvedDependency>;
    readonly validator: ReferenceToolRequirement;
    readonly reasoner: ReferenceToolRequirement;
    readonly files: ReadonlyArray<ReferenceFixtureFile>;
}

export interface PackageManifestFile {
    readonly path: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly executable: boolean;
}

export interface PackageManifestV1 {
    readonly formatVersion: 1;
    readonly archiveRoot: typeof ARCHIVE_ROOT;
    readonly generatedManifestPath: typeof GENERATED_MANIFEST_PATH;
    readonly canonicalIri: string;
    readonly version: string;
    readonly dependencies: ReadonlyArray<ReferenceResolvedDependency>;
    readonly toolchain: Readonly<{
        validator: ReferenceToolRequirement;
        reasoner: ReferenceToolRequirement;
    }>;
    /** Shipped regular files except this generated manifest, which the outer digest covers. */
    readonly files: ReadonlyArray<PackageManifestFile>;
}

export interface ReferencePackageFixture {
    readonly archiveBytes: Uint8Array;
    /** Stored by publication metadata and `erden.lock`; deliberately not self-embedded. */
    readonly archiveSha256: string;
    readonly manifest: PackageManifestV1;
    readonly manifestBytes: Uint8Array;
    readonly manifestSha256: string;
    readonly selectedIgnoreFile: '.erdenignore' | '.gitignore' | null;
}

interface NormalizedFixtureFile {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly executable: boolean;
}

interface TarEntry {
    readonly path: string;
    readonly type: 'directory' | 'file';
    readonly bytes: Uint8Array;
    readonly mode: number;
}

export interface UnsafeTarFixtureEntry {
    readonly path: string;
    readonly typeFlag?: string;
    readonly bytes?: string | Uint8Array;
    readonly linkTarget?: string;
    readonly declaredSize?: number;
    readonly mode?: number;
}

export interface ValidatedReferenceArchive {
    readonly archiveSha256: string;
    readonly manifest: PackageManifestV1;
    readonly files: ReadonlyArray<PackageManifestFile>;
}

const encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const EMPTY_BYTES = new Uint8Array();
const ZERO_TAR_BLOCK = new Uint8Array(TAR_BLOCK_SIZE);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const EXACT_SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonemptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new PackageFixtureError('manifest-integrity', `${label} must be a nonempty string`);
    }
    return value;
}

function parseExactSemanticVersion(value: unknown, label: string): string {
    const text = requireNonemptyString(value, label);
    const match = EXACT_SEMVER.exec(text);
    if (match === null || valid(text, { loose: false }) === null) {
        throw new PackageFixtureError('manifest-integrity', `${label} must be an exact canonical semantic version`);
    }
    if (![match[1], match[2], match[3]].every((component) => Number.isSafeInteger(Number(component)))) {
        throw new PackageFixtureError('manifest-integrity', `${label} has a component outside the safe integer range`);
    }
    return text;
}

function semanticVersionSatisfies(version: string, requested: unknown, label: string): void {
    const range = requireNonemptyString(requested, label);
    if (range !== range.trim()) {
        throw new PackageFixtureError('manifest-integrity', `${label} is not a canonical semantic-version range`);
    }
    const candidate = parseExactSemanticVersion(version, `${label} resolved version`);
    if (validRange(range, { loose: false }) === null) {
        throw new PackageFixtureError('manifest-integrity', `${label} is not a valid semantic-version range`);
    }
    if (!satisfies(candidate, range, { loose: false })) {
        throw new PackageFixtureError('manifest-integrity', `${label} does not contain resolved version ${version}`);
    }
}

function assertCanonicalIri(value: unknown, label: string): string {
    const iri = requireNonemptyString(value, label);
    let canonical: string;
    try {
        canonical = new URL(iri).href;
    } catch {
        throw new PackageFixtureError('manifest-integrity', `${label} must be an absolute canonical IRI`);
    }
    if (canonical !== iri) {
        throw new PackageFixtureError(
            'manifest-integrity',
            `${label} must use its canonical absolute IRI serialization`,
        );
    }
    return iri;
}

function assertManifestSemantics(manifest: PackageManifestV1): void {
    const packageIri = assertCanonicalIri(manifest.canonicalIri, 'manifest.canonicalIri');
    parseExactSemanticVersion(manifest.version, 'manifest.version');
    parseExactSemanticVersion(manifest.toolchain.validator.version, 'toolchain.validator.version');
    parseExactSemanticVersion(manifest.toolchain.reasoner.version, 'toolchain.reasoner.version');
    if (!SHA256_HEX.test(manifest.toolchain.validator.sha256) || !SHA256_HEX.test(manifest.toolchain.reasoner.sha256)) {
        throw new PackageFixtureError('manifest-integrity', 'Toolchain digests must be lowercase SHA-256 values');
    }
    const dependencyIris = new Set<string>();
    for (const dependency of manifest.dependencies) {
        const dependencyIri = assertCanonicalIri(dependency.canonicalIri, 'dependency.canonicalIri');
        if (dependencyIri === packageIri || dependencyIris.has(dependencyIri)) {
            throw new PackageFixtureError(
                'manifest-integrity',
                `Dependency canonical IRI is self-referential or duplicated: ${dependencyIri}`,
            );
        }
        dependencyIris.add(dependencyIri);
        parseExactSemanticVersion(dependency.version, 'dependency.version');
        semanticVersionSatisfies(dependency.version, dependency.requested, 'dependency.requested');
        if (!SHA256_HEX.test(dependency.archiveSha256)) {
            throw new PackageFixtureError('manifest-integrity', 'Dependency archive digest must be lowercase SHA-256');
        }
    }
}

function assertEncoderInputShape(input: ReferencePackageInput): void {
    const value: unknown = input;
    if (!isJsonObject(value)) {
        throw new PackageFixtureError('manifest-integrity', 'Reference package input must be an object');
    }
    for (const key of ['canonicalIri', 'version', 'dependencies', 'validator', 'reasoner', 'files']) {
        if (!(key in value)) {
            throw new PackageFixtureError('manifest-integrity', `Reference package input is missing ${key}`);
        }
    }
    if (
        !Array.isArray(value.dependencies) ||
        !Array.isArray(value.files) ||
        !isJsonObject(value.validator) ||
        !isJsonObject(value.reasoner)
    ) {
        throw new PackageFixtureError(
            'manifest-integrity',
            'Reference package dependencies, files, validator, and reasoner have invalid shapes',
        );
    }
    for (const [index, dependency] of value.dependencies.entries()) {
        if (
            !isJsonObject(dependency) ||
            !['requested', 'canonicalIri', 'version', 'archiveSha256'].every((key) => key in dependency)
        ) {
            throw new PackageFixtureError(
                'manifest-integrity',
                `Reference dependency ${String(index)} is missing required fields`,
            );
        }
    }
    for (const [label, tool] of [
        ['validator', value.validator],
        ['reasoner', value.reasoner],
    ] as const) {
        if (!('version' in tool) || !('sha256' in tool)) {
            throw new PackageFixtureError('manifest-integrity', `Reference ${label} is missing required fields`);
        }
    }
    for (const [index, file] of value.files.entries()) {
        if (!isJsonObject(file) || typeof file.path !== 'string') {
            throw new PackageFixtureError('manifest-integrity', `Reference file ${String(index)} is missing its path`);
        }
    }
}

function toBytes(value: string | Uint8Array | undefined): Uint8Array {
    if (value === undefined) {
        return EMPTY_BYTES;
    }
    return typeof value === 'string' ? encoder.encode(value) : Uint8Array.from(value);
}

export function sha256PackageBytes(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function compareDependencies(left: ReferenceResolvedDependency, right: ReferenceResolvedDependency): number {
    const iri = comparePortablePaths(left.canonicalIri, right.canonicalIri);
    if (iri !== 0) {
        return iri;
    }
    const version = comparePortablePaths(left.version, right.version);
    return version === 0 ? comparePortablePaths(left.requested, right.requested) : version;
}

export function encodeCanonicalPackageManifest(manifest: PackageManifestV1): Uint8Array {
    return encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function normalizeFixtureFiles(files: ReadonlyArray<ReferenceFixtureFile>): Readonly<{
    files: ReadonlyArray<NormalizedFixtureFile>;
    selectedIgnoreFile: '.erdenignore' | '.gitignore' | null;
}> {
    assertNoPortablePathConflicts(files.map(({ path }) => ({ path: path.replaceAll('\\', '/'), kind: 'file' })));
    const normalized = files.map((file) => ({
        source: file,
        path: normalizePackagePath(file.path),
    }));
    assertNoPortablePathConflicts(normalized.map(({ path }) => ({ path, kind: 'file' })));
    const byPath = new Map(normalized.map((file) => [file.path, file]));
    const policy = makePackageIgnorePolicy({
        ...(byPath.has('.erdenignore') ? { erdenIgnore: toBytes(byPath.get('.erdenignore')?.source.bytes) } : {}),
        ...(byPath.has('.gitignore') ? { gitIgnore: toBytes(byPath.get('.gitignore')?.source.bytes) } : {}),
    });
    const selected: NormalizedFixtureFile[] = [];
    for (const file of normalized) {
        const kind = file.source.kind ?? 'file';
        if (kind !== 'file') {
            const code: PackageFixtureErrorCode = kind === 'device' ? 'device-entry' : 'link-entry';
            throw new PackageFixtureError(code, `V1 packages contain regular files only: ${file.path}`);
        }
        if (file.path === GENERATED_MANIFEST_PATH) {
            throw new PackageFixtureError(
                'generated-path',
                `${GENERATED_MANIFEST_PATH} is generated and cannot be supplied by a project`,
            );
        }
        if (policy.isAlwaysExcluded(file.path) || policy.isIgnored(file.path)) {
            continue;
        }
        selected.push({
            path: file.path,
            bytes: toBytes(file.source.bytes),
            executable: file.source.executable ?? false,
        });
    }
    selected.sort((left, right) => comparePortablePaths(left.path, right.path));
    return { files: selected, selectedIgnoreFile: policy.selectedIgnoreFile };
}

function collectDirectories(filePaths: ReadonlyArray<string>): ReadonlyArray<string> {
    const directories = new Set<string>([ARCHIVE_ROOT]);
    for (const archivePath of filePaths) {
        const segments = archivePath.split('/');
        for (let length = 1; length < segments.length; length += 1) {
            directories.add(`${segments.slice(0, length).join('/')}/`);
        }
    }
    return [...directories].sort(comparePortablePaths);
}

function writeBytes(target: Uint8Array, offset: number, width: number, value: string, label: string): void {
    const bytes = encoder.encode(value);
    if (bytes.length > width) {
        throw new PackageFixtureError('invalid-header', `${label} does not fit its USTAR field`);
    }
    target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, width: number, value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PackageFixtureError('invalid-header', `${label} must be a non-negative safe integer`);
    }
    const digits = value.toString(8).padStart(width - 1, '0');
    if (digits.length !== width - 1) {
        throw new PackageFixtureError('invalid-header', `${label} does not fit its USTAR field`);
    }
    writeBytes(target, offset, width - 1, digits, label);
    target[offset + width - 1] = 0;
}

function splitUstarPath(path: string): Readonly<{
    name: string;
    prefix: string;
}> {
    if (Buffer.byteLength(path) <= 100) {
        return { name: path, prefix: '' };
    }
    const trailingSlash = path.endsWith('/') ? '/' : '';
    const pathWithoutTrailingSlash = trailingSlash.length === 0 ? path : path.slice(0, -1);
    for (
        let index = pathWithoutTrailingSlash.lastIndexOf('/');
        index > 0;
        index = pathWithoutTrailingSlash.lastIndexOf('/', index - 1)
    ) {
        const prefix = pathWithoutTrailingSlash.slice(0, index);
        const name = `${pathWithoutTrailingSlash.slice(index + 1)}${trailingSlash}`;
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
            return { name, prefix };
        }
    }
    throw new PackageFixtureError('limit-path-size', `Path is not representable by the V1 USTAR profile: ${path}`);
}

function encodeTarHeader(path: string, typeFlag: string, size: number, mode: number, linkTarget = ''): Uint8Array {
    const header = new Uint8Array(TAR_BLOCK_SIZE);
    const { name, prefix } = splitUstarPath(path);
    writeBytes(header, 0, 100, name, 'name');
    writeOctal(header, 100, 8, mode, 'mode');
    writeOctal(header, 108, 8, 0, 'uid');
    writeOctal(header, 116, 8, 0, 'gid');
    writeOctal(header, 124, 12, size, 'size');
    writeOctal(header, 136, 12, 0, 'mtime');
    header.fill(0x20, 148, 156);
    writeBytes(header, 156, 1, typeFlag, 'type flag');
    writeBytes(header, 157, 100, linkTarget, 'link target');
    writeBytes(header, 257, 6, 'ustar\0', 'magic');
    writeBytes(header, 263, 2, '00', 'version');
    writeOctal(header, 329, 8, 0, 'device major');
    writeOctal(header, 337, 8, 0, 'device minor');
    writeBytes(header, 345, 155, prefix, 'prefix');
    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    writeBytes(header, 148, 6, checksum.toString(8).padStart(6, '0'), 'checksum');
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function paddingFor(size: number): Uint8Array {
    return new Uint8Array((TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE);
}

function encodeTar(entries: ReadonlyArray<TarEntry>): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (const entry of entries) {
        const typeFlag = entry.type === 'directory' ? '5' : '0';
        chunks.push(encodeTarHeader(entry.path, typeFlag, entry.bytes.length, entry.mode));
        if (entry.type === 'file') {
            chunks.push(entry.bytes, paddingFor(entry.bytes.length));
        }
    }
    chunks.push(ZERO_TAR_BLOCK, ZERO_TAR_BLOCK);
    return Buffer.concat(chunks);
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function uint32LittleEndian(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
}

function deflateStored(bytes: Uint8Array): Uint8Array {
    const chunks: Uint8Array[] = [];
    if (bytes.length === 0) {
        return Uint8Array.of(1, 0, 0, 0xff, 0xff);
    }
    for (let offset = 0; offset < bytes.length; offset += 65535) {
        const length = Math.min(65535, bytes.length - offset);
        const final = offset + length === bytes.length ? 1 : 0;
        const complement = ~length & 0xffff;
        chunks.push(Uint8Array.of(final, length & 0xff, length >>> 8, complement & 0xff, complement >>> 8));
        chunks.push(bytes.subarray(offset, offset + length));
    }
    return Buffer.concat(chunks);
}

/** RFC 1952 member with fixed header and RFC 1951 stored blocks; independent of host zlib. */
export function gzipReferenceBytes(bytes: Uint8Array): Uint8Array {
    return Buffer.concat([
        Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff),
        deflateStored(bytes),
        uint32LittleEndian(crc32(bytes)),
        uint32LittleEndian(bytes.length),
    ]);
}

function buildManifest(input: ReferencePackageInput, files: ReadonlyArray<NormalizedFixtureFile>): PackageManifestV1 {
    return {
        formatVersion: PACKAGE_FORMAT_VERSION,
        archiveRoot: ARCHIVE_ROOT,
        generatedManifestPath: GENERATED_MANIFEST_PATH,
        canonicalIri: input.canonicalIri,
        version: input.version,
        dependencies: [...input.dependencies].sort(compareDependencies).map((dependency) => ({
            requested: dependency.requested,
            canonicalIri: dependency.canonicalIri,
            version: dependency.version,
            archiveSha256: dependency.archiveSha256,
        })),
        toolchain: {
            validator: { version: input.validator.version, sha256: input.validator.sha256 },
            reasoner: { version: input.reasoner.version, sha256: input.reasoner.sha256 },
        },
        files: files.map((file) => ({
            path: file.path,
            byteSize: file.bytes.length,
            sha256: sha256PackageBytes(file.bytes),
            executable: file.executable,
        })),
    };
}

/**
 * Bounded interoperability encoder for V1 fixtures. It is deliberately not the Slice 2
 * filesystem packer: callers provide logical bytes and executable flags, so no host path,
 * timestamp, owner, umask, symlink, Git state, or filesystem enumeration can leak in.
 */
/**
 * Bounded interoperability encoder for V1 fixtures. It is deliberately not the Slice 2
 * filesystem packer: callers provide logical bytes and executable flags, so no host path,
 * timestamp, owner, umask, symlink, Git state, or filesystem enumeration can leak in.
 */
export function encodeReferencePackageFixture(input: ReferencePackageInput): ReferencePackageFixture {
    assertEncoderInputShape(input);
    const normalized = normalizeFixtureFiles(input.files);
    const manifest = buildManifest(input, normalized.files);
    assertManifestSemantics(manifest);
    const manifestBytes = encodeCanonicalPackageManifest(manifest);
    const fileEntries: TarEntry[] = [
        ...normalized.files.map((file) => ({
            path: `${ARCHIVE_ROOT}${file.path}`,
            type: 'file' as const,
            bytes: file.bytes,
            mode: file.executable ? 0o755 : 0o644,
        })),
        { path: GENERATED_MANIFEST_ARCHIVE_PATH, type: 'file', bytes: manifestBytes, mode: 0o644 },
    ];
    const directoryEntries: TarEntry[] = collectDirectories(fileEntries.map(({ path }) => path)).map((path) => ({
        path,
        type: 'directory',
        bytes: EMPTY_BYTES,
        mode: 0o755,
    }));
    const entries = [...directoryEntries, ...fileEntries].sort((left, right) =>
        comparePortablePaths(left.path, right.path),
    );
    assertNoPortablePathConflicts(
        entries.map(({ path, type }) => ({
            path: path.endsWith('/') ? path.slice(0, -1) : path,
            kind: type,
        })),
    );
    if (entries.length > REFERENCE_EXTRACTION_LIMITS.maxEntries) {
        throw new PackageFixtureError('limit-entries', 'Reference package exceeds the V1 entry limit');
    }
    const oversized = fileEntries.find(({ bytes }) => bytes.length > REFERENCE_EXTRACTION_LIMITS.maxEntryBytes);
    if (oversized !== undefined) {
        throw new PackageFixtureError('limit-entry-size', `${oversized.path} exceeds the V1 entry-size limit`);
    }
    const tarBytes = encodeTar(entries);
    if (tarBytes.length > REFERENCE_EXTRACTION_LIMITS.maxDecompressedBytes) {
        throw new PackageFixtureError(
            'limit-decompressed-total',
            'Reference package exceeds the V1 decompressed-total limit',
        );
    }
    const archiveBytes = gzipReferenceBytes(tarBytes);
    validateReferenceArchiveFixture(archiveBytes);
    return {
        archiveBytes,
        archiveSha256: sha256PackageBytes(archiveBytes),
        manifest,
        manifestBytes,
        manifestSha256: sha256PackageBytes(manifestBytes),
        selectedIgnoreFile: normalized.selectedIgnoreFile,
    };
}

function decodeFixedString(bytes: Uint8Array, label: string): string {
    const end = bytes.indexOf(0);
    if (end !== -1 && !isZeroBlock(bytes.subarray(end))) {
        throw new PackageFixtureError('invalid-header', `${label} has hidden bytes after its first NUL`);
    }
    const value = bytes.subarray(0, end === -1 ? bytes.length : end);
    try {
        return fatalUtf8Decoder.decode(value);
    } catch {
        throw new PackageFixtureError('invalid-utf8', `${label} contains invalid UTF-8`);
    }
}

function readCanonicalOctal(bytes: Uint8Array, label: string): number {
    if (
        bytes.length < 2 ||
        bytes.at(-1) !== 0 ||
        !bytes.subarray(0, -1).every((byte) => byte >= 0x30 && byte <= 0x37)
    ) {
        throw new PackageFixtureError('invalid-header', `${label} is not zero-padded canonical octal`);
    }
    const value = new TextDecoder().decode(bytes.subarray(0, -1));
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) {
        throw new PackageFixtureError('invalid-header', `${label} is outside the safe integer range`);
    }
    return parsed;
}

function isZeroBlock(bytes: Uint8Array): boolean {
    return bytes.every((byte) => byte === 0);
}

function assertHeaderChecksum(header: Uint8Array): void {
    const field = header.subarray(148, 156);
    if (
        field.length !== 8 ||
        field[6] !== 0 ||
        field[7] !== 0x20 ||
        !field.subarray(0, 6).every((byte) => byte >= 0x30 && byte <= 0x37)
    ) {
        throw new PackageFixtureError('invalid-header', 'Checksum is not six octal digits followed by NUL and space');
    }
    const expected = Number.parseInt(new TextDecoder().decode(field.subarray(0, 6)), 8);
    let actual = 0;
    for (let index = 0; index < header.length; index += 1) {
        actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    if (actual !== expected) {
        throw new PackageFixtureError('invalid-header', 'USTAR header checksum mismatch');
    }
}

function assertExactBytes(actual: Uint8Array, expected: ReadonlyArray<number>, label: string): void {
    if (actual.length !== expected.length || expected.some((byte, index) => actual[index] !== byte)) {
        throw new PackageFixtureError('invalid-header', `${label} is not in the canonical V1 USTAR form`);
    }
}

interface ParsedTarFile extends PortablePathRecord {
    readonly bytes: Uint8Array;
    readonly mode: number;
}

function parseTar(tarBytes: Uint8Array, limits: ReferenceExtractionLimits): ReadonlyArray<ParsedTarFile> {
    const entries: ParsedTarFile[] = [];
    let offset = 0;
    let totalBytes = 0;
    let sawEnd = false;
    let previousArchivePath: string | undefined;
    while (offset + TAR_BLOCK_SIZE <= tarBytes.length) {
        const header = tarBytes.subarray(offset, offset + TAR_BLOCK_SIZE);
        if (isZeroBlock(header)) {
            const second = tarBytes.subarray(offset + TAR_BLOCK_SIZE, offset + 2 * TAR_BLOCK_SIZE);
            if (second.length !== TAR_BLOCK_SIZE || !isZeroBlock(second)) {
                throw new PackageFixtureError('invalid-header', 'Tar terminator must contain two zero blocks');
            }
            if (offset + 2 * TAR_BLOCK_SIZE !== tarBytes.length) {
                throw new PackageFixtureError('invalid-header', 'Tar archive has data after its two-block terminator');
            }
            sawEnd = true;
            break;
        }
        if (entries.length >= limits.maxEntries) {
            throw new PackageFixtureError('limit-entries', `Archive exceeds ${String(limits.maxEntries)} entries`);
        }
        assertHeaderChecksum(header);
        assertExactBytes(header.subarray(257, 263), [0x75, 0x73, 0x74, 0x61, 0x72, 0], 'USTAR magic');
        assertExactBytes(header.subarray(263, 265), [0x30, 0x30], 'USTAR version');
        if (!isZeroBlock(header.subarray(500, TAR_BLOCK_SIZE))) {
            throw new PackageFixtureError('invalid-header', 'USTAR unused header tail is not zero');
        }
        const name = decodeFixedString(header.subarray(0, 100), 'name');
        const prefix = decodeFixedString(header.subarray(345, 500), 'prefix');
        const archivePath = prefix.length === 0 ? name : `${prefix}/${name}`;
        const typeFlag = String.fromCharCode(header[156] ?? 0);
        const size = readCanonicalOctal(header.subarray(124, 136), 'size');
        const mode = readCanonicalOctal(header.subarray(100, 108), 'mode');
        const uid = readCanonicalOctal(header.subarray(108, 116), 'uid');
        const gid = readCanonicalOctal(header.subarray(116, 124), 'gid');
        const mtime = readCanonicalOctal(header.subarray(136, 148), 'mtime');
        const deviceMajor = readCanonicalOctal(header.subarray(329, 337), 'device major');
        const deviceMinor = readCanonicalOctal(header.subarray(337, 345), 'device minor');
        const uname = decodeFixedString(header.subarray(265, 297), 'uname');
        const gname = decodeFixedString(header.subarray(297, 329), 'gname');
        const linkTarget = decodeFixedString(header.subarray(157, 257), 'link name');
        if (
            uid !== 0 ||
            gid !== 0 ||
            mtime !== 0 ||
            deviceMajor !== 0 ||
            deviceMinor !== 0 ||
            uname !== '' ||
            gname !== ''
        ) {
            throw new PackageFixtureError(
                'invalid-header',
                `Archive entry has host-dependent USTAR metadata: ${archivePath}`,
            );
        }
        if (size > limits.maxEntryBytes) {
            throw new PackageFixtureError('limit-entry-size', `${archivePath} exceeds the per-entry byte limit`);
        }
        totalBytes += size;
        if (totalBytes > limits.maxDecompressedBytes) {
            throw new PackageFixtureError(
                'limit-decompressed-total',
                'Archive entries exceed the decompressed-total limit',
            );
        }
        if (typeFlag === '1' || typeFlag === '2') {
            throw new PackageFixtureError('link-entry', `Archive links are forbidden: ${archivePath}`);
        }
        if (typeFlag === '3' || typeFlag === '4' || typeFlag === '6') {
            throw new PackageFixtureError('device-entry', `Archive device/FIFO entries are forbidden: ${archivePath}`);
        }
        if (typeFlag !== '0' && typeFlag !== '5') {
            throw new PackageFixtureError(
                'unsupported-entry',
                `Archive entry type ${JSON.stringify(typeFlag)} is forbidden`,
            );
        }
        if (linkTarget !== '') {
            throw new PackageFixtureError('invalid-header', `Non-link archive entry has a link target: ${archivePath}`);
        }
        if (archivePath !== ARCHIVE_ROOT && !archivePath.startsWith(ARCHIVE_ROOT)) {
            throw new PackageFixtureError('archive-root', `Archive entry is outside ${ARCHIVE_ROOT}: ${archivePath}`);
        }
        const canonicalUstarPath = splitUstarPath(archivePath);
        if (canonicalUstarPath.name !== name || canonicalUstarPath.prefix !== prefix) {
            throw new PackageFixtureError(
                'invalid-header',
                `Archive path does not use its canonical USTAR name/prefix split: ${archivePath}`,
            );
        }
        const directory = typeFlag === '5';
        if (directory && !archivePath.endsWith('/')) {
            throw new PackageFixtureError('invalid-header', `Directory entry lacks a trailing slash: ${archivePath}`);
        }
        if (directory && (size !== 0 || mode !== 0o755)) {
            throw new PackageFixtureError('invalid-header', `Directory entry is not normalized: ${archivePath}`);
        }
        if (!directory && mode !== 0o644 && mode !== 0o755) {
            throw new PackageFixtureError('invalid-header', `Regular-file mode is not normalized: ${archivePath}`);
        }
        if (previousArchivePath !== undefined && comparePortablePaths(previousArchivePath, archivePath) > 0) {
            throw new PackageFixtureError('invalid-header', `Tar entries are not in lexical order: ${archivePath}`);
        }
        previousArchivePath = archivePath;
        const relativeWithOptionalSlash = archivePath === ARCHIVE_ROOT ? '' : archivePath.slice(ARCHIVE_ROOT.length);
        const relative =
            directory && relativeWithOptionalSlash.endsWith('/')
                ? relativeWithOptionalSlash.slice(0, -1)
                : relativeWithOptionalSlash;
        if (relative.length > 0) {
            const normalized = normalizePackagePath(relative);
            if (normalized !== relative) {
                throw new PackageFixtureError(
                    'non-normalized-path',
                    `Archive path is not in canonical NFC/slash form: ${relative}`,
                );
            }
        }
        const pathDepth = relative.length === 0 ? 0 : relative.split('/').length;
        if (pathDepth > limits.maxPathDepth) {
            throw new PackageFixtureError('limit-depth', `${relative} exceeds the path-depth limit`);
        }
        if (Buffer.byteLength(relative) > limits.maxPathBytes) {
            throw new PackageFixtureError('limit-path-size', `${relative} exceeds the path-byte limit`);
        }
        const dataOffset = offset + TAR_BLOCK_SIZE;
        const dataEnd = dataOffset + size;
        if (dataEnd > tarBytes.length) {
            throw new PackageFixtureError('invalid-header', `${archivePath} extends beyond the tar body`);
        }
        const paddedEnd = dataEnd + paddingFor(size).length;
        if (paddedEnd > tarBytes.length || !isZeroBlock(tarBytes.subarray(dataEnd, paddedEnd))) {
            throw new PackageFixtureError('invalid-header', `${archivePath} has nonzero or truncated USTAR padding`);
        }
        entries.push({
            path: relative.length === 0 ? '.' : relative,
            kind: directory ? 'directory' : 'file',
            bytes: Uint8Array.from(tarBytes.subarray(dataOffset, dataEnd)),
            mode,
        });
        offset = paddedEnd;
    }
    if (!sawEnd) {
        throw new PackageFixtureError('invalid-header', 'Tar archive has no two-block terminator');
    }
    assertNoPortablePathConflicts(entries.map(({ path, kind }) => ({ path, kind })));
    return entries;
}

function assertGzipBoundsAndProfile(bytes: Uint8Array, limits: ReferenceExtractionLimits): number {
    if (bytes.length < 18) {
        throw new PackageFixtureError('gzip-profile', 'Gzip member is truncated');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredSize = view.getUint32(bytes.length - 4, true);
    if (declaredSize > limits.maxDecompressedBytes) {
        throw new PackageFixtureError('limit-decompressed-total', 'Gzip ISIZE exceeds the decompressed-total limit');
    }
    if (declaredSize / bytes.length > limits.maxCompressionRatio) {
        throw new PackageFixtureError('limit-compression-ratio', 'Gzip member exceeds the allowed expansion ratio');
    }
    const expectedHeader = [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff];
    if (!expectedHeader.every((value, index) => bytes[index] === value)) {
        throw new PackageFixtureError('gzip-profile', 'Gzip member does not use the V1 fixed header');
    }
    let offset = 10;
    const deflateEnd = bytes.length - 8;
    let final = false;
    while (offset < deflateEnd && !final) {
        const blockHeader = bytes[offset];
        if (blockHeader === undefined || (blockHeader & 0xfe) !== 0) {
            throw new PackageFixtureError(
                'gzip-profile',
                'Gzip member does not use byte-aligned stored DEFLATE blocks',
            );
        }
        final = (blockHeader & 1) === 1;
        if (offset + 5 > deflateEnd) {
            throw new PackageFixtureError('gzip-profile', 'Stored DEFLATE block header is truncated');
        }
        const length = (bytes[offset + 1] ?? 0) | ((bytes[offset + 2] ?? 0) << 8);
        const complement = (bytes[offset + 3] ?? 0) | ((bytes[offset + 4] ?? 0) << 8);
        if ((~length & 0xffff) !== complement) {
            throw new PackageFixtureError('gzip-profile', 'Stored DEFLATE block length complement is invalid');
        }
        offset += 5 + length;
        if (offset > deflateEnd) {
            throw new PackageFixtureError('gzip-profile', 'Stored DEFLATE block extends beyond the gzip member');
        }
    }
    if (!final || offset !== deflateEnd) {
        throw new PackageFixtureError('gzip-profile', 'Gzip member has trailing or incomplete DEFLATE data');
    }
    return declaredSize;
}

function expectObject(value: unknown, label: string): JsonObject {
    if (!isJsonObject(value)) {
        throw new PackageFixtureError('manifest-integrity', `${label} must be an object`);
    }
    return value;
}

function expectExactKeys(value: JsonObject, keys: ReadonlyArray<string>, label: string): void {
    const actual = Object.keys(value).sort(comparePortablePaths);
    const expected = [...keys].sort(comparePortablePaths);
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new PackageFixtureError('manifest-integrity', `${label} has missing or unknown fields`);
    }
}

function expectString(value: JsonObject, key: string, label: string): string {
    const field = value[key];
    if (typeof field !== 'string') {
        throw new PackageFixtureError('manifest-integrity', `${label}.${key} must be a string`);
    }
    return field;
}

function expectDigest(value: JsonObject, key: string, label: string): string {
    const digest = expectString(value, key, label);
    if (!SHA256_HEX.test(digest)) {
        throw new PackageFixtureError('manifest-integrity', `${label}.${key} is not a lowercase SHA-256 digest`);
    }
    return digest;
}

function parseDependency(value: unknown, index: number): ReferenceResolvedDependency {
    const label = `dependencies[${String(index)}]`;
    const object = expectObject(value, label);
    expectExactKeys(object, ['requested', 'canonicalIri', 'version', 'archiveSha256'], label);
    return {
        requested: expectString(object, 'requested', label),
        canonicalIri: expectString(object, 'canonicalIri', label),
        version: expectString(object, 'version', label),
        archiveSha256: expectDigest(object, 'archiveSha256', label),
    };
}

function parseToolRequirement(value: unknown, label: string): ReferenceToolRequirement {
    const object = expectObject(value, label);
    expectExactKeys(object, ['version', 'sha256'], label);
    return { version: expectString(object, 'version', label), sha256: expectDigest(object, 'sha256', label) };
}

function parseManifestFile(value: unknown, index: number): PackageManifestFile {
    const label = `files[${String(index)}]`;
    const object = expectObject(value, label);
    expectExactKeys(object, ['path', 'byteSize', 'sha256', 'executable'], label);
    const byteSize = object.byteSize;
    const executable = object.executable;
    if (!Number.isSafeInteger(byteSize) || typeof byteSize !== 'number' || byteSize < 0) {
        throw new PackageFixtureError('manifest-integrity', `${label}.byteSize must be a non-negative safe integer`);
    }
    if (typeof executable !== 'boolean') {
        throw new PackageFixtureError('manifest-integrity', `${label}.executable must be boolean`);
    }
    return {
        path: expectString(object, 'path', label),
        byteSize,
        sha256: expectDigest(object, 'sha256', label),
        executable,
    };
}

export function decodeCanonicalPackageManifest(bytes: Uint8Array): PackageManifestV1 {
    let value: unknown;
    try {
        value = JSON.parse(fatalUtf8Decoder.decode(bytes));
    } catch {
        throw new PackageFixtureError('manifest-integrity', 'Generated package manifest is not valid UTF-8 JSON');
    }
    const object = expectObject(value, 'manifest');
    const version = object.formatVersion;
    if (typeof version !== 'number' || !isPackageFormatVersionCompatible(version)) {
        throw new PackageFixtureError('unsupported-version', `Unsupported package format version: ${String(version)}`);
    }
    expectExactKeys(
        object,
        [
            'formatVersion',
            'archiveRoot',
            'generatedManifestPath',
            'canonicalIri',
            'version',
            'dependencies',
            'toolchain',
            'files',
        ],
        'manifest',
    );
    if (object.archiveRoot !== ARCHIVE_ROOT || object.generatedManifestPath !== GENERATED_MANIFEST_PATH) {
        throw new PackageFixtureError('manifest-integrity', 'Manifest archive paths do not match format V1');
    }
    if (!Array.isArray(object.dependencies) || !Array.isArray(object.files)) {
        throw new PackageFixtureError('manifest-integrity', 'Manifest dependencies and files must be arrays');
    }
    const dependencies = object.dependencies.map(parseDependency);
    let previousDependency: ReferenceResolvedDependency | undefined;
    for (const dependency of dependencies) {
        if (previousDependency !== undefined && compareDependencies(previousDependency, dependency) >= 0) {
            throw new PackageFixtureError('manifest-integrity', 'Manifest dependencies are not uniquely sorted');
        }
        previousDependency = dependency;
    }
    const toolchain = expectObject(object.toolchain, 'toolchain');
    expectExactKeys(toolchain, ['validator', 'reasoner'], 'toolchain');
    const manifest: PackageManifestV1 = {
        formatVersion: PACKAGE_FORMAT_VERSION,
        archiveRoot: ARCHIVE_ROOT,
        generatedManifestPath: GENERATED_MANIFEST_PATH,
        canonicalIri: expectString(object, 'canonicalIri', 'manifest'),
        version: expectString(object, 'version', 'manifest'),
        dependencies,
        toolchain: {
            validator: parseToolRequirement(toolchain.validator, 'toolchain.validator'),
            reasoner: parseToolRequirement(toolchain.reasoner, 'toolchain.reasoner'),
        },
        files: object.files.map(parseManifestFile),
    };
    assertManifestSemantics(manifest);
    return manifest;
}

function assertManifestIntegrity(
    entries: ReadonlyArray<ParsedTarFile>,
    manifest: PackageManifestV1,
): ReadonlyArray<PackageManifestFile> {
    const archiveFiles = new Map(entries.filter(({ kind }) => kind === 'file').map((entry) => [entry.path, entry]));
    const expectedPaths = new Set<string>([GENERATED_MANIFEST_PATH]);
    let previousPath: string | undefined;
    for (const file of manifest.files) {
        const normalized = normalizePackagePath(file.path);
        if (
            normalized !== file.path ||
            (previousPath !== undefined && comparePortablePaths(previousPath, file.path) >= 0)
        ) {
            throw new PackageFixtureError(
                'manifest-integrity',
                'Manifest file paths are not uniquely sorted in canonical order',
            );
        }
        if (!SHA256_HEX.test(file.sha256)) {
            throw new PackageFixtureError('manifest-integrity', `Manifest digest is invalid for ${file.path}`);
        }
        const entry = archiveFiles.get(file.path);
        if (
            entry === undefined ||
            entry.bytes.length !== file.byteSize ||
            sha256PackageBytes(entry.bytes) !== file.sha256
        ) {
            throw new PackageFixtureError('manifest-integrity', `Manifest integrity check failed for ${file.path}`);
        }
        if (entry.mode !== (file.executable ? 0o755 : 0o644)) {
            throw new PackageFixtureError('manifest-integrity', `Manifest executable mode disagrees for ${file.path}`);
        }
        expectedPaths.add(file.path);
        previousPath = file.path;
    }
    for (const path of archiveFiles.keys()) {
        if (!expectedPaths.has(path)) {
            throw new PackageFixtureError('manifest-integrity', `Unmanifested regular file: ${path}`);
        }
    }
    const expectedDirectories = new Set(
        collectDirectories([...expectedPaths].map((path) => `${ARCHIVE_ROOT}${path}`)).map((archivePath) => {
            if (archivePath === ARCHIVE_ROOT) {
                return '.';
            }
            return archivePath.slice(ARCHIVE_ROOT.length, -1);
        }),
    );
    for (const entry of entries) {
        if (entry.kind === 'directory' && !expectedDirectories.has(entry.path)) {
            throw new PackageFixtureError('manifest-integrity', `Unexpected archive directory: ${entry.path}`);
        }
    }
    const actualDirectories = entries.filter(({ kind }) => kind === 'directory').map(({ path }) => path);
    if (
        actualDirectories.length !== expectedDirectories.size ||
        actualDirectories.some((path) => !expectedDirectories.has(path))
    ) {
        throw new PackageFixtureError(
            'manifest-integrity',
            'Archive does not contain the exact canonical parent-directory set',
        );
    }
    return manifest.files;
}

/**
 * In-memory fixture validator. Slice 2 must implement streaming extraction with the same
 * decisions; this bounded oracle proves the format and attack fixtures without pretending
 * to be that production extractor.
 */
/**
 * In-memory fixture validator. Slice 2 must implement streaming extraction with the same
 * decisions; this bounded oracle proves the format and attack fixtures without pretending
 * to be that production extractor.
 */
export function validateReferenceArchiveFixture(
    archiveBytes: Uint8Array,
    overrides: Partial<ReferenceExtractionLimits> = {},
): ValidatedReferenceArchive {
    const limits = { ...REFERENCE_EXTRACTION_LIMITS, ...overrides };
    const declaredSize = assertGzipBoundsAndProfile(archiveBytes, limits);
    let tarBytes: Uint8Array;
    try {
        tarBytes = gunzipSync(archiveBytes, { maxOutputLength: limits.maxDecompressedBytes });
    } catch {
        throw new PackageFixtureError(
            'limit-decompressed-total',
            'Gzip member could not be decompressed within the configured limit',
        );
    }
    if (tarBytes.length !== declaredSize) {
        throw new PackageFixtureError('gzip-profile', 'Gzip ISIZE does not match the decompressed tar');
    }
    const entries = parseTar(tarBytes, limits);
    const manifestEntry = entries.find(({ kind, path }) => kind === 'file' && path === GENERATED_MANIFEST_PATH);
    if (manifestEntry === undefined) {
        throw new PackageFixtureError('missing-manifest', `Archive lacks ${GENERATED_MANIFEST_ARCHIVE_PATH}`);
    }
    const manifest = decodeCanonicalPackageManifest(manifestEntry.bytes);
    if (
        manifestEntry.mode !== 0o644 ||
        !Buffer.from(manifestEntry.bytes).equals(Buffer.from(encodeCanonicalPackageManifest(manifest)))
    ) {
        throw new PackageFixtureError(
            'manifest-integrity',
            'Generated manifest mode or canonical JSON bytes do not match format V1',
        );
    }
    const files = assertManifestIntegrity(entries, manifest);
    return { archiveSha256: sha256PackageBytes(archiveBytes), manifest, files };
}

/** Build intentionally invalid fixture bytes without applying path or entry-type policy. */
export function encodeUnsafeTarGzipFixture(entries: ReadonlyArray<UnsafeTarFixtureEntry>): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (const entry of entries) {
        const bytes = toBytes(entry.bytes);
        const declaredSize = entry.declaredSize ?? bytes.length;
        chunks.push(
            encodeTarHeader(entry.path, entry.typeFlag ?? '0', declaredSize, entry.mode ?? 0o644, entry.linkTarget),
        );
        chunks.push(bytes, paddingFor(bytes.length));
    }
    chunks.push(ZERO_TAR_BLOCK, ZERO_TAR_BLOCK);
    return gzipReferenceBytes(Buffer.concat(chunks));
}
