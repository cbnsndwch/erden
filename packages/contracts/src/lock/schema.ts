import { Result, Schema } from 'effect';
import { valid } from 'semver';

import { compareCodePoints } from '../manifest/constants.js';
import {
    CanonicalOntologyIri,
    normalizeRegistryOrigin,
    RegistryOrigin,
    ScopedAlias,
    SemverRange,
} from '../manifest/schema.js';

import { LockfileError } from './errors.js';

export const LOCKFILE_VERSION = 1 as const;

export const LOCKFILE_LIMITS = Object.freeze({
    maxBytes: 128 * 1024 * 1024,
    maxScalarBytes: 1_024,
    maxYamlNodes: 500_000,
    maxGraphDepth: 4_096,
    maxDirectDependencies: 1_024,
    maxAliasMappings: 1_024,
    maxPackages: 4_096,
    maxEdges: 16_384,
});

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const EXACT_SEMVER =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const scalarEncoder = new TextEncoder();
export function isBoundedLockfileScalar(value: string): boolean {
    return value.isWellFormed() && scalarEncoder.encode(value).byteLength <= LOCKFILE_LIMITS.maxScalarBytes;
}
const BoundedLockfileScalar = Schema.makeFilter(isBoundedLockfileScalar, {
    expected: `a lockfile scalar of at most ${String(LOCKFILE_LIMITS.maxScalarBytes)} UTF-8 bytes`,
});

const LockCanonicalOntologyIri = CanonicalOntologyIri.check(BoundedLockfileScalar);
const LockRegistryOrigin = RegistryOrigin.check(
    BoundedLockfileScalar,
    Schema.makeFilter((value) => normalizeRegistryOrigin(value) === value, {
        expected: 'the canonical registry origin serialization without a trailing slash',
    }),
);
const LockScopedAlias = ScopedAlias.check(BoundedLockfileScalar);
const LockSemverRange = SemverRange.check(BoundedLockfileScalar);

export const Sha256Hex = Schema.String.check(
    Schema.makeFilter((value) => SHA256_HEX.test(value), { expected: 'a lowercase 64-character SHA-256 digest' }),
);
export type Sha256Hex = typeof Sha256Hex.Type;

export const ExactSemver = Schema.String.check(
    Schema.makeFilter(
        (value) =>
            isBoundedLockfileScalar(value) && EXACT_SEMVER.test(value) && valid(value, { loose: false }) !== null,
        { expected: 'an exact canonical semantic version' },
    ),
);
export type ExactSemver = typeof ExactSemver.Type;

const NonNegativeInteger = Schema.Number.check(
    Schema.isInt(),
    Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0), {
        expected: 'a canonical non-negative safe integer other than negative zero',
    }),
);

export const LockToolRequirement = Schema.Struct({
    version: ExactSemver,
    sha256: Sha256Hex,
});
export type LockToolRequirement = typeof LockToolRequirement.Type;

export const LockToolchain = Schema.Struct({
    validator: LockToolRequirement,
    reasoner: LockToolRequirement,
});
export type LockToolchain = typeof LockToolchain.Type;

export const LockDirectDependency = Schema.Struct({
    identifier: Schema.Union([LockScopedAlias, LockCanonicalOntologyIri]),
    requested: LockSemverRange,
    canonicalIri: LockCanonicalOntologyIri,
    version: ExactSemver,
    archiveSha256: Sha256Hex,
});
export type LockDirectDependency = typeof LockDirectDependency.Type;

export const LockAliasMapping = Schema.Struct({
    alias: LockScopedAlias,
    canonicalIri: LockCanonicalOntologyIri,
});
export type LockAliasMapping = typeof LockAliasMapping.Type;

export const LockPackageEdge = Schema.Struct({
    requested: LockSemverRange,
    canonicalIri: LockCanonicalOntologyIri,
    version: ExactSemver,
    archiveSha256: Sha256Hex,
});
export type LockPackageEdge = typeof LockPackageEdge.Type;

export const LockPackageNode = Schema.Struct({
    canonicalIri: LockCanonicalOntologyIri,
    version: ExactSemver,
    archiveSha256: Sha256Hex,
    dependencies: Schema.Array(LockPackageEdge),
});
export type LockPackageNode = typeof LockPackageNode.Type;

export const LockfileV1Schema = Schema.Struct({
    lockfileVersion: Schema.Literal(LOCKFILE_VERSION),
    registryOrigin: Schema.Union([LockRegistryOrigin, Schema.Null]),
    manifestDependencySha256: Sha256Hex,
    root: Schema.Struct({
        canonicalIri: LockCanonicalOntologyIri,
        alias: LockScopedAlias,
    }),
    directDependencies: Schema.Array(LockDirectDependency),
    aliasMappings: Schema.Array(LockAliasMapping),
    packages: Schema.Array(LockPackageNode),
    toolchain: LockToolchain,
    counts: Schema.Struct({
        directDependencies: NonNegativeInteger,
        aliasMappings: NonNegativeInteger,
        packages: NonNegativeInteger,
        edges: NonNegativeInteger,
    }),
});
export type LockfileV1 = typeof LockfileV1Schema.Type;

const STRICT_OPTIONS = { errors: 'all', onExcessProperty: 'error', reportInput: false } as const;

function dataProperty(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

function arrayLength(value: unknown): number | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    return descriptor !== undefined && 'value' in descriptor && Number.isSafeInteger(descriptor.value)
        ? (descriptor.value as number)
        : undefined;
}

function preflightLockfileCollections(input: unknown): void {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    ) {
        return;
    }
    const direct = dataProperty(input, 'directDependencies');
    const aliases = dataProperty(input, 'aliasMappings');
    const packages = dataProperty(input, 'packages');
    const directLength = arrayLength(direct);
    const aliasLength = arrayLength(aliases);
    const packageLength = arrayLength(packages);
    if (
        (directLength !== undefined && directLength > LOCKFILE_LIMITS.maxDirectDependencies) ||
        (aliasLength !== undefined && aliasLength > LOCKFILE_LIMITS.maxAliasMappings) ||
        (packageLength !== undefined && packageLength > LOCKFILE_LIMITS.maxPackages)
    ) {
        throw new LockfileError('lockfile-truth', 'The lockfile exceeds a closed v1 collection bound');
    }
    if (!Array.isArray(packages) || packageLength === undefined) {
        return;
    }
    let edges = 0;
    for (let index = 0; index < packageLength; index += 1) {
        const node = dataProperty(packages, String(index));
        if (node === null || typeof node !== 'object' || Array.isArray(node)) {
            continue;
        }
        const dependencies = dataProperty(node, 'dependencies');
        const dependencyLength = arrayLength(dependencies);
        if (dependencyLength === undefined) {
            continue;
        }
        edges += dependencyLength;
        if (edges > LOCKFILE_LIMITS.maxEdges) {
            throw new LockfileError('lockfile-truth', 'The lockfile exceeds the closed v1 dependency-edge bound');
        }
    }
}

function assertPlainDataTree(input: unknown): void {
    const pending: unknown[] = [input];
    const seen = new Set<object>();
    let nodes = 0;
    while (pending.length > 0) {
        nodes += 1;
        if (nodes > LOCKFILE_LIMITS.maxYamlNodes) {
            throw new LockfileError('lockfile-schema', 'The lockfile value exceeds the closed v1 node bound');
        }
        const value = pending.pop();
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            continue;
        }
        if (typeof value !== 'object' || seen.has(value)) {
            throw new LockfileError('lockfile-schema', 'The lockfile value is cyclic or is not plain data');
        }
        seen.add(value);
        if (Object.getOwnPropertySymbols(value).length !== 0) {
            throw new LockfileError('lockfile-schema', 'The lockfile value contains symbol properties');
        }
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length)) {
                throw new LockfileError('lockfile-schema', 'The lockfile value contains a non-plain array');
            }
            const names = Object.getOwnPropertyNames(value).filter((name) => name !== 'length');
            if (names.length !== value.length) {
                throw new LockfileError('lockfile-schema', 'The lockfile value contains a sparse or decorated array');
            }
            for (let index = 0; index < value.length; index += 1) {
                const key = String(index);
                if (names[index] !== key) {
                    throw new LockfileError('lockfile-schema', 'The lockfile value contains a sparse array');
                }
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                    throw new LockfileError('lockfile-schema', 'The lockfile value contains an accessor array item');
                }
                pending.push(descriptor.value);
            }
            continue;
        }
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
            throw new LockfileError('lockfile-schema', 'The lockfile value contains a non-plain object');
        }
        for (const key of Object.getOwnPropertyNames(value)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                throw new LockfileError('lockfile-schema', 'The lockfile value contains an unsafe key');
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new LockfileError('lockfile-schema', 'The lockfile value contains an accessor or hidden field');
            }
            pending.push(descriptor.value);
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

export function decodeLockfileStructure(input: unknown): LockfileV1 {
    try {
        preflightLockfileCollections(input);
        assertPlainDataTree(input);
        const decoded = Schema.decodeUnknownResult(LockfileV1Schema, STRICT_OPTIONS)(input);
        if (Result.isFailure(decoded)) {
            throw new LockfileError(
                'lockfile-schema',
                'The erden.lock document does not match the closed v1 schema',
                decoded.failure,
            );
        }
        return deepFreeze(decoded.success);
    } catch (error) {
        if (error instanceof LockfileError) {
            throw error;
        }
        throw new LockfileError('lockfile-schema', 'The erden.lock document could not be decoded safely', error);
    }
}

export function decodeLockToolchain(input: unknown): LockToolchain {
    try {
        assertPlainDataTree(input);
        const decoded = Schema.decodeUnknownResult(LockToolchain, STRICT_OPTIONS)(input);
        if (Result.isFailure(decoded)) {
            throw new LockfileError('lockfile-schema', 'The supplied dependency toolchain is invalid', decoded.failure);
        }
        return deepFreeze(decoded.success);
    } catch (error) {
        if (error instanceof LockfileError) {
            throw error;
        }
        throw new LockfileError(
            'lockfile-schema',
            'The supplied dependency toolchain could not be decoded safely',
            error,
        );
    }
}

export function decodeLockPackageNode(input: unknown): LockPackageNode {
    try {
        assertPlainDataTree(input);
        const decoded = Schema.decodeUnknownResult(LockPackageNode, STRICT_OPTIONS)(input);
        if (Result.isFailure(decoded)) {
            throw new LockfileError('lockfile-schema', 'The supplied locked package node is invalid', decoded.failure);
        }
        if (decoded.success.dependencies.length > LOCKFILE_LIMITS.maxEdges) {
            throw new LockfileError('lockfile-truth', 'The supplied locked package node exceeds the edge bound');
        }
        let previous: string | undefined;
        for (const edge of decoded.success.dependencies) {
            if (previous !== undefined && compareCodePoints(previous, edge.canonicalIri) >= 0) {
                throw new LockfileError(
                    'lockfile-truth',
                    'Locked package dependencies must be strictly UTF-16 ordered and unique',
                );
            }
            previous = edge.canonicalIri;
        }
        return deepFreeze(decoded.success);
    } catch (error) {
        if (error instanceof LockfileError) {
            throw error;
        }
        throw new LockfileError(
            'lockfile-schema',
            'The supplied locked package node could not be decoded safely',
            error,
        );
    }
}
