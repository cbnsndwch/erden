// Writing a request and reading an answer with each canonical serialization done once. The input digest is the
// SHA-256 of the canonical text of the request's axioms and sources, and the wire contains that same text; the
// output digest is the SHA-256 of the canonical text of the answer's evidence, which the canonical answer contains.
// So both digests are hashed from text written once, instead of writing the same JSON again for each digest.
import { createHash } from 'node:crypto';

import { Schema } from 'effect';

import {
    decodeReasonerResponseJson,
    normalizeClassExpression,
    normalizeReasonerRequest,
    normalizeReasonerResponse,
    stringifyCanonicalJson,
    type JsonObject,
    type JsonValue,
} from './canonical.js';
import { hasCanonicalKeyOrder } from './native.js';
import { compareText, diagnosticSortKey, statementSortKey } from './order.js';
import {
    ReasonerRequest as ReasonerRequestSchema,
    ReasonerResponse as ReasonerResponseSchema,
    type ReasonerRequest,
    type ReasonerResponse,
} from './schema.js';
import { rememberOpenedResponse, rememberSealedRequest } from './sealed.js';

const STRICT_OPTIONS = { onExcessProperty: 'error' as const };

function sha256(text: string): string {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** `stringifyCanonicalJson(value)` without its final newline: the text the value has inside canonical JSON. */
function canonicalText(value: JsonValue): string {
    return stringifyCanonicalJson(value).slice(0, -1);
}

/**
 * The canonical text of an object whose members' canonical texts are given, some written already: the members in
 * the order the canonical writer gives an object with these keys (sorted, then as JavaScript orders own keys).
 */
function canonicalObjectText(members: Readonly<Record<string, string>>): string {
    const order = Object.keys(
        Object.fromEntries(
            Object.keys(members)
                .sort(compareText)
                .map((key) => [key, 0]),
        ),
    );
    return `{${order.map((key) => `${JSON.stringify(key)}:${members[key] ?? ''}`).join(',')}}`;
}

/** The canonical text of `value` with the members named in `written` taken from text already written. */
function canonicalTextWith(value: JsonObject, written: Readonly<Record<string, string>>): string {
    return canonicalObjectText(
        Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, written[key] ?? canonicalText(item)] as const),
        ),
    );
}

/** Why `sealReasonerRequest` refused a draft: before its digest could be computed, or against the schema. */
export class ReasonerRequestSealError extends TypeError {
    readonly stage: 'digest' | 'schema';

    constructor(stage: 'digest' | 'schema', cause: unknown) {
        super(
            stage === 'digest'
                ? 'Could not compute the canonical reasoner input digest'
                : 'Reasoner request does not satisfy the strict V1 request schema',
            { cause },
        );
        this.name = 'ReasonerRequestSealError';
        this.stage = stage;
    }
}

export interface SealedReasonerRequest {
    /** The canonical request, frozen; its `ontology.digest` and `requestId` are bound to its content. */
    readonly request: ReasonerRequest;
    /** Its canonical JSON, exactly `encodeReasonerRequestJson(request)`. */
    readonly wire: string;
}

/**
 * Binds a draft request to its content and writes it: normalizes it once, writes the canonical text of its axioms
 * and sources once, hashes that text for the input digest, names the request with `requestIdFor(digest)`, checks
 * the result against the schema once and splices the same text into the wire. The draft's `ontology.digest` and
 * `requestId` are replaced. The sealed request is frozen and shares the draft's axiom and source objects, which are
 * frozen with it. The trust checks read the digest of a request sealed here instead of computing it again.
 */
export function sealReasonerRequest(
    draft: ReasonerRequest,
    requestIdFor: (inputDigest: string) => string,
): SealedReasonerRequest {
    let normalized: ReasonerRequest;
    let axiomsText: string;
    let sourcesText: string;
    let inputDigest: string;
    let request: ReasonerRequest;
    try {
        normalized = normalizeReasonerRequest(draft);
        axiomsText = canonicalText(normalized.ontology.axioms);
        sourcesText = canonicalText(normalized.ontology.sources);
        inputDigest = sha256(`${canonicalObjectText({ axioms: axiomsText, sources: sourcesText })}\n`);
        request = {
            ...normalized,
            profile: { ...normalized.profile },
            requiredTool: { ...normalized.requiredTool },
            limits: { ...normalized.limits },
            requestId: requestIdFor(inputDigest),
            ontology: { ...normalized.ontology, digest: inputDigest },
        };
    } catch (cause) {
        throw new ReasonerRequestSealError('digest', cause);
    }
    try {
        Schema.decodeUnknownSync(ReasonerRequestSchema, STRICT_OPTIONS)(request);
    } catch (cause) {
        throw new ReasonerRequestSealError('schema', cause);
    }
    const value = request as unknown as JsonObject;
    const ontologyText = canonicalTextWith(value.ontology as JsonObject, { axioms: axiomsText, sources: sourcesText });
    const wire = `${canonicalTextWith(value, { ontology: ontologyText })}\n`;
    return Object.freeze({ request: rememberSealedRequest(request, inputDigest), wire });
}

export interface OpenedReasonerResponse {
    /** The decoded answer: the parsed text, frozen, when it was canonical; otherwise decoded in canonical order. */
    readonly response: ReasonerResponse;
    /** Whether the text is exactly the canonical encoding of `response`. */
    readonly canonical: boolean;
}

function isSorted(values: ReadonlyArray<string>): boolean {
    for (let index = 1; index < values.length; index += 1) {
        if (compareText(values[index - 1] ?? '', values[index] ?? '') > 0) {
            return false;
        }
    }
    return true;
}

function hasDuplicates(values: ReadonlyArray<string>): boolean {
    return new Set(values).size !== values.length;
}

function normalDiagnostics(diagnostics: ReasonerResponse['result']['diagnostics']): boolean {
    return (
        diagnostics.every((diagnostic) => isSorted(diagnostic.axiomIds)) &&
        isSorted(diagnostics.map((diagnostic) => diagnosticSortKey(diagnostic)))
    );
}

type Lemmas = Extract<ReasonerResponse['result'], { readonly outcome: 'decided' }>['lemmas'];

/** Whether lemmas are in normalized order: by identifier, premises sorted, every conclusion's expressions normalized. */
function normalLemmas(lemmas: Lemmas): boolean {
    if (lemmas === undefined) {
        return true;
    }
    return (
        !hasDuplicates(lemmas.map((lemma) => lemma.id)) &&
        isSorted(lemmas.map((lemma) => lemma.id)) &&
        lemmas.every((lemma) => {
            const expressions =
                lemma.conclusion.kind === 'SubClassOf'
                    ? [lemma.conclusion.subClass, lemma.conclusion.superClass]
                    : [lemma.conclusion.classExpression];
            return (
                isSorted(lemma.premiseIds) &&
                // The parsed expression's keys are in canonical order already, so its JSON.stringify is its canonical
                // text; normalization (operand order) must leave that text unchanged.
                expressions.every(
                    (expression) =>
                        canonicalText(normalizeClassExpression(expression) as unknown as JsonValue) ===
                        JSON.stringify(expression),
                )
            );
        })
    );
}

/**
 * Whether `normalizeReasonerResponse` would return the answer as it is: every array it sorts is already in its order
 * (a stable sort leaves an array alone exactly when its sort keys do not descend). False for an answer with duplicate
 * statement identifiers, which normalization refuses.
 */
function isNormalResponse(response: ReasonerResponse): boolean {
    const result = response.result;
    if (result.outcome !== 'decided') {
        return normalDiagnostics(result.diagnostics);
    }
    return (
        !hasDuplicates(result.asserted.map((statement) => statement.id)) &&
        !hasDuplicates(result.inferred.map((statement) => statement.id)) &&
        isSorted(result.asserted.map((statement) => statementSortKey(statement))) &&
        result.inferred.every((statement) => isSorted(statement.provenance.premiseIds)) &&
        isSorted(result.inferred.map((statement) => statementSortKey(statement))) &&
        normalLemmas(result.lemmas) &&
        result.unsatisfiableClasses.every((item) => isSorted(item.premiseIds)) &&
        isSorted(result.unsatisfiableClasses.map((item) => item.classIri)) &&
        normalDiagnostics(result.diagnostics)
    );
}

/** `"key":` followed by the member's text, for an object written member by member. */
function memberText(key: string, text: string): string {
    return `${JSON.stringify(key)}:${text}`;
}

/**
 * The text of a parsed answer whose keys are in canonical order, each member written once by `JSON.stringify`, and
 * the output digest of its evidence (the decided result without its certificate), hashed from the same member texts.
 */
function writeOrderedResponse(value: JsonObject): { readonly text: string; readonly outputDigest: string | undefined } {
    const result = value.result as JsonObject;
    let resultText: string | undefined;
    let outputDigest: string | undefined;
    if (result.outcome === 'decided') {
        const members = Object.keys(result).map((key) => memberText(key, JSON.stringify(result[key])));
        const evidence = Object.keys(result).flatMap((key, index) =>
            key === 'certificate' ? [] : [members[index] ?? ''],
        );
        outputDigest = sha256(`{${evidence.join(',')}}\n`);
        resultText = `{${members.join(',')}}`;
    }
    const members = Object.keys(value).map((key) =>
        memberText(key, key === 'result' && resultText !== undefined ? resultText : JSON.stringify(value[key])),
    );
    return { text: `{${members.join(',')}}\n`, outputDigest };
}

/**
 * Reads an answer and decides whether its text is canonical, writing it once. The text is parsed once with
 * `JSON.parse` and validated strictly against the schema; one walk checks that every object's keys are in canonical
 * order and none is integer-like, and one more that every array is in normalized order. Then `JSON.stringify` of the
 * parsed answer is its canonical encoding, written member by member once and compared with the text, and the evidence's
 * members are hashed for the output digest the trust checks compare instead of writing it again. A canonical answer is
 * returned as parsed, frozen. Throws as `decodeReasonerResponseJson` does on text that is not one strict V1 response.
 */
export function openReasonerResponseJson(json: string): OpenedReasonerResponse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        // Not JSON at all: refuse with the error the full decoder gives.
        decodeReasonerResponseJson(json);
        throw new TypeError('Reasoner response is not JSON');
    }
    const decoded = Schema.decodeUnknownSync(ReasonerResponseSchema, STRICT_OPTIONS)(parsed);
    const response = parsed as ReasonerResponse;
    if (hasCanonicalKeyOrder(parsed) && isNormalResponse(response)) {
        const { text, outputDigest } = writeOrderedResponse(parsed as JsonObject);
        if (text === json) {
            return Object.freeze({ response: rememberOpenedResponse(response, outputDigest), canonical: true });
        }
    }
    // Not canonical: the answer in canonical order, or the refusal of duplicate statement identifiers.
    return Object.freeze({ response: normalizeReasonerResponse(decoded), canonical: false });
}
