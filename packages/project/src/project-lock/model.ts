import type { LockConsistencyReason, LockfileV1, LockToolchain, LoadedManifestV1 } from '@erden/contracts';

export interface InspectProjectLockInput {
    readonly project: LoadedManifestV1;
    readonly toolchain: LockToolchain;
}

export interface WriteProjectLockInput extends InspectProjectLockInput {
    readonly lock: LockfileV1;
}

export type ProjectLockInspection =
    | Readonly<{
          readonly status: 'missing';
          readonly lock: null;
          readonly canonicalBytes: null;
          readonly reasons: ReadonlyArray<never>;
      }>
    | Readonly<{
          readonly status: 'stale';
          readonly lock: LockfileV1;
          readonly canonicalBytes: Uint8Array;
          readonly reasons: ReadonlyArray<LockConsistencyReason>;
      }>
    | Readonly<{
          readonly status: 'available';
          readonly lock: LockfileV1;
          readonly canonicalBytes: Uint8Array;
          readonly reasons: ReadonlyArray<never>;
      }>;

export interface ProjectLockWriteResult {
    readonly status: 'written' | 'hit';
    readonly cleanup: 'clean' | 'cleanup-residue-retained';
    readonly bytes: number;
    readonly sha256: string;
}
