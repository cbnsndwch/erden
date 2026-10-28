export type InitProjectErrorCode =
    | 'INIT_INVALID_OPTIONS'
    | 'INIT_PARENT_UNAVAILABLE'
    | 'INIT_TARGET_EXISTS'
    | 'INIT_TRANSACTION_FAILED'
    | 'INIT_ROLLBACK_UNSAFE';

export class InitProjectError extends Error {
    readonly code: InitProjectErrorCode;
    override readonly cause!: unknown;

    constructor(code: InitProjectErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'InitProjectError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
}
