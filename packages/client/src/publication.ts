import { createHash } from 'node:crypto';

import {
    PUBLICATION_LIMITS,
    PUBLICATION_QUERY_LIMITS,
    decodePublicationAttemptView,
    decodePublicationOpaqueId,
    decodePublicationReportSummary,
    normalizeRegistryOrigin,
    parseCliCredential,
    type PublicationAttemptView,
    type PublicationReportSummaryV1,
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
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const textEncoder = new TextEncoder();

export interface PublicationUploadInput {
    readonly registryOrigin: string;
    readonly bearer: string;
    readonly create: false | 'private' | 'public';
    readonly idempotencyKey: string;
    readonly archiveSha256: string;
    readonly byteSize: number;
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

async function decodeUploadResponse(response: Response, signal: AbortSignal): Promise<PublicationAttemptView> {
    if (response.headers.get('content-type') !== 'application/json; charset=utf-8') {
        await cancelRegistryResponseBody(response);
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const bytes = await readRegistryResponseBody(response, PUBLICATION_QUERY_LIMITS.maxStatusBytes, signal);
    const wire: RegistryJsonWireResponse = Object.freeze({
        status: response.status,
        body: decodeCanonicalJson(bytes),
        bytes,
        headers: response.headers,
    });
    if (response.status !== 202) {
        return publicationError(wire);
    }
    authenticateRegistryJsonHeaders(response.headers, bytes, 'no-store');
    try {
        return decodePublicationAttemptView(wire.body);
    } catch {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}

export async function uploadPublication(
    input: PublicationUploadInput,
    runtime?: RegistryHttpRuntime,
): Promise<PublicationAttemptView> {
    const registryOrigin = canonicalOrigin(input.registryOrigin);
    const bearer = canonicalBearer(input.bearer, true);
    const rawCreate: unknown = input.create;
    if (
        (rawCreate !== false && rawCreate !== 'private' && rawCreate !== 'public') ||
        typeof input.idempotencyKey !== 'string' ||
        !input.idempotencyKey.isWellFormed() ||
        !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
        textEncoder.encode(input.idempotencyKey).byteLength > PUBLICATION_LIMITS.maxIdempotencyKeyBytes ||
        typeof input.archiveSha256 !== 'string' ||
        !SHA256.test(input.archiveSha256) ||
        !Number.isSafeInteger(input.byteSize) ||
        input.byteSize < 1 ||
        input.byteSize > PUBLICATION_LIMITS.maxCandidateBytes ||
        typeof input.open !== 'function'
    ) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (bearer === undefined) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const create = input.create === false ? 'false' : input.create;
    return await retryRegistryTransport(
        async () => {
            const body = await uploadBody(input.open, input.byteSize, input.archiveSha256);
            let opened;
            try {
                opened = await openRegistryHttpResponse(
                    {
                        registryOrigin,
                        path: `/api/v1/publications?create=${create}`,
                        method: 'POST',
                        headers: {
                            accept: 'application/json',
                            authorization: `Bearer ${bearer}`,
                            'content-length': String(input.byteSize),
                            'content-type': 'application/vnd.erden.package.v1',
                            'idempotency-key': input.idempotencyKey,
                            'x-erden-archive-sha256': input.archiveSha256,
                        },
                        body: body.stream,
                        streamingRequest: true,
                        ...(input.signal === undefined ? {} : { signal: input.signal }),
                        timeoutMilliseconds: 300000,
                    },
                    runtime,
                );
                const attempt = await decodeUploadResponse(opened.response, opened.signal);
                await body.settled();
                if (!body.completed() || body.failure() !== undefined) {
                    throw body.failure() ?? new RegistryClientError('CLIENT_INPUT_INVALID');
                }
                return attempt;
            } catch (error) {
                const failure = body.failure();
                if (failure !== undefined) {
                    throw failure;
                }
                throw error;
            } finally {
                opened?.finish();
                await body.close();
            }
        },
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
