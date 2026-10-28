export type LockfileErrorCode =
    | 'lockfile-syntax'
    | 'lockfile-schema'
    | 'lockfile-noncanonical'
    | 'lockfile-truth'
    | 'lockfile-version';

/** Deterministic lockfile failure with a deliberately non-enumerable underlying cause. */
export class LockfileError extends Error {
    readonly code: LockfileErrorCode;
    override readonly cause!: unknown;

    constructor(code: LockfileErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'LockfileError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
}
