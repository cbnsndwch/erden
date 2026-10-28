import type { Quad, Term } from 'n3';

import {
    normalizeClassExpression,
    type ClassExpression,
    type ObjectPropertyExpression,
} from '@erden/reasoner-protocol';

import { OWL, RDF, XSD } from '../model.js';

/**
 * Reads OWL 2 class and property expressions from their RDF mapping (OWL 2 Mapping to RDF Graphs, section 3.2) into
 * the V2 protocol's expressions, for the profile partition (which only asks whether an expression is in V2) and the
 * normalizer (which also consumes the statements it is made of). Pure and read-only.
 *
 * An anonymous expression must be a tree: each blank node referenced by exactly one statement (an axiom annotation's
 * `owl:annotatedTarget` aside), with exactly the statements its construct needs. What is valid OWL but outside V2 is
 * named by its OWL 2 structural construct (`ObjectMinCardinality`, `DataSomeValuesFrom`, ...), as the partition's
 * findings name it.
 */

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const RDF_LIST = `${RDF}List`;
const OWL_CLASS = `${OWL}Class`;
const OWL_RESTRICTION = `${OWL}Restriction`;
const OWL_THING = `${OWL}Thing`;
const OWL_AXIOM = `${OWL}Axiom`;
const OWL_ANNOTATION = `${OWL}Annotation`;
const OWL_ANNOTATED_TARGET = `${OWL}annotatedTarget`;
const OWL_INTERSECTION_OF = `${OWL}intersectionOf`;
const OWL_UNION_OF = `${OWL}unionOf`;
const OWL_COMPLEMENT_OF = `${OWL}complementOf`;
const OWL_ONE_OF = `${OWL}oneOf`;
const OWL_ON_PROPERTY = `${OWL}onProperty`;
const OWL_ON_PROPERTIES = `${OWL}onProperties`;
const OWL_SOME_VALUES_FROM = `${OWL}someValuesFrom`;
const OWL_ALL_VALUES_FROM = `${OWL}allValuesFrom`;
const OWL_HAS_VALUE = `${OWL}hasValue`;
const OWL_HAS_SELF = `${OWL}hasSelf`;
const OWL_MIN_CARDINALITY = `${OWL}minCardinality`;
const OWL_MAX_CARDINALITY = `${OWL}maxCardinality`;
const OWL_CARDINALITY = `${OWL}cardinality`;
const OWL_MIN_QUALIFIED = `${OWL}minQualifiedCardinality`;
const OWL_MAX_QUALIFIED = `${OWL}maxQualifiedCardinality`;
const OWL_QUALIFIED = `${OWL}qualifiedCardinality`;
const OWL_ON_CLASS = `${OWL}onClass`;
const OWL_ON_DATA_RANGE = `${OWL}onDataRange`;
const OWL_INVERSE_OF = `${OWL}inverseOf`;
const XSD_NON_NEGATIVE_INTEGER = `${XSD}nonNegativeInteger`;

/** The statements the graph has about a term, and pointing to it. */
export interface ExpressionGraph {
    readonly outgoing: (term: Term) => ReadonlyArray<Quad>;
    readonly incoming: (term: Term) => ReadonlyArray<Quad>;
}

export type PropertyKindOf = (iri: string) => 'ObjectProperty' | 'DataProperty' | 'AnnotationProperty' | undefined;

export interface ExpressionContext {
    readonly graph: ExpressionGraph;
    readonly propertyKind: PropertyKindOf;
    /** Whether a named class IRI may stand in a class position (reserved vocabulary may not). */
    readonly isClassIri: (iri: string) => boolean;
}

export type ExpressionReading<T> =
    | { readonly kind: 'read'; readonly value: T; readonly plumbing: ReadonlyArray<Quad> }
    /** Valid OWL outside V2, named by its OWL 2 structural construct. */
    | { readonly kind: 'outside'; readonly owlConstruct: string }
    /** Not a well-formed RDF mapping of any expression. */
    | { readonly kind: 'malformed'; readonly message: string };

/** Ends a reading early; caught by the reader's entry points and returned as the reading. */
class Stop extends Error {
    readonly reading: Extract<ExpressionReading<never>, { kind: 'outside' | 'malformed' }>;
    constructor(reading: Extract<ExpressionReading<never>, { kind: 'outside' | 'malformed' }>) {
        super(reading.kind === 'outside' ? reading.owlConstruct : reading.message);
        this.reading = reading;
    }
}

function outside(owlConstruct: string): never {
    throw new Stop({ kind: 'outside', owlConstruct });
}

function malformed(message: string): never {
    throw new Stop({ kind: 'malformed', message });
}

function annotatesTarget(context: ExpressionContext, quad: Quad): boolean {
    if (quad.predicate.value !== OWL_ANNOTATED_TARGET || quad.subject.termType !== 'BlankNode') {
        return false;
    }
    return context.graph
        .outgoing(quad.subject)
        .some(
            (item) =>
                item.predicate.value === RDF_TYPE &&
                (item.object.value === OWL_AXIOM || item.object.value === OWL_ANNOTATION),
        );
}

class Reader {
    readonly #context: ExpressionContext;
    readonly plumbing: Quad[] = [];
    readonly #visited = new Set<string>();

    constructor(context: ExpressionContext) {
        this.#context = context;
    }

    /** A blank node owned by `owner` alone, never visited before. */
    #own(node: Term, owner: Quad | undefined): void {
        if (this.#visited.has(node.value)) {
            malformed('An anonymous expression refers to itself or is shared');
        }
        this.#visited.add(node.value);
        const incoming = this.#context.graph.incoming(node).filter((quad) => !annotatesTarget(this.#context, quad));
        const sole = incoming[0];
        if (
            owner === undefined
                ? incoming.length !== 0
                : incoming.length !== 1 || sole === undefined || !sole.equals(owner)
        ) {
            malformed('An anonymous expression must be referenced by exactly one statement');
        }
    }

    /** The statements of a blank node, by predicate; every one is consumed. */
    #statements(node: Term, extra: ReadonlySet<string>): Map<string, Quad[]> {
        const byPredicate = new Map<string, Quad[]>();
        for (const quad of this.#context.graph.outgoing(node)) {
            if (extra.has(quad.predicate.value)) {
                continue;
            }
            byPredicate.set(quad.predicate.value, [...(byPredicate.get(quad.predicate.value) ?? []), quad]);
        }
        return byPredicate;
    }

    #one(statements: Map<string, Quad[]>, predicate: string): Quad {
        const found = statements.get(predicate) ?? [];
        const quad = found[0];
        if (found.length !== 1 || quad === undefined) {
            malformed(`An expression needs exactly one ${predicate}`);
        }
        this.plumbing.push(quad);
        statements.delete(predicate);
        return quad;
    }

    /** The items of an RDF list, consuming its cells. */
    list(head: Term, owner: Quad): ReadonlyArray<{ readonly item: Term; readonly owner: Quad }> {
        const items: Array<{ readonly item: Term; readonly owner: Quad }> = [];
        let cursor = head;
        let incoming = owner;
        while (!(cursor.termType === 'NamedNode' && cursor.value === RDF_NIL)) {
            if (cursor.termType !== 'BlankNode') {
                malformed('Every RDF list cell must be a blank node');
            }
            this.#own(cursor, incoming);
            const statements = this.#statements(cursor, new Set());
            const types = statements.get(RDF_TYPE) ?? [];
            if (types.length > 1 || types.some((quad) => quad.object.value !== RDF_LIST)) {
                malformed('An RDF list cell has extraneous structure');
            }
            this.plumbing.push(...types);
            statements.delete(RDF_TYPE);
            const first = this.#one(statements, RDF_FIRST);
            const rest = this.#one(statements, RDF_REST);
            if (statements.size > 0) {
                malformed('An RDF list cell has extraneous structure');
            }
            items.push({ item: first.object, owner: first });
            incoming = rest;
            cursor = rest.object;
        }
        return items;
    }

    /** An object property expression, or `null` for a data property. */
    property(term: Term, owner: Quad): ObjectPropertyExpression | null {
        if (term.termType === 'NamedNode') {
            const kind = this.#context.propertyKind(term.value);
            if (kind === 'ObjectProperty') {
                return term.value;
            }
            if (kind === 'DataProperty') {
                return null;
            }
            return malformed(`${term.value} is not declared an object or data property`);
        }
        if (term.termType !== 'BlankNode') {
            return malformed('A property expression must be an IRI or ObjectInverseOf');
        }
        this.#own(term, owner);
        const statements = this.#statements(term, new Set());
        const inverse = this.#one(statements, OWL_INVERSE_OF);
        if (statements.size > 0 || inverse.object.termType !== 'NamedNode') {
            return malformed('ObjectInverseOf must name one object property');
        }
        if (this.#context.propertyKind(inverse.object.value) !== 'ObjectProperty') {
            return malformed(`${inverse.object.value} is not declared an object property`);
        }
        return { kind: 'ObjectInverseOf', property: inverse.object.value };
    }

    /** A class expression at `term`, referenced by `owner` (none for a general axiom's subject). */
    expression(term: Term, owner: Quad | undefined, extra: ReadonlySet<string> = new Set()): ClassExpression {
        if (term.termType === 'NamedNode') {
            if (!this.#context.isClassIri(term.value)) {
                outside('reserved-term-role');
            }
            return { kind: 'NamedClass', iri: term.value };
        }
        if (term.termType !== 'BlankNode') {
            return malformed('A class expression must be an IRI or a blank node');
        }
        this.#own(term, owner);
        const statements = this.#statements(term, extra);
        const types = statements.get(RDF_TYPE) ?? [];
        statements.delete(RDF_TYPE);
        const restriction = types.some((quad) => quad.object.value === OWL_RESTRICTION);
        if (
            types.length > 1 ||
            types.some((quad) => quad.object.value !== OWL_CLASS && quad.object.value !== OWL_RESTRICTION)
        ) {
            malformed('A class expression has an extraneous type');
        }
        this.plumbing.push(...types);
        if (statements.has(OWL_INTERSECTION_OF)) {
            const head = this.#one(statements, OWL_INTERSECTION_OF);
            this.#done(statements);
            const operands = this.list(head.object, head).map(({ item, owner: cell }) => this.expression(item, cell));
            if (operands.length < 2) {
                malformed('owl:intersectionOf needs two operands');
            }
            return { kind: 'ObjectIntersectionOf', operands };
        }
        if (statements.has(OWL_UNION_OF)) {
            const head = this.#one(statements, OWL_UNION_OF);
            this.#done(statements);
            const operands = this.list(head.object, head).map(({ item }) => {
                if (item.termType !== 'NamedNode') {
                    return outside('ObjectUnionOf');
                }
                if (!this.#context.isClassIri(item.value)) {
                    return outside('reserved-term-role');
                }
                return item.value;
            });
            if (operands.length < 2 || new Set(operands).size !== operands.length) {
                malformed('owl:unionOf needs two distinct operands');
            }
            return { kind: 'ObjectUnionOf', operands };
        }
        if (statements.has(OWL_COMPLEMENT_OF)) {
            const operand = this.#one(statements, OWL_COMPLEMENT_OF);
            this.#done(statements);
            return { kind: 'ObjectComplementOf', operand: this.expression(operand.object, operand) };
        }
        if (statements.has(OWL_ONE_OF)) {
            outside('ObjectOneOf');
        }
        if (statements.has(OWL_ON_PROPERTIES)) {
            outside('DataSomeValuesFrom');
        }
        if (!statements.has(OWL_ON_PROPERTY)) {
            return malformed('An anonymous class expression has no defining statement');
        }
        if (!restriction && types.length > 0) {
            malformed('A restriction must be typed owl:Restriction');
        }
        const on = this.#one(statements, OWL_ON_PROPERTY);
        const property = this.property(on.object, on);
        const data = property === null;
        function object(): ObjectPropertyExpression {
            return property ?? outside('DataRestriction');
        }
        if (statements.has(OWL_SOME_VALUES_FROM)) {
            const filler = this.#one(statements, OWL_SOME_VALUES_FROM);
            this.#done(statements);
            if (data) {
                outside('DataSomeValuesFrom');
            }
            return { kind: 'ObjectSomeValuesFrom', property: object(), filler: this.expression(filler.object, filler) };
        }
        if (statements.has(OWL_ALL_VALUES_FROM)) {
            const filler = this.#one(statements, OWL_ALL_VALUES_FROM);
            this.#done(statements);
            if (data) {
                outside('DataAllValuesFrom');
            }
            return { kind: 'ObjectAllValuesFrom', property: object(), filler: this.expression(filler.object, filler) };
        }
        if (statements.has(OWL_HAS_VALUE)) {
            return outside(data ? 'DataHasValue' : 'ObjectHasValue');
        }
        if (statements.has(OWL_HAS_SELF)) {
            return outside('ObjectHasSelf');
        }
        for (const [predicate, construct] of [
            [OWL_MIN_CARDINALITY, 'MinCardinality'],
            [OWL_MIN_QUALIFIED, 'MinCardinality'],
            [OWL_CARDINALITY, 'ExactCardinality'],
            [OWL_QUALIFIED, 'ExactCardinality'],
        ] as const) {
            if (statements.has(predicate)) {
                outside(`${data ? 'Data' : 'Object'}${construct}`);
            }
        }
        const qualified = statements.has(OWL_MAX_QUALIFIED);
        const bound = this.#one(statements, qualified ? OWL_MAX_QUALIFIED : OWL_MAX_CARDINALITY);
        if (data || statements.has(OWL_ON_DATA_RANGE)) {
            outside('DataMaxCardinality');
        }
        const value = bound.object;
        if (
            value.termType !== 'Literal' ||
            value.datatype.value !== XSD_NON_NEGATIVE_INTEGER ||
            !/^[0-9]+$/u.test(value.value)
        ) {
            return malformed('A cardinality must be an xsd:nonNegativeInteger');
        }
        const cardinality = Number(value.value);
        if (cardinality > 1) {
            outside('ObjectMaxCardinality');
        }
        let filler: ClassExpression = { kind: 'NamedClass', iri: OWL_THING };
        if (qualified) {
            const onClass = this.#one(statements, OWL_ON_CLASS);
            filler = this.expression(onClass.object, onClass);
        }
        this.#done(statements);
        return { kind: 'ObjectMaxCardinality', cardinality: cardinality as 0 | 1, property: object(), filler };
    }

    #done(statements: Map<string, Quad[]>): void {
        if (statements.size > 0) {
            malformed(`A class expression has extraneous statements: ${[...statements.keys()].sort().join(', ')}`);
        }
    }
}

function read<T>(context: ExpressionContext, body: (reader: Reader) => T): ExpressionReading<T> {
    const reader = new Reader(context);
    try {
        const value = body(reader);
        return { kind: 'read', value, plumbing: reader.plumbing };
    } catch (error) {
        if (error instanceof Stop) {
            return error.reading;
        }
        throw error;
    }
}

/**
 * The class expression `term` stands for, referenced by `owner`; for a general class axiom's anonymous subject, no
 * owner and the axiom predicates the subject itself carries (`extra`, such as `rdfs:subClassOf`).
 */
export function readClassExpression(
    context: ExpressionContext,
    term: Term,
    owner: Quad | undefined,
    extra: ReadonlySet<string> = new Set(),
): ExpressionReading<ClassExpression> {
    return read(context, (reader) => {
        const expression = reader.expression(term, owner, extra);
        try {
            // Sorted operands, in the order the request carries them; a repeated operand is refused.
            return normalizeClassExpression(expression);
        } catch {
            return malformed('A class expression repeats an operand');
        }
    });
}

/** An object property expression: an IRI, or `ObjectInverseOf` of one (a blank node owned by `owner`). */
export function readObjectPropertyExpression(
    context: ExpressionContext,
    term: Term,
    owner: Quad,
): ExpressionReading<ObjectPropertyExpression> {
    return read(context, (reader) => {
        const property = reader.property(term, owner);
        return property ?? malformed('Expected an object property');
    });
}

/** The items of an RDF list owned by `owner`, consuming its cells. */
export function readList(context: ExpressionContext, head: Term, owner: Quad): ExpressionReading<ReadonlyArray<Term>> {
    return read(context, (reader) => reader.list(head, owner).map(({ item }) => item));
}

/** The list items with the cell statement that refers to each, for readers of nested expressions. */
export function readListCells(
    context: ExpressionContext,
    head: Term,
    owner: Quad,
): ExpressionReading<ReadonlyArray<{ readonly item: Term; readonly owner: Quad }>> {
    return read(context, (reader) => reader.list(head, owner));
}
