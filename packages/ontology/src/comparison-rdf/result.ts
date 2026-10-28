import { createHash } from 'node:crypto';

import {
    RDF_COMPARISON_LIMITS as LIMITS,
    RdfComparisonError,
    type RdfComparisonComponent,
    type RdfComparisonProjection,
    type RdfComparisonSummaryReason,
} from './model.js';

const reasons: ReadonlyArray<RdfComparisonSummaryReason> = [
    'input-limit',
    'statement-limit',
    'term-limit',
    'blank-node-limit',
    'component-limit',
    'canonicalization-limit',
    'output-limit',
];

function invalid(): never {
    throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
}

function record(value: unknown, keys: ReadonlyArray<string>): Readonly<Record<string, unknown>> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).length !== keys.length
    ) {
        return invalid();
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            return invalid();
        }
        result[key] = descriptor.value;
    }
    return result;
}

function integer(value: unknown, maximum: number, minimum = 0): number {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        Object.is(value, -0) ||
        value < minimum ||
        value > maximum
    ) {
        return invalid();
    }
    return value;
}

export function decodeRdfWorkerMessage(raw: unknown): RdfComparisonProjection {
    const kind = raw !== null && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'kind') : undefined;
    if (kind === undefined || !('value' in kind)) {
        return invalid();
    }
    if (kind.value === 'result') {
        return decodeRdfWorkerResult(record(raw, ['kind', 'value'])['value']);
    }
    const message = record(raw, ['kind']);
    if (message['kind'] === 'invalid') {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
    return invalid();
}

/** Validate the bounded worker response; this does not authenticate stored RDF evidence. */
export function decodeRdfWorkerResult(raw: unknown): RdfComparisonProjection {
    try {
        if (typeof raw !== 'string' || !raw.isWellFormed() || Buffer.byteLength(raw) > LIMITS.maxOutputBytes) {
            return invalid();
        }
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || !('kind' in parsed)) {
            return invalid();
        }
        if (parsed.kind === 'summary') {
            const value = record(parsed, ['schema', 'kind', 'reason']);
            const reason = reasons.find((reason) => reason === value['reason']);
            if (value['schema'] !== 'erden.rdf-components/v1' || reason === undefined) {
                return invalid();
            }
            return Object.freeze({ schema: 'erden.rdf-components/v1', kind: 'summary', reason });
        }
        const value = record(parsed, ['schema', 'kind', 'quadCount', 'components']);
        if (value['schema'] !== 'erden.rdf-components/v1' || value['kind'] !== 'complete') {
            return invalid();
        }
        const quadCount = integer(value['quadCount'], LIMITS.maxStatements);
        const entries = value['components'];
        if (!Array.isArray(entries) || entries.length > LIMITS.maxComponents) {
            return invalid();
        }
        let total = 0;
        let instances = 0;
        let previous = '';
        const components: RdfComparisonComponent[] = [];
        for (const entry of entries) {
            const value = record(entry, ['nquads', 'sha256', 'multiplicity', 'quadCount']);
            const nquads = value['nquads'];
            const sha256 = value['sha256'];
            if (
                typeof nquads !== 'string' ||
                !nquads.isWellFormed() ||
                !nquads.endsWith('\n') ||
                Buffer.byteLength(nquads) > LIMITS.maxComponentBytes ||
                nquads.includes('\r') ||
                typeof sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(sha256) ||
                sha256 <= previous ||
                createHash('sha256').update(nquads).digest('hex') !== sha256
            ) {
                return invalid();
            }
            const multiplicity = integer(value['multiplicity'], LIMITS.maxComponents, 1);
            const count = integer(value['quadCount'], LIMITS.maxComponentStatements, 1);
            if (nquads.split('\n').length !== count + 1) {
                return invalid();
            }
            total += multiplicity * count;
            instances += multiplicity;
            previous = sha256;
            components.push(Object.freeze({ nquads, sha256, multiplicity, quadCount: count }));
        }
        if (total !== quadCount || instances > LIMITS.maxComponents) {
            return invalid();
        }
        return Object.freeze({
            schema: 'erden.rdf-components/v1',
            kind: 'complete',
            quadCount,
            components: Object.freeze(components),
        });
    } catch {
        return invalid();
    }
}
