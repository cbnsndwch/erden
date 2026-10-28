export type RegistryReleaseIndexErrorCode =
    | 'REGISTRY_INDEX_CURSOR_INVALID'
    | 'REGISTRY_INDEX_INPUT_INVALID'
    | 'REGISTRY_INDEX_LIMIT_EXCEEDED'
    | 'REGISTRY_INDEX_STATE_CONFLICT'
    | 'REGISTRY_INDEX_UNAVAILABLE';

const registryReleaseIndexErrors = new WeakSet<object>();

export class RegistryReleaseIndexError extends Error {
    readonly code: RegistryReleaseIndexErrorCode;
    override readonly cause!: unknown;

    constructor(code: RegistryReleaseIndexErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'RegistryReleaseIndexError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        registryReleaseIndexErrors.add(this);
    }
}

export function isRegistryReleaseIndexError(value: unknown): value is RegistryReleaseIndexError {
    return value !== null && typeof value === 'object' && registryReleaseIndexErrors.has(value);
}

export function registryIndexInputInvalid(): RegistryReleaseIndexError {
    return new RegistryReleaseIndexError('REGISTRY_INDEX_INPUT_INVALID', 'The registry release-index input is invalid');
}

export function normalizeRegistryReleaseIndexError(
    value: unknown,
    fallback: RegistryReleaseIndexErrorCode,
    allowed: ReadonlySet<RegistryReleaseIndexErrorCode>,
): RegistryReleaseIndexError {
    if (isRegistryReleaseIndexError(value) && allowed.has(value.code)) {
        return value;
    }
    return new RegistryReleaseIndexError(
        fallback,
        fallback === 'REGISTRY_INDEX_UNAVAILABLE'
            ? 'The registry release index is unavailable'
            : 'The registry release index returned invalid state',
    );
}
