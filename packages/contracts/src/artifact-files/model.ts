import { assertNoPortablePathConflicts, comparePortablePaths, normalizePackagePath } from '@erden/package-format';

import { isCanonicalOntologyIri, isRegistryOrigin, normalizeRegistryOrigin } from '../manifest/index.js';
import {
    decodeRegistryExactVersion,
    decodeRegistryReadContext,
    type RegistryReadContext,
} from '../registry-release-index/model.js';

import { ArtifactFileError } from './errors.js';

export const ARTIFACT_FILE_LIMITS = Object.freeze({
    fixedPageItems: 64,
    maxCursorBytes: 1_024,
    maxEntries: 10_000,
    maxFileBytes: 64 * 1_024 * 1_024,
    maxOpaqueIdBytes: 128,
    maxPreviewBytes: 10 * 1_024 * 1_024,
    maxScalarBytes: 1_024,
    privateRawLifetimeMilliseconds: 300_000,
});

export type ArtifactMediaSignature =
    | 'binary'
    | 'csv-utf8'
    | 'geojson-utf8'
    | 'gif'
    | 'jpeg'
    | 'jupyter-json'
    | 'markdown-utf8'
    | 'mermaid-utf8'
    | 'pdf'
    | 'png'
    | 'psd'
    | 'stl'
    | 'svg-xml'
    | 'topojson-utf8'
    | 'tsv-utf8'
    | 'utf8-text'
    | 'webp';

export type ArtifactRendererProfile =
    | 'geojson'
    | 'jupyter'
    | 'markdown'
    | 'mermaid'
    | 'pdf'
    | 'psd'
    | 'raster'
    | 'source'
    | 'stl'
    | 'svg'
    | 'tabular';

export type ArtifactRendererSelection =
    | Readonly<{
          readonly kind: 'preview';
          readonly profile: ArtifactRendererProfile;
          readonly sourceByteSize: number;
      }>
    | Readonly<{
          readonly kind: 'fallback';
          readonly reason: 'media-mismatch' | 'size-limit' | 'unsupported';
      }>;

export interface ArtifactReleaseInput {
    readonly canonicalIri: string;
    readonly registryOrigin: string;
    readonly version: string;
}

export interface ListArtifactFilesInput extends ArtifactReleaseInput {
    readonly cursor: string | null;
}

export interface GetArtifactFileInput extends ArtifactReleaseInput {
    readonly ifNoneMatch: string | null;
    readonly path: string;
}

export interface GetArtifactRawFileInput extends GetArtifactFileInput {
    readonly method: 'GET' | 'HEAD';
}

export interface ArtifactFileEntryV1 {
    readonly byteSize: number;
    readonly path: string;
    readonly sha256: string;
}

export interface ArtifactFilePageV1 {
    readonly entries: ReadonlyArray<ArtifactFileEntryV1>;
    readonly fileCount: number;
    readonly indexSha256: string;
    readonly nextCursor: string | null;
    readonly pageOrdinal: number;
    readonly schema: 'erden.artifact-file-page/v1';
}

export interface ArtifactFileViewV1 extends ArtifactFileEntryV1 {
    readonly mediaSignature: ArtifactMediaSignature;
    readonly previewBytes: Readonly<Uint8Array>;
    readonly renderer: ArtifactRendererSelection;
    readonly rawAccess: ArtifactRawAccessV1;
    readonly schema: 'erden.artifact-file-view/v1';
    readonly validator: string;
}

export type ArtifactFileReadResultV1 =
    | Readonly<{ readonly kind: 'file'; readonly file: ArtifactFileViewV1 }>
    | Readonly<{ readonly kind: 'not-modified'; readonly validator: string }>;

export interface ArtifactRawFileV1 extends ArtifactFileEntryV1 {
    readonly body: Readonly<Uint8Array> | null;
    readonly contentDisposition: 'attachment' | 'inline';
    readonly mediaType: string;
    readonly method: 'GET' | 'HEAD';
    readonly rawAccess: ArtifactRawAccessV1;
    readonly schema: 'erden.artifact-raw-file/v1';
    readonly validator: string;
}

export type ArtifactRawAccessV1 =
    | Readonly<{ readonly kind: 'public' }>
    | Readonly<{
          readonly audienceDigest: string;
          readonly kind: 'private';
          readonly maximumLifetimeMilliseconds: 300_000;
          readonly policyEpoch: number;
          readonly releaseDigest: string;
      }>;

export type ArtifactRawFileReadResultV1 =
    | Readonly<{ readonly file: ArtifactRawFileV1; readonly kind: 'file' }>
    | Readonly<{ readonly kind: 'not-modified'; readonly validator: string }>;

export interface AuthorizedArtifactIdentity {
    readonly access: 'private' | 'public';
    readonly archiveSha256: string;
    readonly audienceKey: string;
    readonly canonicalIri: string;
    readonly indexSha256: string;
    readonly policyEpoch: number;
    readonly registryOrigin: string;
    readonly releaseId: string;
    readonly version: string;
}

export interface AuthorizedArtifactFilePageRecord extends AuthorizedArtifactIdentity {
    readonly entries: ReadonlyArray<ArtifactFileEntryV1>;
    readonly fileCount: number;
    readonly nextCursor: string | null;
    readonly pageOrdinal: number;
}

export interface AuthorizedArtifactFileRecord extends AuthorizedArtifactIdentity, ArtifactFileEntryV1 {
    readonly complete: boolean;
    readonly mediaSignature: ArtifactMediaSignature;
    readonly previewBytes: Readonly<Uint8Array>;
}

export interface AuthorizedArtifactRawRecord extends AuthorizedArtifactIdentity, ArtifactFileEntryV1 {
    readonly bytes: Readonly<Uint8Array>;
    readonly mediaSignature: ArtifactMediaSignature;
}

type Plain = Readonly<Record<string, unknown>>;
const SHA256 = /^[0-9a-f]{64}$/u;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const VALIDATOR = /^"[0-9a-f]{64}"$/u;
const mediaSignatures = new Set<ArtifactMediaSignature>([
    'binary',
    'csv-utf8',
    'geojson-utf8',
    'gif',
    'jpeg',
    'jupyter-json',
    'markdown-utf8',
    'mermaid-utf8',
    'pdf',
    'png',
    'psd',
    'stl',
    'svg-xml',
    'topojson-utf8',
    'tsv-utf8',
    'utf8-text',
    'webp',
]);

function failure(code: ConstructorParameters<typeof ArtifactFileError>[0]): never {
    throw new ArtifactFileError(code);
}

function exact(
    input: unknown,
    names: ReadonlyArray<string>,
    code: ConstructorParameters<typeof ArtifactFileError>[0],
): Plain {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        return failure(code);
    }
    const actual = Object.getOwnPropertyNames(input).sort();
    const expected = [...names].sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
        return failure(code);
    }
    return input as Plain;
}

function field(input: Plain, name: string, code: ConstructorParameters<typeof ArtifactFileError>[0]): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
        ? descriptor.value
        : failure(code);
}

function string(input: unknown, maximum: number, code: ConstructorParameters<typeof ArtifactFileError>[0]): string {
    if (typeof input !== 'string' || !input.isWellFormed() || Buffer.byteLength(input) > maximum) {
        return failure(code);
    }
    return input;
}

function nonnegative(
    input: unknown,
    maximum: number,
    code: ConstructorParameters<typeof ArtifactFileError>[0],
): number {
    if (
        !Number.isSafeInteger(input) ||
        typeof input !== 'number' ||
        input < 0 ||
        input > maximum ||
        Object.is(input, -0)
    ) {
        return failure(code);
    }
    return input;
}

function sha(input: unknown, code: ConstructorParameters<typeof ArtifactFileError>[0]): string {
    const value = string(input, 64, code);
    return SHA256.test(value) ? value : failure(code);
}

export function decodeArtifactFilePath(
    input: unknown,
    code: ConstructorParameters<typeof ArtifactFileError>[0] = 'ARTIFACT_FILE_INPUT_INVALID',
): string {
    const value = string(input, 240, code);
    try {
        return normalizePackagePath(value) === value ? value : failure(code);
    } catch {
        return failure(code);
    }
}

function releaseInput(input: Plain): ArtifactReleaseInput {
    const registryOrigin = string(
        field(input, 'registryOrigin', 'ARTIFACT_FILE_INPUT_INVALID'),
        ARTIFACT_FILE_LIMITS.maxScalarBytes,
        'ARTIFACT_FILE_INPUT_INVALID',
    );
    const canonicalIri = string(
        field(input, 'canonicalIri', 'ARTIFACT_FILE_INPUT_INVALID'),
        ARTIFACT_FILE_LIMITS.maxScalarBytes,
        'ARTIFACT_FILE_INPUT_INVALID',
    );
    if (
        !isRegistryOrigin(registryOrigin) ||
        normalizeRegistryOrigin(registryOrigin) !== registryOrigin ||
        !isCanonicalOntologyIri(canonicalIri)
    ) {
        return failure('ARTIFACT_FILE_INPUT_INVALID');
    }
    let version: string;
    try {
        version = decodeRegistryExactVersion(field(input, 'version', 'ARTIFACT_FILE_INPUT_INVALID'));
    } catch {
        return failure('ARTIFACT_FILE_INPUT_INVALID');
    }
    return Object.freeze({ canonicalIri, registryOrigin, version });
}

export function decodeArtifactReadContext(input: unknown): RegistryReadContext {
    try {
        return decodeRegistryReadContext(input);
    } catch {
        return failure('ARTIFACT_FILE_INPUT_INVALID');
    }
}

export function decodeListArtifactFilesInput(input: unknown): ListArtifactFilesInput {
    const value = exact(input, ['canonicalIri', 'cursor', 'registryOrigin', 'version'], 'ARTIFACT_FILE_INPUT_INVALID');
    const base = releaseInput(value);
    const rawCursor = field(value, 'cursor', 'ARTIFACT_FILE_INPUT_INVALID');
    const cursor =
        rawCursor === null
            ? null
            : string(rawCursor, ARTIFACT_FILE_LIMITS.maxCursorBytes, 'ARTIFACT_FILE_INPUT_INVALID');
    if (cursor !== null && !CURSOR.test(cursor)) {
        return failure('ARTIFACT_FILE_INPUT_INVALID');
    }
    return Object.freeze({ ...base, cursor });
}

export function decodeGetArtifactFileInput(input: unknown): GetArtifactFileInput {
    const value = exact(
        input,
        ['canonicalIri', 'ifNoneMatch', 'path', 'registryOrigin', 'version'],
        'ARTIFACT_FILE_INPUT_INVALID',
    );
    const base = releaseInput(value);
    const rawValidator = field(value, 'ifNoneMatch', 'ARTIFACT_FILE_INPUT_INVALID');
    const ifNoneMatch = rawValidator === null ? null : string(rawValidator, 66, 'ARTIFACT_FILE_INPUT_INVALID');
    if (ifNoneMatch !== null && !VALIDATOR.test(ifNoneMatch)) {
        return failure('ARTIFACT_FILE_INPUT_INVALID');
    }
    return Object.freeze({
        ...base,
        ifNoneMatch,
        path: decodeArtifactFilePath(field(value, 'path', 'ARTIFACT_FILE_INPUT_INVALID')),
    });
}

export function decodeGetArtifactRawFileInput(input: unknown): GetArtifactRawFileInput {
    const value = exact(
        input,
        ['canonicalIri', 'ifNoneMatch', 'method', 'path', 'registryOrigin', 'version'],
        'ARTIFACT_FILE_INPUT_INVALID',
    );
    const method = field(value, 'method', 'ARTIFACT_FILE_INPUT_INVALID');
    if (method !== 'GET' && method !== 'HEAD') {
        return failure('ARTIFACT_FILE_INPUT_INVALID');
    }
    return Object.freeze({
        ...decodeGetArtifactFileInput({
            canonicalIri: field(value, 'canonicalIri', 'ARTIFACT_FILE_INPUT_INVALID'),
            ifNoneMatch: field(value, 'ifNoneMatch', 'ARTIFACT_FILE_INPUT_INVALID'),
            path: field(value, 'path', 'ARTIFACT_FILE_INPUT_INVALID'),
            registryOrigin: field(value, 'registryOrigin', 'ARTIFACT_FILE_INPUT_INVALID'),
            version: field(value, 'version', 'ARTIFACT_FILE_INPUT_INVALID'),
        }),
        method,
    });
}

export function decodeArtifactFileEntry(input: unknown): ArtifactFileEntryV1 {
    const value = exact(input, ['byteSize', 'path', 'sha256'], 'ARTIFACT_FILE_STATE_CONFLICT');
    return Object.freeze({
        byteSize: nonnegative(
            field(value, 'byteSize', 'ARTIFACT_FILE_STATE_CONFLICT'),
            ARTIFACT_FILE_LIMITS.maxFileBytes,
            'ARTIFACT_FILE_STATE_CONFLICT',
        ),
        path: decodeArtifactFilePath(
            field(value, 'path', 'ARTIFACT_FILE_STATE_CONFLICT'),
            'ARTIFACT_FILE_STATE_CONFLICT',
        ),
        sha256: sha(field(value, 'sha256', 'ARTIFACT_FILE_STATE_CONFLICT'), 'ARTIFACT_FILE_STATE_CONFLICT'),
    });
}

function identity(input: Plain): AuthorizedArtifactIdentity {
    const registryOrigin = string(
        field(input, 'registryOrigin', 'ARTIFACT_FILE_STATE_CONFLICT'),
        ARTIFACT_FILE_LIMITS.maxScalarBytes,
        'ARTIFACT_FILE_STATE_CONFLICT',
    );
    const canonicalIri = string(
        field(input, 'canonicalIri', 'ARTIFACT_FILE_STATE_CONFLICT'),
        ARTIFACT_FILE_LIMITS.maxScalarBytes,
        'ARTIFACT_FILE_STATE_CONFLICT',
    );
    let version: string;
    try {
        version = decodeRegistryExactVersion(field(input, 'version', 'ARTIFACT_FILE_STATE_CONFLICT'));
    } catch {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    if (
        !isRegistryOrigin(registryOrigin) ||
        normalizeRegistryOrigin(registryOrigin) !== registryOrigin ||
        !isCanonicalOntologyIri(canonicalIri)
    ) {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    const releaseId = string(
        field(input, 'releaseId', 'ARTIFACT_FILE_STATE_CONFLICT'),
        ARTIFACT_FILE_LIMITS.maxOpaqueIdBytes,
        'ARTIFACT_FILE_STATE_CONFLICT',
    );
    const audienceKey = string(
        field(input, 'audienceKey', 'ARTIFACT_FILE_STATE_CONFLICT'),
        ARTIFACT_FILE_LIMITS.maxOpaqueIdBytes,
        'ARTIFACT_FILE_STATE_CONFLICT',
    );
    if (!OPAQUE.test(releaseId) || !OPAQUE.test(audienceKey)) {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    return Object.freeze({
        access:
            field(input, 'access', 'ARTIFACT_FILE_STATE_CONFLICT') === 'public'
                ? 'public'
                : field(input, 'access', 'ARTIFACT_FILE_STATE_CONFLICT') === 'private'
                  ? 'private'
                  : failure('ARTIFACT_FILE_STATE_CONFLICT'),
        archiveSha256: sha(
            field(input, 'archiveSha256', 'ARTIFACT_FILE_STATE_CONFLICT'),
            'ARTIFACT_FILE_STATE_CONFLICT',
        ),
        audienceKey,
        canonicalIri,
        indexSha256: sha(field(input, 'indexSha256', 'ARTIFACT_FILE_STATE_CONFLICT'), 'ARTIFACT_FILE_STATE_CONFLICT'),
        policyEpoch: nonnegative(
            field(input, 'policyEpoch', 'ARTIFACT_FILE_STATE_CONFLICT'),
            Number.MAX_SAFE_INTEGER,
            'ARTIFACT_FILE_STATE_CONFLICT',
        ),
        registryOrigin,
        releaseId,
        version,
    });
}

export function decodeAuthorizedArtifactFilePage(input: unknown): AuthorizedArtifactFilePageRecord {
    const value = exact(
        input,
        [
            'access',
            'archiveSha256',
            'audienceKey',
            'canonicalIri',
            'entries',
            'fileCount',
            'indexSha256',
            'nextCursor',
            'pageOrdinal',
            'policyEpoch',
            'registryOrigin',
            'releaseId',
            'version',
        ],
        'ARTIFACT_FILE_STATE_CONFLICT',
    );
    const rawEntries = field(value, 'entries', 'ARTIFACT_FILE_STATE_CONFLICT');
    if (!Array.isArray(rawEntries) || rawEntries.length > ARTIFACT_FILE_LIMITS.fixedPageItems) {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    const entries = rawEntries.map(decodeArtifactFileEntry);
    for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        if (previous === undefined || current === undefined || comparePortablePaths(previous.path, current.path) >= 0) {
            return failure('ARTIFACT_FILE_STATE_CONFLICT');
        }
    }
    try {
        assertNoPortablePathConflicts(entries.map((entry) => ({ kind: 'file' as const, path: entry.path })));
    } catch {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    const rawCursor = field(value, 'nextCursor', 'ARTIFACT_FILE_STATE_CONFLICT');
    const nextCursor =
        rawCursor === null
            ? null
            : string(rawCursor, ARTIFACT_FILE_LIMITS.maxCursorBytes, 'ARTIFACT_FILE_STATE_CONFLICT');
    if (nextCursor !== null && !CURSOR.test(nextCursor)) {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    return Object.freeze({
        ...identity(value),
        entries: Object.freeze(entries),
        fileCount: nonnegative(
            field(value, 'fileCount', 'ARTIFACT_FILE_STATE_CONFLICT'),
            ARTIFACT_FILE_LIMITS.maxEntries,
            'ARTIFACT_FILE_STATE_CONFLICT',
        ),
        nextCursor,
        pageOrdinal: nonnegative(
            field(value, 'pageOrdinal', 'ARTIFACT_FILE_STATE_CONFLICT'),
            ARTIFACT_FILE_LIMITS.maxEntries,
            'ARTIFACT_FILE_STATE_CONFLICT',
        ),
    });
}

function signature(input: unknown): ArtifactMediaSignature {
    return typeof input === 'string' && mediaSignatures.has(input as ArtifactMediaSignature)
        ? (input as ArtifactMediaSignature)
        : failure('ARTIFACT_FILE_STATE_CONFLICT');
}

export function decodeAuthorizedArtifactFile(input: unknown): AuthorizedArtifactFileRecord {
    const value = exact(
        input,
        [
            'access',
            'archiveSha256',
            'audienceKey',
            'byteSize',
            'canonicalIri',
            'complete',
            'indexSha256',
            'mediaSignature',
            'path',
            'policyEpoch',
            'previewBytes',
            'registryOrigin',
            'releaseId',
            'sha256',
            'version',
        ],
        'ARTIFACT_FILE_STATE_CONFLICT',
    );
    const rawBytes = field(value, 'previewBytes', 'ARTIFACT_FILE_STATE_CONFLICT');
    const complete = field(value, 'complete', 'ARTIFACT_FILE_STATE_CONFLICT');
    if (
        !(rawBytes instanceof Uint8Array) ||
        rawBytes.byteLength > ARTIFACT_FILE_LIMITS.maxPreviewBytes ||
        typeof complete !== 'boolean'
    ) {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    const entry = decodeArtifactFileEntry({
        byteSize: field(value, 'byteSize', 'ARTIFACT_FILE_STATE_CONFLICT'),
        path: field(value, 'path', 'ARTIFACT_FILE_STATE_CONFLICT'),
        sha256: field(value, 'sha256', 'ARTIFACT_FILE_STATE_CONFLICT'),
    });
    if (
        (complete && rawBytes.byteLength !== entry.byteSize) ||
        (!complete && rawBytes.byteLength !== ARTIFACT_FILE_LIMITS.maxPreviewBytes)
    ) {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    return Object.freeze({
        ...identity(value),
        ...entry,
        complete,
        mediaSignature: signature(field(value, 'mediaSignature', 'ARTIFACT_FILE_STATE_CONFLICT')),
        previewBytes: Uint8Array.from(rawBytes),
    });
}

export function decodeAuthorizedArtifactRaw(input: unknown): AuthorizedArtifactRawRecord {
    const value = exact(
        input,
        [
            'access',
            'archiveSha256',
            'audienceKey',
            'byteSize',
            'bytes',
            'canonicalIri',
            'indexSha256',
            'mediaSignature',
            'path',
            'policyEpoch',
            'registryOrigin',
            'releaseId',
            'sha256',
            'version',
        ],
        'ARTIFACT_FILE_STATE_CONFLICT',
    );
    const bytes = field(value, 'bytes', 'ARTIFACT_FILE_STATE_CONFLICT');
    const entry = decodeArtifactFileEntry({
        byteSize: field(value, 'byteSize', 'ARTIFACT_FILE_STATE_CONFLICT'),
        path: field(value, 'path', 'ARTIFACT_FILE_STATE_CONFLICT'),
        sha256: field(value, 'sha256', 'ARTIFACT_FILE_STATE_CONFLICT'),
    });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entry.byteSize) {
        return failure('ARTIFACT_FILE_STATE_CONFLICT');
    }
    return Object.freeze({
        ...identity(value),
        ...entry,
        bytes: Uint8Array.from(bytes),
        mediaSignature: signature(field(value, 'mediaSignature', 'ARTIFACT_FILE_STATE_CONFLICT')),
    });
}

export function sameArtifactRequest(identityRecord: AuthorizedArtifactIdentity, input: ArtifactReleaseInput): boolean {
    return (
        identityRecord.registryOrigin === input.registryOrigin &&
        identityRecord.canonicalIri === input.canonicalIri &&
        identityRecord.version === input.version
    );
}
