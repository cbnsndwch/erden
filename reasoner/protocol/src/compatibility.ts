import { stringifyCanonicalJson } from './canonical.js';
import type { JsonValue } from './canonical.js';
import {
    aggregateJustificationDigest,
    computeCertificateDigest,
    computeDecidedOutputDigest,
    computeInferredJustificationDigest,
    computeLemmaJustificationDigest,
    computeReasonerInputDigest,
    computeUnsatisfiableJustificationDigest,
} from './evidence.js';
import { axiomClassExpressions, axiomIris, hasAdmittedExpressions, someClassExpression } from './expressions.js';
import { sha256OrderedJson } from './native.js';
import {
    ERDEN_PROOF_CHECKER_ID,
    ERDEN_PROOF_CHECKER_SHA256,
    REASONER_PROFILE_ID,
    REASONER_PROFILE_SHA256,
    REASONER_PROTOCOL_VERSION,
} from './profile.js';
import { getProofValidationIssues } from './proof-walk.js';
import type {
    CheckedCertificate,
    InferredStatement,
    Lemma,
    NormalizedAxiom,
    ReasonerRequest,
    ReasonerResponse,
    RequiredTool,
} from './schema.js';
import { isOpenedResponse, openedOutputDigest, sealedInputDigest } from './sealed.js';

export type ReasonerExchangeIssue =
    | 'adapter-digest'
    | 'asserted-provenance'
    | 'asserted-statement'
    | 'axiom-source'
    | 'calculus-digest'
    | 'certificate-digest'
    | 'certificate-input-digest'
    | 'certificate-justification-digest'
    | 'certificate-output-digest'
    | 'diagnostic-reference'
    | 'derivation-cycle'
    | 'duplicate-identifier'
    | 'duplicate-inferred-id'
    | 'duplicate-union-operand'
    | 'executable-digest'
    | 'input-digest'
    | 'inferred-justification-digest'
    | 'invalid-inconsistency-evidence'
    | 'invalid-unsatisfiable-evidence'
    | 'known-divergence'
    | 'lemma-justification-digest'
    | 'missing-premise'
    | 'missing-proof-premise'
    | 'missing-provenance'
    | 'named-graph'
    | 'profile-digest'
    | 'profile-id'
    | 'proof-checker-digest'
    | 'proof-checker-id'
    | 'protocol-version'
    | 'request-id'
    | 'tool-name'
    | 'tool-version'
    | 'unknown-reserved-term'
    | 'unknown-proof-rule'
    | 'unsatisfiable-justification-digest'
    | 'unsupported-construct'
    | 'unsupported-expression-context'
    | 'not-entailed';

export interface ReasonerTrustExpectation {
    readonly protocolVersion: number;
    readonly profileId: string;
    readonly profileDigest: string;
    readonly proofCheckerId: string;
    readonly proofCheckerDigest: string;
    readonly tool: RequiredTool;
}

export type ReasonerEnvelopeIssue = Extract<
    ReasonerExchangeIssue,
    | 'adapter-digest'
    | 'calculus-digest'
    | 'duplicate-identifier'
    | 'duplicate-union-operand'
    | 'executable-digest'
    | 'input-digest'
    | 'profile-digest'
    | 'profile-id'
    | 'proof-checker-digest'
    | 'proof-checker-id'
    | 'protocol-version'
    | 'request-id'
    | 'tool-name'
    | 'tool-version'
>;

export function makeReasonerTrustExpectation(tool: RequiredTool): ReasonerTrustExpectation {
    return Object.freeze({
        protocolVersion: REASONER_PROTOCOL_VERSION,
        profileId: REASONER_PROFILE_ID,
        profileDigest: REASONER_PROFILE_SHA256,
        proofCheckerId: ERDEN_PROOF_CHECKER_ID,
        proofCheckerDigest: ERDEN_PROOF_CHECKER_SHA256,
        tool: Object.freeze({ ...tool }),
    });
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const OWL_BOTTOM_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#bottomObjectProperty';
const OWL_BOTTOM_DATA_PROPERTY = 'http://www.w3.org/2002/07/owl#bottomDataProperty';
const OWL_DISJOINT = 'http://www.w3.org/2002/07/owl#disjointWith';
const OWL_EQUIVALENT = 'http://www.w3.org/2002/07/owl#equivalentClass';
const OWL_INVERSE = 'http://www.w3.org/2002/07/owl#inverseOf';
const OWL_NOTHING = 'http://www.w3.org/2002/07/owl#Nothing';
const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';
const OWL_TRANSITIVE = 'http://www.w3.org/2002/07/owl#TransitiveProperty';
function isDifferent(left: string | number, right: string | number): boolean {
    return left !== right;
}

const RESERVED_NAMESPACES = [
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'http://www.w3.org/2000/01/rdf-schema#',
    'http://www.w3.org/2002/07/owl#',
] as const;
const ALLOWED_RESERVED_IRIS = new Set([
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#HTML',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
    RDF_TYPE,
    'http://www.w3.org/2000/01/rdf-schema#Class',
    'http://www.w3.org/2000/01/rdf-schema#Datatype',
    'http://www.w3.org/2000/01/rdf-schema#Literal',
    'http://www.w3.org/2000/01/rdf-schema#comment',
    RDFS_DOMAIN,
    'http://www.w3.org/2000/01/rdf-schema#label',
    RDFS_RANGE,
    RDFS_SUBCLASS,
    'http://www.w3.org/2002/07/owl#AnnotationProperty',
    'http://www.w3.org/2002/07/owl#Class',
    'http://www.w3.org/2002/07/owl#DatatypeProperty',
    'http://www.w3.org/2002/07/owl#NamedIndividual',
    OWL_NOTHING,
    'http://www.w3.org/2002/07/owl#ObjectProperty',
    'http://www.w3.org/2002/07/owl#Ontology',
    OWL_THING,
    OWL_TRANSITIVE,
    OWL_BOTTOM_DATA_PROPERTY,
    OWL_BOTTOM_OBJECT_PROPERTY,
    OWL_DISJOINT,
    OWL_EQUIVALENT,
    'http://www.w3.org/2002/07/owl#imports',
    OWL_INVERSE,
    'http://www.w3.org/2002/07/owl#unionOf',
]);

function hasDuplicates(values: ReadonlyArray<string>): boolean {
    return new Set(values).size !== values.length;
}

function isReservedIri(iri: string): boolean {
    return RESERVED_NAMESPACES.some((namespace) => iri.startsWith(namespace));
}

/** Whether the V1 profile refuses an axiom that names this IRI: RDF, RDFS or OWL vocabulary outside its allowlist. */
export function isUnknownReservedIri(iri: string): boolean {
    return isReservedIri(iri) && !ALLOWED_RESERVED_IRIS.has(iri);
}

function hasUnknownReservedTerm(iris: ReadonlyArray<string>): boolean {
    return iris.some((iri) => isReservedIri(iri) && !ALLOWED_RESERVED_IRIS.has(iri));
}

function hasInvalidExpressionContext(axiom: NormalizedAxiom): boolean {
    return !hasAdmittedExpressions(axiom);
}

function usesOpaqueExpression(axiom: NormalizedAxiom): boolean {
    return axiomClassExpressions(axiom).some((expression) =>
        someClassExpression(expression, (item) => item.kind === 'OpaqueClassExpression'),
    );
}

function classExpressionHasCycle(axiom: NormalizedAxiom): boolean {
    return axiomClassExpressions(axiom).some((expression) =>
        someClassExpression(expression, (item) => item.kind === 'CyclicClassExpression'),
    );
}

function hasDuplicateUnionOperands(axiom: NormalizedAxiom): boolean {
    return axiomClassExpressions(axiom).some((expression) =>
        someClassExpression(expression, (item) => item.kind === 'ObjectUnionOf' && hasDuplicates(item.operands)),
    );
}

function isThingNothingEquivalence(axiom: NormalizedAxiom): boolean {
    if (axiom.kind !== 'EquivalentClasses') {
        return false;
    }
    const named = new Set(axiom.classes.flatMap((item) => (item.kind === 'NamedClass' ? [item.iri] : [])));
    return named.has(OWL_THING) && named.has(OWL_NOTHING);
}

function usesBottomProperty(axiom: NormalizedAxiom): boolean {
    const iris = axiomIris(axiom);
    return iris.includes(OWL_BOTTOM_OBJECT_PROPERTY) || iris.includes(OWL_BOTTOM_DATA_PROPERTY);
}

/** Finds actual expression-position and construct violations, independent of declarations. */
export function getReasonerProfileRefusals(request: ReasonerRequest): ReadonlyArray<ReasonerExchangeIssue> {
    const issues = new Set<ReasonerExchangeIssue>();
    if (hasUnknownReservedTerm(request.ontology.sources.map((source) => source.ontologyIri))) {
        issues.add('unknown-reserved-term');
    }
    for (const axiom of request.ontology.axioms) {
        if (axiom.graph.kind === 'NamedGraph') {
            issues.add('named-graph');
        }
        if (axiom.provenance.status === 'missing') {
            issues.add('missing-provenance');
        }
        if (axiom.kind === 'Import' || axiom.kind === 'OpaqueAxiom' || usesOpaqueExpression(axiom)) {
            issues.add('unsupported-construct');
        }
        if (hasInvalidExpressionContext(axiom)) {
            issues.add('unsupported-expression-context');
        }
        if (hasDuplicateUnionOperands(axiom)) {
            issues.add('duplicate-union-operand');
        }
        if (hasUnknownReservedTerm(axiomIris(axiom))) {
            issues.add('unknown-reserved-term');
        }
        if (usesBottomProperty(axiom) || classExpressionHasCycle(axiom) || isThingNothingEquivalence(axiom)) {
            issues.add('known-divergence');
        }
    }
    return [...issues].sort();
}

/** Whether two statement objects are the same, compared as canonical text, whatever order each side's keys are in. */
function sameObject(left: JsonValue, right: JsonValue): boolean {
    return stringifyCanonicalJson(left) === stringifyCanonicalJson(right);
}

type StatementObject = Asserted['object'];

/**
 * `sameObject` for a sealed request and an opened answer, both checked strictly against the schema: each object is
 * an IRI or a literal with exactly its four fields, so comparing the IRIs or the fields decides the same without
 * writing either. Never `JSON.stringify` of the two: the request's literals and the answer's have their keys in
 * different orders (schema or normalization order against canonical order).
 */
function sameValidatedObject(left: StatementObject, right: StatementObject): boolean {
    if (typeof left === 'string' || typeof right === 'string') {
        return left === right;
    }
    // Both are literals (`kind` is 'Literal' on both by the schema), compared by their other three fields.
    return (
        left.lexicalForm === right.lexicalForm && left.datatype === right.datatype && left.language === right.language
    );
}

function declarationType(entityKind: string): string {
    switch (entityKind) {
        case 'Ontology':
            return 'http://www.w3.org/2002/07/owl#Ontology';
        case 'Class':
            return 'http://www.w3.org/2002/07/owl#Class';
        case 'ObjectProperty':
            return 'http://www.w3.org/2002/07/owl#ObjectProperty';
        case 'DataProperty':
            return 'http://www.w3.org/2002/07/owl#DatatypeProperty';
        case 'AnnotationProperty':
            return 'http://www.w3.org/2002/07/owl#AnnotationProperty';
        case 'NamedIndividual':
            return 'http://www.w3.org/2002/07/owl#NamedIndividual';
        case 'Datatype':
            return 'http://www.w3.org/2000/01/rdf-schema#Datatype';
        default:
            return '';
    }
}

type DecidedResponse = Extract<ReasonerResponse['result'], { readonly outcome: 'decided' }>;
type Asserted = DecidedResponse['asserted'][number];

function statementMatchesAxiom(
    statement: Asserted,
    axiom: NormalizedAxiom,
    sameValue: (left: StatementObject, right: StatementObject) => boolean,
): boolean {
    switch (axiom.kind) {
        case 'Declaration':
            return (
                statement.subject === axiom.iri &&
                statement.predicate === RDF_TYPE &&
                statement.object === declarationType(axiom.entityKind)
            );
        case 'SubClassOf':
            return (
                axiom.subClass.kind === 'NamedClass' &&
                axiom.superClass.kind === 'NamedClass' &&
                statement.subject === axiom.subClass.iri &&
                statement.predicate === RDFS_SUBCLASS &&
                statement.object === axiom.superClass.iri
            );
        case 'ClassAssertion':
            return (
                axiom.classExpression.kind === 'NamedClass' &&
                statement.subject === axiom.individual &&
                statement.predicate === RDF_TYPE &&
                statement.object === axiom.classExpression.iri
            );
        case 'PropertyDomain':
            return (
                axiom.domain.kind === 'NamedClass' &&
                statement.subject === axiom.property &&
                statement.predicate === RDFS_DOMAIN &&
                statement.object === axiom.domain.iri
            );
        case 'PropertyRange':
            return (
                typeof axiom.range === 'string' &&
                statement.subject === axiom.property &&
                statement.predicate === RDFS_RANGE &&
                statement.object === axiom.range
            );
        case 'EquivalentClasses':
            return (
                typeof statement.object === 'string' &&
                statement.predicate === OWL_EQUIVALENT &&
                axiom.classes.some((item) => item.kind === 'NamedClass' && item.iri === statement.subject) &&
                axiom.classes.some((item) => item.kind === 'NamedClass' && item.iri === statement.object)
            );
        case 'DisjointClasses':
            return (
                typeof statement.object === 'string' &&
                statement.predicate === OWL_DISJOINT &&
                axiom.classes.some((item) => item.kind === 'NamedClass' && item.iri === statement.subject) &&
                axiom.classes.some((item) => item.kind === 'NamedClass' && item.iri === statement.object)
            );
        case 'InverseObjectProperties':
            return (
                statement.subject === axiom.left &&
                statement.predicate === OWL_INVERSE &&
                statement.object === axiom.right
            );
        case 'TransitiveObjectProperty':
            return (
                statement.subject === axiom.property &&
                statement.predicate === RDF_TYPE &&
                statement.object === OWL_TRANSITIVE
            );
        case 'ObjectPropertyAssertion':
            return (
                statement.subject === axiom.subject &&
                statement.predicate === axiom.property &&
                statement.object === axiom.object
            );
        case 'DataPropertyAssertion':
            return (
                statement.subject === axiom.subject &&
                statement.predicate === axiom.property &&
                sameValue(statement.object, axiom.value)
            );
        case 'AnnotationAssertion':
            return (
                statement.subject === axiom.subject &&
                statement.predicate === axiom.property &&
                sameValue(statement.object, axiom.value)
            );
        case 'SubObjectPropertyOf':
        case 'EquivalentObjectProperties':
        case 'FunctionalObjectProperty':
        case 'InverseFunctionalObjectProperty':
        case 'SymmetricObjectProperty':
        case 'SubDataPropertyOf':
        case 'EquivalentDataProperties':
        case 'FunctionalDataProperty':
        case 'Import':
        case 'OpaqueAxiom':
            return false;
    }
}

function addToolIssues(issues: Set<ReasonerExchangeIssue>, actual: RequiredTool, expected: RequiredTool): void {
    if (actual.name !== expected.name) {
        issues.add('tool-name');
    }
    if (actual.version !== expected.version) {
        issues.add('tool-version');
    }
    if (actual.executableDigest !== expected.executableDigest) {
        issues.add('executable-digest');
    }
    if (actual.adapterDigest !== expected.adapterDigest) {
        issues.add('adapter-digest');
    }
    if (actual.calculusDigest !== expected.calculusDigest) {
        issues.add('calculus-digest');
    }
}

/** Whether a request's identifiers and union operands let its input digest be computed at all. */
function digestible(request: ReasonerRequest): boolean {
    return (
        !hasDuplicates(request.ontology.sources.map((source) => source.id)) &&
        !hasDuplicates(request.ontology.axioms.map((axiom) => axiom.id)) &&
        !request.ontology.axioms.some(hasDuplicateUnionOperands)
    );
}

/**
 * The request's input digest, computed at most once; undefined when the request is not digestible. A request
 * `sealReasonerRequest` wrote is frozen and was bound to the digest computed from its own canonical text, so that
 * digest is read instead of computed again.
 */
function lazyInputDigest(request: ReasonerRequest): () => string | undefined {
    const sealed = sealedInputDigest(request);
    if (sealed !== undefined) {
        return () => sealed;
    }
    let computed: { readonly digest: string | undefined } | undefined;
    return () => {
        computed ??= { digest: digestible(request) ? computeReasonerInputDigest(request) : undefined };
        return computed.digest;
    };
}

interface CheckedEnvelope {
    readonly request: ReasonerRequest;
    readonly expected: ReasonerTrustExpectation;
    readonly issues: ReadonlyArray<ReasonerEnvelopeIssue>;
}

/**
 * Envelope results for a sealed request, an opened answer and a frozen expectation: none of the three can change,
 * so the decided-response check reuses the envelope check a caller has just run on the same three.
 */
const checkedEnvelopes = new WeakMap<ReasonerResponse, CheckedEnvelope>();

function memoizable(request: ReasonerRequest, response: ReasonerResponse, expected: ReasonerTrustExpectation): boolean {
    return (
        sealedInputDigest(request) !== undefined &&
        isOpenedResponse(response) &&
        Object.isFrozen(expected) &&
        Object.isFrozen(expected.tool)
    );
}

function checkedEnvelopeIssues(
    request: ReasonerRequest,
    response: ReasonerResponse,
    expected: ReasonerTrustExpectation,
    inputDigest: () => string | undefined,
): ReadonlyArray<ReasonerEnvelopeIssue> {
    const checked = checkedEnvelopes.get(response);
    if (checked !== undefined && checked.request === request && checked.expected === expected) {
        return checked.issues;
    }
    const issues = Object.freeze(envelopeIssues(request, response, expected, inputDigest));
    if (memoizable(request, response, expected)) {
        checkedEnvelopes.set(response, Object.freeze({ request, expected, issues }));
    }
    return issues;
}

function envelopeIssues(
    request: ReasonerRequest,
    response: ReasonerResponse,
    expected: ReasonerTrustExpectation,
    inputDigest: () => string | undefined,
): ReadonlyArray<ReasonerEnvelopeIssue> {
    const issues = new Set<ReasonerEnvelopeIssue>();
    if (isDifferent(expected.protocolVersion, REASONER_PROTOCOL_VERSION)) {
        issues.add('protocol-version');
    }
    if (isDifferent(expected.profileId, REASONER_PROFILE_ID)) {
        issues.add('profile-id');
    }
    if (isDifferent(expected.profileDigest, REASONER_PROFILE_SHA256)) {
        issues.add('profile-digest');
    }
    if (isDifferent(expected.proofCheckerId, ERDEN_PROOF_CHECKER_ID)) {
        issues.add('proof-checker-id');
    }
    if (isDifferent(expected.proofCheckerDigest, ERDEN_PROOF_CHECKER_SHA256)) {
        issues.add('proof-checker-digest');
    }
    if (
        isDifferent(request.protocolVersion, expected.protocolVersion) ||
        isDifferent(response.protocolVersion, expected.protocolVersion)
    ) {
        issues.add('protocol-version');
    }
    if (isDifferent(request.profile.id, expected.profileId) || isDifferent(response.profile.id, expected.profileId)) {
        issues.add('profile-id');
    }
    if (
        isDifferent(request.profile.digest, expected.profileDigest) ||
        isDifferent(response.profile.digest, expected.profileDigest)
    ) {
        issues.add('profile-digest');
    }
    if (response.requestId !== request.requestId) {
        issues.add('request-id');
    }
    addToolIssues(issues, request.requiredTool, expected.tool);
    addToolIssues(issues, response.tool, expected.tool);
    const sourceIds = request.ontology.sources.map((source) => source.id);
    const axiomIds = request.ontology.axioms.map((axiom) => axiom.id);
    if (hasDuplicates(sourceIds) || hasDuplicates(axiomIds)) {
        issues.add('duplicate-identifier');
    }
    if (request.ontology.axioms.some(hasDuplicateUnionOperands)) {
        issues.add('duplicate-union-operand');
    }
    const computed = inputDigest();
    if (computed !== undefined && request.ontology.digest !== computed) {
        issues.add('input-digest');
    }
    if (response.inputDigest !== request.ontology.digest) {
        issues.add('input-digest');
    }
    return [...issues].sort();
}

/**
 * Validates the caller-pinned request/response identity envelope independently
 * of whether the semantic outcome is decided, refused, or incompatible.
 */
export function getReasonerEnvelopeIssues(
    request: ReasonerRequest,
    response: ReasonerResponse,
    expected: ReasonerTrustExpectation,
): ReadonlyArray<ReasonerEnvelopeIssue> {
    return checkedEnvelopeIssues(request, response, expected, lazyInputDigest(request));
}

/** Throws unless the complete response envelope matches caller-owned pins. */
export function assertTrustedReasonerResponseEnvelope(
    request: ReasonerRequest,
    response: ReasonerResponse,
    expected: ReasonerTrustExpectation,
): void {
    const issues = getReasonerEnvelopeIssues(request, response, expected);
    if (issues.length > 0) {
        throw new TypeError(`Reasoner response envelope failed closed: ${issues.join(', ')}`);
    }
}

type UnsatisfiableClass = DecidedResponse['unsatisfiableClasses'][number];

/** How the trust checks compute an answer's justification, aggregate and certificate digests. */
interface AnswerDigests {
    readonly inferred: (statement: InferredStatement) => string;
    readonly lemma: (lemma: Lemma) => string;
    readonly unsatisfiable: (item: UnsatisfiableClass) => string;
    readonly aggregate: typeof aggregateJustificationDigest;
    readonly certificate: (certificate: CheckedCertificate) => string;
}

/** The public digests, for any answer: each value copied with its keys sorted, then written. */
const CANONICAL_DIGESTS: AnswerDigests = Object.freeze({
    inferred: computeInferredJustificationDigest,
    lemma: computeLemmaJustificationDigest,
    unsatisfiable: computeUnsatisfiableJustificationDigest,
    aggregate: aggregateJustificationDigest,
    certificate: computeCertificateDigest,
});

/**
 * The same digests for an opened answer, written once by `JSON.stringify`: each object below is built with its keys
 * in canonical order around parts of the answer whose keys `openReasonerResponseJson` checked, and whose premise
 * lists it checked are sorted, so the text is the canonical writer's.
 */
const ORDERED_DIGESTS: AnswerDigests = Object.freeze({
    inferred: (statement: InferredStatement) =>
        sha256OrderedJson({
            graph: statement.graph,
            id: statement.id,
            object: statement.object,
            predicate: statement.predicate,
            premiseIds: statement.provenance.premiseIds,
            rule: statement.provenance.rule,
            subject: statement.subject,
        }),
    lemma: (lemma: Lemma) =>
        sha256OrderedJson({
            conclusion: lemma.conclusion,
            id: lemma.id,
            premiseIds: lemma.premiseIds,
            rule: lemma.rule,
        }),
    unsatisfiable: (item: UnsatisfiableClass) =>
        sha256OrderedJson({ classIri: item.classIri, premiseIds: item.premiseIds }),
    aggregate: (
        inferred: Parameters<typeof aggregateJustificationDigest>[0],
        unsatisfiableClasses: Parameters<typeof aggregateJustificationDigest>[1],
        lemmas?: Parameters<typeof aggregateJustificationDigest>[2],
    ) =>
        sha256OrderedJson({
            inferred: inferred.map(({ id, justificationDigest }) => ({ id, justificationDigest })),
            ...(lemmas === undefined || lemmas.length === 0
                ? {}
                : { lemmas: lemmas.map(({ id, justificationDigest }) => ({ id, justificationDigest })) }),
            unsatisfiableClasses: unsatisfiableClasses.map(({ classIri, justificationDigest }) => ({
                classIri,
                justificationDigest,
            })),
        }),
    certificate: (certificate: CheckedCertificate) => {
        const { certificateDigest: _certificateDigest, ...bound } = certificate;
        void _certificateDigest;
        return sha256OrderedJson(bound);
    },
});

/**
 * Everything `getReasonerCompatibilityIssues` checks beyond the profile and the envelope, which has already compared
 * the request's identifiers and its and the answer's input digests.
 */
function evidenceIssues(
    request: ReasonerRequest,
    response: ReasonerResponse,
    expected: ReasonerTrustExpectation,
    inputDigest: () => string | undefined,
    issues: Set<ReasonerExchangeIssue>,
): void {
    const sourceIds = request.ontology.sources.map((source) => source.id);
    const axiomIds = request.ontology.axioms.map((axiom) => axiom.id);
    const sources = new Map(request.ontology.sources.map((source) => [source.id, source]));
    const axioms = new Map(request.ontology.axioms.map((axiom) => [axiom.id, axiom]));
    for (const axiom of request.ontology.axioms) {
        if (axiom.provenance.status !== 'available') {
            continue;
        }
        const source = sources.get(axiom.provenance.sourceId);
        if (source === undefined || source.contentDigest !== axiom.provenance.sourceDigest) {
            issues.add('axiom-source');
        }
    }
    const computedInputDigest = inputDigest();
    // An opened answer was read from canonical text with its keys checked in canonical order and its arrays in
    // normalized order: its digests are written by JSON.stringify of its parts, never copied and sorted again.
    const opened = isOpenedResponse(response);
    const digests = opened ? ORDERED_DIGESTS : CANONICAL_DIGESTS;
    const sameValue = opened && sealedInputDigest(request) !== undefined ? sameValidatedObject : sameObject;
    if (response.result.outcome === 'decided') {
        const lemmas = response.result.lemmas ?? [];
        const statementIds = [
            ...response.result.asserted.map((statement) => statement.id),
            ...response.result.inferred.map((statement) => statement.id),
            ...lemmas.map((lemma) => lemma.id),
        ];
        if (hasDuplicates(statementIds) || hasDuplicates([...sourceIds, ...axiomIds, ...statementIds])) {
            issues.add('duplicate-identifier');
        }
        for (const statement of response.result.asserted) {
            const axiom = axioms.get(statement.provenance.axiomId);
            const source = sources.get(statement.provenance.sourceId);
            if (
                axiom === undefined ||
                source === undefined ||
                axiom.provenance.status !== 'available' ||
                axiom.provenance.sourceId !== statement.provenance.sourceId ||
                axiom.provenance.sourceDigest !== statement.provenance.sourceDigest ||
                source.contentDigest !== statement.provenance.sourceDigest
            ) {
                issues.add('asserted-provenance');
            } else if (!statementMatchesAxiom(statement, axiom, sameValue)) {
                issues.add('asserted-statement');
            }
        }
        const premiseIds = new Set([...axiomIds, ...statementIds]);
        // Each justification digest is computed once, checked here and reused for the certificate's aggregate.
        const inferredDigests = response.result.inferred.map((statement) => {
            if (statement.provenance.premiseIds.some((id) => !premiseIds.has(id) || id === statement.id)) {
                issues.add('missing-premise');
            }
            const justificationDigest = digests.inferred(statement);
            if (statement.provenance.justificationDigest !== justificationDigest) {
                issues.add('inferred-justification-digest');
            }
            return { id: statement.id, justificationDigest };
        });
        const lemmaDigests = lemmas.map((lemma) => {
            if (lemma.premiseIds.some((id) => !premiseIds.has(id) || id === lemma.id)) {
                issues.add('missing-premise');
            }
            const justificationDigest = digests.lemma(lemma);
            if (lemma.justificationDigest !== justificationDigest) {
                issues.add('lemma-justification-digest');
            }
            return { id: lemma.id, justificationDigest };
        });
        const unsatisfiableDigests = response.result.unsatisfiableClasses.map((item) => {
            if (item.premiseIds.some((id) => !premiseIds.has(id))) {
                issues.add('missing-premise');
            }
            const justificationDigest = digests.unsatisfiable(item);
            if (item.justificationDigest !== justificationDigest) {
                issues.add('unsatisfiable-justification-digest');
            }
            return { classIri: item.classIri, justificationDigest };
        });
        // A Horn inconsistency cites the proved lemma or statement that concludes it, beside axioms.
        if (response.result.diagnostics.some((diagnostic) => diagnostic.axiomIds.some((id) => !premiseIds.has(id)))) {
            issues.add('diagnostic-reference');
        }
        const { certificate, ...evidence } = response.result;
        for (const issue of getProofValidationIssues(request, evidence)) {
            issues.add(issue);
        }
        if (
            computedInputDigest === undefined ||
            certificate.inputDigest !== computedInputDigest ||
            certificate.inputDigest !== response.inputDigest
        ) {
            issues.add('certificate-input-digest');
        }
        // An opened answer's evidence was hashed from the canonical text it was read from.
        if (certificate.outputDigest !== (openedOutputDigest(response) ?? computeDecidedOutputDigest(evidence))) {
            issues.add('certificate-output-digest');
        }
        if (certificate.calculusDigest !== expected.tool.calculusDigest) {
            issues.add('calculus-digest');
        }
        if (certificate.proofCheckerId !== expected.proofCheckerId) {
            issues.add('proof-checker-id');
        }
        if (certificate.proofCheckerDigest !== expected.proofCheckerDigest) {
            issues.add('proof-checker-digest');
        }
        if (
            certificate.justificationDigest !== digests.aggregate(inferredDigests, unsatisfiableDigests, lemmaDigests)
        ) {
            issues.add('certificate-justification-digest');
        }
        if (certificate.certificateDigest !== digests.certificate(certificate)) {
            issues.add('certificate-digest');
        }
    }
}

/** Cross-validates pinned identity, references, provenance, and cryptographic evidence. */
export function getReasonerCompatibilityIssues(
    request: ReasonerRequest,
    response: ReasonerResponse,
    expected: ReasonerTrustExpectation,
): ReadonlyArray<ReasonerExchangeIssue> {
    const inputDigest = lazyInputDigest(request);
    const issues = new Set<ReasonerExchangeIssue>([
        ...getReasonerProfileRefusals(request),
        ...checkedEnvelopeIssues(request, response, expected, inputDigest),
    ]);
    evidenceIssues(request, response, expected, inputDigest, issues);
    return [...issues].sort();
}

/** Throws unless a decided response satisfies all caller-pinned and recomputed checks. */
export function assertTrustedDecidedResponse(
    request: ReasonerRequest,
    response: ReasonerResponse,
    expected: ReasonerTrustExpectation,
): void {
    if (response.result.outcome !== 'decided') {
        throw new TypeError(`Reasoner did not return a complete decision: ${response.result.outcome}`);
    }
    const issues = getReasonerCompatibilityIssues(request, response, expected);
    if (issues.length > 0) {
        throw new TypeError(`Reasoner response failed closed: ${issues.join(', ')}`);
    }
}
