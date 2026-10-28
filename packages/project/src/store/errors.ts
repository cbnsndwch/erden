export type LocalPackageStoreErrorCode =
    | 'STORE_INVALID_INPUT'
    | 'STORE_ROOT_UNAVAILABLE'
    | 'STORE_OBJECT_MISSING'
    | 'STORE_OBJECT_BUSY'
    | 'STORE_REFERENCE_BUSY'
    | 'STORE_REFERENCE_INVALID'
    | 'STORE_PRUNE_BLOCKED'
    | 'STORE_PRUNE_LIMIT'
    | 'STORE_PRUNE_INTERRUPTED'
    | 'STORE_REPAIR_REQUIRED'
    | 'STORE_ARCHIVE_DIGEST_MISMATCH'
    | 'STORE_PACKAGE_IDENTITY_MISMATCH'
    | 'STORE_IO_FAILURE'
    | 'STORE_ROLLBACK_UNSAFE'
    | 'INSTALL_MISSING'
    | 'INSTALL_REPAIR_REQUIRED'
    | 'INSTALL_BUSY'
    | 'INSTALL_ROLLBACK_UNSAFE'
    | 'LAYER_NOT_FOUND';

const brandedErrors = new WeakSet<object>();

export class LocalPackageStoreError extends Error {
    readonly code: LocalPackageStoreErrorCode;
    override readonly cause!: unknown;

    constructor(code: LocalPackageStoreErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'LocalPackageStoreError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        brandedErrors.add(this);
        Object.freeze(this);
    }
}

/** Brand-safe over hostile Proxy values. */
export function isLocalPackageStoreError(value: unknown): value is LocalPackageStoreError {
    return value !== null && typeof value === 'object' && brandedErrors.has(value);
}
