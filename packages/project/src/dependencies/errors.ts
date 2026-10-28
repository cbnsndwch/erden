export type DependencyResolutionErrorCode =
    | 'alias-not-found'
    | 'alias-retarget'
    | 'catalog-failure'
    | 'catalog-identity-mismatch'
    | 'catalog-incoherent'
    | 'dependency-cycle'
    | 'existing-lock-mismatch'
    | 'frozen-shared-conflict'
    | 'invalid-resolver-input'
    | 'missing-version'
    | 'registry-required'
    | 'resolution-limit'
    | 'resolution-invariant'
    | 'search-exhausted'
    | 'self-dependency'
    | 'toolchain-incompatible'
    | 'version-conflict';

export type DependencyConstraintSource =
    | Readonly<{ readonly kind: 'root'; readonly identifier: string }>
    | Readonly<{
          readonly kind: 'package-edge';
          readonly fromCanonicalIri: string;
          readonly fromVersion: string;
      }>;

export interface DependencyConflictConstraint {
    readonly source: DependencyConstraintSource;
    readonly requested: string;
    readonly exactVersion: string | null;
    readonly archiveSha256: string | null;
}

export interface DependencyConflictDetails {
    readonly canonicalIri: string;
    readonly depth: number;
    readonly constraints: ReadonlyArray<DependencyConflictConstraint>;
}

const dependencyResolutionErrors = new WeakSet<object>();

export class DependencyResolutionError extends Error {
    readonly code: DependencyResolutionErrorCode;
    readonly conflict: DependencyConflictDetails | undefined;
    readonly frozenCanonicalIris: ReadonlyArray<string> | undefined;
    override readonly cause!: unknown;

    constructor(
        code: DependencyResolutionErrorCode,
        message: string,
        cause?: unknown,
        conflict?: DependencyConflictDetails,
        frozenCanonicalIris?: ReadonlyArray<string>,
    ) {
        super(message);
        this.name = 'DependencyResolutionError';
        this.code = code;
        this.conflict = conflict;
        this.frozenCanonicalIris =
            frozenCanonicalIris === undefined ? undefined : Object.freeze([...frozenCanonicalIris]);
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        dependencyResolutionErrors.add(this);
    }
}

/** Exact constructor brand check that performs no reflection on `value`. */
export function isDependencyResolutionError(value: unknown): value is DependencyResolutionError {
    return value !== null && typeof value === 'object' && dependencyResolutionErrors.has(value);
}
