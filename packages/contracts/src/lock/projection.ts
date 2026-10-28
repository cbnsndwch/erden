import { createHash } from 'node:crypto';

import { validRange } from 'semver';

import { compareCodePoints } from '../manifest/constants.js';
import {
    isCanonicalOntologyIri,
    isRegistryOrigin,
    isScopedAlias,
    normalizeRegistryOrigin,
} from '../manifest/schema.js';

import { LockfileError } from './errors.js';
import { isBoundedLockfileScalar, LOCKFILE_LIMITS } from './schema.js';

export interface ManifestDependencyProjectionInput {
    readonly canonicalIri: string;
    readonly alias: string;
    readonly registryOrigin: string | null;
    readonly dependencies: Readonly<Record<string, string>>;
}

export function decodeManifestDependencyProjectionInput(
    input: ManifestDependencyProjectionInput,
): Readonly<ManifestDependencyProjectionInput> {
    try {
        const unknownInput: unknown = input;
        if (
            unknownInput === null ||
            typeof unknownInput !== 'object' ||
            Array.isArray(unknownInput) ||
            (Object.getPrototypeOf(unknownInput) !== Object.prototype &&
                Object.getPrototypeOf(unknownInput) !== null) ||
            Object.getOwnPropertySymbols(unknownInput).length !== 0
        ) {
            throw new Error('projection record shape');
        }
        const keys = Object.getOwnPropertyNames(unknownInput).sort(compareCodePoints);
        const expectedKeys = ['alias', 'canonicalIri', 'dependencies', 'registryOrigin'].sort(compareCodePoints);
        if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
            throw new Error('projection record fields');
        }
        const values = new Map<string, unknown>();
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(unknownInput, key);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('projection accessor');
            }
            values.set(key, descriptor.value);
        }
        const canonicalIri = values.get('canonicalIri');
        const alias = values.get('alias');
        const registryOrigin = values.get('registryOrigin');
        const rawDependencies = values.get('dependencies');
        if (
            typeof canonicalIri !== 'string' ||
            !isCanonicalOntologyIri(canonicalIri) ||
            !isBoundedLockfileScalar(canonicalIri) ||
            typeof alias !== 'string' ||
            !isScopedAlias(alias) ||
            !isBoundedLockfileScalar(alias) ||
            (registryOrigin !== null &&
                (typeof registryOrigin !== 'string' ||
                    !isRegistryOrigin(registryOrigin) ||
                    normalizeRegistryOrigin(registryOrigin) !== registryOrigin ||
                    !isBoundedLockfileScalar(registryOrigin)))
        ) {
            throw new Error('projection identity');
        }
        if (
            rawDependencies === null ||
            typeof rawDependencies !== 'object' ||
            Array.isArray(rawDependencies) ||
            (Object.getPrototypeOf(rawDependencies) !== Object.prototype &&
                Object.getPrototypeOf(rawDependencies) !== null) ||
            Object.getOwnPropertySymbols(rawDependencies).length !== 0
        ) {
            throw new Error('projection dependency map');
        }
        const dependencyNames = Object.getOwnPropertyNames(rawDependencies);
        if (dependencyNames.length > LOCKFILE_LIMITS.maxDirectDependencies) {
            throw new Error('projection dependency bound');
        }
        const dependencies: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const identifier of dependencyNames.sort(compareCodePoints)) {
            const descriptor = Object.getOwnPropertyDescriptor(rawDependencies, identifier);
            const requested: unknown = descriptor?.value;
            if (
                descriptor === undefined ||
                !('value' in descriptor) ||
                !descriptor.enumerable ||
                (!isScopedAlias(identifier) && !isCanonicalOntologyIri(identifier)) ||
                !isBoundedLockfileScalar(identifier) ||
                typeof requested !== 'string' ||
                !isBoundedLockfileScalar(requested) ||
                requested.trim() !== requested ||
                validRange(requested, { loose: false }) === null
            ) {
                throw new Error('projection dependency');
            }
            dependencies[identifier] = requested;
        }
        return Object.freeze({
            canonicalIri,
            alias,
            registryOrigin,
            dependencies: Object.freeze(dependencies),
        });
    } catch (error) {
        if (error instanceof LockfileError) {
            throw error;
        }
        throw new LockfileError('lockfile-schema', 'The manifest dependency projection is invalid', error);
    }
}

export function encodeManifestDependencyProjection(input: ManifestDependencyProjectionInput): Uint8Array {
    const checked = decodeManifestDependencyProjectionInput(input);
    const dependencies = Object.entries(checked.dependencies).map(([identifier, requested]) =>
        Object.freeze({ identifier, requested }),
    );
    return new TextEncoder().encode(
        `${JSON.stringify({
            canonicalIri: checked.canonicalIri,
            alias: checked.alias,
            registryOrigin: checked.registryOrigin,
            dependencies,
        })}\n`,
    );
}

export function manifestDependencyProjectionSha256(input: ManifestDependencyProjectionInput): string {
    return createHash('sha256').update(encodeManifestDependencyProjection(input)).digest('hex');
}
