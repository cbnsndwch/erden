import { rcompare, valid, validRange } from 'semver';

import { LOCKFILE_LIMITS, type LockToolchain } from '../lock/index.js';
import { compareCodePoints } from '../manifest/constants.js';
import { isCanonicalOntologyIri, isRegistryOrigin, isScopedAlias, normalizeRegistryOrigin } from '../manifest/index.js';

import { RegistryReleaseIndexError, registryIndexInputInvalid } from './errors.js';

export const REGISTRY_RELEASE_INDEX_LIMITS = Object.freeze({
    fixedPageItems: 32,
    maxRowsExaminedPerPage: 33,
    maxDependenciesPerRelease: LOCKFILE_LIMITS.maxDirectDependencies,
    maxDependencyEdgesPerPage: 32 * LOCKFILE_LIMITS.maxDirectDependencies,
    maxReleaseHistory: 2_048,
    maxHistoryEncodedBytes: 128 * 1024 * 1024,
    maxReleaseEncodedBytes: 14 * 1024 * 1024,
    maxExactEncodedBytes: 14 * 1024 * 1024,
    maxPageEncodedBytes: 16 * 1024 * 1024,
    maxEnvelopeEncodedBytes: 64 * 1024,
    maxQueryEncodedBytes: 16 * 1024,
    maxCursorBytes: 1_024,
    maxWatermarkBytes: 256,
    maxOpaqueIdBytes: 128,
    maxPages: 64,
    maxResolverMetadataBytes: 128 * 1024 * 1024,
    derivedMaximumReleaseBytes: 13_769_037,
});

const SHA256 = /^[0-9a-f]{64}$/u;
const EXACT_SEMVER =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const encoder = new TextEncoder();

function limitExceeded(): RegistryReleaseIndexError {
    return new RegistryReleaseIndexError(
        'REGISTRY_INDEX_LIMIT_EXCEEDED',
        'The registry release-index document exceeds a closed limit',
    );
}

export interface RegistryIndexToolRequirement {
    readonly version: string;
    readonly sha256: string;
}

export interface RegistryIndexDependency {
    readonly requested: string;
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
}

export interface RegistryIndexRelease {
    readonly version: string;
    readonly archiveSha256: string;
    readonly toolchain: LockToolchain;
    readonly dependencies: ReadonlyArray<RegistryIndexDependency>;
}

export interface RegistryAliasResolutionV1 {
    readonly schema: 'erden.registry-alias-resolution/v1';
    readonly registryOrigin: string;
    readonly alias: string;
    readonly canonicalIri: string;
}

export interface RegistryReleaseIndexPageV1 {
    readonly schema: 'erden.registry-release-index-page/v1';
    readonly registryOrigin: string;
    readonly canonicalIri: string;
    readonly watermark: string;
    readonly pageOrdinal: number;
    readonly releaseCount: number;
    readonly releases: ReadonlyArray<RegistryIndexRelease>;
    readonly nextCursor: string | null;
}

export interface RegistryReleaseIndexEntryV1 {
    readonly schema: 'erden.registry-release-index-entry/v1';
    readonly registryOrigin: string;
    readonly canonicalIri: string;
    readonly release: RegistryIndexRelease;
}

export type RegistryReadContext =
    | Readonly<{ readonly kind: 'anonymous' }>
    | Readonly<{ readonly kind: 'authenticated-user'; readonly userId: string }>;

export interface ResolveRegistryAliasInput {
    readonly registryOrigin: string;
    readonly alias: string;
}

export interface ListRegistryReleasesInput {
    readonly registryOrigin: string;
    readonly canonicalIri: string;
    readonly cursor: string | null;
}

export interface GetExactRegistryReleaseInput {
    readonly registryOrigin: string;
    readonly canonicalIri: string;
    readonly version: string;
}

type Plain = Readonly<Record<string, unknown>>;

function byteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

export function canonicalizeRegistryJson(input: unknown): unknown {
    if (Array.isArray(input)) {
        return input.map(canonicalizeRegistryJson);
    }
    if (input !== null && typeof input === 'object') {
        const result: Record<string, unknown> = {};
        for (const name of Object.keys(input).sort(compareCodePoints)) {
            result[name] = canonicalizeRegistryJson((input as Record<string, unknown>)[name]);
        }
        return result;
    }
    return input;
}

export function canonicalRegistryJsonBytes(input: unknown): Uint8Array {
    return encoder.encode(`${JSON.stringify(canonicalizeRegistryJson(input))}\n`);
}

function checkedAdd(left: number, right: number): number {
    const total = left + right;
    if (!Number.isSafeInteger(total)) {
        throw limitExceeded();
    }
    return total;
}

function exactKeys(input: unknown, names: ReadonlyArray<string>): Plain {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw registryIndexInputInvalid();
    }
    const actual = Object.getOwnPropertyNames(input).sort(compareCodePoints);
    const wanted = [...names].sort(compareCodePoints);
    if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
        throw registryIndexInputInvalid();
    }
    for (const name of actual) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw registryIndexInputInvalid();
        }
    }
    return input as Plain;
}

function data(input: Plain, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw registryIndexInputInvalid();
    }
    return descriptor.value;
}

function boundedString(input: unknown, maximum: number = LOCKFILE_LIMITS.maxScalarBytes): string {
    if (typeof input !== 'string' || !input.isWellFormed() || byteLength(input) > maximum) {
        throw registryIndexInputInvalid();
    }
    return input;
}

export function decodeRegistryExactVersion(input: unknown): string {
    const value = boundedString(input);
    if (!EXACT_SEMVER.test(value) || valid(value, { loose: false }) === null) {
        throw registryIndexInputInvalid();
    }
    return value;
}

function digest(input: unknown): string {
    if (typeof input !== 'string' || !SHA256.test(input)) {
        throw registryIndexInputInvalid();
    }
    return input;
}

function canonicalIri(input: unknown): string {
    const value = boundedString(input);
    if (!isCanonicalOntologyIri(value)) {
        throw registryIndexInputInvalid();
    }
    return value;
}

function registryOrigin(input: unknown): string {
    const value = boundedString(input);
    if (!isRegistryOrigin(value) || normalizeRegistryOrigin(value) !== value) {
        throw registryIndexInputInvalid();
    }
    return value;
}

function alias(input: unknown): string {
    const value = boundedString(input);
    if (!isScopedAlias(value)) {
        throw registryIndexInputInvalid();
    }
    return value;
}

function opaque(input: unknown): string {
    const value = boundedString(input, REGISTRY_RELEASE_INDEX_LIMITS.maxOpaqueIdBytes);
    if (!OPAQUE.test(value)) {
        throw registryIndexInputInvalid();
    }
    return value;
}

function cursorValue(input: unknown, maximum: number): string {
    const value = boundedString(input, maximum);
    if (!CURSOR.test(value)) {
        throw registryIndexInputInvalid();
    }
    return value;
}

function nonnegative(input: unknown): number {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) {
        throw registryIndexInputInvalid();
    }
    return input;
}

function assertPlainDataTree(input: unknown, maximumObjects = 100000): void {
    const pending: unknown[] = [input];
    const seen = new Set<object>();
    let objects = 0;
    while (pending.length > 0) {
        const value = pending.pop();
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            continue;
        }
        if (typeof value !== 'object' || seen.has(value)) {
            throw registryIndexInputInvalid();
        }
        seen.add(value);
        objects += 1;
        if (objects > maximumObjects || Object.getOwnPropertySymbols(value).length !== 0) {
            throw registryIndexInputInvalid();
        }
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype) {
                throw registryIndexInputInvalid();
            }
            const length = Object.getOwnPropertyDescriptor(value, 'length');
            const arrayLength: unknown = length !== undefined && 'value' in length ? length.value : undefined;
            if (
                typeof arrayLength !== 'number' ||
                !Number.isSafeInteger(arrayLength) ||
                Object.getOwnPropertyNames(value).length !== arrayLength + 1
            ) {
                throw registryIndexInputInvalid();
            }
            for (let index = 0; index < arrayLength; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                    throw registryIndexInputInvalid();
                }
                pending.push(descriptor.value);
            }
            continue;
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) {
            throw registryIndexInputInvalid();
        }
        for (const name of Object.getOwnPropertyNames(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw registryIndexInputInvalid();
            }
            pending.push(descriptor.value);
        }
    }
}

function dense(input: unknown, maximum: number): ReadonlyArray<unknown> {
    if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw registryIndexInputInvalid();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    const arrayLength: unknown =
        lengthDescriptor !== undefined && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (
        typeof arrayLength !== 'number' ||
        !Number.isSafeInteger(arrayLength) ||
        arrayLength > maximum ||
        Object.getOwnPropertyNames(input).length !== arrayLength + 1
    ) {
        throw registryIndexInputInvalid();
    }
    const result: unknown[] = [];
    for (let index = 0; index < arrayLength; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw registryIndexInputInvalid();
        }
        result.push(descriptor.value);
    }
    return result;
}

export function preflightRegistryIndexReleaseCollections(input: unknown): void {
    const value = exactKeys(input, ['archiveSha256', 'dependencies', 'toolchain', 'version']);
    const dependencies = data(value, 'dependencies');
    if (!Array.isArray(dependencies)) {
        throw registryIndexInputInvalid();
    }
    const length = Object.getOwnPropertyDescriptor(dependencies, 'length');
    if (
        length === undefined ||
        !('value' in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value > REGISTRY_RELEASE_INDEX_LIMITS.maxDependenciesPerRelease
    ) {
        throw registryIndexInputInvalid();
    }
}

function decodeToolRequirement(input: unknown): RegistryIndexToolRequirement {
    const value = exactKeys(input, ['sha256', 'version']);
    return Object.freeze({
        version: decodeRegistryExactVersion(data(value, 'version')),
        sha256: digest(data(value, 'sha256')),
    });
}

function decodeToolchain(input: unknown): LockToolchain {
    const value = exactKeys(input, ['reasoner', 'validator']);
    return Object.freeze({
        validator: decodeToolRequirement(data(value, 'validator')),
        reasoner: decodeToolRequirement(data(value, 'reasoner')),
    });
}

function decodeDependency(input: unknown): RegistryIndexDependency {
    const value = exactKeys(input, ['archiveSha256', 'canonicalIri', 'requested', 'version']);
    const requested = boundedString(data(value, 'requested'));
    if (validRange(requested, { loose: false }) === null) {
        throw registryIndexInputInvalid();
    }
    return Object.freeze({
        requested,
        canonicalIri: canonicalIri(data(value, 'canonicalIri')),
        version: decodeRegistryExactVersion(data(value, 'version')),
        archiveSha256: digest(data(value, 'archiveSha256')),
    });
}

export function decodeRegistryIndexRelease(input: unknown): RegistryIndexRelease {
    preflightRegistryIndexReleaseCollections(input);
    assertPlainDataTree(input);
    const value = exactKeys(input, ['archiveSha256', 'dependencies', 'toolchain', 'version']);
    const dependencies = dense(
        data(value, 'dependencies'),
        REGISTRY_RELEASE_INDEX_LIMITS.maxDependenciesPerRelease,
    ).map(decodeDependency);
    let previous: string | undefined;
    for (const dependency of dependencies) {
        if (previous !== undefined && compareCodePoints(previous, dependency.canonicalIri) >= 0) {
            throw registryIndexInputInvalid();
        }
        previous = dependency.canonicalIri;
    }
    return Object.freeze({
        version: decodeRegistryExactVersion(data(value, 'version')),
        archiveSha256: digest(data(value, 'archiveSha256')),
        toolchain: decodeToolchain(data(value, 'toolchain')),
        dependencies: Object.freeze(dependencies),
    });
}

export function decodeRegistryReadContext(input: unknown): RegistryReadContext {
    assertPlainDataTree(input);
    if (input !== null && typeof input === 'object') {
        const kind = Object.getOwnPropertyDescriptor(input, 'kind');
        if (kind !== undefined && 'value' in kind && kind.value === 'anonymous') {
            exactKeys(input, ['kind']);
            return Object.freeze({ kind: 'anonymous' });
        }
    }
    const value = exactKeys(input, ['kind', 'userId']);
    if (data(value, 'kind') !== 'authenticated-user') {
        throw registryIndexInputInvalid();
    }
    return Object.freeze({ kind: 'authenticated-user', userId: opaque(data(value, 'userId')) });
}

export function decodeResolveRegistryAliasInput(input: unknown): ResolveRegistryAliasInput {
    assertPlainDataTree(input);
    const value = exactKeys(input, ['alias', 'registryOrigin']);
    return Object.freeze({
        registryOrigin: registryOrigin(data(value, 'registryOrigin')),
        alias: alias(data(value, 'alias')),
    });
}

export function decodeListRegistryReleasesInput(input: unknown): ListRegistryReleasesInput {
    assertPlainDataTree(input);
    const value = exactKeys(input, ['canonicalIri', 'cursor', 'registryOrigin']);
    const cursor = data(value, 'cursor');
    return Object.freeze({
        registryOrigin: registryOrigin(data(value, 'registryOrigin')),
        canonicalIri: canonicalIri(data(value, 'canonicalIri')),
        cursor: cursor === null ? null : cursorValue(cursor, REGISTRY_RELEASE_INDEX_LIMITS.maxCursorBytes),
    });
}

export function decodeGetExactRegistryReleaseInput(input: unknown): GetExactRegistryReleaseInput {
    assertPlainDataTree(input);
    const value = exactKeys(input, ['canonicalIri', 'registryOrigin', 'version']);
    return Object.freeze({
        registryOrigin: registryOrigin(data(value, 'registryOrigin')),
        canonicalIri: canonicalIri(data(value, 'canonicalIri')),
        version: decodeRegistryExactVersion(data(value, 'version')),
    });
}

export function decodeRegistryAliasResolution(input: unknown): RegistryAliasResolutionV1 {
    assertPlainDataTree(input);
    const value = exactKeys(input, ['alias', 'canonicalIri', 'registryOrigin', 'schema']);
    if (data(value, 'schema') !== 'erden.registry-alias-resolution/v1') {
        throw registryIndexInputInvalid();
    }
    return Object.freeze({
        schema: 'erden.registry-alias-resolution/v1',
        registryOrigin: registryOrigin(data(value, 'registryOrigin')),
        alias: alias(data(value, 'alias')),
        canonicalIri: canonicalIri(data(value, 'canonicalIri')),
    });
}

export function decodeRegistryReleaseIndexPage(input: unknown): RegistryReleaseIndexPageV1 {
    const preflight = exactKeys(input, [
        'canonicalIri',
        'nextCursor',
        'pageOrdinal',
        'registryOrigin',
        'releaseCount',
        'releases',
        'schema',
        'watermark',
    ]);
    const rawReleases = dense(data(preflight, 'releases'), REGISTRY_RELEASE_INDEX_LIMITS.fixedPageItems);
    const value = exactKeys(input, [
        'canonicalIri',
        'nextCursor',
        'pageOrdinal',
        'registryOrigin',
        'releaseCount',
        'releases',
        'schema',
        'watermark',
    ]);
    if (data(value, 'schema') !== 'erden.registry-release-index-page/v1') {
        throw registryIndexInputInvalid();
    }
    const nextCursor = data(value, 'nextCursor');
    const releaseCount = nonnegative(data(value, 'releaseCount'));
    const pageOrdinal = nonnegative(data(value, 'pageOrdinal'));
    const decodedNextCursor =
        nextCursor === null ? null : cursorValue(nextCursor, REGISTRY_RELEASE_INDEX_LIMITS.maxCursorBytes);
    const decodedOrigin = registryOrigin(data(value, 'registryOrigin'));
    const decodedIri = canonicalIri(data(value, 'canonicalIri'));
    const decodedWatermark = cursorValue(data(value, 'watermark'), REGISTRY_RELEASE_INDEX_LIMITS.maxWatermarkBytes);
    const envelopeProbe = Object.freeze({
        schema: 'erden.registry-release-index-page/v1' as const,
        registryOrigin: decodedOrigin,
        canonicalIri: decodedIri,
        watermark: decodedWatermark,
        pageOrdinal,
        releaseCount,
        releases: Object.freeze([]),
        nextCursor: decodedNextCursor,
    });
    let envelopeBytes = canonicalRegistryJsonBytes(envelopeProbe).byteLength;
    if (rawReleases.length > 1) {
        envelopeBytes = checkedAdd(envelopeBytes, rawReleases.length - 1);
    }
    if (envelopeBytes > REGISTRY_RELEASE_INDEX_LIMITS.maxEnvelopeEncodedBytes) {
        throw limitExceeded();
    }
    if (
        releaseCount === 0 ||
        releaseCount > REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseHistory ||
        pageOrdinal >= REGISTRY_RELEASE_INDEX_LIMITS.maxPages ||
        rawReleases.length === 0
    ) {
        throw registryIndexInputInvalid();
    }
    const releases: RegistryIndexRelease[] = [];
    let edges = 0;
    let pageBytes = envelopeBytes;
    let previous: string | undefined;
    for (const rawRelease of rawReleases) {
        const release = decodeRegistryIndexRelease(rawRelease);
        const releaseBytes = canonicalRegistryJsonBytes(release).byteLength;
        if (releaseBytes > REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseEncodedBytes) {
            throw limitExceeded();
        }
        pageBytes = checkedAdd(pageBytes, releaseBytes - 1);
        if (pageBytes > REGISTRY_RELEASE_INDEX_LIMITS.maxPageEncodedBytes) {
            throw limitExceeded();
        }
        edges += release.dependencies.length;
        if (!Number.isSafeInteger(edges) || edges > REGISTRY_RELEASE_INDEX_LIMITS.maxDependencyEdgesPerPage) {
            throw registryIndexInputInvalid();
        }
        if (previous !== undefined && compareRegistryVersions(previous, release.version) >= 0) {
            throw registryIndexInputInvalid();
        }
        previous = release.version;
        releases.push(release);
    }
    return Object.freeze({
        schema: 'erden.registry-release-index-page/v1',
        registryOrigin: decodedOrigin,
        canonicalIri: decodedIri,
        watermark: decodedWatermark,
        pageOrdinal,
        releaseCount,
        releases: Object.freeze(releases),
        nextCursor: decodedNextCursor,
    });
}

export function decodeRegistryReleaseIndexEntry(input: unknown): RegistryReleaseIndexEntryV1 {
    const value = exactKeys(input, ['canonicalIri', 'registryOrigin', 'release', 'schema']);
    if (data(value, 'schema') !== 'erden.registry-release-index-entry/v1') {
        throw registryIndexInputInvalid();
    }
    const entry = Object.freeze({
        schema: 'erden.registry-release-index-entry/v1',
        registryOrigin: registryOrigin(data(value, 'registryOrigin')),
        canonicalIri: canonicalIri(data(value, 'canonicalIri')),
        release: decodeRegistryIndexRelease(data(value, 'release')),
    });
    const entryBytes = canonicalRegistryJsonBytes(entry).byteLength;
    const releaseBytesWithLf = canonicalRegistryJsonBytes(entry.release).byteLength;
    if (releaseBytesWithLf > REGISTRY_RELEASE_INDEX_LIMITS.maxReleaseEncodedBytes) {
        throw limitExceeded();
    }
    const releaseBytes = releaseBytesWithLf - 1;
    if (
        entryBytes > REGISTRY_RELEASE_INDEX_LIMITS.maxExactEncodedBytes ||
        entryBytes - releaseBytes > REGISTRY_RELEASE_INDEX_LIMITS.maxEnvelopeEncodedBytes
    ) {
        throw limitExceeded();
    }
    return entry;
}

export function compareRegistryVersions(left: string, right: string): number {
    const precedence = rcompare(left, right, { loose: false });
    return precedence !== 0 ? precedence : compareCodePoints(right, left);
}

export interface RegistryReleaseIndexReaderShape {
    readonly resolveAlias: (
        registryOrigin: string,
        alias: string,
        signal?: AbortSignal,
    ) => Promise<RegistryAliasResolutionV1 | null>;
    readonly listPage: (
        registryOrigin: string,
        canonicalIri: string,
        cursor: string | null,
        signal?: AbortSignal,
    ) => Promise<RegistryReleaseIndexPageV1 | null>;
    readonly getExactRelease: (
        registryOrigin: string,
        canonicalIri: string,
        version: string,
        signal?: AbortSignal,
    ) => Promise<RegistryReleaseIndexEntryV1 | null>;
}
