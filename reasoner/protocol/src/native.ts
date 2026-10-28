// Canonical JSON written by the engine's own `JSON.stringify`, for values read with `JSON.parse` whose keys were
// checked once to be in canonical order. `stringifyCanonicalJson` copies every object to sort its keys; a value whose
// every object already has its keys in that order needs no copy, and `JSON.stringify` writes the same text: the
// canonical writer ends in the same call, and both escape strings and write numbers as ECMAScript specifies.
// Not exported from the package: only the reading of an answer (`openReasonerResponseJson`) and the trust checks on
// an answer it read use it.
import { createHash } from 'node:crypto';

/** An integer-like key, which JavaScript enumerates first and in numeric order whatever order it was written in. */
const INTEGER_LIKE_KEY = /^(?:0|[1-9][0-9]*)$/u;

function isSortedKeys(keys: ReadonlyArray<string>): boolean {
    for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index] ?? '';
        if (INTEGER_LIKE_KEY.test(key) || (index > 0 && (keys[index - 1] ?? '') >= key)) {
            return false;
        }
    }
    return true;
}

/**
 * Internal: whether every object under a value `JSON.parse` returned has its own keys in canonical order (strictly
 * ascending by UTF-16 code units, as `stringifyCanonicalJson` sorts them) and none integer-like, whose written order
 * `JSON.parse` does not keep. When it holds, `JSON.stringify` of the value or of any part of it is its canonical
 * JSON without the final newline.
 */
export function hasCanonicalKeyOrder(value: unknown): boolean {
    if (value === null || typeof value !== 'object') {
        return true;
    }
    if (Array.isArray(value)) {
        for (const item of value as ReadonlyArray<unknown>) {
            if (!hasCanonicalKeyOrder(item)) {
                return false;
            }
        }
        return true;
    }
    const keys = Object.keys(value);
    if (!isSortedKeys(keys)) {
        return false;
    }
    for (const key of keys) {
        if (!hasCanonicalKeyOrder((value as Readonly<Record<string, unknown>>)[key])) {
            return false;
        }
    }
    return true;
}

/** `sha256:` and the hex SHA-256 of the UTF-8 text. */
export function sha256Text(text: string): string {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Internal: the digest `sha256CanonicalJson` gives a value whose every object has its keys in canonical order (a
 * part of an answer `hasCanonicalKeyOrder` accepted, or an object the caller builds with its keys in that order
 * around such parts), written once by `JSON.stringify` instead of copied and sorted first.
 */
export function sha256OrderedJson(value: unknown): string {
    return sha256Text(`${JSON.stringify(value)}\n`);
}
