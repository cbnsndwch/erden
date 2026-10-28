export type StoreMaintenanceErrorCode =
    | 'STORE_MAINTENANCE_INVALID_INPUT'
    | 'STORE_MAINTENANCE_ENVIRONMENT_UNAVAILABLE'
    | 'STORE_MAINTENANCE_INDEX_UNAVAILABLE'
    | 'STORE_MAINTENANCE_PROJECT_UNAVAILABLE'
    | 'STORE_MAINTENANCE_PRUNE_BLOCKED';

const brandedErrors = new WeakSet<object>();

export class StoreMaintenanceError extends Error {
    readonly code: StoreMaintenanceErrorCode;
    override readonly cause!: unknown;

    constructor(code: StoreMaintenanceErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'StoreMaintenanceError';
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
export function isStoreMaintenanceError(value: unknown): value is StoreMaintenanceError {
    return value !== null && typeof value === 'object' && brandedErrors.has(value);
}
