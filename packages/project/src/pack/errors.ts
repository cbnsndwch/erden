export type PackProjectErrorCode =
    | 'PACK_PROJECT_INVALID_INPUT'
    | 'PACK_PROJECT_MANIFEST_UNAVAILABLE'
    | 'PACK_PROJECT_MANIFEST_NOT_PORTABLE'
    | 'PACK_PROJECT_TOOLCHAIN_UNAVAILABLE'
    | 'PACK_PROJECT_LOCK_INVALID'
    | 'PACK_PROJECT_REQUIRED_FILE_IGNORED'
    | 'PACK_PROJECT_DEPENDENCY_UNREPRESENTABLE'
    | 'PACK_PROJECT_SOURCE_INVALID'
    | 'PACK_PROJECT_CODEC_FAILURE'
    | 'PACK_PROJECT_OUTPUT_EXISTS'
    | 'PACK_PROJECT_TRANSACTION_FAILED'
    | 'PACK_PROJECT_ROLLBACK_UNSAFE';

const branded = new WeakSet<object>();

export class PackProjectError extends Error {
    readonly code: PackProjectErrorCode;
    override readonly cause!: unknown;

    constructor(code: PackProjectErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'PackProjectError';
        this.code = code;
        Object.defineProperty(this, 'cause', { value: cause, enumerable: false, configurable: false, writable: false });
        branded.add(this);
        Object.freeze(this);
    }
}

export function isPackProjectError(value: unknown): value is PackProjectError {
    return value !== null && typeof value === 'object' && branded.has(value);
}
