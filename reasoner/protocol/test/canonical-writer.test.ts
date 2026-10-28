import { Schema } from 'effect';
import { FastCheck as fc } from 'effect/testing';
import { describe, expect, it } from 'vitest';

import {
    KNOWN_ANSWER_FIXTURES,
    ReasonerRequest,
    ReasonerResponse,
    assertCanonicalReasonerResponseJson,
    computeDecidedOutputDigest,
    computeReasonerInputDigest,
    decodeReasonerRequestJson,
    decodeReasonerResponseJson,
    encodeReasonerRequestJson,
    encodeReasonerResponseJson,
    normalizeReasonerRequest,
    openReasonerResponseJson,
    sealReasonerRequest,
} from '../src/index.js';
import { openedOutputDigest, sealedInputDigest } from '../src/sealed.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isRequest = Schema.is(ReasonerRequest);
const isResponse = Schema.is(ReasonerResponse);

/** Strings the canonical writer must escape or keep: quotes, backslashes, controls, astral and lone surrogates. */
const awkwardText = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 12 }),
    fc.string({ unit: 'grapheme', maxLength: 12 }),
    fc.constantFrom('"', '\\', '\u0000', ' ', '\uD800', '\uDFFF', '😀', 'é', '</script>', ' '),
);

/**
 * A known-answer document with some string leaves changed (appended awkward text) and some arrays reversed; the
 * result is kept only when it is still schema-valid, so the property ranges over schema-valid documents.
 */
function mutated(document: Json): fc.Arbitrary<Json> {
    if (typeof document === 'string') {
        return fc.oneof(
            { weight: 8, arbitrary: fc.constant(document) },
            { weight: 1, arbitrary: awkwardText.map((suffix) => `${document}${suffix}`) },
        );
    }
    if (Array.isArray(document)) {
        return fc
            .tuple(fc.tuple(...document.map(mutated)), fc.boolean())
            .map(([items, reverse]) => (reverse ? [...items].reverse() : items));
    }
    if (document !== null && typeof document === 'object') {
        const keys = Object.keys(document);
        return fc
            .tuple(...keys.map((key) => mutated(document[key] ?? null)))
            .map((values) => Object.fromEntries(keys.map((key, index) => [key, values[index] ?? null])));
    }
    return fc.constant(document);
}

const requests = fc
    .constantFrom(...KNOWN_ANSWER_FIXTURES.map((item) => JSON.parse(item.requestJson) as Json))
    .chain(mutated)
    .filter((value) => isRequest(value));

const responses = fc
    .constantFrom(...KNOWN_ANSWER_FIXTURES.map((item) => JSON.parse(item.responseJson) as Json))
    .chain(mutated)
    .filter((value) => isResponse(value));

/** A decided known answer with lemmas whose conclusions nest every expression the canonical order sorts. */
function withLemmas(operands: 'sorted' | 'reversed'): string {
    const fixture = KNOWN_ANSWER_FIXTURES.find(
        (item) => item.response.result.outcome === 'decided' && item.response.result.inferred.length > 0,
    );
    if (fixture === undefined) {
        throw new Error('no decided known answer');
    }
    const response = JSON.parse(fixture.responseJson) as { result: Record<string, Json> };
    function named(iri: string) {
        return { iri: `https://example.test/${iri}`, kind: 'NamedClass' };
    }
    const pair = [named('A'), named('B')];
    const intersection = { kind: 'ObjectIntersectionOf', operands: operands === 'sorted' ? pair : [...pair].reverse() };
    response.result.lemmas = [
        {
            conclusion: {
                kind: 'SubClassOf',
                subClass: intersection,
                superClass: {
                    filler: { kind: 'ObjectUnionOf', operands: ['https://example.test/C', 'https://example.test/D'] },
                    kind: 'ObjectSomeValuesFrom',
                    property: { kind: 'ObjectInverseOf', property: 'https://example.test/p' },
                },
            },
            id: 'lemma:1',
            justificationDigest: `sha256:${'1'.repeat(64)}`,
            premiseIds: [],
            rule: 'and-intro',
        },
    ];
    const ordered = Object.fromEntries(
        Object.keys(response.result)
            .sort()
            .map((key) => [key, response.result[key]]),
    );
    return `${JSON.stringify({ ...response, result: ordered })}\n`;
}

describe('canonical writer', () => {
    it('opens a Horn answer with lemmas as canonical exactly when its expressions are in canonical order', () => {
        const text = withLemmas('sorted');
        expect(encodeReasonerResponseJson(decodeReasonerResponseJson(text))).toBe(text);
        expect(openReasonerResponseJson(text).canonical).toBe(true);
        expect(openReasonerResponseJson(withLemmas('reversed')).canonical).toBe(false);
    });

    it('generates requests and responses that differ from the fixtures they start from', () => {
        const fixtures = new Set(KNOWN_ANSWER_FIXTURES.flatMap((item) => [item.requestJson, item.responseJson]));
        const changed = [...fc.sample(requests, 60), ...fc.sample(responses, 60)].filter(
            (value) => !fixtures.has(`${JSON.stringify(value)}\n`),
        );
        expect(changed.length).toBeGreaterThan(30);
    }, 60_000);

    it('seals and opens every known-answer fixture to its committed bytes and digests', () => {
        for (const fixture of KNOWN_ANSWER_FIXTURES) {
            const sealed = sealReasonerRequest(fixture.request, () => fixture.request.requestId);
            expect(sealed.wire).toBe(fixture.requestJson);
            expect(sealedInputDigest(sealed.request)).toBe(fixture.request.ontology.digest);
            const opened = openReasonerResponseJson(fixture.responseJson);
            expect(opened.canonical).toBe(true);
            expect(opened.response).toEqual(fixture.response);
            if (fixture.response.result.outcome === 'decided') {
                expect(openedOutputDigest(opened.response)).toBe(fixture.response.result.certificate.outputDigest);
            }
        }
    });

    it('seals every generated schema-valid request to the wire and input digest of the full encoder', () => {
        fc.assert(
            fc.property(requests, (value) => {
                const draft = value as unknown as ReasonerRequest;
                let sealed: ReturnType<typeof sealReasonerRequest>;
                try {
                    sealed = sealReasonerRequest(draft, (digest) => `request:${digest.slice('sha256:'.length)}`);
                } catch (cause) {
                    // Duplicate identifiers or union operands: the full encoder refuses alike, before writing.
                    expect(() => encodeReasonerRequestJson(draft)).toThrow();
                    return cause instanceof TypeError;
                }
                const { request, wire } = sealed;
                const digest = computeReasonerInputDigest(draft);
                expect(request.ontology.digest).toBe(digest);
                expect(request.requestId).toBe(`request:${digest.slice('sha256:'.length)}`);
                expect(sealedInputDigest(request)).toBe(digest);
                expect(Object.isFrozen(request.ontology.axioms[0] ?? {})).toBe(true);
                expect(wire).toBe(encodeReasonerRequestJson(request));
                expect(decodeReasonerRequestJson(wire)).toEqual(normalizeReasonerRequest(request));
                return true;
            }),
            { numRuns: 150 },
        );
    }, 60_000);

    it('decides canonical form from one decode and one write, as the full check does', () => {
        fc.assert(
            fc.property(responses, fc.boolean(), (value, canonical) => {
                const response = value as unknown as ReasonerResponse;
                let text: string;
                try {
                    text = canonical ? encodeReasonerResponseJson(response) : `${JSON.stringify(response)}\n`;
                } catch {
                    return true;
                }
                let decoded: ReasonerResponse;
                try {
                    decoded = decodeReasonerResponseJson(text);
                } catch {
                    return true;
                }
                const full = (() => {
                    try {
                        assertCanonicalReasonerResponseJson(text);
                        return encodeReasonerResponseJson(decoded) === text;
                    } catch {
                        return false;
                    }
                })();
                const opened = openReasonerResponseJson(text);
                expect(opened.response).toEqual(decoded);
                expect(opened.canonical).toBe(full);
                if (opened.canonical && opened.response.result.outcome === 'decided') {
                    const { certificate: _certificate, ...evidence } = opened.response.result;
                    void _certificate;
                    expect(openedOutputDigest(opened.response)).toBe(computeDecidedOutputDigest(evidence));
                    expect(Object.isFrozen(opened.response.result)).toBe(true);
                } else {
                    expect(openedOutputDigest(opened.response)).toBeUndefined();
                }
                return true;
            }),
            { numRuns: 150 },
        );
    }, 60_000);
});
