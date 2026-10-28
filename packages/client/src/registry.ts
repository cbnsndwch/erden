import { createHash } from 'node:crypto';

import {
    PUBLICATION_LIMITS,
    REGISTRY_RELEASE_INDEX_LIMITS,
    decodeGetExactRegistryReleaseInput,
    decodeListRegistryReleasesInput,
    decodeRegistryAliasResolution,
    decodeRegistryReleaseIndexEntry,
    decodeRegistryReleaseIndexPage,
    decodeResolveRegistryAliasInput,
    normalizeRegistryOrigin,
    parseCliCredential,
    type RegistryAliasResolutionV1,
    type RegistryReleaseIndexEntryV1,
    type RegistryReleaseIndexPageV1,
} from '@erden/contracts';

import {
    cancelRegistryResponseBody,
    openRegistryHttpResponse,
    readRegistryResponseBody,
    requestRegistryJsonWire,
    retryRegistryTransport,
    type RegistryHttpRuntime,
    type RegistryJsonWireResponse,
} from './http.js';
import { RegistryClientError, authenticateRegistryJsonHeaders, decodeCanonicalJson, exactRecord } from './wire.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const CONTENT_LENGTH = /^[1-9][0-9]*$/u;

interface RegistryReadBase {
    readonly registryOrigin: string;
    readonly bearer?: string;
    readonly signal?: AbortSignal;
}

export interface ResolveRegistryAliasRequest extends RegistryReadBase {
    readonly alias: string;
}

export interface ListRegistryReleasesRequest extends RegistryReadBase {
    readonly canonicalIri: string;
    readonly cursor?: string | null;
}

export interface GetExactRegistryReleaseRequest extends RegistryReadBase {
    readonly canonicalIri: string;
    readonly version: string;
}

export interface OpenRegistryArchiveRequest extends GetExactRegistryReleaseRequest {
    readonly archiveSha256: string;
}

export interface RegistryArchiveReadLease {
    readonly sha256: string;
    readonly byteSize: number;
    readonly bytes: AsyncIterable<Uint8Array>;
    readonly close: () => Promise<void>;
}

function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function canonicalOrigin(input: string): string {
    try {
        const value = normalizeRegistryOrigin(input);
        if (value !== input) {
            throw new Error();
        }
        return value;
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
}

function canonicalBearer(input: string | undefined): string | undefined {
    if (input !== undefined && parseCliCredential(input) === null) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    return input;
}

function registryError(response: RegistryJsonWireResponse): never {
    authenticateRegistryJsonHeaders(response.headers, response.bytes, 'no-store');
    const record = exactRecord(response.body, ['code']);
    const code = own(record, 'code');
    const expected =
        response.status === 400
            ? 'REGISTRY_INVALID_REQUEST'
            : response.status === 401
              ? 'REGISTRY_UNAUTHORIZED'
              : response.status === 404
                ? 'REGISTRY_NOT_FOUND'
                : response.status === 409
                  ? 'REGISTRY_CONFLICT'
                  : response.status === 503
                    ? 'REGISTRY_UNAVAILABLE'
                    : null;
    if (expected === null || code !== expected) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    if (response.status === 400) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (response.status === 401) {
        throw new RegistryClientError('CLIENT_UNAUTHORIZED');
    }
    if (response.status === 404) {
        throw new RegistryClientError('CLIENT_NOT_FOUND');
    }
    if (response.status === 409) {
        throw new RegistryClientError('CLIENT_CONFLICT');
    }
    throw new RegistryClientError('CLIENT_RETRYABLE');
}

async function metadata<Value>(
    registryOrigin: string,
    path: string,
    bearer: string | undefined,
    signal: AbortSignal | undefined,
    maximumResponseBytes: number,
    decode: (input: unknown) => Value,
    runtime?: RegistryHttpRuntime,
): Promise<Value> {
    return await retryRegistryTransport(
        async () => {
            const response = await requestRegistryJsonWire(
                {
                    registryOrigin,
                    path,
                    method: 'GET',
                    ...(bearer === undefined ? {} : { bearer }),
                    ...(signal === undefined ? {} : { signal }),
                    maximumResponseBytes,
                },
                runtime,
            );
            if (response.status !== 200) {
                return registryError(response);
            }
            authenticateRegistryJsonHeaders(
                response.headers,
                response.bytes,
                bearer === undefined ? 'public' : 'private',
            );
            try {
                return decode(response.body);
            } catch {
                throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
            }
        },
        runtime,
        signal,
    );
}

export async function resolveRegistryAlias(
    input: ResolveRegistryAliasRequest,
    runtime?: RegistryHttpRuntime,
): Promise<RegistryAliasResolutionV1> {
    const registryOrigin = canonicalOrigin(input.registryOrigin);
    const bearer = canonicalBearer(input.bearer);
    let request;
    try {
        request = decodeResolveRegistryAliasInput({ registryOrigin, alias: input.alias });
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const query = new URLSearchParams([['alias', request.alias]]).toString();
    const result = await metadata(
        registryOrigin,
        `/api/v1/registry/aliases?${query}`,
        bearer,
        input.signal,
        REGISTRY_RELEASE_INDEX_LIMITS.maxEnvelopeEncodedBytes,
        decodeRegistryAliasResolution,
        runtime,
    );
    if (result.registryOrigin !== registryOrigin || result.alias !== request.alias) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return result;
}

export async function listRegistryReleases(
    input: ListRegistryReleasesRequest,
    runtime?: RegistryHttpRuntime,
): Promise<RegistryReleaseIndexPageV1> {
    const registryOrigin = canonicalOrigin(input.registryOrigin);
    const bearer = canonicalBearer(input.bearer);
    let request;
    try {
        request = decodeListRegistryReleasesInput({
            registryOrigin,
            canonicalIri: input.canonicalIri,
            cursor: input.cursor ?? null,
        });
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const query = new URLSearchParams([['canonicalIri', request.canonicalIri]]);
    if (request.cursor !== null) {
        query.append('cursor', request.cursor);
    }
    const result = await metadata(
        registryOrigin,
        `/api/v1/registry/releases?${query.toString()}`,
        bearer,
        input.signal,
        REGISTRY_RELEASE_INDEX_LIMITS.maxPageEncodedBytes,
        decodeRegistryReleaseIndexPage,
        runtime,
    );
    if (result.registryOrigin !== registryOrigin || result.canonicalIri !== request.canonicalIri) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return result;
}

export async function getExactRegistryRelease(
    input: GetExactRegistryReleaseRequest,
    runtime?: RegistryHttpRuntime,
): Promise<RegistryReleaseIndexEntryV1> {
    const registryOrigin = canonicalOrigin(input.registryOrigin);
    const bearer = canonicalBearer(input.bearer);
    let request;
    try {
        request = decodeGetExactRegistryReleaseInput({
            registryOrigin,
            canonicalIri: input.canonicalIri,
            version: input.version,
        });
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const query = new URLSearchParams([['canonicalIri', request.canonicalIri]]).toString();
    const result = await metadata(
        registryOrigin,
        `/api/v1/registry/releases/${encodeURIComponent(request.version)}?${query}`,
        bearer,
        input.signal,
        REGISTRY_RELEASE_INDEX_LIMITS.maxExactEncodedBytes,
        decodeRegistryReleaseIndexEntry,
        runtime,
    );
    if (
        result.registryOrigin !== registryOrigin ||
        result.canonicalIri !== request.canonicalIri ||
        result.release.version !== request.version
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return result;
}

async function archiveError(response: Response, signal: AbortSignal): Promise<never> {
    if (response.headers.get('content-type') !== 'application/json; charset=utf-8') {
        await cancelRegistryResponseBody(response);
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const bytes = await readRegistryResponseBody(response, 64 * 1024, signal);
    const wire: RegistryJsonWireResponse = Object.freeze({
        status: response.status,
        body: decodeCanonicalJson(bytes),
        bytes,
        headers: response.headers,
    });
    return registryError(wire);
}

function authenticateArchiveHeaders(headers: Headers, expectedSha256: string): number {
    const rawLength = headers.get('content-length');
    if (rawLength === null || !CONTENT_LENGTH.test(rawLength)) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const byteSize = Number(rawLength);
    if (
        !Number.isSafeInteger(byteSize) ||
        byteSize < 1 ||
        byteSize > PUBLICATION_LIMITS.maxCandidateBytes ||
        headers.get('content-type') !== 'application/vnd.erden.package.v1' ||
        headers.get('cache-control') !== 'private, no-store, no-transform' ||
        headers.get('x-content-type-options') !== 'nosniff' ||
        headers.get('x-erden-archive-sha256') !== expectedSha256 ||
        headers.get('etag') !== `"${expectedSha256}"` ||
        headers.has('accept-ranges') ||
        headers.has('content-disposition') ||
        headers.has('content-encoding') ||
        headers.has('content-range') ||
        headers.has('digest') ||
        headers.has('location') ||
        headers.has('set-cookie')
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return byteSize;
}

function archiveLease(
    opened: Awaited<ReturnType<typeof openRegistryHttpResponse>>,
    sha256: string,
    byteSize: number,
): RegistryArchiveReadLease {
    const body = opened.response.body;
    if (body === null) {
        opened.finish();
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const reader = body.getReader();
    const hash = createHash('sha256');
    let count = 0;
    let started = false;
    let complete = false;
    let closing: Promise<void> | undefined;
    function close(cancel: boolean): Promise<void> {
        closing ??= (async () => {
            opened.signal.removeEventListener('abort', abort);
            if (cancel) {
                try {
                    await reader.cancel();
                } catch {
                    /* Preserve the closed client error. */
                }
            }
            try {
                reader.releaseLock();
            } catch {
                /* The reader can already be released after a failed read. */
            }
            opened.finish();
        })();
        return closing;
    }
    function abort(): void {
        void close(true);
    }
    opened.signal.addEventListener('abort', abort, { once: true });
    if (opened.signal.aborted) {
        abort();
    }
    const bytes = Object.freeze({
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<Uint8Array> {
            if (started) {
                throw new RegistryClientError('CLIENT_INPUT_INVALID');
            }
            started = true;
            try {
                for (;;) {
                    if (opened.signal.aborted) {
                        throw new RegistryClientError('CLIENT_ABORTED');
                    }
                    const next = await reader.read();
                    if (next.done) {
                        break;
                    }
                    const chunk = Uint8Array.from(next.value);
                    count += chunk.byteLength;
                    if (!Number.isSafeInteger(count) || count > byteSize) {
                        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
                    }
                    hash.update(chunk);
                    yield chunk;
                }
                if (count !== byteSize || hash.digest('hex') !== sha256) {
                    throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
                }
                complete = true;
                await close(false);
            } catch (error) {
                await close(true);
                if (opened.signal.aborted) {
                    throw new RegistryClientError('CLIENT_ABORTED');
                }
                if (error instanceof RegistryClientError) {
                    throw error;
                }
                throw new RegistryClientError('CLIENT_TRANSPORT');
            } finally {
                if (!complete) {
                    await close(true);
                }
            }
        },
    });
    return Object.freeze({
        sha256,
        byteSize,
        bytes,
        close: async () => {
            await close(true);
        },
    });
}

export async function openRegistryArchive(
    input: OpenRegistryArchiveRequest,
    runtime?: RegistryHttpRuntime,
): Promise<RegistryArchiveReadLease> {
    const registryOrigin = canonicalOrigin(input.registryOrigin);
    const bearer = canonicalBearer(input.bearer);
    if (typeof input.archiveSha256 !== 'string' || !SHA256.test(input.archiveSha256)) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const exact = await getExactRegistryRelease(input, runtime);
    if (exact.release.archiveSha256 !== input.archiveSha256 || exact.release.version !== input.version) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const query = new URLSearchParams([['canonicalIri', exact.canonicalIri]]).toString();
    return await retryRegistryTransport(
        async () => {
            const opened = await openRegistryHttpResponse(
                {
                    registryOrigin,
                    path: `/api/v1/registry/releases/${encodeURIComponent(exact.release.version)}/archive?${query}`,
                    method: 'GET',
                    headers: {
                        accept: 'application/vnd.erden.package.v1',
                        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
                    },
                    ...(input.signal === undefined ? {} : { signal: input.signal }),
                    timeoutMilliseconds: 300000,
                },
                runtime,
            );
            if (opened.response.status !== 200) {
                try {
                    return await archiveError(opened.response, opened.signal);
                } finally {
                    opened.finish();
                }
            }
            try {
                const byteSize = authenticateArchiveHeaders(opened.response.headers, input.archiveSha256);
                return archiveLease(opened, input.archiveSha256, byteSize);
            } catch (error) {
                await cancelRegistryResponseBody(opened.response);
                opened.finish();
                throw error;
            }
        },
        runtime,
        input.signal,
    );
}
