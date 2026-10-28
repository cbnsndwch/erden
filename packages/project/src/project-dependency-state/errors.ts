export type ProjectDependencyStateErrorCode =
    | 'PROJECT_DEPENDENCY_STATE_INVALID_INPUT'
    | 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE'
    | 'PROJECT_DEPENDENCY_STATE_LOCK_INVALID'
    | 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT'
    | 'PROJECT_DEPENDENCY_STATE_STALE_REVISION'
    | 'PROJECT_DEPENDENCY_STATE_IO_FAILURE'
    | 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE';

const brandedErrors = new WeakSet<object>();

export class ProjectDependencyStateError extends Error {
    readonly code: ProjectDependencyStateErrorCode;

    constructor(code: ProjectDependencyStateErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'ProjectDependencyStateError';
        this.code = code;
        if (cause !== undefined) {
            Object.defineProperty(this, 'cause', {
                value: cause,
                enumerable: false,
                configurable: false,
                writable: false,
            });
        }
        brandedErrors.add(this);
        Object.freeze(this);
    }
}

/** Brand-safe over hostile Proxy values. */
export function isProjectDependencyStateError(value: unknown): value is ProjectDependencyStateError {
    return value !== null && typeof value === 'object' && brandedErrors.has(value);
}
