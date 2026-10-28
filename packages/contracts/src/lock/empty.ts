import type { ManifestV1 } from '../manifest/index.js';

import { decodeLockfileValue } from './codec.js';
import { decodeManifestDependencyProjectionInput, manifestDependencyProjectionSha256 } from './projection.js';
import { decodeLockToolchain, LOCKFILE_VERSION, type LockfileV1, type LockToolchain } from './schema.js';

/** Builds the one canonical empty closure used by init, install, and leaf packages. */
export function makeEmptyLockfile(manifest: ManifestV1, toolchain: LockToolchain): LockfileV1 {
    const checkedToolchain = decodeLockToolchain(toolchain);
    const projection = decodeManifestDependencyProjectionInput({
        canonicalIri: manifest.canonicalIri,
        alias: manifest.alias,
        registryOrigin: null,
        dependencies: manifest.dependencies,
    });
    if (Object.keys(projection.dependencies).length !== 0) {
        throw new TypeError('A canonical empty lock requires an empty dependency map');
    }
    return decodeLockfileValue({
        lockfileVersion: LOCKFILE_VERSION,
        registryOrigin: null,
        manifestDependencySha256: manifestDependencyProjectionSha256(projection),
        root: {
            canonicalIri: projection.canonicalIri,
            alias: projection.alias,
        },
        directDependencies: [],
        aliasMappings: [],
        packages: [],
        toolchain: checkedToolchain,
        counts: {
            directDependencies: 0,
            aliasMappings: 0,
            packages: 0,
            edges: 0,
        },
    });
}
