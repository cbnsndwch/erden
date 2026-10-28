import { normalizeRegistryOrigin } from '@erden/contracts';

import { RegistryClientError, decodeCanonicalJson, encodeCanonicalJson } from './wire.js';

export interface RegistryHttpRuntime {
    readonly fetch: typeof fetch;
    readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface RegistryJsonRequest {
    readonly registryOrigin: string;
    readonly path: string;
    readonly method: 'GET' | 'POST';
    readonly body?: unknown;
    readonly bearer?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMilliseconds?: number;
    readonly maximumResponseBytes?: number;
}

export interface RegistryJsonResponse {
    readonly status: number;
    readonly body: unknown;
}

export interface RegistryJsonWireResponse extends RegistryJsonResponse {
    readonly bytes: Uint8Array;
    readonly headers: Headers;
}

export interface RegistryHttpRequest {
    readonly registryOrigin: string;
    readonly path: string;
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: BodyInit;
    readonly streamingRequest?: boolean;
    readonly signal?: AbortSignal;
    readonly timeoutMilliseconds: number;
}

export interface OpenRegistryHttpResponse {
    readonly response: Response;
    readonly signal: AbortSignal;
    readonly finish: () => void;
}

const RETRY_ATTEMPTS = 3;

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

export async function retryRegistryTransport<Value>(
    operation: (attempt: number) => Promise<Value>,
    runtime: RegistryHttpRuntime | undefined,
    signal: AbortSignal | undefined,
): Promise<Value> {
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
        try {
            return await operation(attempt);
        } catch (error) {
            if (!retryable(error)) {
                throw error;
            }
            if (signal?.aborted === true) {
                throw new RegistryClientError('CLIENT_ABORTED');
            }
            if (attempt + 1 === RETRY_ATTEMPTS) {
                throw new RegistryClientError('CLIENT_RETRY_EXHAUSTED');
            }
            await retryDelay(100 * 2 ** attempt, runtime, signal);
        }
    }
    throw new RegistryClientError('CLIENT_RETRY_EXHAUSTED');
}

export async function readRegistryResponseBody(
    response: Response,
    maximum: number,
    signal: AbortSignal,
): Promise<Uint8Array> {
    function aborted(): boolean {
        return signal.aborted;
    }
    const body = response.body;
    if (aborted()) {
        if (body !== null && !body.locked) {
            try {
                await body.cancel();
            } catch {
                /* Preserve the closed cancellation error. */
            }
        }
        throw new RegistryClientError('CLIENT_ABORTED');
    }
    const reader = body?.getReader();
    if (reader === undefined) {
        throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
    }
    const responseReader = reader;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let cancellation: Promise<void> | undefined;
    function cancel(): void {
        cancellation ??= responseReader.cancel().catch(() => undefined);
    }
    if (aborted()) {
        cancel();
        await cancellation;
        reader.releaseLock();
        throw new RegistryClientError('CLIENT_ABORTED');
    }
    signal.addEventListener('abort', cancel, { once: true });
    if (aborted()) {
        cancel();
    }
    try {
        if (aborted()) {
            cancel();
            await cancellation;
            throw new RegistryClientError('CLIENT_ABORTED');
        }
        for (;;) {
            const next = await reader.read();
            if (next.done) {
                break;
            }
            size += next.value.byteLength;
            if (size > maximum) {
                throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
            }
            chunks.push(next.value);
        }
        return Buffer.concat(chunks, size);
    } catch (error) {
        cancel();
        await cancellation;
        throw error;
    } finally {
        signal.removeEventListener('abort', cancel);
        if (cancellation !== undefined) {
            await cancellation;
        }
        reader.releaseLock();
    }
}

export async function cancelRegistryResponseBody(response: Response): Promise<void> {
    if (response.body === null || response.body.locked) {
        return;
    }
    try {
        await response.body.cancel();
    } catch {
        /* Preserve the closed response error. */
    }
}

export async function openRegistryHttpResponse(
    raw: RegistryHttpRequest,
    runtime: RegistryHttpRuntime = Object.freeze({ fetch }),
): Promise<OpenRegistryHttpResponse> {
    let origin: string;
    let url: URL;
    try {
        origin = normalizeRegistryOrigin(raw.registryOrigin);
        if (origin !== raw.registryOrigin || !raw.path.startsWith('/') || raw.path.startsWith('//')) {
            throw new Error();
        }
        url = new URL(raw.path, origin);
        if (url.origin !== origin || `${url.origin}${url.pathname}${url.search}` !== `${origin}${raw.path}`) {
            throw new Error();
        }
    } catch {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    if (
        !Number.isSafeInteger(raw.timeoutMilliseconds) ||
        raw.timeoutMilliseconds < 1 ||
        raw.timeoutMilliseconds > 300000
    ) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new RegistryClientError('CLIENT_TIMEOUT'));
    }, raw.timeoutMilliseconds);
    timer.unref();
    const external = raw.signal;
    function abort(): void {
        controller.abort(new RegistryClientError('CLIENT_ABORTED'));
    }
    external?.addEventListener('abort', abort, { once: true });
    let finished = false;
    function finish(): void {
        if (finished) {
            return;
        }
        finished = true;
        clearTimeout(timer);
        external?.removeEventListener('abort', abort);
    }
    try {
        if (external?.aborted === true) {
            throw new RegistryClientError('CLIENT_ABORTED');
        }
        const init: RequestInit & {
            duplex?: 'half';
        } = {
            method: raw.method,
            redirect: 'manual',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal,
            headers: raw.headers,
            ...(raw.body === undefined ? {} : { body: raw.body }),
            ...(raw.streamingRequest === true ? { duplex: 'half' as const } : {}),
        };
        const response = await runtime.fetch(url, init);
        let responseOrigin: string | undefined;
        try {
            responseOrigin = response.url === '' ? undefined : new URL(response.url).origin;
        } catch {
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        if (
            response.redirected ||
            (response.status >= 300 && response.status < 400) ||
            (responseOrigin !== undefined && responseOrigin !== origin)
        ) {
            await cancelRegistryResponseBody(response);
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        if (controller.signal.aborted) {
            await cancelRegistryResponseBody(response);
            throw controller.signal.reason instanceof RegistryClientError
                ? controller.signal.reason
                : new RegistryClientError('CLIENT_TIMEOUT');
        }
        return Object.freeze({ response, signal: controller.signal, finish });
    } catch (error) {
        finish();
        if (external?.aborted === true) {
            throw new RegistryClientError('CLIENT_ABORTED');
        }
        if (controller.signal.aborted) {
            throw controller.signal.reason instanceof RegistryClientError
                ? controller.signal.reason
                : new RegistryClientError('CLIENT_TIMEOUT');
        }
        if (error instanceof RegistryClientError) {
            throw error;
        }
        throw new RegistryClientError('CLIENT_TRANSPORT');
    }
}

export async function requestRegistryJsonWire(
    raw: RegistryJsonRequest,
    runtime: RegistryHttpRuntime = Object.freeze({ fetch }),
): Promise<RegistryJsonWireResponse> {
    const timeout = raw.timeoutMilliseconds ?? 15000;
    const maximum = raw.maximumResponseBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) {
        throw new RegistryClientError('CLIENT_INPUT_INVALID');
    }
    const body = raw.body === undefined ? undefined : encodeCanonicalJson(raw.body);
    const bodyBlob = body === undefined ? undefined : new Blob([body as Uint8Array<ArrayBuffer>]);
    const opened = await openRegistryHttpResponse(
        {
            registryOrigin: raw.registryOrigin,
            path: raw.path,
            method: raw.method,
            headers: {
                accept: 'application/json',
                ...(body === undefined
                    ? {}
                    : { 'content-type': 'application/json', 'content-length': String(body.byteLength) }),
                ...(raw.bearer === undefined ? {} : { authorization: `Bearer ${raw.bearer}` }),
            },
            ...(bodyBlob === undefined ? {} : { body: bodyBlob }),
            ...(raw.signal === undefined ? {} : { signal: raw.signal }),
            timeoutMilliseconds: timeout,
        },
        runtime,
    );
    try {
        if (opened.response.headers.get('content-type') !== 'application/json; charset=utf-8') {
            await cancelRegistryResponseBody(opened.response);
            throw new RegistryClientError('CLIENT_RESPONSE_INVALID');
        }
        const bytes = await readRegistryResponseBody(opened.response, maximum, opened.signal);
        return Object.freeze({
            status: opened.response.status,
            body: decodeCanonicalJson(bytes),
            bytes,
            headers: opened.response.headers,
        });
    } finally {
        opened.finish();
    }
}

export async function requestRegistryJson(
    raw: RegistryJsonRequest,
    runtime: RegistryHttpRuntime = Object.freeze({ fetch }),
): Promise<RegistryJsonResponse> {
    const response = await requestRegistryJsonWire(raw, runtime);
    return Object.freeze({ status: response.status, body: response.body });
}
