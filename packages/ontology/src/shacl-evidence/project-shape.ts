import { RdfComparisonError } from '../comparison-rdf/model.js';

export function expectProjectionValue(value: unknown, expected: string): void {
    if (value !== expected) {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
}

/** Captures contain plain own data only; never invoke getters or serialization hooks. */
export function assertProjectionRecord(value: unknown, expected?: ReadonlyArray<string>): void {
    if (value === null || typeof value !== 'object') {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
    const keys = Reflect.ownKeys(value);
    if (expected !== undefined && (keys.length !== expected.length || expected.some((key) => !keys.includes(key)))) {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || descriptor?.enumerable !== true || !('value' in descriptor)) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
    }
}

export function assertProjectionArray(value: unknown): void {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
}

export function assertProjectionArrayEntries(value: ReadonlyArray<unknown>): void {
    if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor?.enumerable !== true || !('value' in descriptor)) {
            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
        }
    }
}
