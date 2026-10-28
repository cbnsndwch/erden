// Known answers for the Horn calculus against ERDEN_REASONER_BIN: one small ontology per rule of
// the Horn calculus (reasoner/protocol/src/proof-horn-rules.ts), each answer verified by proof checker v3 before its statements
// are compared with the hand-computed ones.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
    assertCanonicalReasonerResponseJson,
    computeReasonerInputDigest,
    encodeReasonerRequestJson,
    getProofValidationIssues,
    getReasonerCompatibilityIssues,
    makeReasonerTrustExpectation,
    REASONER_PROFILE_ID,
    REASONER_PROFILE_SHA256,
} from '../protocol/src/index.js';
import type {
    ClassExpression,
    DecidedEvidence,
    NormalizedAxiom,
    ObjectPropertyExpression,
    ReasonerRequest,
    ReasonerResponse,
    RequiredTool,
} from '../protocol/src/index.js';

import { HORN_ADAPTER_CONTRACT, HORN_CALCULUS_CONTRACT, HORN_TOOL_VERSION } from './horn-identity.js';

const configuredBinary = process.env.ERDEN_REASONER_BIN;
const binary = configuredBinary === undefined ? undefined : resolve(configuredBinary);
const enabled = binary !== undefined && existsSync(binary);

const EX = 'https://h.test/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const OWL_NOTHING = 'http://www.w3.org/2002/07/owl#Nothing';
const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SOURCE = {
    contentDigest: `sha256:${'a'.repeat(64)}` as const,
    id: 'source:root',
    kind: 'root' as const,
    ontologyIri: `${EX}ontology`,
};

function digest(input: string | Buffer): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function tool(): RequiredTool {
    if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
    return {
        adapterDigest: digest(HORN_ADAPTER_CONTRACT),
        calculusDigest: digest(HORN_CALCULUS_CONTRACT),
        executableDigest: digest(readFileSync(binary)),
        name: 'erden-reasoner',
        version: HORN_TOOL_VERSION,
    };
}

// #region Builders

const c = (name: string): ClassExpression => ({ kind: 'NamedClass', iri: `${EX}${name}` });
const p = (name: string): string => `${EX}${name}`;
const inv = (name: string): ObjectPropertyExpression => ({ kind: 'ObjectInverseOf', property: p(name) });
const prop = (property: string | ObjectPropertyExpression): ObjectPropertyExpression =>
    typeof property === 'string' && !property.includes(':') ? p(property) : property;
const some = (property: string | ObjectPropertyExpression, filler: ClassExpression): ClassExpression => ({
    kind: 'ObjectSomeValuesFrom',
    property: prop(property),
    filler,
});
const all = (property: string | ObjectPropertyExpression, filler: ClassExpression): ClassExpression => ({
    kind: 'ObjectAllValuesFrom',
    property: prop(property),
    filler,
});
const max = (
    cardinality: 0 | 1,
    property: string | ObjectPropertyExpression,
    filler: ClassExpression = { kind: 'NamedClass', iri: 'http://www.w3.org/2002/07/owl#Thing' },
): ClassExpression => ({ kind: 'ObjectMaxCardinality', cardinality, property: prop(property), filler });
const and = (...operands: ClassExpression[]): ClassExpression => ({ kind: 'ObjectIntersectionOf', operands });
const not = (operand: ClassExpression): ClassExpression => ({ kind: 'ObjectComplementOf', operand });
const literal = (lexicalForm: string, datatype = `${XSD}string`) => ({
    kind: 'Literal' as const,
    lexicalForm,
    datatype,
    language: null,
});

type AxiomBody = Omit<NormalizedAxiom, 'id' | 'graph' | 'provenance'>;
const sub = (subClass: ClassExpression, superClass: ClassExpression): AxiomBody =>
    ({ kind: 'SubClassOf', subClass, superClass }) as AxiomBody;
const type = (individual: string, classExpression: ClassExpression): AxiomBody =>
    ({ kind: 'ClassAssertion', individual: p(individual), classExpression }) as AxiomBody;
const edge = (subject: string, property: string, object: string): AxiomBody =>
    ({ kind: 'ObjectPropertyAssertion', subject: p(subject), property: p(property), object: p(object) }) as AxiomBody;

/** A canonical request of these axioms, identified `a01`, `a02`, … in order. */
function request(scenario: string, bodies: ReadonlyArray<AxiomBody>): ReasonerRequest {
    const axioms = bodies.map(
        (body, index) =>
            ({
                ...body,
                id: `a${String(index + 1).padStart(2, '0')}`,
                graph: { kind: 'DefaultGraph' },
                provenance: {
                    status: 'available',
                    sourceId: SOURCE.id,
                    sourceDigest: SOURCE.contentDigest,
                    locator: `horn.ttl#${index + 1}`,
                },
            }) as NormalizedAxiom,
    );
    const built: ReasonerRequest = {
        protocolVersion: 1,
        kind: 'ReasonerRequest',
        requestId: `horn:${scenario}`,
        operation: 'classify-and-materialize',
        profile: { id: REASONER_PROFILE_ID, digest: REASONER_PROFILE_SHA256 },
        requiredTool: tool(),
        limits: { maxInputAxioms: 1000, maxInferences: 10_000, maxWallTimeMs: 10_000 },
        ontology: { digest: `sha256:${'0'.repeat(64)}`, sources: [SOURCE], axioms },
    };
    return { ...built, ontology: { ...built.ontology, digest: computeReasonerInputDigest(built) } };
}

// #endregion

function invoke(built: ReasonerRequest): ReasonerResponse {
    if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
    const child = spawnSync(binary, [], {
        encoding: 'utf8',
        input: encodeReasonerRequestJson(built),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    return assertCanonicalReasonerResponseJson(child.stdout);
}

type Triple = readonly [string, string, string];
const isa = (subject: string, object: string): Triple => [p(subject), RDF_TYPE, p(object)];
const below = (subject: string, object: string): Triple => [p(subject), RDFS_SUBCLASS, p(object)];
const fact = (subject: string, property: string, object: string): Triple => [p(subject), p(property), p(object)];
const same = (left: string, right: string): Triple => [p(left), OWL_SAME_AS, p(right)];

interface Scenario {
    readonly name: string;
    readonly axioms: ReadonlyArray<AxiomBody>;
    readonly entailed?: ReadonlyArray<Triple>;
    readonly notEntailed?: ReadonlyArray<Triple>;
    readonly unsatisfiable?: ReadonlyArray<string>;
    readonly inconsistent?: string;
    readonly rules?: ReadonlyArray<string>;
    /** A refusal diagnostic code instead of an answer. */
    readonly refused?: string;
}

const union = (...names: string[]): ClassExpression => ({ kind: 'ObjectUnionOf', operands: names.map(p).sort() });
const objectDomain = (property: string, domain: ClassExpression): AxiomBody =>
    ({ kind: 'PropertyDomain', propertyKind: 'ObjectProperty', property: p(property), domain }) as AxiomBody;
const disjoint = (...classes: ClassExpression[]): AxiomBody =>
    ({
        kind: 'DisjointClasses',
        classes: [...classes].sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1)),
    }) as AxiomBody;
const chain = (properties: string[], superProperty: string): AxiomBody =>
    ({
        kind: 'SubObjectPropertyOf',
        subProperty: { kind: 'ObjectPropertyChain', properties: properties.map(p) },
        superProperty: p(superProperty),
    }) as AxiomBody;
// An EL axiom unrelated to the rest, so a request runs the Horn saturation, not the 0.2 procedure.
const horn = sub(c('Unrelated'), some('unrelated', c('Other')));

const HORN_SCENARIOS: ReadonlyArray<Scenario> = [
    {
        name: 'el-told-and-exists',
        axioms: [
            sub(c('A'), some('r', c('B'))),
            sub(c('B'), c('C')),
            sub(some('r', c('C')), c('D')),
            sub(c('A'), c('E')),
            sub(and(c('D'), c('E')), c('F')),
            type('a', c('A')),
        ],
        entailed: [below('A', 'D'), below('A', 'F'), isa('a', 'F'), isa('a', 'D')],
        notEntailed: [below('B', 'D')],
        rules: ['told', 'exists-intro', 'and-intro'],
    },
    {
        name: 'range-and-universal-fillers',
        axioms: [
            sub(c('A'), some('r', c('B'))),
            { kind: 'PropertyRange', propertyKind: 'ObjectProperty', property: p('r'), range: p('C') } as AxiomBody,
            sub(some('r', and(c('B'), c('C'))), c('G')),
            sub(c('A'), all('s', c('H'))),
            sub(c('A'), some('s', c('K'))),
            sub(some('s', c('H')), c('J')),
        ],
        entailed: [below('A', 'G'), below('A', 'J')],
        rules: ['forall-filler'],
    },
    {
        name: 'inverse-pushback-and-domain',
        axioms: [
            sub(c('A'), some('r', c('B'))),
            sub(c('B'), all(inv('r'), c('C'))),
            { kind: 'PropertyDomain', propertyKind: 'ObjectProperty', property: p('r'), domain: c('Dm') } as AxiomBody,
        ],
        entailed: [below('A', 'C'), below('A', 'Dm')],
        rules: ['inverse-pushback'],
    },
    {
        name: 'inverse-filler',
        axioms: [
            sub(c('A'), some('r', c('B'))),
            sub(some(inv('r'), c('A')), c('X')),
            sub(c('X'), all(inv('r'), c('Y'))),
        ],
        entailed: [below('A', 'Y')],
        notEntailed: [below('B', 'X')],
        rules: ['inverse-filler', 'inverse-pushback'],
    },
    {
        name: 'transitive-exists-and-universals',
        axioms: [
            { kind: 'TransitiveObjectProperty', property: p('partOf') } as AxiomBody,
            sub(c('A'), some('partOf', c('B'))),
            sub(c('B'), some('partOf', c('C'))),
            sub(some('partOf', c('C')), c('PC')),
            sub(c('U'), some('partOf', c('V'))),
            sub(c('V'), some('partOf', c('W'))),
            sub(c('U'), all('partOf', c('M'))),
        ],
        entailed: [below('A', 'PC'), below('B', 'PC')],
        rules: ['transitive-exists'],
    },
    {
        name: 'transitive-pushback',
        axioms: [
            { kind: 'TransitiveObjectProperty', property: p('t') } as AxiomBody,
            sub(c('A'), some('t', c('B'))),
            sub(c('B'), some('t', c('C'))),
            sub(c('C'), all(inv('t'), c('Z'))),
        ],
        entailed: [below('A', 'Z'), below('B', 'Z')],
        rules: ['transitive-pushback', 'inverse-pushback'],
    },
    {
        name: 'functional-merge',
        axioms: [
            { kind: 'FunctionalObjectProperty', property: p('f') } as AxiomBody,
            sub(c('A'), some('f', c('B'))),
            sub(c('A'), some('f', c('C'))),
            sub(some('f', and(c('B'), c('C'))), c('Both')),
        ],
        entailed: [below('A', 'Both')],
        rules: ['functional-merge'],
    },
    {
        name: 'inverse-functional-pushback',
        axioms: [
            { kind: 'InverseFunctionalObjectProperty', property: p('g') } as AxiomBody,
            sub(c('A'), some('g', c('B'))),
            sub(c('B'), some(inv('g'), c('Q'))),
        ],
        entailed: [below('A', 'Q')],
        rules: ['functional-pushback'],
    },
    {
        name: 'max-zero-and-complement',
        axioms: [
            sub(c('A'), some('r', c('B'))),
            sub(c('A'), max(0, 'r', c('B'))),
            sub(c('N'), not(c('O'))),
            sub(c('N'), c('O')),
        ],
        unsatisfiable: ['A', 'N'],
        rules: ['max-zero', 'complement'],
    },
    {
        name: 'disjoint-existential-unsatisfiable',
        axioms: [
            { kind: 'DisjointClasses', classes: [c('B'), c('C')] } as AxiomBody,
            sub(c('A'), some('r', and(c('B'), c('C')))),
        ],
        unsatisfiable: ['A'],
        rules: ['disjoint', 'exists-bottom'],
    },
    {
        name: 'individual-edges',
        axioms: [
            { kind: 'SubObjectPropertyOf', subProperty: p('child'), superProperty: p('descendant') } as AxiomBody,
            { kind: 'TransitiveObjectProperty', property: p('descendant') } as AxiomBody,
            { kind: 'InverseObjectProperties', left: p('descendant'), right: p('ancestor') } as AxiomBody,
            edge('a', 'child', 'b'),
            edge('b', 'child', 'c'),
            type('a', all('descendant', c('Kin'))),
        ],
        entailed: [
            fact('a', 'descendant', 'b'),
            fact('a', 'descendant', 'c'),
            fact('c', 'ancestor', 'a'),
            isa('c', 'Kin'),
            isa('b', 'Kin'),
        ],
        rules: ['sub-property', 'transitive-edge', 'forall-filler'],
    },
    {
        name: 'functional-same-as',
        axioms: [
            { kind: 'FunctionalObjectProperty', property: p('mother') } as AxiomBody,
            edge('x', 'mother', 'm1'),
            edge('x', 'mother', 'm2'),
            type('m1', c('Teacher')),
            edge('m1', 'knows', 'z'),
        ],
        entailed: [same('m1', 'm2'), same('m2', 'm1'), isa('m2', 'Teacher'), fact('m2', 'knows', 'z')],
        rules: ['functional-same-as', 'same-as-symmetric', 'same-as-copy'],
    },
    {
        // Equal individuals share every fact, under either name, each copy with its own proof.
        name: 'inverse-functional-same-as',
        axioms: [
            { kind: 'InverseFunctionalObjectProperty', property: p('holds') } as AxiomBody,
            edge('p1', 'holds', 'passport'),
            edge('p2', 'holds', 'passport'),
            type('p2', c('Traveller')),
            edge('z', 'knows', 'p1'),
        ],
        entailed: [
            same('p1', 'p2'),
            same('p2', 'p1'),
            isa('p1', 'Traveller'),
            fact('z', 'knows', 'p2'),
        ],
        rules: ['functional-same-as', 'same-as-symmetric', 'same-as-copy'],
    },
    {
        // V1 lists `X ⊑ owl:Thing` and `x rdf:type owl:Thing` through a told `B ⊑ owl:Thing`; so does Horn.
        name: 'thing-superclass',
        axioms: [
            sub(c('A'), c('B')),
            sub(c('B'), { kind: 'NamedClass', iri: OWL_THING }),
            sub(c('A'), some('r', c('C'))),
            type('x', c('A')),
        ],
        entailed: [
            [p('A'), RDFS_SUBCLASS, OWL_THING],
            [p('x'), RDF_TYPE, OWL_THING],
        ],
        notEntailed: [
            [p('B'), RDFS_SUBCLASS, OWL_THING],
            [p('C'), RDFS_SUBCLASS, OWL_THING],
        ],
        rules: ['told'],
    },
    {
        name: 'functional-filler',
        axioms: [
            { kind: 'FunctionalObjectProperty', property: p('mother') } as AxiomBody,
            sub(c('Person'), some('mother', c('Woman'))),
            type('x', c('Person')),
            edge('x', 'mother', 'm'),
        ],
        entailed: [isa('m', 'Woman')],
        rules: ['functional-filler'],
    },
    {
        name: 'existential-individual-inconsistent',
        axioms: [
            { kind: 'DisjointClasses', classes: [c('B'), c('C')] } as AxiomBody,
            sub(c('A'), some('r', c('B'))),
            { kind: 'PropertyRange', propertyKind: 'ObjectProperty', property: p('r'), range: p('C') } as AxiomBody,
            type('a', c('A')),
        ],
        inconsistent: 'derived-inconsistency',
    },
    {
        name: 'data-properties',
        axioms: [
            { kind: 'SubDataPropertyOf', subProperty: p('nickname'), superProperty: p('name') } as AxiomBody,
            { kind: 'PropertyDomain', propertyKind: 'DataProperty', property: p('name'), domain: c('Named') } as AxiomBody,
            {
                kind: 'DataPropertyAssertion',
                subject: p('a'),
                property: p('nickname'),
                value: literal('Al'),
            } as AxiomBody,
        ],
        entailed: [isa('a', 'Named')],
        rules: ['sub-property', 'data-domain'],
    },
    {
        name: 'functional-data-clash',
        axioms: [
            { kind: 'FunctionalDataProperty', property: p('age') } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('age'), value: literal('7', `${XSD}integer`) } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('age'), value: literal('8', `${XSD}integer`) } as AxiomBody,
        ],
        inconsistent: 'functional-data-clash',
    },
    {
        name: 'functional-data-one-float-value',
        axioms: [
            { kind: 'FunctionalDataProperty', property: p('weight') } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('weight'), value: literal('1.0', `${XSD}float`) } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('weight'), value: literal('1', `${XSD}float`) } as AxiomBody,
        ],
    },
    {
        name: 'functional-data-two-float-values',
        axioms: [
            { kind: 'FunctionalDataProperty', property: p('weight') } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('weight'), value: literal('1.5', `${XSD}float`) } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('weight'), value: literal('2.5', `${XSD}float`) } as AxiomBody,
        ],
        refused: 'uncheckable-inconsistency',
    },
    {
        name: 'sub-data-property-range',
        axioms: [
            { kind: 'SubDataPropertyOf', subProperty: p('shoe'), superProperty: p('size') } as AxiomBody,
            { kind: 'PropertyRange', propertyKind: 'DataProperty', property: p('size'), range: `${XSD}integer` } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('shoe'), value: literal('large') } as AxiomBody,
        ],
        refused: 'uncheckable-inconsistency',
    },
    {
        name: 'chain-exists-and-edge',
        axioms: [
            chain(['hasParent', 'hasBrother'], 'hasUncle'),
            sub(c('A'), some('hasParent', c('B'))),
            sub(c('B'), some('hasBrother', c('C'))),
            sub(some('hasUncle', c('C')), c('HasUncleC')),
            edge('a', 'hasParent', 'b'),
            edge('b', 'hasBrother', 'u'),
        ],
        entailed: [below('A', 'HasUncleC'), fact('a', 'hasUncle', 'u')],
        rules: ['chain-exists', 'chain-edge'],
    },
    {
        name: 'chain-forall-range',
        axioms: [
            chain(['hasParent', 'hasBrother'], 'hasUncle'),
            { kind: 'PropertyRange', propertyKind: 'ObjectProperty', property: p('hasUncle'), range: p('Man') } as AxiomBody,
            sub(c('A'), some('hasParent', c('B'))),
            sub(c('B'), some('hasBrother', c('C'))),
            sub(some('hasParent', some('hasBrother', c('Man'))), c('Q')),
        ],
        entailed: [below('A', 'Q')],
        rules: ['chain-forall'],
    },
    {
        name: 'chain-non-regular',
        axioms: [chain(['s', 'r', 's'], 'r'), sub(c('A'), some('r', c('B')))],
        refused: 'non-regular-property-hierarchy',
    },
    {
        // From the W1-sized differential against PurRDF (seed 1128): a successor that may have no `s`-predecessor,
        // reached through `r ⊑ s`.
        name: 'max-zero-pushback',
        axioms: [
            sub(c('A'), some('r', max(0, inv('s')))),
            { kind: 'SubObjectPropertyOf', subProperty: p('r'), superProperty: p('s') } as AxiomBody,
            sub(c('B'), some('r', c('C'))),
            type('a', c('A')),
        ],
        inconsistent: 'derived-inconsistency',
        rules: ['max-zero-pushback'],
    },
    {
        name: 'max-zero-pushback-class',
        axioms: [
            sub(c('A'), some('r', max(0, inv('s')))),
            { kind: 'SubObjectPropertyOf', subProperty: p('r'), superProperty: p('s') } as AxiomBody,
        ],
        unsatisfiable: ['A'],
        rules: ['max-zero-pushback'],
    },
    {
        // OWL 2 DL's simple-property restriction (differential seed 1063): counting over a transitive property.
        name: 'non-simple-functional',
        axioms: [
            { kind: 'TransitiveObjectProperty', property: p('t') } as AxiomBody,
            { kind: 'SubObjectPropertyOf', subProperty: p('t'), superProperty: p('u') } as AxiomBody,
            { kind: 'FunctionalObjectProperty', property: { kind: 'ObjectInverseOf', property: p('u') } } as AxiomBody,
            sub(c('A'), some('t', c('B'))),
        ],
        refused: 'non-simple-property-in-cardinality',
    },
    {
        name: 'non-simple-max',
        axioms: [chain(['r', 's'], 'q'), sub(c('A'), max(1, 'q', c('B')))],
        refused: 'non-simple-property-in-cardinality',
    },
    {
        name: 'union-domain-closed-case',
        axioms: [
            objectDomain('p', union('A', 'B')),
            disjoint(c('A'), c('C')),
            type('a', c('C')),
            edge('a', 'p', 'b'),
            horn,
        ],
        entailed: [isa('a', 'B')],
        rules: ['union-case'],
    },
    {
        name: 'union-domain-common-conclusion',
        axioms: [
            objectDomain('p', union('A', 'B')),
            sub(c('A'), c('E')),
            sub(c('B'), c('E')),
            edge('a', 'p', 'b'),
            sub(c('X'), some('p', c('Y'))),
        ],
        entailed: [isa('a', 'E'), below('X', 'E')],
        notEntailed: [isa('a', 'A'), isa('a', 'B')],
        rules: ['union-case'],
    },
    {
        name: 'union-domain-every-case-closed',
        axioms: [
            objectDomain('p', union('A', 'B')),
            disjoint(c('A'), c('C')),
            disjoint(c('B'), c('C')),
            sub(c('X'), and(c('C'), some('p', c('Y')))),
        ],
        unsatisfiable: ['X'],
        rules: ['union-case'],
    },
    {
        name: 'union-domain-data-property',
        axioms: [
            { kind: 'PropertyDomain', propertyKind: 'DataProperty', property: p('d'), domain: union('A', 'B') } as AxiomBody,
            disjoint(c('A'), c('C')),
            type('a', c('C')),
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('d'), value: literal('x') } as AxiomBody,
            horn,
        ],
        entailed: [isa('a', 'B')],
        rules: ['union-case'],
    },
    {
        name: 'union-domain-not-local',
        axioms: [
            objectDomain('p', union('A', 'B')),
            sub(some('r', c('A')), c('Z')),
            edge('a', 'p', 'b'),
            edge('c', 'r', 'a'),
        ],
        refused: 'union-domain-not-local',
    },
];

function triples(response: ReasonerResponse): Set<string> {
    if (response.result.outcome !== 'decided') return new Set();
    return new Set(
        [...response.result.asserted, ...response.result.inferred].map((statement) =>
            JSON.stringify([statement.subject, statement.predicate, statement.object]),
        ),
    );
}

describe.skipIf(!enabled)('Horn calculus known answers', () => {
    for (const scenario of HORN_SCENARIOS) {
        test(scenario.name, () => {
            const built = request(scenario.name, scenario.axioms);
            const response = invoke(built);
            if (process.env.HORN_DUMP !== undefined) console.log(JSON.stringify(response.result, null, 1));
            if (scenario.refused !== undefined) {
                expect(response.result.outcome).toBe('refused');
                if (response.result.outcome === 'refused') {
                    expect(response.result.diagnostics.map((item) => item.code)).toEqual([scenario.refused]);
                }
                return;
            }
            expect(response.result.outcome, JSON.stringify(response.result)).toBe('decided');
            if (response.result.outcome !== 'decided') return;
            expect(getReasonerCompatibilityIssues(built, response, makeReasonerTrustExpectation(tool()))).toEqual([]);
            const found = triples(response);
            for (const triple of scenario.entailed ?? []) {
                expect(found.has(JSON.stringify(triple)), JSON.stringify(triple)).toBe(true);
            }
            for (const triple of scenario.notEntailed ?? []) {
                expect(found.has(JSON.stringify(triple)), JSON.stringify(triple)).toBe(false);
            }
            expect(response.result.unsatisfiableClasses.map((item) => item.classIri)).toEqual(
                (scenario.unsatisfiable ?? []).map(p).sort(),
            );
            if (scenario.inconsistent === undefined) {
                expect(response.result.consistency).toBe('consistent');
            } else {
                expect(response.result.consistency).toBe('inconsistent');
                expect(response.result.diagnostics.map((item) => item.code)).toEqual([scenario.inconsistent]);
            }
            const rules = new Set([
                ...response.result.inferred.map((statement) => statement.provenance.rule),
                ...(response.result.lemmas ?? []).map((lemma) => lemma.rule),
            ]);
            for (const rule of scenario.rules ?? []) {
                expect(rules.has(rule as never), `${scenario.name} uses ${rule}`).toBe(true);
            }
        });
    }
});

// #region Tamper matrix

type Evidence = DecidedEvidence & { readonly lemmas?: DecidedEvidence['lemmas'] };
type Step = { readonly id: string; readonly rule: string; readonly premiseIds: ReadonlyArray<string> };

const FORGED = { kind: 'NamedClass' as const, iri: p('Forged') };

function steps(evidence: Evidence): ReadonlyArray<Step> {
    return [
        ...evidence.inferred.map((item) => ({ id: item.id, rule: item.provenance.rule, premiseIds: item.provenance.premiseIds })),
        ...(evidence.lemmas ?? []).map((item) => ({ id: item.id, rule: item.rule, premiseIds: item.premiseIds })),
    ];
}

/** The evidence with one step's rule, premises or (for a lemma) other fields changed. */
function withStep(
    evidence: Evidence,
    id: string,
    change: (step: { rule: string; premiseIds: ReadonlyArray<string> }) => Record<string, unknown>,
): Evidence {
    return {
        ...evidence,
        inferred: evidence.inferred.map((item) => {
            if (item.id !== id) return item;
            const changed = change({ rule: item.provenance.rule, premiseIds: item.provenance.premiseIds });
            return {
                ...item,
                provenance: {
                    ...item.provenance,
                    rule: changed.rule ?? item.provenance.rule,
                    premiseIds: changed.premiseIds ?? item.provenance.premiseIds,
                },
            } as never;
        }),
        ...(evidence.lemmas === undefined
            ? {}
            : {
                  lemmas: evidence.lemmas.map((item) =>
                      item.id === id ? ({ ...item, ...change({ rule: item.rule, premiseIds: item.premiseIds }) } as never) : item,
                  ) as never,
              }),
    };
}

function issues(built: ReasonerRequest, evidence: Evidence): ReadonlyArray<string> {
    return getProofValidationIssues(built, evidence);
}

describe.skipIf(!enabled)('proof checker v3 refuses tampered Horn answers', () => {
    for (const scenario of HORN_SCENARIOS) {
        test(scenario.name, () => {
            const built = request(scenario.name, scenario.axioms);
            const response = invoke(built);
            if (scenario.refused !== undefined) return;
            if (response.result.outcome !== 'decided') throw new TypeError('decided answer expected');
            const { certificate: _certificate, ...rest } = response.result;
            const evidence = rest as Evidence;
            expect(issues(built, evidence)).toEqual([]);
            const all = steps(evidence);
            for (const step of all) {
                // A rule that only ever concludes owl:Nothing, or a rule name the checker does not know.
                const swapped = withStep(evidence, step.id, (item) => ({ ...item, rule: step.rule === 'max-zero' ? 'complement' : 'max-zero' }));
                const nothingStep =
                    (evidence.lemmas ?? []).find((lemma) => lemma.id === step.id)?.conclusion;
                const concludesNothing =
                    nothingStep !== undefined &&
                    (nothingStep.kind === 'SubClassOf' ? nothingStep.superClass : nothingStep.classExpression).kind === 'NamedClass' &&
                    JSON.stringify(nothingStep).includes(OWL_NOTHING);
                if (!concludesNothing) {
                    expect(issues(built, swapped), `${scenario.name} ${step.id} as max-zero`).not.toEqual([]);
                }
                expect(issues(built, withStep(evidence, step.id, (item) => ({ ...item, rule: 'made-up' }))), step.id).toContain(
                    'unknown-proof-rule',
                );
                // Without its premises (a conjunct needs none).
                if (step.rule !== 'conjunct' && step.premiseIds.length > 0) {
                    expect(
                        issues(built, withStep(evidence, step.id, (item) => ({ ...item, premiseIds: [] }))),
                        `${scenario.name} ${step.id} without premises`,
                    ).not.toEqual([]);
                }
                // A premise that does not exist.
                expect(
                    issues(built, withStep(evidence, step.id, (item) => ({ ...item, premiseIds: [...step.premiseIds, 'lemma:999999'].sort() }))),
                ).toContain('missing-proof-premise');
            }
            // A forged conclusion: a class nothing entails.
            for (const lemma of evidence.lemmas ?? []) {
                const forged = withStep(evidence, lemma.id, (item) => ({
                    ...item,
                    conclusion:
                        lemma.conclusion.kind === 'SubClassOf'
                            ? { ...lemma.conclusion, superClass: FORGED }
                            : { ...lemma.conclusion, classExpression: FORGED },
                }));
                expect(issues(built, forged), `${scenario.name} ${lemma.id} forged`).not.toEqual([]);
            }
            for (const statement of evidence.inferred) {
                const forged = {
                    ...evidence,
                    inferred: evidence.inferred.map((item) => (item.id === statement.id ? { ...item, object: FORGED.iri } : item)),
                } as Evidence;
                expect(issues(built, forged), `${scenario.name} ${statement.id} forged`).not.toEqual([]);
            }
            // A cycle: the first step cites the last one that depends on everything.
            const lemmas = evidence.lemmas ?? [];
            if (lemmas.length > 1) {
                const first = lemmas[0] as Step;
                const last = all.find((item) => item.premiseIds.includes(first.id));
                if (last !== undefined) {
                    const cyclic = withStep(evidence, first.id, (item) => ({ ...item, premiseIds: [...first.premiseIds, last.id].sort() }));
                    expect(issues(built, cyclic)).toContain('derivation-cycle');
                }
            }
            // Unsatisfiable classes and inconsistency evidence must cite proofs of owl:Nothing.
            if (evidence.unsatisfiableClasses.length > 0) {
                const other = all.find((item) => !evidence.unsatisfiableClasses.some((unsat) => unsat.premiseIds.includes(item.id)));
                const premiseIds: [string] = [other === undefined ? 'lemma:999999' : other.id];
                const forged = {
                    ...evidence,
                    unsatisfiableClasses: evidence.unsatisfiableClasses.map((item) => ({ ...item, premiseIds })),
                } as Evidence;
                expect(issues(built, forged)).not.toEqual([]);
                const thing = {
                    ...evidence,
                    unsatisfiableClasses: evidence.unsatisfiableClasses
                        .slice(0, 1)
                        .map((item) => ({ ...item, classIri: p('NotUnsat') })),
                } as Evidence;
                expect(issues(built, thing)).toContain('invalid-unsatisfiable-evidence');
            }
            if (evidence.consistency === 'inconsistent') {
                const other = all.find((item) => !evidence.diagnostics.some((diagnostic) => diagnostic.axiomIds.includes(item.id)));
                const forged = {
                    ...evidence,
                    diagnostics: evidence.diagnostics.map((item) => ({ ...item, axiomIds: other === undefined ? ['a01'] : [other.id] })),
                } as Evidence;
                expect(issues(built, forged)).toContain('invalid-inconsistency-evidence');
            }
        });
    }

    test('a functional data clash needs values the checker can tell apart', () => {
        const built = request('equal-values', [
            { kind: 'FunctionalDataProperty', property: p('age') } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('age'), value: literal('7', `${XSD}integer`) } as AxiomBody,
            { kind: 'DataPropertyAssertion', subject: p('a'), property: p('age'), value: literal('07', `${XSD}integer`) } as AxiomBody,
        ]);
        const response = invoke(built);
        expect(response.result.outcome === 'decided' && response.result.consistency).toBe('consistent');
        if (response.result.outcome !== 'decided') return;
        const { certificate: _certificate, ...rest } = response.result;
        const forged = {
            ...rest,
            consistency: 'inconsistent',
            diagnostics: [
                { severity: 'error', code: 'functional-data-clash', message: 'forged', axiomIds: ['a01', 'a02', 'a03'] },
            ],
        } as Evidence;
        expect(issues(built, forged)).toContain('invalid-inconsistency-evidence');
    });
});

// #endregion
