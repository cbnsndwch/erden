import type { RdfComparisonComplete, RdfComparisonSummaryReason } from '../comparison-rdf/model.js';

import type { CapturedShapeSource, ShaclEvidenceSummary } from './model.js';

export const SHACL_RDF_LIMITS = Object.freeze({
    maxSources: 4_096,
    maxStatements: 25_000,
    maxSourceBytes: 8 * 1_048_576,
    maxEncodedBytes: 8 * 1_048_576,
    maxOutputBytes: 4 * 1_048_576,
});

export interface ShaclRdfSource extends Omit<CapturedShapeSource, 'quads'> {
    readonly quadCount: number;
}

/** Contextual RDF only; successful publication, validation policy, and self-test outcomes remain separate bindings. */
export interface ShaclRdfComplete {
    readonly schema: 'erden.shacl-rdf/v1';
    readonly kind: 'complete';
    readonly sources: ReadonlyArray<ShaclRdfSource>;
    readonly quadCounts: Readonly<{ data: number; shapes: number; report: number }>;
    /** Canonical contextual encoding, not a union of the original RDF datasets. */
    readonly rdf: RdfComparisonComplete;
}

export type ShaclRdfSummary = Readonly<{
    schema: 'erden.shacl-rdf/v1';
    kind: 'summary';
}> &
    (
        | Readonly<{ stage: 'capture'; reason: ShaclEvidenceSummary['reason'] }>
        | Readonly<{
              stage: 'projection';
              reason:
                  | 'source-limit'
                  | 'statement-limit'
                  | 'input-limit'
                  | 'term-limit'
                  | 'encoded-limit'
                  | 'output-limit';
          }>
        | Readonly<{ stage: 'normalization'; reason: RdfComparisonSummaryReason }>
    );

export type ShaclRdfProjection = ShaclRdfComplete | ShaclRdfSummary;

/** Internal capacity signal; callers receive only its closed summary. */
export class ShaclProjectionCapacity extends Error {
    constructor(readonly summary: ShaclRdfSummary) {
        super('The contextual SHACL projection exceeded a capacity limit');
    }
}
