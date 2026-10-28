import { ReleaseComparisonError } from './errors.js';

export function comparisonInvalid(): never {
    throw new ReleaseComparisonError('COMPARISON_INPUT_INVALID');
}

export function comparisonRecord(input: unknown, keys: ReadonlyArray<string>): Readonly<Record<string, unknown>> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== keys.length
    ) {
        return comparisonInvalid();
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            return comparisonInvalid();
        }
        result[key] = descriptor.value;
    }
    return result;
}

export function comparisonText(input: unknown, maximum: number): string {
    if (typeof input !== 'string' || !input.isWellFormed() || Buffer.byteLength(input) > maximum) {
        return comparisonInvalid();
    }
    return input;
}

export function comparisonDigest(input: unknown): string {
    if (typeof input !== 'string' || !/^[a-f0-9]{64}$/u.test(input)) {
        return comparisonInvalid();
    }
    return input;
}

export function comparisonArray<A>(input: unknown, maximum: number, decode: (value: unknown) => A): ReadonlyArray<A> {
    if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        input.length > maximum ||
        Reflect.ownKeys(input).length !== input.length + 1
    ) {
        return comparisonInvalid();
    }
    const values: A[] = [];
    for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            return comparisonInvalid();
        }
        values.push(decode(descriptor.value));
    }
    return Object.freeze(values);
}

/** Only call with a closed, decoded comparison value. */
export function comparisonCanonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(comparisonCanonicalJson).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => `${JSON.stringify(key)}:${comparisonCanonicalJson(entry)}`)
            .join(',')}}`;
    }
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    ) {
        return JSON.stringify(value);
    }
    return comparisonInvalid();
}

export function comparisonExpect(input: unknown, expected: string): void {
    if (input !== expected) {
        return comparisonInvalid();
    }
}
