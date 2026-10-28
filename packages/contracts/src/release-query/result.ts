import { createHash } from 'node:crypto';

import { comparisonCanonicalJson } from '../release-comparison/shape.js';

import { ReleaseQueryError } from './errors.js';
import { RELEASE_QUERY_LIMITS as LIMITS, type ParsedReleaseQuery } from './model.js';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

export type ReleaseQueryResultTerm =
    | Readonly<{ type: 'uri'; value: string }>
    | Readonly<{ type: 'bnode'; value: string }>
    | Readonly<{ type: 'literal'; value: string; 'xml:lang'?: string; datatype?: string }>;

export type ReleaseQuerySparqlResult =
    | Readonly<{
          head: Readonly<{ vars: ReadonlyArray<string> }>;
          results: Readonly<{ bindings: ReadonlyArray<Readonly<Record<string, ReleaseQueryResultTerm>>> }>;
      }>
    | Readonly<{ head: Readonly<Record<string, never>>; boolean: boolean }>;

export type DecodedReleaseQueryResult =
    | Readonly<{ kind: 'complete'; result: ReleaseQuerySparqlResult; bytes: Uint8Array; sha256: string; rows: number }>
    | Readonly<{ kind: 'limited'; reason: 'row-limit' | 'result-byte-limit' }>;

class Limited extends Error {
    readonly reason: 'row-limit' | 'result-byte-limit';
    constructor(reason: 'row-limit' | 'result-byte-limit') {
        super(reason);
        this.reason = reason;
    }
}

function invalid(): never {
    throw new ReleaseQueryError('RELEASE_QUERY_UNAVAILABLE');
}

function record(input: unknown, required: ReadonlyArray<string>, optional: ReadonlyArray<string> = []) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return invalid();
    }
    const value = input as Readonly<Record<string, unknown>>;
    const keys = Object.keys(value);
    if (
        required.some((key) => !Object.hasOwn(value, key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))
    ) {
        return invalid();
    }
    return value;
}

function text(input: unknown): string {
    if (typeof input !== 'string' || !input.isWellFormed()) {
        return invalid();
    }
    if (Buffer.byteLength(input) > LIMITS.maxTermValueBytes) {
        throw new Limited('result-byte-limit');
    }
    return input;
}

function term(input: unknown, labels: Map<string, string>): ReleaseQueryResultTerm {
    const value = record(input, ['type', 'value'], ['xml:lang', 'datatype']);
    const type = value['type'];
    if (type === 'uri') {
        record(input, ['type', 'value']);
        return Object.freeze({ type: 'uri', value: text(value['value']) });
    }
    if (type === 'bnode') {
        record(input, ['type', 'value']);
        const original = text(value['value']);
        let label = labels.get(original);
        if (label === undefined) {
            label = `b${String(labels.size)}`;
            labels.set(original, label);
        }
        return Object.freeze({ type: 'bnode', value: label });
    }
    if (type !== 'literal') {
        // Triple terms and any other shape are outside the closed result contract.
        return invalid();
    }
    const lexical = text(value['value']);
    const language = value['xml:lang'];
    const datatype = value['datatype'];
    if (language !== undefined) {
        if (typeof language !== 'string' || !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) {
            return invalid();
        }
        if (datatype !== undefined && datatype !== RDF_LANG_STRING) {
            return invalid();
        }
        return Object.freeze({ type: 'literal', value: lexical, 'xml:lang': language });
    }
    if (datatype === undefined || datatype === XSD_STRING) {
        return Object.freeze({ type: 'literal', value: lexical });
    }
    return Object.freeze({ type: 'literal', value: lexical, datatype: text(datatype) });
}

function projectedVariables(input: unknown, parsed: ParsedReleaseQuery): ReadonlyArray<string> {
    if (!Array.isArray(input) || input.length > LIMITS.maxVariables) {
        return invalid();
    }
    const names = input.map((name) => (typeof name === 'string' && VARIABLE.test(name) ? name : invalid()));
    if (new Set(names).size !== names.length) {
        return invalid();
    }
    if (parsed.projection !== null) {
        if (comparisonCanonicalJson(names) !== comparisonCanonicalJson(parsed.projection)) {
            return invalid();
        }
    } else if (names.some((name) => !parsed.variables.includes(name))) {
        return invalid();
    }
    return Object.freeze(names);
}

function select(raw: unknown, parsed: ParsedReleaseQuery): Readonly<{ value: ReleaseQuerySparqlResult; rows: number }> {
    const value = record(raw, ['head', 'results']);
    const vars = projectedVariables(record(value['head'], ['vars'])['vars'], parsed);
    const bindings = record(value['results'], ['bindings'])['bindings'];
    if (!Array.isArray(bindings)) {
        return invalid();
    }
    if (bindings.length > LIMITS.maxResultRows) {
        throw new Limited('row-limit');
    }
    const labels = new Map<string, string>();
    const rows = bindings.map((binding: unknown) => {
        const row = record(binding, [], vars);
        const output: Array<readonly [string, ReleaseQueryResultTerm]> = [];
        // Relabel in row order, then head order, so labels depend only on the result, never on engine identifiers.
        for (const name of vars) {
            if (Object.hasOwn(row, name)) {
                output.push([name, term(row[name], labels)]);
            }
        }
        // `fromEntries` defines own properties, so a variable named `__proto__` stays a binding.
        return Object.freeze(Object.fromEntries(output));
    });
    return {
        value: Object.freeze({
            head: Object.freeze({ vars }),
            results: Object.freeze({ bindings: Object.freeze(rows) }),
        }),
        rows: rows.length,
    };
}

/** Strict decoder for engine output. Engine misbehavior is unavailable; bounds become limited reads. */
export function decodeReleaseQueryResult(raw: string, parsed: ParsedReleaseQuery): DecodedReleaseQueryResult {
    try {
        if (Buffer.byteLength(raw) > LIMITS.maxResultBytes) {
            throw new Limited('result-byte-limit');
        }
        let json: unknown;
        try {
            json = JSON.parse(raw);
        } catch {
            return invalid();
        }
        let value: ReleaseQuerySparqlResult;
        let rows = 0;
        if (parsed.form === 'ask') {
            const ask = record(json, ['head', 'boolean']);
            record(ask['head'], []);
            if (typeof ask['boolean'] !== 'boolean') {
                return invalid();
            }
            value = Object.freeze({ head: Object.freeze({}), boolean: ask['boolean'] });
        } else {
            ({ value, rows } = select(json, parsed));
        }
        const encoded = `${comparisonCanonicalJson(value)}\n`;
        const bytes = new TextEncoder().encode(encoded);
        if (bytes.byteLength > LIMITS.maxResultBytes) {
            throw new Limited('result-byte-limit');
        }
        return Object.freeze({
            kind: 'complete',
            result: value,
            bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            rows,
        });
    } catch (cause) {
        if (cause instanceof Limited) {
            return Object.freeze({ kind: 'limited', reason: cause.reason });
        }
        throw cause;
    }
}
