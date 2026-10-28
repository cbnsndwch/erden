export type ProjectDependenciesErrorCode =
    | 'PROJECT_DEPENDENCIES_INVALID_INPUT'
    | 'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE'
    | 'PROJECT_DEPENDENCIES_LOCK_REQUIRED'
    | 'PROJECT_DEPENDENCIES_REGISTRY_REQUIRED'
    | 'PROJECT_DEPENDENCIES_REGISTRY_UNAVAILABLE'
    | 'PROJECT_DEPENDENCIES_REGISTRY_INTEGRITY'
    | 'PROJECT_DEPENDENCIES_RESOLUTION_FAILED'
    | 'PROJECT_DEPENDENCIES_UPDATE_FROZEN_CONFLICT'
    | 'PROJECT_DEPENDENCIES_DUPLICATE_CANONICAL'
    | 'PROJECT_DEPENDENCIES_NOT_FOUND'
    | 'PROJECT_DEPENDENCIES_AMBIGUOUS_IDENTIFIER'
    | 'PROJECT_DEPENDENCIES_COMMIT_FAILED'
    | 'PROJECT_DEPENDENCIES_INSTALL_FAILED'
    | 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED'
    | 'PROJECT_DEPENDENCIES_REPORT_INVALID';

const branded = new WeakSet<object>();

export class ProjectDependenciesError extends Error {
    readonly code: ProjectDependenciesErrorCode;
    override readonly cause!: unknown;

    constructor(code: ProjectDependenciesErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'ProjectDependenciesError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        branded.add(this);
        if (new.target === ProjectDependenciesError) {
            Object.freeze(this);
        }
    }
}

export class ProjectDependenciesCommittedError extends ProjectDependenciesError {
    readonly committed: Readonly<{ readonly manifestSha256: string; readonly lockSha256: string }>;

    constructor(
        committed: Readonly<{ readonly manifestSha256: string; readonly lockSha256: string }>,
        cause?: unknown,
    ) {
        super(
            'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED',
            'Dependency intent was committed, but its exact installation did not complete; run erden install to retry',
            cause,
        );
        this.name = 'ProjectDependenciesCommittedError';
        this.committed = Object.freeze({
            manifestSha256: committed.manifestSha256,
            lockSha256: committed.lockSha256,
        });
        Object.freeze(this);
    }
}

export class ProjectDependenciesFrozenConflictError extends ProjectDependenciesError {
    readonly frozenCanonicalIris: ReadonlyArray<string>;

    constructor(frozenCanonicalIris: ReadonlyArray<string>, cause?: unknown) {
        super(
            'PROJECT_DEPENDENCIES_UPDATE_FROZEN_CONFLICT',
            'A newer target release requires changing packages shared with another authored dependency',
            cause,
        );
        this.name = 'ProjectDependenciesFrozenConflictError';
        this.frozenCanonicalIris = Object.freeze([...frozenCanonicalIris]);
        Object.freeze(this);
    }
}

export function isProjectDependenciesError(value: unknown): value is ProjectDependenciesError {
    return value !== null && typeof value === 'object' && branded.has(value);
}
