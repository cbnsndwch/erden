export type JsonLdGuardReason = 'nesting-too-deep' | 'duplicate-key';

export interface JsonLdGuardRefusal {
    readonly reason: JsonLdGuardReason;
    readonly detail: string;
}

export const JSON_LD_GUARD_LIMITS = Object.freeze({
    /**
     * Object and array nesting depth. Oxigraph's JSON-LD reader recurses per level and traps inside WebAssembly
     * ("memory access out of bounds") from about 750 nested objects, so the bound keeps a wide margin; ontologies
     * nest a few dozen levels at most.
     */
    maxNestingDepth: 128,
});

interface Frame {
    /** The keys an object has read so far; undefined for an array. */
    readonly keys: Set<string> | undefined;
    expectsKey: boolean;
}

/** The index of the quote that closes the string opening at `start`, or -1 when it is not closed. */
function stringEnd(text: string, start: number): number {
    let index = text.indexOf('"', start + 1);
    while (index >= 0) {
        let backslashes = 0;
        while (text[index - 1 - backslashes] === '\\') {
            backslashes += 1;
        }
        if (backslashes % 2 === 0) {
            return index;
        }
        index = text.indexOf('"', index + 1);
    }
    return -1;
}

/**
 * Refuses JSON nested past the bound, and any object that repeats a key: `JSON.parse`, which the remote-context
 * scan reads, keeps a repeated key's last value, while a streaming parser such as Oxigraph's acts on each in turn,
 * so the scan and the parser would read different documents. One linear pass over the text, before either
 * parser runs; text it cannot follow is left to the parser, which reports the syntax error.
 */
export function jsonLdStructureRefusal(text: string): JsonLdGuardRefusal | undefined {
    const frames: Frame[] = [];
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === '"') {
            const end = stringEnd(text, index);
            if (end < 0) {
                return undefined;
            }
            const frame = frames.at(-1);
            if (frame?.keys !== undefined && frame.expectsKey) {
                let key: unknown;
                try {
                    key = JSON.parse(text.slice(index, end + 1)) as unknown;
                } catch {
                    return undefined;
                }
                if (frame.keys.has(key as string)) {
                    return {
                        reason: 'duplicate-key',
                        detail: `an object repeats the key ${JSON.stringify(key)}; parsers disagree on which value counts`,
                    };
                }
                frame.keys.add(key as string);
                frame.expectsKey = false;
            }
            index = end + 1;
            continue;
        }
        if (character === '{' || character === '[') {
            if (frames.length >= JSON_LD_GUARD_LIMITS.maxNestingDepth) {
                return {
                    reason: 'nesting-too-deep',
                    detail: `objects and arrays nest more than ${String(JSON_LD_GUARD_LIMITS.maxNestingDepth)} levels deep`,
                };
            }
            frames.push({ keys: character === '{' ? new Set() : undefined, expectsKey: character === '{' });
        } else if (character === '}' || character === ']') {
            frames.pop();
        } else if (character === ',') {
            const frame = frames.at(-1);
            if (frame?.keys !== undefined) {
                frame.expectsKey = true;
            }
        }
        index += 1;
    }
    return undefined;
}

/**
 * Finds the first JSON-LD context that would have to be loaded from somewhere: a string `@context` (absolute
 * or relative IRI), a string inside a `@context` array, or a context's `@import`. Erden never loads documents
 * while checking, so such a source is refused by name. Inline contexts are fine.
 *
 * Returns undefined for text that is not JSON; the parser then reports the syntax error with its position.
 */
export function jsonLdRemoteContext(text: string): string | undefined {
    let document: unknown;
    try {
        document = JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
    const pending: unknown[] = [document];
    while (pending.length > 0) {
        const value = pending.pop();
        if (Array.isArray(value)) {
            for (const item of value as unknown[]) {
                pending.push(item);
            }
            continue;
        }
        if (value === null || typeof value !== 'object') {
            continue;
        }
        const record = value as Readonly<Record<string, unknown>>;
        const context = Object.hasOwn(record, '@context') ? record['@context'] : undefined;
        const remote = remoteReference(context);
        if (remote !== undefined) {
            return remote;
        }
        const imported = Object.hasOwn(record, '@import') ? record['@import'] : undefined;
        if (typeof imported === 'string') {
            return imported;
        }
        for (const key of Object.keys(record)) {
            pending.push(record[key]);
        }
    }
    return undefined;
}

function remoteReference(context: unknown): string | undefined {
    if (typeof context === 'string') {
        return context;
    }
    if (Array.isArray(context)) {
        return (context as unknown[]).find((item): item is string => typeof item === 'string');
    }
    return undefined;
}
