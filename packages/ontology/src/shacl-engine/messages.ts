// The message of a SHACL finding. PurRDF writes `sh:resultMessage` only when the shape declares `sh:message` (or a
// SPARQL constraint has one), so Erden writes the rest, and a finding always says what is wrong:
//
// 1. the result's own messages, as PurRDF wrote them (with its `{$param}` and `{?var}` substitutions);
// 2. otherwise, for a SHACL Core component, the English template rdf-validate-shacl 0.6.5 uses, with the same
//    `{$param}` substitution, so Core findings read as they did when that engine ran them. The template strings
//    below are copied from rdf-validate-shacl 0.6.5 (src/validators.js), Copyright (c) 2020 Zazuko GmbH, MIT
//    license;
// 3. otherwise (sh:class, sh:and, sh:or, sh:xone, SPARQL constraints and declared components) a generated sentence
//    naming the value or focus node and the component.
import { DataFactory, type Store, type Term } from 'n3';

import type { ShaclAnswerPath, ShaclAnswerResult, ShaclAnswerTerm } from './protocol.js';
import { shaclTerm } from './report.js';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_FIRST = DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first');
const RDF_REST = DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#rest');
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

interface Template {
    /** For a node shape (no `sh:path`); undefined when rdf-validate-shacl has none. */
    readonly node?: string;
    /** For a property shape. */
    readonly property?: string;
}

function both(message: string): Template {
    return { node: message, property: message };
}

/** rdf-validate-shacl 0.6.5's message per Core component (validationMessage, node- and propertyValidationMessage). */
const TEMPLATES: ReadonlyMap<string, Template> = new Map([
    ['ClosedConstraintComponent', both('Predicate is not allowed (closed shape)')],
    ['DatatypeConstraintComponent', both('Value does not have datatype {$datatype}')],
    ['DisjointConstraintComponent', both('Value node must not also be one of the values of {$disjoint}')],
    ['EqualsConstraintComponent', both('Must have same values as {$equals}')],
    [
        'HasValueConstraintComponent',
        { node: 'Value must be {$hasValue}', property: 'Missing expected value {$hasValue}' },
    ],
    ['InConstraintComponent', both('Value is not one of the allowed values: {$in}')],
    ['LanguageInConstraintComponent', both('Language does not match any of {$languageIn}')],
    ['LessThanConstraintComponent', { property: 'Value is not less than value of {$lessThan}' }],
    [
        'LessThanOrEqualsConstraintComponent',
        { property: 'Value is not less than or equal to value of {$lessThanOrEquals}' },
    ],
    ['MaxCountConstraintComponent', { property: 'More than {$maxCount} values' }],
    ['MaxExclusiveConstraintComponent', both('Value is not less than {$maxExclusive}')],
    ['MaxInclusiveConstraintComponent', both('Value is not less than or equal to {$maxInclusive}')],
    ['MaxLengthConstraintComponent', both('Value has more than {$maxLength} characters')],
    ['MinCountConstraintComponent', { property: 'Less than {$minCount} values' }],
    ['MinExclusiveConstraintComponent', both('Value is not greater than {$minExclusive}')],
    ['MinInclusiveConstraintComponent', both('Value is not greater than or equal to {$minInclusive}')],
    ['MinLengthConstraintComponent', both('Value has less than {$minLength} characters')],
    ['NodeKindConstraintComponent', both('Value does not have node kind {$nodeKind}')],
    ['NodeConstraintComponent', both('Value does not have shape {$node}')],
    ['NotConstraintComponent', both('Value does have shape {$not}')],
    ['PatternConstraintComponent', both('Value does not match pattern "{$pattern}"')],
    [
        'QualifiedMaxCountConstraintComponent',
        { property: 'More than {$qualifiedMaxCount} values have shape {$qualifiedValueShape}' },
    ],
    [
        'QualifiedMinCountConstraintComponent',
        { property: 'Less than {$qualifiedMinCount} values have shape {$qualifiedValueShape}' },
    ],
    ['UniqueLangConstraintComponent', { property: 'Language "{?lang}" used more than once' }],
]);

/** The parameter a generated sentence names, for the Core components without a template. */
const GENERATED_PARAMETERS: ReadonlyMap<string, string> = new Map([
    ['ClassConstraintComponent', 'class'],
    ['AndConstraintComponent', 'and'],
    ['OrConstraintComponent', 'or'],
    ['XoneConstraintComponent', 'xone'],
]);

function objects(shapes: Store, subject: Term, predicate: string): ReadonlyArray<Term> {
    return shapes.getQuads(subject, DataFactory.namedNode(predicate), null, null).map((quad) => quad.object);
}

function listItems(shapes: Store, head: Term): ReadonlyArray<Term> {
    const items: Term[] = [];
    const seen = new Set<string>();
    let current: Term | undefined = head;
    while (current !== undefined && current.value !== RDF_NIL && !seen.has(current.value) && items.length < 100_000) {
        seen.add(current.value);
        const first = shapes.getQuads(current, RDF_FIRST, null, null)[0]?.object;
        if (first !== undefined) {
            items.push(first);
        }
        current = shapes.getQuads(current, RDF_REST, null, null)[0]?.object;
    }
    return items;
}

/** rdf-validate-shacl's label of a parameter value: `<iri>`, a literal's lexical form, or the shape's `sh:in` list. */
function parameterLabel(shapes: Store, shape: Term, value: Term | undefined): string {
    if (value === undefined) {
        return 'NULL';
    }
    if (value.termType === 'NamedNode') {
        return `<${value.value}>`;
    }
    if (value.termType === 'BlankNode') {
        // rdf-validate-shacl labels any blank-node parameter with the values of the shape's sh:in list.
        const inList = objects(shapes, shape, `${SH}in`)[0];
        const values = inList === undefined ? [] : listItems(shapes, inList).map((item) => item.value);
        return values.length > 3
            ? `${values.slice(0, 3).join(', ')} ... (and ${String(values.length - 3)} more)`
            : values.join(', ');
    }
    return value.value;
}

function substitute(template: string, shapes: Store, shape: Term): string {
    let message = template;
    for (const match of template.matchAll(/\{[$?]([A-Za-z][A-Za-z0-9]*)\}/gu)) {
        const name = match[1] ?? '';
        const value = objects(shapes, shape, `${SH}${name}`)[0];
        if (value !== undefined || match[0].startsWith('{$')) {
            const label = parameterLabel(shapes, shape, value);
            message = message.replace(`{$${name}}`, label).replace(`{?${name}}`, label);
        }
    }
    return message;
}

/** An N-Triples rendering of a term, as findings show values. */
export function shaclTermText(term: ShaclAnswerTerm): string {
    if (term.termType === 'NamedNode') {
        return `<${term.value}>`;
    }
    if (term.termType === 'BlankNode') {
        return `_:${term.value}`;
    }
    const escaped = term.value.replace(/["\\\n\r]/gu, (character) =>
        character === '\n' ? '\\n' : character === '\r' ? '\\r' : `\\${character}`,
    );
    const language = 'language' in term ? (term.language ?? '') : '';
    if (language !== '') {
        return `"${escaped}"@${language}`;
    }
    const datatype = 'datatype' in term ? term.datatype : undefined;
    const iri = typeof datatype === 'string' ? datatype : (datatype?.value ?? '');
    return iri === '' || iri === 'http://www.w3.org/2001/XMLSchema#string' ? `"${escaped}"` : `"${escaped}"^^<${iri}>`;
}

function sparqlPath(path: ShaclAnswerPath, nested: boolean): string {
    switch (path.kind) {
        case 'predicate':
            return `<${path.iri}>`;
        case 'node':
            return shaclTermText(path.term);
        case 'inverse':
            return `^${sparqlPath(path.path, true)}`;
        case 'zeroOrMore':
            return `${sparqlPath(path.path, true)}*`;
        case 'oneOrMore':
            return `${sparqlPath(path.path, true)}+`;
        case 'zeroOrOne':
            return `${sparqlPath(path.path, true)}?`;
        case 'sequence': {
            const text = path.paths.map((item) => sparqlPath(item, true)).join('/');
            return nested ? `(${text})` : text;
        }
        case 'alternative':
            return `(${path.paths.map((item) => sparqlPath(item, false)).join('|')})`;
    }
}

/**
 * A finding's path: a predicate as its IRI and an inverse predicate as `^iri`, as before; any other path as a SPARQL
 * 1.1 property path with `<iri>` terms, such as `<a>/<b>`, `(<a>|<b>)` or `<a>*`.
 */
export function shaclPathText(path: ShaclAnswerPath | null): string | null {
    if (path === null) {
        return null;
    }
    if (path.kind === 'predicate') {
        return path.iri;
    }
    if (path.kind === 'inverse' && path.path.kind === 'predicate') {
        return `^${path.path.iri}`;
    }
    return sparqlPath(path, false);
}

function componentName(iri: string): string {
    return iri.startsWith(SH) ? `sh:${iri.slice(SH.length)}` : `<${iri}>`;
}

/** The message of one result, by the three rules above. */
export function shaclFindingMessage(result: ShaclAnswerResult, shapes: Store): string {
    if (result.resultMessages.length > 0) {
        return result.resultMessages.map((message) => message.value).join(' ');
    }
    const shape = shaclTerm(result.sourceShape);
    const component = result.sourceConstraintComponent;
    const local = component.startsWith(SH) ? component.slice(SH.length) : null;
    const isPropertyShape = objects(shapes, shape, `${SH}path`).length > 0;
    const template = local === null ? undefined : TEMPLATES.get(local);
    const text = isPropertyShape ? template?.property : template?.node;
    if (text !== undefined) {
        return substitute(text, shapes, shape);
    }
    const subject =
        result.value === null
            ? `Focus node ${shaclTermText(result.focusNode)}`
            : `Value ${shaclTermText(result.value)}`;
    const parameter = local === null ? undefined : GENERATED_PARAMETERS.get(local);
    const values = parameter === undefined ? [] : objects(shapes, shape, `${SH}${parameter}`);
    const detail =
        parameter === undefined || values.length === 0
            ? ''
            : parameter === 'class'
              ? ` (sh:class ${values.map((value) => (value.termType === 'NamedNode' ? `<${value.value}>` : value.value)).join(' ')})`
              : ` (sh:${parameter} of ${String(listItems(shapes, values[0] as Term).length)} shapes)`;
    return `${subject} does not satisfy ${componentName(component)}${detail}`;
}
