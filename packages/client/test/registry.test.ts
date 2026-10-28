import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    getExactRegistryRelease,
    listRegistryReleases,
    openRegistryArchive,
    resolveRegistryAlias,
} from '../src/index.js';
import { encodeCanonicalJson } from '../src/wire.js';

const ORIGIN = 'https://registry.example.test';
const IRI = 'https://example.test/root';
const ALIAS = '@example/root';
const VERSION = '1.2.3+build.7';
const PAYLOAD = createHash('sha256').update('credential').digest('base64url');
const BEARER = `erden_cli_v1_d1_${PAYLOAD}`;
const ARCHIVE = new TextEncoder().encode('one exact immutable archive');
const ARCHIVE_SHA = createHash('sha256').update(ARCHIVE).digest('hex');
const TOOLCHAIN = Object.freeze({
    reasoner: Object.freeze({ version: '1.0.0', sha256: 'a'.repeat(64) }),
    validator: Object.freeze({ version: '1.0.0', sha256: 'b'.repeat(64) }),
});
const RELEASE = Object.freeze({ version: VERSION, archiveSha256: ARCHIVE_SHA, toolchain: TOOLCHAIN, dependencies: [] });
const ALIAS_WIRE = Object.freeze({
    schema: 'erden.registry-alias-resolution/v1',
    registryOrigin: ORIGIN,
    alias: ALIAS,
    canonicalIri: IRI,
});
const PAGE_WIRE = Object.freeze({
    schema: 'erden.registry-release-index-page/v1',
    registryOrigin: ORIGIN,
    canonicalIri: IRI,
    watermark: 'watermark-1',
    pageOrdinal: 0,
    releaseCount: 1,
    releases: [RELEASE],
    nextCursor: null,
});
const ENTRY_WIRE = Object.freeze({
    schema: 'erden.registry-release-index-entry/v1',
    registryOrigin: ORIGIN,
    canonicalIri: IRI,
    release: RELEASE,
});

function jsonResponse(body: unknown, status: number, cache: 'no-store' | 'private' | 'public'): Response {
    const bytes = encodeCanonicalJson(body);
    const headers: Record<string, string> = {
        'cache-control':
            cache === 'no-store'
                ? 'no-store'
                : cache === 'private'
                  ? 'private, no-store, no-transform'
                  : 'public, max-age=0, must-revalidate, no-transform',
        'content-length': String(bytes.byteLength),
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
    };
    if (cache !== 'no-store') {
        headers.etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
        headers.vary = 'Authorization, Cookie, Origin';
    }
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { status, headers });
}

function archiveResponse(
    bytes: Uint8Array,
    length = bytes.byteLength,
    digest = ARCHIVE_SHA,
    stream?: ReadableStream<Uint8Array>,
): Response {
    return new Response(stream ?? new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        status: 200,
        headers: {
            'cache-control': 'private, no-store, no-transform',
            'content-length': String(length),
            'content-type': 'application/vnd.erden.package.v1',
            etag: `"${digest}"`,
            'x-content-type-options': 'nosniff',
            'x-erden-archive-sha256': digest,
        },
    });
}

describe('compact registry client', () => {
    it('uses exact canonical metadata URLs, optional bearer only, and strict public/private headers', async () => {
        const requests: Request[] = [];
        const runtime = {
            fetch: (input: string | URL | Request, init?: RequestInit) => {
                const request = new Request(input, init);
                requests.push(request);
                const url = new URL(request.url);
                if (url.pathname.endsWith('/aliases')) {
                    return Promise.resolve(jsonResponse(ALIAS_WIRE, 200, 'public'));
                }
                if (url.pathname === '/api/v1/registry/releases') {
                    return Promise.resolve(jsonResponse(PAGE_WIRE, 200, 'private'));
                }
                return Promise.resolve(jsonResponse(ENTRY_WIRE, 200, 'private'));
            },
        };
        await expect(resolveRegistryAlias({ registryOrigin: ORIGIN, alias: ALIAS }, runtime)).resolves.toEqual(
            ALIAS_WIRE,
        );
        await expect(
            listRegistryReleases({ registryOrigin: ORIGIN, canonicalIri: IRI, bearer: BEARER }, runtime),
        ).resolves.toEqual(PAGE_WIRE);
        await expect(
            getExactRegistryRelease(
                {
                    registryOrigin: ORIGIN,
                    canonicalIri: IRI,
                    version: VERSION,
                    bearer: BEARER,
                },
                runtime,
            ),
        ).resolves.toEqual(ENTRY_WIRE);

        expect(requests.map((request) => request.url)).toEqual([
            `${ORIGIN}/api/v1/registry/aliases?alias=%40example%2Froot`,
            `${ORIGIN}/api/v1/registry/releases?canonicalIri=https%3A%2F%2Fexample.test%2Froot`,
            `${ORIGIN}/api/v1/registry/releases/1.2.3%2Bbuild.7?canonicalIri=https%3A%2F%2Fexample.test%2Froot`,
        ]);
        expect(requests[0]?.headers.has('authorization')).toBe(false);
        expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${BEARER}`);
        for (const request of requests) {
            expect(request.redirect).toBe('manual');
            expect(request.credentials).toBe('omit');
            expect(request.headers.has('cookie')).toBe(false);
            expect(request.headers.has('origin')).toBe(false);
        }
    });

    it('retries only transport and exact unavailable metadata, then rejects substituted bodies', async () => {
        let calls = 0;
        await expect(
            resolveRegistryAlias(
                { registryOrigin: ORIGIN, alias: ALIAS },
                {
                    fetch: () => {
                        calls += 1;
                        if (calls === 1) {
                            return Promise.reject(new Error('lost response'));
                        }
                        if (calls === 2) {
                            return Promise.resolve(jsonResponse({ code: 'REGISTRY_UNAVAILABLE' }, 503, 'no-store'));
                        }
                        return Promise.resolve(jsonResponse(ALIAS_WIRE, 200, 'public'));
                    },
                    sleep: () => Promise.resolve(),
                },
            ),
        ).resolves.toEqual(ALIAS_WIRE);
        expect(calls).toBe(3);

        await expect(
            resolveRegistryAlias(
                { registryOrigin: ORIGIN, alias: ALIAS },
                {
                    fetch: () => Promise.resolve(jsonResponse({ ...ALIAS_WIRE, alias: '@other/root' }, 200, 'public')),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        await expect(
            resolveRegistryAlias(
                { registryOrigin: ORIGIN, alias: ALIAS },
                {
                    fetch: () => Promise.resolve(jsonResponse({ code: 'REGISTRY_NOT_FOUND' }, 404, 'no-store')),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
        await expect(
            resolveRegistryAlias(
                { registryOrigin: ORIGIN, alias: ALIAS },
                {
                    fetch: () =>
                        Promise.resolve(
                            jsonResponse({ code: 'REGISTRY_NOT_FOUND', internalRef: 'secret' }, 404, 'no-store'),
                        ),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
    });

    it('authenticates exact release metadata before exposing a streamed archive and verifies EOF', async () => {
        const requests: Request[] = [];
        const lease = await openRegistryArchive(
            {
                registryOrigin: ORIGIN,
                canonicalIri: IRI,
                version: VERSION,
                archiveSha256: ARCHIVE_SHA,
                bearer: BEARER,
            },
            {
                fetch: (input, init) => {
                    const request = new Request(input, init);
                    requests.push(request);
                    return Promise.resolve(
                        request.url.includes('/archive?')
                            ? archiveResponse(ARCHIVE)
                            : jsonResponse(ENTRY_WIRE, 200, 'private'),
                    );
                },
            },
        );
        const chunks: Uint8Array[] = [];
        for await (const chunk of lease.bytes) {
            chunks.push(chunk);
        }
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(ARCHIVE));
        expect(lease).toMatchObject({ sha256: ARCHIVE_SHA, byteSize: ARCHIVE.byteLength });
        expect(requests.map((request) => request.url)).toEqual([
            `${ORIGIN}/api/v1/registry/releases/1.2.3%2Bbuild.7?canonicalIri=https%3A%2F%2Fexample.test%2Froot`,
            `${ORIGIN}/api/v1/registry/releases/1.2.3%2Bbuild.7/archive?canonicalIri=https%3A%2F%2Fexample.test%2Froot`,
        ]);
        expect(requests[1]?.headers.get('accept')).toBe('application/vnd.erden.package.v1');
    });

    it('fails at EOF on corruption or truncation and never retries after yielding bytes', async () => {
        for (const body of [
            new TextEncoder().encode('one exact immutable archivf'),
            ARCHIVE.subarray(0, ARCHIVE.byteLength - 1),
        ]) {
            let calls = 0;
            const lease = await openRegistryArchive(
                {
                    registryOrigin: ORIGIN,
                    canonicalIri: IRI,
                    version: VERSION,
                    archiveSha256: ARCHIVE_SHA,
                },
                {
                    fetch: (input) => {
                        calls += 1;
                        return Promise.resolve(
                            new URL(input instanceof Request ? input.url : input).pathname.endsWith('/archive')
                                ? archiveResponse(body, ARCHIVE.byteLength)
                                : jsonResponse(ENTRY_WIRE, 200, 'public'),
                        );
                    },
                },
            );
            const iterator = lease.bytes[Symbol.asyncIterator]();
            const first = await iterator.next();
            expect(first.done).toBe(false);
            await expect(iterator.next()).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
            expect(calls).toBe(2);
        }
    });

    it('awaits archive cancellation and rejects metadata digest substitution before opening bytes', async () => {
        let cancelled = false;
        let settled = false;
        const held = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(ARCHIVE.subarray(0, 1));
            },
            cancel: async () => {
                cancelled = true;
                await Promise.resolve();
                settled = true;
            },
        });
        const lease = await openRegistryArchive(
            {
                registryOrigin: ORIGIN,
                canonicalIri: IRI,
                version: VERSION,
                archiveSha256: ARCHIVE_SHA,
            },
            {
                fetch: (input) =>
                    Promise.resolve(
                        new URL(input instanceof Request ? input.url : input).pathname.endsWith('/archive')
                            ? archiveResponse(ARCHIVE, ARCHIVE.byteLength, ARCHIVE_SHA, held)
                            : jsonResponse(ENTRY_WIRE, 200, 'public'),
                    ),
            },
        );
        const iterator = lease.bytes[Symbol.asyncIterator]();
        expect((await iterator.next()).done).toBe(false);
        await lease.close();
        expect({ cancelled, settled }).toEqual({ cancelled: true, settled: true });

        let archiveCalls = 0;
        await expect(
            openRegistryArchive(
                {
                    registryOrigin: ORIGIN,
                    canonicalIri: IRI,
                    version: VERSION,
                    archiveSha256: ARCHIVE_SHA,
                },
                {
                    fetch: () => {
                        archiveCalls += 1;
                        return Promise.resolve(
                            jsonResponse(
                                {
                                    ...ENTRY_WIRE,
                                    release: { ...RELEASE, archiveSha256: 'c'.repeat(64) },
                                },
                                200,
                                'public',
                            ),
                        );
                    },
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        expect(archiveCalls).toBe(1);
    });
});
