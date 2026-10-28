import type { Effect } from 'effect';

import type { LockfileV1, LockPackageNode, LockToolchain } from '@erden/contracts';
import type { PackageArchiveSource } from '@erden/package-format';

import type { LocalPackageStoreError } from './errors.js';

export const STORE_OBJECT_MARKER_FORMAT = 'erden.store-object/v1' as const;
export const INSTALL_MARKER_FORMAT = 'erden.install/v1' as const;
export const STORE_PROJECT_REFERENCE_FORMAT = 'erden.store-project-reference/v1' as const;

export interface LocalStoreRoots {
    readonly storeRoot: string;
    readonly projectRoot?: string;
}

export interface PutPackageInput {
    readonly storeRoot: string;
    readonly expected: LockPackageNode;
    readonly toolchain: LockToolchain;
    readonly archive: PackageArchiveSource;
}

export interface RefreshProjectReferenceInput {
    readonly storeRoot: string;
    readonly projectRoot: string;
    readonly manifestPath: string;
    readonly manifestSha256: string;
    readonly lock: LockfileV1;
}

export interface RefreshProjectReferenceResult {
    readonly status: 'registered' | 'hit';
    readonly registrationId: string;
    readonly generationSha256: string;
    readonly lockSha256: string;
    readonly packages: number;
}

export interface InspectStoreIndexInput {
    readonly storeRoot: string;
}

export interface StoreProjectReferenceGeneration {
    readonly registrationId: string;
    readonly generationSha256: string;
    readonly previous: Readonly<{
        readonly registrationId: string;
        readonly generationSha256: string;
    }> | null;
    readonly projectRoot: string;
    readonly manifestPath: string;
    readonly project: Readonly<{ readonly canonicalIri: string; readonly alias: string }>;
    readonly manifestSha256: string;
    readonly lockSha256: string;
    readonly manifestDependencySha256: string;
    readonly toolchain: LockToolchain;
    readonly archiveSha256s: ReadonlyArray<string>;
    readonly rootStatus: 'present' | 'missing' | 'unavailable';
}

export interface StoreObjectIndexEntry {
    readonly archiveSha256: string;
    readonly status: 'available' | 'busy' | 'corrupt';
    readonly archiveByteSize: number | null;
    readonly logicalByteSize: string | null;
}

export interface StoreIndexInspection {
    readonly store: 'missing' | 'available';
    readonly transaction: 'idle' | 'busy';
    readonly registrations: ReadonlyArray<StoreProjectReferenceGeneration>;
    readonly corruptRegistrationIds: ReadonlyArray<string>;
    readonly busyRegistrationIds: ReadonlyArray<string>;
    readonly objects: ReadonlyArray<StoreObjectIndexEntry>;
}

export interface PruneStoreInput {
    readonly storeRoot: string;
    readonly registrationGenerations: ReadonlyArray<
        Readonly<{
            readonly registrationId: string;
            readonly generationSha256: string;
        }>
    >;
    readonly archiveSha256s: ReadonlyArray<string>;
}

export interface PruneStoreResult {
    readonly status: 'pruned' | 'hit';
    readonly registrations: number;
    readonly objects: number;
    readonly logicalBytes: string;
    readonly registrationGenerations: ReadonlyArray<
        Readonly<{
            readonly registrationId: string;
            readonly generationSha256: string;
            readonly project: Readonly<{ readonly canonicalIri: string; readonly alias: string }>;
        }>
    >;
    readonly archiveSha256s: ReadonlyArray<string>;
    readonly cleanup: 'clean';
}

export interface InspectPackageInput {
    readonly storeRoot: string;
    readonly archiveSha256: string;
}

export interface VerifyLockAvailabilityInput {
    readonly storeRoot: string;
    readonly lock: LockfileV1;
}

export interface MaterializeLockInput extends VerifyLockAvailabilityInput {
    readonly projectRoot: string;
}

export interface InspectInstallInput {
    readonly projectRoot: string;
    readonly lock: LockfileV1;
}

export interface PathForLayerInput extends InspectInstallInput {
    readonly identifier: string;
}

export interface PutPackageResult {
    readonly status: 'stored' | 'hit';
    readonly archiveSha256: string;
    readonly canonicalIri: string;
    readonly version: string;
    readonly fileCount: number;
}

export interface RepairPackageResult extends Omit<PutPackageResult, 'status'> {
    readonly status: 'repaired';
    readonly cleanup: 'clean' | 'cleanup-residue-retained';
}

export interface PackageInspection {
    readonly status: 'available' | 'missing' | 'busy' | 'repair-required';
    readonly archiveSha256: string;
    readonly canonicalIri: string | null;
    readonly version: string | null;
    readonly fileCount: number | null;
}

export interface LockAvailability {
    readonly status: 'available' | 'unavailable';
    readonly packages: number;
    readonly missing: ReadonlyArray<string>;
    readonly corrupt: ReadonlyArray<string>;
    readonly busy: ReadonlyArray<string>;
}

export type ImportStrategy = 'clone' | 'hardlink' | 'copy';

export interface MaterializeLockResult {
    readonly status: 'materialized' | 'hit';
    readonly cleanup: 'clean' | 'cleanup-residue-retained';
    readonly manifestDependencySha256: string;
    readonly packages: number;
    readonly strategies: Readonly<{ readonly clone: number; readonly hardlink: number; readonly copy: number }>;
}

export interface InstallInspection {
    readonly status: 'available' | 'stale' | 'missing' | 'busy' | 'repair-required';
    readonly manifestDependencySha256: string | null;
    readonly packages: number | null;
}

export interface ResolvedLayerPath {
    readonly identifier: string;
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
    readonly path: string;
}

export interface ResolvedInstalledLayer {
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
    readonly identifiers: ReadonlyArray<string>;
    readonly root: string;
    readonly files: ReadonlyArray<ResolvedInstalledFile>;
}

export interface ResolvedInstalledFile {
    readonly path: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly logicalMode: 0o644 | 0o755;
}

export interface ResolvedInstalledClosure {
    readonly lockSha256: string;
    readonly manifestDependencySha256: string;
    readonly toolchain: LockToolchain;
    readonly layers: ReadonlyArray<ResolvedInstalledLayer>;
}

export interface ReadInstalledLayerFileInput {
    readonly closure: ResolvedInstalledClosure;
    readonly canonicalIri: string;
    readonly path: string;
}

export interface AuthenticatedInstalledFile extends ResolvedInstalledFile {
    readonly bytes: Uint8Array;
}

/** Read-only capability intentionally separated from LocalPackageStore mutation operations. */
export interface InstalledClosureReaderShape {
    readonly resolve: (input: InspectInstallInput) => Effect.Effect<ResolvedInstalledClosure, LocalPackageStoreError>;
    readonly readFile: (
        input: ReadInstalledLayerFileInput,
    ) => Effect.Effect<AuthenticatedInstalledFile, LocalPackageStoreError>;
}
