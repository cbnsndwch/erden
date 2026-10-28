import { createHash } from 'node:crypto';

import type { Quad, Term } from 'n3';

import { admittedAt, type ClassExpression } from '@erden/reasoner-protocol';

import { quadKey } from '../assembly.js';
import type { AssembledOntology, LoadedTurtleSource } from '../model.js';
import { OWL, RDF, RDFS, XSD } from '../model.js';
import { compareCodePoints } from '../order.js';

import { explainFinding } from './explain.js';
import {
    readClassExpression,
    readListCells,
    readObjectPropertyExpression,
    type ExpressionContext,
} from './expressions.js';

/**
 * The profile partition sorts every asserted statement into one of four groups before reasoning:
 *
 * - reasoned: today's V1 axioms, sent to the reasoner exactly as before;
 * - accepted: annotations with no logical effect that every project may use, in either mode: `rdfs:seeAlso`,
 *   `owl:versionIRI`, and a predicate no source declares used with an IRI or a literal value, which is read as an
 *   annotation property and reported as a warning. They stay in the graph for every other stage but never reach the
 *   reasoner, whose allowlist does not name them, so no reasoning result can depend on them;
 * - annotation: statements with no logical effect that the V1 normalizer refuses, such as other header vocabulary
 *   and blank-node annotation values;
 * - unreasoned: logical axioms outside V1, such as restrictions, sub-properties and property characteristics.
 *
 * The last two groups are findings. A finding is one root statement on a named subject, or one anonymous structure
 * with no named referrer, together with every blank-node statement it owns. A project's `outsideProfile` policy
 * decides what happens to its findings: `refuse` (the default, today's behaviour) fails the check listing every
 * finding at once; `report` leaves them out of the reasoner request and lists them in the report. A finding is in
 * `report` mode only when every source asserting any of its statements belongs to a project in `report` mode.
 *
 * Every construct classified here is one the V1 normalizer refuses on its own, so a project with no findings
 * normalizes exactly as it did before the partition existed.
 */
export const PROFILE_PARTITION_RULES_ID = 'erden.profile-partition/v3' as const;

export type OutsideProfilePolicy = 'refuse' | 'report';
export type ProfilePartitionGroup = 'annotation' | 'unreasoned';

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_PROPERTY = `${RDF}Property`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const RDFS_SUBCLASS = `${RDFS}subClassOf`;
const RDFS_DATATYPE = `${RDFS}Datatype`;
const OWL_ANNOTATION_PROPERTY = `${OWL}AnnotationProperty`;
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const OWL_DATA_PROPERTY = `${OWL}DatatypeProperty`;
const OWL_ONTOLOGY_PROPERTY = `${OWL}OntologyProperty`;
const OWL_RESTRICTION = `${OWL}Restriction`;
const OWL_UNION_OF = `${OWL}unionOf`;
const OWL_IMPORTS = `${OWL}imports`;
const OWL_VERSION_IRI = `${OWL}versionIRI`;
const OWL_ON_PROPERTY = `${OWL}onProperty`;
const OWL_ON_DATATYPE = `${OWL}onDatatype`;
const OWL_EQUIVALENT_CLASS = `${OWL}equivalentClass`;
const OWL_DISJOINT_WITH = `${OWL}disjointWith`;
const OWL_INVERSE_OF = `${OWL}inverseOf`;
const OWL_ANNOTATED_TARGET = `${OWL}annotatedTarget`;
const OWL_AXIOM = `${OWL}Axiom`;
const OWL_ANNOTATION = `${OWL}Annotation`;
const RDF_NIL = `${RDF}nil`;
const RDFS_SEE_ALSO = `${RDFS}seeAlso`;

const ENTITY_TYPES = new Set([
    `${OWL}Ontology`,
    `${OWL}Class`,
    `${RDFS}Class`,
    OWL_OBJECT_PROPERTY,
    OWL_DATA_PROPERTY,
    OWL_ANNOTATION_PROPERTY,
    `${OWL}NamedIndividual`,
    RDFS_DATATYPE,
]);

/**
 * Annotation vocabulary every project may use: kept out of the reasoner request and never a finding, as long as its
 * value is an IRI or a literal. A blank-node value stays a finding under the predicate's own name.
 */
const ACCEPTED_VOCABULARY = new Set([OWL_VERSION_IRI, RDFS_SEE_ALSO]);
/** Other ontology-header and deprecation vocabulary: annotation statements the V1 profile does not declare. */
const ANNOTATION_VOCABULARY = new Set([
    ...ACCEPTED_VOCABULARY,
    `${OWL}versionInfo`,
    `${OWL}priorVersion`,
    `${OWL}backwardCompatibleWith`,
    `${OWL}incompatibleWith`,
    `${OWL}deprecated`,
    `${RDFS}isDefinedBy`,
]);
/** The construct of an undeclared predicate read as an annotation property: accepted, with a warning. */
export const UNDECLARED_ANNOTATION_PROPERTY = 'undeclared-annotation-property' as const;
/** The construct of a structure the normalizer refused in report mode: listed rather than aborting the check. */
export const MALFORMED_RDF = 'malformed-rdf' as const;
/**
 * A union domain whose case split the reasoner could not keep local (its refusal `union-domain-not-local`): in
 * report mode the domain statement is left out and listed under this label, and the rest is reasoned again.
 */
export const UNION_DOMAIN_NOT_LOCAL = 'union-domain-not-local' as const;
const ANNOTATION_TYPES = new Set([`${OWL}DeprecatedClass`, `${OWL}DeprecatedProperty`]);
const CHARACTERISTIC_TYPES = new Set([
    `${OWL}FunctionalProperty`,
    `${OWL}InverseFunctionalProperty`,
    `${OWL}SymmetricProperty`,
    `${OWL}AsymmetricProperty`,
    `${OWL}ReflexiveProperty`,
    `${OWL}IrreflexiveProperty`,
]);
const ANONYMOUS_AXIOM_TYPES = new Set([
    `${OWL}AllDifferent`,
    `${OWL}AllDisjointClasses`,
    `${OWL}AllDisjointProperties`,
    `${OWL}NegativePropertyAssertion`,
]);
const UNREASONED_PREDICATES = new Set([
    `${RDFS}subPropertyOf`,
    `${OWL}equivalentProperty`,
    `${OWL}propertyDisjointWith`,
    `${OWL}sameAs`,
    `${OWL}differentFrom`,
    `${OWL}disjointUnionOf`,
    `${OWL}propertyChainAxiom`,
    `${OWL}hasKey`,
    OWL_IMPORTS,
]);
/** Property characteristics profile V2 reasons over (`owl:FunctionalProperty` also for a data property). */
const REASONED_CHARACTERISTICS = new Set([
    `${OWL}FunctionalProperty`,
    `${OWL}InverseFunctionalProperty`,
    `${OWL}SymmetricProperty`,
]);
/** Property relations profile V2 reasons over between two object or two data properties. */
const PROPERTY_RELATIONS = new Set([`${RDFS}subPropertyOf`, `${OWL}equivalentProperty`, `${OWL}propertyChainAxiom`]);
/** The axioms a general class axiom's anonymous subject carries. */
const GENERAL_AXIOM_PREDICATES: ReadonlySet<string> = new Set([
    `${RDFS}subClassOf`,
    `${OWL}equivalentClass`,
    `${OWL}disjointWith`,
]);

/**
 * The vocabulary of the V2 property axioms in its structural role (the predicate, or the type of a property): read
 * into axioms by the normalizer, never an entity the reasoner's reserved-term allowlist must name.
 */
const V2_VOCABULARY: ReadonlySet<string> = new Set([...REASONED_CHARACTERISTICS, ...PROPERTY_RELATIONS]);

/** Whether a class expression is admitted at each polarity asked for. */
function admittedIn(expression: ClassExpression, positive: boolean, negative: boolean): boolean {
    return (!positive || admittedAt(expression, true)) && (!negative || admittedAt(expression, false));
}

const BUILTIN_ANNOTATION_PROPERTIES = new Set([`${RDFS}label`, `${RDFS}comment`]);
const BUILTIN_PROPERTIES = new Set([`${OWL}bottomObjectProperty`, `${OWL}bottomDataProperty`]);
const BUILTIN_CLASSES = new Set([`${OWL}Thing`, `${OWL}Nothing`]);
const CLASS_EXPRESSION_PREDICATES = [
    OWL_UNION_OF,
    `${OWL}intersectionOf`,
    `${OWL}complementOf`,
    `${OWL}oneOf`,
    `${OWL}onProperty`,
    `${OWL}onDatatype`,
];

const PREFIXES: ReadonlyArray<readonly [string, string]> = [
    [OWL, 'owl:'],
    [RDFS, 'rdfs:'],
    [RDF, 'rdf:'],
    [XSD, 'xsd:'],
];

function curie(iri: string): string {
    const prefix = PREFIXES.find(([namespace]) => iri.startsWith(namespace));
    return prefix === undefined ? iri : `${prefix[1]}${iri.slice(prefix[0].length)}`;
}

function isReserved(iri: string): boolean {
    return PREFIXES.some(([namespace]) => iri.startsWith(namespace));
}

/**
 * The versioned rules: the construct census with each construct's group, how a finding's policy is decided, how
 * imports are matched, and which core validation rules are limited to the reasoned group in report mode. Its
 * SHA-256 is recorded with every report-mode result, so the CLI and the server can show they applied the same rules.
 */
export const PROFILE_PARTITION_RULES_DOCUMENT = `${JSON.stringify({
    id: PROFILE_PARTITION_RULES_ID,
    groups: ['reasoned', 'accepted', 'annotation', 'unreasoned'],
    accepted: [
        ...[...ACCEPTED_VOCABULARY].map((iri) => `${curie(iri)}:iri-or-literal-value`).sort(compareCodePoints),
        `${UNDECLARED_ANNOTATION_PROPERTY}:iri-or-literal-value:warning`,
    ],
    annotation: [
        ...[...ANNOTATION_VOCABULARY, ...ANNOTATION_TYPES].map(curie).sort(compareCodePoints),
        'blank-node-annotation-value',
        'double-property-typing',
        'owl:Axiom',
        'plain-rdf-property:literal-or-blank-values',
        'rdf:Property:beside-an-owl-property-kind',
        'reserved-term-declaration:annotation-or-ontology-property-typing',
        'undeclared-predicate:blank-node-value',
        'unsupported-datatype:annotation-value',
    ],
    unreasoned: [
        ...[...UNREASONED_PREDICATES, ...CHARACTERISTIC_TYPES, ...ANONYMOUS_AXIOM_TYPES]
            .map(curie)
            .sort(compareCodePoints),
        'anonymous-individual',
        'anonymous-node',
        'class-expression',
        'datatype-restriction',
        `${MALFORMED_RDF}:report-mode-only`,
        'owl:Restriction',
        'plain-rdf-property:iri-values',
        'reserved-predicate',
        'reserved-term',
        'reserved-term-role',
        'reserved-type',
        'undeclared-property-axiom',
        `${UNION_DOMAIN_NOT_LOCAL}:report-mode-only`,
        'union-range',
        'unsupported-datatype:range-or-data-value',
    ],
    finding: 'named-root-statement-or-anonymous-root-with-owned-blank-node-statements/v1',
    sharing: 'an-owl:annotatedTarget-of-an-owl:Axiom-or-owl:Annotation-does-not-share-a-blank-node/v1',
    unionDomain: 'a-union-of-named-classes-is-reasoned-a-union-with-an-anonymous-operand-is-unreasoned/v1',
    unionDomainNotLocal:
        'a-union-domain-the-reasoner-refuses-as-not-local-is-left-out-in-report-mode-and-refused-in-refuse-mode/v1',
    // Profile V2: a class expression is reasoned where the Horn calculus admits it.
    classExpressions:
        'an-anonymous-class-expression-in-profile-v2-at-a-position-its-polarity-admits-is-reasoned-with-its-tree/v1',
    propertyAxioms:
        'sub-and-equivalent-object-or-data-properties-chains-and-functional-inverse-functional-symmetric-properties-are-reasoned/v1',
    generalAxioms: 'a-general-class-axiom-and-all-disjoint-classes-in-profile-v2-are-reasoned/v1',
    malformed:
        'shared-blank-nodes-named-list-cells-and-reserved-terms-in-logical-roles-stay-normalizer-errors-in-refuse-mode-and-are-malformed-rdf-findings-in-report-mode/v2',
    explanation: 'owl2-structural-construct-name-and-functional-style-description/v1',
    policy: 'report-only-when-every-contributing-source-is-report/v1',
    imports: 'canonical-or-version-iri-of-a-closure-source-owner/v1',
    doubleTyping: 'object-or-data-kind-wins-annotation-typing-is-a-finding/v1',
    plainRdfProperty: 'iri-values-unreasoned-otherwise-annotation/v1',
    coreValidation: {
        borrowedTerms: 'reasoned-group-statements-asserted-by-refuse-mode-projects/v1',
        propertyDomainRange: 'properties-owned-by-refuse-mode-projects-only/v1',
    },
})}\n`;
export const PROFILE_PARTITION_RULES_SHA256 = createHash('sha256')
    .update(PROFILE_PARTITION_RULES_DOCUMENT)
    .digest('hex');

export interface ProfilePartitionFinding {
    readonly group: ProfilePartitionGroup;
    readonly construct: string;
    /** The root statement's named subject, or null for an anonymous structure. */
    readonly subject: string | null;
    readonly predicate: string;
    /** The root statement's object when it is an IRI. */
    readonly object: string | null;
    /** For an unsupported datatype: the datatype the reasoner cannot decide in this usage. */
    readonly datatype?: string;
    /** Quad keys of the root statement and every blank-node statement it owns, sorted. */
    readonly statementKeys: ReadonlyArray<string>;
    readonly sourceIds: ReadonlyArray<string>;
    readonly locators: ReadonlyArray<string>;
    readonly policy: OutsideProfilePolicy;
    /** The quad key of the root statement, which a location names. */
    readonly rootKey: string;
    /** The OWL 2 structural construct the finding hinges on, such as `ObjectSomeValuesFrom`, when there is one. */
    readonly owlConstruct: string | null;
    /** The finding's statements in OWL functional-style syntax, bounded; anonymous findings are named by content. */
    readonly description: string;
    /** For a `malformed-rdf` finding: the normalizer refusal that report mode turned into this finding. */
    readonly reason?: ProfilePartitionReason;
}

/** Why the normalizer refused a structure, kept when report mode lists it as a finding instead of aborting. */
export interface ProfilePartitionReason {
    readonly code: string;
    readonly message: string;
}

/** A predicate no source declares, used with IRI or literal values and read as an annotation property. */
export interface ProfilePartitionUndeclaredAnnotationProperty {
    readonly property: string;
    readonly statementCount: number;
    /** The quad key of its first use in quad-key order, which a location names. */
    readonly firstKey: string;
    readonly sourceIds: ReadonlyArray<string>;
    readonly locators: ReadonlyArray<string>;
}

export interface ProfilePartitionImport {
    readonly ontology: string;
    readonly iri: string;
    readonly status: 'satisfied' | 'unresolved';
    readonly sourceIds: ReadonlyArray<string>;
}

export interface ProfilePartition {
    readonly rulesId: typeof PROFILE_PARTITION_RULES_ID;
    readonly rulesSha256: string;
    /** Every finding in root-statement order. */
    readonly findings: ReadonlyArray<ProfilePartitionFinding>;
    /** Statements left out of the reasoner request: those of the findings in report mode. */
    readonly excludedKeys: ReadonlySet<string>;
    /** Accepted annotations, in either mode: left out of the reasoner request, but not findings. */
    readonly acceptedKeys: ReadonlySet<string>;
    /** The undeclared predicates among the accepted annotations, sorted by IRI; each is a warning. */
    readonly undeclaredAnnotationProperties: ReadonlyArray<ProfilePartitionUndeclaredAnnotationProperty>;
    readonly imports: ReadonlyArray<ProfilePartitionImport>;
}

export type DatatypeUsage = 'range' | 'literal';

export interface ProfilePartitionOptions {
    /**
     * Whether the reasoner can decide a built-in datatype in this usage under a property of this kind; unknown
     * datatypes are decidable.
     */
    readonly isDecidableDatatype: (
        datatype: string,
        usage: DatatypeUsage,
        kind: 'DataProperty' | 'AnnotationProperty',
    ) => boolean;
    /** Whether a reserved-namespace datatype is one of the V1 built-in datatypes, which a range may name. */
    readonly isBuiltinDatatype: (datatype: string) => boolean;
    /** Whether the reasoner refuses any axiom naming this IRI (RDF, RDFS or OWL vocabulary outside its allowlist). */
    readonly isUnknownReservedIri: (iri: string) => boolean;
    /**
     * Root statements (by quad key, named subjects only) the normalizer or the reasoner refused in report mode: each
     * becomes a finding with the blank-node structure it owns, so the next normalization leaves it out. It is a
     * `union-domain-not-local` finding when that is the reason's code, and a `malformed-rdf` finding otherwise.
     */
    readonly forced?: ReadonlyMap<string, ProfilePartitionReason>;
}

type PropertyKind = 'ObjectProperty' | 'DataProperty' | 'AnnotationProperty';

interface Classification {
    readonly group: ProfilePartitionGroup | 'accepted';
    readonly construct: string;
    readonly datatype?: string;
    readonly reason?: ProfilePartitionReason;
}

function annotation(construct: string): Classification {
    return { group: 'annotation', construct };
}

function unreasoned(construct: string): Classification {
    return { group: 'unreasoned', construct };
}

function accepted(construct: string): Classification {
    return { group: 'accepted', construct };
}

function termKey(term: Term): string {
    return `${term.termType}\u0000${term.value}`;
}

/** The policy of a source's project: only an explicit `report` relaxes the profile. */
export function sourcePolicy(source: LoadedTurtleSource): OutsideProfilePolicy {
    return source.descriptor.outsideProfile === 'report' ? 'report' : 'refuse';
}

class GraphIndex {
    readonly quads: ReadonlyArray<Quad>;
    readonly bySubject = new Map<string, Quad[]>();
    readonly byObject = new Map<string, Quad[]>();
    readonly typesOf = new Map<string, Set<string>>();
    readonly #predicatesOf = new Map<string, Set<string>>();

    constructor(quads: ReadonlyArray<Quad>) {
        this.quads = quads;
        for (const quad of quads) {
            const subject = termKey(quad.subject);
            const outgoing = this.bySubject.get(subject) ?? [];
            outgoing.push(quad);
            this.bySubject.set(subject, outgoing);
            const predicates = this.#predicatesOf.get(subject) ?? new Set<string>();
            predicates.add(quad.predicate.value);
            this.#predicatesOf.set(subject, predicates);
            if (quad.object.termType === 'BlankNode') {
                const object = termKey(quad.object);
                const incoming = this.byObject.get(object) ?? [];
                incoming.push(quad);
                this.byObject.set(object, incoming);
            }
            if (quad.predicate.value === RDF_TYPE && quad.object.termType === 'NamedNode') {
                const types = this.typesOf.get(subject) ?? new Set<string>();
                types.add(quad.object.value);
                this.typesOf.set(subject, types);
            }
        }
    }

    outgoing(term: Term): ReadonlyArray<Quad> {
        return this.bySubject.get(termKey(term)) ?? [];
    }

    /** Constant time: a blank node with thousands of statements must not make each lookup scan all of them. */
    has(term: Term, predicate: string): boolean {
        return this.#predicatesOf.get(termKey(term))?.has(predicate) ?? false;
    }

    types(term: Term): ReadonlySet<string> {
        return this.typesOf.get(termKey(term)) ?? new Set();
    }

    incoming(term: Term): ReadonlyArray<Quad> {
        return this.byObject.get(termKey(term)) ?? [];
    }

    /**
     * A blank node more than one statement points to: never a well-formed list, expression or value. An axiom
     * annotation's `owl:annotatedTarget` names the annotated axiom's object again, as the OWL 2 RDF mapping says
     * (CL's annotated existential restrictions), so it does not count as a second reference.
     */
    shared(term: Term): boolean {
        if (term.termType !== 'BlankNode') {
            return false;
        }
        const incoming = this.byObject.get(termKey(term)) ?? [];
        return incoming.length > 1 && incoming.filter((quad) => !this.#annotatesTarget(quad)).length > 1;
    }

    #annotatesTarget(quad: Quad): boolean {
        if (quad.predicate.value !== OWL_ANNOTATED_TARGET || quad.subject.termType !== 'BlankNode') {
            return false;
        }
        const types = this.types(quad.subject);
        return types.has(OWL_AXIOM) || types.has(OWL_ANNOTATION);
    }
}

/** Names an anonymous class or data range by what defines it. */
function expressionConstruct(index: GraphIndex, term: Term, unionConstruct: string): string {
    const types = index.types(term);
    if (types.has(OWL_RESTRICTION) || index.has(term, OWL_ON_PROPERTY)) {
        return 'owl:Restriction';
    }
    if (types.has(RDFS_DATATYPE) || index.has(term, OWL_ON_DATATYPE)) {
        return index.has(term, OWL_UNION_OF) ? unionConstruct : 'datatype-restriction';
    }
    return index.has(term, OWL_UNION_OF) ? unionConstruct : 'class-expression';
}

interface PropertyKinds {
    readonly kinds: ReadonlyMap<string, ReadonlySet<PropertyKind>>;
    readonly plain: ReadonlySet<string>;
}

function propertyKinds(index: GraphIndex): PropertyKinds {
    const kinds = new Map<string, Set<PropertyKind>>();
    const plain = new Set<string>();
    for (const quad of index.quads) {
        if (quad.predicate.value !== RDF_TYPE || quad.subject.termType !== 'NamedNode') {
            continue;
        }
        const kind =
            quad.object.value === OWL_OBJECT_PROPERTY
                ? 'ObjectProperty'
                : quad.object.value === OWL_DATA_PROPERTY
                  ? 'DataProperty'
                  : quad.object.value === OWL_ANNOTATION_PROPERTY
                    ? 'AnnotationProperty'
                    : undefined;
        if (kind !== undefined) {
            const set = kinds.get(quad.subject.value) ?? new Set<PropertyKind>();
            set.add(kind);
            kinds.set(quad.subject.value, set);
        } else if (quad.object.value === RDF_PROPERTY) {
            plain.add(quad.subject.value);
        }
    }
    for (const property of kinds.keys()) {
        plain.delete(property);
    }
    return { kinds, plain };
}

/** The kind the reasoner would use: one logical kind wins over an extra annotation typing. */
function effectiveKind(kinds: ReadonlySet<PropertyKind> | undefined): PropertyKind | 'ambiguous' | undefined {
    if (kinds === undefined || kinds.size === 0) {
        return undefined;
    }
    const logical = [...kinds].filter((kind) => kind !== 'AnnotationProperty');
    if (logical.length > 1) {
        return 'ambiguous';
    }
    return logical[0] ?? 'AnnotationProperty';
}

class Classifier {
    readonly #index: GraphIndex;
    readonly #kinds: PropertyKinds;
    readonly #options: ProfilePartitionOptions;
    readonly #plainUsage = new Map<string, 'iri' | 'other'>();

    constructor(index: GraphIndex, options: ProfilePartitionOptions) {
        this.#index = index;
        this.#kinds = propertyKinds(index);
        this.#options = options;
        for (const quad of index.quads) {
            if (this.#kinds.plain.has(quad.predicate.value)) {
                const previous = this.#plainUsage.get(quad.predicate.value);
                this.#plainUsage.set(
                    quad.predicate.value,
                    quad.object.termType === 'NamedNode' && previous !== 'other' ? 'iri' : 'other',
                );
            }
        }
    }

    get #expressions(): ExpressionContext {
        return {
            graph: { outgoing: (term) => this.#index.outgoing(term), incoming: (term) => this.#index.incoming(term) },
            propertyKind: (iri) => {
                const kind = this.#kindOf(iri);
                return kind === 'ObjectProperty' || kind === 'DataProperty' || kind === 'AnnotationProperty'
                    ? kind
                    : undefined;
            },
            isClassIri: (iri) => !isReserved(iri) || BUILTIN_CLASSES.has(iri),
        };
    }

    /** Whether the expression at `term` (owned by `owner`) is in profile V2 at these polarities. */
    #admitted(term: Term, owner: Quad | undefined, positive: boolean, negative: boolean, extra?: ReadonlySet<string>) {
        const reading = readClassExpression(this.#expressions, term, owner, extra);
        return reading.kind === 'read' && admittedIn(reading.value, positive, negative);
    }

    /** A class expression in a reasoned position: undefined when V2 admits it, else the V1-era finding. */
    #expression(quad: Quad, positive: boolean, negative: boolean, unionConstruct = 'class-expression') {
        return this.#admitted(quad.object, quad, positive, negative)
            ? undefined
            : unreasoned(expressionConstruct(this.#index, quad.object, unionConstruct));
    }

    /** An object property expression or a data property of the given kind, as a sub- or equivalent property. */
    #propertyOfKind(term: Term, owner: Quad, kind: PropertyKind): boolean {
        if (term.termType === 'NamedNode') {
            return this.#kindOf(term.value) === kind;
        }
        return (
            kind === 'ObjectProperty' && readObjectPropertyExpression(this.#expressions, term, owner).kind === 'read'
        );
    }

    /** `rdfs:subPropertyOf`, `owl:equivalentProperty` and `owl:propertyChainAxiom` between properties of one kind. */
    #propertyRelation(quad: Quad): Classification | undefined {
        const predicate = quad.predicate.value;
        const kind = this.#kindOf(quad.subject.value);
        if (kind !== 'ObjectProperty' && kind !== 'DataProperty') {
            return unreasoned(curie(predicate));
        }
        if (predicate === `${OWL}propertyChainAxiom`) {
            if (kind !== 'ObjectProperty') {
                return unreasoned(curie(predicate));
            }
            const cells = readListCells(this.#expressions, quad.object, quad);
            return cells.kind === 'read' &&
                cells.value.length >= 2 &&
                cells.value.every(({ item, owner }) => this.#propertyOfKind(item, owner, 'ObjectProperty'))
                ? undefined
                : unreasoned(curie(predicate));
        }
        return this.#propertyOfKind(quad.object, quad, kind) ? undefined : unreasoned(curie(predicate));
    }

    /**
     * An anonymous structure the reasoner receives: a general class axiom (an anonymous class expression that is the
     * subject of `rdfs:subClassOf`, `owl:equivalentClass` or `owl:disjointWith`), or `owl:AllDisjointClasses`, in V2.
     */
    reasonedAnonymous(node: Term): boolean {
        if (node.termType !== 'BlankNode' || this.#index.incoming(node).length > 0) {
            return false;
        }
        const outgoing = this.#index.outgoing(node);
        const types = this.#index.types(node);
        if (types.has(`${OWL}AllDisjointClasses`)) {
            const members = outgoing.filter((quad) => quad.predicate.value === `${OWL}members`);
            const typing = outgoing.filter((quad) => quad.predicate.value === RDF_TYPE);
            const cells =
                members.length === 1
                    ? readListCells(this.#expressions, (members[0] as Quad).object, members[0] as Quad)
                    : undefined;
            return (
                typing.length === 1 &&
                outgoing.length === 2 &&
                cells?.kind === 'read' &&
                cells.value.length >= 2 &&
                cells.value.every(({ item, owner }) => this.#admitted(item, owner, false, true))
            );
        }
        const axioms = outgoing.filter((quad) => GENERAL_AXIOM_PREDICATES.has(quad.predicate.value));
        if (axioms.length === 0) {
            return false;
        }
        const negative = true;
        const positive = axioms.some((quad) => quad.predicate.value === OWL_EQUIVALENT_CLASS);
        return (
            this.#admitted(node, undefined, positive, negative, GENERAL_AXIOM_PREDICATES) &&
            axioms.every((quad) =>
                quad.predicate.value === RDFS_SUBCLASS
                    ? this.#admitted(quad.object, quad, true, false)
                    : quad.predicate.value === OWL_EQUIVALENT_CLASS
                      ? this.#admitted(quad.object, quad, true, true)
                      : this.#admitted(quad.object, quad, false, true),
            )
        );
    }

    #kindOf(property: string): PropertyKind | 'ambiguous' | 'plain' | undefined {
        if (BUILTIN_ANNOTATION_PROPERTIES.has(property)) {
            return 'AnnotationProperty';
        }
        if (this.#kinds.plain.has(property)) {
            return 'plain';
        }
        return effectiveKind(this.#kinds.kinds.get(property));
    }

    #plainProperty(property: string): Classification {
        return this.#plainUsage.get(property) === 'iri'
            ? unreasoned('plain-rdf-property')
            : annotation('plain-rdf-property');
    }

    /** A statement about a property (domain, range, inverse) whose kind the reasoner cannot know. */
    #propertyAxiom(property: string): Classification | undefined {
        const kind = this.#kindOf(property);
        if (kind === 'plain') {
            return this.#plainProperty(property);
        }
        if (kind === undefined && !BUILTIN_PROPERTIES.has(property)) {
            return isReserved(property) ? unreasoned('reserved-predicate') : unreasoned('undeclared-property-axiom');
        }
        return undefined;
    }

    #type(quad: Quad): Classification | undefined {
        const subject = quad.subject.value;
        if (quad.object.termType === 'BlankNode') {
            return this.#expression(quad, true, false);
        }
        if (quad.object.termType !== 'NamedNode') {
            return undefined;
        }
        const type = quad.object.value;
        if (type === OWL_ONTOLOGY_PROPERTY) {
            return annotation('reserved-term-declaration');
        }
        if (ENTITY_TYPES.has(type)) {
            // Declaring header vocabulary such as owl:versionInfo is harmless; other reserved roles stay errors.
            if (
                type === OWL_ANNOTATION_PROPERTY &&
                isReserved(subject) &&
                !BUILTIN_ANNOTATION_PROPERTIES.has(subject)
            ) {
                return annotation('reserved-term-declaration');
            }
            if (type === OWL_ANNOTATION_PROPERTY) {
                const kind = this.#kindOf(subject);
                return kind === 'ObjectProperty' || kind === 'DataProperty'
                    ? annotation('double-property-typing')
                    : undefined;
            }
            return undefined;
        }
        if (type === `${OWL}TransitiveProperty`) {
            return undefined;
        }
        if (type === RDF_PROPERTY) {
            return this.#kinds.plain.has(subject) ? this.#plainProperty(subject) : annotation('rdf:Property');
        }
        if (ANNOTATION_TYPES.has(type)) {
            return annotation(curie(type));
        }
        if (REASONED_CHARACTERISTICS.has(type)) {
            const kind = this.#kindOf(subject);
            return kind === 'ObjectProperty' || (kind === 'DataProperty' && type === `${OWL}FunctionalProperty`)
                ? undefined
                : unreasoned(curie(type));
        }
        if (CHARACTERISTIC_TYPES.has(type) || ANONYMOUS_AXIOM_TYPES.has(type)) {
            return unreasoned(curie(type));
        }
        if (type === OWL_RESTRICTION) {
            return unreasoned('owl:Restriction');
        }
        if (isReserved(type) && !BUILTIN_CLASSES.has(type)) {
            return unreasoned('reserved-type');
        }
        return undefined;
    }

    #assertion(quad: Quad): Classification | undefined {
        const predicate = quad.predicate.value;
        const kind = this.#kindOf(predicate);
        if (kind === 'plain') {
            return this.#plainProperty(predicate);
        }
        if (kind === undefined) {
            if (BUILTIN_PROPERTIES.has(predicate)) {
                return undefined;
            }
            if (isReserved(predicate)) {
                return unreasoned('reserved-predicate');
            }
            // An undeclared predicate is read as an annotation property; a blank-node value stays a finding.
            return quad.object.termType === 'BlankNode'
                ? annotation('undeclared-predicate')
                : accepted(UNDECLARED_ANNOTATION_PROPERTY);
        }
        if (kind === 'ambiguous') {
            return undefined;
        }
        const object = quad.object;
        if (object.termType === 'BlankNode') {
            return kind === 'AnnotationProperty'
                ? annotation('blank-node-annotation-value')
                : unreasoned('anonymous-individual');
        }
        if (object.termType === 'Literal' && kind !== 'ObjectProperty') {
            if (!this.#options.isDecidableDatatype(object.datatype.value, 'literal', kind)) {
                const datatype = object.datatype.value;
                return kind === 'AnnotationProperty'
                    ? { group: 'annotation', construct: 'unsupported-datatype', datatype }
                    : { group: 'unreasoned', construct: 'unsupported-datatype', datatype };
            }
        }
        return undefined;
    }

    #range(quad: Quad): Classification | undefined {
        const property = quad.subject.value;
        const axiom = this.#propertyAxiom(property);
        if (axiom !== undefined) {
            return axiom;
        }
        if (quad.object.termType === 'BlankNode') {
            return this.#kindOf(property) === 'ObjectProperty'
                ? this.#expression(quad, true, false, 'union-range')
                : unreasoned(expressionConstruct(this.#index, quad.object, 'union-range'));
        }
        const kind = this.#kindOf(property);
        if (
            quad.object.termType === 'NamedNode' &&
            (kind === 'DataProperty' || kind === 'AnnotationProperty') &&
            !this.#options.isDecidableDatatype(quad.object.value, 'range', kind)
        ) {
            return { group: 'unreasoned', construct: 'unsupported-datatype', datatype: quad.object.value };
        }
        return undefined;
    }

    /** Classifies a statement on a named subject; undefined means the reasoner receives it. */
    root(quad: Quad): Classification | undefined {
        const predicate = quad.predicate.value;
        if (this.#malformed(quad)) {
            // Malformed plumbing: the normalizer refuses it with the precise list or expression error.
            return undefined;
        }
        if (predicate === RDF_TYPE) {
            return this.#type(quad);
        }
        if (ANNOTATION_VOCABULARY.has(predicate)) {
            return ACCEPTED_VOCABULARY.has(predicate) && quad.object.termType !== 'BlankNode'
                ? accepted(curie(predicate))
                : annotation(curie(predicate));
        }
        if (PROPERTY_RELATIONS.has(predicate)) {
            return this.#propertyRelation(quad);
        }
        if (UNREASONED_PREDICATES.has(predicate)) {
            return unreasoned(curie(predicate));
        }
        if (predicate === OWL_UNION_OF) {
            return unreasoned('class-expression');
        }
        if (predicate === RDFS_SUBCLASS || predicate === OWL_EQUIVALENT_CLASS || predicate === OWL_DISJOINT_WITH) {
            if (quad.object.termType === 'BlankNode') {
                return (
                    this.#reservedClass(quad.subject) ??
                    this.#expression(quad, predicate !== OWL_DISJOINT_WITH, predicate !== RDFS_SUBCLASS)
                );
            }
            return this.#reservedClass(quad.subject) ?? this.#reservedClass(quad.object);
        }
        if (predicate === RDFS_DOMAIN) {
            const axiom = this.#propertyAxiom(quad.subject.value) ?? this.#reservedClass(quad.object);
            if (axiom !== undefined) {
                return axiom;
            }
            if (quad.object.termType !== 'BlankNode') {
                return undefined;
            }
            if (!this.#index.has(quad.object, OWL_UNION_OF)) {
                return this.#kindOf(quad.subject.value) === 'AnnotationProperty'
                    ? unreasoned(expressionConstruct(this.#index, quad.object, 'class-expression'))
                    : this.#expression(quad, true, false);
            }
            // A union of named classes is a V1 domain; the normalizer validates its list.
            return this.#unionWithAnonymousOperand(quad.object) ? unreasoned('class-expression') : undefined;
        }
        if (predicate === RDFS_RANGE) {
            const object = quad.object;
            return object.termType === 'NamedNode' && this.#options.isBuiltinDatatype(object.value)
                ? this.#range(quad)
                : (this.#reservedClass(object) ?? this.#range(quad));
        }
        if (predicate === OWL_INVERSE_OF) {
            return (
                this.#propertyAxiom(quad.subject.value) ??
                (quad.object.termType === 'NamedNode' ? this.#propertyAxiom(quad.object.value) : undefined)
            );
        }
        return this.#assertion(quad);
    }

    /**
     * Whether a union's well-formed list has an anonymous operand, such as BFO's union domains with an intersection
     * and a complement: valid OWL outside V1. A union of named classes, or a malformed list, is the normalizer's to
     * validate or refuse.
     */
    #unionWithAnonymousOperand(node: Term): boolean {
        const unions = this.#index.outgoing(node).filter((quad) => quad.predicate.value === OWL_UNION_OF);
        let cursor = unions.length === 1 ? (unions[0] as Quad).object : undefined;
        const seen = new Set<string>();
        let anonymous = false;
        while (cursor !== undefined && !(cursor.termType === 'NamedNode' && cursor.value === RDF_NIL)) {
            if (cursor.termType !== 'BlankNode' || seen.has(cursor.value)) {
                return false;
            }
            seen.add(cursor.value);
            const outgoing = this.#index.outgoing(cursor);
            const first = outgoing.filter((quad) => quad.predicate.value === RDF_FIRST);
            const rest = outgoing.filter((quad) => quad.predicate.value === RDF_REST);
            if (first.length !== 1 || rest.length !== 1) {
                return false;
            }
            anonymous ||= (first[0] as Quad).object.termType === 'BlankNode';
            cursor = (rest[0] as Quad).object;
        }
        return cursor !== undefined && anonymous;
    }

    /**
     * Reserved vocabulary in a class position, such as SKOS's `rdfs:range rdf:List` or schema.org's
     * `owl:equivalentClass rdfs:Class`: OWL Full usage the V1 profile cannot reason over.
     */
    #reservedClass(term: Term): Classification | undefined {
        return term.termType === 'NamedNode' && isReserved(term.value) && !BUILTIN_CLASSES.has(term.value)
            ? unreasoned('reserved-term-role')
            : undefined;
    }

    /**
     * A statement the normalizer would pass on that names RDF, RDFS or OWL vocabulary the reasoner's allowlist lacks,
     * such as PROV-O's `rdfs:seeAlso rdfs:comment ""`: the reasoner would refuse the whole request.
     */
    reservedTerm(quad: Quad): Classification | undefined {
        if (this.#malformed(quad)) {
            return undefined;
        }
        const terms = [quad.subject, quad.predicate, quad.object];
        const named = terms.some(
            (term) =>
                term.termType === 'NamedNode' &&
                !V2_VOCABULARY.has(term.value) &&
                this.#options.isUnknownReservedIri(term.value),
        );
        const datatype =
            quad.object.termType === 'Literal' && this.#options.isUnknownReservedIri(quad.object.datatype.value);
        if (!named && !datatype) {
            return undefined;
        }
        return this.#kindOf(quad.predicate.value) === 'AnnotationProperty'
            ? annotation('reserved-term')
            : unreasoned('reserved-term');
    }

    /**
     * A named list cell, or a list or class expression that more than one statement points to. A shared blank node
     * that is neither, such as a person several header annotations name (DPV's `_:person-…`), is ordinary data.
     */
    #malformed(quad: Quad): boolean {
        const predicate = quad.predicate.value;
        if (predicate === RDF_FIRST || predicate === RDF_REST) {
            return true;
        }
        const object = quad.object;
        if (!this.#index.shared(object)) {
            return false;
        }
        const types = this.#index.types(object);
        return (
            this.#index.has(object, RDF_FIRST) ||
            this.#index.has(object, RDF_REST) ||
            types.has(OWL_RESTRICTION) ||
            types.has(`${OWL}Class`) ||
            types.has(RDFS_DATATYPE) ||
            CLASS_EXPRESSION_PREDICATES.some((item) => this.#index.has(object, item))
        );
    }

    /** Classifies an anonymous structure that no named statement owns, by its root node's type. */
    anonymous(root: Term): Classification {
        const types = this.#index.types(root);
        if (types.has(`${OWL}Axiom`) || types.has(`${OWL}Annotation`)) {
            return annotation('owl:Axiom');
        }
        const known = [...types].filter((type) => ANONYMOUS_AXIOM_TYPES.has(type)).sort(compareCodePoints)[0];
        if (known !== undefined) {
            return unreasoned(curie(known));
        }
        if (
            types.has(OWL_RESTRICTION) ||
            types.has(`${OWL}Class`) ||
            types.has(RDFS_DATATYPE) ||
            CLASS_EXPRESSION_PREDICATES.some((predicate) => this.#index.has(root, predicate))
        ) {
            return unreasoned(expressionConstruct(this.#index, root, 'class-expression'));
        }
        if ([...types].some((type) => !isReserved(type))) {
            return unreasoned('anonymous-individual');
        }
        return unreasoned('anonymous-node');
    }
}

interface StatementInfo {
    readonly key: string;
    readonly quad: Quad;
    readonly sourceIds: ReadonlyArray<string>;
    readonly locators: ReadonlyArray<string>;
    readonly policy: OutsideProfilePolicy;
}

function statementInfo(graph: AssembledOntology): ReadonlyMap<string, StatementInfo> {
    const policyBySource = new Map(graph.sources.map((source) => [source.descriptor.id, sourcePolicy(source)]));
    const info = new Map<string, StatementInfo>();
    for (const entry of graph.provenance) {
        if (entry.asserted.length === 0) {
            continue;
        }
        const sourceIds = [...new Set(entry.asserted.map((item) => item.sourceId))].sort(compareCodePoints);
        const locators = [...new Set(entry.asserted.map((item) => item.locator))].sort(compareCodePoints);
        const policy = sourceIds.every((id) => policyBySource.get(id) === 'report') ? 'report' : 'refuse';
        info.set(entry.key, { key: entry.key, quad: entry.quad, sourceIds, locators, policy });
    }
    return info;
}

/**
 * Collects the blank-node statements a root owns: everything reachable through blank-node objects. A finding stops
 * at a shared blank node, which is malformed plumbing the normalizer must see.
 */
function ownedStatements(
    index: GraphIndex,
    start: Term,
    claimed: Set<string>,
    stopAtShared: boolean,
): ReadonlyArray<Quad> {
    const owned: Quad[] = [];
    const pending: Term[] = [start];
    const visited = new Set<string>();
    while (pending.length > 0) {
        const node = pending.pop();
        if (
            node === undefined ||
            node.termType !== 'BlankNode' ||
            visited.has(termKey(node)) ||
            (stopAtShared && node !== start && index.shared(node))
        ) {
            continue;
        }
        visited.add(termKey(node));
        for (const quad of index.outgoing(node)) {
            const key = quadKey(quad);
            if (claimed.has(key)) {
                continue;
            }
            claimed.add(key);
            owned.push(quad);
            pending.push(quad.object);
        }
    }
    return owned;
}

function closureIris(graph: AssembledOntology, index: GraphIndex): ReadonlySet<string> {
    const owners = new Set(graph.sources.map((source) => source.descriptor.owner.canonicalIri));
    const iris = new Set(owners);
    for (const quad of index.quads) {
        if (
            quad.predicate.value === OWL_VERSION_IRI &&
            quad.subject.termType === 'NamedNode' &&
            owners.has(quad.subject.value) &&
            quad.object.termType === 'NamedNode'
        ) {
            iris.add(quad.object.value);
        }
    }
    return iris;
}

/**
 * Partitions the asserted statements of a validated assembled ontology. A pure function of the graph and each
 * source's `outsideProfile` policy, so the CLI and the server compute the same partition.
 */
export function partitionAssembledOntology(
    graph: AssembledOntology,
    options: ProfilePartitionOptions,
): ProfilePartition {
    const info = statementInfo(graph);
    const quads = [...info.values()]
        .sort((left, right) => compareCodePoints(left.key, right.key))
        .map((item) => item.quad);
    const index = new GraphIndex(quads);
    const classifier = new Classifier(index, options);
    const claimed = new Set<string>();
    const roots: Array<{
        readonly root: Quad;
        readonly classification: Classification;
        readonly owned: ReadonlyArray<Quad>;
    }> = [];
    const acceptedKeys = new Set<string>();
    const undeclared = new Map<string, Quad[]>();
    for (const quad of quads) {
        if (quad.subject.termType !== 'NamedNode') {
            continue;
        }
        const key = quadKey(quad);
        claimed.add(key);
        const reason = options.forced?.get(key);
        const classification =
            reason === undefined
                ? (classifier.root(quad) ?? classifier.reservedTerm(quad))
                : {
                      group: 'unreasoned' as const,
                      construct: reason.code === UNION_DOMAIN_NOT_LOCAL ? UNION_DOMAIN_NOT_LOCAL : MALFORMED_RDF,
                      reason,
                  };
        if (classification?.group === 'accepted') {
            // An IRI or literal value owns no blank-node structure.
            acceptedKeys.add(key);
            if (classification.construct === UNDECLARED_ANNOTATION_PROPERTY) {
                undeclared.set(quad.predicate.value, [...(undeclared.get(quad.predicate.value) ?? []), quad]);
            }
            continue;
        }
        if (classification === undefined) {
            // The reasoned statement keeps its blank-node structure (a union domain) for the normalizer to validate.
            ownedStatements(index, quad.object, claimed, false);
            continue;
        }
        roots.push({ root: quad, classification, owned: ownedStatements(index, quad.object, claimed, true) });
    }
    function unclaimed(term: Term): boolean {
        return index.outgoing(term).some((quad) => !claimed.has(quadKey(quad)));
    }
    // One entry per subject, not per statement: each subject's statements are scanned at most twice, so a blank
    // node with n statements costs O(n), not O(n²).
    const anonymousSubjects = new Map<string, Term>();
    for (const quad of quads) {
        if (!claimed.has(quadKey(quad))) {
            anonymousSubjects.set(termKey(quad.subject), quad.subject);
        }
    }
    const anonymousRoots = [...anonymousSubjects.entries()]
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([, term]) => term);
    // Structures that nothing points to first, then any left in blank-node cycles, each from its first node.
    const ordered = [
        ...anonymousRoots.filter((term) => (index.byObject.get(termKey(term)) ?? []).length === 0),
        ...anonymousRoots,
    ];
    for (const node of ordered) {
        if (!unclaimed(node)) {
            continue;
        }
        if (classifier.reasonedAnonymous(node)) {
            // A general class axiom or AllDisjointClasses in V2: the normalizer reads its whole tree.
            ownedStatements(index, node, claimed, false);
            continue;
        }
        const owned = ownedStatements(index, node, claimed, true);
        const typing = owned.find((quad) => quad.subject.equals(node) && quad.predicate.value === RDF_TYPE);
        const root = typing ?? owned[0];
        if (root !== undefined) {
            roots.push({
                root,
                classification: classifier.anonymous(node),
                owned: owned.filter((quad) => quad !== root),
            });
        }
    }
    const findings = roots
        .map(({ root, classification, owned }): ProfilePartitionFinding => {
            const statements = [root, ...owned].map((quad) => info.get(quadKey(quad)) as StatementInfo);
            const explanation = explainFinding(index, root, classification.construct);
            return {
                group: classification.group as ProfilePartitionGroup,
                construct: classification.construct,
                subject: root.subject.termType === 'NamedNode' ? root.subject.value : null,
                predicate: root.predicate.value,
                object: root.object.termType === 'NamedNode' ? root.object.value : null,
                ...(classification.datatype === undefined ? {} : { datatype: classification.datatype }),
                statementKeys: Object.freeze(statements.map((item) => item.key).sort(compareCodePoints)),
                sourceIds: Object.freeze(
                    [...new Set(statements.flatMap((item) => item.sourceIds))].sort(compareCodePoints),
                ),
                locators: Object.freeze(
                    [...new Set(statements.flatMap((item) => item.locators))].sort(compareCodePoints),
                ),
                policy: statements.every((item) => item.policy === 'report')
                    ? ('report' as const)
                    : ('refuse' as const),
                rootKey: quadKey(root),
                owlConstruct: explanation.owlConstruct,
                description:
                    classification.reason === undefined
                        ? explanation.description
                        : `${classification.reason.code}: ${classification.reason.message}; ${explanation.description}`,
                ...(classification.reason === undefined ? {} : { reason: Object.freeze({ ...classification.reason }) }),
            };
        })
        .sort((left, right) => compareCodePoints(left.rootKey, right.rootKey))
        .map((finding) => Object.freeze(finding));
    const excludedKeys = new Set(
        findings.filter((finding) => finding.policy === 'report').flatMap((finding) => finding.statementKeys),
    );
    const closure = closureIris(graph, index);
    const imports = findings
        .filter((finding) => finding.construct === 'owl:imports' && finding.object !== null && finding.subject !== null)
        .map((finding): ProfilePartitionImport =>
            Object.freeze({
                ontology: finding.subject as string,
                iri: finding.object as string,
                status: closure.has(finding.object as string) ? 'satisfied' : 'unresolved',
                sourceIds: finding.sourceIds,
            }),
        )
        .sort((left, right) =>
            compareCodePoints(`${left.iri}\u0000${left.ontology}`, `${right.iri}\u0000${right.ontology}`),
        );
    const undeclaredAnnotationProperties = [...undeclared.entries()]
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([property, uses]): ProfilePartitionUndeclaredAnnotationProperty => {
            const statements = uses.map((quad) => info.get(quadKey(quad)) as StatementInfo);
            return Object.freeze({
                property,
                statementCount: uses.length,
                firstKey: quadKey(uses[0] as Quad),
                sourceIds: Object.freeze(
                    [...new Set(statements.flatMap((item) => item.sourceIds))].sort(compareCodePoints),
                ),
                locators: Object.freeze(
                    [...new Set(statements.flatMap((item) => item.locators))].sort(compareCodePoints),
                ),
            });
        });
    return Object.freeze({
        rulesId: PROFILE_PARTITION_RULES_ID,
        rulesSha256: PROFILE_PARTITION_RULES_SHA256,
        findings: Object.freeze(findings),
        excludedKeys,
        acceptedKeys,
        undeclaredAnnotationProperties: Object.freeze(undeclaredAnnotationProperties),
        imports: Object.freeze(imports),
    });
}
