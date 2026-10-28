import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { beginCliDeviceLogin, exchangeCliDeviceLogin, revokeCliDeviceCredential } from '../src/index.js';
import { encodeCanonicalJson } from '../src/wire.js';

const origin = 'https://registry.example';
const requestId = createHash('sha256').update('request').digest('base64url');
const payload = createHash('sha256').update('payload').digest('base64url');
const device = `erden_dvc_v1_d1_${payload}`;
const credential = `erden_cli_v1_d1_${payload}`;
function response(body: unknown, status: number): Response {
    return new Response(new Blob([encodeCanonicalJson(body) as Uint8Array<ArrayBuffer>]), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

describe('device login client', () => {
    it('strictly decodes begin, poll, credential, and revoke responses', async () => {
        const challenge = await beginCliDeviceLogin(origin, requestId, {
            fetch: () =>
                Promise.resolve(
                    response(
                        {
                            device_code: device,
                            expires_at: 1000,
                            interval: 5,
                            user_code: 'ABCD-EFGH',
                            verification_uri: `${origin}/api/v1/auth/device?user_code=ABCD-EFGH`,
                        },
                        201,
                    ),
                ),
        });
        expect(challenge.userCode).toBe('ABCD-EFGH');
        expect(
            await exchangeCliDeviceLogin(origin, device, {
                fetch: () => Promise.resolve(response({ interval: 10, status: 'slow-down' }, 202)),
            }),
        ).toEqual({ status: 'slow-down', intervalSeconds: 10 });
        expect(
            await exchangeCliDeviceLogin(origin, device, {
                fetch: () =>
                    Promise.resolve(
                        response(
                            {
                                access_token: credential,
                                expires_at: 2000,
                                token_type: 'Bearer',
                            },
                            200,
                        ),
                    ),
            }),
        ).toEqual({ status: 'credential', credential, expiresAt: 2000 });
        await expect(
            revokeCliDeviceCredential(origin, credential, {
                fetch: () => Promise.resolve(response({ revoked: true }, 200)),
            }),
        ).resolves.toBeUndefined();
    });

    it('rejects a cross-origin verification URI and substituted token grammar', async () => {
        await expect(
            beginCliDeviceLogin(origin, requestId, {
                fetch: () =>
                    Promise.resolve(
                        response(
                            {
                                device_code: device,
                                expires_at: 1000,
                                interval: 5,
                                user_code: 'ABCD-EFGH',
                                verification_uri: 'https://attacker.example/api/v1/auth/device?user_code=ABCD-EFGH',
                            },
                            201,
                        ),
                    ),
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        await expect(
            exchangeCliDeviceLogin(origin, device, {
                fetch: () =>
                    Promise.resolve(
                        response(
                            {
                                access_token: device,
                                expires_at: 2000,
                                token_type: 'Bearer',
                            },
                            200,
                        ),
                    ),
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        await expect(
            beginCliDeviceLogin(origin, requestId, {
                fetch: () =>
                    Promise.resolve(
                        response(
                            {
                                device_code: device,
                                expires_at: 1000,
                                interval: 31,
                                user_code: 'ABCD-EFGH',
                                verification_uri: `${origin}/api/v1/auth/device?user_code=ABCD-EFGH&next=https%3A%2F%2Fattacker.example`,
                            },
                            201,
                        ),
                    ),
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
    });

    it('retries transport loss and the exact retryable envelope, but not terminal or malformed errors', async () => {
        let exchangeCalls = 0;
        const sleeps: number[] = [];
        const exchanged = await exchangeCliDeviceLogin(origin, device, {
            fetch: () => {
                exchangeCalls += 1;
                if (exchangeCalls === 1) {
                    return Promise.reject(new Error('lost response'));
                }
                if (exchangeCalls === 2) {
                    return Promise.resolve(
                        response(
                            {
                                code: 'DEVICE_LOGIN_RETRYABLE',
                                message: 'Device login is temporarily unavailable',
                            },
                            503,
                        ),
                    );
                }
                return Promise.resolve(
                    response({ access_token: credential, expires_at: Date.now() + 10_000, token_type: 'Bearer' }, 200),
                );
            },
            sleep: (milliseconds) => {
                sleeps.push(milliseconds);
                return Promise.resolve();
            },
        });
        expect(exchanged).toMatchObject({ status: 'credential', credential });
        expect(exchangeCalls).toBe(3);
        expect(sleeps).toEqual([100, 200]);

        let terminalCalls = 0;
        await expect(
            exchangeCliDeviceLogin(origin, device, {
                fetch: () => {
                    terminalCalls += 1;
                    return Promise.resolve(
                        response({ code: 'ACCESS_DENIED', message: 'The device login was denied' }, 403),
                    );
                },
            }),
        ).resolves.toEqual({ status: 'denied' });
        expect(terminalCalls).toBe(1);

        await expect(
            exchangeCliDeviceLogin(origin, device, {
                fetch: () => Promise.resolve(response({ code: 'wrong', message: 'wrong' }, 400)),
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
        await expect(
            exchangeCliDeviceLogin(origin, device, {
                fetch: () => Promise.resolve(response({ code: 'wrong', message: 'wrong' }, 503)),
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
    });

    it('bounds retry exhaustion and clamps hostile response expiries to policy horizons', async () => {
        let attempts = 0;
        await expect(
            revokeCliDeviceCredential(origin, credential, {
                fetch: () => {
                    attempts += 1;
                    return Promise.reject(new Error('response lost'));
                },
                sleep: () => Promise.resolve(),
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_RETRY_EXHAUSTED' });
        expect(attempts).toBe(3);

        const before = Date.now();
        const challenge = await beginCliDeviceLogin(origin, requestId, {
            fetch: () =>
                Promise.resolve(
                    response(
                        {
                            device_code: device,
                            expires_at: Number.MAX_SAFE_INTEGER,
                            interval: 5,
                            user_code: 'ABCD-EFGH',
                            verification_uri: `${origin}/api/v1/auth/device?user_code=ABCD-EFGH`,
                        },
                        201,
                    ),
                ),
        });
        expect(challenge.expiresAt).toBeGreaterThanOrEqual(before);
        expect(challenge.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1_000);
    });

    it('cancels the active retry timer without another transport attempt', async () => {
        const controller = new AbortController();
        let attempts = 0;
        const pending = exchangeCliDeviceLogin(
            origin,
            device,
            {
                fetch: () => {
                    attempts += 1;
                    return Promise.reject(new Error('response lost'));
                },
            },
            controller.signal,
        );
        setTimeout(() => {
            controller.abort();
        }, 0);
        await expect(pending).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
        expect(attempts).toBe(1);
    });
});
