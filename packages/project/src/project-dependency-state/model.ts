import type { LockfileV1, LockToolchain, LoadedManifestV1, ManifestV1 } from '@erden/contracts';

import type { ManifestDiscoveryOptions } from '../manifest/index.js';
import type { ProjectLockInspection } from '../project-lock/index.js';

export interface InspectProjectDependencyStateInput extends ManifestDiscoveryOptions {
    readonly toolchain: LockToolchain;
}

export interface RecheckProjectDependencyStateInput {
    readonly revision: ProjectDependencyStateRevision;
}

export type ProjectDependencyManifestWrite =
    | Readonly<{ readonly kind: 'preserve' }>
    | Readonly<{ readonly kind: 'replace'; readonly manifest: ManifestV1 }>;

export interface WriteProjectDependencyStateInput {
    readonly revision: ProjectDependencyStateRevision;
    readonly manifest: ProjectDependencyManifestWrite;
    readonly lock: LockfileV1;
}

export interface RecoverProjectDependencyStateInput extends ManifestDiscoveryOptions {
    readonly projectRoot?: string;
    readonly toolchain: LockToolchain;
}

/** Opaque, immutable optimistic revision. Filesystem evidence is held privately by the service. */
export interface ProjectDependencyStateRevision {
    readonly schema: 'erden.project-dependency-state-revision/v1';
}

export interface ProjectDependencyStateInspection {
    readonly project: LoadedManifestV1;
    readonly manifestBytes: Uint8Array;
    readonly lockInspection: ProjectLockInspection;
    readonly revision: ProjectDependencyStateRevision;
}

export interface ProjectDependencyStateWriteResult {
    readonly status: 'written' | 'hit';
    readonly cleanup: 'clean';
    readonly manifest: Readonly<{
        readonly status: 'preserved' | 'written' | 'hit';
        readonly byteSize: number;
        readonly sha256: string;
    }>;
    readonly lock: Readonly<{
        readonly status: 'written' | 'hit';
        readonly byteSize: number;
        readonly sha256: string;
    }>;
    readonly state: ProjectDependencyStateInspection;
}
