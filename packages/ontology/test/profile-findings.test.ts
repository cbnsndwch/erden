import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { resolveBundledReasonerArtifact } from '@erden/reasoner-distribution';
import { isUnknownReservedIri } from '@erden/reasoner-protocol';

import {
    assembleOntology,
    decideAssembledOntology,
    isBuiltinDatatype,
    isDecidableDatatypeUsage,
    locateProfileFindings,
    locateStatements,
    normalizeAssembledOntology,
    partitionAssembledOntology,
    quadKey,
    ReasonerNormalizationError,
    type AssembledOntology,
    type OntologyMediaType,
    type OutsideProfilePolicy,
    type ProfilePartitionFinding,
} from '../src/index.js';

import { ROOT_OWNER, memoryResourcePort } from './reasoner-helpers.js';

const REQUIRED_TOOL = resolveBundledReasonerArtifact().requiredTool;
const OPTIONS = Object.freeze({
    isDecidableDatatype: isDecidableDatatypeUsage,
    isBuiltinDatatype,
    isUnknownReservedIri,
});

const PREFIXES = `@prefix ex: <https://example.test/root#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const CLEAN = `${PREFIXES}<https://example.test/root> a owl:Ontology .
ex:Animal a owl:Class .
ex:Dog a owl:Class ; rdfs:subClassOf ex:Animal .
ex:likes a owl:ObjectProperty ; rdfs:domain ex:Animal ; rdfs:range ex:Animal .
ex:age a owl:DatatypeProperty ; rdfs:domain ex:Animal ; rdfs:range xsd:integer .
ex:rex a ex:Dog ; rdfs:label "Rex" ; ex:likes ex:rex .
`;

const MEDIA_TYPES: Readonly<Record<string, OntologyMediaType>> = {
    ttl: 'text/turtle',
    nt: 'application/n-triples',
    rdf: 'application/rdf+xml',
    owl: 'application/rdf+xml',
    jsonld: 'application/ld+json',
};

async function assemble(
    text: string,
    options: { readonly locator?: string; readonly policy?: OutsideProfilePolicy } = {},
): Promise<AssembledOntology> {
    const locator = options.locator ?? 'root.ttl';
    return Effect.runPromise(
        assembleOntology(memoryResourcePort([{ id: 'root', locator, text }]), [
            {
                id: 'root',
                owner: ROOT_OWNER,
                locator,
                baseIri: ROOT_OWNER.canonicalIri,
                mediaType: MEDIA_TYPES[locator.slice(locator.lastIndexOf('.') + 1)] ?? 'text/turtle',
                provenance: { _tag: 'Asserted' },
                ...(options.policy === undefined ? {} : { outsideProfile: options.policy }),
            },
        ]),
    );
}

function refusal(graph: AssembledOntology): ReasonerNormalizationError {
    try {
        normalizeAssembledOntology(graph, REQUIRED_TOOL);
    } catch (error) {
        if (error instanceof ReasonerNormalizationError) {
            return error;
        }
        throw error;
    }
    throw new Error('expected a refusal');
}

function findingsOf(error: ReasonerNormalizationError): ReadonlyArray<ProfilePartitionFinding> {
    return error.details['findings'] as ReadonlyArray<ProfilePartitionFinding>;
}

/**
 * A request's axioms without their identities: an axiom's ID and provenance digest the source's bytes, so two files
 * that differ only in accepted annotations send the same axioms under different IDs.
 */
function semanticAxioms(normalized: ReturnType<typeof normalizeAssembledOntology>): ReadonlyArray<string> {
    return normalized.request.ontology.axioms
        .map(({ id: _id, provenance: _provenance, ...axiom }) => JSON.stringify(axiom))
        .sort();
}

describe('accepted annotations', () => {
    const ANNOTATED = `${CLEAN}<https://example.test/root> owl:versionIRI <https://example.test/root/1.0> ;
    rdfs:seeAlso <https://example.test/about> ;
    dct:title "Root" .
ex:Dog rdfs:seeAlso "https://example.test/dogs" ; dct:source <https://example.test/kennel> .
ex:rex dct:source <https://example.test/kennel> .
`;

    it('sends exactly the request a project without them sends, in both modes, and warns about each undeclared one', async () => {
        const clean = normalizeAssembledOntology(await assemble(CLEAN), REQUIRED_TOOL);
        for (const policy of ['refuse', 'report'] as const) {
            const graph = await assemble(ANNOTATED, { policy });
            const normalized = normalizeAssembledOntology(graph, REQUIRED_TOOL);
            expect(semanticAxioms(normalized)).toEqual(semanticAxioms(clean));
            expect(normalized.request.ontology.axioms).toHaveLength(clean.request.ontology.axioms.length);
            expect(normalized.partition.findings).toEqual([]);
            expect(normalized.partition.excludedKeys.size).toBe(0);
            expect(normalized.partition.acceptedKeys.size).toBe(6);
            expect(
                normalized.partition.undeclaredAnnotationProperties.map((item) => [item.property, item.statementCount]),
            ).toEqual([
                ['http://purl.org/dc/terms/source', 2],
                ['http://purl.org/dc/terms/title', 1],
            ]);
            // Every accepted statement stays in the graph that SHACL, questions and the release see.
            expect(
                [...normalized.partition.acceptedKeys].every((key) =>
                    graph.provenance.some((entry) => entry.key === key),
                ),
            ).toBe(true);
            // The warning names where the first use is written.
            const first = normalized.partition.undeclaredAnnotationProperties[1];
            expect(locateStatements(graph, [{ key: first?.firstKey ?? '' }])).toEqual([
                { locator: 'root.ttl', line: 15, column: 5 },
            ]);
        }
    });

    it('decides the same answer with and without them', async () => {
        const plain = await Effect.runPromise(decideAssembledOntology(await assemble(CLEAN)));
        const annotated = await Effect.runPromise(decideAssembledOntology(await assemble(ANNOTATED)));
        function answer(decision: typeof plain) {
            const result = decision.response.result;
            return {
                consistency: result.consistency,
                inferred: result.inferred.map((item) => [
                    item.subject,
                    item.predicate,
                    item.object,
                    item.provenance.rule,
                ]),
            };
        }
        expect(answer(annotated)).toEqual(answer(plain));
        expect(answer(plain).inferred.length).toBeGreaterThan(0);
    });

    it('keeps a blank-node value, and an axiom about an undeclared predicate, outside the profile', async () => {
        const error = refusal(
            await assemble(`${CLEAN}ex:Dog rdfs:seeAlso [ rdfs:label "a page" ] .
ex:p rdfs:range ex:Animal .
ex:rex ex:p ex:rex .
`),
        );
        expect(findingsOf(error).map((finding) => [finding.group, finding.construct])).toEqual([
            ['unreasoned', 'undeclared-property-axiom'],
            ['annotation', 'rdfs:seeAlso'],
        ]);
    });
});

describe('report mode never aborts on the W1 hard refusals', () => {
    // BFO 2020 publishes union domains whose operands include an intersection with a complement.
    const BFO = `${CLEAN}ex:Process a owl:Class . ex:Thing a owl:Class . ex:Site a owl:Class .
ex:participates a owl:ObjectProperty ;
    rdfs:domain [ a owl:Class ;
        owl:unionOf ( ex:Dog [ a owl:Class ; owl:intersectionOf ( ex:Thing [ a owl:Class ; owl:complementOf ex:Site ] ) ] )
    ] ;
    rdfs:range ex:Process .
`;
    // CL's OWL API output annotates an existential restriction; the axiom names the same blank node again.
    const CL = `${CLEAN}ex:Puppy a owl:Class ; rdfs:subClassOf ex:Dog , _:r .
_:r a owl:Restriction ; owl:onProperty ex:likes ; owl:someValuesFrom ex:Animal .
[] a owl:Axiom ; owl:annotatedSource ex:Puppy ; owl:annotatedProperty rdfs:subClassOf ; owl:annotatedTarget _:r ;
    rdfs:comment "from the literature" .
ex:bo a ex:Puppy .
`;

    it('lists a union domain with an anonymous operand as an ObjectUnionOf finding and reasons over the rest', async () => {
        const graph = await assemble(BFO, { policy: 'report' });
        const decision = await Effect.runPromise(decideAssembledOntology(graph));
        expect(decision.response.result.outcome).toBe('decided');
        expect(decision.normalization.partition.findings).toEqual([
            expect.objectContaining({
                group: 'unreasoned',
                construct: 'class-expression',
                owlConstruct: 'ObjectUnionOf',
                subject: 'https://example.test/root#participates',
                description:
                    'ObjectPropertyDomain(<https://example.test/root#participates> ObjectUnionOf(<https://example.test/root#Dog> ObjectIntersectionOf(<https://example.test/root#Thing> ObjectComplementOf(<https://example.test/root#Site>))))',
            }),
        ]);
        const refused = refusal(await assemble(BFO));
        expect(refused.code).toBe('OUTSIDE_PROFILE');
        expect(refused.details['locations']).toEqual([{ locator: 'root.ttl', line: 15, column: 5 }]);
    });

    it('reasons over an annotated existential and lists its axiom annotation as a finding', async () => {
        const graph = await assemble(CL, { policy: 'report' });
        const decision = await Effect.runPromise(decideAssembledOntology(graph));
        expect(decision.response.result.outcome).toBe('decided');
        const findings = decision.normalization.partition.findings;
        expect(findings.map((finding) => [finding.group, finding.construct, finding.owlConstruct])).toEqual([
            ['annotation', 'owl:Axiom', 'AxiomAnnotation'],
        ]);
        expect(findings[0]?.description).toBe(
            'AxiomAnnotation on SubClassOf(<https://example.test/root#Puppy> ObjectSomeValuesFrom(<https://example.test/root#likes> <https://example.test/root#Animal>)) with rdfs:comment',
        );
        expect(locateProfileFindings(graph, findings)).toEqual([{ locator: 'root.ttl', line: 15, column: 6 }]);
        const refused = refusal(await assemble(CL));
        expect(refused.code).toBe('OUTSIDE_PROFILE');
        expect(findingsOf(refused)).toHaveLength(1);
    });
});

describe('finding explanations', () => {
    it.each([
        [
            'owl:hasValue',
            '[ a owl:Restriction ; owl:onProperty ex:likes ; owl:hasValue ex:rex ]',
            'ObjectHasValue',
            'ObjectHasValue(<https://example.test/root#likes> <https://example.test/root#rex>)',
        ],
        [
            'owl:hasSelf',
            '[ a owl:Restriction ; owl:onProperty ex:likes ; owl:hasSelf true ]',
            'ObjectHasSelf',
            'ObjectHasSelf(<https://example.test/root#likes>)',
        ],
        [
            'an unqualified minimum',
            '[ a owl:Restriction ; owl:onProperty ex:likes ; owl:minCardinality 1 ]',
            'ObjectMinCardinality',
            'ObjectMinCardinality(1 <https://example.test/root#likes>)',
        ],
        [
            'a qualified maximum',
            '[ a owl:Restriction ; owl:onProperty ex:likes ; owl:maxQualifiedCardinality 2 ; owl:onClass ex:Dog ]',
            'ObjectMaxCardinality',
            'ObjectMaxCardinality(2 <https://example.test/root#likes> <https://example.test/root#Dog>)',
        ],
        [
            'an exact cardinality',
            '[ a owl:Restriction ; owl:onProperty ex:likes ; owl:cardinality 3 ]',
            'ObjectExactCardinality',
            'ObjectExactCardinality(3 <https://example.test/root#likes>)',
        ],
        [
            'a data restriction',
            '[ a owl:Restriction ; owl:onProperty ex:age ; owl:someValuesFrom xsd:integer ]',
            'DataSomeValuesFrom',
            'DataSomeValuesFrom(<https://example.test/root#age> xsd:integer)',
        ],
        [
            'a qualified data cardinality',
            '[ a owl:Restriction ; owl:onProperty ex:age ; owl:qualifiedCardinality 1 ; owl:onDataRange xsd:integer ]',
            'DataExactCardinality',
            'DataExactCardinality(1 <https://example.test/root#age> xsd:integer)',
        ],
        [
            'an enumeration',
            '[ a owl:Class ; owl:oneOf ( ex:rex ) ]',
            'ObjectOneOf',
            'ObjectOneOf(<https://example.test/root#rex>)',
        ],
        // ObjectSomeValuesFrom, ObjectAllValuesFrom and ObjectIntersectionOf are reasoned in this position under
        // profile V2: see the reasoner-normalize tests.
    ] as const)('names %s by its OWL 2 construct', async (_label, expression, owlConstruct, rendered) => {
        const graph = await assemble(`${CLEAN}ex:Puppy a owl:Class ; rdfs:subClassOf ${expression} .\n`);
        const [finding] = partitionAssembledOntology(graph, OPTIONS).findings;
        expect(finding).toMatchObject({
            owlConstruct,
            description: `SubClassOf(<https://example.test/root#Puppy> ${rendered})`,
        });
    });

    it('describes anonymous axioms by their content, not as (anonymous)', async () => {
        const graph = await assemble(`${CLEAN}[] a owl:AllDifferent ; owl:members ( ex:rex ex:pack ) .
[] a owl:Restriction ; owl:onProperty ex:likes ; owl:allValuesFrom ex:Dog ; rdfs:subClassOf ex:Animal .
ex:likes a owl:AsymmetricProperty .
ex:adores owl:propertyDisjointWith ex:likes ; a owl:ObjectProperty .
`);
        const findings = partitionAssembledOntology(graph, OPTIONS).findings;
        expect(findings.map((finding) => [finding.subject, finding.owlConstruct, finding.description])).toEqual(
            expect.arrayContaining([
                [
                    null,
                    'DifferentIndividuals',
                    'DifferentIndividuals(<https://example.test/root#rex> <https://example.test/root#pack>)',
                ],
                [
                    null,
                    'ObjectAllValuesFrom',
                    'general class axiom SubClassOf(ObjectAllValuesFrom(<https://example.test/root#likes> <https://example.test/root#Dog>) <https://example.test/root#Animal>)',
                ],
                [
                    'https://example.test/root#likes',
                    'AsymmetricObjectProperty',
                    'AsymmetricObjectProperty(<https://example.test/root#likes>)',
                ],
                [
                    'https://example.test/root#adores',
                    'DisjointObjectProperties',
                    'DisjointObjectProperties(<https://example.test/root#adores> <https://example.test/root#likes>)',
                ],
            ]),
        );
    });
});

describe('finding locations', () => {
    // A restriction outside profile V2 (an existential is reasoned).
    const EXISTENTIAL = '[ a owl:Restriction ; owl:onProperty ex:likes ; owl:minCardinality 2 ]';

    it('locates Turtle findings at the statement, past indentation and on continued lines', async () => {
        const graph = await assemble(`${CLEAN}ex:Puppy a owl:Class ;
        rdfs:subClassOf ${EXISTENTIAL} ;
    rdfs:seeAlso [ rdfs:label "x" ] .
`);
        const findings = partitionAssembledOntology(graph, OPTIONS).findings;
        const located = locateProfileFindings(graph, findings);
        expect(findings.map((finding, index) => [finding.construct, located[index]])).toEqual(
            expect.arrayContaining([
                ['owl:Restriction', { locator: 'root.ttl', line: 14, column: 9 }],
                ['rdfs:seeAlso', { locator: 'root.ttl', line: 15, column: 5 }],
            ]),
        );
    });

    it('locates N-Triples findings at their line', async () => {
        const graph = await assemble(
            [
                '<https://example.test/root#A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .',
                '<https://example.test/root#p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#SymmetricProperty> .',
                '',
            ].join('\n'),
            { locator: 'root.nt' },
        );
        const findings = partitionAssembledOntology(graph, OPTIONS).findings;
        expect(findings.map((finding) => finding.construct)).toEqual(['owl:SymmetricProperty']);
        expect(locateProfileFindings(graph, findings)).toEqual([{ locator: 'root.nt', line: 2, column: 31 }]);
    });

    it('locates RDF/XML findings at the property element, and anonymous ones at their element', async () => {
        const graph = await assemble(
            `<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [
    <!ENTITY ex "https://example.test/root#">
]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
         xmlns:owl="http://www.w3.org/2002/07/owl#">
    <owl:Class rdf:about="&ex;Animal"/>
    <owl:ObjectProperty rdf:about="&ex;likes"/>
    <owl:Class rdf:about="&ex;Dog">
        <rdfs:subClassOf rdf:resource="&ex;Animal"/>
        <rdfs:subClassOf rdf:nodeID="r1"/>
    </owl:Class>
    <owl:Restriction rdf:nodeID="r1">
        <owl:onProperty rdf:resource="&ex;likes"/>
        <owl:minCardinality rdf:datatype="http://www.w3.org/2001/XMLSchema#nonNegativeInteger">2</owl:minCardinality>
    </owl:Restriction>
    <owl:Axiom>
        <owl:annotatedSource rdf:resource="&ex;Dog"/>
        <owl:annotatedProperty rdf:resource="http://www.w3.org/2000/01/rdf-schema#subClassOf"/>
        <owl:annotatedTarget rdf:nodeID="r1"/>
        <rdfs:comment>why</rdfs:comment>
    </owl:Axiom>
    <owl:AllDifferent>
        <owl:members rdf:parseType="Collection">
            <rdf:Description rdf:about="&ex;rex"/>
            <rdf:Description rdf:about="&ex;pack"/>
        </owl:members>
    </owl:AllDifferent>
</rdf:RDF>
`,
            { locator: 'root.owl' },
        );
        const findings = partitionAssembledOntology(graph, OPTIONS).findings;
        const located = locateProfileFindings(graph, findings);
        expect(
            findings.map((finding, index) => [finding.owlConstruct, located[index]?.line, located[index]?.column]),
        ).toEqual(
            expect.arrayContaining([
                ['ObjectMinCardinality', 12, 9],
                ['AxiomAnnotation', 18, 5],
                ['DifferentIndividuals', 24, 5],
            ]),
        );
    });

    it('locates RDF/XML findings about a relative rdf:about at their property element, as SKOS writes them', async () => {
        const graph = await assemble(
            `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
         xmlns:owl="http://www.w3.org/2002/07/owl#"
         xml:base="https://example.test/root">
  <rdf:Description rdf:about="#likes">
    <rdfs:label>likes</rdfs:label>
    <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#ObjectProperty"/>
    <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#AsymmetricProperty"/>
  </rdf:Description>
</rdf:RDF>
`,
            { locator: 'root.rdf' },
        );
        const findings = partitionAssembledOntology(graph, OPTIONS).findings;
        expect(findings.map((finding) => finding.owlConstruct)).toEqual(['AsymmetricObjectProperty']);
        expect(locateProfileFindings(graph, findings)).toEqual([{ locator: 'root.rdf', line: 9, column: 5 }]);
    });

    it('locates JSON-LD findings at their node object', async () => {
        const graph = await assemble(
            JSON.stringify(
                {
                    '@context': { owl: 'http://www.w3.org/2002/07/owl#', ex: 'https://example.test/root#' },
                    '@graph': [
                        { '@id': 'ex:Animal', '@type': 'owl:Class' },
                        { '@id': 'ex:likes', '@type': ['owl:ObjectProperty', 'owl:AsymmetricProperty'] },
                    ],
                },
                null,
                2,
            ),
            { locator: 'root.jsonld' },
        );
        const findings = partitionAssembledOntology(graph, OPTIONS).findings;
        expect(findings.map((finding) => finding.construct)).toEqual(['owl:AsymmetricProperty']);
        expect(locateProfileFindings(graph, findings)).toEqual([{ locator: 'root.jsonld', line: 11, column: 5 }]);
    });

    it('locates a statement the source does not assert as unknown', async () => {
        const graph = await assemble(CLEAN);
        expect(locateStatements(graph, [{ key: 'not a key' }])).toEqual([null]);
        const key = quadKey(graph.provenance[0]?.quad as never);
        expect(locateStatements(graph, [{ key }])[0]).toMatchObject({ locator: 'root.ttl' });
    });
});
