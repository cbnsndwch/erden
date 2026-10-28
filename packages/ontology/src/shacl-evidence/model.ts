export const SHACL_EVIDENCE_LIMITS = Object.freeze({
    maxSources: 4_096,
    maxStatements: 25_000,
    maxBytes: 8 * 1_048_576,
    maxSourceIdBytes: 1_024,
});

export interface CapturedNamedNode {
    readonly termType: 'NamedNode';
    readonly value: string;
}
export interface CapturedBlankNode {
    readonly termType: 'BlankNode';
    /** Snapshot-local label; never a cross-release identity. */
    readonly value: string;
}
export interface CapturedLiteral {
    readonly termType: 'Literal';
    readonly value: string;
    readonly language: string;
    readonly datatype: string;
}
export interface CapturedDefaultGraph {
    readonly termType: 'DefaultGraph';
}
export type CapturedResource = CapturedNamedNode | CapturedBlankNode;
export interface CapturedQuad {
    readonly subject: CapturedResource;
    readonly predicate: CapturedNamedNode;
    readonly object: CapturedResource | CapturedLiteral;
    readonly graph: CapturedResource | CapturedDefaultGraph;
}
export interface CapturedShapeSource {
    readonly sourceId: string;
    readonly contentDigest: string;
    readonly owner: Readonly<{ role: 'root' | 'dependency'; canonicalIri: string }>;
    readonly quads: ReadonlyArray<CapturedQuad>;
}

/** Transient typed capture. Normalize and bind exact releases before storing a comparison profile. */
export interface ShaclEvidenceComplete {
    readonly schema: 'erden.shacl-capture/v1';
    readonly kind: 'complete';
    readonly data: ReadonlyArray<CapturedQuad>;
    readonly shapes: ReadonlyArray<CapturedShapeSource>;
    readonly report: Readonly<{ root: CapturedResource; quads: ReadonlyArray<CapturedQuad> }>;
}
export interface ShaclEvidenceSummary {
    readonly schema: 'erden.shacl-capture/v1';
    readonly kind: 'summary';
    readonly reason: 'source-limit' | 'statement-limit' | 'term-limit' | 'output-limit';
}
export type ShaclEvidence = ShaclEvidenceComplete | ShaclEvidenceSummary;

export class ShaclEvidenceError extends Error {
    readonly code = 'SHACL_EVIDENCE_INVALID';
    constructor() {
        super('The typed SHACL evidence is invalid');
        this.name = 'ShaclEvidenceError';
        Object.freeze(this);
    }
}

/** Uses the same snapshot-local shape labels as ShaclEvidence; normalize them jointly. */
export type ShaclSelfTestEvidence =
    | Readonly<{
          schema: 'erden.shacl-self-tests/v1';
          kind: 'complete';
          results: ReadonlyArray<Readonly<{ shape: CapturedResource; fired: boolean }>>;
      }>
    | Readonly<{
          schema: 'erden.shacl-self-tests/v1';
          kind: 'summary';
          reason: 'source-limit' | 'term-limit' | 'output-limit';
      }>;
