import type { ManifestV1 } from '../manifest/schema.js';

import { decodeLockfileValue } from './codec.js';
import { LockfileError } from './errors.js';
import { decodeManifestDependencyProjectionInput, manifestDependencyProjectionSha256 } from './projection.js';
import { decodeLockToolchain, type LockfileV1, type LockToolchain } from './schema.js';

export type LockConsistencyReason =
    | 'dependency-projection-changed'
    | 'registry-changed'
    | 'root-identity-changed'
    | 'toolchain-changed';

export interface LockConsistencyResult {
    readonly status: 'consistent' | 'stale';
    readonly reasons: ReadonlyArray<LockConsistencyReason>;
}

function sameTool(left: LockToolchain['validator'], right: LockToolchain['validator']): boolean {
    return left.version === right.version && left.sha256 === right.sha256;
}

/** Pure consistency projection: this function has no catalog, filesystem, clock, or network capability. */
export function checkLockConsistency(
    manifest: ManifestV1,
    toolchain: LockToolchain,
    lock: LockfileV1,
): LockConsistencyResult {
    try {
        const unknownManifest: unknown = manifest;
        if (
            unknownManifest === null ||
            typeof unknownManifest !== 'object' ||
            Array.isArray(unknownManifest) ||
            (Object.getPrototypeOf(unknownManifest) !== Object.prototype &&
                Object.getPrototypeOf(unknownManifest) !== null) ||
            Object.getOwnPropertySymbols(unknownManifest).length !== 0
        ) {
            throw new Error('manifest shape');
        }
        function dataValue(key: string, required: boolean): unknown {
            const descriptor = Object.getOwnPropertyDescriptor(unknownManifest, key);
            if (descriptor === undefined) {
                if (required) {
                    throw new Error('manifest projection field missing');
                }
                return undefined;
            }
            if (!('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('manifest projection accessor');
            }
            return descriptor.value;
        }
        const canonicalIri = dataValue('canonicalIri', true);
        const alias = dataValue('alias', true);
        const registry = dataValue('registry', false);
        const dependencies = dataValue('dependencies', true);
        const hasDependencies =
            dependencies !== null &&
            typeof dependencies === 'object' &&
            Object.getOwnPropertyNames(dependencies).length > 0;
        const projection = decodeManifestDependencyProjectionInput({
            canonicalIri: canonicalIri as string,
            alias: alias as string,
            registryOrigin: hasDependencies ? (registry as string) : null,
            dependencies: dependencies as Readonly<Record<string, string>>,
        });
        const checkedLock = decodeLockfileValue(lock);
        const checkedToolchain = decodeLockToolchain(toolchain);
        const reasons: LockConsistencyReason[] = [];
        if (projection.canonicalIri !== checkedLock.root.canonicalIri || projection.alias !== checkedLock.root.alias) {
            reasons.push('root-identity-changed');
        }
        if (projection.registryOrigin !== checkedLock.registryOrigin) {
            reasons.push('registry-changed');
        }
        const expected = manifestDependencyProjectionSha256(projection);
        if (expected !== checkedLock.manifestDependencySha256) {
            reasons.push('dependency-projection-changed');
        }
        if (
            !sameTool(checkedToolchain.validator, checkedLock.toolchain.validator) ||
            !sameTool(checkedToolchain.reasoner, checkedLock.toolchain.reasoner)
        ) {
            reasons.push('toolchain-changed');
        }
        const unique = Object.freeze([...new Set(reasons)]);
        return Object.freeze({ status: unique.length === 0 ? 'consistent' : 'stale', reasons: unique });
    } catch (error) {
        if (error instanceof LockfileError) {
            throw error;
        }
        throw new LockfileError('lockfile-schema', 'The manifest supplied for lock consistency is invalid', error);
    }
}
