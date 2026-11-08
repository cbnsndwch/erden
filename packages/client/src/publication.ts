import { createHash } from 'node:crypto';

import {
    PUBLICATION_LIMITS,
    PUBLICATION_QUERY_LIMITS,
    decodePublicationAttemptView,
    decodePublicationOpaqueId,
    decodePublicationReportSummary,
    decodePublicationUploadGrant,
    decodePublicationUploadRequest,
    normalizeRegistryOrigin,
    parseCliCredential,
    type PublicationAttemptView,
    type PublicationReportSummaryV1,
    type PublicationSignedPut,
    type PublicationUploadGrant,
    type PublicationUploadRequest,
} from '@erden/contracts';

import {
    putToSignedUrl,
    requestRegistryJsonWire,
    retryRegistryTransport,
    type RegistryHttpRuntime,
    type RegistryJsonWireResponse,
} from './http.js';
import { RegistryClientError, authenticateRegistryJsonHeaders, exactRecord } from './wire.js';

const SIGNED_PUT_IDLE_MILLISECONDS = 120_000;

export interface PublicationUploadInput {
    readonly registryOrigin: string;
    readonly bearer: string;
    readonly create: false | 'private' | 'public';
    readonly idempotencyKey: string;
    readonly archiveSha256: string;
    readonly byteSize: number;
    readonly canonicalIri: string;
    readonly preferredAlias: string;
    readonly version: string;
    readonly open: () => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;
    readonly signal?: AbortSignal;
}

export interface PublicationReadInput {
    readonly registryOrigin: string;
    readonly attemptId: string;
    readonly bearer?: string;
    readonly signal?: AbortSignal;
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

function canonicalBearer(input: string | undefined, required: boolean): string | undefined {
    if (input === undefined) {
        if (required) {
            throw new RegistryClientError('CLIENT_INPUT_INVALID');
        }
        return undefined;
    }
    if (parseCliCredential(input) === null) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    return input;
}

function canonicalAttemptId(input: string): string {
    try {
        return decodePublicationOpaqueId(input);
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
}

function publicationError(response: RegistryJsonWireResponse): never {
    authenticateRegistryJsonHeaders(response.headers, response.bytes, 'no-store');
    const record = exactRecord(response.body, ['code']);
    const code = own(record, 'code');
    const expected =
        response.status === 400
            ? 'PUBLICATION_INVALID_REQUEST'
            : response.status === 401
              ? 'PUBLICATION_UNAUTHORIZED'
              : response.status === 404
                ? 'PUBLICATION_NOT_FOUND'
                : response.status === 409
                  ? 'PUBLICATION_CONFLICT'
                  : response.status === 413
                    ? 'PUBLICATION_TOO_LARGE'
                    : response.status === 503
                      ? 'PUBLICATION_UNAVAILABLE'
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
    if (response.status === 413) {
        throw new RegistryClientError('CLIENT_TOO_LARGE');
    }
    throw new RegistryClientError('CLIENT_RETRYABLE');
}

interface UploadBody {
    readonly stream: ReadableStream<Uint8Array>;
    readonly close: () => Promise<void>;
    readonly settled: () => Promise<void>;
    readonly completed: () => boolean;
    readonly failure: () => RegistryClientError | undefined;
}

async function uploadBody(
    factory: PublicationUploadInput['open'],
    byteSize: number,
    digest: string,
): Promise<UploadBody> {
    let iterable: AsyncIterable<Uint8Array>;
    try {
        iterable = await factory();
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    let iterator: AsyncIterator<Uint8Array>;
    try {
        const open: unknown = iterable[Symbol.asyncIterator];
        if (typeof open !== 'function') {
            throw new Error();
        }
        iterator = Reflect.apply(open, iterable, []) as AsyncIterator<Uint8Array>;
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const hash = createHash('sha256');
    let count = 0;
    let complete = false;
    let closed = false;
    let sourceFailure: RegistryClientError | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
        settle = resolve;
    });
    let closing: Promise<void> | undefined;
    function close(): Promise<void> {
        closing ??= (async () => {
            if (!closed) {
                closed = true;
                try {
                    await iterator.return?.();
                } catch {
                    sourceFailure ??= new RegistryClientError('CLIENT_INPUT_INVALID');
                }
            }
            settle();
        })();
        return closing;
    }
    const stream = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
            try {
                const next = await iterator.next();
                if (next.done) {
                    complete = true;
                    closed = true;
                    if (count !== byteSize || hash.digest('hex') !== digest) {
                        sourceFailure = new RegistryClientError('CLIENT_INPUT_INVALID');
                        controller.error(sourceFailure);
                    } else {
                        controller.close();
                    }
                    settle();
                    return;
                }
                if (!(next.value instanceof Uint8Array)) {
                    throw new RegistryClientError('CLIENT_INPUT_INVALID');
                }
                const chunk = Uint8Array.from(next.value);
                count += chunk.byteLength;
                if (!Number.isSafeInteger(count) || count > byteSize) {
                    throw new RegistryClientError('CLIENT_INPUT_INVALID');
                }
                hash.update(chunk);
                controller.enqueue(chunk);
            } catch (error) {
                sourceFailure =
                    error instanceof RegistryClientError ? error : new RegistryClientError('CLIENT_INPUT_INVALID');
                controller.error(sourceFailure);
                await close();
            }
        },
        cancel: async () => {
            await close();
        },
    });
    return Object.freeze({
        stream,
        close,
        settled: async () => {
            await settled;
        },
        completed: () => complete,
        failure: () => sourceFailure,
    });
}

/** The registry signs for what this client declared, and only an origin as protected as its own may receive the bytes. */
function checkSignedPut(put: PublicationSignedPut, registryOrigin: string, request: PublicationUploadRequest): void {
    if (
        (registryOrigin.startsWith('https:') && !put.url.startsWith('https:')) ||
        put.headers['content-length'] !== String(request.byteSize) ||
        put.headers['x-amz-checksum-sha256'] !== Buffer.from(request.archiveSha256, 'hex').toString('base64')
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}

async function startUpload(
    input: PublicationUploadInput,
    registryOrigin: string,
    bearer: string,
    create: string,
    request: PublicationUploadRequest,
    runtime?: RegistryHttpRuntime,
): Promise<PublicationUploadGrant> {
    const response = await requestRegistryJsonWire(
        {
            registryOrigin,
            path: `/api/v1/publications/uploads?create=${create}`,
            method: 'POST',
            body: request,
            bearer,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        runtime,
    );
    if (response.status !== 201) {
        return publicationError(response);
    }
    authenticateRegistryJsonHeaders(response.headers, response.bytes, 'no-store');
    let grant: PublicationUploadGrant;
    try {
        grant = decodePublicationUploadGrant(response.body);
    } catch {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    if (grant.put !== null) {
        checkSignedPut(grant.put, registryOrigin, request);
    }
    return grant;
}

async function sendArchive(input: PublicationUploadInput, put: PublicationSignedPut, runtime?: RegistryHttpRuntime) {
    const body = await uploadBody(input.open, input.byteSize, input.archiveSha256);
    try {
        const outcome = await putToSignedUrl(
            {
                url: put.url,
                headers: put.headers,
                body: body.stream,
                idleTimeoutMilliseconds: SIGNED_PUT_IDLE_MILLISECONDS,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
            },
            runtime,
        );
        if (outcome === 'stored') {
            await body.settled();
            if (!body.completed() || body.failure() !== undefined) {
                throw body.failure() ?? new RegistryClientError('CLIENT_INPUT_INVALID');
            }
        }
    } catch (error) {
        const failure = body.failure();
        if (failure !== undefined) {
            throw failure;
        }
        throw error;
    } finally {
        await body.close();
    }
}

async function finalizeUpload(
    input: PublicationUploadInput,
    registryOrigin: string,
    bearer: string,
    uploadId: string,
    runtime?: RegistryHttpRuntime,
): Promise<PublicationAttemptView> {
    const response = await requestRegistryJsonWire(
        {
            registryOrigin,
            path: `/api/v1/publications/uploads/${encodeURIComponent(uploadId)}/finalize`,
            method: 'POST',
            bearer,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            maximumResponseBytes: PUBLICATION_QUERY_LIMITS.maxStatusBytes,
        },
        runtime,
    );
    if (response.status !== 202) {
        return publicationError(response);
    }
    authenticateRegistryJsonHeaders(response.headers, response.bytes, 'no-store');
    try {
        const attempt = decodePublicationAttemptView(response.body);
        if (attempt.attemptId !== uploadId) {
            throw new Error();
        }
        return attempt;
    } catch {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}

/**
 * Publishes an archive in three steps: ask the registry to start an upload, send the bytes directly to the storage URL
 * it signs, then finalize. Starting and finalizing both repeat safely under the same idempotency key, so a retry after
 * an expired URL or a lost connection starts over from a fresh URL. The registry verifies everything after finalize;
 * what it finds arrives through the attempt this returns and later polls of it.
 */
export async function uploadPublication(
    input: PublicationUploadInput,
    runtime?: RegistryHttpRuntime,
): Promise<PublicationAttemptView> {
    const registryOrigin = canonicalOrigin(input.registryOrigin);
    const bearer = canonicalBearer(input.bearer, true);
    const rawCreate: unknown = input.create;
    let request: PublicationUploadRequest;
    try {
        request = decodePublicationUploadRequest({
            archiveSha256: input.archiveSha256,
            byteSize: input.byteSize,
            canonicalIri: input.canonicalIri,
            idempotencyKey: input.idempotencyKey,
            preferredAlias: input.preferredAlias,
            version: input.version,
        });
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (
        (rawCreate !== false && rawCreate !== 'private' && rawCreate !== 'public') ||
        request.byteSize > PUBLICATION_LIMITS.maxCandidateBytes ||
        typeof input.open !== 'function' ||
        bearer === undefined
    ) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const create = input.create === false ? 'false' : input.create;
    const uploadId = await retryRegistryTransport(
        async () => {
            const grant = await startUpload(input, registryOrigin, bearer, create, request, runtime);
            if (grant.put !== null) {
                await sendArchive(input, grant.put, runtime);
            }
            return grant.uploadId;
        },
        runtime,
        input.signal,
    );
    return await retryRegistryTransport(
        async () => await finalizeUpload(input, registryOrigin, bearer, uploadId, runtime),
        runtime,
        input.signal,
    );
}

async function readPublicationJson<Value>(
    input: PublicationReadInput,
    suffix: '' | '/report',
    maximumResponseBytes: number,
    decode: (body: unknown) => Value,
    runtime?: RegistryHttpRuntime,
): Promise<Value> {
    const registryOrigin = canonicalOrigin(input.registryOrigin);
    const attemptId = canonicalAttemptId(input.attemptId);
    const bearer = canonicalBearer(input.bearer, false);
    return await retryRegistryTransport(
        async () => {
            const response = await requestRegistryJsonWire(
                {
                    registryOrigin,
                    path: `/api/v1/publications/${encodeURIComponent(attemptId)}${suffix}`,
                    method: 'GET',
                    ...(bearer === undefined ? {} : { bearer }),
                    ...(input.signal === undefined ? {} : { signal: input.signal }),
                    maximumResponseBytes,
                },
                runtime,
            );
            if (response.status !== 200) {
                return publicationError(response);
            }
            authenticateRegistryJsonHeaders(response.headers, response.bytes, 'private');
            let value: Value;
            try {
                value = decode(response.body);
            } catch {
                throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
            }
            if (
                (
                    value as {
                        readonly attemptId?: unknown;
                    }
                ).attemptId !== attemptId
            ) {
                throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
            }
            return value;
        },
        runtime,
        input.signal,
    );
}

export async function getPublicationAttempt(
    input: PublicationReadInput,
    runtime?: RegistryHttpRuntime,
): Promise<PublicationAttemptView> {
    return await readPublicationJson(
        input,
        '',
        PUBLICATION_QUERY_LIMITS.maxStatusBytes,
        decodePublicationAttemptView,
        runtime,
    );
}

export async function getPublicationReport(
    input: PublicationReadInput,
    runtime?: RegistryHttpRuntime,
): Promise<PublicationReportSummaryV1> {
    return await readPublicationJson(
        input,
        '/report',
        PUBLICATION_QUERY_LIMITS.maxReportSummaryBytes,
        decodePublicationReportSummary,
        runtime,
    );
}
