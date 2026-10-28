import type {
    Diagnostic,
    IncompatibilityReason,
    ReasonerProtocolVersion,
    RefusalReason,
    RequiredTool,
} from '@erden/reasoner-protocol';

import type { ProfilePartition } from './partition.js';

export type ReasonerNormalizationErrorCode =
    | 'AMBIGUOUS_PROPERTY_KIND'
    | 'CYCLIC_RDF_LIST'
    | 'DUPLICATE_SOURCE_ID'
    | 'INFERRED_INPUT_SOURCE'
    | 'INVALID_ASSEMBLED_ONTOLOGY'
    | 'INVALID_REASONER_INPUT'
    | 'MALFORMED_RDF_LIST'
    | 'MISSING_ASSERTED_PROVENANCE'
    | 'NAMED_GRAPH_UNSUPPORTED'
    | 'OUTSIDE_PROFILE'
    | 'RESERVED_TERM_ROLE'
    | 'UNREPRESENTABLE_RDF_TERM'
    | 'UNSUPPORTED_CLASS_EXPRESSION'
    | 'UNSUPPORTED_DATATYPE';

/** Where the statement a normalization error is about is written: its source's locator, line and column. */
export interface ReasonerNormalizationLocation {
    readonly file: string;
    readonly line: number;
    readonly column: number;
}

export class ReasonerNormalizationError extends Error {
    readonly code: ReasonerNormalizationErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;
    /** The statement the error is about, when there is one and its source position is known. */
    readonly location: ReasonerNormalizationLocation | undefined;

    constructor(
        code: ReasonerNormalizationErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
        location?: ReasonerNormalizationLocation,
    ) {
        super(message);
        this.name = 'ReasonerNormalizationError';
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
        this.location = location === undefined ? undefined : Object.freeze({ ...location });
    }
}

export type ReasonerProcessErrorCode =
    | 'BUNDLED_REASONER_UNAVAILABLE'
    | 'EMPTY_RESPONSE'
    | 'INVALID_RESPONSE_UTF8'
    | 'INVALID_EXECUTABLE_PATH'
    | 'INVALID_PROCESS_OUTPUT'
    | 'MALFORMED_RESPONSE'
    | 'NONCANONICAL_RESPONSE'
    | 'NONZERO_EXIT'
    | 'PROCESS_SPAWN_FAILED'
    | 'PROCESS_INTERRUPTED'
    | 'PROCESS_TIMEOUT'
    | 'REASONER_INCOMPATIBLE'
    | 'REASONER_NOT_LOCKED'
    | 'REASONER_REFUSED'
    | 'REQUEST_TOO_LARGE'
    | 'STDERR_OVERFLOW'
    | 'STDERR_STREAM_FAILED'
    | 'STDIN_FAILED'
    | 'STDOUT_OVERFLOW'
    | 'STDOUT_STREAM_FAILED'
    | 'UNTRUSTED_RESPONSE';

export class ReasonerProcessError extends Error {
    readonly code: ReasonerProcessErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
    override readonly cause: unknown;

    constructor(
        code: ReasonerProcessErrorCode,
        message: string,
        details: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = 'ReasonerProcessError';
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.cause = cause;
    }
}

interface TrustedNegativeReasonerContextBase {
    readonly protocolVersion: ReasonerProtocolVersion;
    readonly requestId: string;
    readonly profile: Readonly<{ readonly id: string; readonly digest: string }>;
    readonly tool: RequiredTool;
    readonly inputDigest: string;
    readonly diagnostics: ReadonlyArray<Diagnostic>;
    /** Normalized input axioms the request carried, so a max-input-axioms refusal can name the count. */
    readonly inputAxiomCount?: number;
    /** The profile partition the request was normalized under, report-mode findings and accepted annotations included. */
    readonly partition?: ProfilePartition;
    /** The quad keys of the root statements each axiom of the request was read from, to locate a diagnostic's axioms. */
    readonly axiomRoots?: ReadonlyMap<string, ReadonlyArray<string>>;
}

export type TrustedNegativeReasonerContext = TrustedNegativeReasonerContextBase &
    (
        | { readonly outcome: 'refused'; readonly reason: RefusalReason }
        | {
              readonly outcome: 'incompatible';
              readonly reason: IncompatibilityReason;
              readonly expected: string;
              readonly actual: string;
          }
    );

/** A negative semantic outcome whose response identity envelope was fully authenticated. */
export class TrustedNegativeReasonerOutcomeError extends ReasonerProcessError {
    readonly context: TrustedNegativeReasonerContext;

    constructor(context: TrustedNegativeReasonerContext) {
        const code = context.outcome === 'refused' ? 'REASONER_REFUSED' : 'REASONER_INCOMPATIBLE';
        super(
            code,
            `Bundled reasoner ${context.outcome}: ${context.reason}`,
            context.outcome === 'incompatible'
                ? {
                      outcome: context.outcome,
                      reason: context.reason,
                      expected: context.expected,
                      actual: context.actual,
                  }
                : { outcome: context.outcome, reason: context.reason },
        );
        this.name = 'TrustedNegativeReasonerOutcomeError';
        this.context = Object.freeze({
            ...context,
            profile: Object.freeze({ ...context.profile }),
            tool: Object.freeze({ ...context.tool }),
            diagnostics: Object.freeze(
                context.diagnostics.map((item) =>
                    Object.freeze({
                        ...item,
                        axiomIds: Object.freeze([...item.axiomIds]),
                    }),
                ),
            ),
        });
    }
}

export class OntologyInconsistencyError extends Error {
    readonly code = 'ONTOLOGY_INCONSISTENT';
    readonly diagnosticCodes: ReadonlyArray<string>;

    constructor(diagnosticCodes: ReadonlyArray<string>) {
        const sorted = Object.freeze([...diagnosticCodes].sort());
        super(
            `Reasoning proved the ontology globally inconsistent${sorted.length === 0 ? '' : `: ${sorted.join(', ')}`}`,
        );
        this.name = 'OntologyInconsistencyError';
        this.diagnosticCodes = sorted;
    }
}

export class ReasonerMaterializationError extends Error {
    readonly code = 'REASONER_MATERIALIZATION_FAILED';
    override readonly cause: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'ReasonerMaterializationError';
        this.cause = cause;
    }
}
