// E1-S5: the kernel's path reads an answer with JSON.parse, checks its keys once and writes every canonical text and
// digest of it with JSON.stringify. These tests hold it to today's verdicts: the full public path (decode, re-encode
// and compare, then the public trust checks on objects the protocol did not seal or open) is the reference.
//
// - Known answers for the canonical check itself: escapes, non-ASCII text, lone surrogates, numbers, key order.
// - The verifier prototype's parity variants (prototypes/verifier-rust/bench/parity.mjs) on every known-answer
//   fixture, and its regression cases (bench/regressions.test.mjs), run through the kernel's path.
/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access,
   typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return --
   a forger edits answers as untyped JSON, which is the point of these cases. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    KNOWN_ANSWER_FIXTURES,
    assertCanonicalReasonerResponseJson,
    computeAggregateJustificationDigest,
    computeCertificateDigest,
    computeDecidedOutputDigest,
    computeInferredJustificationDigest,
    computeReasonerInputDigest,
    computeUnsatisfiableJustificationDigest,
    decodeReasonerRequestJson,
    decodeReasonerResponseJson,
    encodeReasonerRequestJson,
    encodeReasonerResponseJson,
    getReasonerCompatibilityIssues,
    getReasonerEnvelopeIssues,
    makeReasonerTrustExpectation,
    normalizeReasonerResponse,
    openReasonerResponseJson,
    sealReasonerRequest,
    stringifyCanonicalJson,
    type ReasonerRequest,
    type RequiredTool,
} from '../src/index.js';
import { hasCanonicalKeyOrder } from '../src/native.js';
import { isOpenedResponse, openedOutputDigest } from '../src/sealed.js';

type Json = any;

interface Verdict {
    readonly verdict: string;
    readonly detail?: unknown;
}

const FIXTURES = fileURLToPath(new URL('../fixtures/known-answer/', import.meta.url));
/** The reasoner built from this source: ERDEN_REASONER_BIN, or what `pnpm run reasoner:build` writes. */
const SOURCE_BUILD =
    process.env.ERDEN_REASONER_BIN ||
    fileURLToPath(
        new URL(`../../target/release/erden-reasoner${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
    );
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text process.ts reads: no byte-order mark, valid UTF-8. */
function decodeText(bytes: Uint8Array): string | undefined {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return undefined;
    }
    try {
        return UTF8.decode(bytes);
    } catch {
        return undefined;
    }
}

/** Today's verdict: the full public path, every check computed by the public functions from scratch. */
function fullVerdict(request: ReasonerRequest, bytes: Uint8Array, tool: RequiredTool): Verdict {
    const text = decodeText(bytes);
    if (text === undefined) {
        return { verdict: 'malformed' };
    }
    let response;
    try {
        response = decodeReasonerResponseJson(text);
    } catch {
        return { verdict: 'malformed' };
    }
    if (encodeReasonerResponseJson(response) !== text) {
        return { verdict: 'noncanonical' };
    }
    const expectation = makeReasonerTrustExpectation(tool);
    const envelope = getReasonerEnvelopeIssues(request, response, expectation);
    if (envelope.length > 0) {
        return { verdict: 'untrusted-envelope', detail: [...envelope] };
    }
    if (response.result.outcome !== 'decided') {
        return { verdict: 'trusted-negative', detail: response.result.outcome };
    }
    const issues = getReasonerCompatibilityIssues(request, response, expectation);
    return issues.length > 0 ? { verdict: 'untrusted-decided', detail: [...issues] } : { verdict: 'trusted' };
}

/** The kernel's verdict, in process.ts `decodeTrustedResponse` order, on a sealed request and an opened answer. */
function kernelVerdict(request: ReasonerRequest, bytes: Uint8Array, tool: RequiredTool): Verdict {
    const sealed = sealReasonerRequest(request, () => request.requestId).request;
    const text = decodeText(bytes);
    if (text === undefined) {
        return { verdict: 'malformed' };
    }
    let opened;
    try {
        opened = openReasonerResponseJson(text);
    } catch {
        return { verdict: 'malformed' };
    }
    if (!opened.canonical) {
        return { verdict: 'noncanonical' };
    }
    const response = opened.response;
    // The ordered digests and the field comparison apply: the answer is opened and frozen.
    expect(isOpenedResponse(response)).toBe(true);
    expect(Object.isFrozen(response.result)).toBe(true);
    const expectation = makeReasonerTrustExpectation(tool);
    const envelope = getReasonerEnvelopeIssues(sealed, response, expectation);
    if (envelope.length > 0) {
        return { verdict: 'untrusted-envelope', detail: [...envelope] };
    }
    if (response.result.outcome !== 'decided') {
        return { verdict: 'trusted-negative', detail: response.result.outcome };
    }
    const issues = getReasonerCompatibilityIssues(sealed, response, expectation);
    return issues.length > 0 ? { verdict: 'untrusted-decided', detail: [...issues] } : { verdict: 'trusted' };
}

/** Both verdicts, which must be the same. */
function verdicts(request: ReasonerRequest, bytes: Uint8Array, tool = request.requiredTool) {
    return { full: fullVerdict(request, bytes, tool), kernel: kernelVerdict(request, bytes, tool) };
}

function both(verdict: Verdict) {
    return { full: verdict, kernel: verdict };
}

// #region Known answers for the canonical check

/**
 * A decided answer with one diagnostic whose message is `message` (written by the full canonical writer), so the
 * text carries the characters the canonical check must treat exactly as the writer does.
 */
function answerWithMessage(message: string): string {
    const fixture = KNOWN_ANSWER_FIXTURES.find((item) => item.scenario === 'subclass-type');
    if (fixture === undefined) {
        throw new TypeError('missing fixture');
    }
    const response: Json = JSON.parse(fixture.responseJson);
    response.result.diagnostics = [{ axiomIds: [], code: 'probe', message, severity: 'warning' }];
    return encodeReasonerResponseJson(response);
}

/** Whether the full check finds `text` canonical. */
function fullCanonical(text: string): boolean {
    try {
        assertCanonicalReasonerResponseJson(text);
        return true;
    } catch {
        return false;
    }
}

describe('the native canonical check (E1-S5)', () => {
    it('writes awkward text exactly as the canonical writer, and both decide its canonical form alike', () => {
        // [label, the message, the text the canonical writer must give it inside JSON]
        const written: ReadonlyArray<readonly [string, string, string]> = [
            ['a quote and a backslash', 'say "hi" \\ bye', String.raw`"say \"hi\" \\ bye"`],
            ['short escapes', 'a\nb\tc\rd\be\ff', String.raw`"a\nb\tc\rd\be\ff"`],
            ['other controls as lower-case \\u escapes', '\u0000\u001f\u007f', '"\\u0000\\u001f\u007f"'],
            ['non-ASCII text, unescaped', 'café 東京 ü', '"café 東京 ü"'],
            ['an astral character, unescaped', '😀', '"😀"'],
            ['line and paragraph separators, unescaped', '  ', '"  "'],
            ['a lone high surrogate, as a lower-case escape', 'x\uD800y', '"x\\ud800y"'],
            ['a lone low surrogate, as a lower-case escape', '\uDFFF', '"\\udfff"'],
            ['a slash, unescaped', 'a/b', '"a/b"'],
            ['an HTML-looking string, unescaped', '</script>', '"</script>"'],
        ];
        for (const [label, message, inside] of written) {
            const text = answerWithMessage(message);
            expect(text, label).toContain(`"message":${inside}`);
            expect(stringifyCanonicalJson(message), label).toBe(`${inside}\n`);
            expect(`${JSON.stringify(message)}\n`, label).toBe(stringifyCanonicalJson(message));
            expect(fullCanonical(text), label).toBe(true);
            const opened = openReasonerResponseJson(text);
            expect(opened.canonical, label).toBe(true);
            const { certificate: _certificate, ...evidence } = decodeReasonerResponseJson(text).result as Json;
            void _certificate;
            expect(openedOutputDigest(opened.response), label).toBe(computeDecidedOutputDigest(evidence));
        }
    });

    it('refuses every other spelling of the same answer, as the full check does', () => {
        const base = answerWithMessage('x\uD800y é 😀 \u001f');
        const variants: ReadonlyArray<readonly [string, string]> = [
            ['a lone surrogate escaped in upper case', base.replace('\\ud800', '\\uD800')],
            ['a lone surrogate written raw', base.replace('\\ud800', '\uD800')],
            ['non-ASCII text escaped', base.replace('é', '\\u00e9')],
            ['an astral character as an escaped pair', base.replace('😀', '\\ud83d\\ude00')],
            ['a control escaped in upper case', base.replace('\\u001f', '\\u001F')],
            ['an escaped letter', base.replace('"requestId":"k', '"requestId":"\\u006b')],
            ['an escaped slash', base.replace('"https://', '"https:\\/\\/')],
            ['protocolVersion written 1.0', base.replace('"protocolVersion":1,', '"protocolVersion":1.0,')],
            ['protocolVersion written 1e0', base.replace('"protocolVersion":1,', '"protocolVersion":1e0,')],
            ['protocolVersion written 10e-1', base.replace('"protocolVersion":1,', '"protocolVersion":10e-1,')],
            ['a space after a colon', base.replace('"kind":"ReasonerResponse"', '"kind": "ReasonerResponse"')],
            ['no final newline', base.slice(0, -1)],
            ['a final CRLF', `${base.slice(0, -1)}\r\n`],
            ['two final newlines', `${base}\n`],
            ['leading whitespace', ` ${base}`],
            [
                'two keys swapped',
                base.replace(
                    /"kind":"ReasonerResponse","profile":(\{[^}]*\})/u,
                    '"profile":$1,"kind":"ReasonerResponse"',
                ),
            ],
            [
                'a duplicated key',
                base.replace('"kind":"ReasonerResponse"', '"kind":"ReasonerResponse","kind":"ReasonerResponse"'),
            ],
        ];
        for (const [label, text] of variants) {
            expect(text, label).not.toBe(base);
            const full = fullCanonical(text);
            let opened: boolean | 'malformed';
            try {
                opened = openReasonerResponseJson(text).canonical;
            } catch {
                opened = 'malformed';
            }
            expect(opened === true, label).toBe(false);
            // Where the full check decodes the text, it finds it non-canonical too; malformed text stays malformed.
            expect(full, label).toBe(false);
        }
    });

    it('checks key order in one walk, refusing integer-like keys whose order JSON.parse does not keep', () => {
        expect(hasCanonicalKeyOrder(JSON.parse('{"a":1,"b":{"c":[{"d":null,"e":true}]}}'))).toBe(true);
        expect(hasCanonicalKeyOrder(JSON.parse('{"b":1,"a":2}'))).toBe(false);
        expect(hasCanonicalKeyOrder(JSON.parse('{"a":[{"y":1,"x":2}]}'))).toBe(false);
        // Code-unit order, as the canonical writer sorts: upper case before lower case, "Z" before "a".
        expect(hasCanonicalKeyOrder(JSON.parse('{"Z":1,"a":2}'))).toBe(true);
        expect(hasCanonicalKeyOrder(JSON.parse('{"a":1,"Z":2}'))).toBe(false);
        // Written in order, but JavaScript enumerates "2" before "10": refused whatever the order.
        expect(hasCanonicalKeyOrder(JSON.parse('{"10":1,"2":2}'))).toBe(false);
        expect(hasCanonicalKeyOrder(JSON.parse('{"2":1,"10":2}'))).toBe(false);
        expect(hasCanonicalKeyOrder(JSON.parse('{"0":1}'))).toBe(false);
        // Not integer-like: ordered as text.
        expect(hasCanonicalKeyOrder(JSON.parse('{"01":1,"1a":2}'))).toBe(true);
    });

    it('opens every known-answer fixture canonical, as parsed, with the digests the public functions give', () => {
        for (const fixture of KNOWN_ANSWER_FIXTURES) {
            const opened = openReasonerResponseJson(fixture.responseJson);
            expect(opened.canonical, fixture.scenario).toBe(true);
            expect(`${JSON.stringify(opened.response)}\n`).toBe(fixture.responseJson);
            expect(opened.response).toEqual(fixture.response);
            const request = sealReasonerRequest(fixture.request, () => fixture.request.requestId).request;
            const tool = fixture.request.requiredTool;
            expect(kernelVerdict(request, Buffer.from(fixture.responseJson), tool)).toEqual(
                fullVerdict(fixture.request, Buffer.from(fixture.responseJson), tool),
            );
        }
    });
});

// #endregion

// #region The prototype's parity variants

/** Recomputes every digest of a decided answer, as a dishonest engine would, and writes canonical bytes. */
function resignAll(input: Json): Buffer {
    let response = input;
    const result = response.result;
    if (result.outcome === 'decided') {
        for (const statement of result.inferred) {
            statement.provenance.premiseIds.sort();
            statement.provenance.justificationDigest = computeInferredJustificationDigest(statement);
        }
        for (const item of result.unsatisfiableClasses) {
            item.premiseIds.sort();
            item.justificationDigest = computeUnsatisfiableJustificationDigest(item);
        }
        let normalized = result;
        try {
            normalized = normalizeReasonerResponse(response).result;
        } catch {
            // Duplicate ids cannot be normalized; keep the order they have.
        }
        const { certificate, ...evidence } = normalized;
        certificate.outputDigest = computeDecidedOutputDigest(evidence);
        certificate.justificationDigest = computeAggregateJustificationDigest(evidence);
        certificate.certificateDigest = computeCertificateDigest(certificate);
        response = { ...response, result: { ...normalized, certificate } };
    }
    return Buffer.from(stringifyCanonicalJson(response));
}

function inferredWithInferredPremise(result: Json): Json {
    const ids = new Set(result.inferred.map((item: Json) => item.id));
    return result.inferred.find((item: Json) => item.provenance.premiseIds.some((id: string) => ids.has(id)));
}

type Mutation = (text: string, response: Json, request: ReasonerRequest) => Buffer | undefined;

const MUTATIONS: ReadonlyArray<readonly [string, Mutation]> = [
    ['unchanged', (text) => Buffer.from(text)],
    ['space after the first brace', (text) => Buffer.from(`{ ${text.slice(1)}`)],
    ['a UTF-8 byte-order mark', (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])],
    [
        'an invalid UTF-8 byte',
        (text) => Buffer.concat([Buffer.from(text.slice(0, -2)), Buffer.from([0xff, 0x7d, 0x0a])]),
    ],
    ['an unknown result field', (text) => Buffer.from(text.replace('"result":{', '"result":{"aaa":1,'))],
    [
        'protocolVersion written 1.0',
        (text) => Buffer.from(text.replace('"protocolVersion":1,', '"protocolVersion":1.0,')),
    ],
    [
        'an escaped letter in the request id',
        (text) => Buffer.from(text.replace('"requestId":"k', '"requestId":"\\u006b')),
    ],
    [
        'another request id',
        (_text, response) => resignAll({ ...response, requestId: `${String(response.requestId)}x` }),
    ],
    ['another input digest', (_text, response) => resignAll({ ...response, inputDigest: `sha256:${'1'.repeat(64)}` })],
    [
        'a tampered certificate digest',
        (_text, response) => {
            if (response.result.outcome !== 'decided') {
                return undefined;
            }
            response.result.certificate.certificateDigest = `sha256:${'2'.repeat(64)}`;
            return Buffer.from(stringifyCanonicalJson(response));
        },
    ],
    [
        'a tampered justification digest',
        (_text, response) => {
            const statement = response.result.inferred?.[0];
            if (statement === undefined) {
                return undefined;
            }
            statement.provenance.justificationDigest = `sha256:${'3'.repeat(64)}`;
            return Buffer.from(stringifyCanonicalJson(response));
        },
    ],
    [
        'two inferred statements swapped',
        (_text, response) => {
            const inferred = response.result.inferred;
            if (inferred === undefined || inferred.length < 2) {
                return undefined;
            }
            [inferred[0], inferred[1]] = [inferred[1], inferred[0]];
            return Buffer.from(`${JSON.stringify(response)}\n`);
        },
    ],
    [
        'an unknown proof rule',
        (_text, response) => {
            const statement = response.result.inferred?.[0];
            if (statement === undefined) {
                return undefined;
            }
            statement.provenance.rule = 'modus-ponens';
            return Buffer.from(stringifyCanonicalJson(response));
        },
    ],
    [
        're-signed: a duplicated inferred id',
        (_text, response) => {
            const inferred = response.result.inferred;
            if (inferred === undefined || inferred.length < 2) {
                return undefined;
            }
            inferred[1].id = inferred[0].id;
            return resignAll(response);
        },
    ],
    [
        're-signed: a conclusion with another object',
        (_text, response) => {
            const statement = response.result.inferred?.find((item: Json) => typeof item.object === 'string');
            if (statement === undefined) {
                return undefined;
            }
            statement.object = `${String(statement.object)}Forged`;
            return resignAll(response);
        },
    ],
    [
        're-signed: a premise dropped',
        (_text, response) => {
            const statement = response.result.inferred?.find((item: Json) => item.provenance.premiseIds.length > 1);
            if (statement === undefined) {
                return undefined;
            }
            statement.provenance.premiseIds = statement.provenance.premiseIds.slice(1);
            return resignAll(response);
        },
    ],
    [
        're-signed: an unknown premise',
        (_text, response) => {
            const statement = response.result.inferred?.[0];
            if (statement === undefined) {
                return undefined;
            }
            statement.provenance.premiseIds = [...statement.provenance.premiseIds, 'axiom:does-not-exist'];
            return resignAll(response);
        },
    ],
    [
        're-signed: a derivation cycle',
        (_text, response) => {
            const statement = response.result.inferred && inferredWithInferredPremise(response.result);
            if (statement === undefined) {
                return undefined;
            }
            const premise = response.result.inferred.find((item: Json) =>
                statement.provenance.premiseIds.includes(item.id),
            );
            premise.provenance.premiseIds = [...premise.provenance.premiseIds, statement.id];
            return resignAll(response);
        },
    ],
    [
        're-signed: inconsistent without evidence',
        (_text, response) => {
            if (response.result.outcome !== 'decided') {
                return undefined;
            }
            response.result.consistency = 'inconsistent';
            return resignAll(response);
        },
    ],
    [
        're-signed: an unsatisfiable class without evidence',
        (_text, response) => {
            if (response.result.outcome !== 'decided') {
                return undefined;
            }
            const premise = response.result.asserted[0]?.id ?? response.result.inferred[0]?.id;
            if (premise === undefined) {
                return undefined;
            }
            response.result.unsatisfiableClasses.push({
                classIri: 'https://example.org/Forged',
                premiseIds: [premise],
                justificationDigest: `sha256:${'0'.repeat(64)}`,
            });
            return resignAll(response);
        },
    ],
    [
        're-signed: an asserted statement with another subject',
        (_text, response) => {
            const statement = response.result.asserted?.[0];
            if (statement === undefined) {
                return undefined;
            }
            statement.subject = `${String(statement.subject)}Forged`;
            return resignAll(response);
        },
    ],
    [
        're-signed: a legitimate asserted statement with a literal object',
        (_text, response, request) => {
            const axiom: Json = request.ontology.axioms.find(
                (item) =>
                    (item.kind === 'DataPropertyAssertion' || item.kind === 'AnnotationAssertion') &&
                    item.provenance.status === 'available',
            );
            if (response.result.outcome !== 'decided' || axiom === undefined) {
                return undefined;
            }
            response.result.asserted.push({
                graph: { kind: 'DefaultGraph' },
                id: `statement:parity-${String(axiom.id)}`,
                subject: axiom.subject,
                predicate: axiom.property,
                object: axiom.value,
                provenance: {
                    kind: 'asserted',
                    axiomId: axiom.id,
                    sourceId: axiom.provenance.sourceId,
                    sourceDigest: axiom.provenance.sourceDigest,
                },
            });
            return resignAll(response);
        },
    ],
];

describe("the verifier prototype's parity variants through the kernel's path (E1-S5)", () => {
    it('gives every variant of every known-answer fixture the verdict of the full public path', () => {
        const rows: Record<string, string> = {};
        const expected: Record<string, string> = {};
        const kinds = new Set<string>();
        for (const fixture of KNOWN_ANSWER_FIXTURES) {
            const request = fixture.request;
            const tool = request.requiredTool;
            const variants: Array<readonly [string, Buffer | undefined, RequiredTool]> = MUTATIONS.map(
                ([name, mutate]) => [
                    name,
                    mutate(fixture.responseJson, JSON.parse(fixture.responseJson), request),
                    tool,
                ],
            );
            variants.push([
                'a different pinned tool',
                Buffer.from(fixture.responseJson),
                { ...tool, version: `${tool.version}-other` },
            ]);
            for (const [name, bytes, pinned] of variants) {
                if (bytes === undefined) {
                    continue;
                }
                const { full, kernel } = verdicts(request, bytes, pinned);
                const label = `${fixture.scenario} / ${name}`;
                rows[label] = JSON.stringify(kernel);
                expected[label] = JSON.stringify(full);
                kinds.add(full.verdict);
            }
        }
        expect(rows).toEqual(expected);
        expect(Object.keys(rows)).toHaveLength(181);
        expect([...kinds].sort()).toEqual([
            'malformed',
            'noncanonical',
            'trusted',
            'trusted-negative',
            'untrusted-decided',
            'untrusted-envelope',
        ]);
    });
});

// #endregion

// #region The prototype's regression cases

/** Recomputes every digest of a decided answer and writes its canonical bytes, as a dishonest engine would. */
function resign(response: Json): Buffer {
    const normalized: Json = normalizeReasonerResponse(response);
    const { certificate, ...evidence } = normalized.result;
    certificate.inputDigest = normalized.inputDigest;
    certificate.outputDigest = computeDecidedOutputDigest(evidence);
    certificate.justificationDigest = computeAggregateJustificationDigest(evidence);
    certificate.certificateDigest = computeCertificateDigest(certificate);
    return Buffer.from(stringifyCanonicalJson({ ...normalized, result: { ...evidence, certificate } }));
}

function read(fixture: string, kind: 'request' | 'response'): string {
    return readFileSync(`${FIXTURES}${fixture}.${kind}.json`, 'utf8');
}

/** A request with its input digest bound to its (changed) content. */
function rebound(draft: Json): ReasonerRequest {
    return { ...draft, ontology: { ...draft.ontology, digest: computeReasonerInputDigest(draft) } };
}

/** The fixture's answer with an asserted statement added for `axiom`. */
function withAssertedStatement(text: string, axiom: Json): Json {
    const response = JSON.parse(text);
    response.result.asserted.push({
        graph: { kind: 'DefaultGraph' },
        id: `statement:probe-${String(axiom.id)}`,
        subject: axiom.subject,
        predicate: axiom.property,
        object: axiom.value,
        provenance: {
            kind: 'asserted',
            axiomId: axiom.id,
            sourceId: axiom.provenance.sourceId,
            sourceDigest: axiom.provenance.sourceDigest,
        },
    });
    return response;
}

const EX = 'https://example.test/erden/reasoner#';
const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';

describe("the verifier prototype's regression cases through the kernel's path (E1-S5)", () => {
    it('refuses an inconsistency citing two assertions of the same class', () => {
        const request = decodeReasonerRequestJson(read('inconsistency', 'request'));
        const response = JSON.parse(read('inconsistency', 'response'));
        const person = `${EX}Person`;
        // a3 now asserts alice a Person, as a2 does: nothing is a Machine, so the ontology is consistent.
        const axioms = request.ontology.axioms.map((axiom) =>
            axiom.id === 'a3' ? { ...axiom, classExpression: { kind: 'NamedClass', iri: person } } : axiom,
        );
        const consistent = rebound({ ...request, ontology: { ...request.ontology, axioms } });
        response.inputDigest = consistent.ontology.digest;
        for (const statement of response.result.asserted) {
            if (statement.provenance.axiomId === 'a3') {
                statement.object = person;
            }
        }
        expect(response.result.consistency).toBe('inconsistent');
        const decoded = decodeReasonerRequestJson(encodeReasonerRequestJson(consistent));
        expect(verdicts(decoded, resign(response))).toEqual(
            both({ verdict: 'untrusted-decided', detail: ['invalid-inconsistency-evidence'] }),
        );
    });

    it('trusts a legitimate asserted statement with a literal object whatever the key order of the request', () => {
        const wire = read('current-demo-constructs', 'request');
        const text = read('current-demo-constructs', 'response');
        const decoded = decodeReasonerRequestJson(wire);
        const literals: Json[] = decoded.ontology.axioms.filter(
            (item) => item.kind === 'DataPropertyAssertion' || item.kind === 'AnnotationAssertion',
        );
        expect(literals.map((item) => item.kind).sort()).toEqual(['AnnotationAssertion', 'DataPropertyAssertion']);
        for (const axiom of literals) {
            const response = withAssertedStatement(text, axiom);
            response.inputDigest = decoded.ontology.digest;
            const bytes = resign(response);
            // The answer's literal has its keys in canonical order; the request's in schema order (decoded) or in
            // the reverse order (as normalize.ts might build it). A JSON.stringify comparison would refuse one.
            const { kind, lexicalForm, datatype, language } = axiom.value;
            const reordered: ReasonerRequest = {
                ...decoded,
                ontology: {
                    ...decoded.ontology,
                    axioms: decoded.ontology.axioms.map((item) =>
                        item.id === axiom.id
                            ? ({ ...item, value: { language, datatype, lexicalForm, kind } } as Json)
                            : item,
                    ),
                },
            };
            const literal: Json = reordered.ontology.axioms.find((item) => item.id === axiom.id);
            expect(Object.keys(literal.value)).toEqual(['language', 'datatype', 'lexicalForm', 'kind']);
            expect(JSON.stringify(literal.value)).not.toBe(JSON.stringify(axiom.value));
            expect(verdicts(decoded, bytes), axiom.kind).toEqual(both({ verdict: 'trusted' }));
            expect(verdicts(reordered, bytes), axiom.kind).toEqual(both({ verdict: 'trusted' }));
        }
    });

    it('trusts a legitimate asserted statement for an IRI-valued annotation, and refuses one with a literal', () => {
        const decoded = decodeReasonerRequestJson(read('current-demo-constructs', 'request'));
        const annotation: Json = decoded.ontology.axioms.find((item) => item.kind === 'AnnotationAssertion');
        const iri = `${EX}seeAlso`;
        const axioms = decoded.ontology.axioms.map((item) => (item === annotation ? { ...item, value: iri } : item));
        const request = rebound({ ...decoded, ontology: { ...decoded.ontology, axioms } });
        const original = JSON.parse(read('current-demo-constructs', 'response'));
        original.inputDigest = request.ontology.digest;
        const text = JSON.stringify(original);
        const axiom = request.ontology.axioms.find((item) => item.id === annotation.id);
        const honest = withAssertedStatement(text, axiom);
        expect(verdicts(request, resign(honest))).toEqual(both({ verdict: 'trusted' }));
        const forged = withAssertedStatement(text, { ...axiom, value: annotation.value });
        expect(verdicts(request, resign(forged))).toEqual(
            both({ verdict: 'untrusted-decided', detail: ['asserted-statement'] }),
        );
    });

    it('trusts an answer that leaves something out: no verifier checks omissions', () => {
        const omissions: ReadonlyArray<readonly [string, (result: Json) => void]> = [
            [
                'inconsistency',
                (result) => {
                    result.consistency = 'consistent';
                    result.diagnostics = result.diagnostics.filter(
                        (item: Json) => item.code !== 'disjoint-class-assertions',
                    );
                },
            ],
            [
                'unsatisfiable-classes',
                (result) => {
                    result.unsatisfiableClasses = [];
                },
            ],
            [
                'subclass-type',
                (result) => {
                    result.inferred = [];
                },
            ],
        ];
        for (const [fixture, omit] of omissions) {
            const response = JSON.parse(read(fixture, 'response'));
            const before = JSON.stringify(response.result);
            omit(response.result);
            expect(JSON.stringify(response.result), fixture).not.toBe(before);
            const request = decodeReasonerRequestJson(read(fixture, 'request'));
            expect(verdicts(request, resign(response)), fixture).toEqual(both({ verdict: 'trusted' }));
        }
    });

    // An input with any construct beyond V1 is answered by the Horn calculus, whose union domains are decided by case
    // analysis (`union-case`) instead of V1's `union-domain-type` step. The regression runs on the reasoner built from
    // this source (`pnpm run reasoner:build`, or ERDEN_REASONER_BIN).
    it.skipIf(!existsSync(SOURCE_BUILD))(
        "trusts the engine's case analysis over a union domain and refuses it forged",
        () => {
            const base = decodeReasonerRequestJson(read('subclass-type', 'request'));
            const first: Json = base.ontology.axioms[0];
            const { provenance: template, graph } = first;
            function named(iri: string): Json {
                return { kind: 'NamedClass', iri };
            }
            function axiom(id: string, body: Json): Json {
                return { id, graph, provenance: { ...template, locator: `fixture.ttl#${id}` }, ...body };
            }
            const axioms = [
                axiom('d1', {
                    kind: 'PropertyDomain',
                    propertyKind: 'ObjectProperty',
                    property: `${EX}plays`,
                    domain: { kind: 'ObjectUnionOf', operands: [`${EX}A`, `${EX}B`] },
                }),
                axiom('p1', {
                    kind: 'ObjectPropertyAssertion',
                    property: `${EX}plays`,
                    subject: `${EX}x`,
                    object: `${EX}y`,
                }),
                axiom('s1', { kind: 'SubClassOf', subClass: named(`${EX}A`), superClass: named(`${EX}C`) }),
                axiom('s2', { kind: 'SubClassOf', subClass: named(`${EX}B`), superClass: named(`${EX}C`) }),
                axiom('t1', { kind: 'SubClassOf', subClass: named(OWL_THING), superClass: named(`${EX}D`) }),
                // An EL axiom unrelated to the rest: a V1-only input is still answered by the 0.2 procedure.
                axiom('u1', {
                    kind: 'SubClassOf',
                    subClass: named(`${EX}Unrelated`),
                    superClass: {
                        kind: 'ObjectSomeValuesFrom',
                        property: `${EX}unrelated`,
                        filler: named(`${EX}Other`),
                    },
                }),
            ];
            function ask(requiredTool: Json) {
                const request = rebound({
                    ...base,
                    requestId: 'regression:case-analysis',
                    requiredTool,
                    ontology: { ...base.ontology, axioms },
                });
                const wire = encodeReasonerRequestJson(request);
                return { wire, run: spawnSync(SOURCE_BUILD, [], { input: wire, maxBuffer: 1 << 26 }) };
            }
            // A placeholder identity is answered `incompatible`, with the identity the build has.
            const probe = ask({ ...base.requiredTool, executableDigest: `sha256:${'0'.repeat(64)}` });
            const { wire, run } = ask(JSON.parse(probe.run.stdout.toString('utf8')).tool);
            expect(run.status, run.stderr.toString()).toBe(0);
            const decoded = decodeReasonerRequestJson(wire);
            const bytes = run.stdout;
            const answer = JSON.parse(bytes.toString('utf8'));
            const inferred = answer.result.inferred as Json[];
            // x plays, so x is an A or a B, and a C either way; owl:Thing ⊑ D makes x a D.
            const caseStep = inferred.find(
                (item: Json) => item.provenance.rule === 'union-case' && item.object === `${EX}C`,
            );
            expect(caseStep).toMatchObject({ subject: `${EX}x` });
            expect(inferred.some((item: Json) => item.subject === `${EX}x` && item.object === `${EX}D`)).toBe(true);
            expect(verdicts(decoded, bytes)).toEqual(both({ verdict: 'trusted' }));

            // Drop a premise of the case analysis: one case is no longer shown to reach C.
            const forged = JSON.parse(bytes.toString('utf8'));
            const step = (forged.result.inferred as Json[]).find((item: Json) => item.id === caseStep.id);
            step.provenance.premiseIds = step.provenance.premiseIds.slice(0, -1);
            step.provenance.justificationDigest = computeInferredJustificationDigest(step);
            const refused = verdicts(decoded, resign(forged));
            expect(refused.full.verdict).toBe('untrusted-decided');
            expect(refused.kernel.verdict).toBe('untrusted-decided');
        },
    );

    it('refuses a consistent answer that lists owl:Thing as unsatisfiable', () => {
        const impossible = `${EX}Impossible`;
        function rename(text: string): string {
            return text.replaceAll(JSON.stringify(impossible), JSON.stringify(OWL_THING));
        }
        const request = rebound(decodeReasonerRequestJson(rename(read('unsatisfiable-classes', 'request'))));
        const response = JSON.parse(rename(read('unsatisfiable-classes', 'response')));
        response.inputDigest = request.ontology.digest;
        for (const item of response.result.unsatisfiableClasses) {
            item.justificationDigest = computeUnsatisfiableJustificationDigest(item);
        }
        expect(response.result.consistency).toBe('consistent');
        expect(response.result.unsatisfiableClasses.map((item: Json) => item.classIri)).toEqual([OWL_THING]);
        const decoded = decodeReasonerRequestJson(encodeReasonerRequestJson(request));
        expect(verdicts(decoded, resign(response))).toEqual(
            both({ verdict: 'untrusted-decided', detail: ['invalid-unsatisfiable-evidence'] }),
        );
    });
});

// #endregion
