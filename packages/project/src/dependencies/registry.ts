import { Context } from 'effect';

import {
    decodeLockPackageNode,
    type LockPackageNode,
    compareCodePoints,
    normalizeRegistryOrigin,
} from '@erden/contracts';
import {
    decodeCanonicalPackageManifest,
    encodeCanonicalPackageManifest,
    type PackageArchiveSource,
    type PackageManifestV1,
} from '@erden/package-format';

import type { CatalogAliasResolution, DependencyCatalogShape, PublishedPackageRecord } from './catalog.js';

export interface DependencyArchiveReaderShape {
    readonly fetchArchive: (
        registryOrigin: string,
        locked: LockPackageNode,
        signal?: AbortSignal,
    ) => Promise<PackageArchiveSource | null>;
}

export const DependencyArchiveReader = Context.Service<DependencyArchiveReaderShape>(
    '@erden/project/DependencyArchiveReader',
);

/** Legacy aggregate retained for fixture and embedding compatibility. */
export interface DependencyRegistryShape extends DependencyCatalogShape, DependencyArchiveReaderShape {}

export const DependencyRegistry = Context.Service<DependencyRegistryShape>('@erden/project/DependencyRegistry');

const unavailableRegistryErrors = new WeakSet<object>();

export class DependencyRegistryUnavailableError extends Error {
    readonly code = 'DEPENDENCY_REGISTRY_TRANSPORT_UNAVAILABLE' as const;

    constructor() {
        super('No production dependency registry transport is configured');
        this.name = 'DependencyRegistryUnavailableError';
        unavailableRegistryErrors.add(this);
        Object.freeze(this);
    }
}

/** Brand-safe even when `value` is a hostile Proxy. */
export function isDependencyRegistryUnavailableError(value: unknown): value is DependencyRegistryUnavailableError {
    return value !== null && typeof value === 'object' && unavailableRegistryErrors.has(value);
}

function unavailable(): Promise<never> {
    return Promise.reject(new DependencyRegistryUnavailableError());
}

/**
 * Production-safe V1 boundary: this port has no HTTP, DNS, filesystem,
 * credential, or environment capability. Cached and offline operations can use
 * it because they never invoke registry methods; any actual demand fails closed.
 */
export const unavailableDependencyRegistry: DependencyRegistryShape = Object.freeze({
    resolveAlias: unavailable,
    listPublished: unavailable,
    fetchArchive: unavailable,
});

export type FixtureRegistryCall =
    | Readonly<{ readonly operation: 'resolve-alias'; readonly registryOrigin: string; readonly alias: string }>
    | Readonly<{ readonly operation: 'list-published'; readonly registryOrigin: string; readonly canonicalIri: string }>
    | Readonly<{
          readonly operation: 'fetch-archive';
          readonly registryOrigin: string;
          readonly canonicalIri: string;
          readonly version: string;
          readonly archiveSha256: string;
      }>;

export interface FixtureRegistryPackage extends PublishedPackageRecord {
    readonly archive: Uint8Array;
}

export interface FixtureRegistryInput {
    readonly registryOrigin: string;
    readonly aliases: ReadonlyArray<CatalogAliasResolution>;
    readonly packages: ReadonlyArray<FixtureRegistryPackage>;
}

export interface FixtureDependencyRegistry extends DependencyRegistryShape {
    readonly trace: () => ReadonlyArray<FixtureRegistryCall>;
    readonly clearTrace: () => void;
}

function exactKeys(value: unknown, expected: ReadonlyArray<string>): value is Record<string, unknown> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
    ) {
        return false;
    }
    const names = Object.getOwnPropertyNames(value).sort(compareCodePoints);
    const wanted = [...expected].sort(compareCodePoints);
    return (
        names.length === wanted.length &&
        names.every((name, index) => name === wanted[index]) &&
        names.every((name) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
        })
    );
}

function denseArray(value: unknown, maximum: number): ReadonlyArray<unknown> {
    if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > maximum ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).filter((key) => key !== 'length').length !== value.length
    ) {
        throw new TypeError('The fixture registry contains a noncanonical array');
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        snapshot.push(value[index]);
    }
    return Object.freeze(snapshot);
}

function packageKey(canonicalIri: string, version: string, digest: string): string {
    return `${canonicalIri}\u0000${version}\u0000${digest}`;
}

function deepFreezeJson<Value>(value: Value): Value {
    if (Array.isArray(value)) {
        for (const item of value) {
            deepFreezeJson(item);
        }
        return Object.freeze(value);
    }
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) {
            deepFreezeJson(child);
        }
        return Object.freeze(value);
    }
    return value;
}

/** In-process, immutable registry fixture. It has no filesystem, clock, or network capability. */
export function makeFixtureDependencyRegistry(input: FixtureRegistryInput): FixtureDependencyRegistry {
    if (!exactKeys(input, ['registryOrigin', 'aliases', 'packages'])) {
        throw new TypeError('The fixture registry input is not closed data');
    }
    const registryOrigin = normalizeRegistryOrigin(input.registryOrigin);
    if (registryOrigin !== input.registryOrigin) {
        throw new TypeError('The fixture registry origin must be canonical');
    }
    const aliases = denseArray(input.aliases, 1024)
        .map((entry) => {
            if (
                !exactKeys(entry, ['alias', 'canonicalIri']) ||
                typeof entry.alias !== 'string' ||
                typeof entry.canonicalIri !== 'string'
            ) {
                throw new TypeError('The fixture registry alias is invalid');
            }
            return Object.freeze({ alias: entry.alias, canonicalIri: entry.canonicalIri });
        })
        .sort((left, right) => compareCodePoints(left.alias, right.alias));
    if (new Set(aliases.map((entry) => entry.alias)).size !== aliases.length) {
        throw new TypeError('The fixture registry aliases are ambiguous');
    }
    const packages = denseArray(input.packages, 8192)
        .map((entry) => {
            if (
                !exactKeys(entry, ['archive', 'archiveSha256', 'canonicalIri', 'manifest', 'version']) ||
                typeof entry.canonicalIri !== 'string' ||
                typeof entry.version !== 'string' ||
                typeof entry.archiveSha256 !== 'string' ||
                !(entry.archive instanceof Uint8Array)
            ) {
                throw new TypeError('The fixture registry package is invalid');
            }
            const archive = Uint8Array.from(entry.archive);
            const manifest = deepFreezeJson(
                decodeCanonicalPackageManifest(encodeCanonicalPackageManifest(entry.manifest as PackageManifestV1)),
            );
            return Object.freeze({
                canonicalIri: entry.canonicalIri,
                version: entry.version,
                archiveSha256: entry.archiveSha256,
                manifest,
                archive,
            });
        })
        .sort((left, right) =>
            compareCodePoints(
                packageKey(left.canonicalIri, left.version, left.archiveSha256),
                packageKey(right.canonicalIri, right.version, right.archiveSha256),
            ),
        );
    const packageKeys = packages.map((entry) => packageKey(entry.canonicalIri, entry.version, entry.archiveSha256));
    if (new Set(packageKeys).size !== packageKeys.length) {
        throw new TypeError('The fixture registry packages are ambiguous');
    }
    const calls: FixtureRegistryCall[] = [];
    function push(call: FixtureRegistryCall): void {
        calls.push(Object.freeze(call));
    }
    return Object.freeze({
        resolveAlias: (origin: string, alias: string) => {
            push({ operation: 'resolve-alias', registryOrigin: origin, alias });
            return Promise.resolve(
                origin !== registryOrigin ? null : (aliases.find((entry) => entry.alias === alias) ?? null),
            );
        },
        listPublished: (origin: string, canonicalIri: string) => {
            push({ operation: 'list-published', registryOrigin: origin, canonicalIri });
            if (origin !== registryOrigin) {
                return Promise.resolve(Object.freeze([]));
            }
            return Promise.resolve(
                Object.freeze(
                    packages
                        .filter((entry) => entry.canonicalIri === canonicalIri)
                        .map((entry) =>
                            Object.freeze({
                                canonicalIri: entry.canonicalIri,
                                version: entry.version,
                                archiveSha256: entry.archiveSha256,
                                manifest: entry.manifest,
                            }),
                        ),
                ),
            );
        },
        fetchArchive: (origin: string, lockedInput: LockPackageNode) => {
            const locked = decodeLockPackageNode(lockedInput);
            push({
                operation: 'fetch-archive',
                registryOrigin: origin,
                canonicalIri: locked.canonicalIri,
                version: locked.version,
                archiveSha256: locked.archiveSha256,
            });
            if (origin !== registryOrigin) {
                return Promise.resolve(null);
            }
            const found = packages.find(
                (entry) =>
                    packageKey(entry.canonicalIri, entry.version, entry.archiveSha256) ===
                    packageKey(locked.canonicalIri, locked.version, locked.archiveSha256),
            );
            return Promise.resolve(found === undefined ? null : Uint8Array.from(found.archive));
        },
        trace: () => Object.freeze(calls.map((call) => Object.freeze({ ...call }))),
        clearTrace: () => {
            calls.splice(0, calls.length);
        },
    });
}
