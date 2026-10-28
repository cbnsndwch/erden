import { Schema } from 'effect';

import {
    ERDEN_PROOF_CHECKER_ID,
    REASONER_OPERATION,
    REASONER_PROFILE_ID,
    REASONER_PROTOCOL_VERSION,
} from './profile.js';

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
function TwoOrMore<S extends Schema.Constraint>(item: S) {
    return Schema.Array(item).check(Schema.isMinLength(2));
}

export const ReasonerProtocolVersion = Schema.Literal(REASONER_PROTOCOL_VERSION);
export type ReasonerProtocolVersion = typeof ReasonerProtocolVersion.Type;
export const NonEmptyText = Schema.NonEmptyString;
export const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u));
/**
 * The hard ceiling for one request or response on the wire, 128 MiB. Deployments set a lower effective ceiling for
 * the request and its answer (ERDEN_REASONER_MAX_REQUEST_BYTES, 16 MiB by default).
 */
export const MAX_REASONER_WIRE_BYTES = 134_217_728 as const;
/** V1 request IDs are ASCII by Identifier, so code-unit and UTF-8 byte lengths are identical. */
export const MAX_REASONER_REQUEST_ID_BYTES = 1024 as const;
export const ReasonerRequestId = Identifier.check(Schema.isMaxLength(MAX_REASONER_REQUEST_ID_BYTES));
export type ReasonerRequestId = typeof ReasonerRequestId.Type;
export const AbsoluteIri = Schema.String.check(
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9+.-]*:(?!.*[\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF])[\s\S]+$/u),
);
export const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));

export const ProfileReference = Schema.Struct({ id: Schema.Literal(REASONER_PROFILE_ID), digest: Sha256Digest });
export type ProfileReference = typeof ProfileReference.Type;

export const DefaultGraph = Schema.Struct({ kind: Schema.Literal('DefaultGraph') });
export const NamedGraph = Schema.Struct({ kind: Schema.Literal('NamedGraph'), iri: AbsoluteIri });
export const GraphName = Schema.Union([DefaultGraph, NamedGraph]);
export type GraphName = typeof GraphName.Type;

export const Literal = Schema.Struct({
    kind: Schema.Literal('Literal'),
    lexicalForm: Schema.String,
    datatype: AbsoluteIri,
    language: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/u))),
});
export type Literal = typeof Literal.Type;

/** An object property, or the inverse of one (`ObjectInverseOf`). */
export const ObjectInverseOf = Schema.Struct({ kind: Schema.Literal('ObjectInverseOf'), property: AbsoluteIri });
export const ObjectPropertyExpression = Schema.Union([AbsoluteIri, ObjectInverseOf]);
export type ObjectPropertyExpression = typeof ObjectPropertyExpression.Type;
/** The left side of a complex role inclusion: the properties in order, composed. */
export const ObjectPropertyChain = Schema.Struct({
    kind: Schema.Literal('ObjectPropertyChain'),
    properties: TwoOrMore(ObjectPropertyExpression),
});
export type ObjectPropertyChain = typeof ObjectPropertyChain.Type;

export type NamedClassExpression = {
    readonly kind: 'NamedClass';
    readonly iri: string;
};
/** V1's union: of named classes only, as a property domain or (V2) a subclass. */
export type ObjectUnionOfExpression = {
    readonly kind: 'ObjectUnionOf';
    readonly operands: ReadonlyArray<string>;
};
export type ObjectIntersectionOfExpression = {
    readonly kind: 'ObjectIntersectionOf';
    readonly operands: ReadonlyArray<ClassExpression>;
};
export type ObjectSomeValuesFromExpression = {
    readonly kind: 'ObjectSomeValuesFrom';
    readonly property: ObjectPropertyExpression;
    readonly filler: ClassExpression;
};
export type ObjectAllValuesFromExpression = {
    readonly kind: 'ObjectAllValuesFrom';
    readonly property: ObjectPropertyExpression;
    readonly filler: ClassExpression;
};
/** At most 0 or 1 successors in the filler; an unqualified restriction has `owl:Thing` as its filler. */
export type ObjectMaxCardinalityExpression = {
    readonly kind: 'ObjectMaxCardinality';
    readonly cardinality: 0 | 1;
    readonly property: ObjectPropertyExpression;
    readonly filler: ClassExpression;
};
export type ObjectComplementOfExpression = {
    readonly kind: 'ObjectComplementOf';
    readonly operand: ClassExpression;
};
export type OpaqueClassExpressionValue = {
    readonly kind: 'OpaqueClassExpression';
    readonly constructIri: string;
    readonly canonicalForm: string;
};
export type CyclicClassExpressionValue = {
    readonly kind: 'CyclicClassExpression';
    readonly expressionId: string;
};
export type ClassExpression =
    | NamedClassExpression
    | ObjectUnionOfExpression
    | ObjectIntersectionOfExpression
    | ObjectSomeValuesFromExpression
    | ObjectAllValuesFromExpression
    | ObjectMaxCardinalityExpression
    | ObjectComplementOfExpression
    | OpaqueClassExpressionValue
    | CyclicClassExpressionValue;

const ClassExpressionReference = Schema.suspend((): Schema.Codec<ClassExpression> => ClassExpression);

export const NamedClass = Schema.Struct({ kind: Schema.Literal('NamedClass'), iri: AbsoluteIri });
export const ObjectUnionOf = Schema.Struct({ kind: Schema.Literal('ObjectUnionOf'), operands: TwoOrMore(AbsoluteIri) });
export const ObjectIntersectionOf = Schema.Struct({
    kind: Schema.Literal('ObjectIntersectionOf'),
    operands: TwoOrMore(ClassExpressionReference),
});
export const ObjectSomeValuesFrom = Schema.Struct({
    kind: Schema.Literal('ObjectSomeValuesFrom'),
    property: ObjectPropertyExpression,
    filler: ClassExpressionReference,
});
export const ObjectAllValuesFrom = Schema.Struct({
    kind: Schema.Literal('ObjectAllValuesFrom'),
    property: ObjectPropertyExpression,
    filler: ClassExpressionReference,
});
export const ObjectMaxCardinality = Schema.Struct({
    kind: Schema.Literal('ObjectMaxCardinality'),
    cardinality: Schema.Literals([0, 1]),
    property: ObjectPropertyExpression,
    filler: ClassExpressionReference,
});
export const ObjectComplementOf = Schema.Struct({
    kind: Schema.Literal('ObjectComplementOf'),
    operand: ClassExpressionReference,
});
export const OpaqueClassExpression = Schema.Struct({
    kind: Schema.Literal('OpaqueClassExpression'),
    constructIri: AbsoluteIri,
    canonicalForm: NonEmptyText,
});
export const CyclicClassExpression = Schema.Struct({
    kind: Schema.Literal('CyclicClassExpression'),
    expressionId: Identifier,
});
export const ClassExpression: Schema.Codec<ClassExpression> = Schema.Union([
    NamedClass,
    ObjectUnionOf,
    ObjectIntersectionOf,
    ObjectSomeValuesFrom,
    ObjectAllValuesFrom,
    ObjectMaxCardinality,
    ObjectComplementOf,
    OpaqueClassExpression,
    CyclicClassExpression,
]);

export const AvailableAssertedProvenance = Schema.Struct({
    status: Schema.Literal('available'),
    sourceId: Identifier,
    sourceDigest: Sha256Digest,
    locator: NonEmptyText,
});
export const MissingAssertedProvenance = Schema.Struct({ status: Schema.Literal('missing') });
export const AssertedProvenance = Schema.Union([AvailableAssertedProvenance, MissingAssertedProvenance]);
export type AssertedProvenance = typeof AssertedProvenance.Type;

const axiomFields = { id: Identifier, graph: GraphName, provenance: AssertedProvenance };
export const DeclarationAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('Declaration'),
    entityKind: Schema.Literals([
        'Ontology',
        'Class',
        'ObjectProperty',
        'DataProperty',
        'AnnotationProperty',
        'NamedIndividual',
        'Datatype',
    ]),
    iri: AbsoluteIri,
});
export const SubClassOfAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('SubClassOf'),
    subClass: ClassExpression,
    superClass: ClassExpression,
});
export const ClassAssertionAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('ClassAssertion'),
    classExpression: ClassExpression,
    individual: AbsoluteIri,
});
export const PropertyDomainAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('PropertyDomain'),
    propertyKind: Schema.Literals(['ObjectProperty', 'DataProperty', 'AnnotationProperty']),
    property: AbsoluteIri,
    domain: ClassExpression,
});
/**
 * A named range is its IRI, as in V1 (a class, datatype or annotation range). V2 adds a class expression as the range
 * of an object property; a named class range stays an IRI, so each axiom has one encoding.
 */
export const PropertyRangeAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('PropertyRange'),
    propertyKind: Schema.Literals(['ObjectProperty', 'DataProperty', 'AnnotationProperty']),
    property: AbsoluteIri,
    range: Schema.Union([AbsoluteIri, ClassExpression]),
});
export const EquivalentClassesAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('EquivalentClasses'),
    classes: TwoOrMore(ClassExpression),
});
export const DisjointClassesAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('DisjointClasses'),
    classes: TwoOrMore(ClassExpression),
});
export const InverseObjectPropertiesAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('InverseObjectProperties'),
    left: AbsoluteIri,
    right: AbsoluteIri,
});
export const TransitiveObjectPropertyAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('TransitiveObjectProperty'),
    property: AbsoluteIri,
});
export const SubObjectPropertyOfAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('SubObjectPropertyOf'),
    subProperty: Schema.Union([ObjectPropertyExpression, ObjectPropertyChain]),
    superProperty: ObjectPropertyExpression,
});
export const EquivalentObjectPropertiesAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('EquivalentObjectProperties'),
    properties: TwoOrMore(ObjectPropertyExpression),
});
export const FunctionalObjectPropertyAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('FunctionalObjectProperty'),
    property: ObjectPropertyExpression,
});
export const InverseFunctionalObjectPropertyAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('InverseFunctionalObjectProperty'),
    property: ObjectPropertyExpression,
});
export const SymmetricObjectPropertyAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('SymmetricObjectProperty'),
    property: AbsoluteIri,
});
export const SubDataPropertyOfAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('SubDataPropertyOf'),
    subProperty: AbsoluteIri,
    superProperty: AbsoluteIri,
});
export const EquivalentDataPropertiesAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('EquivalentDataProperties'),
    properties: TwoOrMore(AbsoluteIri),
});
export const FunctionalDataPropertyAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('FunctionalDataProperty'),
    property: AbsoluteIri,
});
export const ObjectPropertyAssertionAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('ObjectPropertyAssertion'),
    property: AbsoluteIri,
    subject: AbsoluteIri,
    object: AbsoluteIri,
});
export const DataPropertyAssertionAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('DataPropertyAssertion'),
    property: AbsoluteIri,
    subject: AbsoluteIri,
    value: Literal,
});
export const AnnotationAssertionAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('AnnotationAssertion'),
    property: AbsoluteIri,
    subject: AbsoluteIri,
    value: Schema.Union([AbsoluteIri, Literal]),
});
export const ImportAxiom = Schema.Struct({ ...axiomFields, kind: Schema.Literal('Import'), ontology: AbsoluteIri });
export const OpaqueAxiom = Schema.Struct({
    ...axiomFields,
    kind: Schema.Literal('OpaqueAxiom'),
    constructIri: AbsoluteIri,
    canonicalForm: NonEmptyText,
});

export const NormalizedAxiom = Schema.Union([
    DeclarationAxiom,
    SubClassOfAxiom,
    ClassAssertionAxiom,
    PropertyDomainAxiom,
    PropertyRangeAxiom,
    EquivalentClassesAxiom,
    DisjointClassesAxiom,
    InverseObjectPropertiesAxiom,
    TransitiveObjectPropertyAxiom,
    SubObjectPropertyOfAxiom,
    EquivalentObjectPropertiesAxiom,
    FunctionalObjectPropertyAxiom,
    InverseFunctionalObjectPropertyAxiom,
    SymmetricObjectPropertyAxiom,
    SubDataPropertyOfAxiom,
    EquivalentDataPropertiesAxiom,
    FunctionalDataPropertyAxiom,
    ObjectPropertyAssertionAxiom,
    DataPropertyAssertionAxiom,
    AnnotationAssertionAxiom,
    ImportAxiom,
    OpaqueAxiom,
]);
export type NormalizedAxiom = typeof NormalizedAxiom.Type;

export const OntologySource = Schema.Struct({
    id: Identifier,
    kind: Schema.Literals(['root', 'dependency']),
    ontologyIri: AbsoluteIri,
    contentDigest: Sha256Digest,
});
export type OntologySource = typeof OntologySource.Type;

export const RequiredTool = Schema.Struct({
    name: NonEmptyText,
    version: NonEmptyText,
    executableDigest: Sha256Digest,
    adapterDigest: Sha256Digest,
    calculusDigest: Sha256Digest,
});
export type RequiredTool = typeof RequiredTool.Type;
export const ReasoningLimits = Schema.Struct({
    maxInputAxioms: PositiveInteger,
    maxInferences: PositiveInteger,
    maxWallTimeMs: PositiveInteger,
});

export const ReasonerRequest = Schema.Struct({
    protocolVersion: ReasonerProtocolVersion,
    kind: Schema.Literal('ReasonerRequest'),
    requestId: ReasonerRequestId,
    operation: Schema.Literal(REASONER_OPERATION),
    profile: ProfileReference,
    requiredTool: RequiredTool,
    limits: ReasoningLimits,
    ontology: Schema.Struct({
        digest: Sha256Digest,
        sources: Schema.NonEmptyArray(OntologySource),
        axioms: Schema.Array(NormalizedAxiom),
    }),
});
export type ReasonerRequest = typeof ReasonerRequest.Type;

export const StatementObject = Schema.Union([AbsoluteIri, Literal]);
const statementFields = {
    id: Identifier,
    subject: AbsoluteIri,
    predicate: AbsoluteIri,
    object: StatementObject,
    graph: DefaultGraph,
};
export const AssertedStatement = Schema.Struct({
    ...statementFields,
    provenance: Schema.Struct({
        kind: Schema.Literal('asserted'),
        axiomId: Identifier,
        sourceId: Identifier,
        sourceDigest: Sha256Digest,
    }),
});
export type AssertedStatement = typeof AssertedStatement.Type;
/** The proof rules of the V1 decision procedure (proof checker v2), unchanged in v3. */
export const V1_PROOF_RULES = [
    'subclass-type',
    'subclass-transitive',
    'object-property-domain',
    'data-property-domain',
    'object-property-range',
    'equivalent-class-subclass',
    'equivalent-class-type',
    'inverse-object-property',
    'transitive-object-property',
    'union-domain-type',
    'thing-subclass-type',
] as const;
/** The proof rules of the Horn calculus (proof checker v3); `proof-horn.ts` states what each one checks. */
export const HORN_PROOF_RULES = [
    'conjunct',
    'told',
    'and-intro',
    'and-elim',
    'union-intro',
    'exists-intro',
    'exists-bottom',
    'forall-filler',
    'inverse-pushback',
    'inverse-filler',
    'transitive-filler',
    'transitive-pushback',
    'transitive-exists',
    'functional-merge',
    'functional-pushback',
    'functional-same-as',
    'functional-filler',
    'max-zero',
    'max-zero-pushback',
    'disjoint',
    'complement',
    'sub-property',
    'transitive-edge',
    'data-domain',
    'same-as-symmetric',
    'same-as-transitive',
    'same-as-copy',
    'union-case',
    'chain-exists',
    'chain-forall',
    'chain-edge',
] as const;
export const ProofRuleName = Schema.Literals([...V1_PROOF_RULES, ...HORN_PROOF_RULES]);
export type ProofRule = typeof ProofRuleName.Type;

export const InferredStatement = Schema.Struct({
    ...statementFields,
    provenance: Schema.Struct({
        kind: Schema.Literal('inferred'),
        rule: ProofRuleName,
        premiseIds: Schema.NonEmptyArray(Identifier),
        justificationDigest: Sha256Digest,
    }),
});
export type InferredStatement = typeof InferredStatement.Type;

/**
 * A proof step whose conclusion is not an RDF statement: every element of a context (a class expression, read as
 * its conjuncts) is in a class expression, or one named individual is. Only the Horn calculus writes lemmas.
 */
export const LemmaConclusion = Schema.Union([
    Schema.Struct({ kind: Schema.Literal('SubClassOf'), subClass: ClassExpression, superClass: ClassExpression }),
    Schema.Struct({
        kind: Schema.Literal('ClassAssertion'),
        individual: AbsoluteIri,
        classExpression: ClassExpression,
    }),
]);
export type LemmaConclusion = typeof LemmaConclusion.Type;
export const Lemma = Schema.Struct({
    id: Identifier,
    rule: ProofRuleName,
    premiseIds: Schema.Array(Identifier),
    conclusion: LemmaConclusion,
    justificationDigest: Sha256Digest,
});
export type Lemma = typeof Lemma.Type;

export const Diagnostic = Schema.Struct({
    severity: Schema.Literals(['warning', 'error']),
    code: Identifier,
    message: NonEmptyText,
    axiomIds: Schema.Array(Identifier),
});
export type Diagnostic = typeof Diagnostic.Type;
export const UnsatisfiableClass = Schema.Struct({
    classIri: AbsoluteIri,
    premiseIds: Schema.NonEmptyArray(Identifier),
    justificationDigest: Sha256Digest,
});
export const CheckedCertificate = Schema.Struct({
    decision: Schema.Literal('Decided'),
    checked: Schema.Literal(true),
    checkerName: NonEmptyText,
    checkerVersion: NonEmptyText,
    proofCheckerId: Schema.Literal(ERDEN_PROOF_CHECKER_ID),
    proofCheckerDigest: Sha256Digest,
    inputDigest: Sha256Digest,
    outputDigest: Sha256Digest,
    calculusDigest: Sha256Digest,
    certificateDigest: Sha256Digest,
    justificationDigest: Sha256Digest,
});
export type CheckedCertificate = typeof CheckedCertificate.Type;

export const DecidedResult = Schema.Struct({
    outcome: Schema.Literal('decided'),
    completeness: Schema.Literal('complete'),
    consistency: Schema.Literals(['consistent', 'inconsistent']),
    asserted: Schema.Array(AssertedStatement),
    inferred: Schema.Array(InferredStatement),
    /** Absent when there are none, so V1 answers keep their bytes. */
    lemmas: Schema.optionalKey(Schema.NonEmptyArray(Lemma)),
    unsatisfiableClasses: Schema.Array(UnsatisfiableClass),
    diagnostics: Schema.Array(Diagnostic),
    certificate: CheckedCertificate,
});
export type DecidedResult = typeof DecidedResult.Type;

export const RefusalReason = Schema.Literals([
    'unsupported-construct',
    'named-graph',
    'unknown-reserved-term',
    'bottom-property',
    'cyclic-expression',
    'known-divergence',
    'unknown-result',
    'boundary-exhausted',
    'budget-exhausted',
    'missing-provenance',
    'incomplete-certificate',
]);
export type RefusalReason = typeof RefusalReason.Type;
export const RefusedResult = Schema.Struct({
    outcome: Schema.Literal('refused'),
    completeness: Schema.Literal('incomplete'),
    reason: RefusalReason,
    diagnostics: Schema.NonEmptyArray(Diagnostic),
});
export type RefusedResult = typeof RefusedResult.Type;

export const IncompatibilityReason = Schema.Literals([
    'protocol-version',
    'tool-name',
    'tool-version',
    'executable-digest',
    'adapter-digest',
    'calculus-digest',
    'profile-id',
    'profile-digest',
    'input-digest',
]);
export type IncompatibilityReason = typeof IncompatibilityReason.Type;
export const IncompatibleResult = Schema.Struct({
    outcome: Schema.Literal('incompatible'),
    completeness: Schema.Literal('incomplete'),
    reason: IncompatibilityReason,
    expected: NonEmptyText,
    actual: NonEmptyText,
    diagnostics: Schema.NonEmptyArray(Diagnostic),
});
export type IncompatibleResult = typeof IncompatibleResult.Type;

export const ReasonerResult = Schema.Union([DecidedResult, RefusedResult, IncompatibleResult]);
export type ReasonerResult = typeof ReasonerResult.Type;
export const ActualTool = RequiredTool;
export type ActualTool = typeof ActualTool.Type;
export const ReasonerResponse = Schema.Struct({
    protocolVersion: ReasonerProtocolVersion,
    kind: Schema.Literal('ReasonerResponse'),
    requestId: ReasonerRequestId,
    profile: ProfileReference,
    tool: ActualTool,
    inputDigest: Sha256Digest,
    result: ReasonerResult,
});
export type ReasonerResponse = typeof ReasonerResponse.Type;

/** JSON text codecs. Use the strict helpers at the process boundary. */
export const ReasonerRequestJson = Schema.fromJsonString(ReasonerRequest);
export const ReasonerResponseJson = Schema.fromJsonString(ReasonerResponse);
