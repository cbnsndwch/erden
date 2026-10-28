import { DataFactory, type Quad, type Term } from 'n3';

import { OWL, RDF, RDFS, XSD } from '../model.js';

/**
 * Names and describes a profile finding in OWL 2 terms, so a refusal says exactly what was refused: the structural
 * construct (`ObjectSomeValuesFrom`, `ObjectMinCardinality`, `DisjointClasses`, ...) where the partition's construct
 * label is a coarse group (`owl:Restriction`, `class-expression`), and, for every finding, a bounded rendering of its
 * statements in OWL functional-style syntax. An anonymous finding, which has no subject to print, is described by
 * what it says: the axiom an `owl:Axiom` annotates, the members of an `owl:AllDisjointClasses`, the class expression
 * a general class axiom starts from.
 *
 * Pure and read-only: it reads the statements the partition indexed and changes no classification.
 */

/** What the explanation reads: the partition's index over the asserted statements. */
export interface FindingGraphView {
    readonly outgoing: (term: Term) => ReadonlyArray<Quad>;
    readonly types: (term: Term) => ReadonlySet<string>;
}

export interface FindingExplanation {
    /** The OWL 2 structural-specification name of the construct the finding hinges on, when there is one. */
    readonly owlConstruct: string | null;
    /** The finding's statements in OWL functional-style syntax, bounded; IRIs outside rdf/rdfs/owl/xsd in full. */
    readonly description: string;
}

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const RDFS_DATATYPE = `${RDFS}Datatype`;
const RDFS_LITERAL = `${RDFS}Literal`;
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const OWL_DATA_PROPERTY = `${OWL}DatatypeProperty`;
const OWL_ANNOTATION_PROPERTY = `${OWL}AnnotationProperty`;
const OWL_ONTOLOGY = `${OWL}Ontology`;

/** The longest description; a longer one is cut at a character boundary and ends with an ellipsis. */
export const FINDING_DESCRIPTION_MAX_LENGTH = 600;
const MAX_DEPTH = 6;
const MAX_LIST_ITEMS = 12;

const PREFIXES: ReadonlyArray<readonly [string, string]> = [
    [OWL, 'owl:'],
    [RDFS, 'rdfs:'],
    [RDF, 'rdf:'],
    [XSD, 'xsd:'],
];

function iri(value: string): string {
    const prefix = PREFIXES.find(([namespace]) => value.startsWith(namespace));
    return prefix === undefined ? `<${value}>` : `${prefix[1]}${value.slice(prefix[0].length)}`;
}

function literal(term: Term & { termType: 'Literal' }): string {
    const lexical = JSON.stringify(term.value.length > 80 ? `${term.value.slice(0, 79)}…` : term.value);
    if (term.language !== '') {
        return `${lexical}@${term.language}`;
    }
    return term.datatype.value === `${XSD}string` ? lexical : `${lexical}^^${iri(term.datatype.value)}`;
}

/** Cuts at the maximum length in UTF-16 code units, never between the two halves of a surrogate pair. */
function bounded(text: string): string {
    if (text.length <= FINDING_DESCRIPTION_MAX_LENGTH) {
        return text;
    }
    let end = FINDING_DESCRIPTION_MAX_LENGTH - 1;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
        end -= 1;
    }
    return `${text.slice(0, end)}…`;
}

type PropertyKind = 'object' | 'data' | 'annotation' | undefined;

class Renderer {
    readonly #view: FindingGraphView;

    constructor(view: FindingGraphView) {
        this.#view = view;
    }

    values(term: Term, predicate: string): ReadonlyArray<Term> {
        return this.#view
            .outgoing(term)
            .filter((quad) => quad.predicate.value === predicate)
            .map((quad) => quad.object);
    }

    value(term: Term, predicate: string): Term | undefined {
        return this.values(term, predicate)[0];
    }

    has(term: Term, predicate: string): boolean {
        return this.value(term, predicate) !== undefined;
    }

    types(term: Term): ReadonlySet<string> {
        return this.#view.types(term);
    }

    /** The members of a well-formed RDF list, or undefined when the list is malformed or cyclic. */
    list(head: Term): ReadonlyArray<Term> | undefined {
        const items: Term[] = [];
        const seen = new Set<string>();
        let cursor: Term | undefined = head;
        while (cursor !== undefined && !(cursor.termType === 'NamedNode' && cursor.value === RDF_NIL)) {
            if (cursor.termType !== 'BlankNode' || seen.has(cursor.value)) {
                return undefined;
            }
            seen.add(cursor.value);
            const first = this.values(cursor, RDF_FIRST);
            const rest = this.values(cursor, RDF_REST);
            if (first.length !== 1 || rest.length !== 1) {
                return undefined;
            }
            items.push(first[0] as Term);
            cursor = rest[0];
        }
        return cursor === undefined ? undefined : items;
    }

    propertyKind(property: Term | undefined): PropertyKind {
        if (property?.termType !== 'NamedNode') {
            return undefined;
        }
        const types = this.types(property);
        if (types.has(OWL_OBJECT_PROPERTY)) {
            return 'object';
        }
        if (types.has(OWL_DATA_PROPERTY)) {
            return 'data';
        }
        return types.has(OWL_ANNOTATION_PROPERTY) ? 'annotation' : undefined;
    }

    /** Whether a filler or a list of values is a data range rather than a class. */
    isDataRange(term: Term | undefined): boolean {
        if (term === undefined) {
            return false;
        }
        if (term.termType === 'Literal') {
            return true;
        }
        if (term.termType === 'NamedNode') {
            return term.value.startsWith(XSD) || term.value === RDFS_LITERAL || term.value === `${RDF}langString`;
        }
        return this.types(term).has(RDFS_DATATYPE) || this.has(term, `${OWL}onDatatype`);
    }

    /** The OWL constructor of an anonymous class expression, data range or property expression. */
    constructorName(term: Term): string | null {
        if (term.termType !== 'BlankNode') {
            return null;
        }
        const property = this.value(term, `${OWL}onProperty`);
        const properties = this.value(term, `${OWL}onProperties`);
        if (property !== undefined || properties !== undefined) {
            return this.restrictionName(term, property);
        }
        const data = this.types(term).has(RDFS_DATATYPE);
        if (this.has(term, `${OWL}intersectionOf`)) {
            return data ? 'DataIntersectionOf' : 'ObjectIntersectionOf';
        }
        if (this.has(term, `${OWL}unionOf`)) {
            return data ? 'DataUnionOf' : 'ObjectUnionOf';
        }
        if (this.has(term, `${OWL}complementOf`)) {
            return 'ObjectComplementOf';
        }
        if (this.has(term, `${OWL}datatypeComplementOf`)) {
            return 'DataComplementOf';
        }
        if (this.has(term, `${OWL}oneOf`)) {
            const members = this.list(this.value(term, `${OWL}oneOf`) as Term);
            return data || (members !== undefined && members.some((member) => member.termType === 'Literal'))
                ? 'DataOneOf'
                : 'ObjectOneOf';
        }
        if (this.has(term, `${OWL}onDatatype`)) {
            return 'DatatypeRestriction';
        }
        if (this.has(term, `${OWL}inverseOf`)) {
            return 'ObjectInverseOf';
        }
        return null;
    }

    restrictionName(term: Term, property: Term | undefined): string {
        const kind = this.propertyKind(property);
        const qualifiedData = this.has(term, `${OWL}onDataRange`);
        const filler =
            this.value(term, `${OWL}someValuesFrom`) ??
            this.value(term, `${OWL}allValuesFrom`) ??
            this.value(term, `${OWL}hasValue`);
        const data =
            kind === 'data' ||
            qualifiedData ||
            this.has(term, `${OWL}onProperties`) ||
            (kind === undefined && this.isDataRange(filler));
        const prefix = data ? 'Data' : 'Object';
        if (this.has(term, `${OWL}someValuesFrom`)) {
            return `${prefix}SomeValuesFrom`;
        }
        if (this.has(term, `${OWL}allValuesFrom`)) {
            return `${prefix}AllValuesFrom`;
        }
        if (this.has(term, `${OWL}hasValue`)) {
            return `${prefix}HasValue`;
        }
        if (this.has(term, `${OWL}hasSelf`)) {
            return 'ObjectHasSelf';
        }
        for (const [predicates, name] of [
            [['minCardinality', 'minQualifiedCardinality'], 'MinCardinality'],
            [['maxCardinality', 'maxQualifiedCardinality'], 'MaxCardinality'],
            [['cardinality', 'qualifiedCardinality'], 'ExactCardinality'],
        ] as const) {
            if (predicates.some((predicate) => this.has(term, `${OWL}${predicate}`))) {
                return `${prefix}${name}`;
            }
        }
        return 'owl:Restriction';
    }

    term(term: Term | undefined, depth = 0): string {
        if (term === undefined) {
            return '?';
        }
        switch (term.termType) {
            case 'NamedNode':
                return iri(term.value);
            case 'Literal':
                return literal(term);
            case 'BlankNode':
                return this.expression(term, depth);
            default:
                return '?';
        }
    }

    items(terms: ReadonlyArray<Term> | undefined, depth: number): string {
        if (terms === undefined) {
            return '(malformed list)';
        }
        const shown = terms.slice(0, MAX_LIST_ITEMS).map((item) => this.term(item, depth + 1));
        return terms.length > MAX_LIST_ITEMS
            ? `${shown.join(' ')} …${String(terms.length - MAX_LIST_ITEMS)} more`
            : shown.join(' ');
    }

    /** An anonymous class expression, data range or property expression in functional-style syntax. */
    expression(term: Term, depth = 0): string {
        if (term.termType !== 'BlankNode') {
            return this.term(term, depth);
        }
        if (depth >= MAX_DEPTH) {
            return '…';
        }
        const name = this.constructorName(term);
        if (name === null) {
            // An anonymous individual or other blank node: named by what is said about it.
            const predicates = [
                ...new Set(
                    this.#view
                        .outgoing(term)
                        .map((quad) => iri(quad.predicate.value))
                        .slice(0, MAX_LIST_ITEMS),
                ),
            ];
            return predicates.length === 0 ? '[anonymous]' : `[anonymous with ${predicates.join(', ')}]`;
        }
        const next = depth + 1;
        const operands = (predicate: string): string =>
            this.items(this.list(this.value(term, predicate) as Term), depth);
        switch (name) {
            case 'ObjectIntersectionOf':
            case 'DataIntersectionOf':
                return `${name}(${operands(`${OWL}intersectionOf`)})`;
            case 'ObjectUnionOf':
            case 'DataUnionOf':
                return `${name}(${operands(`${OWL}unionOf`)})`;
            case 'ObjectComplementOf':
                return `${name}(${this.term(this.value(term, `${OWL}complementOf`), next)})`;
            case 'DataComplementOf':
                return `${name}(${this.term(this.value(term, `${OWL}datatypeComplementOf`), next)})`;
            case 'ObjectOneOf':
            case 'DataOneOf':
                return `${name}(${operands(`${OWL}oneOf`)})`;
            case 'ObjectInverseOf':
                return `${name}(${this.term(this.value(term, `${OWL}inverseOf`), next)})`;
            case 'DatatypeRestriction': {
                const facets = (this.list(this.value(term, `${OWL}withRestrictions`) as Term) ?? []).flatMap((facet) =>
                    this.#view
                        .outgoing(facet)
                        .map((quad) => `${iri(quad.predicate.value)} ${this.term(quad.object, next)}`),
                );
                return `${name}(${this.term(this.value(term, `${OWL}onDatatype`), next)}${facets.length === 0 ? '' : ` ${facets.join(' ')}`})`;
            }
            default:
                return this.restriction(term, name, next);
        }
    }

    restriction(term: Term, name: string, depth: number): string {
        const property =
            this.value(term, `${OWL}onProperty`) !== undefined
                ? this.term(this.value(term, `${OWL}onProperty`), depth)
                : this.items(this.list(this.value(term, `${OWL}onProperties`) as Term), depth);
        const filler = (predicate: string): string => this.term(this.value(term, `${OWL}${predicate}`), depth);
        if (name.endsWith('SomeValuesFrom')) {
            return `${name}(${property} ${filler('someValuesFrom')})`;
        }
        if (name.endsWith('AllValuesFrom')) {
            return `${name}(${property} ${filler('allValuesFrom')})`;
        }
        if (name.endsWith('HasValue')) {
            return `${name}(${property} ${filler('hasValue')})`;
        }
        if (name === 'ObjectHasSelf') {
            return `${name}(${property})`;
        }
        const [plain, qualified] = name.endsWith('MinCardinality')
            ? ['minCardinality', 'minQualifiedCardinality']
            : name.endsWith('MaxCardinality')
              ? ['maxCardinality', 'maxQualifiedCardinality']
              : ['cardinality', 'qualifiedCardinality'];
        const count = this.value(term, `${OWL}${qualified}`) ?? this.value(term, `${OWL}${plain}`);
        const qualifier = this.value(term, `${OWL}onClass`) ?? this.value(term, `${OWL}onDataRange`);
        return `${name}(${count?.value ?? '?'} ${property}${qualifier === undefined ? '' : ` ${this.term(qualifier, depth)}`})`;
    }

    /** One statement as the OWL axiom it maps to, with any anonymous object expanded. */
    axiom(subject: Term, predicate: string, object: Term): string {
        const s = this.term(subject);
        const o = this.term(object);
        const kind = this.propertyKind(subject);
        switch (predicate) {
            case RDF_TYPE: {
                if (object.termType !== 'NamedNode') {
                    return `ClassAssertion(${o} ${s})`;
                }
                const characteristic = CHARACTERISTICS[object.value];
                if (characteristic !== undefined) {
                    return `${kind === 'data' ? (characteristic[1] ?? characteristic[0]) : characteristic[0]}(${s})`;
                }
                const declared = DECLARATION_KINDS[object.value];
                if (declared !== undefined) {
                    return `Declaration(${declared}(${s}))`;
                }
                // Other reserved types (rdf:Property, owl:DeprecatedClass, ...) have no OWL axiom of their own.
                return object.value.startsWith(OWL) || object.value.startsWith(RDF) || object.value.startsWith(RDFS)
                    ? `${s} rdf:type ${o}`
                    : `ClassAssertion(${o} ${s})`;
            }
            case `${RDFS}subClassOf`:
                return `SubClassOf(${s} ${o})`;
            case `${OWL}equivalentClass`:
                return `EquivalentClasses(${s} ${o})`;
            case `${OWL}disjointWith`:
                return `DisjointClasses(${s} ${o})`;
            case `${RDFS}domain`:
                return `${kind === 'data' ? 'DataPropertyDomain' : kind === 'annotation' ? 'AnnotationPropertyDomain' : 'ObjectPropertyDomain'}(${s} ${o})`;
            case `${RDFS}range`:
                return `${kind === 'data' ? 'DataPropertyRange' : kind === 'annotation' ? 'AnnotationPropertyRange' : 'ObjectPropertyRange'}(${s} ${o})`;
            case `${RDFS}subPropertyOf`:
                return `${kind === 'data' ? 'SubDataPropertyOf' : kind === 'annotation' ? 'SubAnnotationPropertyOf' : 'SubObjectPropertyOf'}(${s} ${o})`;
            case `${OWL}equivalentProperty`:
                return `${kind === 'data' ? 'EquivalentDataProperties' : 'EquivalentObjectProperties'}(${s} ${o})`;
            case `${OWL}propertyDisjointWith`:
                return `${kind === 'data' ? 'DisjointDataProperties' : 'DisjointObjectProperties'}(${s} ${o})`;
            case `${OWL}inverseOf`:
                return `InverseObjectProperties(${s} ${o})`;
            case `${OWL}sameAs`:
                return `SameIndividual(${s} ${o})`;
            case `${OWL}differentFrom`:
                return `DifferentIndividuals(${s} ${o})`;
            case `${OWL}disjointUnionOf`:
                return `DisjointUnion(${s} ${this.items(this.list(object), 0)})`;
            case `${OWL}propertyChainAxiom`:
                return `SubObjectPropertyOf(ObjectPropertyChain(${this.items(this.list(object), 0)}) ${s})`;
            case `${OWL}hasKey`:
                return `HasKey(${s} (${this.items(this.list(object), 0)}) ())`;
            case `${OWL}imports`:
                return `Import(${o})`;
            default: {
                const predicateKind = this.propertyKind(DataFactory.namedNode(predicate));
                const name =
                    predicateKind === 'object'
                        ? 'ObjectPropertyAssertion'
                        : predicateKind === 'data'
                          ? 'DataPropertyAssertion'
                          : this.types(subject).has(OWL_ONTOLOGY)
                            ? 'Annotation'
                            : 'AnnotationAssertion';
                return name === 'AnnotationAssertion'
                    ? `${name}(${iri(predicate)} ${s} ${o})`
                    : name === 'Annotation'
                      ? `Ontology(${s} ${name}(${iri(predicate)} ${o}))`
                      : `${name}(${iri(predicate)} ${s} ${o})`;
            }
        }
    }
}

const DECLARATION_KINDS: Readonly<Record<string, string>> = {
    [`${OWL}Class`]: 'Class',
    [`${RDFS}Class`]: 'Class',
    [OWL_OBJECT_PROPERTY]: 'ObjectProperty',
    [OWL_DATA_PROPERTY]: 'DataProperty',
    [OWL_ANNOTATION_PROPERTY]: 'AnnotationProperty',
    [`${OWL}NamedIndividual`]: 'NamedIndividual',
    [RDFS_DATATYPE]: 'Datatype',
};

const CHARACTERISTICS: Readonly<Record<string, readonly [string, string | null]>> = {
    [`${OWL}FunctionalProperty`]: ['FunctionalObjectProperty', 'FunctionalDataProperty'],
    [`${OWL}InverseFunctionalProperty`]: ['InverseFunctionalObjectProperty', null],
    [`${OWL}SymmetricProperty`]: ['SymmetricObjectProperty', null],
    [`${OWL}AsymmetricProperty`]: ['AsymmetricObjectProperty', null],
    [`${OWL}ReflexiveProperty`]: ['ReflexiveObjectProperty', null],
    [`${OWL}IrreflexiveProperty`]: ['IrreflexiveObjectProperty', null],
};

const AXIOM_NAMES: Readonly<Record<string, string>> = {
    [`${OWL}sameAs`]: 'SameIndividual',
    [`${OWL}differentFrom`]: 'DifferentIndividuals',
    [`${OWL}disjointUnionOf`]: 'DisjointUnion',
    [`${OWL}propertyChainAxiom`]: 'ObjectPropertyChain',
    [`${OWL}hasKey`]: 'HasKey',
    [`${OWL}imports`]: 'Import',
    [`${OWL}inverseOf`]: 'InverseObjectProperties',
};

const ANNOTATION_CONSTRUCTS = new Set([
    'owl:versionInfo',
    'owl:versionIRI',
    'owl:priorVersion',
    'owl:backwardCompatibleWith',
    'owl:incompatibleWith',
    'owl:deprecated',
    'rdfs:seeAlso',
    'rdfs:isDefinedBy',
    'blank-node-annotation-value',
    'undeclared-predicate',
]);

/** The anonymous structure's own outgoing statements, grouped by predicate, as a readable list. */
function predicateList(renderer: Renderer, view: FindingGraphView, node: Term): string {
    const predicates = [
        ...new Set(
            view
                .outgoing(node)
                .filter((quad) => quad.predicate.value !== RDF_TYPE)
                .map((quad) => iri(quad.predicate.value)),
        ),
    ];
    const types = [...renderer.types(node)].map(iri);
    return [
        ...(types.length === 0 ? [] : [`typed ${types.join(', ')}`]),
        ...(predicates.length === 0 ? [] : [`with ${predicates.slice(0, MAX_LIST_ITEMS).join(', ')}`]),
    ].join(' ');
}

function explainAnonymous(
    renderer: Renderer,
    view: FindingGraphView,
    root: Term,
    construct: string,
): FindingExplanation {
    const types = renderer.types(root);
    if (types.has(`${OWL}Axiom`) || types.has(`${OWL}Annotation`)) {
        const source = renderer.value(root, `${OWL}annotatedSource`);
        const property = renderer.value(root, `${OWL}annotatedProperty`);
        const target = renderer.value(root, `${OWL}annotatedTarget`);
        const annotations = [
            ...new Set(
                view
                    .outgoing(root)
                    .filter(
                        (quad) =>
                            quad.predicate.value !== RDF_TYPE && !quad.predicate.value.startsWith(`${OWL}annotated`),
                    )
                    .map((quad) => iri(quad.predicate.value)),
            ),
        ];
        const annotated =
            source !== undefined && property?.termType === 'NamedNode' && target !== undefined
                ? renderer.axiom(source, property.value, target)
                : 'an incomplete owl:annotatedSource/owl:annotatedProperty/owl:annotatedTarget triple';
        const name = types.has(`${OWL}Axiom`) ? 'AxiomAnnotation' : 'AnnotationAnnotation';
        return {
            owlConstruct: name,
            description: bounded(
                `${name} on ${annotated}${annotations.length === 0 ? '' : ` with ${annotations.join(', ')}`}`,
            ),
        };
    }
    if (types.has(`${OWL}AllDisjointClasses`)) {
        return {
            owlConstruct: 'DisjointClasses',
            description: bounded(
                `DisjointClasses(${renderer.items(renderer.list(renderer.value(root, `${OWL}members`) as Term), 0)})`,
            ),
        };
    }
    if (types.has(`${OWL}AllDifferent`)) {
        const members = renderer.value(root, `${OWL}members`) ?? renderer.value(root, `${OWL}distinctMembers`);
        return {
            owlConstruct: 'DifferentIndividuals',
            description: bounded(`DifferentIndividuals(${renderer.items(renderer.list(members as Term), 0)})`),
        };
    }
    if (types.has(`${OWL}AllDisjointProperties`)) {
        const members = renderer.list(renderer.value(root, `${OWL}members`) as Term);
        const name =
            members !== undefined && members.some((member) => renderer.propertyKind(member) === 'data')
                ? 'DisjointDataProperties'
                : 'DisjointObjectProperties';
        return { owlConstruct: name, description: bounded(`${name}(${renderer.items(members, 0)})`) };
    }
    if (types.has(`${OWL}NegativePropertyAssertion`)) {
        const data = renderer.has(root, `${OWL}targetValue`);
        const name = data ? 'NegativeDataPropertyAssertion' : 'NegativeObjectPropertyAssertion';
        return {
            owlConstruct: name,
            description: bounded(
                `${name}(${renderer.term(renderer.value(root, `${OWL}assertionProperty`))} ${renderer.term(renderer.value(root, `${OWL}sourceIndividual`))} ${renderer.term(renderer.value(root, data ? `${OWL}targetValue` : `${OWL}targetIndividual`))})`,
            ),
        };
    }
    const expression = renderer.constructorName(root);
    if (expression !== null) {
        // A class expression no named statement owns: a general class axiom when it is the subject of one.
        const axioms = view
            .outgoing(root)
            .filter((quad) =>
                [`${RDFS}subClassOf`, `${OWL}equivalentClass`, `${OWL}disjointWith`].includes(quad.predicate.value),
            )
            .map((quad) => renderer.axiom(root, quad.predicate.value, quad.object));
        return {
            owlConstruct: expression,
            description: bounded(
                axioms.length === 0
                    ? `${renderer.expression(root)}, an anonymous expression no axiom uses`
                    : `general class axiom ${axioms.join(', ')}`,
            ),
        };
    }
    return {
        owlConstruct: construct === 'anonymous-individual' ? 'AnonymousIndividual' : null,
        description: bounded(`anonymous node ${predicateList(renderer, view, root)}`.trimEnd()),
    };
}

function namedConstruct(renderer: Renderer, quad: Quad, construct: string): string | null {
    const predicate = quad.predicate.value;
    if (
        quad.object.termType === 'BlankNode' &&
        predicate !== `${OWL}propertyChainAxiom` &&
        predicate !== `${OWL}hasKey` &&
        predicate !== `${OWL}disjointUnionOf`
    ) {
        const expression = renderer.constructorName(quad.object);
        if (expression !== null) {
            return expression;
        }
    }
    if (predicate === RDF_TYPE && quad.object.termType === 'NamedNode') {
        const characteristic = CHARACTERISTICS[quad.object.value];
        if (characteristic !== undefined) {
            const kind = renderer.propertyKind(quad.subject);
            return kind === 'data' ? characteristic[1] : characteristic[0];
        }
        if (construct === 'double-property-typing' || construct === 'reserved-term-declaration') {
            return 'Declaration';
        }
        return null;
    }
    const kind = renderer.propertyKind(quad.subject);
    switch (predicate) {
        case `${RDFS}subPropertyOf`:
            return kind === 'data'
                ? 'SubDataPropertyOf'
                : kind === 'annotation'
                  ? 'SubAnnotationPropertyOf'
                  : kind === 'object'
                    ? 'SubObjectPropertyOf'
                    : null;
        case `${OWL}equivalentProperty`:
            return kind === 'data'
                ? 'EquivalentDataProperties'
                : kind === 'object'
                  ? 'EquivalentObjectProperties'
                  : null;
        case `${OWL}propertyDisjointWith`:
            return kind === 'data' ? 'DisjointDataProperties' : kind === 'object' ? 'DisjointObjectProperties' : null;
        default:
            break;
    }
    const axiom = AXIOM_NAMES[predicate];
    if (axiom !== undefined) {
        return axiom;
    }
    if (ANNOTATION_CONSTRUCTS.has(construct)) {
        return renderer.types(quad.subject).has(OWL_ONTOLOGY) ? 'Annotation' : 'AnnotationAssertion';
    }
    if (construct === 'unsupported-datatype') {
        return predicate === `${RDFS}range`
            ? kind === 'annotation'
                ? 'AnnotationPropertyRange'
                : 'DataPropertyRange'
            : renderer.propertyKind(quad.predicate) === 'annotation'
              ? 'AnnotationAssertion'
              : 'DataPropertyAssertion';
    }
    if (construct === 'anonymous-individual') {
        return 'ObjectPropertyAssertion';
    }
    return null;
}

/**
 * Explains one finding from its root statement: the named statement it starts from, or the typing statement of an
 * anonymous structure (any statement of it when untyped).
 */
export function explainFinding(view: FindingGraphView, root: Quad, construct: string): FindingExplanation {
    const renderer = new Renderer(view);
    if (root.subject.termType !== 'NamedNode') {
        return explainAnonymous(renderer, view, root.subject, construct);
    }
    return {
        owlConstruct: namedConstruct(renderer, root, construct),
        description: bounded(renderer.axiom(root.subject, root.predicate.value, root.object)),
    };
}
