import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { resolveBundledReasonerArtifact } from '@erden/reasoner-distribution';
import { isUnknownReservedIri } from '@erden/reasoner-protocol';

import {
    assembleOntology,
    decideAssembledOntology,
    isBuiltinDatatype,
    isDecidableDatatypeUsage,
    materializeReasonerDecision,
    normalizeAssembledOntology,
    partitionAssembledOntology,
    PROFILE_PARTITION_RULES_DOCUMENT,
    PROFILE_PARTITION_RULES_ID,
    PROFILE_PARTITION_RULES_SHA256,
    quadKey,
    ReasonerNormalizationError,
    validateCoreOntology,
    type AssembledOntology,
    type OutsideProfilePolicy,
    type ProfilePartitionFinding,
    type ProjectSourceOwner,
    type TurtleSourceDescriptor,
} from '../src/index.js';

import { DEPENDENCY_OWNER, ROOT_OWNER, memoryResourcePort } from './reasoner-helpers.js';

const REQUIRED_TOOL = resolveBundledReasonerArtifact().requiredTool;
const OPTIONS = Object.freeze({
    isDecidableDatatype: isDecidableDatatypeUsage,
    isBuiltinDatatype,
    isUnknownReservedIri,
});

const PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix dep: <https://example.test/dependency#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix schema: <https://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const CLEAN = `${PREFIXES}
<https://example.test/root> a owl:Ontology .
ex:Animal a owl:Class .
ex:Dog a owl:Class ; rdfs:subClassOf ex:Animal .
ex:likes a owl:ObjectProperty ; rdfs:domain ex:Animal ; rdfs:range ex:Animal .
ex:rex a ex:Dog ; rdfs:label "Rex" ; ex:likes ex:rex .
`;

interface Source {
    readonly id: string;
    readonly text: string;
    readonly owner?: ProjectSourceOwner;
    readonly policy?: OutsideProfilePolicy;
}

async function assemble(sources: ReadonlyArray<Source>): Promise<AssembledOntology> {
    const descriptors = sources.map((source): TurtleSourceDescriptor =>
        Object.freeze({
            id: source.id,
            owner: source.owner ?? ROOT_OWNER,
            locator: `${source.id}.ttl`,
            baseIri: (source.owner ?? ROOT_OWNER).canonicalIri,
            mediaType: 'text/turtle',
            provenance: Object.freeze({ _tag: 'Asserted' as const }),
            ...(source.policy === undefined ? {} : { outsideProfile: source.policy }),
        }),
    );
    return Effect.runPromise(
        assembleOntology(
            memoryResourcePort(
                sources.map((source) => ({ id: source.id, locator: `${source.id}.ttl`, text: source.text })),
            ),
            descriptors,
        ),
    );
}

function summary(findings: ReadonlyArray<ProfilePartitionFinding>) {
    return findings.map((finding) => [finding.group, finding.construct, finding.statementKeys.length]);
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
    throw new Error('expected an outside-profile refusal');
}

/** One fixture per construct in the FR (a) census, with its expected group and owned statement count. */
const CENSUS: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, string, number]>]> = [
    [
        'header annotation vocabulary',
        `<https://example.test/root> owl:versionInfo "1.0" ; owl:versionIRI <https://example.test/root/1.0> ; owl:priorVersion <https://example.test/root/0.9> .
ex:Old owl:deprecated true ; rdfs:seeAlso <https://example.test/doc> ; rdfs:isDefinedBy <https://example.test/root> .`,
        // owl:versionIRI and rdfs:seeAlso are accepted: see 'accepts rdfs:seeAlso, owl:versionIRI and undeclared
        // annotation properties'.
        [
            ['annotation', 'owl:priorVersion', 1],
            ['annotation', 'owl:versionInfo', 1],
            ['annotation', 'owl:deprecated', 1],
            ['annotation', 'rdfs:isDefinedBy', 1],
        ],
    ],
    [
        'an undeclared predicate with a blank-node value',
        `<https://example.test/root> dct:contributor [ foaf:name "Ada" ] .`,
        [['annotation', 'undeclared-predicate', 2]],
    ],
    [
        'blank-node annotation values',
        `dct:creator a owl:AnnotationProperty . <https://example.test/root> dct:creator [ foaf:name "Ada" ; foaf:mbox <mailto:ada@example.test> ] .`,
        [['annotation', 'blank-node-annotation-value', 3]],
    ],
    [
        'plain rdf:Property used with IRIs and with literals',
        `ex:partOf a rdf:Property . ex:rex ex:partOf ex:pack . ex:note a rdf:Property . ex:rex ex:note "good" .`,
        [
            ['annotation', 'plain-rdf-property', 1],
            ['annotation', 'plain-rdf-property', 1],
            ['unreasoned', 'plain-rdf-property', 1],
            ['unreasoned', 'plain-rdf-property', 1],
        ],
    ],
    [
        'a property typed both annotation and object',
        `ex:wasRevisionOf a owl:AnnotationProperty , owl:ObjectProperty ; rdfs:domain ex:Animal ; rdfs:range ex:Animal .`,
        [['annotation', 'double-property-typing', 1]],
    ],
    [
        // Profile V2 reasons over existential, universal and at-most-one restrictions; a minimum cardinality stays out.
        'an owl:Restriction outside profile V2 with its plumbing',
        `ex:Dog rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:likes ; owl:minCardinality "2"^^xsd:nonNegativeInteger ] .`,
        [['unreasoned', 'owl:Restriction', 4]],
    ],
    [
        'owl:propertyDisjointWith',
        `ex:adores a owl:ObjectProperty ; rdfs:domain ex:Animal ; rdfs:range ex:Animal ; owl:propertyDisjointWith ex:likes .`,
        [['unreasoned', 'owl:propertyDisjointWith', 1]],
    ],
    [
        'asymmetric, irreflexive and reflexive properties',
        `ex:likes a owl:AsymmetricProperty , owl:IrreflexiveProperty , owl:ReflexiveProperty .`,
        [
            ['unreasoned', 'owl:AsymmetricProperty', 1],
            ['unreasoned', 'owl:IrreflexiveProperty', 1],
            ['unreasoned', 'owl:ReflexiveProperty', 1],
        ],
    ],
    [
        'owl:imports',
        `<https://example.test/root> owl:imports <https://example.test/elsewhere> .`,
        [['unreasoned', 'owl:imports', 1]],
    ],
    [
        'an owl:unionOf range',
        `ex:owns a owl:ObjectProperty ; rdfs:domain ex:Animal ; rdfs:range [ a owl:Class ; owl:unionOf ( ex:Dog ex:Animal ) ] .`,
        [['unreasoned', 'union-range', 7]],
    ],
    [
        // Under the bundled 0.2 reasoner a bare range and an annotation value of such a datatype decide; a data
        // value of one does not.
        'datatypes the reasoner cannot decide',
        `ex:at a owl:DatatypeProperty ; rdfs:domain ex:Animal ; rdfs:range xsd:dateTimeStamp .
ex:rex ex:at "2026-10-09T00:00:00Z"^^xsd:dateTimeStamp .
dct:source a owl:AnnotationProperty . ex:rex dct:source "https://example.test/rex"^^xsd:anyURI .`,
        [['unreasoned', 'unsupported-datatype', 1]],
    ],
    [
        'anonymous axioms and axiom annotations',
        `[] a owl:AllDifferent ; owl:members ( ex:rex ex:pack ) .
[] a owl:Axiom ; owl:annotatedSource ex:Dog ; owl:annotatedProperty rdfs:subClassOf ; owl:annotatedTarget ex:Animal ; rdfs:comment "why" .`,
        [
            ['unreasoned', 'owl:AllDifferent', 6],
            ['annotation', 'owl:Axiom', 5],
        ],
    ],
];

describe('profile partition', () => {
    it('partitions a blank node with thousands of statements in linear time, in both modes', async () => {
        // Each statement once listed its subject again, and each listing rescanned every statement: 5,000
        // statements took 64 s before the reasoner's budget even started.
        const lines = Array.from({ length: 5_000 }, (_, index) => `_:b ex:p "v${String(index)}" .`).join('\n');
        for (const policy of ['report', 'refuse'] as const) {
            const graph = await assemble([{ id: 'root:ontology:0000', text: `${PREFIXES}${lines}`, policy }]);
            const partition = partitionAssembledOntology(graph, OPTIONS);
            expect(summary(partition.findings)).toEqual([['unreasoned', 'anonymous-node', 5_000]]);
            expect(partition.excludedKeys.size).toBe(policy === 'report' ? 5_000 : 0);
        }
    }, 15_000);

    it('publishes a versioned rules identity', () => {
        expect(PROFILE_PARTITION_RULES_ID).toBe('erden.profile-partition/v3');
        expect(JSON.parse(PROFILE_PARTITION_RULES_DOCUMENT)).toMatchObject({ id: PROFILE_PARTITION_RULES_ID });
        expect(PROFILE_PARTITION_RULES_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('finds nothing in a project inside the profile, which normalizes identically in either mode', async () => {
        const refuse = await assemble([{ id: 'root', text: CLEAN }]);
        const report = await assemble([{ id: 'root', text: CLEAN, policy: 'report' }]);
        expect(partitionAssembledOntology(refuse, OPTIONS).findings).toEqual([]);
        expect(normalizeAssembledOntology(report, REQUIRED_TOOL).wire).toBe(
            normalizeAssembledOntology(refuse, REQUIRED_TOOL).wire,
        );
        for (const name of ['animals.ttl', 'animals.rdf']) {
            const graph = await Effect.runPromise(
                assembleOntology(
                    memoryResourcePort([
                        {
                            id: 'root',
                            locator: name,
                            bytes: Uint8Array.from(
                                readFileSync(join(import.meta.dirname, 'fixtures', 'source-formats', name)),
                            ),
                        },
                    ]),
                    [
                        {
                            id: 'root',
                            owner: ROOT_OWNER,
                            locator: name,
                            baseIri: ROOT_OWNER.canonicalIri,
                            mediaType: name.endsWith('.rdf') ? 'application/rdf+xml' : 'text/turtle',
                            provenance: { _tag: 'Asserted' },
                        },
                    ],
                ),
            );
            expect(partitionAssembledOntology(graph, OPTIONS).findings).toEqual([]);
        }
    });

    it.each(CENSUS)('classifies %s in both modes', async (_label, body, expected) => {
        const text = `${CLEAN}\n${body}\n`;
        const refuse = await assemble([{ id: 'root', text }]);
        const findings = partitionAssembledOntology(refuse, OPTIONS).findings;
        expect(summary(findings).sort()).toEqual([...expected].map((item) => [...item]).sort());
        expect(findings.every((finding) => finding.policy === 'refuse' && finding.sourceIds[0] === 'root')).toBe(true);

        const error = refusal(refuse);
        expect(error.code).toBe('OUTSIDE_PROFILE');
        expect(summary(error.details.findings as ReadonlyArray<ProfilePartitionFinding>)).toEqual(summary(findings));

        const report = await assemble([{ id: 'root', text, policy: 'report' }]);
        const normalized = normalizeAssembledOntology(report, REQUIRED_TOOL);
        const clean = normalizeAssembledOntology(await assemble([{ id: 'root', text: CLEAN }]), REQUIRED_TOOL);
        expect(normalized.partition.excludedKeys.size).toBe(
            findings.reduce((total, finding) => total + finding.statementKeys.length, 0),
        );
        expect(
            normalized.request.ontology.axioms.some((axiom) => axiom.kind === 'OpaqueAxiom' || axiom.kind === 'Import'),
        ).toBe(false);
        expect(normalized.request.ontology.axioms.length).toBeGreaterThanOrEqual(clean.request.ontology.axioms.length);
    });

    it('lists every finding at once in refuse mode, never stopping at the first', async () => {
        const graph = await assemble([
            { id: 'root', text: `${CLEAN}\n${CENSUS.map(([, body]) => body).join('\n')}\n` },
        ]);
        const error = refusal(graph);
        const findings = error.details.findings as ReadonlyArray<ProfilePartitionFinding>;
        expect(findings.length).toBe(CENSUS.reduce((total, [, , expected]) => total + expected.length, 0));
        expect(new Set(findings.map((finding) => finding.construct))).toEqual(
            new Set(CENSUS.flatMap(([, , expected]) => expected.map(([, construct]) => construct))),
        );
        expect(error.message).toContain('outside what Erden reasons over yet');
    });

    it('carries the construct, subject, predicate and source file of each finding', async () => {
        const graph = await assemble([
            {
                id: 'root',
                text: `${CLEAN}\nex:Dog rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:likes ; owl:minCardinality "2"^^xsd:nonNegativeInteger ] .\n`,
            },
        ]);
        expect(partitionAssembledOntology(graph, OPTIONS).findings).toEqual([
            expect.objectContaining({
                group: 'unreasoned',
                construct: 'owl:Restriction',
                subject: 'https://example.test/root#Dog',
                predicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf',
                object: null,
                sourceIds: ['root'],
                locators: ['root.ttl'],
            }),
        ]);
    });

    it('applies each contributing project its own mode', async () => {
        const restricted = `${PREFIXES}
<https://example.test/dependency> a owl:Ontology ; owl:versionInfo "2" .
dep:Thing a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty dep:p ; owl:minCardinality "2"^^xsd:nonNegativeInteger ] .
dep:p a owl:ObjectProperty ; rdfs:domain dep:Thing ; rdfs:range dep:Thing .
`;
        const mixed = await assemble([
            { id: 'root', text: CLEAN },
            { id: 'dependency', text: restricted, owner: DEPENDENCY_OWNER, policy: 'report' },
        ]);
        const normalized = normalizeAssembledOntology(mixed, REQUIRED_TOOL);
        expect(normalized.partition.findings.map((finding) => [finding.policy, finding.sourceIds])).toEqual([
            ['report', ['dependency']],
            ['report', ['dependency']],
        ]);
        const rootRestricted = await assemble([
            { id: 'root', text: `${CLEAN}\nex:Old owl:deprecated true .\n` },
            { id: 'dependency', text: restricted, owner: DEPENDENCY_OWNER, policy: 'report' },
        ]);
        const error = refusal(rootRestricted);
        expect(
            (error.details.findings as ReadonlyArray<ProfilePartitionFinding>).map((item) => item.sourceIds),
        ).toEqual([['root']]);
        const shared = await assemble([
            {
                id: 'root',
                text: `${CLEAN}\ndep:Thing rdfs:subClassOf [ a owl:Restriction ; owl:onProperty dep:p ; owl:minCardinality "2"^^xsd:nonNegativeInteger ] .\n`,
            },
            { id: 'dependency', text: restricted, owner: DEPENDENCY_OWNER, policy: 'report' },
        ]);
        expect(
            partitionAssembledOntology(shared, OPTIONS)
                .findings.map((finding) => finding.policy)
                .sort(),
        ).toEqual(['refuse', 'report', 'report']);
    });

    it('matches imports against the dependency closure by canonical or version IRI and never refuses them', async () => {
        const dependency = `${PREFIXES}
<https://example.test/dependency> a owl:Ontology ; owl:versionIRI <https://example.test/dependency/2.0> .
dep:Thing a owl:Class .
`;
        const graph = await assemble([
            {
                id: 'root',
                policy: 'report',
                text: `${CLEAN}
<https://example.test/root> owl:imports <https://example.test/dependency> , <https://example.test/dependency/2.0> , <https://example.test/missing> .
`,
            },
            { id: 'dependency', text: dependency, owner: DEPENDENCY_OWNER, policy: 'report' },
        ]);
        const normalized = normalizeAssembledOntology(graph, REQUIRED_TOOL);
        expect(normalized.partition.imports.map((item) => [item.iri, item.status])).toEqual([
            ['https://example.test/dependency', 'satisfied'],
            ['https://example.test/dependency/2.0', 'satisfied'],
            ['https://example.test/missing', 'unresolved'],
        ]);
    });

    it('reasons over the profile in report mode while validation still sees every asserted statement', async () => {
        const graph = await assemble([
            {
                id: 'root',
                policy: 'report',
                text: `${CLEAN}
<https://example.test/root> dct:title "Root" ; owl:versionInfo "1" .
ex:Puppy a owl:Class ; rdfs:subClassOf ex:Dog , [ a owl:Restriction ; owl:onProperty ex:likes ; owl:someValuesFrom ex:Dog ] .
ex:bo a ex:Puppy .
ex:wasRevisionOf a owl:AnnotationProperty , owl:ObjectProperty ; rdfs:domain ex:Animal ; rdfs:range ex:Animal .
ex:bo ex:wasRevisionOf ex:rex .
`,
            },
        ]);
        const decision = await Effect.runPromise(decideAssembledOntology(graph));
        const reasoned = materializeReasonerDecision(decision);
        const inferred = reasoned.reasoning.inferredStatements.map(
            (item) => `${item.subject} ${typeof item.object === 'string' ? item.object : JSON.stringify(item.object)}`,
        );
        expect(inferred).toContain('https://example.test/root#bo https://example.test/root#Animal');
        expect(reasoned.dataset.getQuads(null, null, null, null).map(quadKey)).toEqual(
            expect.arrayContaining(
                decision.normalization.partition.findings.flatMap((finding) => finding.statementKeys),
            ),
        );
        const core = validateCoreOntology(reasoned);
        expect(core.borrowedTerms.missing).toEqual([]);
        expect(core.borrowedTerms.used).not.toContain('http://purl.org/dc/terms/title');
        expect(core.propertyDomainRange.properties).toEqual([]);
    });

    it.each([
        ['owl:Thing in an individual role', 'owl:Thing a ex:A .', 'RESERVED_TERM_ROLE', 11],
        [
            'a list shared by two expressions',
            '_:l rdf:first ex:A ; rdf:rest (ex:B) . ex:p a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf _:l ] . ex:q a owl:DatatypeProperty ; rdfs:domain [ owl:unionOf _:l ] .',
            'MALFORMED_RDF_LIST',
            11,
        ],
        ['a named list cell', 'ex:list rdf:first ex:A ; rdf:rest rdf:nil .', 'UNREPRESENTABLE_RDF_TERM', 11],
    ] as const)(
        'leaves malformed RDF, %s, to the normalizer: a located refusal in refuse mode, a finding in report mode',
        async (_label, body, code, line) => {
            // The body is on line 11, after the ten lines of PREFIXES.
            const refuse = await assemble([{ id: 'root', text: `${PREFIXES}${body}` }]);
            expect(partitionAssembledOntology(refuse, OPTIONS).findings).toEqual([]);
            expect(() => normalizeAssembledOntology(refuse, REQUIRED_TOOL)).toThrow(
                expect.objectContaining({
                    code,
                    location: expect.objectContaining({ file: 'root.ttl', line }) as unknown,
                }),
            );

            const report = await assemble([{ id: 'root', text: `${PREFIXES}${body}`, policy: 'report' }]);
            expect(partitionAssembledOntology(report, OPTIONS).findings).toEqual([]);
            const normalized = normalizeAssembledOntology(report, REQUIRED_TOOL);
            const malformed = normalized.partition.findings.filter((finding) => finding.construct === 'malformed-rdf');
            expect(malformed.length).toBeGreaterThan(0);
            expect(malformed.every((finding) => finding.policy === 'report' && finding.reason?.code === code)).toBe(
                true,
            );
            expect(malformed[0]?.description).toContain(`${code}: `);
            expect(
                normalized.request.ontology.axioms.some(
                    (axiom) => axiom.kind === 'PropertyDomain' || axiom.kind === 'ClassAssertion',
                ),
            ).toBe(false);
        },
    );

    it('lists a literal value of a property another source declares an object property only when its own source reports', async () => {
        function sources(literalPolicy: OutsideProfilePolicy | undefined): ReadonlyArray<Source> {
            return [
                { id: 'root', text: `${CLEAN}dct:creator a owl:ObjectProperty .\n` },
                {
                    id: 'dependency',
                    owner: DEPENDENCY_OWNER,
                    text: `${PREFIXES}<https://example.test/dependency> a owl:Ontology ; dct:creator "Someone" .\n`,
                    ...(literalPolicy === undefined ? {} : { policy: literalPolicy }),
                },
            ];
        }
        const reported = normalizeAssembledOntology(await assemble(sources('report')), REQUIRED_TOOL);
        expect(
            reported.partition.findings.map((finding) => [finding.construct, finding.reason?.code, finding.subject]),
        ).toEqual([['malformed-rdf', 'UNREPRESENTABLE_RDF_TERM', 'https://example.test/dependency']]);
        expect(reported.partition.findings[0]?.description).toContain(
            'http://purl.org/dc/terms/creator is declared an owl:ObjectProperty',
        );
        expect(
            reported.request.ontology.axioms.some(
                (axiom) => axiom.kind === 'Declaration' && axiom.iri === 'http://purl.org/dc/terms/creator',
            ),
        ).toBe(true);

        const refusalGraph = await assemble(sources(undefined));
        expect(() => normalizeAssembledOntology(refusalGraph, REQUIRED_TOOL)).toThrow(
            expect.objectContaining({
                code: 'UNREPRESENTABLE_RDF_TERM',
                details: expect.objectContaining({ property: 'http://purl.org/dc/terms/creator' }) as unknown,
                location: expect.objectContaining({ file: 'dependency.ttl', line: 11 }) as unknown,
            }),
        );
    });

    it('lists reserved vocabulary the reasoner would refuse, as SKOS, schema.org and PROV-O publish it', async () => {
        const graph = await assemble([
            {
                id: 'root',
                text: `${PREFIXES}
ex:memberList a owl:ObjectProperty ; rdfs:domain ex:Animal ; rdfs:range rdf:List .
ex:Class owl:equivalentClass rdfs:Class .
rdfs:seeAlso rdfs:comment "" .
`,
                policy: 'report',
            },
        ]);
        expect(summary(partitionAssembledOntology(graph, OPTIONS).findings)).toEqual([
            ['unreasoned', 'reserved-term-role', 1],
            ['unreasoned', 'reserved-term-role', 1],
            ['annotation', 'reserved-term', 1],
        ]);
        const decision = await Effect.runPromise(decideAssembledOntology(graph));
        expect(decision.response.result.outcome).toBe('decided');
    });

    it('treats a blank node several annotations share as data, as DPV names its contributors', async () => {
        const graph = await assemble([
            {
                id: 'root',
                text: `${PREFIXES}
<https://example.test/root> dct:creator _:person ; dct:contributor _:person .
_:person a foaf:Person ; foaf:name "Someone" ; foaf:member _:org .
<https://example.test/other> dct:publisher _:org .
_:org a foaf:Organization ; foaf:name "Somewhere" .
`,
                policy: 'report',
            },
        ]);
        const partition = partitionAssembledOntology(graph, OPTIONS);
        expect(partition.excludedKeys.size).toBe(graph.dataset.size);
        const normalized = normalizeAssembledOntology(graph, REQUIRED_TOOL);
        expect(normalized.request.ontology.axioms).toEqual([]);
    });

    it('asks only refuse-mode statements to declare their borrowed terms', async () => {
        const graph = await assemble([
            {
                id: 'mirror',
                owner: DEPENDENCY_OWNER,
                text: `${PREFIXES}
dep:Organization a owl:Class ; rdfs:subClassOf foaf:Agent .
`,
                policy: 'report',
            },
            { id: 'root', text: `${PREFIXES}\nex:Team a owl:Class ; rdfs:subClassOf dep:Organization .\n` },
        ]);
        const reasoned = materializeReasonerDecision(await Effect.runPromise(decideAssembledOntology(graph)));
        expect(validateCoreOntology(reasoned).borrowedTerms).toMatchObject({ conforms: true, missing: [] });
        const strict = await assemble([
            {
                id: 'root',
                text: `${PREFIXES}\nex:Team a owl:Class ; rdfs:subClassOf foaf:Agent .\n`,
                policy: 'report',
            },
            { id: 'other', owner: DEPENDENCY_OWNER, text: `${PREFIXES}\ndep:Thing rdfs:subClassOf foaf:Agent .\n` },
        ]);
        const strictReasoned = materializeReasonerDecision(await Effect.runPromise(decideAssembledOntology(strict)));
        expect(validateCoreOntology(strictReasoned).borrowedTerms.missing).toEqual(['http://xmlns.com/foaf/0.1/Agent']);
    });

    it('names the undecidable datatype of a literal, and lets a bare range of one through', async () => {
        const graph = await assemble([
            {
                id: 'root',
                text: `${PREFIXES}
ex:at a owl:DatatypeProperty ; rdfs:range xsd:dateTimeStamp .
ex:size a owl:DatatypeProperty .
ex:s ex:size "x"^^rdf:XMLLiteral .
`,
            },
        ]);
        const findings = partitionAssembledOntology(graph, OPTIONS).findings;
        // The bundled 0.2 reasoner decides the bare range; with a value asserted, the normalizer refuses it by name.
        expect(findings.map((finding) => [finding.construct, finding.subject, finding.datatype])).toEqual([
            [
                'unsupported-datatype',
                'https://example.test/root#s',
                'http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral',
            ],
        ]);
        expect(refusal(graph).message).toContain(
            'starting with unsupported-datatype http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral on https://example.test/root#s',
        );
    });

    it('keeps the core rules unchanged for projects in refuse mode', async () => {
        const graph = await assemble([{ id: 'root', text: `${CLEAN}\nex:untyped a owl:ObjectProperty .\n` }]);
        const reasoned = materializeReasonerDecision(await Effect.runPromise(decideAssembledOntology(graph)));
        expect(validateCoreOntology(reasoned).propertyDomainRange.findings).toEqual([
            { property: 'https://example.test/root#untyped', missing: 'domain+range' },
        ]);
    });
});
