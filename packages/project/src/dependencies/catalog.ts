import { Context } from 'effect';

import type { PackageManifestV1 } from '@erden/package-format';

export interface CatalogAliasResolution {
    readonly alias: string;
    readonly canonicalIri: string;
}

export interface PublishedPackageRecord {
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
    readonly manifest: PackageManifestV1;
}

/** Closed registry catalog boundary. Batch 2.2 intentionally provides no network implementation. */
export interface DependencyCatalogShape {
    readonly resolveAlias: (
        registryOrigin: string,
        alias: string,
        signal?: AbortSignal,
    ) => Promise<CatalogAliasResolution | null>;
    readonly listPublished: (
        registryOrigin: string,
        canonicalIri: string,
        signal?: AbortSignal,
    ) => Promise<ReadonlyArray<PublishedPackageRecord>>;
}

export const DependencyCatalog = Context.Service<DependencyCatalogShape>('@erden/project/DependencyCatalog');
