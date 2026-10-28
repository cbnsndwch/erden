export type ProjectLockErrorCode =
    | 'PROJECT_LOCK_INVALID_INPUT'
    | 'PROJECT_LOCK_ROOT_UNAVAILABLE'
    | 'PROJECT_LOCK_INVALID'
    | 'PROJECT_LOCK_IO_FAILURE'
    | 'PROJECT_LOCK_ROLLBACK_UNSAFE';

export class ProjectLockError extends Error {
    readonly code: ProjectLockErrorCode;
    override readonly cause!: unknown;

    constructor(code: ProjectLockErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'ProjectLockError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
}
