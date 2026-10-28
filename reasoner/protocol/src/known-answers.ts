import {
    decodeReasonerRequestJson,
    decodeReasonerResponseJson,
    encodeReasonerRequestJson,
    encodeReasonerResponseJson,
} from './canonical.js';
import { bindDecidedEvidence, computeReasonerInputDigest } from './evidence.js';
import type { DecidedEvidence } from './evidence.js';
import {
    REASONER_OPERATION,
    REASONER_PROFILE_ID,
    REASONER_PROFILE_SHA256,
    REASONER_PROTOCOL_VERSION,
} from './profile.js';
import type {
    AssertedStatement,
    InferredStatement,
    NormalizedAxiom,
    ProofRule,
    ReasonerRequest,
    ReasonerResponse,
    ReasonerResult,
} from './schema.js';
import type { DecidedResult } from './schema.js';

const EX = 'https://example.test/erden/reasoner#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const SHA = {
    source: `sha256:${'a'.repeat(64)}`,
    executable: `sha256:${'b'.repeat(64)}`,
    adapter: `sha256:${'c'.repeat(64)}`,
    calculus: `sha256:${'d'.repeat(64)}`,
    placeholder: `sha256:${'0'.repeat(64)}`,
} as const;
const DEFAULT_GRAPH = { kind: 'DefaultGraph' as const };
const SOURCE = {
    id: 'source:root',
    kind: 'root' as const,
    ontologyIri: `${EX}ontology`,
    contentDigest: SHA.source,
};
const TOOL = {
    name: 'erden-fixture-reasoner',
    version: '0.0.0-fixture',
    executableDigest: SHA.executable,
    adapterDigest: SHA.adapter,
    calculusDigest: SHA.calculus,
};
const PROFILE = { id: REASONER_PROFILE_ID, digest: REASONER_PROFILE_SHA256 };
const CHECKER = { name: 'erden-fixture-certificate-checker', version: '1' };

function available(axiomId: string) {
    return {
        status: 'available' as const,
        sourceId: SOURCE.id,
        sourceDigest: SHA.source,
        locator: `fixture.ttl#${axiomId}`,
    };
}
function named(iri: string) {
    return { kind: 'NamedClass' as const, iri };
}

function makeRequest(
    scenario: string,
    _digestCharacter: string,
    axioms: ReadonlyArray<NormalizedAxiom>,
): ReasonerRequest {
    void _digestCharacter;
    const request: ReasonerRequest = {
        protocolVersion: REASONER_PROTOCOL_VERSION,
        kind: 'ReasonerRequest',
        requestId: `known-answer:${scenario}`,
        operation: REASONER_OPERATION,
        profile: PROFILE,
        requiredTool: TOOL,
        limits: { maxInputAxioms: 1000, maxInferences: 1000, maxWallTimeMs: 5000 },
        ontology: { digest: SHA.placeholder, sources: [SOURCE], axioms },
    };
    return { ...request, ontology: { ...request.ontology, digest: computeReasonerInputDigest(request) } };
}

function assertedType(id: string, axiomId: string, individual: string, classIri: string): AssertedStatement {
    return {
        id,
        subject: individual,
        predicate: RDF_TYPE,
        object: classIri,
        graph: DEFAULT_GRAPH,
        provenance: { kind: 'asserted', axiomId, sourceId: SOURCE.id, sourceDigest: SHA.source },
    };
}
function inferred(
    id: string,
    subject: string,
    predicate: string,
    object: string,
    rule: ProofRule,
    premiseIds: readonly [string, ...string[]],
): InferredStatement {
    return {
        id,
        subject,
        predicate,
        object,
        graph: DEFAULT_GRAPH,
        provenance: { kind: 'inferred', rule, premiseIds, justificationDigest: SHA.placeholder },
    };
}
function decided(
    request: ReasonerRequest,
    consistency: 'consistent' | 'inconsistent',
    asserted: ReadonlyArray<AssertedStatement>,
    inferredStatements: ReadonlyArray<InferredStatement>,
    unsatisfiableClasses: DecidedResult['unsatisfiableClasses'] = [],
    diagnostics: DecidedResult['diagnostics'] = [],
): DecidedResult {
    return bindDecidedEvidence(
        request,
        {
            outcome: 'decided',
            completeness: 'complete',
            consistency,
            asserted,
            inferred: inferredStatements,
            unsatisfiableClasses,
            diagnostics,
        } satisfies DecidedEvidence,
        CHECKER,
    );
}
function makeResponse(request: ReasonerRequest, result: ReasonerResult): ReasonerResponse {
    return {
        protocolVersion: REASONER_PROTOCOL_VERSION,
        kind: 'ReasonerResponse',
        requestId: request.requestId,
        profile: PROFILE,
        tool: TOOL,
        inputDigest: request.ontology.digest,
        result,
    };
}

export interface KnownAnswerFixture {
    readonly scenario: string;
    readonly request: ReasonerRequest;
    readonly response: ReasonerResponse;
    readonly requestJson: string;
    readonly responseJson: string;
}

function fixture(scenario: string, request: ReasonerRequest, result: ReasonerResult): KnownAnswerFixture {
    const requestJson = encodeReasonerRequestJson(request);
    const canonicalRequest = decodeReasonerRequestJson(requestJson);
    const responseJson = encodeReasonerResponseJson(makeResponse(canonicalRequest, result));
    return Object.freeze({
        scenario,
        request: canonicalRequest,
        response: decodeReasonerResponseJson(responseJson),
        requestJson,
        responseJson,
    });
}

const subclassTypeRequest = makeRequest('subclass-type', '1', [
    {
        id: 'a1',
        kind: 'SubClassOf',
        subClass: named(`${EX}Child`),
        superClass: named(`${EX}Parent`),
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'ClassAssertion',
        classExpression: named(`${EX}Child`),
        individual: `${EX}alice`,
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
]);
const domainRangeRequest = makeRequest('domain-range', '2', [
    {
        id: 'a1',
        kind: 'PropertyDomain',
        propertyKind: 'ObjectProperty',
        property: `${EX}knows`,
        domain: named(`${EX}Person`),
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'PropertyRange',
        propertyKind: 'ObjectProperty',
        property: `${EX}knows`,
        range: `${EX}Person`,
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
    {
        id: 'a3',
        kind: 'ObjectPropertyAssertion',
        property: `${EX}knows`,
        subject: `${EX}alice`,
        object: `${EX}bob`,
        graph: DEFAULT_GRAPH,
        provenance: available('a3'),
    },
]);
const equivalenceRequest = makeRequest('equivalence', '3', [
    {
        id: 'a1',
        kind: 'EquivalentClasses',
        classes: [named(`${EX}Writer`), named(`${EX}Author`)],
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'ClassAssertion',
        classExpression: named(`${EX}Writer`),
        individual: `${EX}alice`,
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
]);
const disjointnessRequest = makeRequest('disjointness', '4', [
    {
        id: 'a1',
        kind: 'DisjointClasses',
        classes: [named(`${EX}Person`), named(`${EX}Machine`)],
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'ClassAssertion',
        classExpression: named(`${EX}Person`),
        individual: `${EX}alice`,
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
    {
        id: 'a3',
        kind: 'ClassAssertion',
        classExpression: named(`${EX}Machine`),
        individual: `${EX}robot`,
        graph: DEFAULT_GRAPH,
        provenance: available('a3'),
    },
]);
const inverseTransitiveRequest = makeRequest('inverse-transitive-properties', '5', [
    {
        id: 'a1',
        kind: 'InverseObjectProperties',
        left: `${EX}parentOf`,
        right: `${EX}childOf`,
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'TransitiveObjectProperty',
        property: `${EX}ancestorOf`,
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
    {
        id: 'a3',
        kind: 'ObjectPropertyAssertion',
        property: `${EX}parentOf`,
        subject: `${EX}alice`,
        object: `${EX}bob`,
        graph: DEFAULT_GRAPH,
        provenance: available('a3'),
    },
    {
        id: 'a4',
        kind: 'ObjectPropertyAssertion',
        property: `${EX}ancestorOf`,
        subject: `${EX}alice`,
        object: `${EX}bob`,
        graph: DEFAULT_GRAPH,
        provenance: available('a4'),
    },
    {
        id: 'a5',
        kind: 'ObjectPropertyAssertion',
        property: `${EX}ancestorOf`,
        subject: `${EX}bob`,
        object: `${EX}carol`,
        graph: DEFAULT_GRAPH,
        provenance: available('a5'),
    },
]);
const inconsistencyRequest = makeRequest('inconsistency', '6', [
    {
        id: 'a1',
        kind: 'DisjointClasses',
        classes: [named(`${EX}Person`), named(`${EX}Machine`)],
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'ClassAssertion',
        classExpression: named(`${EX}Person`),
        individual: `${EX}alice`,
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
    {
        id: 'a3',
        kind: 'ClassAssertion',
        classExpression: named(`${EX}Machine`),
        individual: `${EX}alice`,
        graph: DEFAULT_GRAPH,
        provenance: available('a3'),
    },
]);
const unsatisfiableRequest = makeRequest('unsatisfiable-classes', '7', [
    {
        id: 'a1',
        kind: 'SubClassOf',
        subClass: named(`${EX}Impossible`),
        superClass: named(`${EX}Person`),
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'SubClassOf',
        subClass: named(`${EX}Impossible`),
        superClass: named(`${EX}Machine`),
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
    {
        id: 'a3',
        kind: 'DisjointClasses',
        classes: [named(`${EX}Person`), named(`${EX}Machine`)],
        graph: DEFAULT_GRAPH,
        provenance: available('a3'),
    },
]);
const unsupportedRequest = makeRequest('unsupported-constructs', '8', [
    { id: 'a1', kind: 'Import', ontology: `${EX}external`, graph: DEFAULT_GRAPH, provenance: available('a1') },
    {
        id: 'a2',
        kind: 'OpaqueAxiom',
        constructIri: 'http://www.w3.org/2002/07/owl#hasKey',
        canonicalForm: 'HasKey(ex:Person ex:id)',
        graph: DEFAULT_GRAPH,
        provenance: { status: 'missing' },
    },
    {
        id: 'a3',
        kind: 'Declaration',
        entityKind: 'Class',
        iri: `${EX}NamedGraphClass`,
        graph: { kind: 'NamedGraph', iri: `${EX}graph` },
        provenance: available('a3'),
    },
]);
const bottomObjectRequest = makeRequest('pur-rdf-bottom-object-property', 'a', [
    {
        id: 'a1',
        kind: 'ObjectPropertyAssertion',
        property: 'http://www.w3.org/2002/07/owl#bottomObjectProperty',
        subject: `${EX}alice`,
        object: `${EX}bob`,
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
]);
const bottomDataRequest = makeRequest('pur-rdf-bottom-data-property', 'b', [
    {
        id: 'a1',
        kind: 'DataPropertyAssertion',
        property: 'http://www.w3.org/2002/07/owl#bottomDataProperty',
        subject: `${EX}alice`,
        value: { kind: 'Literal', lexicalForm: 'forbidden', datatype: XSD_STRING, language: null },
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
]);
const cyclicExpressionRequest = makeRequest('pur-rdf-cyclic-expression', 'c', [
    {
        id: 'a1',
        kind: 'ClassAssertion',
        classExpression: { kind: 'CyclicClassExpression', expressionId: 'cycle:1' },
        individual: `${EX}alice`,
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
]);
const thingNothingRequest = makeRequest('pur-rdf-thing-nothing-empty-domain', 'd', [
    {
        id: 'a1',
        kind: 'EquivalentClasses',
        classes: [named('http://www.w3.org/2002/07/owl#Thing'), named('http://www.w3.org/2002/07/owl#Nothing')],
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
]);
const demoRequest = makeRequest('current-demo-constructs', '9', [
    {
        id: 'a1',
        kind: 'Declaration',
        entityKind: 'Class',
        iri: `${EX}Gap`,
        graph: DEFAULT_GRAPH,
        provenance: available('a1'),
    },
    {
        id: 'a2',
        kind: 'Declaration',
        entityKind: 'Class',
        iri: `${EX}VerifiedAbsence`,
        graph: DEFAULT_GRAPH,
        provenance: available('a2'),
    },
    {
        id: 'a3',
        kind: 'PropertyDomain',
        propertyKind: 'DataProperty',
        property: `${EX}atCommit`,
        domain: { kind: 'ObjectUnionOf', operands: [`${EX}VerifiedAbsence`, `${EX}Gap`] },
        graph: DEFAULT_GRAPH,
        provenance: available('a3'),
    },
    {
        id: 'a4',
        kind: 'DataPropertyAssertion',
        property: `${EX}atCommit`,
        subject: `${EX}gap`,
        value: { kind: 'Literal', lexicalForm: 'abc123', datatype: XSD_STRING, language: null },
        graph: DEFAULT_GRAPH,
        provenance: available('a4'),
    },
    {
        id: 'a5',
        kind: 'AnnotationAssertion',
        property: 'http://www.w3.org/2000/01/rdf-schema#label',
        subject: `${EX}gap`,
        value: { kind: 'Literal', lexicalForm: 'Known gap', datatype: XSD_STRING, language: null },
        graph: DEFAULT_GRAPH,
        provenance: available('a5'),
    },
]);

export const KNOWN_ANSWER_FIXTURES: ReadonlyArray<KnownAnswerFixture> = Object.freeze([
    fixture(
        'subclass-type',
        subclassTypeRequest,
        decided(
            subclassTypeRequest,
            'consistent',
            [assertedType('stmt:a2', 'a2', `${EX}alice`, `${EX}Child`)],
            [inferred('inferred:1', `${EX}alice`, RDF_TYPE, `${EX}Parent`, 'subclass-type', ['a1', 'a2'])],
        ),
    ),
    fixture(
        'domain-range',
        domainRangeRequest,
        decided(
            domainRangeRequest,
            'consistent',
            [],
            [
                inferred('inferred:1', `${EX}alice`, RDF_TYPE, `${EX}Person`, 'object-property-domain', ['a1', 'a3']),
                inferred('inferred:2', `${EX}bob`, RDF_TYPE, `${EX}Person`, 'object-property-range', ['a2', 'a3']),
            ],
        ),
    ),
    fixture(
        'equivalence',
        equivalenceRequest,
        decided(
            equivalenceRequest,
            'consistent',
            [assertedType('stmt:a2', 'a2', `${EX}alice`, `${EX}Writer`)],
            [inferred('inferred:1', `${EX}alice`, RDF_TYPE, `${EX}Author`, 'equivalent-class-type', ['a1', 'a2'])],
        ),
    ),
    fixture(
        'disjointness',
        disjointnessRequest,
        decided(
            disjointnessRequest,
            'consistent',
            [
                assertedType('stmt:a2', 'a2', `${EX}alice`, `${EX}Person`),
                assertedType('stmt:a3', 'a3', `${EX}robot`, `${EX}Machine`),
            ],
            [],
        ),
    ),
    fixture(
        'inverse-transitive-properties',
        inverseTransitiveRequest,
        decided(
            inverseTransitiveRequest,
            'consistent',
            [],
            [
                inferred('inferred:1', `${EX}bob`, `${EX}childOf`, `${EX}alice`, 'inverse-object-property', [
                    'a1',
                    'a3',
                ]),
                inferred('inferred:2', `${EX}alice`, `${EX}ancestorOf`, `${EX}carol`, 'transitive-object-property', [
                    'a2',
                    'a4',
                    'a5',
                ]),
            ],
        ),
    ),
    fixture(
        'inconsistency',
        inconsistencyRequest,
        decided(
            inconsistencyRequest,
            'inconsistent',
            [
                assertedType('stmt:a2', 'a2', `${EX}alice`, `${EX}Person`),
                assertedType('stmt:a3', 'a3', `${EX}alice`, `${EX}Machine`),
            ],
            [],
            [],
            [
                {
                    severity: 'error',
                    code: 'disjoint-class-assertions',
                    message: 'alice is asserted in two disjoint classes',
                    axiomIds: ['a1', 'a2', 'a3'],
                },
            ],
        ),
    ),
    fixture(
        'unsatisfiable-classes',
        unsatisfiableRequest,
        decided(
            unsatisfiableRequest,
            'consistent',
            [],
            [],
            [
                {
                    classIri: `${EX}Impossible`,
                    premiseIds: ['a1', 'a2', 'a3'],
                    justificationDigest: SHA.placeholder,
                },
            ],
        ),
    ),
    fixture('unsupported-constructs', unsupportedRequest, {
        outcome: 'refused',
        completeness: 'incomplete',
        reason: 'unsupported-construct',
        diagnostics: [
            {
                severity: 'error',
                code: 'missing-provenance',
                message: 'Every asserted axiom requires source provenance',
                axiomIds: ['a2'],
            },
            { severity: 'error', code: 'named-graph', message: 'V1 accepts the default graph only', axiomIds: ['a3'] },
            {
                severity: 'error',
                code: 'unsupported-import',
                message: 'Imports must be resolved before invocation',
                axiomIds: ['a1'],
            },
            {
                severity: 'error',
                code: 'unsupported-opaque-axiom',
                message: 'Opaque axioms are outside the V1 allowlist',
                axiomIds: ['a2'],
            },
        ],
    }),
    fixture('pur-rdf-bottom-object-property', bottomObjectRequest, {
        outcome: 'refused',
        completeness: 'incomplete',
        reason: 'bottom-property',
        diagnostics: [
            {
                severity: 'error',
                code: 'bottom-object-property-known-divergence',
                message: 'PurRDF missed this bottom object property inconsistency',
                axiomIds: ['a1'],
            },
        ],
    }),
    fixture('pur-rdf-bottom-data-property', bottomDataRequest, {
        outcome: 'refused',
        completeness: 'incomplete',
        reason: 'bottom-property',
        diagnostics: [
            {
                severity: 'error',
                code: 'bottom-data-property-known-divergence',
                message: 'PurRDF missed this bottom data property inconsistency',
                axiomIds: ['a1'],
            },
        ],
    }),
    fixture('pur-rdf-cyclic-expression', cyclicExpressionRequest, {
        outcome: 'refused',
        completeness: 'incomplete',
        reason: 'cyclic-expression',
        diagnostics: [
            {
                severity: 'error',
                code: 'cyclic-expression-known-divergence',
                message: 'PurRDF withheld a decided result for this cyclic expression',
                axiomIds: ['a1'],
            },
        ],
    }),
    fixture('pur-rdf-thing-nothing-empty-domain', thingNothingRequest, {
        outcome: 'refused',
        completeness: 'incomplete',
        reason: 'known-divergence',
        diagnostics: [
            {
                severity: 'error',
                code: 'thing-nothing-empty-domain-known-divergence',
                message: 'PurRDF wrongly reported this empty-domain ontology satisfiable',
                axiomIds: ['a1'],
            },
        ],
    }),
    fixture('current-demo-constructs', demoRequest, decided(demoRequest, 'consistent', [], [])),
]);

/** A tiny asserted subclass statement used by protocol smoke tests and doctor. */
export const KNOWN_ANSWER_SUBCLASS_STATEMENT = Object.freeze({
    subject: `${EX}Child`,
    predicate: RDFS_SUBCLASS,
    object: `${EX}Parent`,
});
