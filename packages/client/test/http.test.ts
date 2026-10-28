import { describe, expect, it } from 'vitest';

import { requestRegistryJson, requestRegistryJsonWire } from '../src/http.js';
import { RegistryClientError, encodeCanonicalJson } from '../src/wire.js';

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(new Blob([encodeCanonicalJson(body) as Uint8Array<ArrayBuffer>]), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });
}

describe('registry HTTP boundary', () => {
    it('uses a fixed canonical origin, canonical JSON, no redirects, and no ambient credentials', async () => {
        const requests: Request[] = [];
        const result = await requestRegistryJson(
            {
                registryOrigin: 'https://registry.example',
                path: '/api/v1/test',
                method: 'POST',
                body: { z: 1, a: true },
                bearer: 'safe-bearer',
            },
            {
                fetch: (input, init) => {
                    requests.push(new Request(input, init));
                    return Promise.resolve(response({ ok: true }));
                },
            },
        );
        expect(result).toEqual({ status: 200, body: { ok: true } });
        expect(requests[0]?.url).toBe('https://registry.example/api/v1/test');
        expect(requests[0]?.redirect).toBe('manual');
        expect(requests[0]?.credentials).toBe('omit');
        expect(await requests[0]?.text()).toBe('{"a":true,"z":1}\n');
    });

    it('rejects cross-origin paths, redirects, noncanonical bytes, oversized bodies, and cancellation', async () => {
        await expect(
            requestRegistryJson({
                registryOrigin: 'https://registry.example',
                path: '//attacker.example/path',
                method: 'GET',
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_INPUT_INVALID' });
        await expect(
            requestRegistryJson(
                {
                    registryOrigin: 'https://registry.example',
                    path: '/redirect',
                    method: 'GET',
                },
                {
                    fetch: () =>
                        Promise.resolve(
                            new Response(null, { status: 307, headers: { location: 'https://attacker.example' } }),
                        ),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        await expect(
            requestRegistryJson(
                {
                    registryOrigin: 'https://registry.example',
                    path: '/bad',
                    method: 'GET',
                },
                {
                    fetch: () =>
                        Promise.resolve(
                            new Response('{ "ok": true }\n', {
                                headers: { 'content-type': 'application/json; charset=utf-8' },
                            }),
                        ),
                },
            ),
        ).rejects.toBeInstanceOf(RegistryClientError);
        await expect(
            requestRegistryJson(
                {
                    registryOrigin: 'https://registry.example',
                    path: '/large',
                    method: 'GET',
                    maximumResponseBytes: 4,
                },
                { fetch: () => Promise.resolve(response({ value: 'too-large' })) },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        const controller = new AbortController();
        controller.abort();
        await expect(
            requestRegistryJson({
                registryOrigin: 'https://registry.example',
                path: '/cancel',
                method: 'GET',
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
    });

    it('cancels an active request and distinguishes its bounded deadline', async () => {
        const active = new AbortController();
        const pending = requestRegistryJson(
            {
                registryOrigin: 'https://registry.example',
                path: '/active-cancel',
                method: 'GET',
                signal: active.signal,
            },
            {
                fetch: async (_input, init) =>
                    await new Promise<Response>((_resolve, reject) => {
                        const signal = init?.signal;
                        if (!(signal instanceof AbortSignal)) {
                            throw new Error('Expected request abort signal');
                        }
                        signal.addEventListener(
                            'abort',
                            () => {
                                reject(new Error('request aborted'));
                            },
                            { once: true },
                        );
                    }),
            },
        );
        active.abort();
        await expect(pending).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });

        await expect(
            requestRegistryJson(
                {
                    registryOrigin: 'https://registry.example',
                    path: '/deadline',
                    method: 'GET',
                    timeoutMilliseconds: 1,
                },
                {
                    fetch: async (_input, init) =>
                        await new Promise<Response>((_resolve, reject) => {
                            const signal = init?.signal;
                            if (!(signal instanceof AbortSignal)) {
                                throw new Error('Expected request abort signal');
                            }
                            signal.addEventListener(
                                'abort',
                                () => {
                                    reject(new Error('request aborted'));
                                },
                                { once: true },
                            );
                        }),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_TIMEOUT' });
    });

    it('awaits cancellation of oversized and header-invalid response streams', async () => {
        let oversizedCancelled = false;
        let oversizedSettled = false;
        const oversized = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(new Uint8Array(8));
            },
            cancel: async () => {
                oversizedCancelled = true;
                await Promise.resolve();
                oversizedSettled = true;
            },
        });
        await expect(
            requestRegistryJson(
                {
                    registryOrigin: 'https://registry.example',
                    path: '/oversized-stream',
                    method: 'GET',
                    maximumResponseBytes: 4,
                },
                {
                    fetch: () =>
                        Promise.resolve(
                            new Response(oversized, {
                                headers: { 'content-type': 'application/json; charset=utf-8' },
                            }),
                        ),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        expect({ oversizedCancelled, oversizedSettled }).toEqual({ oversizedCancelled: true, oversizedSettled: true });

        let earlySettled = false;
        const wrongType = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(new Uint8Array([1]));
            },
            cancel: async () => {
                await Promise.resolve();
                earlySettled = true;
            },
        });
        await expect(
            requestRegistryJson(
                {
                    registryOrigin: 'https://registry.example',
                    path: '/wrong-type',
                    method: 'GET',
                },
                {
                    fetch: () =>
                        Promise.resolve(new Response(wrongType, { headers: { 'content-type': 'text/plain' } })),
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        expect(earlySettled).toBe(true);
    });

    it('cancels a still-open response when fetch returns after the caller already aborted', async () => {
        const controller = new AbortController();
        let cancelled = false;
        let settled = false;
        const stream = new ReadableStream<Uint8Array>({
            start: (producer) => {
                producer.enqueue(new TextEncoder().encode('{"ok":'));
            },
            cancel: async () => {
                cancelled = true;
                await Promise.resolve();
                settled = true;
            },
        });
        await expect(
            requestRegistryJson(
                {
                    registryOrigin: 'https://registry.example',
                    path: '/abort-before-response',
                    method: 'GET',
                    signal: controller.signal,
                },
                {
                    fetch: () => {
                        controller.abort();
                        return Promise.resolve(
                            new Response(stream, {
                                headers: { 'content-type': 'application/json; charset=utf-8' },
                            }),
                        );
                    },
                },
            ),
        ).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
        expect({ cancelled, settled }).toEqual({ cancelled: true, settled: true });
    });

    it('retains exact canonical bytes and controlled headers for strict higher-level codecs', async () => {
        const body = { schema: 'erden.test/v1', value: 1 };
        const bytes = encodeCanonicalJson(body);
        const wire = await requestRegistryJsonWire(
            {
                registryOrigin: 'https://registry.example',
                path: '/wire',
                method: 'GET',
                maximumResponseBytes: 1_024,
            },
            {
                fetch: () =>
                    Promise.resolve(
                        new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
                            headers: {
                                'content-type': 'application/json; charset=utf-8',
                                'x-content-type-options': 'nosniff',
                            },
                        }),
                    ),
            },
        );
        expect(wire.body).toEqual(body);
        expect(Buffer.from(wire.bytes)).toEqual(Buffer.from(bytes));
        expect(wire.headers.get('x-content-type-options')).toBe('nosniff');
    });
});
