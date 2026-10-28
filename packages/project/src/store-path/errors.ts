export type StorePathErrorCode = 'STORE_PATH_ENVIRONMENT_UNAVAILABLE';

export class StorePathError extends Error {
    readonly code: StorePathErrorCode;
    override readonly cause!: unknown;

    constructor(code: StorePathErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'StorePathError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        Object.freeze(this);
    }
}
