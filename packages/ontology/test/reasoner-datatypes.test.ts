import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { TOOL_VERSION, resolveBundledReasonerArtifact } from '@erden/reasoner-distribution';
import {
    assertCanonicalReasonerResponseJson,
    computeReasonerInputDigest,
    encodeReasonerRequestJson,
    type ReasonerRequest,
} from '@erden/reasoner-protocol';

import {
    BUILTIN_DATATYPES,
    MEASURED_DATATYPE_RELEASES,
    ReasonerNormalizationError,
    datatypeBoundaries,
    decideAssembledOntology,
    normalizeAssembledOntology,
    type ProfilePartitionFinding,
} from '../src/index.js';

import { assembleFixtures } from './reasoner-helpers.js';

type Outcome = 'decided' | 'boundary' | 'inconsistent';

interface DatatypeCase {
    readonly iri: string;
    readonly lexical: string;
    readonly language?: string;
    readonly range: Outcome;
    readonly literal: Outcome;
    readonly 'v0.2': Readonly<
        Record<
            'range' | 'dataAssertion' | 'annotation' | 'annotationRange' | 'rangedAssertion' | 'rangedStringAssertion',
            Outcome
        >
    >;
}

const repository = resolve(import.meta.dirname, '../../..');
const table = JSON.parse(readFileSync(resolve(repository, 'reasoner/qualification/datatypes.json'), 'utf8')) as {
    readonly datatypes: ReadonlyArray<DatatypeCase>;
};
const artifact = resolveBundledReasonerArtifact();
const V01 = '0.1.0+purrdf.0.12.0.dfb1df7';
const V02 = '0.2.0+purrdf.0.12.0.dfb1df7';
// 0.3.0 sends literals and data ranges to PurRDF as 0.2.0 does: adapter.test.ts measures it against the 'v0.2' column.
const V03 = '0.3.0+purrdf.0.12.0.dfb1df7';

type Usage = 'data-property range' | 'annotation-property range' | 'data assertion' | 'annotation' | 'ranged assertion';

/** What the release does with each usage, read from `datatypes.json` alone. */
function recorded(item: DatatypeCase, version: string): Readonly<Record<Usage, Outcome>> {
    if (version === V01) {
        const ranged = item.range === 'boundary' || item.literal === 'boundary' ? 'boundary' : 'decided';
        return {
            'data-property range': item.range,
            'annotation-property range': item.range,
            'data assertion': item.literal,
            annotation: item.literal,
            'ranged assertion': ranged,
        };
    }
    if (version === V02 || version === V03) {
        const v = item['v0.2'];
        return {
            'data-property range': v.range,
            'annotation-property range': v.annotationRange,
            'data assertion': v.dataAssertion,
            annotation: v.annotation,
            'ranged assertion': v.rangedAssertion,
        };
    }
    throw new TypeError(`datatypes.json has no column for ${version}`);
}

function boundarySet(predicate: (item: DatatypeCase) => boolean): ReadonlySet<string> {
    return new Set(table.datatypes.filter(predicate).map((item) => item.iri));
}

const HEADER = `@prefix x: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

function literal(item: DatatypeCase): string {
    return item.language === undefined
        ? `${JSON.stringify(item.lexical)}^^<${item.iri}>`
        : `${JSON.stringify(item.lexical)}@${item.language}`;
}

function turtle(item: DatatypeCase, usage: Usage): string {
    switch (usage) {
        case 'data-property range':
            return `${HEADER}x:p a owl:DatatypeProperty ; rdfs:range <${item.iri}> .`;
        case 'annotation-property range':
            return `${HEADER}x:a a owl:AnnotationProperty ; rdfs:range <${item.iri}> .`;
        case 'data assertion':
            return `${HEADER}x:p a owl:DatatypeProperty . x:i x:p ${literal(item)} .`;
        case 'annotation':
            return `${HEADER}x:a a owl:AnnotationProperty . x:i x:a ${literal(item)} .`;
        case 'ranged assertion':
            return `${HEADER}x:p a owl:DatatypeProperty ; rdfs:range <${item.iri}> . x:i x:p ${literal(item)} .`;
    }
}

/** The same usage as a protocol request, bypassing the normalizer, for the bundled executable itself. */
function protocolRequest(item: DatatypeCase, usage: Usage): ReasonerRequest {
    const base = JSON.parse(
        readFileSync(resolve(repository, 'reasoner/protocol/fixtures/known-answer/subclass-type.request.json'), 'utf8'),
    ) as ReasonerRequest;
    const provenance = base.ontology.axioms[0]?.provenance;
    if (provenance === undefined) {
        throw new TypeError('subclass fixture has no provenance');
    }
    const graph = { kind: 'DefaultGraph' } as const;
    const value = {
        datatype: item.iri,
        kind: 'Literal' as const,
        language: item.language ?? null,
        lexicalForm: item.lexical,
    };
    const property = 'https://example.test/root#p';
    const subject = 'https://example.test/root#i';
    const annotation = usage === 'annotation' || usage === 'annotation-property range';
    const declaration = {
        entityKind: annotation ? 'AnnotationProperty' : 'DataProperty',
        graph,
        id: 'a1',
        iri: property,
        kind: 'Declaration',
        provenance,
    } as const;
    const range = {
        graph,
        id: 'a2',
        kind: 'PropertyRange',
        property,
        propertyKind: annotation ? 'AnnotationProperty' : 'DataProperty',
        provenance,
        range: item.iri,
    } as const;
    const data = { graph, id: 'a3', kind: 'DataPropertyAssertion', property, provenance, subject, value } as const;
    const axioms: Record<Usage, ReasonerRequest['ontology']['axioms']> = {
        'data-property range': [declaration, range],
        'annotation-property range': [declaration, range],
        'data assertion': [declaration, data],
        annotation: [
            declaration,
            { graph, id: 'a3', kind: 'AnnotationAssertion', property, provenance, subject, value },
        ],
        'ranged assertion': [declaration, range, data],
    };
    const request: ReasonerRequest = {
        ...base,
        requestId: `datatype:${usage.replaceAll(' ', '-')}:${item.iri.replace(/^.*[#/]/u, '')}`,
        requiredTool: artifact.requiredTool,
        ontology: { ...base.ontology, axioms: axioms[usage] },
    };
    return { ...request, ontology: { ...request.ontology, digest: computeReasonerInputDigest(request) } };
}

function runBundled(request: ReasonerRequest) {
    const child = spawnSync(artifact.path, [], {
        input: encodeReasonerRequestJson(request),
        encoding: 'utf8',
        timeout: 60_000,
    });
    expect(child.status).toBe(0);
    return assertCanonicalReasonerResponseJson(child.stdout);
}

async function decide(text: string) {
    const graph = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text }]);
    return Effect.runPromise(Effect.result(decideAssembledOntology(graph)));
}

async function normalizeFor(version: string, text: string) {
    const graph = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text }]);
    return Effect.runSync(
        Effect.result(
            Effect.try({
                try: () => normalizeAssembledOntology(graph, { ...artifact.requiredTool, version }),
                catch: (cause) => cause,
            }),
        ),
    );
}

/**
 * The subject a refusal of each usage names: the property for a range, the individual for a value. A ranged
 * assertion names whichever of the two reaches the boundary.
 */
const SUBJECTS: Readonly<Record<Usage, string | undefined>> = {
    'data-property range': 'https://example.test/root#p',
    'annotation-property range': 'https://example.test/root#a',
    'data assertion': 'https://example.test/root#i',
    annotation: 'https://example.test/root#i',
    'ranged assertion': undefined,
};

const USAGES: ReadonlyArray<Usage> = [
    'data-property range',
    'annotation-property range',
    'data assertion',
    'annotation',
    'ranged assertion',
];

describe('built-in datatypes against the bundled reasoner', () => {
    it('lists every built-in datatype of the normalizer exactly once, in table order', () => {
        expect(table.datatypes.map((item) => item.iri)).toEqual(BUILTIN_DATATYPES);
        expect(new Set(BUILTIN_DATATYPES).size).toBe(44);
    });

    it('has measurements for the bundled release, and for each release measured in datatypes.json', () => {
        expect(MEASURED_DATATYPE_RELEASES).toContain(TOOL_VERSION);
        expect([...MEASURED_DATATYPE_RELEASES].sort()).toEqual([V01, V02, V03]);
        expect(() => datatypeBoundaries('9.9.9+unmeasured')).toThrow(ReasonerNormalizationError);
    });

    it('refuses for each release exactly the boundaries datatypes.json records for it', () => {
        expect(datatypeBoundaries(V01)).toEqual({
            range: boundarySet((item) => item.range === 'boundary'),
            assertedRange: new Set(),
            dataLiteral: boundarySet((item) => item.literal === 'boundary'),
            annotationLiteral: boundarySet((item) => item.literal === 'boundary'),
        });
        const v02 = datatypeBoundaries(V02);
        expect(v02).toEqual({
            range: boundarySet(
                (item) => item['v0.2'].range === 'boundary' || item['v0.2'].annotationRange === 'boundary',
            ),
            assertedRange: boundarySet((item) => item['v0.2'].rangedStringAssertion === 'boundary'),
            dataLiteral: boundarySet((item) => item['v0.2'].dataAssertion === 'boundary'),
            annotationLiteral: boundarySet((item) => item['v0.2'].annotation === 'boundary'),
        });
        for (const item of table.datatypes) {
            const refused = v02.assertedRange.has(item.iri) || v02.dataLiteral.has(item.iri);
            expect(refused, item.iri).toBe(item['v0.2'].rangedAssertion === 'boundary');
        }
        expect(datatypeBoundaries(V03)).toEqual(v02);
    });

    it('lifts the 0.1 refusals the 0.2 reasoner decides once it is the bundled release', async () => {
        const anyUri = '<http://www.w3.org/2001/XMLSchema#anyURI>';
        const annotation = `${HEADER}x:a a owl:AnnotationProperty . x:i x:a "https://example.org/licence"^^${anyUri} .`;
        const bareRange = `${HEADER}x:p a owl:DatatypeProperty ; rdfs:range ${anyUri} .`;
        const rangedValue = `${HEADER}x:p a owl:DatatypeProperty ; rdfs:range ${anyUri} . x:i x:p "x" .`;
        const literalRange = `${HEADER}x:p a owl:DatatypeProperty ; rdfs:range rdfs:Literal . x:i x:p "x" .`;
        expect((await normalizeFor(V01, annotation))._tag).toBe('Failure');
        expect((await normalizeFor(V01, bareRange))._tag).toBe('Failure');
        expect((await normalizeFor(V02, annotation))._tag).toBe('Success');
        expect((await normalizeFor(V02, bareRange))._tag).toBe('Success');
        expect((await normalizeFor(V02, literalRange))._tag).toBe('Success');
        const refused = await normalizeFor(V02, rangedValue);
        expect(refused._tag).toBe('Failure');
        if (refused._tag === 'Failure') {
            expect(refused.failure).toMatchObject({
                code: 'UNSUPPORTED_DATATYPE',
                details: {
                    datatype: 'http://www.w3.org/2001/XMLSchema#anyURI',
                    subject: 'https://example.test/root#p',
                    usage: 'range',
                },
            });
        }
    });

    it.each(table.datatypes.map((item) => [item.iri.replace(/^.*[#/]/u, ''), item] as const))(
        '%s: decides every usage the bundled release decides and refuses the rest by name before reasoning',
        async (_name, item) => {
            const expected = recorded(item, TOOL_VERSION);
            for (const usage of USAGES) {
                const label = `${usage} of ${item.iri}`;
                const outcome = await decide(turtle(item, usage));
                if (expected[usage] === 'decided') {
                    expect(outcome._tag, label).toBe('Success');
                    if (outcome._tag === 'Success') {
                        expect(outcome.success.response.result.consistency).toBe('consistent');
                    }
                    continue;
                }
                expect(outcome._tag, label).toBe('Failure');
                if (outcome._tag === 'Failure') {
                    // The profile partition lists each usage the release refuses on its own; a range refused only
                    // under an asserted value needs the whole ontology, so the normalizer refuses it afterwards.
                    expect(outcome.failure).toBeInstanceOf(ReasonerNormalizationError);
                    const failure = outcome.failure as ReasonerNormalizationError;
                    // A ranged assertion's value has the range's datatype, so a refused data literal is listed by the
                    // partition first; only a datatype whose literals decide reaches the asserted-range refusal.
                    const boundaries = datatypeBoundaries(TOOL_VERSION);
                    if (
                        boundaries.assertedRange.has(item.iri) &&
                        !boundaries.dataLiteral.has(item.iri) &&
                        usage === 'ranged assertion'
                    ) {
                        expect(failure).toMatchObject({
                            code: 'UNSUPPORTED_DATATYPE',
                            details: { datatype: item.iri },
                        });
                    } else {
                        expect(failure.code, label).toBe('OUTSIDE_PROFILE');
                        const findings = failure.details.findings as ReadonlyArray<ProfilePartitionFinding>;
                        const subject = SUBJECTS[usage];
                        expect(
                            findings.some(
                                (finding) =>
                                    finding.construct === 'unsupported-datatype' &&
                                    finding.datatype === item.iri &&
                                    (subject === undefined || finding.subject === subject),
                            ),
                            label,
                        ).toBe(true);
                    }
                    expect(outcome.failure.message).toContain(item.iri);
                }
                const response = runBundled(protocolRequest(item, usage));
                expect(response.result.outcome, `${label} at the protocol level`).toBe('refused');
                if (response.result.outcome === 'refused') {
                    expect(response.result.reason, label).toBe('boundary-exhausted');
                }
            }
        },
        60_000,
    );

    it('still accepts a declaration of any built-in datatype and an xsd:dateTime range', async () => {
        const declared = await decide(`${HEADER}<http://www.w3.org/2001/XMLSchema#dateTimeStamp> a rdfs:Datatype .`);
        expect(declared._tag).toBe('Success');
        const control = await decide(
            `${HEADER}x:E a owl:Class ; rdfs:label "E" . x:at a owl:DatatypeProperty ; rdfs:label "at" ; rdfs:domain x:E ; rdfs:range <http://www.w3.org/2001/XMLSchema#dateTime> .`,
        );
        expect(control._tag).toBe('Success');
    });

    it('refuses the bug report issue 4 reproduction (an xsd:dateTimeStamp range) by name while it reaches a boundary', async () => {
        const reproduction = `${HEADER}x:E a owl:Class ; rdfs:label "E" . x:at a owl:DatatypeProperty ; rdfs:label "at" ; rdfs:domain x:E ; rdfs:range <http://www.w3.org/2001/XMLSchema#dateTimeStamp> .`;
        const withValue = `${reproduction} x:e x:at "2026-10-05T12:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp> .`;
        const refusal = {
            code: 'OUTSIDE_PROFILE',
            details: {
                findings: [
                    {
                        construct: 'unsupported-datatype',
                        datatype: 'http://www.w3.org/2001/XMLSchema#dateTimeStamp',
                        subject: 'https://example.test/root#at',
                        predicate: 'http://www.w3.org/2000/01/rdf-schema#range',
                    },
                ],
            },
        };
        const under01 = await normalizeFor(V01, reproduction);
        expect(under01._tag).toBe('Failure');
        if (under01._tag === 'Failure') {
            expect(under01.failure).toMatchObject(refusal);
        }
        expect((await normalizeFor(V02, reproduction))._tag).toBe('Success');
        const under02 = await normalizeFor(V02, withValue);
        expect(under02._tag).toBe('Failure');
        if (under02._tag === 'Failure') {
            // The xsd:dateTimeStamp value is itself a 0.2 boundary, so the partition lists it before the range check.
            expect(under02.failure).toMatchObject({ code: 'OUTSIDE_PROFILE' });
        }
    });
});
