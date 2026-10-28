import { createHash } from 'node:crypto';

import { DataFactory, Writer, type Quad } from 'n3';

import { RdfComparisonError } from '../comparison-rdf/model.js';
import { compareCodePoints } from '../order.js';

import type { CapturedQuad, ShaclEvidenceComplete, ShaclSelfTestEvidence } from './model.js';
import { SHACL_EVIDENCE_LIMITS } from './model.js';
import { SHACL_RDF_LIMITS, ShaclProjectionCapacity, type ShaclRdfSource } from './project-model.js';
import { assertProjectionArray, assertProjectionArrayEntries, assertProjectionRecord } from './project-shape.js';
import { makeShaclProjectionTerms } from './project-terms.js';

const NS = 'urn:erden:shacl-context:v1:';

/** Encode only typed captured values; no input text is executed or fetched. */
export function encodeShaclContexts(
    input: ShaclEvidenceComplete,
    checkDeadline: () => void,
    selfTests?: Extract<ShaclSelfTestEvidence, { kind: 'complete' }>,
    mergeShapeContext = false,
) {
    const terms = makeShaclProjectionTerms();
    const writer = new Writer({ format: 'N-Quads' });
    const lines: string[] = [];
    const graphs = new Map<string, Quad['subject']>();
    const namedGraphKeys = new Map<string, string>();
    let encodedBytes = 0;
    let statements = 0;
    function capacity(reason: 'source-limit' | 'statement-limit' | 'encoded-limit'): never {
        throw new ShaclProjectionCapacity(
            Object.freeze({ schema: 'erden.shacl-rdf/v1', kind: 'summary', stage: 'projection', reason }),
        );
    }
    function write(quad: Quad): void {
        const line = writer.quadsToString([quad]);
        encodedBytes += Buffer.byteLength(line);
        if (encodedBytes > SHACL_RDF_LIMITS.maxEncodedBytes) {
            capacity('encoded-limit');
        }
        lines.push(line);
    }
    function emit(subject: Quad['subject'], predicate: string, object: Quad['object']): void {
        write(DataFactory.quad(subject, DataFactory.namedNode(NS + predicate), object));
    }
    function mappedGraph(context: Quad['subject'], original: Quad['graph']): Quad['graph'] {
        const key = `${JSON.stringify([context.value, original.termType, original.value])}\n`;
        const previous = graphs.get(key);
        if (previous !== undefined) {
            return previous;
        }
        let mapped: Quad['subject'];
        if (original.termType === 'BlankNode') {
            mapped = terms.graphNode();
        } else {
            const id = NS + 'graph:' + createHash('sha256').update(key).digest('hex');
            const prior = namedGraphKeys.get(id);
            if (prior !== undefined && prior !== key) {
                throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
            }
            namedGraphKeys.set(id, key);
            mapped = DataFactory.namedNode(id);
        }
        graphs.set(key, mapped);
        emit(mapped, 'context', context);
        emit(
            mapped,
            original.termType === 'DefaultGraph' ? 'defaultGraph' : 'graph',
            original.termType === 'DefaultGraph' ? DataFactory.literal('true') : original,
        );
        return mapped;
    }
    function context(id: string, kind: 'data' | 'shape' | 'report'): Quad['subject'] {
        const node = DataFactory.namedNode(NS + id);
        emit(node, 'kind', DataFactory.literal(kind));
        return node;
    }
    function encodeQuads(node: Quad['subject'], values: ReadonlyArray<CapturedQuad>): number {
        assertProjectionArray(values);
        if (values.length + statements > SHACL_RDF_LIMITS.maxStatements) {
            capacity('statement-limit');
        }
        const seen = new Set<string>();
        assertProjectionArrayEntries(values);
        for (const value of values) {
            checkDeadline();
            if (++statements > SHACL_RDF_LIMITS.maxStatements) {
                capacity('statement-limit');
            }
            const quad = terms.quad(value);
            const key = writer.quadsToString([quad]);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            write(DataFactory.quad(quad.subject, quad.predicate, quad.object, mappedGraph(node, quad.graph)));
        }
        return seen.size;
    }
    assertProjectionArray(input.shapes);
    if (input.shapes.length > SHACL_RDF_LIMITS.maxSources) {
        capacity('source-limit');
    }
    const ids = new Set<string>();
    assertProjectionArrayEntries(input.shapes);
    const selected = input.shapes
        .map((source) => {
            checkDeadline();
            assertProjectionRecord(source, ['sourceId', 'contentDigest', 'owner', 'quads']);
            assertProjectionRecord(source.owner, ['role', 'canonicalIri']);
            const sourceId = terms.charge(source.sourceId, SHACL_EVIDENCE_LIMITS.maxSourceIdBytes);
            const contentDigest = terms.charge(source.contentDigest, 71);
            const role = source.owner.role;
            if (
                !/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u.test(sourceId) ||
                ids.has(sourceId) ||
                !/^sha256:[a-f0-9]{64}$/u.test(contentDigest) ||
                !['root', 'dependency'].includes(role)
            ) {
                throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
            }
            ids.add(sourceId);
            return {
                sourceId,
                contentDigest,
                owner: Object.freeze({ role, canonicalIri: terms.iri(source.owner.canonicalIri) }),
                quads: source.quads,
            };
        })
        .sort((a, b) => compareCodePoints(a.sourceId, b.sourceId));
    const dataCount = encodeQuads(context('data', 'data'), input.data);
    const sources: ShaclRdfSource[] = [];
    let shapeCount = 0;
    if (mergeShapeContext && selected.length !== 0) {
        const node = context('shape:outcome-context', 'shape');
        emit(node, 'sourceId', DataFactory.literal('outcome-context'));
        shapeCount = encodeQuads(
            node,
            selected.flatMap((source) => source.quads),
        );
    } else {
        for (const source of selected) {
            checkDeadline();
            const node = context(`shape:${encodeURIComponent(source.sourceId)}`, 'shape');
            emit(node, 'sourceId', DataFactory.literal(source.sourceId));
            const quadCount = encodeQuads(node, source.quads);
            shapeCount += quadCount;
            sources.push(
                Object.freeze({
                    sourceId: source.sourceId,
                    contentDigest: source.contentDigest,
                    owner: source.owner,
                    quadCount,
                }),
            );
        }
    }
    const report = context('report', 'report');
    assertProjectionRecord(input.report, ['root', 'quads']);
    emit(report, 'root', terms.resource(input.report.root));
    const reportCount = encodeQuads(report, input.report.quads);
    if (selfTests !== undefined) {
        for (const result of selfTests.results) {
            checkDeadline();
            const node = terms.graphNode();
            emit(report, 'selfTest', node);
            emit(node, 'shape', terms.resource(result.shape));
            emit(
                node,
                'fired',
                DataFactory.literal(
                    result.fired ? 'true' : 'false',
                    DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#boolean'),
                ),
            );
        }
    }
    return Object.freeze({
        nquads: lines.join(''),
        sources: Object.freeze(sources),
        quadCounts: Object.freeze({ data: dataCount, shapes: shapeCount, report: reportCount }),
    });
}
