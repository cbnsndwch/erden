import { RDF_COMPARISON_LIMITS } from '../comparison-rdf/model.js';
import type { ProjectSourceOwner } from '../model.js';

import {
    SHACL_EVIDENCE_LIMITS as LIMITS,
    ShaclEvidenceError,
    type CapturedNamedNode,
    type CapturedQuad,
    type CapturedResource,
    type CapturedShapeSource,
    type ShaclEvidence,
    type ShaclEvidenceSummary,
    type ShaclSelfTestEvidence,
} from './model.js';

/** Structural RDF/JS input; capture never retains library instances or methods. */
export interface ShaclEvidenceTerm {
    readonly termType: string;
    readonly value: string;
    readonly language?: string;
    readonly datatype?: ShaclEvidenceTerm;
    readonly direction?: string | null;
}
export interface ShaclEvidenceQuad {
    readonly subject: ShaclEvidenceTerm;
    readonly predicate: ShaclEvidenceTerm;
    readonly object: ShaclEvidenceTerm;
    readonly graph: ShaclEvidenceTerm;
}

export interface CaptureShaclEvidenceInput {
    readonly data: Iterable<ShaclEvidenceQuad>;
    readonly shapes: ReadonlyArray<{
        readonly descriptor: { readonly id: string; readonly owner: Pick<ProjectSourceOwner, 'role' | 'canonicalIri'> };
        readonly contentDigest: string;
        readonly quads: Iterable<ShaclEvidenceQuad>;
    }>;
    readonly report: { readonly term: ShaclEvidenceTerm; readonly dataset: Iterable<ShaclEvidenceQuad> };
}

class Capacity extends Error {
    constructor(readonly reason: ShaclEvidenceSummary['reason']) {
        super(reason);
    }
}

function text(value: string, maximum: number): string {
    if (typeof value !== 'string' || !value.isWellFormed()) {
        throw new ShaclEvidenceError();
    }
    if (Buffer.byteLength(value) > maximum) {
        throw new Capacity('term-limit');
    }
    return value;
}

function iri(value: string): string {
    const result = text(value, RDF_COMPARISON_LIMITS.maxIriBytes);
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^<>"{}|^`\\\u0000-\u0020\u007f-\u009f]*$/u.test(result)) {
        throw new ShaclEvidenceError();
    }
    return result;
}

function named(term: ShaclEvidenceTerm): CapturedNamedNode {
    if (term.termType !== 'NamedNode') {
        throw new ShaclEvidenceError();
    }
    return Object.freeze({ termType: 'NamedNode', value: iri(term.value) });
}

function resource(term: ShaclEvidenceTerm): CapturedResource {
    if (term.termType === 'NamedNode') {
        return named(term);
    }
    if (term.termType !== 'BlankNode' || term.value.length === 0) {
        throw new ShaclEvidenceError();
    }
    return Object.freeze({ termType: 'BlankNode', value: text(term.value, RDF_COMPARISON_LIMITS.maxBlankNodeBytes) });
}

function object(term: ShaclEvidenceTerm): CapturedQuad['object'] {
    if (term.termType !== 'Literal') {
        return resource(term);
    }
    if (term.language === undefined || term.datatype === undefined) {
        throw new ShaclEvidenceError();
    }
    const language = text(term.language, RDF_COMPARISON_LIMITS.maxLanguageBytes).toLowerCase();
    if (
        (language !== '' && !/^[a-z]+(?:-[a-z0-9]+)*$/u.test(language)) ||
        (term.direction !== undefined && term.direction !== null && term.direction !== '')
    ) {
        throw new ShaclEvidenceError();
    }
    const datatype = named(term.datatype).value;
    if ((language !== '') !== (datatype === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString')) {
        throw new ShaclEvidenceError();
    }
    return Object.freeze({
        termType: 'Literal',
        value: text(term.value, RDF_COMPARISON_LIMITS.maxLiteralBytes),
        language,
        datatype,
    });
}

/** Copy typed engine evidence while the validated graph and exact shape sources are still in scope. */
export function captureShaclEvidence(input: CaptureShaclEvidenceInput): ShaclEvidence {
    try {
        if (input.shapes.length > LIMITS.maxSources) {
            throw new Capacity('source-limit');
        }
        let statements = 0;
        let bytes = 0;
        const dataBlanks = new Set<string>();
        const shapeBlanks = new Set<string>();
        function charge(value: unknown): void {
            bytes += Buffer.byteLength(JSON.stringify(value));
            if (bytes > LIMITS.maxBytes) {
                throw new Capacity('output-limit');
            }
        }
        function quads(values: Iterable<ShaclEvidenceQuad>, blanks?: Set<string>): ReadonlyArray<CapturedQuad> {
            const captured: CapturedQuad[] = [];
            for (const quad of values) {
                if (++statements > LIMITS.maxStatements) {
                    throw new Capacity('statement-limit');
                }
                if (quad.graph.termType === 'DefaultGraph' && quad.graph.value !== '') {
                    throw new ShaclEvidenceError();
                }
                const value = Object.freeze({
                    subject: resource(quad.subject),
                    predicate: named(quad.predicate),
                    object: object(quad.object),
                    graph:
                        quad.graph.termType === 'DefaultGraph'
                            ? Object.freeze({ termType: 'DefaultGraph' as const })
                            : resource(quad.graph),
                });
                for (const term of [value.subject, value.object, value.graph]) {
                    if (term.termType === 'BlankNode') {
                        blanks?.add(term.value);
                    }
                }
                charge(value);
                captured.push(value);
            }
            return Object.freeze(captured);
        }
        const data = quads(input.data, dataBlanks);
        const ids = new Set<string>();
        const shapes: CapturedShapeSource[] = [];
        for (const source of input.shapes) {
            const sourceId = text(source.descriptor.id, LIMITS.maxSourceIdBytes);
            if (
                !/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u.test(sourceId) ||
                ids.has(sourceId) ||
                !/^sha256:[a-f0-9]{64}$/u.test(source.contentDigest) ||
                !['root', 'dependency'].includes(source.descriptor.owner.role)
            ) {
                throw new ShaclEvidenceError();
            }
            ids.add(sourceId);
            const metadata = Object.freeze({
                sourceId,
                contentDigest: source.contentDigest,
                owner: Object.freeze({
                    role: source.descriptor.owner.role,
                    canonicalIri: iri(source.descriptor.owner.canonicalIri),
                }),
            });
            charge(metadata);
            const captured = quads(source.quads, shapeBlanks);
            shapes.push(Object.freeze({ ...metadata, quads: captured }));
        }
        const root = resource(input.report.term);
        if (
            [...shapeBlanks].some((label) => dataBlanks.has(label)) ||
            (root.termType === 'BlankNode' && (dataBlanks.has(root.value) || shapeBlanks.has(root.value)))
        ) {
            throw new ShaclEvidenceError();
        }
        const report = Object.freeze({ root, quads: quads(input.report.dataset) });
        const result = Object.freeze({
            schema: 'erden.shacl-capture/v1' as const,
            kind: 'complete' as const,
            data,
            shapes: Object.freeze(shapes),
            report,
        });
        if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.maxBytes) {
            throw new Capacity('output-limit');
        }
        return result;
    } catch (error) {
        if (error instanceof Capacity) {
            return Object.freeze({ schema: 'erden.shacl-capture/v1', kind: 'summary', reason: error.reason });
        }
        throw new ShaclEvidenceError();
    }
}

/** Capture actual self-test resource terms before the legacy report discards their RDF kind. */
export function captureShaclSelfTests(
    input: Iterable<Readonly<{ term: ShaclEvidenceTerm; fired: boolean }>>,
): ShaclSelfTestEvidence {
    const schema = 'erden.shacl-self-tests/v1' as const;
    try {
        const results: Readonly<{ shape: CapturedResource; fired: boolean }>[] = [];
        let bytes = 0;
        for (const result of input) {
            if (results.length >= LIMITS.maxSources) {
                return Object.freeze({ schema, kind: 'summary', reason: 'source-limit' });
            }
            if (typeof result.fired !== 'boolean') {
                throw new ShaclEvidenceError();
            }
            const captured = Object.freeze({ shape: resource(result.term), fired: result.fired });
            bytes += Buffer.byteLength(JSON.stringify(captured)) + 1;
            if (bytes > LIMITS.maxBytes - 128) {
                return Object.freeze({ schema, kind: 'summary', reason: 'output-limit' });
            }
            results.push(captured);
        }
        return Object.freeze({ schema, kind: 'complete', results: Object.freeze(results) });
    } catch (cause) {
        if (cause instanceof Capacity && cause.reason === 'term-limit') {
            return Object.freeze({ schema, kind: 'summary', reason: 'term-limit' });
        }
        throw new ShaclEvidenceError();
    }
}
