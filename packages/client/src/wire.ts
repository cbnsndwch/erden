import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

export class RegistryClientError extends Error {
    readonly code:
        | 'CLIENT_ABORTED'
        | 'CLIENT_CONFLICT'
        | 'CLIENT_INPUT_INVALID'
        | 'CLIENT_NOT_FOUND'
        | 'CLIENT_RESPONSE_INVALID'
        | 'CLIENT_RETRYABLE'
        | 'CLIENT_RETRY_EXHAUSTED'
        | 'CLIENT_TIMEOUT'
        | 'CLIENT_TOO_LARGE'
        | 'CLIENT_TRANSPORT'
        | 'CLIENT_UNAUTHORIZED';

    constructor(code: RegistryClientError['code']) {
        const messages = {
            CLIENT_ABORTED: 'The registry request was cancelled',
            CLIENT_CONFLICT: 'The registry request conflicts with current state',
            CLIENT_INPUT_INVALID: 'The registry request is invalid',
            CLIENT_NOT_FOUND: 'The registry resource was not found',
            CLIENT_RESPONSE_INVALID: 'The registry response is invalid',
            CLIENT_RETRYABLE: 'The registry is temporarily unavailable',
            CLIENT_RETRY_EXHAUSTED: 'The registry request retry limit was reached',
            CLIENT_TIMEOUT: 'The registry request timed out',
            CLIENT_TOO_LARGE: 'The registry request exceeds a closed size limit',
            CLIENT_TRANSPORT: 'The registry request could not complete',
            CLIENT_UNAUTHORIZED: 'The registry request is not authorized',
        } as const;
        super(messages[code]);
        this.name = 'RegistryClientError';
        this.code = code;
        Object.freeze(this);
    }
}

function visit(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return value;
    }
    if (Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype) {
        return value.map(visit);
    }
    if (
        typeof value === 'object' &&
        !isProxy(value) &&
        Object.getPrototypeOf(value) === Object.prototype &&
        Object.getOwnPropertySymbols(value).length === 0
    ) {
        const output: Array<readonly [string, unknown]> = [];
        for (const key of Object.keys(value).sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new RegistryClientError('CLIENT_INPUT_INVALID');
            }
            output.push([key, visit(descriptor.value)]);
        }
        // `fromEntries` defines own properties, so a `__proto__` key is data rather than a prototype change.
        return Object.fromEntries(output);
    }
    throw new RegistryClientError('CLIENT_INPUT_INVALID');
}

export function encodeCanonicalJson(input: unknown): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(visit(input))}\n`);
}

export function decodeCanonicalJson(bytes: Uint8Array): unknown {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed: unknown = JSON.parse(text);
        if (!Buffer.from(encodeCanonicalJson(parsed)).equals(Buffer.from(bytes))) {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        return parsed;
    } catch (error) {
        if (error instanceof RegistryClientError) {
            throw error;
        }
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}

export function exactRecord(input: unknown, fields: ReadonlyArray<string>): Readonly<Record<string, unknown>> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        isProxy(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const names = Object.getOwnPropertyNames(input).sort();
    const expected = [...fields].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    return input as Readonly<Record<string, unknown>>;
}

export type RegistryJsonCache = 'no-store' | 'private' | 'public';

export function authenticateRegistryJsonHeaders(headers: Headers, bytes: Uint8Array, cache: RegistryJsonCache): void {
    const expectedCache =
        cache === 'no-store'
            ? 'no-store'
            : cache === 'private'
              ? 'private, no-store, no-transform'
              : 'public, max-age=0, must-revalidate, no-transform';
    if (
        headers.get('content-type') !== 'application/json; charset=utf-8' ||
        headers.get('cache-control') !== expectedCache ||
        headers.get('x-content-type-options') !== 'nosniff' ||
        headers.has('content-encoding') ||
        headers.has('location') ||
        headers.has('set-cookie')
    ) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const contentLength = headers.get('content-length');
    if (contentLength !== null && contentLength !== String(bytes.byteLength)) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    if (cache === 'no-store') {
        if (headers.has('etag') || headers.has('vary')) {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        return;
    }
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    if (headers.get('etag') !== etag || headers.get('vary') !== 'Authorization, Cookie, Origin') {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
}
