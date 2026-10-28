import {
    RELEASE_QUERY_LIMITS,
    decodeGetExactRegistryReleaseInput,
    decodeReleaseQueryErrorBody,
    decodeReleaseQueryResultEnvelope,
    normalizeRegistryOrigin,
    parseCliCredential,
    type ReleaseQueryErrorBodyV1,
    type ReleaseQueryResultEnvelopeV1,
} from '@erden/contracts';

import {
    cancelRegistryResponseBody,
    openRegistryHttpResponse,
    readRegistryResponseBody,
    type RegistryHttpRuntime,
} from './http.js';
import { RegistryClientError, decodeCanonicalJson } from './wire.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const ENVELOPE_TYPE = 'application/vnd.erden.release-query+json';
const QUERY_TIMEOUT_MILLISECONDS = 60_000;
const MAXIMUM_ENVELOPE_BYTES = RELEASE_QUERY_LIMITS.maxResultBytes + 64 * 1_024;
const MAXIMUM_ERROR_BYTES = 64 * 1_024;
const PRIVATE_CACHE = 'private, no-store, no-transform';
const VARY = 'Accept, Authorization, Cookie, Origin';

export interface QueryRegistryReleaseRequest {
    readonly registryOrigin: string;
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
    /** Exact UTF-8 query bytes; never logged, never placed in a URL. */
    readonly query: Uint8Array;
    readonly bearer?: string;
    readonly signal?: AbortSignal;
}

/** A refusal the registry disclosed with a closed code; everything else throws a closed client error. */
export type RegistryReleaseQueryRefusal = Readonly<{
    kind: 'refused';
    status: 404 | 409 | 413 | 422 | 503;
    code: ReleaseQueryErrorBodyV1['code'];
    reason: ReleaseQueryErrorBodyV1['reason'];
}>;

export type RegistryReleaseQueryOutcome =
    | Readonly<{ kind: 'complete'; envelope: ReleaseQueryResultEnvelopeV1; bytes: Uint8Array }>
    | RegistryReleaseQueryRefusal;

const REFUSALS: Readonly<Record<number, ReadonlyArray<ReleaseQueryErrorBodyV1['code']>>> = Object.freeze({
    404: ['RELEASE_QUERY_NOT_FOUND'],
    409: ['RELEASE_QUERY_DATASET_UNAVAILABLE'],
    413: ['RELEASE_QUERY_TOO_LARGE'],
    422: ['RELEASE_QUERY_REJECTED', 'RELEASE_QUERY_LIMIT_EXCEEDED'],
    503: ['RELEASE_QUERY_BUSY', 'RELEASE_QUERY_UNAVAILABLE'],
});

function input(raw: QueryRegistryReleaseRequest): QueryRegistryReleaseRequest {
    try {
        const registryOrigin = normalizeRegistryOrigin(raw.registryOrigin);
        const exact = decodeGetExactRegistryReleaseInput({
            registryOrigin,
            canonicalIri: raw.canonicalIri,
            version: raw.version,
        });
        if (
            registryOrigin !== raw.registryOrigin ||
            exact.canonicalIri !== raw.canonicalIri ||
            exact.version !== raw.version ||
            typeof raw.archiveSha256 !== 'string' ||
            !SHA256.test(raw.archiveSha256) ||
            !(raw.query instanceof Uint8Array) ||
            (raw.bearer !== undefined && parseCliCredential(raw.bearer) === null)
        ) {
            throw new Error();
        }
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (raw.query.byteLength < 1) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (raw.query.byteLength > RELEASE_QUERY_LIMITS.maxQueryBytes) {
        throw new RegistryClientError('CLIENT_TOO_LARGE');
    }
    return raw;
}

function authenticateHeaders(headers: Headers, contentType: string, bytes: Uint8Array): void {
    const length = headers.get('content-length');
    if (
        headers.get('content-type') !== contentType ||
        headers.get('cache-control') !== PRIVATE_CACHE ||
        headers.get('vary') !== VARY ||
        headers.get('x-content-type-options') !== 'nosniff' ||
        headers.has('content-encoding') ||
        headers.has('etag') ||
        headers.has('last-modified') ||
        headers.has('location') ||
        headers.has('set-cookie') ||
        headers.has('access-control-allow-origin') ||
        (length !== null && length !== String(bytes.byteLength))
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}

function sameRelease(envelope: ReleaseQueryResultEnvelopeV1, request: QueryRegistryReleaseRequest): boolean {
    const release = envelope.binding.release;
    return (
        release.registryOrigin === request.registryOrigin &&
        release.canonicalIri === request.canonicalIri &&
        release.version === request.version &&
        release.archiveSha256 === request.archiveSha256
    );
}

async function refusal(response: Response, signal: AbortSignal): Promise<RegistryReleaseQueryRefusal> {
    if (response.headers.get('content-type') !== 'application/json; charset=utf-8') {
        await cancelRegistryResponseBody(response);
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const bytes = await readRegistryResponseBody(response, MAXIMUM_ERROR_BYTES, signal);
    let body: ReleaseQueryErrorBodyV1;
    try {
        body = decodeReleaseQueryErrorBody(decodeCanonicalJson(bytes));
    } catch {
        // A registry without release queries answers its fixed endpoint not-found.
        throw new RegistryClientError(response.status === 404 ? 'CLIENT_NOT_FOUND' : 'CLIENT_RESPONSE_INVALID');
    }
    authenticateHeaders(response.headers, 'application/json; charset=utf-8', bytes);
    const status = response.status;
    if (status === 400 && body.code === 'RELEASE_QUERY_INVALID_REQUEST') {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (status === 401 && body.code === 'RELEASE_QUERY_UNAUTHORIZED') {
        throw new RegistryClientError('CLIENT_UNAUTHORIZED');
    }
    if (
        (status === 404 || status === 409 || status === 413 || status === 422 || status === 503) &&
        REFUSALS[status]?.includes(body.code) === true
    ) {
        return Object.freeze({ kind: 'refused', status, code: body.code, reason: body.reason });
    }
    throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
}

/**
 * Run one bounded query against one exact release. The query text travels only as the POST body, redirects are
 * refused, and only the Erden envelope is accepted, so the result is bound to the requested release. Queries are
 * never retried: a busy registry reports so instead of receiving repeated work.
 */
export async function queryRegistryRelease(
    raw: QueryRegistryReleaseRequest,
    runtime?: RegistryHttpRuntime,
): Promise<RegistryReleaseQueryOutcome> {
    const request = input(raw);
    const search = new URLSearchParams([
        ['canonicalIri', request.canonicalIri],
        ['archiveSha256', request.archiveSha256],
    ]).toString();
    const opened = await openRegistryHttpResponse(
        {
            registryOrigin: request.registryOrigin,
            path: `/api/v1/registry/releases/${encodeURIComponent(request.version)}/query?${search}`,
            method: 'POST',
            headers: {
                accept: ENVELOPE_TYPE,
                'content-type': 'application/sparql-query',
                'content-length': String(request.query.byteLength),
                ...(request.bearer === undefined ? {} : { authorization: `Bearer ${request.bearer}` }),
            },
            body: new Blob([Uint8Array.from(request.query)]),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            timeoutMilliseconds: QUERY_TIMEOUT_MILLISECONDS,
        },
        runtime,
    );
    try {
        if (opened.response.status !== 200) {
            return await refusal(opened.response, opened.signal);
        }
        if (opened.response.headers.get('content-type') !== `${ENVELOPE_TYPE}; charset=utf-8`) {
            await cancelRegistryResponseBody(opened.response);
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        const bytes = await readRegistryResponseBody(opened.response, MAXIMUM_ENVELOPE_BYTES, opened.signal);
        authenticateHeaders(opened.response.headers, `${ENVELOPE_TYPE}; charset=utf-8`, bytes);
        let envelope: ReleaseQueryResultEnvelopeV1;
        try {
            envelope = decodeReleaseQueryResultEnvelope(decodeCanonicalJson(bytes));
        } catch {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        if (!sameRelease(envelope, request)) {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        return Object.freeze({ kind: 'complete', envelope, bytes });
    } catch (error) {
        if (opened.signal.aborted) {
            throw opened.signal.reason instanceof RegistryClientError
                ? opened.signal.reason
                : new RegistryClientError('CLIENT_ABORTED');
        }
        if (error instanceof RegistryClientError) {
            throw error;
        }
        throw new RegistryClientError('CLIENT_TRANSPORT');
    } finally {
        opened.finish();
    }
}
