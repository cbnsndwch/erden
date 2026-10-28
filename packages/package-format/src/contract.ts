import { Schema } from 'effect';

export const PACKAGE_FORMAT_VERSION = 1 as const;
export const ARCHIVE_ROOT = 'package/' as const;
export const GENERATED_MANIFEST_PATH = '.erden/package-manifest.json' as const;
export const GENERATED_MANIFEST_ARCHIVE_PATH = `${ARCHIVE_ROOT}${GENERATED_MANIFEST_PATH}` as const;
export const TAR_BLOCK_SIZE = 512 as const;

export const PackageFormatVersion = Schema.Literal(PACKAGE_FORMAT_VERSION);
export type PackageFormatVersion = typeof PackageFormatVersion.Type;

export interface ReferenceExtractionLimits {
    readonly maxEntries: number;
    readonly maxEntryBytes: number;
    readonly maxDecompressedBytes: number;
    readonly maxCompressionRatio: number;
    readonly maxPathDepth: number;
    readonly maxPathBytes: number;
}

export const REFERENCE_EXTRACTION_LIMITS: ReferenceExtractionLimits = Object.freeze({
    maxEntries: 10_000,
    maxEntryBytes: 64 * 1024 * 1024,
    maxDecompressedBytes: 512 * 1024 * 1024,
    maxCompressionRatio: 200,
    maxPathDepth: 32,
    maxPathBytes: 240,
});

export type PackageFixtureErrorCode =
    | 'absolute-path'
    | 'archive-root'
    | 'case-conflict'
    | 'conflicting-path'
    | 'device-entry'
    | 'drive-path'
    | 'duplicate-path'
    | 'empty-path'
    | 'generated-path'
    | 'gzip-profile'
    | 'invalid-header'
    | 'invalid-utf8'
    | 'limit-compression-ratio'
    | 'limit-decompressed-total'
    | 'limit-depth'
    | 'limit-entries'
    | 'limit-entry-size'
    | 'limit-path-size'
    | 'link-entry'
    | 'manifest-integrity'
    | 'missing-manifest'
    | 'non-normalized-path'
    | 'reserved-name'
    | 'traversal-path'
    | 'unicode-conflict'
    | 'unsupported-entry'
    | 'unsupported-version';

export class PackageFixtureError extends Error {
    readonly code: PackageFixtureErrorCode;

    constructor(code: PackageFixtureErrorCode, message: string) {
        super(message);
        this.name = 'PackageFixtureError';
        this.code = code;
    }
}

const WINDOWS_RESERVED_BASENAMES =
    /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function utf8Length(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

function assertPortableSegment(segment: string, original: string): void {
    if (segment === '..') {
        throw new PackageFixtureError('traversal-path', `Package path traverses its root: ${JSON.stringify(original)}`);
    }
    if (segment === '.' || segment.length === 0) {
        throw new PackageFixtureError(
            'non-normalized-path',
            `Package path has an empty or dot segment: ${JSON.stringify(original)}`,
        );
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
        throw new PackageFixtureError(
            'reserved-name',
            `Package path has a segment ending in a dot or space: ${JSON.stringify(original)}`,
        );
    }
    if (WINDOWS_FORBIDDEN_CHARACTERS.test(segment) || WINDOWS_RESERVED_BASENAMES.test(segment)) {
        throw new PackageFixtureError(
            'reserved-name',
            `Package path is not portable to Windows: ${JSON.stringify(original)}`,
        );
    }
}

/**
 * Convert a logical package path to the sole V1 representation.
 *
 * Inputs are Unicode scalar-value strings. Backslashes are accepted as source-platform
 * separators, converted to `/`, and the whole path is normalized to NFC. Dot segments,
 * absolute paths, drive/UNC forms, control characters, and Windows-reserved names are
 * rejected rather than repaired. A V1 path is relative to `package/`, never includes that
 * root itself, and is at most 240 UTF-8 bytes and 32 segments.
 */
/**
 * Convert a logical package path to the sole V1 representation.
 *
 * Inputs are Unicode scalar-value strings. Backslashes are accepted as source-platform
 * separators, converted to `/`, and the whole path is normalized to NFC. Dot segments,
 * absolute paths, drive/UNC forms, control characters, and Windows-reserved names are
 * rejected rather than repaired. A V1 path is relative to `package/`, never includes that
 * root itself, and is at most 240 UTF-8 bytes and 32 segments.
 */
export function normalizePackagePath(input: string): string {
    if (input.length === 0) {
        throw new PackageFixtureError('empty-path', 'Package path must not be empty');
    }
    if (UNPAIRED_SURROGATE.test(input)) {
        throw new PackageFixtureError(
            'invalid-utf8',
            `Package path contains an unpaired UTF-16 surrogate: ${JSON.stringify(input)}`,
        );
    }
    if (input.startsWith('/') || input.startsWith('\\')) {
        throw new PackageFixtureError('absolute-path', `Package path must be relative: ${JSON.stringify(input)}`);
    }
    if (WINDOWS_DRIVE_PREFIX.test(input)) {
        throw new PackageFixtureError(
            'drive-path',
            `Package path must not use a Windows drive prefix: ${JSON.stringify(input)}`,
        );
    }
    const normalized = input.replaceAll('\\', '/').normalize('NFC');
    if (normalized.startsWith('//')) {
        throw new PackageFixtureError(
            'absolute-path',
            `Package path must not use a UNC root: ${JSON.stringify(input)}`,
        );
    }
    const segments = normalized.split('/');
    for (const segment of segments) {
        assertPortableSegment(segment, input);
    }
    if (segments.length > REFERENCE_EXTRACTION_LIMITS.maxPathDepth) {
        throw new PackageFixtureError(
            'limit-depth',
            `Package path exceeds ${String(REFERENCE_EXTRACTION_LIMITS.maxPathDepth)} segments: ${JSON.stringify(input)}`,
        );
    }
    if (utf8Length(normalized) > REFERENCE_EXTRACTION_LIMITS.maxPathBytes) {
        throw new PackageFixtureError(
            'limit-path-size',
            `Package path exceeds ${String(REFERENCE_EXTRACTION_LIMITS.maxPathBytes)} UTF-8 bytes: ${JSON.stringify(input)}`,
        );
    }
    return normalized;
}

/** Conservative, deterministic Windows-style ordinal-insensitive key. */
export function portablePathCollisionKey(path: string): string {
    return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

export function comparePortablePaths(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function isPackageFormatVersionCompatible(version: number): version is PackageFormatVersion {
    return version === PACKAGE_FORMAT_VERSION;
}

export interface PortablePathRecord {
    readonly path: string;
    readonly kind: 'directory' | 'file';
}

/** Reject exact, NFC, case-folded, and file-vs-descendant collisions. */
export function assertNoPortablePathConflicts(records: ReadonlyArray<PortablePathRecord>): void {
    const exact = new Map<string, PortablePathRecord>();
    const canonical = new Map<string, string>();
    const folded = new Map<string, string>();
    for (const record of records) {
        const existing = exact.get(record.path);
        if (existing !== undefined) {
            throw new PackageFixtureError('duplicate-path', `Duplicate normalized package path: ${record.path}`);
        }
        exact.set(record.path, record);
        const nfc = record.path.normalize('NFC');
        const canonicallyConflicting = canonical.get(nfc);
        if (canonicallyConflicting !== undefined && canonicallyConflicting !== record.path) {
            throw new PackageFixtureError(
                'unicode-conflict',
                `Unicode-equivalent package paths conflict: ${canonicallyConflicting} and ${record.path}`,
            );
        }
        canonical.set(nfc, record.path);
        const key = portablePathCollisionKey(nfc);
        const conflicting = folded.get(key);
        if (conflicting !== undefined && conflicting !== record.path) {
            throw new PackageFixtureError(
                'case-conflict',
                `Case-insensitive package paths conflict: ${conflicting} and ${record.path}`,
            );
        }
        folded.set(key, record.path);
    }
    for (const record of records) {
        const segments = record.path.split('/');
        for (let length = 1; length < segments.length; length += 1) {
            const ancestorPath = segments.slice(0, length).join('/');
            if (exact.get(ancestorPath)?.kind === 'file') {
                throw new PackageFixtureError(
                    'conflicting-path',
                    `File path ${ancestorPath} conflicts with descendant ${record.path}`,
                );
            }
        }
    }
}
