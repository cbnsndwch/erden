import { createHash } from 'node:crypto';

import { decodeLockToolchain, type LockToolchain } from '../lock/index.js';
import { decodeComparisonReleaseIdentity } from '../release-comparison/identity.js';
import type { ComparisonReleaseIdentity } from '../release-comparison/model.js';
import {
    comparisonArray,
    comparisonCanonicalJson,
    comparisonDigest,
    comparisonRecord,
    comparisonText,
} from '../release-comparison/shape.js';

import { ReleaseQueryError } from './errors.js';
import {
    RELEASE_QUERY_LIMITS as LIMITS,
    RELEASE_QUERY_REJECTION_REASONS,
    type ReleaseQueryForm,
    type ReleaseQueryRejectionReason,
} from './model.js';
import type { ReleaseQueryResultTerm, ReleaseQuerySparqlResult } from './result.js';

export type ReleaseQueryRelease = ComparisonReleaseIdentity;

export interface ReleaseQueryResultEnvelopeV1 {
    readonly schema: 'erden.release-query-result/v1';
    readonly binding: Readonly<{
        release: ReleaseQueryRelease;
        evidence: Readonly<{ kind: 'comparison-profile'; sha256: string }>;
        dataset: Readonly<{ sha256: string; quadCounts: Readonly<{ declared: number; inferred: number }> }>;
        toolchain: LockToolchain;
        reasoningProfile: Readonly<{ id: string; sha256: string }>;
        engine: Readonly<{ name: string; version: string; wasmSha256: string }>;
        policy: Readonly<{ id: string; sha256: string }>;
    }>;
    readonly query: Readonly<{ form: ReleaseQueryForm; sha256: string }>;
    readonly result: ReleaseQuerySparqlResult;
    readonly resultSha256: string;
}

export type ReleaseQueryLimitedReason = 'time-limit' | 'resource-limit' | 'row-limit' | 'result-byte-limit';

export type ReleaseQueryUnavailableReason = 'dataset-missing' | 'dataset-limit';

/** Transport error codes. `code` and `reason` are closed; nothing else is ever serialized. */
export type ReleaseQueryTransportCode =
    | 'RELEASE_QUERY_INVALID_REQUEST'
    | 'RELEASE_QUERY_UNAUTHORIZED'
    | 'RELEASE_QUERY_NOT_FOUND'
    | 'RELEASE_QUERY_METHOD_NOT_ALLOWED'
    | 'RELEASE_QUERY_NOT_ACCEPTABLE'
    | 'RELEASE_QUERY_DATASET_UNAVAILABLE'
    | 'RELEASE_QUERY_TOO_LARGE'
    | 'RELEASE_QUERY_UNSUPPORTED_MEDIA_TYPE'
    | 'RELEASE_QUERY_REJECTED'
    | 'RELEASE_QUERY_LIMIT_EXCEEDED'
    | 'RELEASE_QUERY_CONFLICT'
    | 'RELEASE_QUERY_BUSY'
    | 'RELEASE_QUERY_UNAVAILABLE';

export type ReleaseQueryTransportReason =
    | ReleaseQueryRejectionReason
    | ReleaseQueryLimitedReason
    | ReleaseQueryUnavailableReason
    | null;

export const RELEASE_QUERY_TRANSPORT_CODES: ReadonlyArray<ReleaseQueryTransportCode> = Object.freeze([
    'RELEASE_QUERY_INVALID_REQUEST',
    'RELEASE_QUERY_UNAUTHORIZED',
    'RELEASE_QUERY_NOT_FOUND',
    'RELEASE_QUERY_METHOD_NOT_ALLOWED',
    'RELEASE_QUERY_NOT_ACCEPTABLE',
    'RELEASE_QUERY_DATASET_UNAVAILABLE',
    'RELEASE_QUERY_TOO_LARGE',
    'RELEASE_QUERY_UNSUPPORTED_MEDIA_TYPE',
    'RELEASE_QUERY_REJECTED',
    'RELEASE_QUERY_LIMIT_EXCEEDED',
    'RELEASE_QUERY_CONFLICT',
    'RELEASE_QUERY_BUSY',
    'RELEASE_QUERY_UNAVAILABLE',
]);

const TRANSPORT_REASONS: ReadonlySet<string> = new Set([
    ...RELEASE_QUERY_REJECTION_REASONS,
    'time-limit',
    'resource-limit',
    'row-limit',
    'result-byte-limit',
    'dataset-missing',
    'dataset-limit',
]);

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const LANGUAGE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const BLANK = /^b(?:0|[1-9][0-9]{0,5})$/u;
const SHORT_TEXT_BYTES = 256;

export interface ReleaseQueryErrorBodyV1 {
    readonly schema: 'erden.release-query-error/v1';
    readonly code: ReleaseQueryTransportCode;
    readonly reason: ReleaseQueryTransportReason;
}

function invalid(): never {
    throw new ReleaseQueryError('RELEASE_QUERY_INPUT_INVALID');
}

/** Decode a closed `erden.release-query-error/v1` body; any other code or reason is invalid. */
export function decodeReleaseQueryErrorBody(input: unknown): ReleaseQueryErrorBodyV1 {
    try {
        const value = comparisonRecord(input, ['code', 'reason', 'schema']);
        const code = value['code'];
        const reason = value['reason'];
        if (
            value['schema'] !== 'erden.release-query-error/v1' ||
            typeof code !== 'string' ||
            !(RELEASE_QUERY_TRANSPORT_CODES as ReadonlyArray<string>).includes(code) ||
            (reason !== null && (typeof reason !== 'string' || !TRANSPORT_REASONS.has(reason)))
        ) {
            return invalid();
        }
        return Object.freeze({
            schema: 'erden.release-query-error/v1',
            code: code as ReleaseQueryTransportCode,
            reason: reason as ReleaseQueryTransportReason,
        });
    } catch {
        return invalid();
    }
}

function count(input: unknown, maximum: number): number {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > maximum) {
        return invalid();
    }
    return input;
}

function term(input: unknown): ReleaseQueryResultTerm {
    if (input === null || typeof input !== 'object') {
        return invalid();
    }
    const keys = Object.keys(input).sort().join(',');
    const type = (input as Readonly<Record<string, unknown>>)['type'];
    if (type === 'uri' || type === 'bnode') {
        const value = comparisonRecord(input, ['type', 'value']);
        const text = comparisonText(value['value'], LIMITS.maxTermValueBytes);
        if (type === 'bnode' && !BLANK.test(text)) {
            return invalid();
        }
        return Object.freeze({ type, value: text });
    }
    if (type !== 'literal') {
        return invalid();
    }
    if (keys === 'type,value') {
        const value = comparisonRecord(input, ['type', 'value']);
        return Object.freeze({ type: 'literal', value: comparisonText(value['value'], LIMITS.maxTermValueBytes) });
    }
    if (keys === 'type,value,xml:lang') {
        const value = comparisonRecord(input, ['type', 'value', 'xml:lang']);
        const language = comparisonText(value['xml:lang'], LIMITS.maxLanguageBytes);
        if (!LANGUAGE.test(language)) {
            return invalid();
        }
        return Object.freeze({
            type: 'literal',
            value: comparisonText(value['value'], LIMITS.maxTermValueBytes),
            'xml:lang': language,
        });
    }
    const value = comparisonRecord(input, ['datatype', 'type', 'value']);
    const datatype = comparisonText(value['datatype'], LIMITS.maxTermValueBytes);
    if (datatype === XSD_STRING || datatype === RDF_LANG_STRING) {
        return invalid();
    }
    return Object.freeze({
        type: 'literal',
        value: comparisonText(value['value'], LIMITS.maxTermValueBytes),
        datatype,
    });
}

function sparqlResult(input: unknown, form: 'select' | 'ask'): ReleaseQuerySparqlResult {
    if (form === 'ask') {
        const value = comparisonRecord(input, ['boolean', 'head']);
        comparisonRecord(value['head'], []);
        if (typeof value['boolean'] !== 'boolean') {
            return invalid();
        }
        return Object.freeze({ head: Object.freeze({}), boolean: value['boolean'] });
    }
    const value = comparisonRecord(input, ['head', 'results']);
    const vars = comparisonArray(comparisonRecord(value['head'], ['vars'])['vars'], LIMITS.maxVariables, (name) =>
        typeof name === 'string' && VARIABLE.test(name) ? name : invalid(),
    );
    if (new Set(vars).size !== vars.length) {
        return invalid();
    }
    const bindings = comparisonArray(
        comparisonRecord(value['results'], ['bindings'])['bindings'],
        LIMITS.maxResultRows,
        (raw) => {
            if (raw === null || typeof raw !== 'object') {
                return invalid();
            }
            const names = Object.keys(raw);
            const row = comparisonRecord(raw, names);
            const output: Array<readonly [string, ReleaseQueryResultTerm]> = [];
            for (const name of names) {
                if (!vars.includes(name)) {
                    return invalid();
                }
                output.push([name, term(row[name])]);
            }
            // `fromEntries` defines own properties, so a variable named `__proto__` stays a binding.
            return Object.freeze(Object.fromEntries(output));
        },
    );
    return Object.freeze({
        head: Object.freeze({ vars }),
        results: Object.freeze({ bindings }),
    });
}

/**
 * Strict client-side decoding of `erden.release-query-result/v1`. The result digest is recomputed from the
 * canonical result bytes, so a response whose result and `resultSha256` disagree is refused.
 */
export function decodeReleaseQueryResultEnvelope(input: unknown): ReleaseQueryResultEnvelopeV1 {
    try {
        const value = comparisonRecord(input, ['binding', 'query', 'result', 'resultSha256', 'schema']);
        if (value['schema'] !== 'erden.release-query-result/v1') {
            return invalid();
        }
        const binding = comparisonRecord(value['binding'], [
            'dataset',
            'engine',
            'evidence',
            'policy',
            'reasoningProfile',
            'release',
            'toolchain',
        ]);
        const evidence = comparisonRecord(binding['evidence'], ['kind', 'sha256']);
        const dataset = comparisonRecord(binding['dataset'], ['quadCounts', 'sha256']);
        const quadCounts = comparisonRecord(dataset['quadCounts'], ['declared', 'inferred']);
        const profile = comparisonRecord(binding['reasoningProfile'], ['id', 'sha256']);
        const engine = comparisonRecord(binding['engine'], ['name', 'version', 'wasmSha256']);
        const policy = comparisonRecord(binding['policy'], ['id', 'sha256']);
        const query = comparisonRecord(value['query'], ['form', 'sha256']);
        const form = query['form'];
        if (evidence['kind'] !== 'comparison-profile' || (form !== 'select' && form !== 'ask')) {
            return invalid();
        }
        const result = sparqlResult(value['result'], form);
        const resultSha256 = comparisonDigest(value['resultSha256']);
        const digest = createHash('sha256')
            .update(`${comparisonCanonicalJson(result)}\n`)
            .digest('hex');
        if (digest !== resultSha256) {
            return invalid();
        }
        return Object.freeze({
            schema: 'erden.release-query-result/v1',
            binding: Object.freeze({
                release: decodeComparisonReleaseIdentity(binding['release']),
                evidence: Object.freeze({ kind: 'comparison-profile', sha256: comparisonDigest(evidence['sha256']) }),
                dataset: Object.freeze({
                    sha256: comparisonDigest(dataset['sha256']),
                    quadCounts: Object.freeze({
                        declared: count(quadCounts['declared'], LIMITS.maxDatasetQuads),
                        inferred: count(quadCounts['inferred'], LIMITS.maxDatasetQuads),
                    }),
                }),
                toolchain: decodeLockToolchain(binding['toolchain']),
                reasoningProfile: Object.freeze({
                    id: comparisonText(profile['id'], SHORT_TEXT_BYTES),
                    sha256: comparisonDigest(profile['sha256']),
                }),
                engine: Object.freeze({
                    name: comparisonText(engine['name'], SHORT_TEXT_BYTES),
                    version: comparisonText(engine['version'], SHORT_TEXT_BYTES),
                    wasmSha256: comparisonDigest(engine['wasmSha256']),
                }),
                policy: Object.freeze({
                    id: comparisonText(policy['id'], SHORT_TEXT_BYTES),
                    sha256: comparisonDigest(policy['sha256']),
                }),
            }),
            query: Object.freeze({ form, sha256: comparisonDigest(query['sha256']) }),
            result,
            resultSha256,
        });
    } catch {
        return invalid();
    }
}
