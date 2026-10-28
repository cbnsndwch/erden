export type ProjectPathErrorCode =
    | 'PROJECT_PATH_INVALID_INPUT'
    | 'PROJECT_PATH_MANIFEST_UNAVAILABLE'
    | 'PROJECT_PATH_TOOLCHAIN_UNAVAILABLE'
    | 'PROJECT_PATH_LOCK_INVALID'
    | 'PROJECT_PATH_LOCK_REQUIRED'
    | 'PROJECT_PATH_LOCK_STALE'
    | 'PROJECT_PATH_INSTALL_UNAVAILABLE'
    | 'PROJECT_PATH_LAYER_NOT_FOUND'
    | 'PROJECT_PATH_STORE_FAILURE';

export class ProjectPathError extends Error {
    readonly code: ProjectPathErrorCode;
    override readonly cause!: unknown;

    constructor(code: ProjectPathErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'ProjectPathError';
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
