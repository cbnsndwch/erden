// The W3C validation report graph of a trusted erden-shacl answer, written by Erden (the engine's answer carries the
// results, not a graph). Every result gets the fields SHACL defines: focus node, path (complex paths as their SHACL
// path structure), value, constraint component, source shape, severity, messages, nested details, and, for a SPARQL
// constraint, `sh:sourceConstraint` when the source shape has exactly one `sh:sparql` value (PurRDF does not report
// it; with two or more the result does not say which, and none is written).
import { DataFactory, type Quad, type Term } from 'n3';

import type {
    ShaclAnswerPath,
    ShaclAnswerReport,
    ShaclAnswerResult,
    ShaclAnswerTerm,
    ShaclInputQuad,
} from './protocol.js';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const SPARQL_COMPONENT = `${SH}SPARQLConstraintComponent`;

function blankNode(label: string) {
    return DataFactory.blankNode(label);
}
function namedNode(iri: string) {
    return DataFactory.namedNode(iri);
}
function literal(value: string, languageOrDatatype: string | ReturnType<typeof namedNode>) {
    return DataFactory.literal(value, languageOrDatatype);
}
function quad(subject: Quad['subject'], predicate: Quad['predicate'], object: Quad['object']): Quad {
    return DataFactory.quad(subject, predicate, object);
}

function key(term: { readonly termType: string; readonly value: string }): string {
    return `${term.termType}:${term.value}`;
}

/** What the report writer reads from the shapes graph: each shape's `sh:sparql` values. */
export interface ShaclShapesIndex {
    readonly sparqlBySubject: ReadonlyMap<string, ReadonlyArray<ShaclAnswerTerm>>;
}

export function indexShaclShapes(quads: Iterable<ShaclInputQuad>): ShaclShapesIndex {
    const sparqlBySubject = new Map<string, ShaclAnswerTerm[]>();
    for (const item of quads) {
        if (item.predicate.value === `${SH}sparql`) {
            const values = sparqlBySubject.get(key(item.subject)) ?? [];
            if (!values.some((value) => key(value) === key(item.object))) {
                values.push(item.object);
            }
            sparqlBySubject.set(key(item.subject), values);
        }
    }
    return Object.freeze({ sparqlBySubject });
}

/** The result's `sh:sourceConstraint`, when the engine's result determines it; otherwise null. */
export function shaclSourceConstraint(result: ShaclAnswerResult, shapes: ShaclShapesIndex): ShaclAnswerTerm | null {
    if (result.sourceConstraintComponent !== SPARQL_COMPONENT) {
        return null;
    }
    const values = shapes.sparqlBySubject.get(key(result.sourceShape)) ?? [];
    return values.length === 1 ? (values[0] ?? null) : null;
}

export function shaclTerm(term: ShaclAnswerTerm): Term {
    if (term.termType === 'NamedNode') {
        return namedNode(term.value);
    }
    if (term.termType === 'BlankNode') {
        return blankNode(term.value);
    }
    if (term.termType === 'Literal') {
        const datatype = 'datatype' in term ? term.datatype : undefined;
        const language = term.language ?? '';
        const iri = typeof datatype === 'string' ? datatype : (datatype?.value ?? XSD_STRING);
        return language !== '' ? literal(term.value, language) : literal(term.value, namedNode(iri));
    }
    throw new TypeError(`A ${term.termType} term cannot appear in a SHACL report`);
}

/** Writes the quads of one report; blank nodes the writer mints start with `prefix`. */
export function shaclReportQuads(report: ShaclAnswerReport, shapes: ShaclShapesIndex, prefix: string): Quad[] {
    const out: Quad[] = [];
    let next = 0;
    function fresh(kind: string): Term {
        next += 1;
        return blankNode(`${prefix}${kind}${String(next)}`);
    }
    function list(items: ReadonlyArray<Term>): Term {
        let head: Term = namedNode(`${RDF}nil`);
        for (let index = items.length - 1; index >= 0; index -= 1) {
            const cell = fresh('l');
            out.push(quad(cell as Quad['subject'], namedNode(`${RDF}first`), items[index] as Quad['object']));
            out.push(quad(cell as Quad['subject'], namedNode(`${RDF}rest`), head as Quad['object']));
            head = cell;
        }
        return head;
    }
    function path(value: ShaclAnswerPath): Term {
        switch (value.kind) {
            case 'predicate':
                return namedNode(value.iri);
            case 'node':
                return shaclTerm(value.term);
            case 'sequence':
                return list(value.paths.map(path));
            case 'alternative': {
                const node = fresh('p');
                out.push(
                    quad(
                        node as Quad['subject'],
                        namedNode(`${SH}alternativePath`),
                        list(value.paths.map(path)) as Quad['object'],
                    ),
                );
                return node;
            }
            default: {
                const node = fresh('p');
                const predicate = value.kind === 'inverse' ? 'inversePath' : `${value.kind}Path`;
                out.push(
                    quad(node as Quad['subject'], namedNode(`${SH}${predicate}`), path(value.path) as Quad['object']),
                );
                return node;
            }
        }
    }
    function result(value: ShaclAnswerResult): Term {
        const node = fresh('r');
        const subject = node as Quad['subject'];
        function add(predicate: string, object: Term): void {
            out.push(quad(subject, namedNode(`${SH}${predicate}`), object as Quad['object']));
        }
        out.push(quad(subject, namedNode(`${RDF}type`), namedNode(`${SH}ValidationResult`)));
        add('focusNode', shaclTerm(value.focusNode));
        if (value.resultPath !== null) {
            add('resultPath', path(value.resultPath));
        }
        if (value.value !== null) {
            add('value', shaclTerm(value.value));
        }
        add('sourceConstraintComponent', namedNode(value.sourceConstraintComponent));
        add('sourceShape', shaclTerm(value.sourceShape));
        add('resultSeverity', namedNode(value.resultSeverity));
        for (const message of value.resultMessages) {
            add(
                'resultMessage',
                message.language !== ''
                    ? literal(message.value, message.language)
                    : literal(message.value, namedNode(message.datatype)),
            );
        }
        const constraint = shaclSourceConstraint(value, shapes);
        if (constraint !== null) {
            add('sourceConstraint', shaclTerm(constraint));
        }
        for (const detail of value.details) {
            add('detail', result(detail));
        }
        return node;
    }
    const root = blankNode(`${prefix}report`);
    out.push(quad(root, namedNode(`${RDF}type`), namedNode(`${SH}ValidationReport`)));
    out.push(quad(root, namedNode(`${SH}conforms`), literal(String(report.conforms), namedNode(XSD_BOOLEAN))));
    for (const item of report.results) {
        out.push(quad(root, namedNode(`${SH}result`), result(item) as Quad['object']));
    }
    return out;
}
