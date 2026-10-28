import { createHash } from 'node:crypto';

import {
    ARTIFACT_FILE_LIMITS,
    decodeArtifactFileEntry,
    decodeGetArtifactFileInput,
    decodeListArtifactFilesInput,
    normalizeRegistryOrigin,
    parseCliCredential,
    type ArtifactFileEntryV1,
    type ArtifactFilePageV1,
    type ArtifactMediaSignature,
    type ArtifactRendererSelection,
} from '@erden/contracts';

import { requestRegistryJsonWire, retryRegistryTransport, type RegistryHttpRuntime } from './http.js';
import { RegistryClientError, authenticateRegistryJsonHeaders, exactRecord } from './wire.js';

interface ArtifactRegistryReadBase {
    readonly bearer?: string;
    readonly registryOrigin: string;
    readonly signal?: AbortSignal;
}

export interface ListRegistryArtifactFilesRequest extends ArtifactRegistryReadBase {
    readonly canonicalIri: string;
    readonly cursor?: string | null;
    readonly version: string;
}

export interface GetRegistryArtifactFileRequest extends ArtifactRegistryReadBase {
    readonly canonicalIri: string;
    readonly path: string;
    readonly version: string;
}

export interface RegistryArtifactRawDescriptor {
    readonly expiresAt: number | null;
    readonly headUrl: string;
    readonly url: string;
}

export interface RegistryArtifactFile extends ArtifactFileEntryV1 {
    readonly mediaSignature: ArtifactMediaSignature;
    readonly previewBytes: Readonly<Uint8Array>;
    readonly raw: RegistryArtifactRawDescriptor;
    readonly renderer: ArtifactRendererSelection;
    readonly schema: 'erden.registry-artifact-file/v1';
    readonly validator: string;
}

const SHA256 = /^[0-9a-f]{64}$/u;
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
const rendererProfiles = new Set([
    'geojson',
    'jupyter',
    'markdown',
    'mermaid',
    'pdf',
    'psd',
    'raster',
    'source',
    'stl',
    'svg',
    'tabular',
]);

function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function origin(input: string): string {
    try {
        const normalized = normalizeRegistryOrigin(input);
        if (normalized !== input) {
            throw new Error();
        }
        return normalized;
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
}

function bearer(input: string | undefined): string | undefined {
    if (input !== undefined && parseCliCredential(input) === null) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    return input;
}

function integer(input: unknown, maximum: number): number {
    if (
        typeof input !== 'number' ||
        !Number.isSafeInteger(input) ||
        input < 0 ||
        input > maximum ||
        Object.is(input, -0)
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return input;
}

function string(input: unknown, maximum: number): string {
    if (typeof input !== 'string' || !input.isWellFormed() || Buffer.byteLength(input) > maximum) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return input;
}

function entry(input: unknown): ArtifactFileEntryV1 {
    try {
        return decodeArtifactFileEntry(input);
    } catch {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}

function comparePath(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function pathsConflict(entries: ReadonlyArray<ArtifactFileEntryV1>): boolean {
    const exact = new Set<string>();
    const folded = new Set<string>();
    for (const value of entries) {
        const key = value.path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
        if (exact.has(value.path) || folded.has(key)) {
            return true;
        }
        exact.add(value.path);
        folded.add(key);
    }
    return entries.some((value) => {
        const segments = value.path.split('/');
        return segments.some((_segment, index) => index > 0 && exact.has(segments.slice(0, index).join('/')));
    });
}

function page(input: unknown): ArtifactFilePageV1 {
    const value = exactRecord(input, ['entries', 'fileCount', 'indexSha256', 'nextCursor', 'pageOrdinal', 'schema']);
    if (own(value, 'schema') !== 'erden.artifact-file-page/v1') {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const rawEntries = own(value, 'entries');
    if (!Array.isArray(rawEntries) || rawEntries.length > ARTIFACT_FILE_LIMITS.fixedPageItems) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const entries = rawEntries.map(entry);
    if (entries.some((value, index) => index > 0 && comparePath(entries[index - 1]?.path ?? '', value.path) >= 0)) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    if (pathsConflict(entries)) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const indexSha256 = string(own(value, 'indexSha256'), 64);
    const nextCursorValue = own(value, 'nextCursor');
    const nextCursor = nextCursorValue === null ? null : string(nextCursorValue, ARTIFACT_FILE_LIMITS.maxCursorBytes);
    if (!SHA256.test(indexSha256) || (nextCursor !== null && !/^[A-Za-z0-9_.-]+$/u.test(nextCursor))) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const fileCount = integer(own(value, 'fileCount'), ARTIFACT_FILE_LIMITS.maxEntries);
    const pageOrdinal = integer(own(value, 'pageOrdinal'), ARTIFACT_FILE_LIMITS.maxEntries);
    if (
        fileCount < entries.length ||
        pageOrdinal * ARTIFACT_FILE_LIMITS.fixedPageItems > fileCount ||
        (nextCursor !== null && entries.length !== ARTIFACT_FILE_LIMITS.fixedPageItems)
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return Object.freeze({
        entries: Object.freeze(entries),
        fileCount,
        indexSha256,
        nextCursor,
        pageOrdinal,
        schema: 'erden.artifact-file-page/v1',
    });
}

function renderer(input: unknown): ArtifactRendererSelection {
    const generic = exactRecord(
        input,
        Object.prototype.hasOwnProperty.call(input, 'profile')
            ? ['kind', 'profile', 'sourceByteSize']
            : ['kind', 'reason'],
    );
    if (own(generic, 'kind') === 'fallback') {
        const reason = own(generic, 'reason');
        if (reason !== 'media-mismatch' && reason !== 'size-limit' && reason !== 'unsupported') {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        return Object.freeze({ kind: 'fallback', reason });
    }
    const profile = own(generic, 'profile');
    if (own(generic, 'kind') !== 'preview' || typeof profile !== 'string' || !rendererProfiles.has(profile)) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return Object.freeze({
        kind: 'preview',
        profile: profile as Extract<ArtifactRendererSelection, { kind: 'preview' }>['profile'],
        sourceByteSize: integer(own(generic, 'sourceByteSize'), ARTIFACT_FILE_LIMITS.maxFileBytes),
    });
}

function file(input: unknown): RegistryArtifactFile {
    const value = exactRecord(input, [
        'byteSize',
        'mediaSignature',
        'path',
        'previewBase64',
        'raw',
        'renderer',
        'schema',
        'sha256',
        'validator',
    ]);
    if (own(value, 'schema') !== 'erden.registry-artifact-file/v1') {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const base = entry({ byteSize: own(value, 'byteSize'), path: own(value, 'path'), sha256: own(value, 'sha256') });
    const signature = own(value, 'mediaSignature');
    const validator = string(own(value, 'validator'), 66);
    const previewBase64 = string(
        own(value, 'previewBase64'),
        Math.ceil((ARTIFACT_FILE_LIMITS.maxPreviewBytes * 4) / 3) + 4,
    );
    if (
        typeof signature !== 'string' ||
        !mediaSignatures.has(signature as ArtifactMediaSignature) ||
        !VALIDATOR.test(validator) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(previewBase64)
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const previewBytes = Buffer.from(previewBase64, 'base64');
    if (previewBytes.byteLength > ARTIFACT_FILE_LIMITS.maxPreviewBytes || previewBytes.byteLength > base.byteSize) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    if (
        previewBytes.byteLength === base.byteSize &&
        createHash('sha256').update(previewBytes).digest('hex') !== base.sha256
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const rawValue = exactRecord(own(value, 'raw'), ['expiresAt', 'headUrl', 'url']);
    const rawUrl = string(own(rawValue, 'url'), 4096);
    const headUrl = string(own(rawValue, 'headUrl'), 4096);
    let parsed: URL;
    let parsedHead: URL;
    try {
        parsed = new URL(rawUrl);
        parsedHead = new URL(headUrl);
    } catch {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const loopback =
        parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname.toLowerCase());
    if (
        (parsed.protocol !== 'https:' && !loopback) ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.hash !== '' ||
        parsedHead.origin !== parsed.origin ||
        parsedHead.pathname !== parsed.pathname ||
        parsedHead.username !== '' ||
        parsedHead.password !== '' ||
        parsedHead.hash !== ''
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const expiresAtValue = own(rawValue, 'expiresAt');
    const expiresAt = expiresAtValue === null ? null : integer(expiresAtValue, Number.MAX_SAFE_INTEGER);
    return Object.freeze({
        ...base,
        mediaSignature: signature as ArtifactMediaSignature,
        previewBytes: Uint8Array.from(previewBytes),
        raw: Object.freeze({ expiresAt, headUrl, url: rawUrl }),
        renderer: renderer(own(value, 'renderer')),
        schema: 'erden.registry-artifact-file/v1',
        validator,
    });
}

function registryError(status: number, body: unknown): never {
    const value = exactRecord(body, ['code']);
    const code = own(value, 'code');
    const expected =
        status === 400
            ? 'REGISTRY_INVALID_REQUEST'
            : status === 404
              ? 'REGISTRY_NOT_FOUND'
              : status === 409
                ? 'REGISTRY_CONFLICT'
                : status === 503
                  ? 'REGISTRY_UNAVAILABLE'
                  : null;
    if (code !== expected) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    throw new RegistryClientError(
        status === 400
            ? 'CLIENT_INPUT_INVALID'
            : status === 404
              ? 'CLIENT_NOT_FOUND'
              : status === 409
                ? 'CLIENT_CONFLICT'
                : 'CLIENT_RETRYABLE',
    );
}

async function request<Value>(
    registryOrigin: string,
    path: string,
    credential: string | undefined,
    signal: AbortSignal | undefined,
    maximum: number,
    decode: (input: unknown) => Value,
    runtime?: RegistryHttpRuntime,
): Promise<Value> {
    return retryRegistryTransport(
        async () => {
            const response = await requestRegistryJsonWire(
                {
                    registryOrigin,
                    path,
                    method: 'GET',
                    ...(credential === undefined ? {} : { bearer: credential }),
                    ...(signal === undefined ? {} : { signal }),
                    maximumResponseBytes: maximum,
                },
                runtime,
            );
            if (response.status !== 200) {
                return registryError(response.status, response.body);
            }
            authenticateRegistryJsonHeaders(
                response.headers,
                response.bytes,
                credential === undefined ? 'public' : 'private',
            );
            return decode(response.body);
        },
        runtime,
        signal,
    );
}

export async function listRegistryArtifactFiles(
    input: ListRegistryArtifactFilesRequest,
    runtime?: RegistryHttpRuntime,
): Promise<ArtifactFilePageV1> {
    const registryOrigin = origin(input.registryOrigin);
    const credential = bearer(input.bearer);
    let decoded;
    try {
        decoded = decodeListArtifactFilesInput({
            canonicalIri: input.canonicalIri,
            cursor: input.cursor ?? null,
            registryOrigin,
            version: input.version,
        });
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const query = new URLSearchParams([['canonicalIri', decoded.canonicalIri]]);
    if (decoded.cursor !== null) {
        query.append('cursor', decoded.cursor);
    }
    return request(
        registryOrigin,
        `/api/v1/registry/releases/${encodeURIComponent(decoded.version)}/files?${query.toString()}`,
        credential,
        input.signal,
        128 * 1024,
        page,
        runtime,
    );
}

export async function getRegistryArtifactFile(
    input: GetRegistryArtifactFileRequest,
    runtime?: RegistryHttpRuntime,
): Promise<RegistryArtifactFile> {
    const registryOrigin = origin(input.registryOrigin);
    const credential = bearer(input.bearer);
    let decoded;
    try {
        decoded = decodeGetArtifactFileInput({
            canonicalIri: input.canonicalIri,
            ifNoneMatch: null,
            path: input.path,
            registryOrigin,
            version: input.version,
        });
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const query = new URLSearchParams([['canonicalIri', decoded.canonicalIri]]).toString();
    const result = await request(
        registryOrigin,
        `/api/v1/registry/releases/${encodeURIComponent(decoded.version)}/files/${decoded.path.split('/').map(encodeURIComponent).join('/')}?${query}`,
        credential,
        input.signal,
        14 * 1024 * 1024,
        file,
        runtime,
    );
    if (result.path !== decoded.path) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const raw = new URL(result.raw.url);
    const head = new URL(result.raw.headUrl);
    const expectedPath = `/raw/v1/releases/${encodeURIComponent(decoded.version)}/files/${decoded.path.split('/').map(encodeURIComponent).join('/')}`;
    const token = raw.searchParams.get('token');
    const expectedQuery = new URLSearchParams([['canonicalIri', decoded.canonicalIri]]);
    if (token !== null) {
        expectedQuery.append('token', token);
    }
    if (
        raw.pathname !== expectedPath ||
        head.origin !== raw.origin ||
        head.pathname !== expectedPath ||
        raw.search !== `?${expectedQuery.toString()}` ||
        (token === null) !== (result.raw.expiresAt === null) ||
        (token !== null && !/^[A-Za-z0-9_.-]{16,1900}$/u.test(token)) ||
        (result.raw.expiresAt === null
            ? head.search !== raw.search
            : !/^[A-Za-z0-9_.-]{16,1900}$/u.test(head.searchParams.get('token') ?? '') ||
              head.searchParams.get('canonicalIri') !== decoded.canonicalIri)
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return result;
}
