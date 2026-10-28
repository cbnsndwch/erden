import { RegistryReleaseIndexError, isRegistryReleaseIndexError, registryIndexInputInvalid } from './errors.js';
import {
    REGISTRY_RELEASE_INDEX_LIMITS,
    canonicalRegistryJsonBytes,
    decodeRegistryAliasResolution,
    decodeRegistryIndexRelease,
    decodeRegistryReleaseIndexEntry,
    decodeRegistryReleaseIndexPage,
    type RegistryAliasResolutionV1,
    type RegistryIndexRelease,
    type RegistryReleaseIndexEntryV1,
    type RegistryReleaseIndexPageV1,
} from './model.js';

const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength');
const typedArraySetDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'set');

function intrinsicByteLength(input: Uint8Array): unknown {
    const getter: unknown =
        typedArrayByteLengthDescriptor === undefined ? undefined : Reflect.get(typedArrayByteLengthDescriptor, 'get');
    if (typeof getter !== 'function') {
        throw new TypeError('Typed-array byte length is unavailable');
    }
    return Reflect.apply(getter, input, []);
}

function intrinsicCopy(input: Uint8Array, length: number): Uint8Array {
    const set: unknown =
        typedArraySetDescriptor === undefined ? undefined : Reflect.get(typedArraySetDescriptor, 'value');
    if (typeof set !== 'function') {
        throw new TypeError('Typed-array copy is unavailable');
    }
    const copy = new Uint8Array(length);
    Reflect.apply(set, copy, [input]);
    return copy;
}

function limitExceeded(): RegistryReleaseIndexError {
    return new RegistryReleaseIndexError(
        'REGISTRY_INDEX_LIMIT_EXCEEDED',
        'The registry release-index document exceeds a closed limit',
    );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function snapshotBytes(input: unknown, maximum: number): Uint8Array {
    try {
        if (
            !(input instanceof Uint8Array) ||
            Object.getPrototypeOf(input) !== Uint8Array.prototype ||
            Object.getOwnPropertySymbols(input).length !== 0 ||
            Object.getOwnPropertyDescriptor(input, 'byteLength') !== undefined
        ) {
            throw registryIndexInputInvalid();
        }
        const length = intrinsicByteLength(input);
        if (typeof length !== 'number' || !Number.isSafeInteger(length)) {
            throw registryIndexInputInvalid();
        }
        if (length > maximum) {
            throw limitExceeded();
        }
        const copy = intrinsicCopy(input, length);
        const copiedLength = intrinsicByteLength(copy);
        if (copiedLength !== length) {
            throw registryIndexInputInvalid();
        }
        return copy;
    } catch (error) {
        if (isRegistryReleaseIndexError(error)) {
            throw error;
        }
        throw registryIndexInputInvalid();
    }
}

function parseCanonical<Value>(
    input: unknown,
    maximum: number,
    decode: (value: unknown) => Value,
    encode: (value: Value) => Uint8Array,
): Value {
    const bytes = snapshotBytes(input, maximum);
    let parsed: unknown;
    try {
        parsed = JSON.parse(fatalDecoder.decode(bytes));
    } catch {
        throw registryIndexInputInvalid();
    }
    const value = decode(parsed);
    const canonical = encode(value);
    if (!equalBytes(bytes, canonical)) {
        throw registryIndexInputInvalid();
    }
    return value;
}

export function encodeRegistryIndexRelease(input: RegistryIndexRelease): Uint8Array {
    const release = decodeRegistryIndexRelease(input);
    const bytes = canonicalRegistryJsonBytes(release);
    if (bytes.byteLength > REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseEncodedBytes) {
        throw limitExceeded();
    }
    return bytes;
}

export function decodeRegistryIndexReleaseWire(input: unknown): RegistryIndexRelease {
    return parseCanonical(
        input,
        REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseEncodedBytes,
        decodeRegistryIndexRelease,
        encodeRegistryIndexRelease,
    );
}

export function encodeRegistryAliasResolution(input: RegistryAliasResolutionV1): Uint8Array {
    const value = decodeRegistryAliasResolution(input);
    const bytes = canonicalRegistryJsonBytes(value);
    if (bytes.byteLength > REGISTRY_RELEASE_INDEX_LIMITS.maxEnvelopeEncodedBytes) {
        throw limitExceeded();
    }
    return bytes;
}

export function decodeRegistryAliasResolutionWire(input: unknown): RegistryAliasResolutionV1 {
    return parseCanonical(
        input,
        REGISTRY_RELEASE_INDEX_LIMITS.maxEnvelopeEncodedBytes,
        decodeRegistryAliasResolution,
        encodeRegistryAliasResolution,
    );
}

function releasePayloadBytes(releases: ReadonlyArray<RegistryIndexRelease>): number {
    let total = 0;
    for (const release of releases) {
        const length = encodeRegistryIndexRelease(release).byteLength - 1;
        total += length;
        if (!Number.isSafeInteger(total)) {
            throw limitExceeded();
        }
    }
    return total;
}

export function encodeRegistryReleaseIndexPage(input: RegistryReleaseIndexPageV1): Uint8Array {
    const page = decodeRegistryReleaseIndexPage(input);
    const bytes = canonicalRegistryJsonBytes(page);
    const payload = releasePayloadBytes(page.releases);
    if (
        bytes.byteLength > REGISTRY_RELEASE_INDEX_LIMITS.maxPageEncodedBytes ||
        bytes.byteLength - payload > REGISTRY_RELEASE_INDEX_LIMITS.maxEnvelopeEncodedBytes
    ) {
        throw limitExceeded();
    }
    return bytes;
}

export function decodeRegistryReleaseIndexPageWire(input: unknown): RegistryReleaseIndexPageV1 {
    return parseCanonical(
        input,
        REGISTRY_RELEASE_INDEX_LIMITS.maxPageEncodedBytes,
        decodeRegistryReleaseIndexPage,
        encodeRegistryReleaseIndexPage,
    );
}

export function encodeRegistryReleaseIndexEntry(input: RegistryReleaseIndexEntryV1): Uint8Array {
    const entry = decodeRegistryReleaseIndexEntry(input);
    const bytes = canonicalRegistryJsonBytes(entry);
    const payload = encodeRegistryIndexRelease(entry.release).byteLength - 1;
    if (
        bytes.byteLength > REGISTRY_RELEASE_INDEX_LIMITS.maxExactEncodedBytes ||
        bytes.byteLength - payload > REGISTRY_RELEASE_INDEX_LIMITS.maxEnvelopeEncodedBytes
    ) {
        throw limitExceeded();
    }
    return bytes;
}

export function decodeRegistryReleaseIndexEntryWire(input: unknown): RegistryReleaseIndexEntryV1 {
    return parseCanonical(
        input,
        REGISTRY_RELEASE_INDEX_LIMITS.maxExactEncodedBytes,
        decodeRegistryReleaseIndexEntry,
        encodeRegistryReleaseIndexEntry,
    );
}
