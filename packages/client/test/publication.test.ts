import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { PUBLICATION_LIMITS } from '@erden/contracts';

import { putToSignedUrl } from '../src/http.js';
import { getPublicationAttempt, getPublicationReport, uploadPublication } from '../src/index.js';
import { RegistryClientError, encodeCanonicalJson } from '../src/wire.js';

const ORIGIN = 'https://registry.example.test';
const PAYLOAD = createHash('sha256').update('credential').digest('base64url');
const BEARER = `erden_cli_v1_d1_${PAYLOAD}`;
const ARCHIVE = new TextEncoder().encode('deterministic archive bytes');
const SHA256 = createHash('sha256').update(ARCHIVE).digest('hex');

const attempt = Object.freeze({
    attemptId: 'attempt-1',
    createdAt: 1,
    failure: null,
    project: {
        canonicalIri: 'https://example.test/root',
        preferredAlias: '@example/root',
        visibility: 'public',
    },
    release: null,
    report: null,
    schema: 'erden.publication-attempt/v1',
    state: 'queued',
    updatedAt: 1,
    validationExecutions: 0,
    version: '1.2.3',
});

const report = Object.freeze({
    attemptId: 'attempt-1',
    failure: { code: 'PUBLICATION_CANDIDATE_OBJECT_INVALID', kind: 'candidate' },
    outcome: 'failed',
    report: { byteSize: 10, sha256: 'a'.repeat(64) },
    schema: 'erden.publication-report-summary/v1',
    validation: null,
});

function jsonResponse(body: unknown, status: number, cache: 'no-store' | 'private' = 'no-store'): Response {
    const bytes = encodeCanonicalJson(body);
    const headers: Record<string, string> = {
        'cache-control': cache === 'private' ? 'private, no-store, no-transform' : 'no-store',
        'content-length': String(bytes.byteLength),
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
    };
    if (cache === 'private') {
        headers.etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
        headers.vary = 'Authorization, Cookie, Origin';
    }
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { status, headers });
}

function source(
    opened: {
        count: number;
    },
    closed?: {
        count: number;
    },
) {
    return async function* (): AsyncGenerator<Uint8Array> {
        opened.count += 1;
        try {
            await Promise.resolve();
            yield ARCHIVE;
        } finally {
            if (closed !== undefined) {
                closed.count += 1;
            }
        }
    };
}

describe('publication registry client', () => {
    const IDENTITY = Object.freeze({
        canonicalIri: 'https://example.test/root',
        preferredAlias: '@example/root',
        version: '1.2.3',
    });
    const STORAGE_URL = 'https://storage.example.test/bucket/staged-uploads/s123?X-Amz-Signature=secret-signature';
    const CHECKSUM = Buffer.from(SHA256, 'hex').toString('base64');

    function grant(put: unknown = signedPut()): Response {
        return jsonResponse({ put, schema: 'erden.publication-upload/v1', uploadId: 'attempt-1' }, 201);
    }

    function signedPut(overrides: Readonly<Record<string, unknown>> = {}) {
        return {
            expiresAt: 1_000,
            headers: {
                'content-length': String(ARCHIVE.byteLength),
                'if-none-match': '*',
                'x-amz-checksum-sha256': CHECKSUM,
            },
            url: STORAGE_URL,
            ...overrides,
        };
    }

    function uploadInput(opened: { count: number }, closed?: { count: number }) {
        return {
            registryOrigin: ORIGIN,
            bearer: BEARER,
            create: 'public' as const,
            idempotencyKey: 'publish-1',
            archiveSha256: SHA256,
            byteSize: ARCHIVE.byteLength,
            ...IDENTITY,
            open: source(opened, closed),
        };
    }

    interface Seen {
        readonly request: Request;
        readonly bytes: Buffer;
    }

    /** Plays the registry and the store; `store` is the store's answer to each signed PUT, in order. */
    function storeRuntime(store: ReadonlyArray<number | Response | Error>, start: () => Response = () => grant()) {
        const seen: Seen[] = [];
        let puts = 0;
        return {
            seen,
            runtime: {
                sleep: () => Promise.resolve(),
                fetch: async (input: string | URL | Request, init?: RequestInit) => {
                    const request = new Request(input, init);
                    seen.push({ request, bytes: Buffer.from(await request.clone().arrayBuffer()) });
                    if (new URL(request.url).origin !== ORIGIN) {
                        const answer = store[puts++];
                        if (answer instanceof Error) {
                            throw answer;
                        }
                        return answer instanceof Response
                            ? answer
                            : new Response('<Error/>', { status: answer ?? 200 });
                    }
                    return request.url.endsWith('/finalize') ? jsonResponse(attempt, 202) : start();
                },
            },
        };
    }

    it('starts, sends the bytes to storage with no credential, and finalizes', async () => {
        const opened = { count: 0 };
        const { seen, runtime } = storeRuntime([200]);
        const value = await uploadPublication(uploadInput(opened), runtime);
        expect(value).toEqual(attempt);
        expect(opened.count).toBe(1);
        const [start, put, finalize] = seen;
        expect(start?.request.url).toBe(`${ORIGIN}/api/v1/publications/uploads?create=public`);
        expect(start?.request.method).toBe('POST');
        expect(start?.request.headers.get('authorization')).toBe(`Bearer ${BEARER}`);
        expect(JSON.parse(start?.bytes.toString() ?? '')).toEqual({
            archiveSha256: SHA256,
            byteSize: ARCHIVE.byteLength,
            canonicalIri: IDENTITY.canonicalIri,
            idempotencyKey: 'publish-1',
            preferredAlias: IDENTITY.preferredAlias,
            version: IDENTITY.version,
        });

        expect(put?.request.url).toBe(STORAGE_URL);
        expect(put?.request.method).toBe('PUT');
        expect(put?.bytes).toEqual(Buffer.from(ARCHIVE));
        expect(put?.request.redirect).toBe('manual');
        expect(put?.request.credentials).toBe('omit');
        expect(put?.request.headers.get('authorization')).toBeNull();
        expect(put?.request.headers.get('cookie')).toBeNull();
        expect(put?.request.headers.get('content-length')).toBe(String(ARCHIVE.byteLength));
        expect(put?.request.headers.get('if-none-match')).toBe('*');
        expect(put?.request.headers.get('x-amz-checksum-sha256')).toBe(CHECKSUM);
        expect(JSON.stringify([...(put?.request.headers ?? [])])).not.toContain(BEARER);

        expect(finalize?.request.url).toBe(`${ORIGIN}/api/v1/publications/uploads/attempt-1/finalize`);
        expect(finalize?.request.headers.get('authorization')).toBe(`Bearer ${BEARER}`);
        expect(seen).toHaveLength(3);
    });

    it('sends no bytes when the registry already holds the upload', async () => {
        const opened = { count: 0 };
        const { seen, runtime } = storeRuntime([], () => grant(null));
        await expect(uploadPublication(uploadInput(opened), runtime)).resolves.toEqual(attempt);
        expect(opened.count).toBe(0);
        expect(seen.map(({ request }) => request.method)).toEqual(['POST', 'POST']);
    });

    it('follows no redirect from storage, and sends nothing to where it points', async () => {
        const { seen, runtime } = storeRuntime([
            new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.test/x' } }),
        ]);
        await expect(uploadPublication(uploadInput({ count: 0 }), runtime)).rejects.toMatchObject({
            code: 'CLIENT_RESPONSE_INVALID',
        });
        expect(seen.map(({ request }) => new URL(request.url).host)).not.toContain('elsewhere.example.test');
    });

    it('refuses a response claiming another origin or a followed redirect', async () => {
        const redirected = new Response(null, { status: 200 });
        Object.defineProperty(redirected, 'redirected', { value: true });
        const moved = new Response(null, { status: 200 });
        Object.defineProperty(moved, 'url', { value: 'https://elsewhere.example.test/x' });
        for (const answer of [redirected, moved]) {
            const { runtime } = storeRuntime([answer]);
            await expect(uploadPublication(uploadInput({ count: 0 }), runtime)).rejects.toMatchObject({
                code: 'CLIENT_RESPONSE_INVALID',
            });
        }
    });

    it('starts over from a fresh URL after an expired URL, a store failure, or a lost connection', async () => {
        const opened = { count: 0 };
        const { seen, runtime } = storeRuntime([403, 503, 200]);
        await expect(uploadPublication(uploadInput(opened), runtime)).resolves.toEqual(attempt);
        expect(opened.count).toBe(3);
        expect(seen.filter(({ request }) => request.url.includes('uploads?create'))).toHaveLength(3);
        const lost = storeRuntime([new TypeError('socket hang up'), 200]);
        await expect(uploadPublication(uploadInput({ count: 0 }), lost.runtime)).resolves.toEqual(attempt);
    });

    it('treats the single-write refusal as an earlier write whose answer was lost, and finalizes', async () => {
        const { seen, runtime } = storeRuntime([412]);
        await expect(uploadPublication(uploadInput({ count: 0 }), runtime)).resolves.toEqual(attempt);
        expect(seen.at(-1)?.request.url).toMatch(/\/finalize$/u);
    });

    it('never repeats the signed URL in an error', async () => {
        for (const answer of [400, 403, new TypeError(STORAGE_URL)]) {
            const { runtime } = storeRuntime([answer, answer, answer]);
            const error: unknown = await uploadPublication(uploadInput({ count: 0 }), runtime).catch(
                (reason: unknown) => reason,
            );
            expect(error).toBeInstanceOf(RegistryClientError);
            expect(String(error)).not.toContain('secret-signature');
            expect(JSON.stringify(error)).not.toContain('secret-signature');
            expect((error as Error).stack ?? '').not.toContain('secret-signature');
        }
    });

    it('refuses a grant that disagrees with the declaration, a credentialed URL, or a downgrade', async () => {
        for (const put of [
            signedPut({ url: 'http://storage.example.test/x' }),
            signedPut({ url: 'https://user:pass@storage.example.test/x' }),
            signedPut({ url: 'https://storage.example.test/x#fragment' }),
            signedPut({ headers: { 'content-length': '1', 'if-none-match': '*', 'x-amz-checksum-sha256': CHECKSUM } }),
            signedPut({
                headers: {
                    'content-length': String(ARCHIVE.byteLength),
                    'if-none-match': '*',
                    'x-amz-checksum-sha256': 'AAAA',
                },
            }),
            signedPut({
                headers: {
                    authorization: 'Bearer stolen',
                    'content-length': String(ARCHIVE.byteLength),
                    'if-none-match': '*',
                    'x-amz-checksum-sha256': CHECKSUM,
                },
            }),
        ]) {
            const opened = { count: 0 };
            const { seen, runtime } = storeRuntime([], () => grant(put));
            await expect(uploadPublication(uploadInput(opened), runtime)).rejects.toMatchObject({
                code: 'CLIENT_RESPONSE_INVALID',
            });
            expect(opened.count).toBe(0);
            expect(seen).toHaveLength(1);
        }
    });

    it('fails closed on local length or digest drift and awaits source cleanup on transport failure', async () => {
        for (const bytes of [new TextEncoder().encode('other bytes of other length'), ARCHIVE.slice(1)]) {
            const { runtime } = storeRuntime([200]);
            await expect(
                uploadPublication(
                    {
                        ...uploadInput({ count: 0 }),
                        open: async function* (): AsyncGenerator<Uint8Array> {
                            await Promise.resolve();
                            yield bytes;
                        },
                    },
                    runtime,
                ),
            ).rejects.toMatchObject({ code: 'CLIENT_INPUT_INVALID' });
        }
        const opened = { count: 0 };
        const closed = { count: 0 };
        const { runtime } = storeRuntime([new TypeError('reset'), new TypeError('reset'), new TypeError('reset')]);
        await expect(uploadPublication(uploadInput(opened, closed), runtime)).rejects.toMatchObject({
            code: 'CLIENT_RETRY_EXHAUSTED',
        });
        expect(opened.count).toBe(closed.count);
    });

    it('maps the refusals of a start: too large, unauthorized, not found, conflict', async () => {
        for (const [status, wire, code] of [
            [413, 'PUBLICATION_TOO_LARGE', 'CLIENT_TOO_LARGE'],
            [401, 'PUBLICATION_UNAUTHORIZED', 'CLIENT_UNAUTHORIZED'],
            [404, 'PUBLICATION_NOT_FOUND', 'CLIENT_NOT_FOUND'],
            [409, 'PUBLICATION_CONFLICT', 'CLIENT_CONFLICT'],
        ] as const) {
            const opened = { count: 0 };
            const { runtime } = storeRuntime([], () => jsonResponse({ code: wire }, status));
            await expect(uploadPublication(uploadInput(opened), runtime)).rejects.toMatchObject({ code });
            expect(opened.count).toBe(0);
        }
    });

    it('refuses an over-limit package locally', async () => {
        const { seen, runtime } = storeRuntime([]);
        await expect(
            uploadPublication(
                { ...uploadInput({ count: 0 }), byteSize: PUBLICATION_LIMITS.maxCandidateBytes + 1 },
                runtime,
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_INPUT_INVALID' });
        expect(seen).toEqual([]);
    });

    it('applies an idle timeout to the transfer, not a total deadline', async () => {
        vi.useFakeTimers();
        try {
            const { reader, stream } = (() => {
                const inner = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
                return { reader: inner.getReader(), stream: inner };
            })();
            void reader;
            void stream;
            const pending = putToSignedUrl(
                {
                    url: STORAGE_URL,
                    headers: {},
                    body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }),
                    idleTimeoutMilliseconds: 1_000,
                },
                {
                    fetch: async (_input, init) =>
                        await new Promise<Response>((_resolve, reject) => {
                            init?.signal?.addEventListener('abort', () => {
                                reject(new DOMException('aborted', 'AbortError'));
                            });
                        }),
                },
            );
            const caught = pending.catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(await caught).toMatchObject({ code: 'CLIENT_TIMEOUT' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('strictly reads actor-scoped attempt and report wires and retries only canonical 503', async () => {
        const paths: string[] = [];
        let calls = 0;
        const runtime = {
            fetch: (input: string | URL | Request) => {
                calls += 1;
                const request = new Request(input);
                paths.push(new URL(request.url).pathname);
                if (calls === 1) {
                    return Promise.resolve(jsonResponse({ code: 'PUBLICATION_UNAVAILABLE' }, 503));
                }
                return Promise.resolve(jsonResponse(attempt, 200, 'private'));
            },
            sleep: () => Promise.resolve(),
        };
        await expect(
            getPublicationAttempt(
                {
                    registryOrigin: ORIGIN,
                    attemptId: 'attempt-1',
                    bearer: BEARER,
                },
                runtime,
            ),
        ).resolves.toEqual(attempt);
        expect(paths).toEqual(['/api/v1/publications/attempt-1', '/api/v1/publications/attempt-1']);

        await expect(
            getPublicationReport(
                {
                    registryOrigin: ORIGIN,
                    attemptId: 'attempt-1',
                    bearer: BEARER,
                },
                { fetch: () => Promise.resolve(jsonResponse(report, 200, 'private')) },
            ),
        ).resolves.toEqual(report);
        await expect(
            getPublicationAttempt(
                {
                    registryOrigin: ORIGIN,
                    attemptId: 'attempt-1',
                    bearer: BEARER,
                },
                { fetch: () => Promise.resolve(jsonResponse({ ...attempt, attemptId: 'attempt-2' }, 200, 'private')) },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
    });

    it('maps only exact closed errors and rejects cache or body substitutions without retry', async () => {
        await expect(
            getPublicationAttempt(
                {
                    registryOrigin: ORIGIN,
                    attemptId: 'attempt-1',
                    bearer: BEARER,
                },
                { fetch: () => Promise.resolve(jsonResponse({ code: 'PUBLICATION_UNAUTHORIZED' }, 401)) },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_UNAUTHORIZED' });
        await expect(
            getPublicationAttempt(
                {
                    registryOrigin: ORIGIN,
                    attemptId: 'attempt-1',
                    bearer: BEARER,
                },
                {
                    fetch: () =>
                        Promise.resolve(jsonResponse({ code: 'PUBLICATION_NOT_FOUND', detail: 'secret' }, 404)),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        await expect(
            getPublicationAttempt(
                {
                    registryOrigin: ORIGIN,
                    attemptId: 'attempt-1',
                    bearer: BEARER,
                },
                { fetch: () => Promise.resolve(jsonResponse(attempt, 200, 'no-store')) },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
    });
});
