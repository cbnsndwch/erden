import { createHash } from 'node:crypto';

import { Effect } from 'effect';
import { Store } from 'n3';
import { describe, expect, it } from 'vitest';

import { resolveBundledReasonerArtifact } from '@erden/reasoner-distribution';
import { getReasonerProfileRefusals } from '@erden/reasoner-protocol';

import {
    ReasonerNormalizationError,
    TurtleSourceParseError,
    TurtleSourceEncodingError,
    assembleOntology,
    normalizeAssembledOntology,
    type AssembledOntology,
} from '../src/index.js';

import {
    DEPENDENCY_OWNER,
    ROOT_OWNER,
    assembleFixtures,
    memoryResourcePort,
    sourceDescriptor,
    type SourceFixture,
} from './reasoner-helpers.js';

const PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix dep: <https://example.test/dependency#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const artifact = resolveBundledReasonerArtifact();
async function normalize(text: string, locator = 'root.ttl') {
    const graph = await assembleFixtures([{ id: 'source:root', locator, text }]);
    return normalizeAssembledOntology(graph, artifact.requiredTool);
}

async function expectNormalizationCode(text: string, code: ReasonerNormalizationError['code']) {
    const graph = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text }]);
    expect(() => normalizeAssembledOntology(graph, artifact.requiredTool)).toThrow(expect.objectContaining({ code }));
}

/** A refuse-mode project outside the profile fails before reasoning, listing every finding by construct. */
async function expectOutsideProfile(text: string, constructs: ReadonlyArray<string>) {
    const graph = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text }]);
    let thrown: unknown;
    try {
        normalizeAssembledOntology(graph, artifact.requiredTool);
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReasonerNormalizationError);
    const error = thrown as ReasonerNormalizationError;
    expect(error.code).toBe('OUTSIDE_PROFILE');
    const findings = (
        error.details as { findings: ReadonlyArray<{ construct: string; locators: ReadonlyArray<string> }> }
    ).findings;
    expect(findings.map((finding) => finding.construct).sort()).toEqual([...constructs].sort());
    expect(findings.every((finding) => finding.locators.includes('root.ttl'))).toBe(true);
}

describe('RDF to qualified reasoner normalization', () => {
    it('maps every construct in the closed V1 axiom allowlist without a second wire model', async () => {
        const normalized = await normalize(`${PREFIXES}
ex:ontology a owl:Ontology .
ex:A a owl:Class .
ex:B a rdfs:Class .
ex:C a owl:Class .
ex:D a owl:Class .
ex:Code a rdfs:Datatype .
ex:p a owl:ObjectProperty, owl:TransitiveProperty ; rdfs:domain ex:A ; rdfs:range ex:B .
ex:q a owl:ObjectProperty .
ex:p owl:inverseOf ex:q .
ex:data a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf (ex:A ex:B) ] ; rdfs:range xsd:string .
ex:annotation a owl:AnnotationProperty ; rdfs:domain ex:A ; rdfs:range rdfs:Literal .
ex:A rdfs:subClassOf ex:B ; owl:equivalentClass ex:C ; owl:disjointWith ex:D .
ex:alice a owl:NamedIndividual, ex:A ;
  ex:p ex:bob ;
  ex:data "42"^^xsd:integer ;
  ex:annotation ex:target ;
  rdfs:label "Alice"@en .
`);
        expect(normalized.request.limits).toEqual({
            maxInputAxioms: 100_000,
            maxInferences: 100_000,
            maxWallTimeMs: 30_000,
        });
        const kinds = normalized.request.ontology.axioms.map((axiom) => axiom.kind);
        for (const kind of [
            'Declaration',
            'SubClassOf',
            'ClassAssertion',
            'PropertyDomain',
            'PropertyRange',
            'EquivalentClasses',
            'DisjointClasses',
            'InverseObjectProperties',
            'TransitiveObjectProperty',
            'ObjectPropertyAssertion',
            'DataPropertyAssertion',
            'AnnotationAssertion',
        ]) {
            expect(kinds).toContain(kind);
        }
        const union = normalized.request.ontology.axioms.find(
            (axiom) => axiom.kind === 'PropertyDomain' && axiom.domain.kind === 'ObjectUnionOf',
        );
        expect(union).toMatchObject({
            kind: 'PropertyDomain',
            propertyKind: 'DataProperty',
            domain: {
                kind: 'ObjectUnionOf',
                operands: ['https://example.test/root#A', 'https://example.test/root#B'],
            },
        });
        const data = normalized.request.ontology.axioms.find((axiom) => axiom.kind === 'DataPropertyAssertion');
        expect(data).toMatchObject({
            value: {
                lexicalForm: '42',
                datatype: 'http://www.w3.org/2001/XMLSchema#integer',
                language: null,
            },
        });
        const label = normalized.request.ontology.axioms.find(
            (axiom) => axiom.kind === 'AnnotationAssertion' && axiom.property.endsWith('#label'),
        );
        expect(label).toMatchObject({ value: { lexicalForm: 'Alice', language: 'en' } });
        expect(getReasonerProfileRefusals(normalized.request)).toEqual([]);
        expect(normalized.wire.endsWith('\n')).toBe(true);
    });

    it('uses explicit declarations and narrow builtins as the only property-kind authority', async () => {
        // An undeclared predicate's assertions are accepted as annotations; an axiom about it is not.
        await expectOutsideProfile(
            `${PREFIXES}
ex:p rdfs:range xsd:string .
ex:s ex:p "value" .
`,
            ['undeclared-property-axiom'],
        );
        await expectOutsideProfile(
            `${PREFIXES}
ex:p rdfs:range ex:A .
ex:s ex:p ex:o .
`,
            ['undeclared-property-axiom'],
        );
        await expectNormalizationCode(
            `${PREFIXES}
ex:p a owl:ObjectProperty, owl:DatatypeProperty .
`,
            'AMBIGUOUS_PROPERTY_KIND',
        );

        const builtin = await normalize(`${PREFIXES}
ex:s rdfs:label "label" ; rdfs:comment "comment" .
`);
        expect(builtin.request.ontology.axioms.every((axiom) => axiom.kind === 'AnnotationAssertion')).toBe(true);
    });

    it('supports rdfs:Class declarations and lists generic rdf:Property outside the profile', async () => {
        const normalized = await normalize(`${PREFIXES}
ex:A a rdfs:Class .
`);
        expect(normalized.request.ontology.axioms).toEqual([
            expect.objectContaining({
                kind: 'Declaration',
                entityKind: 'Class',
                iri: 'https://example.test/root#A',
            }),
        ]);
        await expectOutsideProfile(
            `${PREFIXES}
ex:A a rdfs:Class .
ex:p a rdf:Property .
`,
            ['plain-rdf-property'],
        );
    });

    it.each([
        ['disjoint property', 'ex:p owl:propertyDisjointWith ex:q .', 'owl:propertyDisjointWith'],
        ['same individual', 'ex:a owl:sameAs ex:b .', 'owl:sameAs'],
        ['different individual', 'ex:a owl:differentFrom ex:b .', 'owl:differentFrom'],
        ['asymmetric property', 'ex:p a owl:AsymmetricProperty .', 'owl:AsymmetricProperty'],
        ['reflexive property', 'ex:p a owl:ReflexiveProperty .', 'owl:ReflexiveProperty'],
        ['irreflexive property', 'ex:p a owl:IrreflexiveProperty .', 'owl:IrreflexiveProperty'],
    ])('refuses unsupported %s before reasoning, by construct', async (_label, statement, construct) => {
        await expectOutsideProfile(
            `${PREFIXES}
ex:p a owl:ObjectProperty .
ex:q a owl:ObjectProperty .
${statement}
`,
            [construct],
        );
    });

    it.each([
        ['object subproperty', 'ex:p rdfs:subPropertyOf ex:q .', 'SubObjectPropertyOf'],
        ['equivalent property', 'ex:p owl:equivalentProperty ex:q .', 'EquivalentObjectProperties'],
        ['symmetric property', 'ex:p a owl:SymmetricProperty .', 'SymmetricObjectProperty'],
        ['functional property', 'ex:p a owl:FunctionalProperty .', 'FunctionalObjectProperty'],
        ['inverse-functional property', 'ex:p a owl:InverseFunctionalProperty .', 'InverseFunctionalObjectProperty'],
        ['property chain', 'ex:p owl:propertyChainAxiom ( ex:q ex:q ) .', 'SubObjectPropertyOf'],
    ])('maps the profile V2 %s', async (_label, statement, kind) => {
        const normalized = await normalize(`${PREFIXES}
ex:p a owl:ObjectProperty .
ex:q a owl:ObjectProperty .
${statement}
`);
        expect(normalized.request.ontology.axioms.map((axiom) => axiom.kind)).toContain(kind);
    });

    it('maps profile V2 class expressions, general class axioms and data property axioms', async () => {
        const normalized = await normalize(`${PREFIXES}
ex:A a owl:Class .
ex:B a owl:Class .
ex:C a owl:Class .
ex:p a owl:ObjectProperty .
ex:d a owl:DatatypeProperty, owl:FunctionalProperty .
ex:e a owl:DatatypeProperty ; rdfs:subPropertyOf ex:d .
ex:A rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:someValuesFrom ex:B ] .
ex:B rdfs:subClassOf [ a owl:Restriction ; owl:onProperty [ owl:inverseOf ex:p ] ; owl:allValuesFrom ex:C ] .
[ owl:intersectionOf ( ex:A ex:B ) ] rdfs:subClassOf ex:C .
[ owl:unionOf ( ex:A ex:B ) ] rdfs:subClassOf ex:C .
[] a owl:AllDisjointClasses ; owl:members ( ex:A ex:B ex:C ) .
ex:C rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
ex:x a [ owl:complementOf ex:C ] .
`);
        const axioms = normalized.request.ontology.axioms;
        function named(local: string) {
            return { kind: 'NamedClass', iri: `https://example.test/root#${local}` };
        }
        expect(axioms.map((axiom) => axiom.kind)).toEqual(
            expect.arrayContaining([
                'SubClassOf',
                'DisjointClasses',
                'ClassAssertion',
                'FunctionalDataProperty',
                'SubDataPropertyOf',
            ]),
        );
        expect(axioms).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'SubClassOf',
                    subClass: named('A'),
                    superClass: {
                        kind: 'ObjectSomeValuesFrom',
                        property: 'https://example.test/root#p',
                        filler: named('B'),
                    },
                }),
                expect.objectContaining({
                    kind: 'SubClassOf',
                    subClass: {
                        kind: 'ObjectUnionOf',
                        operands: ['https://example.test/root#A', 'https://example.test/root#B'],
                    },
                    superClass: named('C'),
                }),
                expect.objectContaining({
                    kind: 'DisjointClasses',
                    classes: [named('A'), named('B'), named('C')],
                }),
            ]),
        );
        expect(getReasonerProfileRefusals(normalized.request)).toEqual([]);
    });

    it('refuses imports in refuse mode and keeps the qualification divergence cases for the pinned profile', async () => {
        await expectOutsideProfile(`${PREFIXES} ex:ontology owl:imports <https://example.test/other> .`, [
            'owl:imports',
        ]);

        const bottomObject = await normalize(`${PREFIXES} ex:s owl:bottomObjectProperty ex:o .`);
        expect(bottomObject.request.ontology.axioms[0]).toMatchObject({ kind: 'ObjectPropertyAssertion' });
        expect(getReasonerProfileRefusals(bottomObject.request)).toContain('known-divergence');

        const bottomData = await normalize(`${PREFIXES} ex:s owl:bottomDataProperty "x" .`);
        expect(bottomData.request.ontology.axioms[0]).toMatchObject({ kind: 'DataPropertyAssertion' });
        expect(getReasonerProfileRefusals(bottomData.request)).toContain('known-divergence');

        const thingNothing = await normalize(`${PREFIXES} owl:Thing owl:equivalentClass owl:Nothing .`);
        expect(thingNothing.request.ontology.axioms[0]).toMatchObject({ kind: 'EquivalentClasses' });
        expect(getReasonerProfileRefusals(thingNothing.request)).toContain('known-divergence');
    });

    it('uses the protocol UTF-16 order for astral and BMP-private-use union operands', async () => {
        const normalized = await normalize(`${PREFIXES}
ex:p a owl:DatatypeProperty ;
  rdfs:domain [ owl:unionOf (<https://example.test/😀> <https://example.test/\uE000>) ] .
`);
        const domain = normalized.request.ontology.axioms.find((axiom) => axiom.kind === 'PropertyDomain');
        expect(domain).toMatchObject({
            domain: {
                kind: 'ObjectUnionOf',
                operands: ['https://example.test/😀', 'https://example.test/\uE000'],
            },
        });
    });

    it.each([
        [
            'missing rest',
            '_:e owl:unionOf _:l . _:l rdf:first ex:A . ex:p a owl:DatatypeProperty ; rdfs:domain _:e .',
            'MALFORMED_RDF_LIST',
        ],
        [
            'cycle',
            '_:e owl:unionOf _:l . _:l rdf:first ex:A ; rdf:rest _:l . ex:p a owl:DatatypeProperty ; rdfs:domain _:e .',
            'CYCLIC_RDF_LIST',
        ],
        [
            'duplicate operand',
            'ex:p a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf (ex:A ex:A) ] .',
            'MALFORMED_RDF_LIST',
        ],
        ['singleton', 'ex:p a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf (ex:A) ] .', 'MALFORMED_RDF_LIST'],
        [
            'extraneous blank structure',
            '_:e owl:unionOf (ex:A ex:B) ; ex:extra ex:value . ex:p a owl:DatatypeProperty ; rdfs:domain _:e .',
            'UNREPRESENTABLE_RDF_TERM',
        ],
    ] as const)('fails closed for %s', async (_label, body, code) => {
        await expectNormalizationCode(`${PREFIXES} ${body}`, code);
    });

    it.each([
        // A union with an anonymous operand is valid OWL outside V1, as BFO's union domains are.
        [
            'a union domain with an anonymous operand',
            '_:inner owl:unionOf (ex:A ex:B) . ex:p a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf (_:inner ex:C) ] .',
            'class-expression',
        ],
        ['orphan list', '_:l rdf:first ex:A ; rdf:rest rdf:nil .', 'anonymous-node'],
        // A union is reasoned as a subclass under profile V2, not as a superclass.
        ['union as a superclass', '_:e owl:unionOf (ex:A ex:B) . ex:C rdfs:subClassOf _:e .', 'class-expression'],
        [
            'a minimum cardinality',
            'ex:p a owl:ObjectProperty . ex:C rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:minCardinality 2 ] .',
            'owl:Restriction',
        ],
        ['ordinary blank individual', '[] a ex:A .', 'anonymous-individual'],
    ] as const)('lists %s outside the profile', async (_label, body, construct) => {
        await expectOutsideProfile(`${PREFIXES} ${body}`, [construct]);
    });

    it('rejects shared anonymous expressions and shared RDF list tails', async () => {
        await expectNormalizationCode(
            `${PREFIXES}
_:e owl:unionOf (ex:A ex:B) .
ex:p a owl:DatatypeProperty ; rdfs:domain _:e .
ex:q a owl:DatatypeProperty ; rdfs:domain _:e .
`,
            'MALFORMED_RDF_LIST',
        );
        await expectNormalizationCode(
            `${PREFIXES}
_:e1 owl:unionOf _:l1 . _:e2 owl:unionOf _:l2 .
_:l1 rdf:first ex:A ; rdf:rest _:tail .
_:l2 rdf:first ex:B ; rdf:rest _:tail .
_:tail rdf:first ex:C ; rdf:rest rdf:nil .
ex:p a owl:DatatypeProperty ; rdfs:domain _:e1 .
ex:q a owl:DatatypeProperty ; rdfs:domain _:e2 .
`,
            'MALFORMED_RDF_LIST',
        );
    });

    it.each([
        [
            'named list head',
            'ex:p a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf ex:list ] . ex:list rdf:first ex:A ; rdf:rest rdf:nil .',
            'MALFORMED_RDF_LIST',
        ],
        [
            'expression reused as its own list head',
            'ex:p a owl:DatatypeProperty ; rdfs:domain _:e . _:e owl:unionOf _:e ; rdf:first ex:A ; rdf:rest rdf:nil .',
            'MALFORMED_RDF_LIST',
        ],
        [
            'list cell reused as another expression',
            'ex:p a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf _:cell ] . _:cell rdf:first ex:A ; rdf:rest rdf:nil ; owl:unionOf (ex:B ex:C) .',
            'MALFORMED_RDF_LIST',
        ],
        [
            'extra incoming list reference',
            'ex:a a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf _:cell ] . _:cell rdf:first ex:A ; rdf:rest _:tail . _:tail rdf:first ex:B ; rdf:rest rdf:nil . ex:z rdfs:label _:cell .',
            'MALFORMED_RDF_LIST',
        ],
        [
            'extra outgoing list structure',
            'ex:p a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf _:cell ] . _:cell rdf:first ex:A ; rdf:rest _:tail ; rdfs:label "cell" . _:tail rdf:first ex:B ; rdf:rest rdf:nil .',
            'UNREPRESENTABLE_RDF_TERM',
        ],
    ] as const)('rejects unowned or cross-role union plumbing: %s', async (_label, body, code) => {
        await expectNormalizationCode(`${PREFIXES} ${body}`, code);
    });

    it.each([
        ['owl:Thing as object property', 'owl:Thing a owl:ObjectProperty . ex:s owl:Thing ex:o .'],
        ['owl:Class as object property', 'owl:Class a owl:ObjectProperty .'],
        ['rdfs:domain as object property', 'rdfs:domain a owl:ObjectProperty .'],
        ['owl:Thing in individual role', 'owl:Thing a ex:A .'],
    ])('rejects reserved vocabulary in the wrong semantic role: %s', async (_label, body) => {
        await expectNormalizationCode(`${PREFIXES} ${body}`, 'RESERVED_TERM_ROLE');
    });

    it('rejects bottom-property declarations in a conflicting property role', async () => {
        await expectNormalizationCode(
            `${PREFIXES} owl:bottomObjectProperty a owl:DatatypeProperty .`,
            'AMBIGUOUS_PROPERTY_KIND',
        );
        await expectNormalizationCode(
            `${PREFIXES} owl:bottomDataProperty a owl:ObjectProperty .`,
            'AMBIGUOUS_PROPERTY_KIND',
        );
    });

    it('validates literal datatype roles against an explicit built-in set', async () => {
        await expectNormalizationCode(
            `${PREFIXES}
ex:data a owl:DatatypeProperty .
ex:s ex:data "x"^^owl:Class .
`,
            'RESERVED_TERM_ROLE',
        );
        await expectNormalizationCode(
            `${PREFIXES}
ex:data a owl:DatatypeProperty .
ex:s ex:data "x"^^xsd:MadeUp .
`,
            'RESERVED_TERM_ROLE',
        );
        await expect(
            assembleFixtures([
                {
                    id: 'source:root',
                    locator: 'root.ttl',
                    text: `${PREFIXES}
ex:data a owl:DatatypeProperty .
ex:s ex:data "x"^^rdf:langString .
`,
                },
            ]),
        ).rejects.toBeInstanceOf(TurtleSourceParseError);
        const accepted = await normalize(`${PREFIXES}
ex:data a owl:DatatypeProperty .
ex:s ex:data "42"^^xsd:integer .
`);
        expect(accepted.request.ontology.axioms.some((axiom) => axiom.kind === 'DataPropertyAssertion')).toBe(true);
    });

    it('lists reserved vocabulary in a class position outside the profile', async () => {
        await expectOutsideProfile(`${PREFIXES} ex:A rdfs:subClassOf owl:ObjectProperty .`, ['reserved-term-role']);
        await expectOutsideProfile(
            `${PREFIXES}
ex:annotation a owl:AnnotationProperty ; rdfs:range rdf:type .
`,
            ['reserved-term-role'],
        );
        await expectOutsideProfile(`${PREFIXES} ex:p a owl:ObjectProperty ; rdfs:range rdf:List .`, [
            'reserved-term-role',
        ]);
        const literal = await normalize(`${PREFIXES} ex:note a owl:AnnotationProperty ; rdfs:range rdfs:Literal .`);
        expect(literal.request.ontology.axioms.some((axiom) => axiom.kind === 'PropertyRange')).toBe(true);
    });

    it('rejects reserved vocabulary as a source ontology identity', async () => {
        const owner = Object.freeze({
            canonicalIri: 'http://www.w3.org/2002/07/owl#Thing',
            role: 'root' as const,
            ownedIriPrefixes: Object.freeze(['https://example.test/root#']),
        });
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                owner,
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
        ]);
        expect(() => normalizeAssembledOntology(graph, artifact.requiredTool)).toThrow(
            expect.objectContaining({
                code: 'RESERVED_TERM_ROLE',
            }),
        );
    });

    it('requires exactly one distinct root project owner across any number of root source documents', async () => {
        const dependencyOnly = await assembleFixtures([
            {
                id: 'source:dependency',
                locator: 'dependency.ttl',
                owner: DEPENDENCY_OWNER,
                text: `${PREFIXES} dep:A a owl:Class .`,
            },
        ]);
        expect(() => normalizeAssembledOntology(dependencyOnly, artifact.requiredTool)).toThrow(
            expect.objectContaining({
                code: 'INVALID_ASSEMBLED_ONTOLOGY',
            }),
        );

        const otherRoot = Object.freeze({
            canonicalIri: 'https://example.test/other-root',
            role: 'root' as const,
            ownedIriPrefixes: Object.freeze(['https://example.test/other-root#']),
        });
        const multipleRoots = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
            {
                id: 'source:other-root',
                locator: 'other-root.ttl',
                owner: otherRoot,
                text: `${PREFIXES} <https://example.test/other-root#B> a owl:Class .`,
            },
        ]);
        expect(() => normalizeAssembledOntology(multipleRoots, artifact.requiredTool)).toThrow(
            expect.objectContaining({
                code: 'INVALID_ASSEMBLED_ONTOLOGY',
            }),
        );

        const repeatedRoot = await assembleFixtures([
            {
                id: 'source:root-a',
                locator: 'root-a.ttl',
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
            {
                id: 'source:root-b',
                locator: 'root-b.ttl',
                text: `${PREFIXES} ex:B a owl:Class .`,
            },
        ]);
        expect(() => normalizeAssembledOntology(repeatedRoot, artifact.requiredTool)).not.toThrow();
    });

    it('is byte-for-byte deterministic across source order, quad insertion order, locators, and CWD-shaped paths', async () => {
        const rootText = `${PREFIXES} ex:A a owl:Class . ex:alice a ex:A .`;
        const dependencyText = `${PREFIXES} dep:A a owl:Class . ex:A rdfs:subClassOf dep:A .`;
        const leftFixtures: SourceFixture[] = [
            { id: 'source:root', locator: 'C:\\one\\root.ttl', text: rootText, owner: ROOT_OWNER },
            {
                id: 'source:dependency',
                locator: 'C:\\one\\dependency.ttl',
                text: dependencyText,
                owner: DEPENDENCY_OWNER,
            },
        ];
        const rightFixtures: SourceFixture[] = [
            {
                id: 'source:dependency',
                locator: '/another/cwd/dependency.ttl',
                text: dependencyText,
                owner: DEPENDENCY_OWNER,
            },
            { id: 'source:root', locator: '/another/cwd/root.ttl', text: rootText, owner: ROOT_OWNER },
        ];
        const left = normalizeAssembledOntology(await assembleFixtures(leftFixtures), artifact.requiredTool);
        const right = normalizeAssembledOntology(await assembleFixtures(rightFixtures), artifact.requiredTool);
        expect(left.wire).toBe(right.wire);
        expect(left.wire).not.toContain('C:\\one');
        expect(left.wire).not.toContain('/another/cwd');
        expect(left.request.ontology.sources.map((source) => source.id)).toEqual(['source:dependency', 'source:root']);
    });

    it('binds exact source bytes and rejects replacement-decoded input', async () => {
        const bytes = Buffer.from(`${PREFIXES.replaceAll('\n', '\r\n')}ex:A a owl:Class .\r\n`, 'utf8');
        const fixture = { id: 'source:root', locator: 'exact.ttl', bytes };
        const graph = await assembleFixtures([fixture]);
        const normalized = normalizeAssembledOntology(graph, artifact.requiredTool);
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        expect(graph.sources[0]?.contentDigest).toBe(digest);
        expect(normalized.request.ontology.sources[0].contentDigest).toBe(digest);

        const invalid = { id: 'source:root', locator: 'invalid.ttl', bytes: Uint8Array.from([0xc3, 0x28]) };
        const failure = await Effect.runPromise(
            Effect.flip(assembleOntology(memoryResourcePort([invalid]), [sourceDescriptor(invalid)])),
        );
        expect(failure).toBeInstanceOf(TurtleSourceEncodingError);
        expect(failure).toMatchObject({ code: 'TURTLE_SOURCE_ENCODING_ERROR' });
    });

    it('rejects invalid source identity and unsafe reasoning limits deterministically', async () => {
        const fixture = { id: 'not valid', locator: 'root.ttl', text: `${PREFIXES} ex:A a owl:Class .` };
        const graph = await assembleFixtures([fixture]);
        expect(() => normalizeAssembledOntology(graph, artifact.requiredTool)).toThrow(
            expect.objectContaining({
                code: 'INVALID_REASONER_INPUT',
            }),
        );
        const valid = await assembleFixtures([
            { id: 'source:root', locator: 'root.ttl', text: `${PREFIXES} ex:A a owl:Class .` },
        ]);
        expect(() =>
            normalizeAssembledOntology(valid, artifact.requiredTool, {
                limits: { maxInputAxioms: 1, maxInferences: 1, maxWallTimeMs: Number.MAX_SAFE_INTEGER + 1 },
            }),
        ).toThrow(expect.objectContaining({ code: 'INVALID_REASONER_INPUT' }));
    });

    it('copies and freezes caller-owned limits and source-owner metadata', async () => {
        const prefixes = ['https://example.test/root#'];
        const owner = {
            canonicalIri: 'https://example.test/root',
            role: 'root' as const,
            ownedIriPrefixes: prefixes,
        };
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                owner,
                text: `${PREFIXES} ex:A a owl:Class .`,
            },
        ]);
        const limits = { maxInputAxioms: 7, maxInferences: 8, maxWallTimeMs: 9 };
        const normalized = normalizeAssembledOntology(graph, artifact.requiredTool, { limits });
        limits.maxInputAxioms = 999;
        prefixes.push('https://mutated.invalid/');
        expect(normalized.request.limits).toEqual({ maxInputAxioms: 7, maxInferences: 8, maxWallTimeMs: 9 });
        expect(Object.isFrozen(normalized.request.limits)).toBe(true);
        expect(normalized.sourceBindings[0]?.owner.ownedIriPrefixes).toEqual(['https://example.test/root#']);
        expect(Object.isFrozen(normalized.sourceBindings[0]?.owner.ownedIriPrefixes)).toBe(true);
    });

    it('uses full SHA-256 source namespaces to isolate anonymous blank nodes across sources', async () => {
        const graph = await assembleFixtures([
            { id: 'source:alpha', locator: 'alpha.ttl', text: `${PREFIXES} ex:a ex:p [ ex:q ex:o ] .` },
            { id: 'source:beta', locator: 'beta.ttl', text: `${PREFIXES} ex:b ex:p [ ex:q ex:o ] .` },
        ]);
        const blankValuesBySource = new Map<string, Set<string>>();
        for (const entry of graph.provenance) {
            const values = [entry.quad.subject, entry.quad.object]
                .filter((term) => term.termType === 'BlankNode')
                .map((term) => term.value);
            for (const contributor of entry.asserted) {
                const set = blankValuesBySource.get(contributor.sourceId) ?? new Set<string>();
                for (const value of values) {
                    set.add(value);
                }
                blankValuesBySource.set(contributor.sourceId, set);
            }
        }
        const alphaDigest = createHash('sha256').update('source:alpha').digest('hex');
        const betaDigest = createHash('sha256').update('source:beta').digest('hex');
        const alpha = [...(blankValuesBySource.get('source:alpha') ?? [])];
        const beta = [...(blankValuesBySource.get('source:beta') ?? [])];
        expect(alpha).not.toEqual([]);
        expect(beta).not.toEqual([]);
        expect(alpha.every((value) => value.includes(alphaDigest))).toBe(true);
        expect(beta.every((value) => value.includes(betaDigest))).toBe(true);
        expect(alpha.some((value) => beta.includes(value))).toBe(false);
    });

    it('rejects forged structural graph, source, and provenance identities before normalization', async () => {
        function fresh() {
            return assembleFixtures([
                {
                    id: 'source:root',
                    locator: 'root.ttl',
                    text: `${PREFIXES} ex:A a owl:Class .`,
                },
            ]);
        }
        async function expectForged(mutate: (graph: AssembledOntology) => AssembledOntology): Promise<void> {
            const forged = mutate(await fresh());
            expect(() => normalizeAssembledOntology(forged, artifact.requiredTool)).toThrow(
                expect.objectContaining({
                    code: 'INVALID_ASSEMBLED_ONTOLOGY',
                }),
            );
        }

        await expectForged((graph) => ({ ...graph, provenance: [] }));
        await expectForged((graph) => ({ ...graph, provenance: [...graph.provenance, ...graph.provenance] }));
        await expectForged((graph) => {
            const entry = graph.provenance[0];
            if (entry === undefined) {
                throw new TypeError('Expected provenance');
            }
            return { ...graph, provenance: [{ ...entry, key: 'forged:key' }] };
        });
        await expectForged((graph) => {
            const entry = graph.provenance[0];
            if (entry === undefined) {
                throw new TypeError('Expected provenance');
            }
            return { ...graph, provenance: [{ ...entry, asserted: [] }] };
        });
        await expectForged((graph) => {
            const entry = graph.provenance[0];
            const contributor = entry?.asserted[0];
            if (entry === undefined || contributor === undefined) {
                throw new TypeError('Expected provenance');
            }
            return {
                ...graph,
                provenance: [
                    {
                        ...entry,
                        inferred: [
                            {
                                ...contributor,
                                provenance: {
                                    _tag: 'Inferred' as const,
                                    reasoner: 'forged',
                                    operation: 'forged',
                                    statementId: 'inferred:forged',
                                    rule: 'subclass-type' as const,
                                    premises: ['axiom:forged'],
                                    justificationDigest: `sha256:${'0'.repeat(64)}`,
                                    contributingSourceIds: [contributor.sourceId],
                                    contributingOwners: [contributor.owner],
                                    certificateDigest: `sha256:${'0'.repeat(64)}`,
                                },
                            },
                        ],
                    },
                ],
            };
        });
        await expectForged((graph) => {
            const entry = graph.provenance[0];
            const contributor = entry?.asserted[0];
            if (entry === undefined || contributor === undefined) {
                throw new TypeError('Expected provenance');
            }
            return {
                ...graph,
                provenance: [{ ...entry, asserted: [{ ...contributor, sourceIndex: 99 }] }],
            };
        });
        await expectForged((graph) => ({
            ...graph,
            sources: graph.sources.map((source) => ({ ...source, tripleCount: source.tripleCount + 1 })),
        }));
        await expectForged((graph) => ({
            ...graph,
            sources: graph.sources.map((source) => ({ ...source, contentDigest: `sha256:${'0'.repeat(64)}` })),
        }));
        await expectForged((graph) => {
            const bytes = Uint8Array.from(graph.sources[0]?.bytes ?? []);
            bytes[0] = (bytes[0] ?? 0) ^ 0xff;
            return {
                ...graph,
                sources: graph.sources.map((source) => ({ ...source, bytes })),
            };
        });
        await expectForged((graph) => {
            const dataset = new Store(graph.dataset.getQuads(null, null, null, null));
            const quad = dataset.getQuads(null, null, null, null)[0];
            if (quad !== undefined) {
                dataset.removeQuad(quad);
            }
            return { ...graph, dataset };
        });

        const twoSources = await assembleFixtures([
            { id: 'source:root', locator: 'root.ttl', text: `${PREFIXES} ex:A a owl:Class .` },
            {
                id: 'source:dependency',
                locator: 'dependency.ttl',
                owner: DEPENDENCY_OWNER,
                text: `${PREFIXES} dep:B a owl:Class .`,
            },
        ]);
        const rootEntry = twoSources.provenance.find((entry) => entry.quad.subject.value.endsWith('#A'));
        const dependency = twoSources.sources.find((source) => source.descriptor.id === 'source:dependency');
        if (rootEntry === undefined || dependency === undefined) {
            throw new TypeError('Expected two-source provenance');
        }
        if (dependency.descriptor.provenance._tag !== 'Asserted') {
            throw new TypeError('Expected asserted dependency');
        }
        const forgedContributor = {
            sourceId: dependency.descriptor.id,
            sourceIndex: dependency.sourceIndex,
            owner: dependency.descriptor.owner,
            locator: dependency.descriptor.locator,
            provenance: dependency.descriptor.provenance,
        };
        const wrongSource: AssembledOntology = {
            ...twoSources,
            provenance: twoSources.provenance.map((entry) =>
                entry.key === rootEntry.key ? { ...entry, asserted: [forgedContributor] } : entry,
            ),
        };
        expect(() => normalizeAssembledOntology(wrongSource, artifact.requiredTool)).toThrow(
            expect.objectContaining({
                code: 'INVALID_ASSEMBLED_ONTOLOGY',
            }),
        );
    });
});
