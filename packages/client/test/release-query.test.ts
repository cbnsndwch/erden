import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RegistryClientError, queryRegistryRelease, type RegistryHttpRuntime } from '../src/index.js';
import { encodeCanonicalJson } from '../src/wire.js';

const ORIGIN = 'https://registry.example.test';
const IRI = 'https://example.test/root';
const VERSION = '1.2.3+build.7';
const ARCHIVE = 'a'.repeat(64);
const PAYLOAD = createHash('sha256').update('credential').digest('base64url');
const BEARER = `erden_cli_v1_d1_${PAYLOAD}`;
const QUERY = new TextEncoder().encode('SELECT ?c WHERE { ?c a <http://www.w3.org/2002/07/owl#Class> }');
const ENVELOPE_TYPE = 'application/vnd.erden.release-query+json; charset=utf-8';

function sha(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

function canonical(value: unknown): string {
    return new TextDecoder().decode(encodeCanonicalJson(value));
}

// Parsed from text: a `__proto__` literal key would set a prototype, while `JSON.parse` keeps it as own data.
const DEFAULT_RESULT = `{"head":{"vars":["__proto__","c"]},"results":{"bindings":[{"__proto__":{"type":"uri","value":"https://example.test/root#A"}},{"c":{"type":"literal","value":"Root","xml:lang":"en"}},{"c":{"datatype":"http://www.w3.org/2001/XMLSchema#integer","type":"literal","value":"7"}},{"c":{"type":"bnode","value":"b0"}}]}}`;

function envelope(overrides: Readonly<Record<string, unknown>> = {}, result?: unknown) {
    const parsedResult: unknown = result ?? JSON.parse(DEFAULT_RESULT);
    const value = {
        schema: 'erden.release-query-result/v1',
        binding: {
            release: { registryOrigin: ORIGIN, canonicalIri: IRI, version: VERSION, archiveSha256: ARCHIVE },
            evidence: { kind: 'comparison-profile', sha256: 'b'.repeat(64) },
            dataset: { sha256: 'c'.repeat(64), quadCounts: { declared: 12, inferred: 3 } },
            toolchain: {
                reasoner: { version: '1.0.0', sha256: 'd'.repeat(64) },
                validator: { version: '1.0.0', sha256: 'e'.repeat(64) },
            },
            reasoningProfile: { id: 'erden.reasoning/v1', sha256: 'f'.repeat(64) },
            engine: { name: 'oxigraph', version: '0.5.9', wasmSha256: '1'.repeat(64) },
            policy: { id: 'erden.release-query-policy/v1', sha256: '2'.repeat(64) },
        },
        query: { form: 'select', sha256: '3'.repeat(64) },
        result: parsedResult,
        resultSha256: sha(canonical(parsedResult)),
        ...overrides,
    };
    return value;
}

function bytesOf(value: unknown): Uint8Array {
    return encodeCanonicalJson(value);
}

function headers(type: string, bytes: Uint8Array, extra: Readonly<Record<string, string>> = {}) {
    return {
        'cache-control': 'private, no-store, no-transform',
        'content-length': String(bytes.byteLength),
        'content-type': type,
        vary: 'Accept, Authorization, Cookie, Origin',
        'x-content-type-options': 'nosniff',
        ...extra,
    };
}

function success(value: unknown = envelope(), extra: Readonly<Record<string, string>> = {}): Response {
    const bytes = bytesOf(value);
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        status: 200,
        headers: headers(ENVELOPE_TYPE, bytes, extra),
    });
}

function failure(status: number, code: string, reason: string | null): Response {
    const bytes = bytesOf({ schema: 'erden.release-query-error/v1', code, reason });
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        status,
        headers: headers('application/json; charset=utf-8', bytes),
    });
}

function runtime(respond: (request: Request) => Response | Promise<Response>, requests: Request[] = []) {
    return Object.freeze<RegistryHttpRuntime>({
        fetch: async (input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            return await respond(request);
        },
        sleep: () => Promise.resolve(),
    });
}

const REQUEST = Object.freeze({
    registryOrigin: ORIGIN,
    canonicalIri: IRI,
    version: VERSION,
    archiveSha256: ARCHIVE,
    query: QUERY,
});

describe('release query client', () => {
    it('posts exact query bytes once to the exact-release path and accepts only a bound envelope', async () => {
        const requests: Request[] = [];
        const outcome = await queryRegistryRelease(
            { ...REQUEST, bearer: BEARER },
            runtime(() => success(), requests),
        );
        expect(requests).toHaveLength(1);
        const request = requests[0] as Request;
        expect(request.method).toBe('POST');
        expect(request.url).toBe(
            `${ORIGIN}/api/v1/registry/releases/1.2.3%2Bbuild.7/query?canonicalIri=https%3A%2F%2Fexample.test%2Froot&archiveSha256=${ARCHIVE}`,
        );
        expect(request.redirect).toBe('manual');
        expect(request.headers.get('accept')).toBe('application/vnd.erden.release-query+json');
        expect(request.headers.get('content-type')).toBe('application/sparql-query');
        expect(request.headers.get('authorization')).toBe(`Bearer ${BEARER}`);
        expect(request.headers.has('origin')).toBe(false);
        expect(request.headers.has('cookie')).toBe(false);
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(QUERY);
        expect(outcome.kind).toBe('complete');
        if (outcome.kind !== 'complete') {
            return;
        }
        const result = outcome.envelope.result;
        expect('results' in result && Object.hasOwn(result.results.bindings[0] ?? {}, '__proto__')).toBe(true);
        expect(outcome.envelope.binding.release.archiveSha256).toBe(ARCHIVE);
    });

    it('omits the credential for anonymous queries', async () => {
        const requests: Request[] = [];
        await queryRegistryRelease(
            REQUEST,
            runtime(() => success(), requests),
        );
        expect(requests[0]?.headers.has('authorization')).toBe(false);
    });

    it.each([
        [
            'another release',
            envelope({
                binding: { ...envelope().binding, release: { ...envelope().binding.release, version: '1.2.4' } },
            }),
        ],
        [
            'another archive',
            envelope({
                binding: {
                    ...envelope().binding,
                    release: { ...envelope().binding.release, archiveSha256: 'f'.repeat(64) },
                },
            }),
        ],
        ['a result digest mismatch', envelope({ resultSha256: '0'.repeat(64) })],
        ['an unknown field', { ...envelope(), extra: true }],
        [
            'a triple term',
            envelope({}, { head: { vars: ['t'] }, results: { bindings: [{ t: { type: 'triple', value: 'x' } }] } }),
        ],
        [
            'an undeclared variable',
            envelope({}, { head: { vars: ['a'] }, results: { bindings: [{ b: { type: 'uri', value: 'x' } }] } }),
        ],
        [
            'an engine blank label',
            envelope(
                {},
                { head: { vars: ['a'] }, results: { bindings: [{ a: { type: 'bnode', value: 'riog00000001' } }] } },
            ),
        ],
        [
            'an xsd:string datatype',
            envelope(
                {},
                {
                    head: { vars: ['a'] },
                    results: {
                        bindings: [
                            { a: { type: 'literal', value: 'x', datatype: 'http://www.w3.org/2001/XMLSchema#string' } },
                        ],
                    },
                },
            ),
        ],
        ['an ask form with bindings', envelope({ query: { form: 'ask', sha256: '3'.repeat(64) } })],
    ])('refuses %s', async (_name, value) => {
        await expect(
            queryRegistryRelease(
                REQUEST,
                runtime(() => success(value)),
            ),
        ).rejects.toMatchObject({
            code: 'CLIENT_RESPONSE_INVALID',
        });
    });

    it.each([
        ['a cookie', { 'set-cookie': 'a=b' }],
        ['an entity tag', { etag: '"x"' }],
        ['CORS', { 'access-control-allow-origin': '*' }],
        ['public caching', { 'cache-control': 'public, max-age=60' }],
        ['a wrong length', { 'content-length': '1' }],
    ])('refuses a success response with %s', async (_name, extra) => {
        await expect(
            queryRegistryRelease(
                REQUEST,
                runtime(() => success(envelope(), extra)),
            ),
        ).rejects.toBeInstanceOf(RegistryClientError);
    });

    it('refuses noncanonical JSON, SPARQL JSON, redirects, and oversized envelopes', async () => {
        const noncanonical = new TextEncoder().encode(`${JSON.stringify(envelope())}\n`.replace('{', '{ '));
        const cases: ReadonlyArray<() => Response> = [
            () =>
                new Response(new Blob([noncanonical]), {
                    status: 200,
                    headers: headers(ENVELOPE_TYPE, noncanonical),
                }),
            () => {
                const bytes = bytesOf(envelope().result);
                return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
                    status: 200,
                    headers: headers('application/sparql-results+json; charset=utf-8', bytes),
                });
            },
            () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
            () =>
                new Response(new Blob([new Uint8Array(4 * 1_048_576 + 64 * 1_024 + 1)]), {
                    status: 200,
                    headers: { 'content-type': ENVELOPE_TYPE },
                }),
        ];
        for (const respond of cases) {
            await expect(queryRegistryRelease(REQUEST, runtime(respond))).rejects.toMatchObject({
                code: 'CLIENT_RESPONSE_INVALID',
            });
        }
    });

    it.each([
        [404, 'RELEASE_QUERY_NOT_FOUND', null],
        [409, 'RELEASE_QUERY_DATASET_UNAVAILABLE', 'dataset-missing'],
        [413, 'RELEASE_QUERY_TOO_LARGE', 'query-too-large'],
        [422, 'RELEASE_QUERY_REJECTED', 'service-forbidden'],
        [422, 'RELEASE_QUERY_LIMIT_EXCEEDED', 'row-limit'],
        [503, 'RELEASE_QUERY_BUSY', null],
        [503, 'RELEASE_QUERY_UNAVAILABLE', null],
    ] as const)('reports %i %s as a closed refusal without retrying', async (status, code, reason) => {
        const requests: Request[] = [];
        await expect(
            queryRegistryRelease(
                REQUEST,
                runtime(() => failure(status, code, reason), requests),
            ),
        ).resolves.toEqual({ kind: 'refused', status, code, reason });
        expect(requests).toHaveLength(1);
    });

    it.each([
        [400, 'RELEASE_QUERY_INVALID_REQUEST', null, 'CLIENT_INPUT_INVALID'],
        [401, 'RELEASE_QUERY_UNAUTHORIZED', null, 'CLIENT_UNAUTHORIZED'],
        [404, 'RELEASE_QUERY_BUSY', null, 'CLIENT_RESPONSE_INVALID'],
        [422, 'RELEASE_QUERY_REJECTED', 'not-a-reason', 'CLIENT_RESPONSE_INVALID'],
        [406, 'RELEASE_QUERY_NOT_ACCEPTABLE', null, 'CLIENT_RESPONSE_INVALID'],
    ] as const)('maps %i %s to a closed client error', async (status, code, reason, expected) => {
        await expect(
            queryRegistryRelease(
                REQUEST,
                runtime(() => failure(status, code, reason)),
            ),
        ).rejects.toMatchObject({ code: expected });
    });

    it('reports a registry without release queries as not found', async () => {
        const bytes = new TextEncoder().encode(
            `${JSON.stringify({ code: 'NOT_FOUND', message: 'The endpoint was not found' })}\n`,
        );
        await expect(
            queryRegistryRelease(
                REQUEST,
                runtime(
                    () =>
                        new Response(new Blob([bytes]), {
                            status: 404,
                            headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
                        }),
                ),
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
    });

    it('validates inputs before any request', async () => {
        const requests: Request[] = [];
        const respond = runtime(() => success(), requests);
        for (const input of [
            { ...REQUEST, registryOrigin: `${ORIGIN}/` },
            { ...REQUEST, canonicalIri: 'not an iri' },
            { ...REQUEST, version: '^1.2.3' },
            { ...REQUEST, archiveSha256: 'A'.repeat(64) },
            { ...REQUEST, bearer: 'not-a-credential' },
            { ...REQUEST, query: new Uint8Array(0) },
        ]) {
            await expect(queryRegistryRelease(input, respond)).rejects.toMatchObject({ code: 'CLIENT_INPUT_INVALID' });
        }
        await expect(
            queryRegistryRelease({ ...REQUEST, query: new Uint8Array(8_193).fill(32) }, respond),
        ).rejects.toMatchObject({ code: 'CLIENT_TOO_LARGE' });
        expect(requests).toEqual([]);
    });
});
