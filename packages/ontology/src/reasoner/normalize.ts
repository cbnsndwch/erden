import { createHash } from 'node:crypto';

import { DataFactory, type Quad, type Term } from 'n3';

import { TOOL_VERSION as BUNDLED_REASONER_VERSION } from '@erden/reasoner-distribution';
import {
    REASONER_OPERATION,
    REASONER_PROFILE_ID,
    REASONER_PROFILE_SHA256,
    REASONER_PROTOCOL_VERSION,
    MAX_REASONER_REQUEST_ID_BYTES,
    ReasonerRequestSealError,
    isUnknownReservedIri,
    sealReasonerRequest,
    stringifyCanonicalJson,
    classExpressionKey,
    type ClassExpression,
    type JsonValue,
    type ObjectPropertyExpression,
    type NormalizedAxiom,
    type ReasonerRequest,
    type RequiredTool,
} from '@erden/reasoner-protocol';

import { quadKey } from '../assembly.js';
import type { AssembledOntology, LoadedTurtleSource, ProjectSourceOwner, QuadContributor } from '../model.js';
import { OWL, RDF, RDFS, XSD } from '../model.js';
import { compareCodePoints } from '../order.js';

import { BUILTIN_DATATYPES, datatypeBoundaries, isDecidableUnder, makeDatatypeUsageCheck } from './datatypes.js';
import { ReasonerNormalizationError, type ReasonerNormalizationErrorCode } from './errors.js';
import {
    readClassExpression,
    readListCells,
    readObjectPropertyExpression,
    type ExpressionContext,
    type ExpressionReading,
} from './expressions.js';
import { DEFAULT_REASONER_LIMITS, type ReasonerRequestLimits } from './limits.js';
import { locateProfileFindings, locateStatements } from './locate.js';
import {
    partitionAssembledOntology,
    sourcePolicy,
    UNION_DOMAIN_NOT_LOCAL,
    type ProfilePartition,
    type ProfilePartitionFinding,
    type ProfilePartitionReason,
} from './partition.js';
import { assertValidExplicitAssembledOntology } from './validate.js';

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const RDF_LIST = `${RDF}List`;
const RDFS_CLASS = `${RDFS}Class`;
const RDFS_DATATYPE = `${RDFS}Datatype`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const RDFS_SUBCLASS = `${RDFS}subClassOf`;
const OWL_ANNOTATION_PROPERTY = `${OWL}AnnotationProperty`;
const OWL_CLASS = `${OWL}Class`;
const OWL_DATA_PROPERTY = `${OWL}DatatypeProperty`;
const OWL_NAMED_INDIVIDUAL = `${OWL}NamedIndividual`;
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const OWL_ONTOLOGY = `${OWL}Ontology`;
const OWL_TRANSITIVE_PROPERTY = `${OWL}TransitiveProperty`;
const OWL_EQUIVALENT_CLASS = `${OWL}equivalentClass`;
const OWL_DISJOINT_WITH = `${OWL}disjointWith`;
const OWL_INVERSE_OF = `${OWL}inverseOf`;
const OWL_IMPORTS = `${OWL}imports`;
const OWL_UNION_OF = `${OWL}unionOf`;
const OWL_BOTTOM_OBJECT_PROPERTY = `${OWL}bottomObjectProperty`;
const OWL_BOTTOM_DATA_PROPERTY = `${OWL}bottomDataProperty`;
const OWL_THING = `${OWL}Thing`;
const OWL_NOTHING = `${OWL}Nothing`;
const RDF_LANG_STRING = `${RDF}langString`;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u;
const DEFAULT_GRAPH = Object.freeze({ kind: 'DefaultGraph' as const });

type PropertyKind = 'ObjectProperty' | 'DataProperty' | 'AnnotationProperty';
type SemanticAxiom = NormalizedAxiom extends infer Axiom
    ? Axiom extends NormalizedAxiom
        ? Omit<Axiom, 'id' | 'provenance'>
        : never
    : never;

export interface ReasonerSourceBinding {
    readonly sourceId: string;
    readonly sourceDigest: string;
    readonly sourceIndex: number;
    readonly locator: string;
    readonly owner: ProjectSourceOwner;
}

export interface ReasonerAxiomBinding {
    readonly axiomId: string;
    readonly sourceId: string;
    readonly sourceDigest: string;
}

export interface NormalizedReasonerInput {
    readonly request: ReasonerRequest;
    readonly wire: string;
    /** How the asserted statements split into reasoned, annotation and unreasoned groups. */
    readonly partition: ProfilePartition;
    readonly sourceBindings: ReadonlyArray<ReasonerSourceBinding>;
    readonly axiomBindings: ReadonlyArray<ReasonerAxiomBinding>;
    /** The quad keys of the root statements each axiom of the request was read from. */
    readonly axiomRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

export interface NormalizeReasonerOptions {
    readonly limits?: ReasonerRequestLimits;
    /**
     * Root statements (by quad key) to leave out as findings from the start, with why: those the reasoner refused
     * in report mode (`leftOutAfterRefusal`). Report-mode statements only.
     */
    readonly forced?: ReadonlyMap<string, ProfilePartitionReason>;
}

function sha256Bytes(value: string | Uint8Array): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function termIdentity(term: Term): string {
    switch (term.termType) {
        case 'NamedNode':
            return `N:${term.value}`;
        case 'BlankNode':
            return `B:${term.value}`;
        case 'Literal':
            return `L:${JSON.stringify([term.value, term.datatype.value, term.language])}`;
        case 'DefaultGraph':
            return 'D:';
        case 'Variable':
            return `V:${term.value}`;
    }
}

function termWireValue(term: Term): JsonValue {
    switch (term.termType) {
        case 'NamedNode':
            return { kind: 'NamedNode', value: term.value };
        case 'BlankNode':
            return { kind: 'BlankNode', value: term.value };
        case 'Literal': {
            const direction = 'direction' in term ? term.direction : undefined;
            if (direction !== undefined && direction !== '') {
                throw new ReasonerNormalizationError(
                    'UNREPRESENTABLE_RDF_TERM',
                    'RDF 1.2 directional literals are not representable in the V1 reasoner protocol',
                );
            }
            return {
                datatype: term.datatype.value,
                kind: 'Literal',
                language: term.language,
                lexicalForm: term.value,
            };
        }
        case 'DefaultGraph':
            return { kind: 'DefaultGraph' };
        case 'Variable':
            return { kind: 'Variable', value: term.value };
    }
}

function opaqueCanonicalForm(quad: Quad): string {
    return stringifyCanonicalJson({
        graph: termWireValue(quad.graph),
        object: termWireValue(quad.object),
        predicate: termWireValue(quad.predicate),
        subject: termWireValue(quad.subject),
    }).trimEnd();
}

function named(term: Term, context: string): string {
    if (term.termType !== 'NamedNode') {
        throw new ReasonerNormalizationError(
            'UNREPRESENTABLE_RDF_TERM',
            `${context} must be a named IRI: Erden does not reason over other terms here yet`,
            { context, termType: term.termType },
        );
    }
    return term.value;
}

function literal(term: Term, context: string) {
    if (term.termType !== 'Literal') {
        throw new ReasonerNormalizationError('UNREPRESENTABLE_RDF_TERM', `${context} must be an RDF literal`, {
            context,
            termType: term.termType,
        });
    }
    const direction = 'direction' in term ? term.direction : undefined;
    if (direction !== undefined && direction !== '') {
        throw new ReasonerNormalizationError(
            'UNREPRESENTABLE_RDF_TERM',
            `${context} uses an RDF 1.2 directional literal that the V1 protocol cannot represent`,
            { context },
        );
    }
    const language = term.language === '' ? null : term.language;
    const datatype = assertDatatypeIri(term.datatype.value, `${context} datatype`);
    if ((language === null && datatype === RDF_LANG_STRING) || (language !== null && datatype !== RDF_LANG_STRING)) {
        throw new ReasonerNormalizationError(
            'UNREPRESENTABLE_RDF_TERM',
            `${context} has an invalid RDF language/datatype pairing`,
            { context, datatype, language },
        );
    }
    return {
        kind: 'Literal' as const,
        lexicalForm: term.value,
        datatype,
        language,
    };
}

function sortedUnique(values: ReadonlyArray<string>): ReadonlyArray<string> {
    return [...new Set(values)].sort(compareCodePoints);
}

function freezeOwner(owner: ProjectSourceOwner): ProjectSourceOwner {
    return Object.freeze({
        canonicalIri: owner.canonicalIri,
        role: owner.role,
        ownedIriPrefixes: Object.freeze([...owner.ownedIriPrefixes].sort(compareCodePoints)),
    });
}

function entityKindForType(iri: string):
    | Extract<
          NormalizedAxiom,
          {
              kind: 'Declaration';
          }
      >['entityKind']
    | undefined {
    switch (iri) {
        case OWL_ONTOLOGY:
            return 'Ontology';
        case OWL_CLASS:
        case RDFS_CLASS:
            return 'Class';
        case OWL_OBJECT_PROPERTY:
            return 'ObjectProperty';
        case OWL_DATA_PROPERTY:
            return 'DataProperty';
        case OWL_ANNOTATION_PROPERTY:
            return 'AnnotationProperty';
        case OWL_NAMED_INDIVIDUAL:
            return 'NamedIndividual';
        case RDFS_DATATYPE:
            return 'Datatype';
        default:
            return undefined;
    }
}

function explicitPropertyKindForType(iri: string): PropertyKind | undefined {
    switch (iri) {
        case OWL_OBJECT_PROPERTY:
            return 'ObjectProperty';
        case OWL_DATA_PROPERTY:
            return 'DataProperty';
        case OWL_ANNOTATION_PROPERTY:
            return 'AnnotationProperty';
        default:
            return undefined;
    }
}

const unsupportedTypeConstructs = new Set([
    `${RDF}Property`,
    `${OWL}AllDifferent`,
    `${OWL}AllDisjointProperties`,
    `${OWL}AsymmetricProperty`,
    `${OWL}DeprecatedClass`,
    `${OWL}DeprecatedProperty`,
    `${OWL}IrreflexiveProperty`,
    `${OWL}ReflexiveProperty`,
    `${OWL}Restriction`,
]);

const unsupportedPredicates = new Set([
    `${OWL}differentFrom`,
    `${OWL}disjointUnionOf`,
    `${OWL}propertyDisjointWith`,
    `${OWL}sameAs`,
]);

const RDFS_SUB_PROPERTY = `${RDFS}subPropertyOf`;
const OWL_EQUIVALENT_PROPERTY = `${OWL}equivalentProperty`;
const OWL_PROPERTY_CHAIN = `${OWL}propertyChainAxiom`;
const OWL_ALL_DISJOINT_CLASSES = `${OWL}AllDisjointClasses`;
const OWL_MEMBERS = `${OWL}members`;
/** Property characteristics profile V2 reasons over. */
const CHARACTERISTICS = new Map<string, 'Functional' | 'InverseFunctional' | 'Symmetric'>([
    [`${OWL}FunctionalProperty`, 'Functional'],
    [`${OWL}InverseFunctionalProperty`, 'InverseFunctional'],
    [`${OWL}SymmetricProperty`, 'Symmetric'],
]);
/** The axioms a general class axiom's anonymous subject carries. */
const GENERAL_AXIOM_PREDICATES: ReadonlySet<string> = new Set([
    `${RDFS}subClassOf`,
    `${OWL}equivalentClass`,
    `${OWL}disjointWith`,
]);
/** Statements of anonymous expressions, lists and inverse properties: read with the axiom that owns them. */
const EXPRESSION_PLUMBING = new Set([
    `${RDF}first`,
    `${RDF}rest`,
    `${OWL}intersectionOf`,
    `${OWL}unionOf`,
    `${OWL}complementOf`,
    `${OWL}onProperty`,
    `${OWL}someValuesFrom`,
    `${OWL}allValuesFrom`,
    `${OWL}maxCardinality`,
    `${OWL}maxQualifiedCardinality`,
    `${OWL}onClass`,
    `${OWL}inverseOf`,
    `${OWL}members`,
]);

function sortedClasses(classes: ReadonlyArray<ClassExpression>): ReadonlyArray<ClassExpression> {
    return [...classes].sort((left, right) => compareCodePoints(classExpressionKey(left), classExpressionKey(right)));
}

const builtinAnnotationProperties = new Set([`${RDFS}comment`, `${RDFS}label`]);
const builtinClasses = new Set([OWL_THING, OWL_NOTHING]);
const builtinDatatypes = new Set(BUILTIN_DATATYPES);

/** Whether a reserved-namespace IRI is one of the V1 built-in datatypes. */
export function isBuiltinDatatype(datatype: string): boolean {
    return builtinDatatypes.has(datatype);
}

/**
 * The profile partition under one reasoner release's datatype boundaries (the bundled release unless named): the one
 * normalization applies. A range that release refuses only under an asserted value is left to the normalizer.
 */
export function partitionForBundledReasoner(
    graph: AssembledOntology,
    toolVersion: string = BUNDLED_REASONER_VERSION,
    forced?: ReadonlyMap<string, ProfilePartitionReason>,
): ProfilePartition {
    const boundaries = datatypeBoundaries(toolVersion);
    return partitionAssembledOntology(graph, {
        isDecidableDatatype: (datatype, usage, kind) => isDecidableUnder(boundaries, datatype, usage, kind),
        isBuiltinDatatype,
        isUnknownReservedIri,
        ...(forced === undefined || forced.size === 0 ? {} : { forced }),
    });
}

/** Whether the bundled reasoner decides this datatype in this usage; datatypes outside the built-in list do. */
export function isDecidableDatatypeUsage(
    datatype: string,
    usage: 'range' | 'literal',
    kind: 'DataProperty' | 'AnnotationProperty' = 'DataProperty',
): boolean {
    return isDecidableUnder(datatypeBoundaries(BUNDLED_REASONER_VERSION), datatype, usage, kind);
}

function plural(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Every finding of a project in refuse mode, at once, so an author fixes them in one pass. `locations` holds where
 * each finding's root statement is written, in the same order, null where it cannot be established.
 */
function refuseOutsideProfile(graph: AssembledOntology, findings: ReadonlyArray<ProfilePartitionFinding>): never {
    const statements = findings.reduce((total, finding) => total + finding.statementKeys.length, 0);
    const first = findings[0];
    throw new ReasonerNormalizationError(
        'OUTSIDE_PROFILE',
        `${plural(statements, 'statement')} in ${plural(findings.length, 'finding')} ${findings.length === 1 ? 'is' : 'are'} outside what Erden reasons over yet${first === undefined ? '' : `, starting with ${first.construct}${first.datatype === undefined ? '' : ` ${first.datatype}`} on ${first.subject ?? 'an anonymous node'}`}; set outsideProfile to report to reason over the rest and list these`,
        { findings, locations: locateProfileFindings(graph, findings) },
    );
}

function isReservedIri(iri: string): boolean {
    return [RDF, RDFS, OWL, XSD].some((namespace) => iri.startsWith(namespace));
}

function refuseReservedRole(iri: string, role: string): never {
    throw new ReasonerNormalizationError(
        'RESERVED_TERM_ROLE',
        `${iri} is a reserved vocabulary term and cannot be used as ${role}`,
        { iri, role },
    );
}

function assertClassIri(iri: string, role: string): string {
    if (isReservedIri(iri) && !builtinClasses.has(iri)) {
        refuseReservedRole(iri, role);
    }
    return iri;
}

function assertIndividualIri(iri: string, role: string): string {
    if (isReservedIri(iri)) {
        refuseReservedRole(iri, role);
    }
    return iri;
}

function assertDatatypeIri(iri: string, role: string): string {
    if (isReservedIri(iri) && !builtinDatatypes.has(iri)) {
        refuseReservedRole(iri, role);
    }
    return iri;
}

function assertAnnotationRangeIri(iri: string, role: string): string {
    if (isReservedIri(iri) && !builtinClasses.has(iri) && !builtinDatatypes.has(iri)) {
        refuseReservedRole(iri, role);
    }
    return iri;
}

function assertPropertyIri(iri: string, kind: PropertyKind, role: string): string {
    if (!isReservedIri(iri)) {
        return iri;
    }
    if (kind === 'ObjectProperty' && iri === OWL_BOTTOM_OBJECT_PROPERTY) {
        return iri;
    }
    if (kind === 'DataProperty' && iri === OWL_BOTTOM_DATA_PROPERTY) {
        return iri;
    }
    if (kind === 'AnnotationProperty' && builtinAnnotationProperties.has(iri)) {
        return iri;
    }
    return refuseReservedRole(iri, role);
}

function assertOntologyIri(iri: string, role: string): string {
    return assertIndividualIri(iri, role);
}

function canonicalSemantic(axiom: SemanticAxiom): JsonValue {
    return axiom;
}

export function normalizeAssembledOntology(
    graph: AssembledOntology,
    requiredTool: RequiredTool,
    options: NormalizeReasonerOptions = {},
): NormalizedReasonerInput {
    assertValidExplicitAssembledOntology(graph);
    return normalizeValidatedAssembledOntology(graph, requiredTool, options);
}

/** The statement the normalizer was reading when it threw, so its error can name a location. */
interface NormalizationAttempt {
    current: Quad | undefined;
}

/** Statement-level refusals: report mode lists their statements as findings rather than aborting the check. */
const LISTABLE_CODES: ReadonlySet<ReasonerNormalizationErrorCode> = new Set([
    'AMBIGUOUS_PROPERTY_KIND',
    'CYCLIC_RDF_LIST',
    'MALFORMED_RDF_LIST',
    'RESERVED_TERM_ROLE',
    'UNREPRESENTABLE_RDF_TERM',
    'UNSUPPORTED_CLASS_EXPRESSION',
    'UNSUPPORTED_DATATYPE',
]);

const EXPLICIT_PROPERTY_TYPES = new Set([OWL_OBJECT_PROPERTY, OWL_DATA_PROPERTY, OWL_ANNOTATION_PROPERTY]);

/** The statements a refusal is about: the one being read, or for a whole-ontology check the ones it names. */
function refusedStatements(
    graph: AssembledOntology,
    cause: ReasonerNormalizationError,
    current: Quad | undefined,
): ReadonlyArray<Quad> {
    if (current !== undefined) {
        return [current];
    }
    const property = cause.details['property'];
    if (cause.code === 'AMBIGUOUS_PROPERTY_KIND' && typeof property === 'string') {
        // Conflicting declarations: each typing statement of the property.
        return graph.dataset
            .getQuads(DataFactory.namedNode(property), DataFactory.namedNode(RDF_TYPE), null, null)
            .filter((quad) => EXPLICIT_PROPERTY_TYPES.has(quad.object.value));
    }
    const subject = cause.details['subject'];
    const datatype = cause.details['datatype'];
    if (
        cause.code === 'UNSUPPORTED_DATATYPE' &&
        cause.details['context'] === 'rdfs:range' &&
        typeof subject === 'string' &&
        typeof datatype === 'string'
    ) {
        // A range the reasoner cannot decide under an asserted value, found after every axiom was read.
        return graph.dataset.getQuads(
            DataFactory.namedNode(subject),
            DataFactory.namedNode(RDFS_RANGE),
            DataFactory.namedNode(datatype),
            null,
        );
    }
    return [];
}

/** The named root statements that own a statement: itself, or every named statement its blank subject hangs from. */
function rootStatements(graph: AssembledOntology, quad: Quad): ReadonlyArray<Quad> {
    if (quad.subject.termType === 'NamedNode') {
        return [quad];
    }
    const roots: Quad[] = [];
    const visited = new Set<string>();
    const pending: Term[] = [quad.subject];
    while (pending.length > 0) {
        const node = pending.pop() as Term;
        if (visited.has(node.value)) {
            continue;
        }
        visited.add(node.value);
        for (const incoming of graph.dataset.getQuads(null, null, node, null)) {
            if (incoming.subject.termType === 'NamedNode') {
                roots.push(incoming);
            } else if (incoming.subject.termType === 'BlankNode') {
                pending.push(incoming.subject);
            }
        }
    }
    return roots;
}

/** The refusal again, with the location of the statement it is about when that can be established. */
function locatedRefusal(
    graph: AssembledOntology,
    cause: ReasonerNormalizationError,
    statements: ReadonlyArray<Quad>,
): ReasonerNormalizationError {
    const first = statements[0];
    if (cause.location !== undefined || first === undefined) {
        return cause;
    }
    const [location] = locateStatements(graph, [{ key: quadKey(first) }]);
    return location === null || location === undefined
        ? cause
        : new ReasonerNormalizationError(cause.code, cause.message, cause.details, cause.cause, {
              file: location.locator,
              line: location.line,
              column: location.column,
          });
}

/**
 * Internal: `normalizeAssembledOntology` for a graph its caller has just validated with
 * `assertValidExplicitAssembledOntology` and held since, as one decision does; it does not validate again.
 *
 * Report mode never aborts on a statement-level refusal: when the statement the normalizer refused belongs only to
 * projects in report mode, its root statement and the blank-node structure it owns become a `malformed-rdf` finding,
 * left out like any other, and normalization runs again. Each pass adds at least one root, so it ends. In refuse
 * mode the refusal stands, now with the location of the statement it is about.
 */
export function normalizeValidatedAssembledOntology(
    graph: AssembledOntology,
    requiredTool: RequiredTool,
    options: NormalizeReasonerOptions = {},
): NormalizedReasonerInput {
    let forced = new Map<string, ProfilePartitionReason>(options.forced ?? []);
    const policies = new Map(graph.sources.map((source) => [source.descriptor.id, sourcePolicy(source)]));
    const provenance = new Map<string, ReadonlyArray<QuadContributor>>();
    for (;;) {
        const attempt: NormalizationAttempt = { current: undefined };
        try {
            return normalizeOnce(graph, requiredTool, options, forced, attempt);
        } catch (cause) {
            if (!(cause instanceof ReasonerNormalizationError) || !LISTABLE_CODES.has(cause.code)) {
                throw cause;
            }
            const statements = refusedStatements(graph, cause, attempt.current);
            const roots = statements.flatMap((quad) => rootStatements(graph, quad));
            if (provenance.size === 0) {
                for (const entry of graph.provenance) {
                    provenance.set(entry.key, entry.asserted);
                }
            }
            const keys = [...new Set(roots.map(quadKey))];
            const listable =
                keys.length > 0 &&
                keys.every((key) => {
                    const contributors = provenance.get(key) ?? [];
                    return (
                        contributors.length > 0 &&
                        contributors.every((item) => policies.get(item.sourceId) === 'report')
                    );
                }) &&
                keys.some((key) => !forced.has(key));
            if (!listable) {
                throw locatedRefusal(graph, cause, statements);
            }
            forced = new Map([
                ...forced,
                ...keys.map((key) => [key, Object.freeze({ code: cause.code, message: cause.message })] as const),
            ]);
        }
    }
}

function normalizeOnce(
    graph: AssembledOntology,
    requiredTool: RequiredTool,
    options: NormalizeReasonerOptions,
    forced: ReadonlyMap<string, ProfilePartitionReason>,
    attempt: NormalizationAttempt,
): NormalizedReasonerInput {
    const suppliedLimits = options.limits ?? DEFAULT_REASONER_LIMITS;
    if (
        ![suppliedLimits.maxInputAxioms, suppliedLimits.maxInferences, suppliedLimits.maxWallTimeMs].every(
            (value) => Number.isSafeInteger(value) && value > 0,
        )
    ) {
        throw new ReasonerNormalizationError(
            'INVALID_REASONER_INPUT',
            'Reasoner limits must be positive safe integers',
            { limits: suppliedLimits },
        );
    }
    const datatypeUsage = makeDatatypeUsageCheck(datatypeBoundaries(requiredTool.version));
    const limits = Object.freeze({
        maxInputAxioms: suppliedLimits.maxInputAxioms,
        maxInferences: suppliedLimits.maxInferences,
        maxWallTimeMs: suppliedLimits.maxWallTimeMs,
    });
    const sourcesById = new Map<string, LoadedTurtleSource>();
    for (const source of graph.sources) {
        const id = source.descriptor.id;
        if (!IDENTIFIER.test(id)) {
            throw new ReasonerNormalizationError(
                'INVALID_REASONER_INPUT',
                `Ontology source ID ${JSON.stringify(id)} is not a V1 protocol identifier`,
                { sourceId: id },
            );
        }
        if (sourcesById.has(id)) {
            throw new ReasonerNormalizationError('DUPLICATE_SOURCE_ID', `Ontology source ID ${id} is not unique`, {
                sourceId: id,
            });
        }
        if (source.descriptor.provenance._tag !== 'Asserted') {
            throw new ReasonerNormalizationError(
                'INFERRED_INPUT_SOURCE',
                `Ontology source ${id} is derived; V1 reasoner input must contain explicit sources only`,
                { sourceId: id },
            );
        }
        assertOntologyIri(source.descriptor.owner.canonicalIri, 'a source ontology identity');
        sourcesById.set(id, source);
    }
    if (sourcesById.size === 0) {
        throw new ReasonerNormalizationError(
            'INVALID_REASONER_INPUT',
            'Reasoner normalization requires at least one explicit ontology source',
        );
    }
    const sourceBindings = [...sourcesById.values()]
        .sort((left, right) => compareCodePoints(left.descriptor.id, right.descriptor.id))
        .map((source, sourceIndex): ReasonerSourceBinding =>
            Object.freeze({
                sourceId: source.descriptor.id,
                sourceDigest: source.contentDigest,
                sourceIndex,
                locator: source.descriptor.locator,
                owner: freezeOwner(source.descriptor.owner),
            }),
        );
    const sourceBindingById = new Map(sourceBindings.map((binding) => [binding.sourceId, binding]));
    const provenanceByQuad = new Map(graph.provenance.map((entry) => [entry.key, entry]));
    function assertedContributors(quad: Quad): ReadonlyArray<QuadContributor> {
        const entry = provenanceByQuad.get(quadKey(quad));
        const contributors = entry?.asserted ?? [];
        if (contributors.length === 0) {
            throw new ReasonerNormalizationError(
                'MISSING_ASSERTED_PROVENANCE',
                'A reasoner input quad has no asserted source provenance',
                { quad: opaqueCanonicalForm(quad) },
            );
        }
        return [...contributors].sort((left, right) => compareCodePoints(left.sourceId, right.sourceId));
    }
    const consumed = new Set<string>();
    function contributorSourceIds(quad: Quad): ReadonlyArray<string> {
        return sortedUnique(assertedContributors(quad).map((item) => item.sourceId));
    }
    function consume(quad: Quad, requiredSourceIds?: ReadonlyArray<string>): void {
        const actualSourceIds = contributorSourceIds(quad);
        if (requiredSourceIds !== undefined && JSON.stringify(actualSourceIds) !== JSON.stringify(requiredSourceIds)) {
            throw new ReasonerNormalizationError(
                'MALFORMED_RDF_LIST',
                'An anonymous class expression and all of its RDF list plumbing must belong to exactly the same source set as the referencing axiom',
                { actualSourceIds, requiredSourceIds },
            );
        }
        consumed.add(quadKey(quad));
    }
    const allQuads = graph.dataset
        .getQuads(null, null, null, null)
        .sort((left, right) => compareCodePoints(quadKey(left), quadKey(right)));
    for (const quad of allQuads) {
        if (quad.graph.termType !== 'DefaultGraph') {
            throw new ReasonerNormalizationError(
                'NAMED_GRAPH_UNSUPPORTED',
                'Erden reasons over the default graph only',
                { graph: termIdentity(quad.graph) },
            );
        }
    }
    const partition = partitionForBundledReasoner(graph, requiredTool.version, forced);
    const refused = partition.findings.filter((finding) => finding.policy === 'refuse');
    if (refused.length > 0) {
        refuseOutsideProfile(graph, refused);
    }
    // Report-mode findings and accepted annotations stay out of the request; with neither, every statement is
    // reasoned exactly as before.
    const reasonedQuads =
        partition.excludedKeys.size === 0 && partition.acceptedKeys.size === 0
            ? allQuads
            : allQuads.filter(
                  (quad) => !partition.excludedKeys.has(quadKey(quad)) && !partition.acceptedKeys.has(quadKey(quad)),
              );
    const typeIris = new Map<string, Set<string>>();
    for (const quad of reasonedQuads) {
        if (
            quad.predicate.value !== RDF_TYPE ||
            quad.subject.termType !== 'NamedNode' ||
            quad.object.termType !== 'NamedNode'
        ) {
            continue;
        }
        const existing = typeIris.get(quad.subject.value) ?? new Set<string>();
        existing.add(quad.object.value);
        typeIris.set(quad.subject.value, existing);
    }
    const explicitPropertyKinds = new Map<string, Set<PropertyKind>>();
    function addPropertyKind(property: string, kind: PropertyKind): void {
        const existing = explicitPropertyKinds.get(property) ?? new Set<PropertyKind>();
        existing.add(kind);
        explicitPropertyKinds.set(property, existing);
    }
    for (const [subject, types] of typeIris) {
        for (const type of types) {
            const kind = explicitPropertyKindForType(type);
            if (kind === undefined) {
                continue;
            }
            addPropertyKind(subject, kind);
        }
    }
    for (const property of builtinAnnotationProperties) {
        addPropertyKind(property, 'AnnotationProperty');
    }
    addPropertyKind(OWL_BOTTOM_OBJECT_PROPERTY, 'ObjectProperty');
    addPropertyKind(OWL_BOTTOM_DATA_PROPERTY, 'DataProperty');
    for (const [property, kinds] of explicitPropertyKinds) {
        if (kinds.size > 1) {
            throw new ReasonerNormalizationError(
                'AMBIGUOUS_PROPERTY_KIND',
                `${property} has conflicting property-kind declarations`,
                { property, candidates: [...kinds].sort(compareCodePoints) },
            );
        }
    }
    function propertyKind(iri: string, context: string): PropertyKind {
        const explicit = explicitPropertyKinds.get(iri);
        const kinds = new Set<PropertyKind>(explicit ?? []);
        if (kinds.size !== 1) {
            throw new ReasonerNormalizationError(
                'AMBIGUOUS_PROPERTY_KIND',
                `${context} cannot classify ${iri} as exactly one object, data, or annotation property`,
                { context, property: iri, candidates: [...kinds].sort(compareCodePoints) },
            );
        }
        const kind = [...kinds][0] as PropertyKind;
        assertPropertyIri(iri, kind, context);
        return kind;
    }
    function declarationIri(
        iri: string,
        entityKind: Extract<
            NormalizedAxiom,
            {
                kind: 'Declaration';
            }
        >['entityKind'],
    ): string {
        switch (entityKind) {
            case 'Class':
                return assertClassIri(iri, 'a class declaration');
            case 'ObjectProperty':
                return assertPropertyIri(iri, 'ObjectProperty', 'an object-property declaration');
            case 'DataProperty':
                return assertPropertyIri(iri, 'DataProperty', 'a data-property declaration');
            case 'AnnotationProperty':
                return assertPropertyIri(iri, 'AnnotationProperty', 'an annotation-property declaration');
            case 'Datatype':
                return assertDatatypeIri(iri, 'a datatype declaration');
            case 'NamedIndividual':
                return assertIndividualIri(iri, 'a named-individual declaration');
            case 'Ontology':
                return assertIndividualIri(iri, 'an ontology declaration');
        }
    }
    function parseNamedClassExpression(term: Term, context: string): ClassExpression {
        if (term.termType === 'NamedNode') {
            return { kind: 'NamedClass', iri: assertClassIri(term.value, context) };
        }
        throw new ReasonerNormalizationError(
            'UNSUPPORTED_CLASS_EXPRESSION',
            `${context} accepts only a named class: Erden does not reason over other class expressions here yet`,
            { context, termType: term.termType },
        );
    }
    const expressionContext: ExpressionContext = {
        graph: {
            outgoing: (term) => graph.dataset.getQuads(term, null, null, null),
            incoming: (term) => graph.dataset.getQuads(null, null, term, null),
        },
        propertyKind: (iri) => {
            const kinds = explicitPropertyKinds.get(iri);
            return kinds?.size === 1 ? [...kinds][0] : undefined;
        },
        isClassIri: (iri) => !isReservedIri(iri) || builtinClasses.has(iri),
    };
    /** The value of a reading, its statements consumed with the referencing axiom's sources. */
    function consumeReading<T>(reading: ExpressionReading<T>, context: string, referencingQuad: Quad): T {
        if (reading.kind === 'outside') {
            throw new ReasonerNormalizationError(
                'UNSUPPORTED_CLASS_EXPRESSION',
                `${context} uses ${reading.owlConstruct}, which is outside the Erden V2 reasoner profile`,
                { context, owlConstruct: reading.owlConstruct },
            );
        }
        if (reading.kind === 'malformed') {
            throw new ReasonerNormalizationError('MALFORMED_RDF_LIST', `${context}: ${reading.message}`, { context });
        }
        const requiredSourceIds = contributorSourceIds(referencingQuad);
        for (const plumbing of reading.plumbing) {
            consume(plumbing, requiredSourceIds);
        }
        return reading.value;
    }
    /** A class expression of profile V2: a named class, or an anonymous expression owned by `referencingQuad`. */
    function parseClassExpression(term: Term, context: string, referencingQuad: Quad): ClassExpression {
        if (term.termType === 'NamedNode') {
            return { kind: 'NamedClass', iri: assertClassIri(term.value, context) };
        }
        return consumeReading(readClassExpression(expressionContext, term, referencingQuad), context, referencingQuad);
    }
    function parsePropertyExpression(term: Term, context: string, referencingQuad: Quad): ObjectPropertyExpression {
        if (term.termType === 'NamedNode') {
            return assertPropertyIri(term.value, 'ObjectProperty', context);
        }
        return consumeReading(
            readObjectPropertyExpression(expressionContext, term, referencingQuad),
            context,
            referencingQuad,
        );
    }
    const usedExpressions = new Set<string>();
    const usedListNodes = new Set<string>();
    function parseDomainExpression(term: Term, context: string, referencingQuad: Quad): ClassExpression {
        if (term.termType === 'NamedNode') {
            return { kind: 'NamedClass', iri: assertClassIri(term.value, context) };
        }
        if (term.termType !== 'BlankNode') {
            throw new ReasonerNormalizationError(
                'UNSUPPORTED_CLASS_EXPRESSION',
                `${context} uses a class expression term the V1 protocol cannot represent`,
                { context, termType: term.termType },
            );
        }
        const cacheKey = termIdentity(term);
        if (usedExpressions.has(cacheKey) || usedListNodes.has(cacheKey)) {
            throw new ReasonerNormalizationError(
                'MALFORMED_RDF_LIST',
                `${context} reuses an anonymous class expression; V1 union lists must be owned by one axiom`,
                { context },
            );
        }
        usedExpressions.add(cacheKey);
        const requiredSourceIds = contributorSourceIds(referencingQuad);
        const unionQuads = graph.dataset.getQuads(term, DataFactory.namedNode(OWL_UNION_OF), null, null);
        if (unionQuads.length !== 1) {
            throw new ReasonerNormalizationError(
                'UNSUPPORTED_CLASS_EXPRESSION',
                `${context} requires exactly one owl:unionOf definition for an anonymous expression`,
                { context, unionDefinitions: unionQuads.length },
            );
        }
        const unionQuad = unionQuads[0];
        if (unionQuad === undefined) {
            throw new TypeError('Expected one union quad');
        }
        const expressionIncoming = graph.dataset.getQuads(null, null, term, null);
        const owningExpressionQuad = expressionIncoming[0];
        if (
            expressionIncoming.length !== 1 ||
            owningExpressionQuad === undefined ||
            quadKey(owningExpressionQuad) !== quadKey(referencingQuad)
        ) {
            throw new ReasonerNormalizationError(
                'MALFORMED_RDF_LIST',
                `${context} anonymous expression must be referenced by exactly one owning axiom`,
                { context, incomingCount: expressionIncoming.length },
            );
        }
        const classTypes = graph.dataset.getQuads(
            term,
            DataFactory.namedNode(RDF_TYPE),
            DataFactory.namedNode(OWL_CLASS),
            null,
        );
        const expressionOutgoing = graph.dataset.getQuads(term, null, null, null);
        if (classTypes.length > 1 || expressionOutgoing.length !== 1 + classTypes.length) {
            throw new ReasonerNormalizationError(
                'MALFORMED_RDF_LIST',
                `${context} anonymous expression has extraneous outgoing RDF structure`,
                { context, outgoingCount: expressionOutgoing.length },
            );
        }
        if (unionQuad.object.termType !== 'BlankNode') {
            throw new ReasonerNormalizationError(
                'MALFORMED_RDF_LIST',
                `${context} owl:unionOf must point to an owned blank-node list head`,
                { context, termType: unionQuad.object.termType },
            );
        }
        consume(unionQuad, requiredSourceIds);
        for (const classType of classTypes) {
            consume(classType, requiredSourceIds);
        }
        const operands: string[] = [];
        const visited = new Set<string>();
        const listOwnership: Array<readonly [Term, Quad]> = [];
        let cursor: Term = unionQuad.object;
        let expectedIncoming = unionQuad;
        while (!(cursor.termType === 'NamedNode' && cursor.value === RDF_NIL)) {
            if (cursor.termType !== 'BlankNode') {
                throw new ReasonerNormalizationError(
                    'MALFORMED_RDF_LIST',
                    `${context} requires every non-rdf:nil list cell to be a blank node`,
                    { context, termType: cursor.termType },
                );
            }
            const cursorKey = termIdentity(cursor);
            if (visited.has(cursorKey)) {
                throw new ReasonerNormalizationError('CYCLIC_RDF_LIST', `${context} contains a cyclic RDF list`, {
                    context,
                });
            }
            visited.add(cursorKey);
            if (usedListNodes.has(cursorKey) || usedExpressions.has(cursorKey)) {
                throw new ReasonerNormalizationError(
                    'MALFORMED_RDF_LIST',
                    `${context} shares an RDF list node with another expression`,
                    { context },
                );
            }
            usedListNodes.add(cursorKey);
            listOwnership.push([cursor, expectedIncoming]);
            const first = graph.dataset.getQuads(cursor, DataFactory.namedNode(RDF_FIRST), null, null);
            const rest = graph.dataset.getQuads(cursor, DataFactory.namedNode(RDF_REST), null, null);
            if (first.length !== 1 || rest.length !== 1) {
                throw new ReasonerNormalizationError(
                    'MALFORMED_RDF_LIST',
                    `${context} requires every RDF list node to have exactly one rdf:first and rdf:rest`,
                    { context, firstCount: first.length, restCount: rest.length },
                );
            }
            const firstQuad = first[0];
            const restQuad = rest[0];
            if (firstQuad === undefined || restQuad === undefined) {
                throw new TypeError('Expected RDF list quads');
            }
            const listTypes = graph.dataset.getQuads(
                cursor,
                DataFactory.namedNode(RDF_TYPE),
                DataFactory.namedNode(RDF_LIST),
                null,
            );
            const outgoing = graph.dataset.getQuads(cursor, null, null, null);
            if (listTypes.length > 1 || outgoing.length !== 2 + listTypes.length) {
                throw new ReasonerNormalizationError(
                    'MALFORMED_RDF_LIST',
                    `${context} RDF list cell has extraneous outgoing RDF structure`,
                    { context, outgoingCount: outgoing.length },
                );
            }
            consume(firstQuad, requiredSourceIds);
            consume(restQuad, requiredSourceIds);
            for (const listType of listTypes) {
                consume(listType, requiredSourceIds);
            }
            if (firstQuad.object.termType === 'BlankNode' && termIdentity(firstQuad.object) === cacheKey) {
                throw new ReasonerNormalizationError(
                    'CYCLIC_RDF_LIST',
                    `${context} contains a self-referential class expression`,
                    { context },
                );
            }
            if (firstQuad.object.termType !== 'NamedNode') {
                throw new ReasonerNormalizationError(
                    'UNSUPPORTED_CLASS_EXPRESSION',
                    `${context} union operands must be named class IRIs`,
                    { context, termType: firstQuad.object.termType },
                );
            }
            operands.push(assertClassIri(firstQuad.object.value, `${context} union operand`));
            expectedIncoming = restQuad;
            cursor = restQuad.object;
        }
        for (const [cell, ownerEdge] of listOwnership) {
            const incoming = graph.dataset.getQuads(null, null, cell, null);
            const soleIncoming = incoming[0];
            if (incoming.length !== 1 || soleIncoming === undefined || quadKey(soleIncoming) !== quadKey(ownerEdge)) {
                throw new ReasonerNormalizationError(
                    'MALFORMED_RDF_LIST',
                    `${context} RDF list cells must have exactly one owning incoming edge`,
                    { context, incomingCount: incoming.length },
                );
            }
        }
        const unique = sortedUnique(operands);
        if (unique.length !== operands.length || unique.length < 2) {
            throw new ReasonerNormalizationError(
                'MALFORMED_RDF_LIST',
                `${context} owl:unionOf must contain at least two unique named class IRIs`,
                { context, operandCount: operands.length, uniqueOperandCount: unique.length },
            );
        }
        const expression: ClassExpression = { kind: 'ObjectUnionOf', operands: unique };
        return expression;
    }
    const axioms = new Map<string, NormalizedAxiom>();
    const axiomBindings = new Map<string, ReasonerAxiomBinding>();
    const axiomRoots = new Map<string, string[]>();
    function emit(quad: Quad, semantic: SemanticAxiom): void {
        consume(quad);
        for (const contributor of assertedContributors(quad)) {
            const source = sourceBindingById.get(contributor.sourceId);
            if (source === undefined) {
                throw new ReasonerNormalizationError(
                    'MISSING_ASSERTED_PROVENANCE',
                    `Quad provenance refers to unknown source ${contributor.sourceId}`,
                    { sourceId: contributor.sourceId },
                );
            }
            const digest = sha256Bytes(
                stringifyCanonicalJson({
                    semantic: canonicalSemantic(semantic),
                    sourceDigest: source.sourceDigest,
                    sourceId: source.sourceId,
                }),
            );
            const id = `axiom:${digest.slice('sha256:'.length)}`;
            const roots = axiomRoots.get(id) ?? [];
            if (!roots.includes(quadKey(quad))) {
                roots.push(quadKey(quad));
                axiomRoots.set(id, roots);
            }
            if (axioms.has(id)) {
                continue;
            }
            const provenance = {
                status: 'available' as const,
                sourceId: source.sourceId,
                sourceDigest: source.sourceDigest,
                locator: `erden-source:${source.sourceId}#${id}`,
            };
            axioms.set(id, { ...semantic, id, provenance });
            axiomBindings.set(
                id,
                Object.freeze({
                    axiomId: id,
                    sourceId: source.sourceId,
                    sourceDigest: source.sourceDigest,
                }),
            );
        }
    }
    for (const quad of reasonedQuads) {
        if (consumed.has(quadKey(quad))) {
            continue;
        }
        attempt.current = quad;
        const predicate = quad.predicate.value;
        if (predicate === OWL_UNION_OF || predicate === RDF_FIRST || predicate === RDF_REST) {
            continue;
        }
        if (quad.subject.termType === 'BlankNode') {
            const owned = graph.dataset.countQuads(null, null, quad.subject, null) > 0;
            if (!owned && GENERAL_AXIOM_PREDICATES.has(predicate)) {
                // A general class axiom: its anonymous subject is read with the axiom predicates it carries.
                const subject = consumeReading(
                    readClassExpression(expressionContext, quad.subject, undefined, GENERAL_AXIOM_PREDICATES),
                    `${predicate} subject`,
                    quad,
                );
                const object = parseClassExpression(quad.object, `${predicate} object`, quad);
                emit(
                    quad,
                    predicate === RDFS_SUBCLASS
                        ? { kind: 'SubClassOf', graph: DEFAULT_GRAPH, subClass: subject, superClass: object }
                        : {
                              kind: predicate === OWL_EQUIVALENT_CLASS ? 'EquivalentClasses' : 'DisjointClasses',
                              graph: DEFAULT_GRAPH,
                              classes: sortedClasses([subject, object]),
                          },
                );
                continue;
            }
            if (
                !owned &&
                predicate === RDF_TYPE &&
                quad.object.termType === 'NamedNode' &&
                quad.object.value === OWL_ALL_DISJOINT_CLASSES
            ) {
                const members = graph.dataset.getQuads(quad.subject, DataFactory.namedNode(OWL_MEMBERS), null, null);
                const membersQuad = members[0];
                if (members.length !== 1 || membersQuad === undefined) {
                    throw new ReasonerNormalizationError(
                        'MALFORMED_RDF_LIST',
                        'owl:AllDisjointClasses needs exactly one owl:members list',
                        { count: members.length },
                    );
                }
                consume(membersQuad, contributorSourceIds(quad));
                const cells = consumeReading(
                    readListCells(expressionContext, membersQuad.object, membersQuad),
                    'owl:AllDisjointClasses members',
                    quad,
                );
                const classes = sortedClasses(
                    cells.map(({ item, owner }) => parseClassExpression(item, 'owl:AllDisjointClasses member', owner)),
                );
                if (classes.length < 2) {
                    throw new ReasonerNormalizationError(
                        'MALFORMED_RDF_LIST',
                        'owl:AllDisjointClasses needs two members',
                        { count: classes.length },
                    );
                }
                emit(quad, {
                    kind: 'DisjointClasses',
                    graph: DEFAULT_GRAPH,
                    classes,
                });
                continue;
            }
            const axiomRoot =
                !owned &&
                (graph.dataset
                    .getQuads(quad.subject, null, null, null)
                    .some((outgoing) => GENERAL_AXIOM_PREDICATES.has(outgoing.predicate.value)) ||
                    graph.dataset.countQuads(
                        quad.subject,
                        DataFactory.namedNode(RDF_TYPE),
                        DataFactory.namedNode(OWL_ALL_DISJOINT_CLASSES),
                        null,
                    ) > 0);
            if ((owned || axiomRoot) && (EXPRESSION_PLUMBING.has(predicate) || predicate === RDF_TYPE)) {
                // Read with the axiom that owns the expression; the last check finds any left over.
                continue;
            }
        }
        if (
            predicate === RDF_TYPE &&
            quad.subject.termType === 'BlankNode' &&
            quad.object.termType === 'NamedNode' &&
            quad.object.value === OWL_CLASS &&
            graph.dataset.countQuads(quad.subject, DataFactory.namedNode(OWL_UNION_OF), null, null) > 0
        ) {
            continue;
        }
        if (predicate === RDF_TYPE && quad.object.termType === 'NamedNode') {
            const entityKind = entityKindForType(quad.object.value);
            if (entityKind !== undefined) {
                emit(quad, {
                    kind: 'Declaration',
                    graph: DEFAULT_GRAPH,
                    entityKind,
                    iri: declarationIri(named(quad.subject, 'declaration subject'), entityKind),
                });
                continue;
            }
            const characteristic = CHARACTERISTICS.get(quad.object.value);
            if (characteristic !== undefined) {
                const property = named(quad.subject, 'property characteristic subject');
                const kind = propertyKind(property, `${characteristic} property declaration`);
                if (kind === 'DataProperty' && characteristic === 'Functional') {
                    emit(quad, { kind: 'FunctionalDataProperty', graph: DEFAULT_GRAPH, property });
                    continue;
                }
                if (kind !== 'ObjectProperty') {
                    throw new ReasonerNormalizationError(
                        'AMBIGUOUS_PROPERTY_KIND',
                        `${property} is ${characteristic} but is not classified as an object property`,
                        { property },
                    );
                }
                emit(quad, { kind: `${characteristic}ObjectProperty`, graph: DEFAULT_GRAPH, property });
                continue;
            }
            if (quad.object.value === OWL_TRANSITIVE_PROPERTY) {
                const property = named(quad.subject, 'transitive property subject');
                if (propertyKind(property, 'transitive property declaration') !== 'ObjectProperty') {
                    throw new ReasonerNormalizationError(
                        'AMBIGUOUS_PROPERTY_KIND',
                        `${property} is transitive but is not classified as an object property`,
                        { property },
                    );
                }
                emit(quad, { kind: 'TransitiveObjectProperty', graph: DEFAULT_GRAPH, property });
                continue;
            }
            if (unsupportedTypeConstructs.has(quad.object.value)) {
                emit(quad, {
                    kind: 'OpaqueAxiom',
                    graph: DEFAULT_GRAPH,
                    constructIri: quad.object.value,
                    canonicalForm: opaqueCanonicalForm(quad),
                });
                continue;
            }
            emit(quad, {
                kind: 'ClassAssertion',
                graph: DEFAULT_GRAPH,
                classExpression: parseClassExpression(quad.object, 'class assertion', quad),
                individual: assertIndividualIri(
                    named(quad.subject, 'class assertion subject'),
                    'a class-assertion individual',
                ),
            });
            continue;
        }
        if (predicate === RDF_TYPE && quad.object.termType === 'BlankNode') {
            emit(quad, {
                kind: 'ClassAssertion',
                graph: DEFAULT_GRAPH,
                classExpression: parseClassExpression(quad.object, 'class assertion', quad),
                individual: assertIndividualIri(
                    named(quad.subject, 'class assertion subject'),
                    'a class-assertion individual',
                ),
            });
            continue;
        }
        if (predicate === RDFS_SUBCLASS) {
            emit(quad, {
                kind: 'SubClassOf',
                graph: DEFAULT_GRAPH,
                subClass: parseNamedClassExpression(quad.subject, 'rdfs:subClassOf subject'),
                superClass: parseClassExpression(quad.object, 'rdfs:subClassOf object', quad),
            });
            continue;
        }
        if (predicate === OWL_EQUIVALENT_CLASS || predicate === OWL_DISJOINT_WITH) {
            const classes = sortedClasses([
                parseNamedClassExpression(quad.subject, `${predicate} subject`),
                parseClassExpression(quad.object, `${predicate} object`, quad),
            ]) as [ClassExpression, ClassExpression];
            emit(
                quad,
                predicate === OWL_EQUIVALENT_CLASS
                    ? { kind: 'EquivalentClasses', graph: DEFAULT_GRAPH, classes }
                    : { kind: 'DisjointClasses', graph: DEFAULT_GRAPH, classes },
            );
            continue;
        }
        if (predicate === RDFS_DOMAIN) {
            const property = named(quad.subject, 'rdfs:domain subject');
            emit(quad, {
                kind: 'PropertyDomain',
                graph: DEFAULT_GRAPH,
                property,
                propertyKind: propertyKind(property, 'rdfs:domain'),
                domain:
                    quad.object.termType === 'BlankNode' &&
                    graph.dataset.countQuads(quad.object, DataFactory.namedNode(OWL_UNION_OF), null, null) === 0
                        ? parseClassExpression(quad.object, 'rdfs:domain object', quad)
                        : parseDomainExpression(quad.object, 'rdfs:domain object', quad),
            });
            continue;
        }
        if (predicate === RDFS_RANGE) {
            const property = named(quad.subject, 'rdfs:range subject');
            const kind = propertyKind(property, 'rdfs:range');
            if (kind === 'ObjectProperty' && quad.object.termType === 'BlankNode') {
                emit(quad, {
                    kind: 'PropertyRange',
                    graph: DEFAULT_GRAPH,
                    property,
                    propertyKind: kind,
                    range: parseClassExpression(quad.object, 'rdfs:range object', quad),
                });
                continue;
            }
            const range = named(quad.object, 'rdfs:range object');
            if (kind !== 'ObjectProperty') {
                datatypeUsage.range(property, kind, range);
            }
            emit(quad, {
                kind: 'PropertyRange',
                graph: DEFAULT_GRAPH,
                property,
                propertyKind: kind,
                range:
                    kind === 'ObjectProperty'
                        ? assertClassIri(range, 'an object-property range')
                        : kind === 'AnnotationProperty'
                          ? assertAnnotationRangeIri(range, 'an annotation-property range')
                          : assertDatatypeIri(range, 'a data-property range'),
            });
            continue;
        }
        if (predicate === OWL_INVERSE_OF) {
            const left = named(quad.subject, 'owl:inverseOf subject');
            const right = named(quad.object, 'owl:inverseOf object');
            if (
                propertyKind(left, 'owl:inverseOf subject') !== 'ObjectProperty' ||
                propertyKind(right, 'owl:inverseOf object') !== 'ObjectProperty'
            ) {
                throw new ReasonerNormalizationError(
                    'AMBIGUOUS_PROPERTY_KIND',
                    'owl:inverseOf requires two declared object properties',
                    { left, right },
                );
            }
            const [first, second] = [left, right].sort(compareCodePoints) as [string, string];
            emit(quad, { kind: 'InverseObjectProperties', graph: DEFAULT_GRAPH, left: first, right: second });
            continue;
        }
        if (predicate === RDFS_SUB_PROPERTY || predicate === OWL_EQUIVALENT_PROPERTY) {
            const subject = named(quad.subject, `${predicate} subject`);
            const kind = propertyKind(subject, predicate);
            if (kind === 'DataProperty') {
                const object = named(quad.object, `${predicate} object`);
                if (propertyKind(object, predicate) !== 'DataProperty') {
                    throw new ReasonerNormalizationError(
                        'AMBIGUOUS_PROPERTY_KIND',
                        `${predicate} relates a data property to a property of another kind`,
                        { subject, object },
                    );
                }
                emit(
                    quad,
                    predicate === RDFS_SUB_PROPERTY
                        ? {
                              kind: 'SubDataPropertyOf',
                              graph: DEFAULT_GRAPH,
                              subProperty: subject,
                              superProperty: object,
                          }
                        : {
                              kind: 'EquivalentDataProperties',
                              graph: DEFAULT_GRAPH,
                              properties: [subject, object].sort(compareCodePoints),
                          },
                );
                continue;
            }
            if (kind !== 'ObjectProperty') {
                throw new ReasonerNormalizationError(
                    'AMBIGUOUS_PROPERTY_KIND',
                    `${predicate} is reasoned between two object or two data properties only`,
                    { subject, kind },
                );
            }
            const object = parsePropertyExpression(quad.object, `${predicate} object`, quad);
            emit(
                quad,
                predicate === RDFS_SUB_PROPERTY
                    ? { kind: 'SubObjectPropertyOf', graph: DEFAULT_GRAPH, subProperty: subject, superProperty: object }
                    : {
                          kind: 'EquivalentObjectProperties',
                          graph: DEFAULT_GRAPH,
                          properties: [subject, object].sort((left, right) =>
                              compareCodePoints(JSON.stringify(left), JSON.stringify(right)),
                          ),
                      },
            );
            continue;
        }
        if (predicate === OWL_PROPERTY_CHAIN) {
            const superProperty = named(quad.subject, 'owl:propertyChainAxiom subject');
            if (propertyKind(superProperty, 'owl:propertyChainAxiom') !== 'ObjectProperty') {
                throw new ReasonerNormalizationError(
                    'AMBIGUOUS_PROPERTY_KIND',
                    'owl:propertyChainAxiom needs an object property',
                    { superProperty },
                );
            }
            const cells = consumeReading(
                readListCells(expressionContext, quad.object, quad),
                'owl:propertyChainAxiom list',
                quad,
            );
            const properties = cells.map(({ item, owner }) =>
                parsePropertyExpression(item, 'owl:propertyChainAxiom member', owner),
            );
            if (properties.length < 2) {
                throw new ReasonerNormalizationError(
                    'MALFORMED_RDF_LIST',
                    'owl:propertyChainAxiom needs two properties',
                    { count: properties.length },
                );
            }
            emit(quad, {
                kind: 'SubObjectPropertyOf',
                graph: DEFAULT_GRAPH,
                subProperty: {
                    kind: 'ObjectPropertyChain',
                    properties,
                },
                superProperty,
            });
            continue;
        }
        if (predicate === OWL_IMPORTS) {
            emit(quad, {
                kind: 'Import',
                graph: DEFAULT_GRAPH,
                ontology: named(quad.object, 'owl:imports object'),
            });
            continue;
        }
        if (unsupportedPredicates.has(predicate)) {
            if (
                quad.subject.termType !== 'NamedNode' ||
                (quad.object.termType !== 'NamedNode' && quad.object.termType !== 'Literal')
            ) {
                throw new ReasonerNormalizationError(
                    'UNREPRESENTABLE_RDF_TERM',
                    'Unsupported RDF axioms containing anonymous nodes cannot be represented opaquely',
                    { predicate, subjectType: quad.subject.termType, objectType: quad.object.termType },
                );
            }
            emit(quad, {
                kind: 'OpaqueAxiom',
                graph: DEFAULT_GRAPH,
                constructIri: predicate,
                canonicalForm: opaqueCanonicalForm(quad),
            });
            continue;
        }
        if (quad.subject.termType !== 'NamedNode') {
            throw new ReasonerNormalizationError(
                'UNREPRESENTABLE_RDF_TERM',
                'Erden does not reason over assertions about anonymous subjects yet',
                { predicate, termType: quad.subject.termType },
            );
        }
        const kind = propertyKind(predicate, 'property assertion');
        if (kind === 'ObjectProperty' && quad.object.termType === 'Literal') {
            // Often two layers disagree: one declares the property an object property, another gives it text.
            throw new ReasonerNormalizationError(
                'UNREPRESENTABLE_RDF_TERM',
                `object property assertion object must be a named IRI: ${predicate} is declared an owl:ObjectProperty in the checked ontologies, so this literal value cannot be read as an assertion; give an IRI value, declare the property a data or annotation property where it is defined, or set outsideProfile to report in the project that makes this statement to list it and reason over the rest`,
                { context: 'object property assertion object', property: predicate, termType: 'Literal' },
            );
        }
        if (kind === 'ObjectProperty') {
            emit(quad, {
                kind: 'ObjectPropertyAssertion',
                graph: DEFAULT_GRAPH,
                property: predicate,
                subject: assertIndividualIri(quad.subject.value, 'an object-property assertion subject'),
                object: assertIndividualIri(
                    named(quad.object, 'object property assertion object'),
                    'an object-property assertion object',
                ),
            });
        } else if (kind === 'DataProperty') {
            const subject = assertIndividualIri(quad.subject.value, 'a data-property assertion subject');
            const value = literal(quad.object, 'data property assertion object');
            datatypeUsage.dataLiteral(predicate, subject, value.datatype);
            emit(quad, {
                kind: 'DataPropertyAssertion',
                graph: DEFAULT_GRAPH,
                property: predicate,
                subject,
                value,
            });
        } else {
            const value =
                quad.object.termType === 'NamedNode'
                    ? quad.object.value
                    : literal(quad.object, 'annotation assertion object');
            if (typeof value !== 'string') {
                datatypeUsage.annotationLiteral(quad.subject.value, value.datatype);
            }
            emit(quad, {
                kind: 'AnnotationAssertion',
                graph: DEFAULT_GRAPH,
                property: predicate,
                subject: quad.subject.value,
                value,
            });
        }
    }
    attempt.current = undefined;
    datatypeUsage.finish();
    for (const quad of reasonedQuads) {
        if (!consumed.has(quadKey(quad))) {
            attempt.current = quad;
            throw new ReasonerNormalizationError(
                'UNREPRESENTABLE_RDF_TERM',
                'RDF list or class-expression plumbing was not consumed by a supported semantic axiom',
                { quad: opaqueCanonicalForm(quad) },
            );
        }
    }
    attempt.current = undefined;
    const ontologySourcesList = sourceBindings.map((binding) => ({
        id: binding.sourceId,
        kind: binding.owner.role,
        ontologyIri: binding.owner.canonicalIri,
        contentDigest: binding.sourceDigest,
    }));
    const firstOntologySource = ontologySourcesList[0];
    if (firstOntologySource === undefined) {
        throw new TypeError('Expected at least one ontology source');
    }
    const ontologySources: ReasonerRequest['ontology']['sources'] = [
        firstOntologySource,
        ...ontologySourcesList.slice(1),
    ];
    const normalizedAxioms = [...axioms.values()].sort((left, right) => compareCodePoints(left.id, right.id));
    const draft: ReasonerRequest = {
        protocolVersion: REASONER_PROTOCOL_VERSION,
        kind: 'ReasonerRequest',
        requestId: 'request:pending',
        operation: REASONER_OPERATION,
        profile: { id: REASONER_PROFILE_ID, digest: REASONER_PROFILE_SHA256 },
        requiredTool,
        limits,
        ontology: {
            digest: `sha256:${'0'.repeat(64)}`,
            sources: ontologySources,
            axioms: normalizedAxioms,
        },
    };
    const requestIdLimit = new TypeError('Derived request ID exceeds protocol limit');
    let request: ReasonerRequest;
    let wire: string;
    try {
        // One canonical write of the axioms and sources: hashed for the input digest and spliced into the wire.
        ({ request, wire } = sealReasonerRequest(draft, (digest) => {
            const requestId = `request:${digest.slice('sha256:'.length)}`;
            if (Buffer.byteLength(requestId, 'utf8') > MAX_REASONER_REQUEST_ID_BYTES) {
                throw requestIdLimit;
            }
            return requestId;
        }));
    } catch (cause) {
        if (cause instanceof ReasonerRequestSealError && cause.cause === requestIdLimit) {
            throw requestIdLimit;
        }
        throw new ReasonerNormalizationError(
            'INVALID_REASONER_INPUT',
            cause instanceof ReasonerRequestSealError && cause.stage === 'schema'
                ? 'Normalized ontology does not satisfy the strict V1 reasoner request schema'
                : 'Could not compute the canonical reasoner input digest',
            {},
            cause instanceof ReasonerRequestSealError ? cause.cause : cause,
        );
    }
    return Object.freeze({
        request,
        wire,
        partition,
        sourceBindings: Object.freeze(sourceBindings),
        axiomBindings: Object.freeze(
            [...axiomBindings.values()].sort((left, right) => compareCodePoints(left.axiomId, right.axiomId)),
        ),
        axiomRoots: new Map(
            [...axiomRoots.entries()].map(([id, roots]) => [id, Object.freeze([...roots].sort(compareCodePoints))]),
        ),
    });
}

/** Reasoner refusals that report mode turns into findings, leaving the axiom out, instead of refusing the project. */
const LEAVE_OUT_REFUSALS: ReadonlySet<string> = new Set([UNION_DOMAIN_NOT_LOCAL]);

/**
 * The statements to leave out after the reasoner refused a request: when every diagnostic is one report mode lists
 * (a union domain whose case split cannot stay local) and every root statement of the axioms it names belongs only
 * to projects in report mode, the forced findings to normalize again with (those already forced, plus these roots);
 * otherwise null, and the refusal stands. Each call adds at least one root, so a caller's loop ends.
 */
export function leftOutAfterRefusal(
    graph: AssembledOntology,
    normalization: NormalizedReasonerInput,
    diagnostics: ReadonlyArray<{
        readonly code: string;
        readonly message: string;
        readonly axiomIds: ReadonlyArray<string>;
    }>,
    forced: ReadonlyMap<string, ProfilePartitionReason>,
): ReadonlyMap<string, ProfilePartitionReason> | null {
    if (diagnostics.length === 0 || !diagnostics.every((item) => LEAVE_OUT_REFUSALS.has(item.code))) {
        return null;
    }
    const policies = new Map(graph.sources.map((source) => [source.descriptor.id, sourcePolicy(source)]));
    const contributors = new Map(graph.provenance.map((entry) => [entry.key, entry.asserted]));
    const added = new Map<string, ProfilePartitionReason>();
    for (const diagnostic of diagnostics) {
        const keys = diagnostic.axiomIds.flatMap((id) => normalization.axiomRoots.get(id) ?? []);
        if (keys.length === 0) {
            return null;
        }
        for (const key of keys) {
            const sources = contributors.get(key) ?? [];
            if (sources.length === 0 || !sources.every((item) => policies.get(item.sourceId) === 'report')) {
                return null;
            }
            if (!forced.has(key)) {
                added.set(key, Object.freeze({ code: diagnostic.code, message: diagnostic.message }));
            }
        }
    }
    return added.size === 0 ? null : new Map([...forced, ...added]);
}
