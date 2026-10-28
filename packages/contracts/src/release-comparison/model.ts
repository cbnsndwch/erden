import type { LockToolchain } from '../lock/index.js';

export const COMPARISON_POLICY = 'erden.semantic-comparison/v1' as const;

export const COMPARISON_BINDING_LIMITS = Object.freeze({
    maxIriBytes: 4_096,
    maxVersionBytes: 256,
    maxPolicyIdBytes: 128,
    maxDependencies: 256,
    maxBasisBytes: 512 * 1_024,
    maxBindingBytes: 1_024 * 1_024,
});

export interface ComparisonReleaseIdentity {
    readonly archiveSha256: string;
    readonly canonicalIri: string;
    readonly registryOrigin: string;
    readonly version: string;
}

/** Ordered, exact selections. Version ordering does not choose comparison direction. */
export interface ReleaseComparisonSelection {
    readonly before: ComparisonReleaseIdentity;
    readonly after: ComparisonReleaseIdentity;
}

export interface ComparisonPolicyIdentity {
    readonly id: string;
    readonly sha256: string;
}

export interface ComparisonDependency {
    readonly release: ComparisonReleaseIdentity;
    readonly direct: boolean;
}

/** Immutable evidence identity; decoding does not authenticate storage or grant access. */
export interface ComparisonBasisV1 {
    readonly schema: 'erden.comparison-basis/v1';
    readonly release: ComparisonReleaseIdentity;
    readonly manifestSha256: string;
    readonly dependencies: ReadonlyArray<ComparisonDependency>;
    readonly toolchain: LockToolchain;
    readonly reasoningProfile: ComparisonPolicyIdentity;
    readonly validationPolicy: ComparisonPolicyIdentity;
}

/** Shared binding of every category in a future comparison result. */
export interface ComparisonBindingV1 {
    readonly schema: 'erden.comparison-binding/v1';
    readonly comparisonPolicy: typeof COMPARISON_POLICY;
    readonly compatibility: 'not-assessed';
    readonly before: ComparisonBasisV1;
    readonly after: ComparisonBasisV1;
}
