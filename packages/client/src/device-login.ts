import {
    DEVICE_LOGIN_LIMITS,
    decodeDeviceLoginRequestId,
    decodeDeviceLoginUserCode,
    normalizeRegistryOrigin,
    parseCliCredential,
    parseDeviceSecret,
} from '@erden/contracts';

import { requestRegistryJson, type RegistryHttpRuntime } from './http.js';
import { RegistryClientError, exactRecord } from './wire.js';

export interface ClientDeviceChallenge {
    readonly registryOrigin: string;
    readonly requestId: string;
    readonly deviceSecret: string;
    readonly userCode: string;
    readonly verificationUrl: string;
    readonly expiresAt: number;
    readonly intervalSeconds: number;
}

export type ClientDeviceExchange = Readonly<
    | { status: 'pending' | 'slow-down'; intervalSeconds: number }
    | { status: 'denied' | 'invalid' }
    | { status: 'credential'; credential: string; expiresAt: number }
>;

function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function safeInteger(input: unknown): number {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return input;
}

function boundedExpiry(input: unknown, lifetimeMilliseconds: number): number {
    return Math.min(safeInteger(input), Date.now() + lifetimeMilliseconds);
}

const CLIENT_RETRY_ATTEMPTS = 3;
const CLIENT_RETRY_DELAY_MILLISECONDS = 100;

function retryable(error: unknown): boolean {
    return (
        error instanceof RegistryClientError &&
        (error.code === 'CLIENT_RETRYABLE' || error.code === 'CLIENT_TIMEOUT' || error.code === 'CLIENT_TRANSPORT')
    );
}

async function retryDelay(
    milliseconds: number,
    runtime: RegistryHttpRuntime | undefined,
    signal: AbortSignal | undefined,
): Promise<void> {
    function aborted(): boolean {
        return signal?.aborted === true;
    }
    if (aborted()) {
        throw new RegistryClientError('CLIENT_ABORTED');
    }
    if (runtime?.sleep !== undefined) {
        try {
            await runtime.sleep(milliseconds, signal);
        } catch (error) {
            if (aborted()) {
                throw new RegistryClientError('CLIENT_ABORTED');
            }
            if (error instanceof RegistryClientError) {
                throw error;
            }
            throw new RegistryClientError('CLIENT_TRANSPORT');
        }
        if (aborted()) {
            throw new RegistryClientError('CLIENT_ABORTED');
        }
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(finish, milliseconds);
        function abort(): void {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(new RegistryClientError('CLIENT_ABORTED'));
        }
        function finish(): void {
            signal?.removeEventListener('abort', abort);
            resolve();
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
}

async function retryOperation<Value>(
    operation: () => Promise<Value>,
    runtime: RegistryHttpRuntime | undefined,
    signal: AbortSignal | undefined,
): Promise<Value> {
    for (let attempt = 0; attempt < CLIENT_RETRY_ATTEMPTS; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (!retryable(error)) {
                throw error;
            }
            if (signal?.aborted === true) {
                throw new RegistryClientError('CLIENT_ABORTED');
            }
            if (attempt + 1 === CLIENT_RETRY_ATTEMPTS) {
                throw new RegistryClientError('CLIENT_RETRY_EXHAUSTED');
            }
            await retryDelay(CLIENT_RETRY_DELAY_MILLISECONDS * 2 ** attempt, runtime, signal);
        }
    }
    throw new RegistryClientError('CLIENT_RETRY_EXHAUSTED');
}

function exactError(
    response: Readonly<{
        status: number;
        body: unknown;
    }>,
    status: number,
    code: string,
    message: string,
): boolean {
    if (response.status !== status) {
        return false;
    }
    const record = exactRecord(response.body, ['code', 'message']);
    if (own(record, 'code') !== code || own(record, 'message') !== message) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return true;
}

function throwIfRetryable(
    response: Readonly<{
        status: number;
        body: unknown;
    }>,
): void {
    if (exactError(response, 503, 'DEVICE_LOGIN_RETRYABLE', 'Device login is temporarily unavailable')) {
        throw new RegistryClientError('CLIENT_RETRYABLE');
    }
}

export async function beginCliDeviceLogin(
    registryOrigin: string,
    requestId: string,
    runtime?: RegistryHttpRuntime,
    signal?: AbortSignal,
): Promise<ClientDeviceChallenge> {
    let origin: string;
    let canonicalRequestId: string;
    try {
        origin = normalizeRegistryOrigin(registryOrigin);
        if (origin !== registryOrigin) {
            throw new Error();
        }
        canonicalRequestId = decodeDeviceLoginRequestId(requestId);
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const response = await retryOperation(
        async () => {
            const result = await requestRegistryJson(
                {
                    registryOrigin: origin,
                    path: '/api/v1/auth/device/code',
                    method: 'POST',
                    body: { request_id: canonicalRequestId },
                    ...(signal === undefined ? {} : { signal }),
                },
                runtime,
            );
            throwIfRetryable(result);
            return result;
        },
        runtime,
        signal,
    );
    if (exactError(response, 400, 'REQUEST_INVALID', 'The request is invalid')) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (exactError(response, 409, 'DEVICE_LOGIN_CONFLICT', 'The device login request conflicts')) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (response.status !== 201) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const record = exactRecord(response.body, [
        'device_code',
        'expires_at',
        'interval',
        'user_code',
        'verification_uri',
    ]);
    const deviceSecret = own(record, 'device_code');
    const userCode = own(record, 'user_code');
    const verificationUrl = own(record, 'verification_uri');
    const intervalSeconds = safeInteger(own(record, 'interval'));
    let canonicalUserCode: string;
    try {
        canonicalUserCode = decodeDeviceLoginUserCode(userCode);
    } catch {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    if (
        typeof deviceSecret !== 'string' ||
        parseDeviceSecret(deviceSecret) === null ||
        typeof userCode !== 'string' ||
        canonicalUserCode !== userCode ||
        typeof verificationUrl !== 'string' ||
        verificationUrl !== `${origin}/api/v1/auth/device?user_code=${encodeURIComponent(canonicalUserCode)}` ||
        intervalSeconds < 5 ||
        intervalSeconds > 30
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return Object.freeze({
        registryOrigin: origin,
        requestId: canonicalRequestId,
        deviceSecret,
        userCode: canonicalUserCode,
        verificationUrl,
        expiresAt: boundedExpiry(own(record, 'expires_at'), DEVICE_LOGIN_LIMITS.deviceLifetimeMilliseconds),
        intervalSeconds,
    });
}

export async function exchangeCliDeviceLogin(
    registryOrigin: string,
    deviceSecret: string,
    runtime?: RegistryHttpRuntime,
    signal?: AbortSignal,
): Promise<ClientDeviceExchange> {
    if (parseDeviceSecret(deviceSecret) === null) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const response = await retryOperation(
        async () => {
            const result = await requestRegistryJson(
                {
                    registryOrigin,
                    path: '/api/v1/auth/device/token',
                    method: 'POST',
                    body: { device_code: deviceSecret },
                    ...(signal === undefined ? {} : { signal }),
                },
                runtime,
            );
            throwIfRetryable(result);
            return result;
        },
        runtime,
        signal,
    );
    if (response.status === 200) {
        const record = exactRecord(response.body, ['access_token', 'expires_at', 'token_type']);
        const credential = own(record, 'access_token');
        if (
            own(record, 'token_type') !== 'Bearer' ||
            typeof credential !== 'string' ||
            parseCliCredential(credential) === null
        ) {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        return Object.freeze({
            status: 'credential',
            credential,
            expiresAt: boundedExpiry(own(record, 'expires_at'), DEVICE_LOGIN_LIMITS.credentialLifetimeMilliseconds),
        });
    }
    if (response.status === 202) {
        const record = exactRecord(response.body, ['interval', 'status']);
        const status = own(record, 'status');
        const intervalSeconds = safeInteger(own(record, 'interval'));
        if ((status !== 'pending' && status !== 'slow-down') || intervalSeconds < 5 || intervalSeconds > 30) {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        return Object.freeze({ status, intervalSeconds });
    }
    if (exactError(response, 403, 'ACCESS_DENIED', 'The device login was denied')) {
        return Object.freeze({ status: 'denied' });
    }
    if (exactError(response, 400, 'DEVICE_CODE_INVALID', 'The device login is invalid')) {
        return Object.freeze({ status: 'invalid' });
    }
    throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
}

export async function revokeCliDeviceCredential(
    registryOrigin: string,
    credential: string,
    runtime?: RegistryHttpRuntime,
    signal?: AbortSignal,
): Promise<void> {
    if (parseCliCredential(credential) === null) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const response = await retryOperation(
        async () => {
            const result = await requestRegistryJson(
                {
                    registryOrigin,
                    path: '/api/v1/auth/credentials/revoke',
                    method: 'POST',
                    bearer: credential,
                    ...(signal === undefined ? {} : { signal }),
                },
                runtime,
            );
            throwIfRetryable(result);
            return result;
        },
        runtime,
        signal,
    );
    if (exactError(response, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required')) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const record = exactRecord(response.body, ['revoked']);
    if (response.status !== 200 || own(record, 'revoked') !== true) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}
