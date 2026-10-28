import { DataFactory, type Quad } from 'n3';

import { RDF_COMPARISON_LIMITS, RdfComparisonError } from '../comparison-rdf/model.js';

import type { CapturedQuad, CapturedResource } from './model.js';
import { SHACL_RDF_LIMITS, ShaclProjectionCapacity } from './project-model.js';
import { assertProjectionRecord, expectProjectionValue } from './project-shape.js';

const LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/** One blank-node map spans all contexts; generated graph nodes use a disjoint prefix. */
export function makeShaclProjectionTerms() {
    let bytes = 0;
    let graphNodes = 0;
    const labels = new Map<string, Quad['subject']>();
    function capacity(reason: 'term-limit' | 'input-limit'): never {
        throw new ShaclProjectionCapacity(
            Object.freeze({ schema: 'erden.shacl-rdf/v1', kind: 'summary', stage: 'projection', reason }),
        );
    }
    function charge(value: string, maximum: number): string {
        if (typeof value !== 'string') {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
        if (value.length > maximum) {
            capacity('term-limit');
        }
        if (!value.isWellFormed()) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
        const size = Buffer.byteLength(value);
        if (size > maximum) {
            capacity('term-limit');
        }
        bytes += size;
        if (bytes > SHACL_RDF_LIMITS.maxSourceBytes) {
            capacity('input-limit');
        }
        return value;
    }
    function iri(value: string): string {
        const result = charge(value, RDF_COMPARISON_LIMITS.maxIriBytes);
        if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^<>"{}|^`\\\u0000-\u0020\u007f-\u009f]*$/u.test(result)) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
        return result;
    }
    function checkBlankCapacity(): void {
        if (labels.size + graphNodes > RDF_COMPARISON_LIMITS.maxBlankNodes) {
            throw new ShaclProjectionCapacity(
                Object.freeze({
                    schema: 'erden.shacl-rdf/v1',
                    kind: 'summary',
                    stage: 'normalization',
                    reason: 'blank-node-limit',
                }),
            );
        }
    }
    function resource(value: CapturedResource): Quad['subject'] {
        assertProjectionRecord(value, ['termType', 'value']);
        if (value.termType === 'NamedNode') {
            return DataFactory.namedNode(iri(value.value));
        }
        expectProjectionValue(value.termType, 'BlankNode');
        if (value.value.length === 0) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
        const label = charge(value.value, RDF_COMPARISON_LIMITS.maxBlankNodeBytes);
        let node = labels.get(label);
        if (node === undefined) {
            node = DataFactory.blankNode(`v${String(labels.size)}`);
            labels.set(label, node);
            checkBlankCapacity();
        }
        return node;
    }
    function object(value: CapturedQuad['object']): Quad['object'] {
        assertProjectionRecord(value);
        if (value.termType !== 'Literal') {
            return resource(value);
        }
        const lexical = charge(value.value, RDF_COMPARISON_LIMITS.maxLiteralBytes);
        assertProjectionRecord(value, ['termType', 'value', 'language', 'datatype']);
        const language = charge(value.language, RDF_COMPARISON_LIMITS.maxLanguageBytes).toLowerCase();
        const datatype = iri(value.datatype);
        if (
            (language !== '' && !/^[a-z]+(?:-[a-z0-9]+)*$/u.test(language)) ||
            (language !== '') !== (datatype === LANG_STRING)
        ) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
        return DataFactory.literal(lexical, language || DataFactory.namedNode(datatype));
    }
    function quad(value: CapturedQuad): Quad {
        assertProjectionRecord(value, ['subject', 'predicate', 'object', 'graph']);
        assertProjectionRecord(value.predicate, ['termType', 'value']);
        expectProjectionValue(value.predicate.termType, 'NamedNode');
        assertProjectionRecord(value.graph);
        if (value.graph.termType === 'DefaultGraph') {
            assertProjectionRecord(value.graph, ['termType']);
        }
        return DataFactory.quad(
            resource(value.subject),
            DataFactory.namedNode(iri(value.predicate.value)),
            object(value.object),
            value.graph.termType === 'DefaultGraph' ? DataFactory.defaultGraph() : resource(value.graph),
        );
    }
    function graphNode(): Quad['subject'] {
        const result = DataFactory.blankNode(`g${String(graphNodes++)}`);
        checkBlankCapacity();
        return result;
    }
    return { charge, iri, resource, quad, graphNode };
}
