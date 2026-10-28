import { describe, expect, it, vi } from 'vitest';

import { getRegistryArtifactFile, listRegistryArtifactFiles } from '../src/artifact-files.js';
import type { RegistryHttpRuntime } from '../src/http.js';

const ORIGIN = 'https://registry.example.test';
const IRI = 'https://example.test/ontology/artifact';
const VERSION = '1.0.0';
const DIGEST = createHash('sha256').update('safe').digest('hex');
const BEARER = `erden_cli_v1_d1_${'A'.repeat(43)}`;

function canonicalJson(value: unknown): Uint8Array {
    function visit(input: unknown): unknown {
        if (input === null || typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') {
            return input;
        }
        if (Array.isArray(input)) {
            return input.map(visit);
        }
        if (typeof input === 'object') {
            return Object.fromEntries(
                Object.entries(input)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, child]) => [key, visit(child)]),
            );
        }
        throw new Error('unsupported fixture');
    }
    return new TextEncoder().encode(`${JSON.stringify(visit(value))}\n`);
}

function jsonResponse(body: unknown, cache: 'private' | 'public', status = 200): Response {
    const bytes = canonicalJson(body);
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    return new Response(Uint8Array.from(bytes).buffer, {
        status,
        headers: {
            'cache-control':
                cache === 'private'
                    ? 'private, no-store, no-transform'
                    : 'public, max-age=0, must-revalidate, no-transform',
            'content-type': 'application/json; charset=utf-8',
            etag,
            vary: 'Authorization, Cookie, Origin',
            'x-content-type-options': 'nosniff',
        },
    });
}

function pageBody() {
    return {
        entries: [{ byteSize: 4, path: 'a.txt', sha256: DIGEST }],
        fileCount: 1,
        indexSha256: 'b'.repeat(64),
        nextCursor: null,
        pageOrdinal: 0,
        schema: 'erden.artifact-file-page/v1',
    };
}

function fileBody(path = 'a.txt') {
    return {
        byteSize: 4,
        mediaSignature: 'utf8-text',
        path,
        previewBase64: Buffer.from('safe').toString('base64'),
        raw: {
            expiresAt: null,
            headUrl: `https://raw.registry.example.test/raw/v1/releases/1.0.0/files/a.txt?canonicalIri=${encodeURIComponent(IRI)}`,
            url: `https://raw.registry.example.test/raw/v1/releases/1.0.0/files/a.txt?canonicalIri=${encodeURIComponent(IRI)}`,
        },
        renderer: { kind: 'preview', profile: 'source', sourceByteSize: 4 },
        schema: 'erden.registry-artifact-file/v1',
        sha256: DIGEST,
        validator: `"${'c'.repeat(64)}"`,
    };
}

describe('artifact registry client', () => {
    it('authenticates bounded pages and exact encoded paths', async () => {
        const fetch = vi.fn((url: string | URL | Request) => {
            const requested = url instanceof Request ? url.url : url.toString();
            expect(requested).toContain(`/releases/${VERSION}/files?canonicalIri=`);
            return Promise.resolve(jsonResponse(pageBody(), 'public'));
        });
        const result = await listRegistryArtifactFiles(
            { canonicalIri: IRI, registryOrigin: ORIGIN, version: VERSION },
            { fetch },
        );
        expect(result.entries.map((entry) => entry.path)).toEqual(['a.txt']);
    });

    it('uses the exact bearer and decodes a bounded raw descriptor without following it', async () => {
        const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${BEARER}`);
            return Promise.resolve(jsonResponse(fileBody(), 'private'));
        });
        const result = await getRegistryArtifactFile(
            { bearer: BEARER, canonicalIri: IRI, path: 'a.txt', registryOrigin: ORIGIN, version: VERSION },
            { fetch },
        );
        expect(new TextDecoder().decode(result.previewBytes)).toBe('safe');
        expect(result.raw.url).toMatch(/^https:\/\/raw\.registry\.example\.test\//u);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('rejects response path substitution and preview oversize relative to authenticated metadata', async () => {
        const substituted: RegistryHttpRuntime = {
            fetch: () => Promise.resolve(jsonResponse(fileBody('../secret'), 'public')),
        };
        await expect(
            getRegistryArtifactFile(
                { canonicalIri: IRI, path: 'a.txt', registryOrigin: ORIGIN, version: VERSION },
                substituted,
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        const oversized = { ...fileBody(), byteSize: 1 };
        await expect(
            getRegistryArtifactFile(
                { canonicalIri: IRI, path: 'a.txt', registryOrigin: ORIGIN, version: VERSION },
                { fetch: () => Promise.resolve(jsonResponse(oversized, 'public')) },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
    });

    it('cancels in flight without putting credentials or raw URLs in errors', async () => {
        const controller = new AbortController();
        const runtime: RegistryHttpRuntime = {
            fetch: async (_url, init) =>
                await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                        'abort',
                        () => {
                            reject(new DOMException('aborted', 'AbortError'));
                        },
                        {
                            once: true,
                        },
                    );
                }),
        };
        const running = getRegistryArtifactFile(
            {
                bearer: BEARER,
                canonicalIri: IRI,
                path: 'a.txt',
                registryOrigin: ORIGIN,
                signal: controller.signal,
                version: VERSION,
            },
            runtime,
        );
        controller.abort();
        await expect(running).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
        await running.catch((error: unknown) => {
            expect(String(error)).not.toContain(BEARER);
            expect(String(error)).not.toContain('raw.registry');
        });
    });
});
import { createHash } from 'node:crypto';
