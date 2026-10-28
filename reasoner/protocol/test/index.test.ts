import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    assertCanonicalReasonerRequestJson,
    assertCanonicalReasonerResponseJson,
    assertTrustedDecidedResponse,
    assertTrustedReasonerResponseEnvelope,
    AbsoluteIri,
    bindDecidedEvidence,
    computeAggregateJustificationDigest,
    computeCertificateDigest,
    computeDecidedOutputDigest,
    computeInferredJustificationDigest,
    computeReasonerInputDigest,
    decodeReasonerRequestJson,
    decodeReasonerResponseJson,
    encodeReasonerRequestJson,
    encodeReasonerResponseJson,
    ERDEN_PROOF_CHECKER_SHA256,
    ERDEN_PROOF_CHECKER_SPEC,
    ERDEN_REQUIRED_CONSTRUCTS_V1,
    ERDEN_REQUIRED_CONSTRUCTS_V2,
    ERDEN_REASONER_V1_SELECTION,
    getReasonerCompatibilityIssues,
    getReasonerEnvelopeIssues,
    getReasonerProfileRefusals,
    getProofValidationIssues,
    KNOWN_ANSWER_FIXTURES,
    makeReasonerTrustExpectation,
    MAX_REASONER_REQUEST_ID_BYTES,
    PURRDF_RESEARCH_REFERENCE,
    REASONER_PROFILE_ID,
    REASONER_PROFILE_SHA256,
    REASONER_PROFILE_V1_ID,
    REASONER_PROFILE_V1_SHA256,
    REASONER_PROTOCOL_VERSION,
    ReasonerProtocolVersion,
    ReasonerResponse,
    RefusedResult,
    stringifyCanonicalJson,
} from '../src/index.js';
import type { DecidedEvidence, JsonValue, ReasonerRequest } from '../src/index.js';

function getFixture(scenario: string) {
    const fixture = KNOWN_ANSWER_FIXTURES.find((item) => item.scenario === scenario);
    if (fixture === undefined) {
        throw new Error(`Missing fixture: ${scenario}`);
    }
    return fixture;
}

describe('@erden/reasoner-protocol profile', () => {
    it('pins V2, a superset of V1, without making an unrestricted OWL 2 DL claim', () => {
        expect(Schema.decodeUnknownSync(ReasonerProtocolVersion)(REASONER_PROTOCOL_VERSION)).toBe(1);
        expect(ERDEN_REQUIRED_CONSTRUCTS_V2.id).toBe(REASONER_PROFILE_ID);
        expect(ERDEN_REQUIRED_CONSTRUCTS_V2.claim).toBe('erden-v2-allowlist-not-owl2-dl');
        expect(ERDEN_REQUIRED_CONSTRUCTS_V2.extends).toBe(ERDEN_REQUIRED_CONSTRUCTS_V1.id);
        for (const axiom of ERDEN_REQUIRED_CONSTRUCTS_V1.axioms) {
            expect(ERDEN_REQUIRED_CONSTRUCTS_V2.axioms).toContain(axiom);
        }
        for (const refusal of ERDEN_REQUIRED_CONSTRUCTS_V1.failClosed) {
            expect(ERDEN_REQUIRED_CONSTRUCTS_V2.failClosed).toContain(refusal);
        }
        expect(ERDEN_REQUIRED_CONSTRUCTS_V1.id).toBe(REASONER_PROFILE_V1_ID);
        expect(ERDEN_REQUIRED_CONSTRUCTS_V1.claim).toBe('erden-v1-allowlist-not-owl2-dl');
        expect(ERDEN_REQUIRED_CONSTRUCTS_V1.axioms).toContain('inverse-object-properties');
        expect(ERDEN_REQUIRED_CONSTRUCTS_V1.axioms).toContain('finite-acyclic-object-union-of-named-classes-as-domain');
        expect(ERDEN_REQUIRED_CONSTRUCTS_V1.failClosed).toContain('unknown-result');
        expect(ERDEN_REQUIRED_CONSTRUCTS_V1.failClosed).toContain('reasoning-budget-exhaustion');
    });

    it('publishes a reproducible digest for the proof checker specification', () => {
        const actual = `sha256:${createHash('sha256').update(stringifyCanonicalJson(ERDEN_PROOF_CHECKER_SPEC)).digest('hex')}`;
        expect(actual).toBe(ERDEN_PROOF_CHECKER_SHA256);
        expect(ERDEN_PROOF_CHECKER_SPEC.rules).toContain('union-domain-type');
        expect(ERDEN_PROOF_CHECKER_SPEC.rules).toContain('thing-subclass-type');
    });

    it('publishes a reproducible digest for the complete profile descriptor, and keeps the V1 digest', () => {
        function digest(value: unknown): string {
            return `sha256:${createHash('sha256')
                .update(stringifyCanonicalJson(value as JsonValue))
                .digest('hex')}`;
        }
        expect(digest(ERDEN_REQUIRED_CONSTRUCTS_V2)).toBe(REASONER_PROFILE_SHA256);
        expect(digest(ERDEN_REQUIRED_CONSTRUCTS_V1)).toBe(REASONER_PROFILE_V1_SHA256);
        expect(REASONER_PROFILE_V1_SHA256).toBe(
            'sha256:0bc7dec03b01761e9762f4bc8d44b23c2f8288228cd8913d791771536bf179e5',
        );
    });

    it('separates the unselected raw engine from the selected wrapped V1 executable', () => {
        expect(PURRDF_RESEARCH_REFERENCE.rawEngineSelection).toEqual({
            status: 'not-selected',
            scope: 'raw-or-unwrapped-purrdf-api-or-binary',
        });
        expect(PURRDF_RESEARCH_REFERENCE.commit).toBe('dfb1df73199668720116dfbc737c0585e23afb5e');
        expect(PURRDF_RESEARCH_REFERENCE.knownDivergences.map(({ code }) => code)).toEqual([
            'bottom-object-property-missed-inconsistency',
            'bottom-data-property-missed-inconsistency',
            'cyclic-expression-result-withheld',
            'thing-nothing-empty-domain-wrongly-satisfiable',
        ]);
        expect(ERDEN_REASONER_V1_SELECTION).toEqual({
            status: 'selected-for-erden-v1',
            scope: 'wrapped-pinned-erden-reasoner-closed-profile-only',
            profileId: REASONER_PROFILE_ID,
            purrdfCrateVersion: '0.12.0',
            purrdfCommit: 'dfb1df73199668720116dfbc737c0585e23afb5e',
            rustVersion: '1.96.0',
            qualificationEvidence: 'reasoner/qualification/artifacts.json',
            arbitraryOwl2Dl: false,
            distributionComplete: true,
        });
    });
});

describe('known-answer JSON fixtures', () => {
    it('covers every required reasoning scenario', () => {
        expect(KNOWN_ANSWER_FIXTURES.map((fixture) => fixture.scenario)).toEqual([
            'subclass-type',
            'domain-range',
            'equivalence',
            'disjointness',
            'inverse-transitive-properties',
            'inconsistency',
            'unsatisfiable-classes',
            'unsupported-constructs',
            'pur-rdf-bottom-object-property',
            'pur-rdf-bottom-data-property',
            'pur-rdf-cyclic-expression',
            'pur-rdf-thing-nothing-empty-domain',
            'current-demo-constructs',
        ]);
    });

    it('round-trips every request and response as canonical newline-terminated JSON', () => {
        for (const fixture of KNOWN_ANSWER_FIXTURES) {
            const requestFile = readFileSync(
                new URL(`../fixtures/known-answer/${fixture.scenario}.request.json`, import.meta.url),
                'utf8',
            );
            const responseFile = readFileSync(
                new URL(`../fixtures/known-answer/${fixture.scenario}.response.json`, import.meta.url),
                'utf8',
            );
            expect(fixture.requestJson.endsWith('\n')).toBe(true);
            expect(fixture.responseJson.endsWith('\n')).toBe(true);
            expect(requestFile).toBe(fixture.requestJson);
            expect(responseFile).toBe(fixture.responseJson);
            expect(decodeReasonerRequestJson(fixture.requestJson)).toEqual(fixture.request);
            expect(decodeReasonerResponseJson(fixture.responseJson)).toEqual(fixture.response);
            expect(assertCanonicalReasonerRequestJson(fixture.requestJson)).toEqual(fixture.request);
            expect(assertCanonicalReasonerResponseJson(fixture.responseJson)).toEqual(fixture.response);
        }
    });

    it('carries checked certificates and inferred justification digests on decided answers', () => {
        for (const fixture of KNOWN_ANSWER_FIXTURES) {
            if (fixture.response.result.outcome !== 'decided') {
                continue;
            }
            expect(fixture.response.result.certificate).toMatchObject({ decision: 'Decided', checked: true });
            expect(fixture.response.result.certificate.certificateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
            for (const statement of fixture.response.result.inferred) {
                expect(statement.provenance.kind).toBe('inferred');
                expect(statement.provenance.justificationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
                expect(statement.provenance.premiseIds.length).toBeGreaterThan(0);
            }
        }
    });

    it('preserves asserted and inferred provenance in the subclass/type answer', () => {
        const fixture = getFixture('subclass-type');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        expect(fixture.response.result.asserted[0]?.provenance.kind).toBe('asserted');
        expect(fixture.response.result.inferred[0]?.provenance).toMatchObject({
            kind: 'inferred',
            premiseIds: ['a1', 'a2'],
        });
    });
});

describe('strict process boundary', () => {
    const requestJson = getFixture('subclass-type').requestJson;
    const response = getFixture('subclass-type').response;

    it('rejects malformed JSON and trailing stdout noise', () => {
        expect(() => decodeReasonerRequestJson('{')).toThrow();
        expect(() => decodeReasonerRequestJson(`${requestJson}debug output`)).toThrow();
    });

    it('rejects protocol version mismatches', () => {
        expect(() =>
            decodeReasonerRequestJson(requestJson.replace('"protocolVersion":1', '"protocolVersion":2')),
        ).toThrow();
    });

    it('rejects unknown envelope and nested fields', () => {
        expect(() => decodeReasonerRequestJson(requestJson.replace('{', '{"unexpected":true,'))).toThrow();
        expect(() =>
            decodeReasonerRequestJson(requestJson.replace('"limits":{', '"limits":{"unexpected":true,')),
        ).toThrow();
    });

    it('accepts a 1024-byte ASCII request ID and rejects boundary plus one', () => {
        const request = getFixture('subclass-type').request;
        const boundary = { ...request, requestId: `r${'a'.repeat(MAX_REASONER_REQUEST_ID_BYTES - 1)}` };
        expect(encodeReasonerRequestJson(boundary)).toContain(`"requestId":"${boundary.requestId}"`);
        expect(() =>
            encodeReasonerRequestJson({
                ...request,
                requestId: `r${'a'.repeat(MAX_REASONER_REQUEST_ID_BYTES)}`,
            }),
        ).toThrow();
    });

    it('rejects non-absolute, whitespace, control and invalid-scalar IRIs', () => {
        const decodeIri = Schema.decodeUnknownSync(AbsoluteIri);
        for (const iri of [
            'relative/path',
            '://missing-scheme',
            'https://example.test/white space',
            'https://example.test/line\nbreak',
            'https://example.test/no-break\u00a0space',
            'https://example.test/null\u0000byte',
            'https://example.test/c1\u0085control',
            'https://example.test/del\u007fcontrol',
            'https://example.test/high\ud800surrogate',
            'https://example.test/low\udfff-surrogate',
        ]) {
            expect(() => decodeIri(iri)).toThrow();
        }
        expect(decodeIri('https://example.test/unicode/\u{1f642}')).toBe('https://example.test/unicode/\u{1f642}');
    });

    it('rejects incomplete evidence masquerading as a decided success', () => {
        if (response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const decidedResponse = response.result;
        expect(() =>
            Schema.decodeUnknownSync(ReasonerResponse, { onExcessProperty: 'error' })({
                ...response,
                result: { ...decidedResponse, certificate: { ...decidedResponse.certificate, checked: false } },
            }),
        ).toThrow();
        expect(() =>
            Schema.decodeUnknownSync(ReasonerResponse, { onExcessProperty: 'error' })({
                ...response,
                result: {
                    ...decidedResponse,
                    certificate: { ...decidedResponse.certificate, justificationDigest: '' },
                },
            }),
        ).toThrow();
    });

    it('models unknown, boundary and budget exhaustion as incomplete refusals', () => {
        for (const reason of [
            'unknown-result',
            'boundary-exhausted',
            'budget-exhausted',
            'incomplete-certificate',
        ] as const) {
            expect(
                Schema.decodeUnknownSync(RefusedResult, { onExcessProperty: 'error' })({
                    outcome: 'refused',
                    completeness: 'incomplete',
                    reason,
                    diagnostics: [{ severity: 'error', code: reason, message: reason, axiomIds: [] }],
                }).reason,
            ).toBe(reason);
        }
    });
});

describe('canonical deterministic ordering', () => {
    it('normalizes axiom, class operand, inference and premise ordering', () => {
        const equivalence = getFixture('equivalence');
        const reversedRequest = {
            ...equivalence.request,
            ontology: {
                ...equivalence.request.ontology,
                axioms: [...equivalence.request.ontology.axioms]
                    .reverse()
                    .map((axiom) =>
                        axiom.kind === 'EquivalentClasses'
                            ? { ...axiom, classes: [...axiom.classes].reverse() }
                            : axiom,
                    ),
            },
        };
        expect(encodeReasonerRequestJson(reversedRequest)).toBe(equivalence.requestJson);

        const domainRange = getFixture('domain-range');
        if (domainRange.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const reversedResponse = {
            ...domainRange.response,
            result: {
                ...domainRange.response.result,
                inferred: [...domainRange.response.result.inferred].reverse().map((statement) => ({
                    ...statement,
                    provenance: {
                        ...statement.provenance,
                        premiseIds: [
                            statement.provenance.premiseIds[statement.provenance.premiseIds.length - 1] ?? '',
                            ...statement.provenance.premiseIds.slice(0, -1).reverse(),
                        ] as const,
                    },
                })),
            },
        };
        expect(encodeReasonerResponseJson(reversedResponse)).toBe(domainRange.responseJson);
    });

    it('rejects duplicate union operands instead of canonicalizing into an invalid singleton', () => {
        const fixture = getFixture('current-demo-constructs');
        const request = {
            ...fixture.request,
            ontology: {
                ...fixture.request.ontology,
                axioms: fixture.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'PropertyDomain'
                        ? {
                              ...axiom,
                              domain: {
                                  kind: 'ObjectUnionOf' as const,
                                  operands: [
                                      'https://example.test/erden/reasoner#Gap',
                                      'https://example.test/erden/reasoner#Gap',
                                  ],
                              },
                          }
                        : axiom,
                ),
            },
        };
        expect(() => encodeReasonerRequestJson(request)).toThrow(/unique identifiers/u);
    });

    it('rejects structurally valid but non-canonical bytes when canonical assertion is requested', () => {
        const fixture = getFixture('subclass-type');
        const pretty = JSON.stringify(fixture.request, null, 2);
        expect(decodeReasonerRequestJson(pretty)).toEqual(fixture.request);
        expect(() => assertCanonicalReasonerRequestJson(pretty)).toThrow(/canonical wire order/u);
    });
});

describe('fail-closed exchange checks', () => {
    function trustFor(scenario: string) {
        return makeReasonerTrustExpectation(getFixture(scenario).request.requiredTool);
    }

    it('trusts a compatible decided fixture', () => {
        const fixture = getFixture('subclass-type');
        const expected = trustFor('subclass-type');
        expect(() => {
            assertTrustedDecidedResponse(fixture.request, fixture.response, expected);
        }).not.toThrow();
        expect(getReasonerCompatibilityIssues(fixture.request, fixture.response, expected)).toEqual([]);
        expect(computeReasonerInputDigest(fixture.request)).toBe(fixture.request.ontology.digest);
    });

    it('trusts the pinned envelope of a negative outcome without pretending it is decided', () => {
        const fixture = getFixture('unsupported-constructs');
        const expected = trustFor('unsupported-constructs');
        expect(fixture.response.result.outcome).toBe('refused');
        expect(getReasonerEnvelopeIssues(fixture.request, fixture.response, expected)).toEqual([]);
        expect(() => {
            assertTrustedReasonerResponseEnvelope(fixture.request, fixture.response, expected);
        }).not.toThrow();
        expect(() => {
            assertTrustedDecidedResponse(fixture.request, fixture.response, expected);
        }).toThrow(/did not return/u);
    });

    it('rejects a negative outcome whose response envelope is not caller-bound', () => {
        const fixture = getFixture('unsupported-constructs');
        const tampered = { ...fixture.response, requestId: 'wrong:request' };
        expect(getReasonerEnvelopeIssues(fixture.request, tampered, trustFor('unsupported-constructs'))).toEqual([
            'request-id',
        ]);
        expect(() => {
            assertTrustedReasonerResponseEnvelope(fixture.request, tampered, trustFor('unsupported-constructs'));
        }).toThrow(/envelope failed closed/u);
    });

    it('detects incompatible tool, input and profile digests', () => {
        const fixture = getFixture('subclass-type');
        const expected = trustFor('subclass-type');
        const incompatible = {
            ...fixture.response,
            inputDigest: `sha256:${'0'.repeat(64)}`,
            profile: { ...fixture.response.profile, digest: `sha256:${'1'.repeat(64)}` },
            tool: { ...fixture.response.tool, version: 'wrong', executableDigest: `sha256:${'2'.repeat(64)}` },
        };
        expect(getReasonerCompatibilityIssues(fixture.request, incompatible, expected)).toEqual([
            'certificate-input-digest',
            'executable-digest',
            'input-digest',
            'profile-digest',
            'tool-version',
        ]);
        expect(() => {
            assertTrustedDecidedResponse(fixture.request, incompatible, expected);
        }).toThrow(/failed closed/u);
    });

    it('preflights every known divergence and unsupported boundary in its fixture', () => {
        const fixture = getFixture('unsupported-constructs');
        expect(getReasonerProfileRefusals(fixture.request)).toEqual([
            'missing-provenance',
            'named-graph',
            'unknown-reserved-term',
            'unsupported-construct',
        ]);
        expect(() => {
            assertTrustedDecidedResponse(fixture.request, fixture.response, trustFor('unsupported-constructs'));
        }).toThrow(/did not return/u);
    });

    it('checks only typed IRI fields and matches reserved namespaces at the IRI start', () => {
        const fixture = getFixture('subclass-type');
        const embeddedReservedText = 'https://custom.test/path/http://www.w3.org/2002/07/owl#hasKey';
        const custom: ReasonerRequest = {
            ...fixture.request,
            ontology: {
                ...fixture.request.ontology,
                sources: [
                    { ...fixture.request.ontology.sources[0], ontologyIri: embeddedReservedText },
                    ...fixture.request.ontology.sources.slice(1),
                ],
                axioms: fixture.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'SubClassOf'
                        ? { ...axiom, subClass: { kind: 'NamedClass' as const, iri: embeddedReservedText } }
                        : axiom,
                ),
            },
        };
        expect(getReasonerProfileRefusals(custom)).not.toContain('unknown-reserved-term');

        const unknownReserved = {
            ...fixture.request,
            ontology: {
                ...fixture.request.ontology,
                axioms: fixture.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'SubClassOf'
                        ? {
                              ...axiom,
                              subClass: { kind: 'NamedClass' as const, iri: 'http://www.w3.org/2002/07/owl#hasKey' },
                          }
                        : axiom,
                ),
            },
        };
        expect(getReasonerProfileRefusals(unknownReserved)).toContain('unknown-reserved-term');
    });

    it('validates actual expression positions rather than accepting declared constructs globally', () => {
        const subclass = getFixture('subclass-type');
        const unionInSubclass = {
            ...subclass.request,
            ontology: {
                ...subclass.request.ontology,
                axioms: subclass.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'SubClassOf'
                        ? {
                              ...axiom,
                              superClass: {
                                  kind: 'ObjectUnionOf' as const,
                                  operands: ['https://example.test/A', 'https://example.test/B'],
                              },
                          }
                        : axiom,
                ),
            },
        };
        // A union is admitted where it is tested (a subclass), never where something is asserted to be in it.
        expect(getReasonerProfileRefusals(unionInSubclass)).toContain('unsupported-expression-context');
        const universalInSubclass = {
            ...subclass.request,
            ontology: {
                ...subclass.request.ontology,
                axioms: subclass.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'SubClassOf'
                        ? {
                              ...axiom,
                              subClass: {
                                  kind: 'ObjectAllValuesFrom' as const,
                                  property: 'https://example.test/p',
                                  filler: { kind: 'NamedClass' as const, iri: 'https://example.test/A' },
                              },
                          }
                        : axiom,
                ),
            },
        };
        expect(getReasonerProfileRefusals(universalInSubclass)).toContain('unsupported-expression-context');

        const opaqueInClassAssertion = {
            ...subclass.request,
            ontology: {
                ...subclass.request.ontology,
                axioms: subclass.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'ClassAssertion'
                        ? {
                              ...axiom,
                              classExpression: {
                                  kind: 'OpaqueClassExpression' as const,
                                  constructIri: 'https://example.test/Outside',
                                  canonicalForm: 'Outside()',
                              },
                          }
                        : axiom,
                ),
            },
        };
        expect(getReasonerProfileRefusals(opaqueInClassAssertion)).toEqual([
            'unsupported-construct',
            'unsupported-expression-context',
        ]);
        const equivalence = getFixture('equivalence');
        const unionInEquivalence = {
            ...equivalence.request,
            ontology: {
                ...equivalence.request.ontology,
                axioms: equivalence.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'EquivalentClasses'
                        ? {
                              ...axiom,
                              classes: [
                                  { kind: 'NamedClass' as const, iri: 'https://example.test/A' },
                                  {
                                      kind: 'ObjectUnionOf' as const,
                                      operands: ['https://example.test/B', 'https://example.test/C'],
                                  },
                              ],
                          }
                        : axiom,
                ),
            },
        };
        expect(getReasonerProfileRefusals(unionInEquivalence)).toContain('unsupported-expression-context');
        const disjointness = getFixture('disjointness');
        const unionInDisjointness = {
            ...disjointness.request,
            ontology: {
                ...disjointness.request.ontology,
                axioms: disjointness.request.ontology.axioms.map((axiom) =>
                    axiom.kind === 'DisjointClasses'
                        ? {
                              ...axiom,
                              classes: [
                                  { kind: 'NamedClass' as const, iri: 'https://example.test/A' },
                                  {
                                      kind: 'ObjectUnionOf' as const,
                                      operands: ['https://example.test/B', 'https://example.test/C'],
                                  },
                              ],
                          }
                        : axiom,
                ),
            },
        };
        // Disjointness members are tested, so a union of named classes is admitted there.
        expect(getReasonerProfileRefusals(unionInDisjointness)).not.toContain('unsupported-expression-context');
        expect(getReasonerProfileRefusals(getFixture('current-demo-constructs').request)).toEqual([]);
    });

    it('compares request and response identities with caller-owned pins', () => {
        const fixture = getFixture('subclass-type');
        const expected = trustFor('subclass-type');
        const compromisedTool = { ...fixture.request.requiredTool, version: 'self-consistent-but-unpinned' };
        const compromisedRequest = { ...fixture.request, requiredTool: compromisedTool };
        const compromisedResponse = { ...fixture.response, tool: compromisedTool };
        expect(getReasonerCompatibilityIssues(compromisedRequest, compromisedResponse, expected)).toContain(
            'tool-version',
        );
        expect(
            getReasonerCompatibilityIssues(fixture.request, fixture.response, {
                ...expected,
                protocolVersion: 2,
            }),
        ).toContain('protocol-version');
    });

    it('has one exact refusal pair for each PurRDF divergence', () => {
        const cases = [
            ['pur-rdf-bottom-object-property', 'bottom-property'],
            ['pur-rdf-bottom-data-property', 'bottom-property'],
            ['pur-rdf-cyclic-expression', 'cyclic-expression'],
            ['pur-rdf-thing-nothing-empty-domain', 'known-divergence'],
        ] as const;
        for (const [scenario, reason] of cases) {
            const fixture = getFixture(scenario);
            expect(fixture.response.result).toMatchObject({ outcome: 'refused', reason });
            expect(getReasonerProfileRefusals(fixture.request)).toContain('known-divergence');
        }
    });

    it('cross-validates request source and asserted provenance references', () => {
        const fixture = getFixture('subclass-type');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const expected = trustFor('subclass-type');
        const badRequest = {
            ...fixture.request,
            ontology: {
                ...fixture.request.ontology,
                axioms: fixture.request.ontology.axioms.map((axiom) => ({
                    ...axiom,
                    provenance:
                        axiom.provenance.status === 'available'
                            ? { ...axiom.provenance, sourceId: 'source:missing' }
                            : axiom.provenance,
                })),
            },
        };
        expect(getReasonerCompatibilityIssues(badRequest, fixture.response, expected)).toEqual(
            expect.arrayContaining(['axiom-source', 'asserted-provenance', 'input-digest']),
        );
        const badResponse = {
            ...fixture.response,
            result: {
                ...fixture.response.result,
                asserted: fixture.response.result.asserted.map((statement) => ({
                    ...statement,
                    provenance: { ...statement.provenance, axiomId: 'a1' },
                })),
            },
        };
        expect(getReasonerCompatibilityIssues(fixture.request, badResponse, expected)).toEqual(
            expect.arrayContaining(['asserted-statement', 'certificate-output-digest']),
        );
        const badSourceDigest = {
            ...fixture.response,
            result: {
                ...fixture.response.result,
                asserted: fixture.response.result.asserted.map((statement) => ({
                    ...statement,
                    provenance: { ...statement.provenance, sourceDigest: `sha256:${'9'.repeat(64)}` },
                })),
            },
        };
        expect(getReasonerCompatibilityIssues(fixture.request, badSourceDigest, expected)).toContain(
            'asserted-provenance',
        );
    });

    it('rejects dangling premises and arbitrary checked digest strings', () => {
        const fixture = getFixture('subclass-type');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const expected = trustFor('subclass-type');
        const tampered = {
            ...fixture.response,
            result: {
                ...fixture.response.result,
                inferred: fixture.response.result.inferred.map((statement) => ({
                    ...statement,
                    provenance: {
                        ...statement.provenance,
                        premiseIds: ['axiom:does-not-exist'] as const,
                        justificationDigest: `sha256:${'1'.repeat(64)}`,
                    },
                })),
                certificate: {
                    ...fixture.response.result.certificate,
                    inputDigest: `sha256:${'2'.repeat(64)}`,
                    outputDigest: `sha256:${'3'.repeat(64)}`,
                    justificationDigest: `sha256:${'4'.repeat(64)}`,
                    certificateDigest: `sha256:${'5'.repeat(64)}`,
                },
            },
        };
        expect(getReasonerCompatibilityIssues(fixture.request, tampered, expected)).toEqual(
            expect.arrayContaining([
                'certificate-digest',
                'certificate-input-digest',
                'certificate-justification-digest',
                'certificate-output-digest',
                'inferred-justification-digest',
                'missing-premise',
            ]),
        );
        expect(() => {
            assertTrustedDecidedResponse(fixture.request, tampered, expected);
        }).toThrow(/failed closed/u);
    });

    it('requires unique source, axiom and response statement identifiers', () => {
        const fixture = getFixture('subclass-type');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const source = fixture.request.ontology.sources[0];
        const axiom = fixture.request.ontology.axioms[0];
        const inferredStatement = fixture.response.result.inferred[0];
        if (axiom === undefined || inferredStatement === undefined) {
            throw new Error('Fixture must contain axiom and inference records');
        }
        const duplicateRequest = {
            ...fixture.request,
            ontology: {
                ...fixture.request.ontology,
                sources: [source, source] as const,
                axioms: [axiom, axiom],
            },
        };
        const duplicateResponse = {
            ...fixture.response,
            result: {
                ...fixture.response.result,
                inferred: [inferredStatement, inferredStatement],
            },
        };
        expect(
            getReasonerCompatibilityIssues(duplicateRequest, duplicateResponse, trustFor('subclass-type')),
        ).toContain('duplicate-identifier');
    });

    it('rejects two-node and longer inferred-premise cycles', () => {
        const fixture = getFixture('subclass-type');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const { certificate: _certificate, ...base } = fixture.response.result;
        void _certificate;
        const template = base.inferred[0];
        if (template === undefined) {
            throw new Error('Expected inferred fixture statement');
        }
        const inferredTemplate = template;
        function makeNode(id: string, next: string) {
            return {
                ...inferredTemplate,
                id,
                provenance: { ...inferredTemplate.provenance, premiseIds: [next, 'a1'] as const },
            };
        }
        const twoNode = {
            ...base,
            inferred: [makeNode('cycle:1', 'cycle:2'), makeNode('cycle:2', 'cycle:1')],
        };
        expect(getProofValidationIssues(fixture.request, twoNode)).toContain('derivation-cycle');
        expect(() => bindDecidedEvidence(fixture.request, twoNode, { name: 'test-checker', version: '1' })).toThrow(
            /derivation-cycle/u,
        );

        const threeNode = {
            ...base,
            inferred: [makeNode('cycle:1', 'cycle:2'), makeNode('cycle:2', 'cycle:3'), makeNode('cycle:3', 'cycle:1')],
        };
        expect(getProofValidationIssues(fixture.request, threeNode)).toContain('derivation-cycle');
    });

    it('rejects an unknown proof rule before JSON or trust acceptance', () => {
        const fixture = getFixture('subclass-type');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const { certificate: _certificate, ...base } = fixture.response.result;
        void _certificate;
        const statement = base.inferred[0];
        if (statement === undefined) {
            throw new Error('Expected inferred fixture statement');
        }
        const mutableStatement = {
            ...statement,
            provenance: { ...statement.provenance },
        };
        Object.defineProperty(mutableStatement.provenance, 'rule', { value: 'evil-unknown-rule' });
        const evidence: DecidedEvidence = { ...base, inferred: [mutableStatement] };
        expect(getProofValidationIssues(fixture.request, evidence)).toEqual(
            expect.arrayContaining(['not-entailed', 'unknown-proof-rule']),
        );
        expect(() =>
            decodeReasonerResponseJson(
                fixture.responseJson.replace('"rule":"subclass-type"', '"rule":"evil-unknown-rule"'),
            ),
        ).toThrow();
    });

    it('rejects a fully rehashed NotEntailed conclusion and prevents binder bypass', () => {
        const fixture = getFixture('subclass-type');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const { certificate: originalCertificate, ...base } = fixture.response.result;
        const evilStatements = base.inferred.map((statement) => {
            const evil = { ...statement, object: 'https://example.test/NotEntailed' };
            return {
                ...evil,
                provenance: {
                    ...evil.provenance,
                    justificationDigest: computeInferredJustificationDigest(evil),
                },
            };
        });
        const evilEvidence: DecidedEvidence = { ...base, inferred: evilStatements };
        expect(getProofValidationIssues(fixture.request, evilEvidence)).toContain('not-entailed');
        expect(() =>
            bindDecidedEvidence(fixture.request, evilEvidence, { name: 'test-checker', version: '1' }),
        ).toThrow(/not-entailed/u);

        const certificateBase = {
            ...originalCertificate,
            inputDigest: computeReasonerInputDigest(fixture.request),
            outputDigest: computeDecidedOutputDigest(evilEvidence),
            justificationDigest: computeAggregateJustificationDigest(evilEvidence),
            certificateDigest: `sha256:${'0'.repeat(64)}`,
        };
        const evilResponse = {
            ...fixture.response,
            result: {
                ...evilEvidence,
                certificate: {
                    ...certificateBase,
                    certificateDigest: computeCertificateDigest(certificateBase),
                },
            },
        };
        expect(getReasonerCompatibilityIssues(fixture.request, evilResponse, trustFor('subclass-type'))).toContain(
            'not-entailed',
        );
        expect(() => {
            assertTrustedDecidedResponse(fixture.request, evilResponse, trustFor('subclass-type'));
        }).toThrow(/not-entailed/u);
    });

    it('rejects a fully re-signed inconsistency that cites two assertions of the same class', () => {
        const fixture = getFixture('inconsistency');
        if (fixture.response.result.outcome !== 'decided') {
            throw new Error('Expected decided fixture');
        }
        const person = 'https://example.test/erden/reasoner#Person';
        // a3 asserts alice a Person, as a2 does: alice is in Person twice and in Machine never, so the ontology is
        // consistent even though Person and Machine are disjoint.
        const axioms = fixture.request.ontology.axioms.map((axiom) =>
            axiom.id === 'a3' && axiom.kind === 'ClassAssertion'
                ? { ...axiom, classExpression: { kind: 'NamedClass' as const, iri: person } }
                : axiom,
        );
        const draft = { ...fixture.request, ontology: { ...fixture.request.ontology, axioms } };
        const consistentRequest: ReasonerRequest = {
            ...draft,
            ontology: { ...draft.ontology, digest: computeReasonerInputDigest(draft) },
        };
        const { certificate: originalCertificate, ...base } = fixture.response.result;
        const forged: DecidedEvidence = {
            ...base,
            asserted: base.asserted
                .map((statement) =>
                    statement.provenance.axiomId === 'a3' ? { ...statement, object: person } : statement,
                )
                .sort((left, right) => (left.id < right.id ? -1 : 1)),
        };
        expect(forged.consistency).toBe('inconsistent');
        expect(forged.diagnostics.map((diagnostic) => diagnostic.axiomIds)).toEqual([['a1', 'a2', 'a3']]);
        expect(getProofValidationIssues(consistentRequest, forged)).toEqual(['invalid-inconsistency-evidence']);
        expect(() => bindDecidedEvidence(consistentRequest, forged, { name: 'test-checker', version: '1' })).toThrow(
            /invalid-inconsistency-evidence/u,
        );

        const certificateBase = {
            ...originalCertificate,
            inputDigest: consistentRequest.ontology.digest,
            outputDigest: computeDecidedOutputDigest(forged),
            justificationDigest: computeAggregateJustificationDigest(forged),
        };
        const forgedResponse = {
            ...fixture.response,
            inputDigest: consistentRequest.ontology.digest,
            result: {
                ...forged,
                certificate: { ...certificateBase, certificateDigest: computeCertificateDigest(certificateBase) },
            },
        };
        expect(getReasonerCompatibilityIssues(consistentRequest, forgedResponse, trustFor('inconsistency'))).toEqual([
            'invalid-inconsistency-evidence',
        ]);
        // The genuine evidence (alice in Person and in Machine) stays valid.
        expect(getProofValidationIssues(fixture.request, base)).toEqual([]);
    });
});

describe('case-analysis proof rules', () => {
    const ex = 'https://example.test/erden/reasoner#';
    const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const owlThing = 'http://www.w3.org/2002/07/owl#Thing';
    const base = getFixture('subclass-type').request;
    const graph = { kind: 'DefaultGraph' as const };
    function provenance(id: string) {
        return {
            status: 'available' as const,
            sourceId: 'source:root',
            sourceDigest: `sha256:${'a'.repeat(64)}`,
            locator: id,
        };
    }
    const axioms = {
        union: {
            id: 'd1',
            kind: 'PropertyDomain' as const,
            propertyKind: 'ObjectProperty' as const,
            property: `${ex}plays`,
            domain: { kind: 'ObjectUnionOf' as const, operands: [`${ex}A`, `${ex}B`] as const },
            graph,
            provenance: provenance('d1'),
        },
        plays: {
            id: 'p1',
            kind: 'ObjectPropertyAssertion' as const,
            property: `${ex}plays`,
            subject: `${ex}x`,
            object: `${ex}y`,
            graph,
            provenance: provenance('p1'),
        },
        aUnderC: subclass('s1', 'A', 'C'),
        bUnderC: subclass('s2', 'B', 'C'),
        thingUnderD: { ...subclass('t1', 'Thing', 'D'), subClass: { kind: 'NamedClass' as const, iri: owlThing } },
        xIsE: {
            id: 'c1',
            kind: 'ClassAssertion' as const,
            classExpression: { kind: 'NamedClass' as const, iri: `${ex}E` },
            individual: `${ex}x`,
            graph,
            provenance: provenance('c1'),
        },
        bDisjointE: disjoint('j1', 'B', 'E'),
        aDisjointE: disjoint('j2', 'A', 'E'),
        declaredX: {
            id: 'n1',
            kind: 'Declaration' as const,
            entityKind: 'NamedIndividual' as const,
            iri: `${ex}x`,
            graph,
            provenance: provenance('n1'),
        },
    };
    function subclass(id: string, sub: string, sup: string) {
        return {
            id,
            kind: 'SubClassOf' as const,
            subClass: { kind: 'NamedClass' as const, iri: `${ex}${sub}` },
            superClass: { kind: 'NamedClass' as const, iri: `${ex}${sup}` },
            graph,
            provenance: provenance(id),
        };
    }
    function disjoint(id: string, left: string, right: string) {
        return {
            id,
            kind: 'DisjointClasses' as const,
            classes: [
                { kind: 'NamedClass' as const, iri: `${ex}${left}` },
                { kind: 'NamedClass' as const, iri: `${ex}${right}` },
            ] as const,
            graph,
            provenance: provenance(id),
        };
    }
    function issuesFor(
        rule: 'union-domain-type' | 'thing-subclass-type',
        object: string,
        premises: ReadonlyArray<{ readonly id: string }>,
    ) {
        const request: ReasonerRequest = { ...base, ontology: { ...base.ontology, axioms: Object.values(axioms) } };
        const [first, ...rest] = premises.map((premise) => premise.id);
        if (first === undefined) {
            throw new Error('Expected a premise');
        }
        const evidence: DecidedEvidence = {
            outcome: 'decided',
            completeness: 'complete',
            consistency: 'consistent',
            asserted: [],
            inferred: [
                {
                    id: 'inferred:1',
                    subject: `${ex}x`,
                    predicate: rdfType,
                    object,
                    graph,
                    provenance: {
                        kind: 'inferred',
                        rule,
                        premiseIds: [first, ...rest],
                        justificationDigest: `sha256:${'0'.repeat(64)}`,
                    },
                },
            ],
            unsatisfiableClasses: [],
            diagnostics: [],
        };
        return getProofValidationIssues(request, evidence);
    }

    it('accepts a type every operand of a union domain leads to', () => {
        const { union, plays, aUnderC, bUnderC } = axioms;
        expect(issuesFor('union-domain-type', `${ex}C`, [union, plays, aUnderC, bUnderC])).toEqual([]);
        expect(issuesFor('union-domain-type', `${ex}C`, [union, plays, aUnderC])).toEqual(['not-entailed']);
        expect(issuesFor('union-domain-type', `${ex}C`, [union, aUnderC, bUnderC])).toEqual(['not-entailed']);
    });

    it('accepts a union type when the other operands are excluded by a cited disjointness', () => {
        const { union, plays, aUnderC, xIsE, bDisjointE, aDisjointE } = axioms;
        expect(issuesFor('union-domain-type', `${ex}C`, [union, plays, aUnderC, xIsE, bDisjointE])).toEqual([]);
        expect(issuesFor('union-domain-type', `${ex}A`, [union, plays, xIsE, bDisjointE])).toEqual([]);
        expect(issuesFor('union-domain-type', `${ex}C`, [union, plays, aUnderC, xIsE])).toEqual(['not-entailed']);
        expect(issuesFor('union-domain-type', `${ex}C`, [union, plays, aUnderC, xIsE, bDisjointE, aDisjointE])).toEqual(
            ['not-entailed'],
        );
    });

    it('accepts a superclass of owl:Thing only for an individual a premise names', () => {
        const { thingUnderD, declaredX, plays, union } = axioms;
        expect(issuesFor('thing-subclass-type', `${ex}D`, [thingUnderD, declaredX])).toEqual([]);
        expect(issuesFor('thing-subclass-type', `${ex}D`, [thingUnderD, plays])).toEqual([]);
        expect(issuesFor('thing-subclass-type', `${ex}D`, [thingUnderD, union])).toEqual(['not-entailed']);
        expect(issuesFor('thing-subclass-type', owlThing, [thingUnderD, declaredX])).toEqual(['not-entailed']);
        expect(issuesFor('thing-subclass-type', `${ex}C`, [thingUnderD, declaredX])).toEqual(['not-entailed']);
    });
});

describe('inconsistency and unsatisfiability evidence', () => {
    const ex = 'https://example.test/erden/reasoner#';
    const owlThing = 'http://www.w3.org/2002/07/owl#Thing';
    const base = getFixture('subclass-type').request;
    const graph = { kind: 'DefaultGraph' as const };
    function provenance(id: string, sourceId = 'source:root') {
        return { status: 'available' as const, sourceId, sourceDigest: `sha256:${'a'.repeat(64)}`, locator: id };
    }
    function named(name: string) {
        return { kind: 'NamedClass' as const, iri: name === 'Thing' ? owlThing : `${ex}${name}` };
    }
    function typed(id: string, individual: string, name: string, sourceId?: string) {
        return {
            id,
            kind: 'ClassAssertion' as const,
            classExpression: named(name),
            individual: `${ex}${individual}`,
            graph,
            provenance: provenance(id, sourceId),
        };
    }
    function subclass(id: string, sub: string, sup: string) {
        return {
            id,
            kind: 'SubClassOf' as const,
            subClass: named(sub),
            superClass: named(sup),
            graph,
            provenance: provenance(id),
        };
    }
    const disjointAB = {
        id: 'j1',
        kind: 'DisjointClasses' as const,
        classes: [named('A'), named('B')] as const,
        graph,
        provenance: provenance('j1'),
    };
    function evidenceFor(
        axioms: ReadonlyArray<ReasonerRequest['ontology']['axioms'][number]>,
        result: Pick<DecidedEvidence, 'consistency' | 'diagnostics' | 'unsatisfiableClasses'>,
    ) {
        const request: ReasonerRequest = { ...base, ontology: { ...base.ontology, axioms } };
        const evidence: DecidedEvidence = {
            outcome: 'decided',
            completeness: 'complete',
            asserted: [],
            inferred: [],
            ...result,
        };
        return getProofValidationIssues(request, evidence);
    }
    function witness(axiomIds: readonly [string, ...string[]]) {
        return {
            axiomIds,
            code: 'disjoint-class-assertions',
            message: 'An individual is asserted in two disjoint classes',
            severity: 'error' as const,
        };
    }

    it('accepts an individual asserted in two classes of one disjointness as inconsistent', () => {
        const axioms = [disjointAB, typed('c1', 'a', 'A'), typed('c2', 'a', 'B')];
        expect(
            evidenceFor(axioms, {
                consistency: 'inconsistent',
                diagnostics: [witness(['c1', 'c2', 'j1'])],
                unsatisfiableClasses: [],
            }),
        ).toEqual([]);
    });

    it('refuses a witness made of the same class assertion from two sources', () => {
        // The same triple in two sources is two ClassAssertion axioms with two ids; together with
        // DisjointClasses(A, B) they are consistent.
        const axioms = [disjointAB, typed('c1', 'a', 'A'), typed('c2', 'a', 'A', 'source:dependency')];
        expect(
            evidenceFor(axioms, {
                consistency: 'inconsistent',
                diagnostics: [witness(['c1', 'c2', 'j1'])],
                unsatisfiableClasses: [],
            }),
        ).toEqual(['invalid-inconsistency-evidence']);
    });

    it('refuses a consistent answer that proves owl:Thing unsatisfiable', () => {
        // OWL 2 Direct Semantics needs a non-empty domain, so an ontology in which owl:Thing is
        // unsatisfiable has no model, with or without individuals.
        const axioms = [disjointAB, subclass('t1', 'Thing', 'A'), subclass('t2', 'Thing', 'B')];
        const premiseIds = ['j1', 't1', 't2'] as const;
        const justificationDigest = `sha256:${'0'.repeat(64)}` as const;
        expect(
            evidenceFor(axioms, {
                consistency: 'consistent',
                diagnostics: [],
                unsatisfiableClasses: [{ classIri: owlThing, premiseIds, justificationDigest }],
            }),
        ).toEqual(['invalid-unsatisfiable-evidence']);
        const named = [disjointAB, subclass('t1', 'C', 'A'), subclass('t2', 'C', 'B')];
        expect(
            evidenceFor(named, {
                consistency: 'consistent',
                diagnostics: [],
                unsatisfiableClasses: [{ classIri: `${ex}C`, premiseIds, justificationDigest }],
            }),
        ).toEqual([]);
    });
});
