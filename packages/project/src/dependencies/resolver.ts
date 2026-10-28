import { Context, Effect } from 'effect';
import { rcompare, satisfies, valid, validRange } from 'semver';

import {
    decodeLockfileValue,
    serializeLockfile,
    LockfileError,
    manifestDependencyProjectionSha256,
    decodeLockToolchain,
    isBoundedLockfileScalar,
    LOCKFILE_LIMITS,
    type LockfileV1,
    type LockPackageNode,
    type LockToolchain,
    compareCodePoints,
    isCanonicalOntologyIri,
    isRegistryOrigin,
    isScopedAlias,
    normalizeRegistryOrigin,
    REGISTRY_RELEASE_INDEX_LIMITS,
    decodeRegistryAliasResolution,
    decodeRegistryReleaseIndexPage,
    encodeRegistryIndexRelease,
    type RegistryIndexDependency,
    type RegistryReleaseIndexReaderShape,
} from '@erden/contracts';
import type { ManifestV1 } from '@erden/contracts';
import {
    decodeCanonicalPackageManifest,
    encodeCanonicalPackageManifest,
    PACKAGE_CODEC_LIMITS,
    type PackageManifestV1,
} from '@erden/package-format';

import type { ApplicationOperation } from '../index.js';

import {
    DependencyCatalog,
    type CatalogAliasResolution,
    type DependencyCatalogShape,
    type PublishedPackageRecord,
} from './catalog.js';
import {
    DependencyResolutionError,
    isDependencyResolutionError,
    type DependencyConflictConstraint,
    type DependencyConflictDetails,
    type DependencyConstraintSource,
    type DependencyResolutionErrorCode,
} from './errors.js';

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const EXACT_RECORD_KEYS = ['archiveSha256', 'canonicalIri', 'manifest', 'version'] as const;
const EXACT_ALIAS_KEYS = ['alias', 'canonicalIri'] as const;

function safelyIsLockfileError(value: unknown): value is LockfileError {
    try {
        return value instanceof LockfileError;
    } catch {
        return false;
    }
}

export interface DependencyResolverLimits {
    readonly maxDirectDependencies: number;
    readonly maxAliasLookups: number;
    readonly maxCatalogCalls: number;
    readonly maxCatalogMetadataBytes: number;
    readonly maxReleasesPerPackage: number;
    readonly maxPackages: number;
    readonly maxEdges: number;
    readonly maxConstraintsPerPackage: number;
    readonly maxConflictBytes: number;
    readonly maxSearchStates: number;
}

export const DEPENDENCY_RESOLVER_LIMITS: DependencyResolverLimits = Object.freeze({
    maxDirectDependencies: LOCKFILE_LIMITS.maxDirectDependencies,
    maxAliasLookups: LOCKFILE_LIMITS.maxAliasMappings,
    maxCatalogCalls: 8_192,
    maxCatalogMetadataBytes: REGISTRY_RELEASE_INDEX_LIMITS.maxResolverMetadataBytes,
    maxReleasesPerPackage: 2_048,
    maxPackages: LOCKFILE_LIMITS.maxPackages,
    maxEdges: LOCKFILE_LIMITS.maxEdges,
    maxConstraintsPerPackage: LOCKFILE_LIMITS.maxDirectDependencies,
    maxConflictBytes: 56 * 1_024,
    maxSearchStates: 100_000,
});

export interface ResolveDependenciesInput {
    readonly manifest: ManifestV1;
    readonly toolchain: LockToolchain;
    readonly existingLock?: LockfileV1;
    readonly selection?: DependencySelectionPolicy;
    readonly limits?: Partial<DependencyResolverLimits>;
}

export type DependencySelectionPolicy =
    | Readonly<{ readonly kind: 'update-full-graph' }>
    | Readonly<{ readonly kind: 'update-targeted-frozen'; readonly identifier: string }>;

export interface ResolvedDependenciesResult {
    readonly status: 'resolved';
    readonly lock: LockfileV1;
    readonly lockfileText: string;
}

export type DependencyResolutionResult = ResolvedDependenciesResult;

interface DirectIdentity {
    readonly identifier: string;
    readonly requested: string;
    readonly canonicalIri: string;
}

interface ResolverRelease {
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
    readonly toolchain: LockToolchain;
    readonly dependencies: ReadonlyArray<RegistryIndexDependency>;
}

type ResolverRegistrySource =
    | Readonly<{ readonly kind: 'legacy-catalog'; readonly catalog: DependencyCatalogShape }>
    | Readonly<{ readonly kind: 'release-index'; readonly index: RegistryReleaseIndexReaderShape }>;

interface Constraint {
    readonly requested: string;
    readonly source: DependencyConstraintSource;
    readonly depth: number;
    readonly exactVersion?: string;
    readonly exactDigest?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
        return false;
    }
    const actual = Object.getOwnPropertyNames(value).sort(compareCodePoints);
    const expected = [...keys].sort(compareCodePoints);
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyDataProperties(value: object, keys: ReadonlyArray<string>): boolean {
    return keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && 'value' in descriptor;
    });
}

function snapshotDenseArray(value: unknown, label: string, maximumLength: number): ReadonlyArray<unknown> {
    try {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
            throw new Error('not a plain array');
        }
        if (
            !Number.isSafeInteger(value.length) ||
            value.length > maximumLength ||
            Object.getOwnPropertySymbols(value).length !== 0
        ) {
            throw new Error('bound or symbol');
        }
        const expected = Array.from({ length: value.length }, (_, index) => String(index));
        const names = Object.getOwnPropertyNames(value).filter((name) => name !== 'length');
        if (
            names.length !== expected.length ||
            names.some((name, index) => name !== expected[index]) ||
            !hasOnlyDataProperties(value, expected)
        ) {
            throw new Error('holes or accessors');
        }
        return Object.freeze(expected.map((key) => Object.getOwnPropertyDescriptor(value, key)?.value as unknown));
    } catch (error) {
        if (isDependencyResolutionError(error)) {
            throw error;
        }
        throw new DependencyResolutionError(
            'catalog-incoherent',
            `The catalog ${label} is not one closed dense release array`,
            error,
        );
    }
}

function assertPlainJson(value: unknown): void {
    const pending: Array<{
        readonly value: unknown;
        readonly depth: number;
    }> = [{ value, depth: 1 }];
    const seen = new Set<object>();
    let nodes = 0;
    while (pending.length > 0) {
        const item = pending.pop();
        if (item === undefined) {
            continue;
        }
        nodes += 1;
        if (nodes > LOCKFILE_LIMITS.maxYamlNodes || item.depth > LOCKFILE_LIMITS.maxGraphDepth) {
            throw new Error('catalog JSON node or depth bound');
        }
        const candidate = item.value;
        if (candidate === null || typeof candidate === 'boolean') {
            continue;
        }
        if (typeof candidate === 'string') {
            if (!isBoundedLockfileScalar(candidate)) {
                throw new Error('catalog JSON scalar bound');
            }
            continue;
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate) && !Object.is(candidate, -0)) {
            continue;
        }
        if (Array.isArray(candidate)) {
            if (
                Object.getPrototypeOf(candidate) !== Array.prototype ||
                Object.getOwnPropertySymbols(candidate).length !== 0 ||
                seen.has(candidate) ||
                candidate.length > LOCKFILE_LIMITS.maxYamlNodes
            ) {
                throw new Error('reused, decorated, or oversized array');
            }
            const names = Object.getOwnPropertyNames(candidate).filter((name) => name !== 'length');
            if (names.length !== candidate.length) {
                throw new Error('sparse or decorated array');
            }
            seen.add(candidate);
            for (let index = candidate.length - 1; index >= 0; index -= 1) {
                const key = String(index);
                const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
                if (
                    names[index] !== key ||
                    descriptor === undefined ||
                    !('value' in descriptor) ||
                    !descriptor.enumerable
                ) {
                    throw new Error('sparse, hidden, or accessor array item');
                }
                pending.push({ value: descriptor.value, depth: item.depth + 1 });
            }
            continue;
        }
        if (!isPlainRecord(candidate) || Object.getOwnPropertySymbols(candidate).length !== 0 || seen.has(candidate)) {
            throw new Error('non-JSON, reused, or decorated object');
        }
        const names = Object.getOwnPropertyNames(candidate);
        if (names.length > LOCKFILE_LIMITS.maxYamlNodes) {
            throw new Error('catalog JSON object field bound');
        }
        seen.add(candidate);
        for (let index = names.length - 1; index >= 0; index -= 1) {
            const key = names[index];
            if (
                key === undefined ||
                !key.isWellFormed() ||
                key === '__proto__' ||
                key === 'constructor' ||
                key === 'prototype'
            ) {
                throw new Error('unsafe key');
            }
            const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('hidden or accessor object field');
            }
            pending.push({ value: descriptor.value, depth: item.depth + 1 });
        }
    }
}

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function normalizeLimits(overrides: Partial<DependencyResolverLimits> = {}): DependencyResolverLimits {
    if (!isPlainRecord(overrides) || Object.getOwnPropertySymbols(overrides).length !== 0) {
        throw new DependencyResolutionError(
            'invalid-resolver-input',
            'Dependency resolver limits must be one plain data record',
        );
    }
    const allowed = new Set(Object.keys(DEPENDENCY_RESOLVER_LIMITS));
    const overrideValues: Partial<Record<keyof DependencyResolverLimits, number>> = {};
    for (const key of Object.getOwnPropertyNames(overrides)) {
        const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
        if (!allowed.has(key) || descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new DependencyResolutionError(
                'invalid-resolver-input',
                'Dependency resolver limits contain an unknown or accessor field',
            );
        }
        const candidate: unknown = descriptor.value;
        if (typeof candidate !== 'number') {
            throw new DependencyResolutionError(
                'invalid-resolver-input',
                `Dependency resolver limit ${key} must be numeric`,
            );
        }
        overrideValues[key as keyof DependencyResolverLimits] = candidate;
    }
    const limits = { ...DEPENDENCY_RESOLVER_LIMITS, ...overrideValues };
    for (const [key, value] of Object.entries(limits)) {
        const maximum = DEPENDENCY_RESOLVER_LIMITS[key as keyof DependencyResolverLimits];
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
            throw new DependencyResolutionError(
                'invalid-resolver-input',
                `Dependency resolver limit ${key} must be a positive safe integer no greater than its closed v1 maximum`,
            );
        }
    }
    return Object.freeze(limits);
}

function snapshotSelection(value: unknown): DependencySelectionPolicy | undefined {
    if (value === undefined) {
        return undefined;
    }
    try {
        if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
            throw new Error('shape');
        }
        const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
        if (kindDescriptor === undefined || !('value' in kindDescriptor) || !kindDescriptor.enumerable) {
            throw new Error('kind');
        }
        const kind: unknown = kindDescriptor.value;
        if (kind === 'update-full-graph') {
            if (!hasExactKeys(value, ['kind'])) {
                throw new Error('fields');
            }
            return Object.freeze({ kind });
        }
        if (kind === 'update-targeted-frozen') {
            if (!hasExactKeys(value, ['identifier', 'kind'])) {
                throw new Error('fields');
            }
            const identifierDescriptor = Object.getOwnPropertyDescriptor(value, 'identifier');
            const identifier: unknown =
                identifierDescriptor !== undefined && 'value' in identifierDescriptor
                    ? (identifierDescriptor.value as unknown)
                    : undefined;
            if (
                identifierDescriptor === undefined ||
                !identifierDescriptor.enumerable ||
                typeof identifier !== 'string' ||
                (!isScopedAlias(identifier) && !isCanonicalOntologyIri(identifier)) ||
                !isBoundedLockfileScalar(identifier)
            ) {
                throw new Error('identifier');
            }
            return Object.freeze({ kind, identifier });
        }
        throw new Error('kind');
    } catch (error) {
        if (isDependencyResolutionError(error)) {
            throw error;
        }
        throw new DependencyResolutionError(
            'invalid-resolver-input',
            'Dependency resolver selection must be one closed update policy',
            error,
        );
    }
}

function snapshotManifest(
    manifest: ManifestV1,
    maximumDependencies: number,
): Readonly<{
    canonicalIri: string;
    alias: string;
    registry?: string;
    dependencies: Readonly<Record<string, string>>;
}> {
    const unknownManifest: unknown = manifest;
    if (
        !isPlainRecord(unknownManifest) ||
        !hasOnlyDataProperties(unknownManifest, ['alias', 'canonicalIri', 'dependencies'])
    ) {
        throw new DependencyResolutionError(
            'invalid-resolver-input',
            'The normalized dependency manifest identity is invalid',
        );
    }
    const canonicalIri = unknownManifest.canonicalIri;
    const alias = unknownManifest.alias;
    if (
        typeof canonicalIri !== 'string' ||
        !isCanonicalOntologyIri(canonicalIri) ||
        !isBoundedLockfileScalar(canonicalIri) ||
        typeof alias !== 'string' ||
        !isScopedAlias(alias) ||
        !isBoundedLockfileScalar(alias)
    ) {
        throw new DependencyResolutionError(
            'invalid-resolver-input',
            'The normalized dependency manifest identity is invalid',
        );
    }
    const rawDependencies = unknownManifest.dependencies;
    if (!isPlainRecord(rawDependencies) || Object.getOwnPropertySymbols(rawDependencies).length !== 0) {
        throw new DependencyResolutionError('invalid-resolver-input', 'The normalized dependency map is invalid');
    }
    const dependencies: Record<string, string> = Object.create(null) as Record<string, string>;
    const dependencyNames = Object.getOwnPropertyNames(rawDependencies);
    if (dependencyNames.length > maximumDependencies) {
        throw new DependencyResolutionError(
            'resolution-limit',
            'The direct dependency count exceeds the resolver bound',
        );
    }
    for (const identifier of dependencyNames.sort(compareCodePoints)) {
        const descriptor = Object.getOwnPropertyDescriptor(rawDependencies, identifier);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new DependencyResolutionError(
                'invalid-resolver-input',
                'The normalized dependency map contains an accessor or hidden field',
            );
        }
        const requested: unknown = descriptor.value;
        if (
            (!isScopedAlias(identifier) && !isCanonicalOntologyIri(identifier)) ||
            !isBoundedLockfileScalar(identifier) ||
            typeof requested !== 'string' ||
            !isBoundedLockfileScalar(requested) ||
            requested.trim() !== requested ||
            validRange(requested, { loose: false }) === null
        ) {
            throw new DependencyResolutionError(
                'invalid-resolver-input',
                `The authored dependency ${identifier} is invalid`,
            );
        }
        dependencies[identifier] = requested;
    }
    const registryDescriptor = Object.getOwnPropertyDescriptor(unknownManifest, 'registry');
    if (registryDescriptor !== undefined && (!('value' in registryDescriptor) || !registryDescriptor.enumerable)) {
        throw new DependencyResolutionError(
            'invalid-resolver-input',
            'The normalized registry origin is an accessor or hidden field',
        );
    }
    const registry: unknown = registryDescriptor?.value;
    if (
        registry !== undefined &&
        (typeof registry !== 'string' ||
            !isRegistryOrigin(registry) ||
            !isBoundedLockfileScalar(registry) ||
            normalizeRegistryOrigin(registry) !== registry)
    ) {
        throw new DependencyResolutionError('invalid-resolver-input', 'The normalized registry origin is invalid');
    }
    return Object.freeze({
        canonicalIri,
        alias,
        ...(registry === undefined ? {} : { registry }),
        dependencies: Object.freeze(dependencies),
    });
}

function validateAliasResolution(value: CatalogAliasResolution | null, alias: string): CatalogAliasResolution {
    try {
        const unknownValue: unknown = value;
        if (
            !isPlainRecord(unknownValue) ||
            !hasExactKeys(unknownValue, EXACT_ALIAS_KEYS) ||
            !hasOnlyDataProperties(unknownValue, EXACT_ALIAS_KEYS) ||
            unknownValue.alias !== alias ||
            typeof unknownValue.canonicalIri !== 'string' ||
            !isCanonicalOntologyIri(unknownValue.canonicalIri) ||
            !isBoundedLockfileScalar(unknownValue.canonicalIri)
        ) {
            throw new Error('invalid alias identity');
        }
        return Object.freeze({ alias, canonicalIri: unknownValue.canonicalIri });
    } catch (error) {
        if (isDependencyResolutionError(error)) {
            throw error;
        }
        throw new DependencyResolutionError(
            'catalog-incoherent',
            `The catalog returned an invalid identity for ${alias}`,
            error,
        );
    }
}

function validatePackageRecord(
    value: PublishedPackageRecord,
    requestedIri: string,
    maximumDependencies: number,
): ResolverRelease {
    const unknownValue: unknown = value;
    try {
        if (
            !isPlainRecord(unknownValue) ||
            !hasExactKeys(unknownValue, EXACT_RECORD_KEYS) ||
            !hasOnlyDataProperties(unknownValue, EXACT_RECORD_KEYS)
        ) {
            throw new Error('record shape');
        }
        const rawManifest: unknown = unknownValue.manifest;
        if (!isPlainRecord(rawManifest) || !hasOnlyDataProperties(rawManifest, ['dependencies', 'files'])) {
            throw new Error('manifest collection shape');
        }
        const rawDependencies: unknown = rawManifest.dependencies;
        const rawFiles: unknown = rawManifest.files;
        if (
            !Array.isArray(rawDependencies) ||
            !Array.isArray(rawFiles) ||
            rawDependencies.length > maximumDependencies ||
            rawFiles.length > PACKAGE_CODEC_LIMITS.maxEntries
        ) {
            throw new Error('manifest collection bound');
        }
        assertPlainJson(unknownValue);
        if (
            unknownValue.canonicalIri !== requestedIri ||
            typeof unknownValue.version !== 'string' ||
            valid(unknownValue.version, { loose: false }) === null ||
            typeof unknownValue.archiveSha256 !== 'string' ||
            !SHA256_HEX.test(unknownValue.archiveSha256)
        ) {
            throw new Error('record identity');
        }
        const encoded = encodeCanonicalPackageManifest(unknownValue.manifest as PackageManifestV1);
        const manifest = decodeCanonicalPackageManifest(encoded);
        if (manifest.canonicalIri !== unknownValue.canonicalIri || manifest.version !== unknownValue.version) {
            throw new Error('manifest identity');
        }
        const boundedManifestScalars = [
            manifest.canonicalIri,
            manifest.version,
            manifest.toolchain.validator.version,
            manifest.toolchain.reasoner.version,
            ...manifest.dependencies.flatMap(({ requested, canonicalIri, version }) => [
                requested,
                canonicalIri,
                version,
            ]),
        ];
        if (boundedManifestScalars.some((value) => !isBoundedLockfileScalar(value))) {
            throw new Error('manifest scalar bound');
        }
        return Object.freeze({
            canonicalIri: unknownValue.canonicalIri,
            version: unknownValue.version,
            archiveSha256: unknownValue.archiveSha256,
            toolchain: deepFreeze(manifest.toolchain),
            dependencies: deepFreeze(manifest.dependencies),
        });
    } catch (error) {
        throw new DependencyResolutionError(
            'catalog-incoherent',
            `The catalog returned an invalid published record for ${requestedIri}`,
            error,
        );
    }
}

function compareReleases(left: ResolverRelease, right: ResolverRelease): number {
    const precedence = rcompare(left.version, right.version, { loose: false });
    return precedence !== 0 ? precedence : compareCodePoints(right.version, left.version);
}

function sameToolchain(releaseToolchain: LockToolchain, toolchain: LockToolchain): boolean {
    return (
        releaseToolchain.validator.version === toolchain.validator.version &&
        releaseToolchain.validator.sha256 === toolchain.validator.sha256 &&
        releaseToolchain.reasoner.version === toolchain.reasoner.version &&
        releaseToolchain.reasoner.sha256 === toolchain.reasoner.sha256
    );
}

function sameEdges(
    left: ReadonlyArray<{
        readonly requested: string;
        readonly canonicalIri: string;
        readonly version: string;
        readonly archiveSha256: string;
    }>,
    right: ReadonlyArray<{
        readonly requested: string;
        readonly canonicalIri: string;
        readonly version: string;
        readonly archiveSha256: string;
    }>,
): boolean {
    return (
        left.length === right.length &&
        left.every((edge, index) => {
            const other = right[index];
            return (
                other !== undefined &&
                edge.requested === other.requested &&
                edge.canonicalIri === other.canonicalIri &&
                edge.version === other.version &&
                edge.archiveSha256 === other.archiveSha256
            );
        })
    );
}

function recordFromLockedNode(node: LockPackageNode, toolchain: LockToolchain): ResolverRelease {
    return Object.freeze({
        canonicalIri: node.canonicalIri,
        version: node.version,
        archiveSha256: node.archiveSha256,
        dependencies: node.dependencies,
        toolchain,
    });
}

function recordMatchesLockedNode(record: ResolverRelease, node: LockPackageNode, toolchain: LockToolchain): boolean {
    return (
        record.canonicalIri === node.canonicalIri &&
        record.version === node.version &&
        record.archiveSha256 === node.archiveSha256 &&
        sameToolchain(record.toolchain, toolchain) &&
        sameEdges(record.dependencies, node.dependencies)
    );
}

function sameLockedNode(left: LockPackageNode | undefined, right: LockPackageNode | undefined): boolean {
    return (
        left !== undefined &&
        right !== undefined &&
        left.canonicalIri === right.canonicalIri &&
        left.version === right.version &&
        left.archiveSha256 === right.archiveSha256 &&
        sameEdges(left.dependencies, right.dependencies)
    );
}

function satisfiesConstraints(record: ResolverRelease, constraints: ReadonlyArray<Constraint>): boolean {
    return constraints.every(
        (constraint) =>
            satisfies(record.version, constraint.requested, { loose: false }) &&
            (constraint.exactVersion === undefined || constraint.exactVersion === record.version) &&
            (constraint.exactDigest === undefined || constraint.exactDigest === record.archiveSha256),
    );
}

function addConstraint(
    constraints: Map<string, Constraint[]>,
    canonicalIri: string,
    constraint: Constraint,
    maximumConstraints: number,
    maximumConflictBytes: number,
): void {
    const values = constraints.get(canonicalIri) ?? [];
    if (values.length >= maximumConstraints) {
        throw new DependencyResolutionError(
            'resolution-limit',
            `The dependency constraint fan-in bound was exhausted for ${canonicalIri}`,
        );
    }
    const frozen = Object.freeze({ ...constraint });
    const prospective = [...values, frozen];
    if (
        messageEncoder.encode(JSON.stringify(conflictDetails(canonicalIri, prospective))).byteLength >
        maximumConflictBytes
    ) {
        throw new DependencyResolutionError(
            'resolution-limit',
            `The dependency conflict evidence byte bound was exhausted for ${canonicalIri}`,
        );
    }
    if (!constraints.has(canonicalIri)) {
        constraints.set(canonicalIri, values);
    }
    values.push(frozen);
}

interface CycleEvidence {
    readonly at: string;
    readonly length: number;
    readonly path?: string;
}

const MAX_RESOLUTION_MESSAGE_BYTES = 64 * 1_024;
const messageEncoder = new TextEncoder();

function cycleAt(selected: ReadonlyMap<string, ResolverRelease>): CycleEvidence | undefined {
    const complete = new Set<string>();
    for (const root of [...selected.keys()].sort(compareCodePoints)) {
        if (complete.has(root)) {
            continue;
        }
        const active = new Set<string>([root]);
        const stack: Array<{
            canonicalIri: string;
            nextEdge: number;
        }> = [{ canonicalIri: root, nextEdge: 0 }];
        while (stack.length > 0) {
            const frame = stack.at(-1);
            if (frame === undefined) {
                break;
            }
            const edges = selected.get(frame.canonicalIri)?.dependencies ?? [];
            let edge = edges[frame.nextEdge];
            while (edge !== undefined && !selected.has(edge.canonicalIri)) {
                frame.nextEdge += 1;
                edge = edges[frame.nextEdge];
            }
            if (edge === undefined) {
                stack.pop();
                active.delete(frame.canonicalIri);
                complete.add(frame.canonicalIri);
                continue;
            }
            frame.nextEdge += 1;
            if (active.has(edge.canonicalIri)) {
                const start = stack.findIndex(({ canonicalIri }) => canonicalIri === edge.canonicalIri);
                const length = stack.length - start;
                let pathBytes = 0;
                for (let index = start; index < stack.length; index += 1) {
                    const canonicalIri = stack[index]?.canonicalIri;
                    if (canonicalIri !== undefined) {
                        pathBytes += messageEncoder.encode(canonicalIri).byteLength + 4;
                    }
                    if (pathBytes > MAX_RESOLUTION_MESSAGE_BYTES) {
                        break;
                    }
                }
                pathBytes += messageEncoder.encode(edge.canonicalIri).byteLength;
                const candidatePath =
                    pathBytes <= MAX_RESOLUTION_MESSAGE_BYTES
                        ? [...stack.slice(start).map(({ canonicalIri }) => canonicalIri), edge.canonicalIri].join(
                              ' -> ',
                          )
                        : undefined;
                const path =
                    candidatePath !== undefined &&
                    messageEncoder.encode(
                        `The selected package graph cycles (${String(length)} edges): ${candidatePath}`,
                    ).byteLength <= MAX_RESOLUTION_MESSAGE_BYTES
                        ? candidatePath
                        : undefined;
                return Object.freeze({ at: edge.canonicalIri, length, ...(path === undefined ? {} : { path }) });
            }
            if (!complete.has(edge.canonicalIri)) {
                active.add(edge.canonicalIri);
                stack.push({ canonicalIri: edge.canonicalIri, nextEdge: 0 });
            }
        }
    }
    return undefined;
}

function conflictDetails(canonicalIri: string, constraints: ReadonlyArray<Constraint>): DependencyConflictDetails {
    function sourceFields(source: DependencyConstraintSource): ReadonlyArray<string> {
        return source.kind === 'root'
            ? ['root', source.identifier]
            : ['package-edge', source.fromCanonicalIri, source.fromVersion];
    }
    function compareConstraints(left: DependencyConflictConstraint, right: DependencyConflictConstraint): number {
        const fields: ReadonlyArray<readonly [string, string]> = [
            ...sourceFields(left.source).map(
                (field, index) => [field, sourceFields(right.source)[index] ?? ''] as const,
            ),
            [left.requested, right.requested],
            [left.exactVersion ?? '', right.exactVersion ?? ''],
            [left.archiveSha256 ?? '', right.archiveSha256 ?? ''],
        ];
        for (const [leftField, rightField] of fields) {
            const compared = compareCodePoints(leftField, rightField);
            if (compared !== 0) {
                return compared;
            }
        }
        return 0;
    }
    const values = constraints
        .map(({ source, requested, exactVersion, exactDigest }) =>
            Object.freeze({
                source:
                    source.kind === 'root'
                        ? Object.freeze({ kind: 'root' as const, identifier: source.identifier })
                        : Object.freeze({
                              kind: 'package-edge' as const,
                              fromCanonicalIri: source.fromCanonicalIri,
                              fromVersion: source.fromVersion,
                          }),
                requested,
                exactVersion: exactVersion ?? null,
                archiveSha256: exactDigest ?? null,
            }),
        )
        .sort(compareConstraints);
    return Object.freeze({
        canonicalIri,
        depth: constraints.reduce((maximum, constraint) => Math.max(maximum, constraint.depth), 0),
        constraints: Object.freeze(values),
    });
}

function compareConflicts(left: DependencyConflictDetails, right: DependencyConflictDetails): number {
    const identity = compareCodePoints(left.canonicalIri, right.canonicalIri);
    if (identity !== 0) {
        return identity;
    }
    for (let index = 0; index < Math.min(left.constraints.length, right.constraints.length); index += 1) {
        const leftConstraint = left.constraints[index];
        const rightConstraint = right.constraints[index];
        if (leftConstraint === undefined || rightConstraint === undefined) {
            break;
        }
        const leftSource = leftConstraint.source;
        const rightSource = rightConstraint.source;
        const fields: ReadonlyArray<readonly [string, string]> = [
            [leftSource.kind, rightSource.kind],
            [
                leftSource.kind === 'root' ? leftSource.identifier : leftSource.fromCanonicalIri,
                rightSource.kind === 'root' ? rightSource.identifier : rightSource.fromCanonicalIri,
            ],
            [
                leftSource.kind === 'package-edge' ? leftSource.fromVersion : '',
                rightSource.kind === 'package-edge' ? rightSource.fromVersion : '',
            ],
            [leftConstraint.requested, rightConstraint.requested],
            [leftConstraint.exactVersion ?? '', rightConstraint.exactVersion ?? ''],
            [leftConstraint.archiveSha256 ?? '', rightConstraint.archiveSha256 ?? ''],
        ];
        for (const [leftField, rightField] of fields) {
            const compared = compareCodePoints(leftField, rightField);
            if (compared !== 0) {
                return compared;
            }
        }
    }
    return left.constraints.length - right.constraints.length;
}

/** Up to five versions in ascending semver order, for a refusal message. */
function versionList(versions: ReadonlyArray<string>): string {
    return [...versions]
        .sort((left, right) => rcompare(right, left))
        .slice(0, 5)
        .join(', ');
}

/**
 * Why no candidate exists when the toolchain is the cause: no release is under the current toolchain, or only releases
 * under an earlier one meet the requirements. A published version is immutable, so the remedy is a new version under
 * the current toolchain and, for a dependent whose requirement excludes it, a wider requirement.
 */
function toolchainRefusal(
    canonicalIri: string,
    releases: ReadonlyArray<ResolverRelease>,
    compatible: ReadonlyArray<ResolverRelease>,
    constraints: ReadonlyArray<Constraint>,
    toolchain: LockToolchain,
): DependencyResolutionError | undefined {
    const current = `reasoner ${toolchain.reasoner.version}, validator ${toolchain.validator.version}`;
    if (compatible.length === 0) {
        return new DependencyResolutionError(
            'toolchain-incompatible',
            `No release of ${canonicalIri} was published under the current Erden toolchain (${current}); the dependency must be republished as a new version under the current toolchain before it can be installed, because a published version cannot be replaced`,
        );
    }
    const earlier = releases
        .filter((release) => !sameToolchain(release.toolchain, toolchain) && satisfiesConstraints(release, constraints))
        .map((release) => release.version);
    if (earlier.length === 0 || compatible.some((release) => satisfiesConstraints(release, constraints))) {
        return undefined;
    }
    return new DependencyResolutionError(
        'toolchain-incompatible',
        `Only releases of ${canonicalIri} published under an earlier Erden toolchain (${versionList(earlier)}) meet its requirements; the current toolchain (${current}) has ${versionList(compatible.map((release) => release.version))}, so widen the requirement to a version published under it`,
    );
}

function versionConflict(canonicalIri: string, constraints: ReadonlyArray<Constraint>): DependencyResolutionError {
    const conflict = conflictDetails(canonicalIri, constraints);
    return new DependencyResolutionError(
        'version-conflict',
        `No one-version dependency solution exists for ${canonicalIri} with ${String(conflict.constraints.length)} contributing constraints`,
        undefined,
        conflict,
    );
}

function branchError(
    canonicalIri: string,
    errors: ReadonlyArray<DependencyResolutionError>,
    constraints: ReadonlyArray<Constraint>,
): DependencyResolutionError {
    const priorities: ReadonlyArray<DependencyResolutionErrorCode> = [
        'dependency-cycle',
        'self-dependency',
        'version-conflict',
        'missing-version',
        'toolchain-incompatible',
    ];
    for (const code of priorities) {
        const matching = errors.filter((error) => error.code === code);
        if (matching.length === 0) {
            continue;
        }
        if (code !== 'version-conflict') {
            return matching[0] as DependencyResolutionError;
        }
        return [...matching].sort((left, right) => {
            const leftConflict = left.conflict;
            const rightConflict = right.conflict;
            if (leftConflict === undefined || rightConflict === undefined) {
                return leftConflict === undefined ? 1 : -1;
            }
            if (leftConflict.depth !== rightConflict.depth) {
                return rightConflict.depth - leftConflict.depth;
            }
            return compareConflicts(leftConflict, rightConflict);
        })[0] as DependencyResolutionError;
    }
    return versionConflict(canonicalIri, constraints);
}

function buildLock(
    manifest: ReturnType<typeof snapshotManifest>,
    toolchain: LockToolchain,
    direct: ReadonlyArray<DirectIdentity>,
    selected: ReadonlyMap<string, ResolverRelease>,
): LockfileV1 {
    const registryOrigin = direct.length === 0 ? null : (manifest.registry ?? null);
    const directDependencies = direct.map((dependency) => {
        const record = selected.get(dependency.canonicalIri);
        if (record === undefined) {
            throw new DependencyResolutionError('version-conflict', 'The dependency solution is incomplete');
        }
        return {
            identifier: dependency.identifier,
            requested: dependency.requested,
            canonicalIri: dependency.canonicalIri,
            version: record.version,
            archiveSha256: record.archiveSha256,
        };
    });
    const aliasMappings = directDependencies
        .filter(({ identifier }) => isScopedAlias(identifier))
        .map(({ identifier, canonicalIri }) => ({ alias: identifier, canonicalIri }));
    const packages = [...selected.values()]
        .sort((left, right) => compareCodePoints(left.canonicalIri, right.canonicalIri))
        .map((record) => ({
            canonicalIri: record.canonicalIri,
            version: record.version,
            archiveSha256: record.archiveSha256,
            dependencies: [...record.dependencies]
                .sort((left, right) => compareCodePoints(left.canonicalIri, right.canonicalIri))
                .map(({ requested, canonicalIri, version, archiveSha256 }) => ({
                    requested,
                    canonicalIri,
                    version,
                    archiveSha256,
                })),
        }));
    const lock = {
        lockfileVersion: 1 as const,
        registryOrigin,
        manifestDependencySha256: manifestDependencyProjectionSha256({
            canonicalIri: manifest.canonicalIri,
            alias: manifest.alias,
            registryOrigin,
            dependencies: manifest.dependencies,
        }),
        root: { canonicalIri: manifest.canonicalIri, alias: manifest.alias },
        directDependencies,
        aliasMappings,
        packages,
        toolchain,
        counts: {
            directDependencies: directDependencies.length,
            aliasMappings: aliasMappings.length,
            packages: packages.length,
            edges: packages.reduce((total, node) => total + node.dependencies.length, 0),
        },
    };
    try {
        return decodeLockfileValue(lock);
    } catch (error) {
        throw new DependencyResolutionError(
            'resolution-invariant',
            'The dependency solution could not be represented by the closed lockfile contract',
            error,
        );
    }
}

function resolvedResult(lock: LockfileV1): ResolvedDependenciesResult {
    try {
        return Object.freeze({ status: 'resolved', lock, lockfileText: serializeLockfile(lock) });
    } catch (error) {
        throw new DependencyResolutionError(
            'resolution-invariant',
            'The dependency solution could not be serialized by the closed lockfile contract',
            error,
        );
    }
}

function frozenClosureForTarget(
    lock: LockfileV1,
    identifier: string,
): Readonly<{
    readonly target: LockPackageNode;
    readonly frozen: ReadonlySet<string>;
}> {
    const direct = lock.directDependencies.find((candidate) => candidate.identifier === identifier);
    if (direct === undefined) {
        throw new DependencyResolutionError(
            'invalid-resolver-input',
            'The targeted update identifier is not one exact authored dependency',
        );
    }
    const nodes = new Map(lock.packages.map((node) => [node.canonicalIri, node]));
    const target = nodes.get(direct.canonicalIri);
    if (target === undefined) {
        throw new DependencyResolutionError('resolution-invariant', 'The targeted update lock graph is incomplete');
    }
    const frozen = new Set<string>();
    const pending = lock.directDependencies
        .filter((candidate) => candidate.identifier !== identifier)
        .map((candidate) => candidate.canonicalIri)
        .sort(compareCodePoints)
        .reverse();
    while (pending.length > 0) {
        const canonicalIri = pending.pop();
        if (canonicalIri === undefined || frozen.has(canonicalIri)) {
            continue;
        }
        const node = nodes.get(canonicalIri);
        if (node === undefined) {
            throw new DependencyResolutionError('resolution-invariant', 'The targeted update lock graph is incomplete');
        }
        frozen.add(canonicalIri);
        for (const edge of [...node.dependencies]
            .sort((left, right) => compareCodePoints(left.canonicalIri, right.canonicalIri))
            .reverse()) {
            pending.push(edge.canonicalIri);
        }
    }
    return Object.freeze({ target, frozen });
}

async function resolveWithRegistry(
    input: ResolveDependenciesInput,
    source: ResolverRegistrySource,
    signal: AbortSignal,
): Promise<DependencyResolutionResult> {
    const limits = normalizeLimits(input.limits);
    const manifest = snapshotManifest(input.manifest, limits.maxDirectDependencies);
    const toolchain = decodeLockToolchain(input.toolchain);
    const existingLock = input.existingLock === undefined ? undefined : decodeLockfileValue(input.existingLock);
    const selection = snapshotSelection(input.selection);
    const dependencyEntries = Object.entries(manifest.dependencies);
    if (selection !== undefined) {
        if (existingLock === undefined) {
            throw new DependencyResolutionError(
                'invalid-resolver-input',
                'Update selection requires one authenticated existing lock',
            );
        }
        const registryOrigin = dependencyEntries.length === 0 ? null : (manifest.registry ?? null);
        const projection = manifestDependencyProjectionSha256({
            canonicalIri: manifest.canonicalIri,
            alias: manifest.alias,
            registryOrigin,
            dependencies: manifest.dependencies,
        });
        if (
            existingLock.root.canonicalIri !== manifest.canonicalIri ||
            existingLock.root.alias !== manifest.alias ||
            existingLock.registryOrigin !== registryOrigin ||
            existingLock.manifestDependencySha256 !== projection ||
            existingLock.toolchain.validator.version !== toolchain.validator.version ||
            existingLock.toolchain.validator.sha256 !== toolchain.validator.sha256 ||
            existingLock.toolchain.reasoner.version !== toolchain.reasoner.version ||
            existingLock.toolchain.reasoner.sha256 !== toolchain.reasoner.sha256
        ) {
            throw new DependencyResolutionError(
                'existing-lock-mismatch',
                'Update selection requires a manifest- and toolchain-consistent existing lock',
            );
        }
    }
    if (dependencyEntries.length === 0) {
        if (selection?.kind === 'update-targeted-frozen') {
            throw new DependencyResolutionError(
                'invalid-resolver-input',
                'The targeted update identifier is not one exact authored dependency',
            );
        }
        if (
            existingLock !== undefined &&
            (existingLock.root.canonicalIri !== manifest.canonicalIri || existingLock.root.alias !== manifest.alias)
        ) {
            throw new DependencyResolutionError(
                'existing-lock-mismatch',
                'The existing lock belongs to a different root identity',
            );
        }
        const lock = buildLock(manifest, toolchain, [], new Map());
        return resolvedResult(lock);
    }
    if (dependencyEntries.length > limits.maxDirectDependencies) {
        throw new DependencyResolutionError(
            'search-exhausted',
            'The direct dependency count exceeds the resolver bound',
        );
    }
    if (manifest.registry === undefined) {
        throw new DependencyResolutionError(
            'registry-required',
            'A registry origin is required to resolve manifest dependencies',
        );
    }
    if (
        existingLock !== undefined &&
        (existingLock.root.canonicalIri !== manifest.canonicalIri ||
            existingLock.root.alias !== manifest.alias ||
            (existingLock.registryOrigin !== null && existingLock.registryOrigin !== manifest.registry))
    ) {
        throw new DependencyResolutionError(
            'existing-lock-mismatch',
            'The existing lock belongs to a different root identity or registry',
        );
    }
    let catalogCalls = 0;
    function throwIfInterrupted(): void {
        if (!signal.aborted) {
            return;
        }
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Dependency resolution was interrupted', 'AbortError');
    }
    const registryOrigin = manifest.registry;
    async function callRemote<A>(operation: () => Promise<A>): Promise<A> {
        throwIfInterrupted();
        catalogCalls += 1;
        if (catalogCalls > limits.maxCatalogCalls) {
            throw new DependencyResolutionError('search-exhausted', 'The dependency catalog call bound was exhausted');
        }
        let result: A;
        try {
            result = await operation();
        } catch (error) {
            if (isDependencyResolutionError(error)) {
                throw error;
            }
            throw new DependencyResolutionError('catalog-failure', 'The dependency catalog operation failed', error);
        }
        throwIfInterrupted();
        return result;
    }
    const direct: DirectIdentity[] = [];
    let aliases = 0;
    for (const [identifier, requested] of dependencyEntries) {
        let canonicalIri: string;
        if (isScopedAlias(identifier)) {
            aliases += 1;
            if (aliases > limits.maxAliasLookups) {
                throw new DependencyResolutionError('search-exhausted', 'The alias lookup bound was exhausted');
            }
            const result =
                source.kind === 'legacy-catalog'
                    ? await callRemote(
                          async () => await source.catalog.resolveAlias(registryOrigin, identifier, signal),
                      )
                    : await callRemote(async () => {
                          const raw = await source.index.resolveAlias(registryOrigin, identifier, signal);
                          if (raw === null) {
                              return null;
                          }
                          const decoded = decodeRegistryAliasResolution(raw);
                          if (decoded.registryOrigin !== registryOrigin || decoded.alias !== identifier) {
                              throw new DependencyResolutionError(
                                  'catalog-incoherent',
                                  `The release index returned an invalid identity for ${identifier}`,
                              );
                          }
                          return Object.freeze({ alias: decoded.alias, canonicalIri: decoded.canonicalIri });
                      });
            if (result === null) {
                throw new DependencyResolutionError(
                    'alias-not-found',
                    `The catalog has no published identity for ${identifier}`,
                );
            }
            canonicalIri = validateAliasResolution(result, identifier).canonicalIri;
            const previous = existingLock?.aliasMappings.find(({ alias }) => alias === identifier);
            if (previous !== undefined && previous.canonicalIri !== canonicalIri) {
                throw new DependencyResolutionError(
                    'alias-retarget',
                    `Authored alias ${identifier} changed canonical identity`,
                );
            }
        } else {
            canonicalIri = identifier;
        }
        if (canonicalIri === manifest.canonicalIri) {
            throw new DependencyResolutionError(
                'self-dependency',
                `The root project cannot depend on itself through ${identifier}`,
            );
        }
        direct.push(Object.freeze({ identifier, requested, canonicalIri }));
    }
    const currentNodes =
        selection === undefined || existingLock === undefined
            ? new Map<string, LockPackageNode>()
            : new Map(existingLock.packages.map((node) => [node.canonicalIri, node]));
    const targeted =
        selection?.kind === 'update-targeted-frozen' && existingLock !== undefined
            ? frozenClosureForTarget(existingLock, selection.identifier)
            : undefined;
    if (
        selection?.kind === 'update-targeted-frozen' &&
        !direct.some(
            ({ identifier, canonicalIri }) =>
                identifier === selection.identifier && canonicalIri === targeted?.target.canonicalIri,
        )
    ) {
        throw new DependencyResolutionError(
            'existing-lock-mismatch',
            'The targeted authored dependency changed identity during update planning',
        );
    }
    const initialConstraints = new Map<string, Constraint[]>();
    for (const dependency of direct) {
        addConstraint(
            initialConstraints,
            dependency.canonicalIri,
            {
                requested: dependency.requested,
                source: Object.freeze({ kind: 'root', identifier: dependency.identifier }),
                depth: 0,
            },
            limits.maxConstraintsPerPackage,
            limits.maxConflictBytes,
        );
    }
    let catalogMetadataBytes = 0;
    function accountRelease(release: ResolverRelease): void {
        const encodedBytes = encodeRegistryIndexRelease({
            version: release.version,
            archiveSha256: release.archiveSha256,
            toolchain: release.toolchain,
            dependencies: release.dependencies,
        }).byteLength;
        catalogMetadataBytes += encodedBytes;
        if (!Number.isSafeInteger(catalogMetadataBytes) || catalogMetadataBytes > limits.maxCatalogMetadataBytes) {
            throw new DependencyResolutionError(
                'resolution-limit',
                'The compact registry metadata byte bound was exhausted',
            );
        }
    }
    const releaseCache = new Map<string, ReadonlyArray<ResolverRelease>>();
    async function releasesFor(canonicalIri: string): Promise<ReadonlyArray<ResolverRelease>> {
        const cached = releaseCache.get(canonicalIri);
        if (cached !== undefined) {
            return cached;
        }
        let releases: ResolverRelease[];
        if (source.kind === 'legacy-catalog') {
            const rawValues = await callRemote(
                async () => await source.catalog.listPublished(registryOrigin, canonicalIri, signal),
            );
            const values = snapshotDenseArray(
                rawValues,
                `release set for ${canonicalIri}`,
                limits.maxReleasesPerPackage,
            );
            releases = values.map((value) =>
                validatePackageRecord(value as PublishedPackageRecord, canonicalIri, limits.maxEdges),
            );
            for (const release of releases) {
                accountRelease(release);
            }
        } else {
            releases = [];
            let cursor: string | null = null;
            let expectedOrdinal = 0;
            let expectedWatermark: string | undefined;
            let expectedReleaseCount: number | undefined;
            let priorVersion: string | undefined;
            const observedCursors = new Set<string>();
            for (;;) {
                if (expectedOrdinal >= REGISTRY_RELEASE_INDEX_LIMITS.maxPages) {
                    throw new DependencyResolutionError(
                        'resolution-limit',
                        'The registry release-index page bound was exhausted',
                    );
                }
                const rawPage = await callRemote(
                    async () => await source.index.listPage(registryOrigin, canonicalIri, cursor, signal),
                );
                if (rawPage === null) {
                    if (cursor === null) {
                        break;
                    }
                    throw new DependencyResolutionError(
                        'catalog-incoherent',
                        'The registry release index disappeared during pagination',
                    );
                }
                let page;
                try {
                    page = decodeRegistryReleaseIndexPage(rawPage);
                } catch (error) {
                    throw new DependencyResolutionError(
                        'catalog-incoherent',
                        'The registry returned an invalid compact release-index page',
                        error,
                    );
                }
                if (
                    page.registryOrigin !== registryOrigin ||
                    page.canonicalIri !== canonicalIri ||
                    page.pageOrdinal !== expectedOrdinal ||
                    (expectedWatermark !== undefined && page.watermark !== expectedWatermark) ||
                    (expectedReleaseCount !== undefined && page.releaseCount !== expectedReleaseCount)
                ) {
                    throw new DependencyResolutionError(
                        'catalog-incoherent',
                        'The registry release-index page context changed',
                    );
                }
                expectedWatermark ??= page.watermark;
                expectedReleaseCount ??= page.releaseCount;
                if (
                    releases.length + page.releases.length > limits.maxReleasesPerPackage ||
                    releases.length + page.releases.length > page.releaseCount
                ) {
                    throw new DependencyResolutionError(
                        'resolution-limit',
                        'The registry release history exceeds the resolver bound',
                    );
                }
                for (const release of page.releases) {
                    const compact: ResolverRelease = Object.freeze({ canonicalIri, ...release });
                    if (
                        priorVersion !== undefined &&
                        compareReleases(Object.freeze({ ...compact, version: priorVersion }), compact) >= 0
                    ) {
                        throw new DependencyResolutionError(
                            'catalog-incoherent',
                            'The registry release-index pages overlap or do not progress',
                        );
                    }
                    accountRelease(compact);
                    releases.push(compact);
                    priorVersion = compact.version;
                }
                if (page.nextCursor === null) {
                    if (releases.length !== page.releaseCount) {
                        throw new DependencyResolutionError(
                            'catalog-incoherent',
                            'The registry release-index count does not match its terminal page',
                        );
                    }
                    break;
                }
                if (page.nextCursor === cursor || observedCursors.has(page.nextCursor)) {
                    throw new DependencyResolutionError(
                        'catalog-incoherent',
                        'The registry release-index cursor repeated',
                    );
                }
                observedCursors.add(page.nextCursor);
                cursor = page.nextCursor;
                expectedOrdinal += 1;
            }
        }
        const current = currentNodes.get(canonicalIri);
        let currentPublished = false;
        if (current !== undefined) {
            for (const release of releases) {
                if (release.version !== current.version) {
                    continue;
                }
                if (!recordMatchesLockedNode(release, current, toolchain)) {
                    throw new DependencyResolutionError(
                        'catalog-identity-mismatch',
                        `The catalog changed the authenticated identity of ${canonicalIri} at ${current.version}`,
                    );
                }
                currentPublished = true;
            }
            if (!currentPublished) {
                releases.push(recordFromLockedNode(current, toolchain));
            }
        }
        releases.sort(compareReleases);
        const seen = new Set<string>();
        for (const release of releases) {
            if (seen.has(release.version)) {
                throw new DependencyResolutionError(
                    'catalog-incoherent',
                    `The catalog returned duplicate release ${release.version} for ${canonicalIri}`,
                );
            }
            seen.add(release.version);
        }
        const frozen = Object.freeze(releases);
        releaseCache.set(canonicalIri, frozen);
        return frozen;
    }
    let searchStates = 0;
    async function solveGraph(frozenIris: ReadonlySet<string>): Promise<ReadonlyMap<string, ResolverRelease>> {
        let selectedEdgeCount = 0;
        const selected = new Map<string, ResolverRelease>();
        const constraintsByIri = new Map(
            [...initialConstraints].map(([canonicalIri, values]) => [canonicalIri, [...values]]),
        );
        async function solve(): Promise<ReadonlyMap<string, ResolverRelease>> {
            let canonicalIri: string | undefined;
            for (const constrainedIri of constraintsByIri.keys()) {
                if (selected.has(constrainedIri)) {
                    continue;
                }
                if (canonicalIri === undefined || compareCodePoints(constrainedIri, canonicalIri) < 0) {
                    canonicalIri = constrainedIri;
                }
            }
            if (canonicalIri === undefined) {
                const cycle = cycleAt(selected);
                if (cycle !== undefined) {
                    throw new DependencyResolutionError(
                        'dependency-cycle',
                        cycle.path === undefined
                            ? `The selected package graph contains a cycle at ${cycle.at} with ${String(cycle.length)} edges`
                            : `The selected package graph cycles (${String(cycle.length)} edges): ${cycle.path}`,
                    );
                }
                return new Map(selected);
            }
            const constraints = constraintsByIri.get(canonicalIri) ?? [];
            const releases = await releasesFor(canonicalIri);
            if (releases.length === 0) {
                throw new DependencyResolutionError(
                    'missing-version',
                    `No published versions exist for ${canonicalIri}`,
                );
            }
            const current = currentNodes.get(canonicalIri);
            const currentRecord = current === undefined ? undefined : recordFromLockedNode(current, toolchain);
            const compatibleToolchain = releases.filter((release) => sameToolchain(release.toolchain, toolchain));
            const candidates = compatibleToolchain.filter(
                (release) =>
                    satisfiesConstraints(release, constraints) &&
                    (currentRecord === undefined || compareReleases(release, currentRecord) <= 0) &&
                    (!frozenIris.has(canonicalIri) ||
                        (current !== undefined && recordMatchesLockedNode(release, current, toolchain))),
            );
            if (candidates.length === 0) {
                throw (
                    toolchainRefusal(canonicalIri, releases, compatibleToolchain, constraints, toolchain) ??
                    versionConflict(canonicalIri, constraints)
                );
            }
            const errors: DependencyResolutionError[] = [];
            for (const candidate of candidates) {
                searchStates += 1;
                if (searchStates > limits.maxSearchStates) {
                    throw new DependencyResolutionError(
                        'search-exhausted',
                        'The deterministic dependency search bound was exhausted',
                    );
                }
                if (selected.size + 1 > limits.maxPackages) {
                    throw new DependencyResolutionError(
                        'search-exhausted',
                        'The dependency package count exceeds the resolver bound',
                    );
                }
                if (selectedEdgeCount + candidate.dependencies.length > limits.maxEdges) {
                    throw new DependencyResolutionError(
                        'search-exhausted',
                        'The dependency edge count exceeds the resolver bound',
                    );
                }
                const candidateDepth =
                    constraints.reduce((maximum, constraint) => Math.max(maximum, constraint.depth), 0) + 1;
                const previousEdgeCount = selectedEdgeCount;
                const touchedConstraintIris: string[] = [];
                selected.set(canonicalIri, candidate);
                selectedEdgeCount += candidate.dependencies.length;
                try {
                    let candidateFailure: DependencyResolutionError | undefined;
                    for (const edge of candidate.dependencies) {
                        if (edge.canonicalIri === canonicalIri) {
                            candidateFailure = new DependencyResolutionError(
                                'self-dependency',
                                `Package ${canonicalIri} cannot depend on itself`,
                            );
                            break;
                        }
                        if (edge.canonicalIri === manifest.canonicalIri) {
                            candidateFailure = new DependencyResolutionError(
                                'self-dependency',
                                `Package ${canonicalIri} depends on the root project`,
                            );
                            break;
                        }
                        addConstraint(
                            constraintsByIri,
                            edge.canonicalIri,
                            {
                                requested: edge.requested,
                                exactVersion: edge.version,
                                exactDigest: edge.archiveSha256,
                                source: Object.freeze({
                                    kind: 'package-edge',
                                    fromCanonicalIri: canonicalIri,
                                    fromVersion: candidate.version,
                                }),
                                depth: candidateDepth,
                            },
                            limits.maxConstraintsPerPackage,
                            limits.maxConflictBytes,
                        );
                        touchedConstraintIris.push(edge.canonicalIri);
                    }
                    if (candidateFailure === undefined) {
                        for (const touchedIri of touchedConstraintIris) {
                            const touchedRecord = selected.get(touchedIri);
                            const touchedConstraints = constraintsByIri.get(touchedIri) ?? [];
                            if (
                                touchedRecord !== undefined &&
                                !satisfiesConstraints(touchedRecord, touchedConstraints)
                            ) {
                                candidateFailure = versionConflict(touchedIri, touchedConstraints);
                                break;
                            }
                        }
                    }
                    if (candidateFailure !== undefined) {
                        errors.push(candidateFailure);
                        continue;
                    }
                    return await solve();
                } catch (error) {
                    if (!isDependencyResolutionError(error)) {
                        throw error;
                    }
                    if (
                        error.code === 'search-exhausted' ||
                        error.code === 'resolution-limit' ||
                        error.code === 'catalog-failure' ||
                        error.code === 'catalog-incoherent' ||
                        error.code === 'catalog-identity-mismatch' ||
                        error.code === 'resolution-invariant'
                    ) {
                        throw error;
                    }
                    errors.push(error);
                } finally {
                    for (let index = touchedConstraintIris.length - 1; index >= 0; index -= 1) {
                        const touchedIri = touchedConstraintIris[index];
                        if (touchedIri === undefined) {
                            continue;
                        }
                        const values = constraintsByIri.get(touchedIri);
                        values?.pop();
                        if (values?.length === 0) {
                            constraintsByIri.delete(touchedIri);
                        }
                    }
                    selectedEdgeCount = previousEdgeCount;
                    selected.delete(canonicalIri);
                }
            }
            throw branchError(canonicalIri, errors, constraints);
        }
        return await solve();
    }
    const solution = await solveGraph(targeted?.frozen ?? new Set<string>());
    const lock = buildLock(manifest, toolchain, direct, solution);
    if (targeted !== undefined) {
        const pinnedTarget = lock.packages.find(({ canonicalIri }) => canonicalIri === targeted.target.canonicalIri);
        if (pinnedTarget === undefined) {
            throw new DependencyResolutionError(
                'resolution-invariant',
                'The targeted update solution omitted its direct package',
            );
        }
        if (sameLockedNode(pinnedTarget, targeted.target)) {
            const unpinnedSolution = await solveGraph(new Set<string>());
            const unpinnedLock = buildLock(manifest, toolchain, direct, unpinnedSolution);
            const unpinnedTarget = unpinnedLock.packages.find(
                ({ canonicalIri }) => canonicalIri === targeted.target.canonicalIri,
            );
            if (unpinnedTarget === undefined) {
                throw new DependencyResolutionError(
                    'resolution-invariant',
                    'The unpinned update solution omitted its direct package',
                );
            }
            const targetOrder = compareReleases(
                recordFromLockedNode(unpinnedTarget, toolchain),
                recordFromLockedNode(targeted.target, toolchain),
            );
            if (targetOrder < 0) {
                const unpinnedNodes = new Map(unpinnedLock.packages.map((node) => [node.canonicalIri, node]));
                const changedFrozen = [...targeted.frozen]
                    .filter(
                        (canonicalIri) =>
                            !sameLockedNode(currentNodes.get(canonicalIri), unpinnedNodes.get(canonicalIri)),
                    )
                    .sort(compareCodePoints);
                if (changedFrozen.length === 0) {
                    throw new DependencyResolutionError(
                        'resolution-invariant',
                        'Pinned update selection omitted an otherwise compatible newer target',
                    );
                }
                if (messageEncoder.encode(JSON.stringify(changedFrozen)).byteLength > limits.maxConflictBytes) {
                    throw new DependencyResolutionError(
                        'resolution-limit',
                        'The frozen update conflict evidence exceeds the resolver bound',
                    );
                }
                throw new DependencyResolutionError(
                    'frozen-shared-conflict',
                    'A newer target release requires changing packages frozen by another authored dependency',
                    undefined,
                    undefined,
                    changedFrozen,
                );
            }
            if (targetOrder > 0) {
                throw new DependencyResolutionError(
                    'resolution-invariant',
                    'Update selection attempted to downgrade the target package',
                );
            }
        } else if (
            compareReleases(
                recordFromLockedNode(pinnedTarget, toolchain),
                recordFromLockedNode(targeted.target, toolchain),
            ) >= 0
        ) {
            throw new DependencyResolutionError(
                'resolution-invariant',
                'Update selection changed the target without choosing a newer release',
            );
        }
    }
    return resolvedResult(lock);
}

export interface DependencyResolverShape {
    readonly resolve: (
        input: ResolveDependenciesInput,
    ) => Effect.Effect<DependencyResolutionResult, DependencyResolutionError>;
}

export const DependencyResolver = Context.Service<DependencyResolverShape>('@erden/project/DependencyResolver');

function resolverFailure(error: unknown): DependencyResolutionError {
    return isDependencyResolutionError(error)
        ? error
        : safelyIsLockfileError(error)
          ? new DependencyResolutionError(
                'invalid-resolver-input',
                'The dependency resolver input lock or toolchain is invalid',
                error,
            )
          : new DependencyResolutionError('invalid-resolver-input', 'Dependency resolution could not complete', error);
}

function resolveWithSource(
    input: ResolveDependenciesInput,
    source: ResolverRegistrySource,
): Effect.Effect<DependencyResolutionResult, DependencyResolutionError> {
    return Effect.acquireUseRelease(
        Effect.sync(() => {
            const controller = new AbortController();
            const promise = resolveWithRegistry(input, source, controller.signal);
            return Object.freeze({ controller, promise });
        }),
        ({ promise }) => Effect.tryPromise({ try: () => promise, catch: resolverFailure }),
        ({ controller, promise }) =>
            Effect.promise(async () => {
                controller.abort();
                await promise.catch(() => undefined);
            }),
    );
}

export function makeDependencyResolver(catalog: DependencyCatalogShape): DependencyResolverShape {
    return Object.freeze({
        resolve: (input: ResolveDependenciesInput) =>
            resolveWithSource(
                input,
                Object.freeze({
                    kind: 'legacy-catalog',
                    catalog,
                }),
            ),
    });
}

export function makeDependencyResolverFromReleaseIndex(
    index: RegistryReleaseIndexReaderShape,
): DependencyResolverShape {
    return Object.freeze({
        resolve: (input: ResolveDependenciesInput) =>
            resolveWithSource(
                input,
                Object.freeze({
                    kind: 'release-index',
                    index,
                }),
            ),
    });
}

export function resolveDependencies(
    input: ResolveDependenciesInput,
): Effect.Effect<
    DependencyResolutionResult,
    DependencyResolutionError,
    Context.Service.Identifier<typeof DependencyResolver>
> {
    return Effect.gen(function* () {
        const resolver = yield* Effect.service(DependencyResolver);
        return yield* resolver.resolve(input);
    });
}

export function resolveDependenciesWithCatalog(
    input: ResolveDependenciesInput,
): Effect.Effect<
    DependencyResolutionResult,
    DependencyResolutionError,
    Context.Service.Identifier<typeof DependencyCatalog>
> {
    return Effect.gen(function* () {
        const catalog = yield* Effect.service(DependencyCatalog);
        return yield* makeDependencyResolver(catalog).resolve(input);
    });
}

export function defineResolveDependenciesOperation(
    input: ResolveDependenciesInput,
): ApplicationOperation<
    'ResolveDependencies',
    DependencyResolutionResult,
    DependencyResolutionError,
    Context.Service.Identifier<typeof DependencyResolver>
> {
    return Object.freeze({ name: 'ResolveDependencies', effect: resolveDependencies(input) });
}
