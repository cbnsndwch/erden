import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { getPublicationAttempt, getPublicationReport, uploadPublication } from '../src/index.js';
import { encodeCanonicalJson } from '../src/wire.js';

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
    it('streams one authenticated upload with exact headers and decodes the accepted attempt', async () => {
        const opened = { count: 0 };
        let request: Request | undefined;
        const value = await uploadPublication(
            {
                registryOrigin: ORIGIN,
                bearer: BEARER,
                create: 'public',
                idempotencyKey: 'publish-1',
                archiveSha256: SHA256,
                byteSize: ARCHIVE.byteLength,
                open: source(opened),
            },
            {
                fetch: async (input, init) => {
                    request = new Request(input, init);
                    expect(Buffer.from(await request.arrayBuffer())).toEqual(Buffer.from(ARCHIVE));
                    return jsonResponse(attempt, 202);
                },
            },
        );
        expect(value).toEqual(attempt);
        expect(opened.count).toBe(1);
        expect(request?.url).toBe(`${ORIGIN}/api/v1/publications?create=public`);
        expect(request?.redirect).toBe('manual');
        expect(request?.credentials).toBe('omit');
        expect(request?.headers.get('authorization')).toBe(`Bearer ${BEARER}`);
        expect(request?.headers.get('idempotency-key')).toBe('publish-1');
        expect(request?.headers.get('x-erden-archive-sha256')).toBe(SHA256);
        expect(request?.headers.has('cookie')).toBe(false);
        expect(request?.headers.has('origin')).toBe(false);
    });

    it('reopens a fresh source for response loss and canonical unavailable replay', async () => {
        const opened = { count: 0 };
        const keys: string[] = [];
        const sleeps: number[] = [];
        let calls = 0;
        const value = await uploadPublication(
            {
                registryOrigin: ORIGIN,
                bearer: BEARER,
                create: false,
                idempotencyKey: 'stable-key',
                archiveSha256: SHA256,
                byteSize: ARCHIVE.byteLength,
                open: source(opened),
            },
            {
                fetch: async (input, init) => {
                    calls += 1;
                    const request = new Request(input, init);
                    keys.push(request.headers.get('idempotency-key') ?? '');
                    expect(Buffer.from(await request.arrayBuffer())).toEqual(Buffer.from(ARCHIVE));
                    if (calls === 1) {
                        throw new Error('response lost');
                    }
                    if (calls === 2) {
                        return jsonResponse({ code: 'PUBLICATION_UNAVAILABLE' }, 503);
                    }
                    return jsonResponse(attempt, 202);
                },
                sleep: (milliseconds) => {
                    sleeps.push(milliseconds);
                    return Promise.resolve();
                },
            },
        );
        expect(value).toEqual(attempt);
        expect({ calls, opened: opened.count, keys, sleeps }).toEqual({
            calls: 3,
            opened: 3,
            keys: ['stable-key', 'stable-key', 'stable-key'],
            sleeps: [100, 200],
        });
    });

    it('fails closed on local length/digest drift and awaits source cleanup on transport failure', async () => {
        await expect(
            uploadPublication(
                {
                    registryOrigin: ORIGIN,
                    bearer: BEARER,
                    create: false,
                    idempotencyKey: 'bad-length',
                    archiveSha256: SHA256,
                    byteSize: ARCHIVE.byteLength + 1,
                    open: source({ count: 0 }),
                },
                {
                    fetch: async (input, init) => {
                        await new Request(input, init).arrayBuffer();
                        return jsonResponse(attempt, 202);
                    },
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_INPUT_INVALID' });

        const opened = { count: 0 };
        const closed = { count: 0 };
        await expect(
            uploadPublication(
                {
                    registryOrigin: ORIGIN,
                    bearer: BEARER,
                    create: false,
                    idempotencyKey: 'lost',
                    archiveSha256: SHA256,
                    byteSize: ARCHIVE.byteLength,
                    open: source(opened, closed),
                },
                {
                    fetch: () => Promise.reject(new Error('offline')),
                    sleep: () => Promise.resolve(),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RETRY_EXHAUSTED' });
        expect({ opened: opened.count, closed: closed.count }).toEqual({ opened: 3, closed: 3 });
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
