import { Schema } from 'effect';

import { compareText, diagnosticSortKey, statementSortKey } from './order.js';
import type {
    ClassExpression,
    Diagnostic,
    LemmaConclusion,
    NormalizedAxiom,
    ObjectPropertyExpression,
    ReasonerRequest,
    ReasonerResponse,
} from './schema.js';
import {
    ReasonerRequest as ReasonerRequestSchema,
    ReasonerRequestJson,
    ReasonerResponse as ReasonerResponseSchema,
    ReasonerResponseJson,
} from './schema.js';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | JsonObject;
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

const STRICT_OPTIONS = { onExcessProperty: 'error' as const };

function canonicalizeJsonValue(value: JsonValue, ancestors: ReadonlySet<object>): JsonValue {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Canonical JSON cannot contain a non-finite number');
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (ancestors.has(value)) {
        throw new TypeError('Canonical JSON cannot contain a cycle');
    }
    const nextAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        return (value as ReadonlyArray<JsonValue>).map((item) => canonicalizeJsonValue(item, nextAncestors));
    }
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => compareText(left, right))
            .map(([key, item]) => [key, canonicalizeJsonValue(item, nextAncestors)]),
    );
}

export function stringifyCanonicalJson(value: JsonValue): string {
    return `${JSON.stringify(canonicalizeJsonValue(value, new Set()))}\n`;
}

function sortText(values: ReadonlyArray<string>): ReadonlyArray<string> {
    return [...values].sort(compareText);
}

function sortUniqueNonEmptyText(values: readonly [string, ...string[]]): readonly [string, ...string[]] {
    const [first, ...rest] = sortText(values);
    if (first === undefined) {
        throw new TypeError('Expected a non-empty list');
    }
    return [first, ...rest];
}

function sortNonEmpty<T>(values: readonly [T, ...T[]], compare: (left: T, right: T) => number): readonly [T, ...T[]] {
    const [first, ...rest] = [...values].sort(compare);
    if (first === undefined) {
        throw new TypeError('Expected a non-empty list');
    }
    return [first, ...rest];
}

function mapSortNonEmpty<T, U>(
    values: readonly [T, ...T[]],
    map: (value: T) => U,
    compare: (left: U, right: U) => number,
): readonly [U, ...U[]] {
    const [first, ...rest] = values;
    return sortNonEmpty([map(first), ...rest.map(map)], compare);
}

/** A property expression rebuilt with its fields in schema order. */
function normalizePropertyExpression(property: ObjectPropertyExpression): ObjectPropertyExpression {
    return typeof property === 'string' ? property : { kind: 'ObjectInverseOf', property: property.property };
}

/**
 * A class expression rebuilt with its fields in schema order and its unordered operands sorted, so `JSON.stringify` of
 * it is its sort key (`classExpressionKey`), the key V1 already sorts class lists by. Duplicate operands are refused.
 */
export function normalizeClassExpression(expression: ClassExpression): ClassExpression {
    switch (expression.kind) {
        case 'NamedClass':
            return { kind: 'NamedClass', iri: expression.iri };
        case 'ObjectUnionOf':
            assertUnique('ObjectUnionOf.operands', expression.operands);
            return { kind: 'ObjectUnionOf', operands: sortText(expression.operands) };
        case 'ObjectIntersectionOf': {
            const operands = expression.operands
                .map(normalizeClassExpression)
                .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
            assertUnique(
                'ObjectIntersectionOf.operands',
                operands.map((operand) => JSON.stringify(operand)),
            );
            return { kind: 'ObjectIntersectionOf', operands };
        }
        case 'ObjectSomeValuesFrom':
        case 'ObjectAllValuesFrom':
            return {
                kind: expression.kind,
                property: normalizePropertyExpression(expression.property),
                filler: normalizeClassExpression(expression.filler),
            };
        case 'ObjectMaxCardinality':
            return {
                kind: 'ObjectMaxCardinality',
                cardinality: expression.cardinality,
                property: normalizePropertyExpression(expression.property),
                filler: normalizeClassExpression(expression.filler),
            };
        case 'ObjectComplementOf':
            return { kind: 'ObjectComplementOf', operand: normalizeClassExpression(expression.operand) };
        case 'OpaqueClassExpression':
            return {
                kind: 'OpaqueClassExpression',
                constructIri: expression.constructIri,
                canonicalForm: expression.canonicalForm,
            };
        case 'CyclicClassExpression':
            return { kind: 'CyclicClassExpression', expressionId: expression.expressionId };
    }
}

/** The order of class expressions in an unordered list: `JSON.stringify` of the normalized expression. */
export function classExpressionKey(expression: ClassExpression): string {
    return JSON.stringify(normalizeClassExpression(expression));
}

function sortedExpressions(expressions: ReadonlyArray<ClassExpression>): ReadonlyArray<ClassExpression> {
    return expressions
        .map(normalizeClassExpression)
        .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

function sortedProperties(
    properties: ReadonlyArray<ObjectPropertyExpression>,
): ReadonlyArray<ObjectPropertyExpression> {
    const normalized = properties.map(normalizePropertyExpression);
    assertUnique(
        'EquivalentObjectProperties.properties',
        normalized.map((property) => JSON.stringify(property)),
    );
    return normalized.sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

function normalizeAxiom(axiom: NormalizedAxiom): NormalizedAxiom {
    switch (axiom.kind) {
        case 'EquivalentClasses':
        case 'DisjointClasses':
            return { ...axiom, classes: sortedExpressions(axiom.classes) };
        case 'SubClassOf':
            return {
                ...axiom,
                subClass: normalizeClassExpression(axiom.subClass),
                superClass: normalizeClassExpression(axiom.superClass),
            };
        case 'ClassAssertion':
            return { ...axiom, classExpression: normalizeClassExpression(axiom.classExpression) };
        case 'PropertyDomain':
            return { ...axiom, domain: normalizeClassExpression(axiom.domain) };
        case 'PropertyRange':
            return typeof axiom.range === 'string' ? axiom : { ...axiom, range: normalizeClassExpression(axiom.range) };
        case 'SubObjectPropertyOf':
            return {
                ...axiom,
                subProperty:
                    typeof axiom.subProperty !== 'string' && axiom.subProperty.kind === 'ObjectPropertyChain'
                        ? {
                              kind: 'ObjectPropertyChain',
                              properties: axiom.subProperty.properties.map(normalizePropertyExpression),
                          }
                        : normalizePropertyExpression(axiom.subProperty),
                superProperty: normalizePropertyExpression(axiom.superProperty),
            };
        case 'EquivalentObjectProperties':
            return { ...axiom, properties: sortedProperties(axiom.properties) };
        case 'FunctionalObjectProperty':
        case 'InverseFunctionalObjectProperty':
            return { ...axiom, property: normalizePropertyExpression(axiom.property) };
        case 'EquivalentDataProperties':
            assertUnique('EquivalentDataProperties.properties', axiom.properties);
            return { ...axiom, properties: sortText(axiom.properties) };
        default:
            return axiom;
    }
}

function normalizeLemmaConclusion(conclusion: LemmaConclusion): LemmaConclusion {
    return conclusion.kind === 'SubClassOf'
        ? {
              kind: 'SubClassOf',
              subClass: normalizeClassExpression(conclusion.subClass),
              superClass: normalizeClassExpression(conclusion.superClass),
          }
        : {
              kind: 'ClassAssertion',
              individual: conclusion.individual,
              classExpression: normalizeClassExpression(conclusion.classExpression),
          };
}

function normalizeDiagnostic(diagnostic: Diagnostic): Diagnostic {
    return {
        ...diagnostic,
        axiomIds: sortText(diagnostic.axiomIds),
    };
}
function assertUnique(label: string, values: ReadonlyArray<string>): void {
    if (new Set(values).size !== values.length) {
        throw new TypeError(`${label} must contain unique identifiers`);
    }
}

export function normalizeReasonerRequest(request: ReasonerRequest): ReasonerRequest {
    assertUnique(
        'ontology.sources',
        request.ontology.sources.map((source) => source.id),
    );
    assertUnique(
        'ontology.axioms',
        request.ontology.axioms.map((axiom) => axiom.id),
    );
    return {
        ...request,
        ontology: {
            ...request.ontology,
            sources: sortNonEmpty(request.ontology.sources, (left, right) => compareText(left.id, right.id)),
            axioms: [...request.ontology.axioms]
                .map(normalizeAxiom)
                .sort((left, right) => compareText(left.id, right.id)),
        },
    };
}

export function normalizeReasonerResponse(response: ReasonerResponse): ReasonerResponse {
    if (response.result.outcome === 'decided') {
        assertUnique(
            'result.asserted',
            response.result.asserted.map((statement) => statement.id),
        );
        assertUnique(
            'result.inferred',
            response.result.inferred.map((statement) => statement.id),
        );
        const lemmas = response.result.lemmas;
        if (lemmas !== undefined) {
            assertUnique(
                'result.lemmas',
                lemmas.map((lemma) => lemma.id),
            );
        }
        return {
            ...response,
            result: {
                ...response.result,
                ...(lemmas === undefined
                    ? {}
                    : {
                          lemmas: sortNonEmpty(
                              [lemmas[0], ...lemmas.slice(1)].map((lemma) => ({
                                  ...lemma,
                                  premiseIds: sortText(lemma.premiseIds),
                                  conclusion: normalizeLemmaConclusion(lemma.conclusion),
                              })) as [(typeof lemmas)[number], ...(typeof lemmas)[number][]],
                              (left, right) => compareText(left.id, right.id),
                          ),
                      }),
                asserted: [...response.result.asserted].sort((left, right) =>
                    compareText(statementSortKey(left), statementSortKey(right)),
                ),
                inferred: response.result.inferred
                    .map((statement) => ({
                        ...statement,
                        provenance: {
                            ...statement.provenance,
                            premiseIds: sortUniqueNonEmptyText(statement.provenance.premiseIds),
                        },
                    }))
                    .sort((left, right) => compareText(statementSortKey(left), statementSortKey(right))),
                unsatisfiableClasses: response.result.unsatisfiableClasses
                    .map((item) => ({ ...item, premiseIds: sortUniqueNonEmptyText(item.premiseIds) }))
                    .sort((left, right) => compareText(left.classIri, right.classIri)),
                diagnostics: response.result.diagnostics
                    .map(normalizeDiagnostic)
                    .sort((left, right) => compareText(diagnosticSortKey(left), diagnosticSortKey(right))),
            },
        };
    }
    return {
        ...response,
        result: {
            ...response.result,
            diagnostics: mapSortNonEmpty(response.result.diagnostics, normalizeDiagnostic, (left, right) =>
                compareText(diagnosticSortKey(left), diagnosticSortKey(right)),
            ),
        },
    };
}

export function decodeReasonerRequestJson(json: string): ReasonerRequest {
    return normalizeReasonerRequest(Schema.decodeUnknownSync(ReasonerRequestJson, STRICT_OPTIONS)(json));
}
export function decodeReasonerResponseJson(json: string): ReasonerResponse {
    return normalizeReasonerResponse(Schema.decodeUnknownSync(ReasonerResponseJson, STRICT_OPTIONS)(json));
}

export function encodeReasonerRequestJson(request: ReasonerRequest): string {
    const valid = Schema.decodeUnknownSync(ReasonerRequestSchema, STRICT_OPTIONS)(request);
    const json = stringifyCanonicalJson(normalizeReasonerRequest(valid));
    Schema.decodeUnknownSync(ReasonerRequestJson, STRICT_OPTIONS)(json);
    return json;
}
export function encodeReasonerResponseJson(response: ReasonerResponse): string {
    const valid = Schema.decodeUnknownSync(ReasonerResponseSchema, STRICT_OPTIONS)(response);
    const json = stringifyCanonicalJson(normalizeReasonerResponse(valid));
    Schema.decodeUnknownSync(ReasonerResponseJson, STRICT_OPTIONS)(json);
    return json;
}

export function assertCanonicalReasonerRequestJson(json: string): ReasonerRequest {
    const request = decodeReasonerRequestJson(json);
    if (encodeReasonerRequestJson(request) !== json) {
        throw new TypeError('Reasoner request is valid JSON but is not in canonical wire order');
    }
    return request;
}
export function assertCanonicalReasonerResponseJson(json: string): ReasonerResponse {
    const response = decodeReasonerResponseJson(json);
    if (encodeReasonerResponseJson(response) !== json) {
        throw new TypeError('Reasoner response is valid JSON but is not in canonical wire order');
    }
    return response;
}
