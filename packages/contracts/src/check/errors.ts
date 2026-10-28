export type CheckProjectOperationalStage = 'manifest' | 'dependencies' | 'sources' | 'reasoning' | 'validation';

/**
 * A statement outside the V1 profile, as structured data beside the diagnostic's message. Additive: diagnostics of
 * other kinds have no `finding`.
 */
export interface CheckProjectErrorDiagnosticFinding {
    readonly group: 'annotation' | 'unreasoned';
    /** Erden's construct label, as in the message's `[group/construct]` prefix and the report's `unreasoned`. */
    readonly construct: string;
    /** The OWL 2 structural construct, such as `ObjectSomeValuesFrom`; null when there is none. */
    readonly owlConstruct: string | null;
    /** The root statement's named subject; null for an anonymous structure, which `description` names instead. */
    readonly subject: string | null;
    readonly predicate: string;
    readonly object: string | null;
    readonly datatype?: string;
    readonly statementCount: number;
    /** The finding's statements in OWL functional-style syntax, bounded. */
    readonly description: string;
}

export interface CheckProjectErrorDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly file: string | null;
    readonly line: number | null;
    readonly column: number | null;
    readonly finding?: CheckProjectErrorDiagnosticFinding;
}

export class CheckProjectOperationalError extends Error {
    readonly code: string;
    readonly stage: CheckProjectOperationalStage;
    readonly diagnostics: ReadonlyArray<CheckProjectErrorDiagnostic>;
    override readonly cause!: unknown;

    constructor(
        code: string,
        stage: CheckProjectOperationalStage,
        message: string,
        diagnostics: ReadonlyArray<CheckProjectErrorDiagnostic> = [],
        cause?: unknown,
    ) {
        super(message);
        this.name = 'CheckProjectOperationalError';
        this.code = code;
        this.stage = stage;
        this.diagnostics = Object.freeze(
            diagnostics.map((diagnostic) =>
                Object.freeze(
                    diagnostic.finding === undefined
                        ? { ...diagnostic }
                        : { ...diagnostic, finding: Object.freeze({ ...diagnostic.finding }) },
                ),
            ),
        );
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
}

export class CheckProjectDependenciesUnavailableError extends CheckProjectOperationalError {
    readonly dependencies: ReadonlyArray<Readonly<{ readonly identifier: string; readonly range: string }>>;

    constructor(dependencies: ReadonlyArray<Readonly<{ readonly identifier: string; readonly range: string }>>) {
        const sorted = Object.freeze(
            [...dependencies]
                .sort((left, right) =>
                    left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0,
                )
                .map((item) => Object.freeze({ ...item })),
        );
        super(
            'PROJECT_DEPENDENCIES_UNAVAILABLE',
            'sources',
            'Project dependencies require the Slice 2 lock/install closure and cannot be omitted from a Slice 1 check',
            sorted.map((item) => ({
                code: 'dependency-closure-unavailable',
                message: `${item.identifier} ${item.range}`,
                file: null,
                line: null,
                column: null,
            })),
        );
        this.name = 'CheckProjectDependenciesUnavailableError';
        this.dependencies = sorted;
    }
}

export type CheckProjectError = CheckProjectOperationalError | CheckProjectDependenciesUnavailableError;
