export const RDF_COMPARISON_LIMITS = Object.freeze({
    maxInputBytes: 8 * 1_048_576,
    maxStatements: 100_000,
    maxBlankNodes: 10_000,
    maxComponents: 16_384,
    maxComponentStatements: 10_000,
    maxComponentBytes: 1_048_576,
    maxIriBytes: 4_096,
    maxLiteralBytes: 16_384,
    maxLanguageBytes: 128,
    maxBlankNodeBytes: 512,
    maxOutputBytes: 4 * 1_048_576,
    maxDeepIterations: 10_000,
    maxHashOperations: 100_000,
    maxHashBytes: 64 * 1_048_576,
    maxMilliseconds: 5_000,
    maxWorkers: 2,
    maxOldGenerationSizeMb: 128,
});

export type RdfComparisonSummaryReason =
    | 'input-limit'
    | 'statement-limit'
    | 'term-limit'
    | 'blank-node-limit'
    | 'component-limit'
    | 'canonicalization-limit'
    | 'output-limit';

export interface RdfComparisonComponent {
    /** Blank-node labels are scoped to this component and each instance. */
    readonly nquads: string;
    readonly sha256: string;
    readonly multiplicity: number;
    readonly quadCount: number;
}

export interface RdfComparisonComplete {
    readonly schema: 'erden.rdf-components/v1';
    readonly kind: 'complete';
    readonly quadCount: number;
    readonly components: ReadonlyArray<RdfComparisonComponent>;
}

export interface RdfComparisonSummary {
    readonly schema: 'erden.rdf-components/v1';
    readonly kind: 'summary';
    readonly reason: RdfComparisonSummaryReason;
}

export type RdfComparisonProjection = RdfComparisonComplete | RdfComparisonSummary;

export type RdfComparisonErrorCode =
    | 'RDF_COMPARISON_INPUT_INVALID'
    | 'RDF_COMPARISON_CANCELLED'
    | 'RDF_COMPARISON_UNAVAILABLE';

const messages: Readonly<Record<RdfComparisonErrorCode, string>> = Object.freeze({
    RDF_COMPARISON_INPUT_INVALID: 'The RDF comparison input is invalid',
    RDF_COMPARISON_CANCELLED: 'RDF comparison normalization was cancelled',
    RDF_COMPARISON_UNAVAILABLE: 'RDF comparison normalization is temporarily unavailable',
});

export class RdfComparisonError extends Error {
    readonly code: RdfComparisonErrorCode;

    constructor(code: RdfComparisonErrorCode) {
        super(messages[code]);
        this.name = 'RdfComparisonError';
        this.code = code;
        Object.freeze(this);
    }
}
