export declare const PACKAGE_VERSION: '0.3.0+purrdf.0.12.0.dfb1df7';
export declare const TOOL_VERSION: typeof PACKAGE_VERSION;
/** Whether every platform's binary is pinned; a platform without pins runs a source build instead (TS-6). */
export declare const REASONER_RELEASED: boolean;
/** The tool identity requests to this version name and its answers carry. */
export declare const REASONER_TOOL: Readonly<{
    name: 'erden-reasoner';
    version: typeof PACKAGE_VERSION;
    adapterDigest: string;
    calculusDigest: string;
}>;
/** The platform package name a source build reports in place of an installed platform package. */
export declare const SOURCE_BUILD: 'source-build';
export declare const QUALIFIED_REASONER_ARTIFACTS: Readonly<
    Record<
        string,
        Readonly<{
            packageName: string;
            description: string;
            runtime: Readonly<{ os: string; cpu: string; libc?: string }>;
            target: string;
            binaryPath: string;
            /** Null while the version is unreleased, like the other pins. */
            bytes: number | null;
            sha256: string | null;
            responseBytes: number | null;
            responseSha256: string | null;
        }>
    >
>;

export declare const SUPPORTED_PLATFORMS: ReadonlyArray<string>;

export declare const ERROR_CODES: Readonly<{
    ambiguousPackage: string;
    binaryDigestMismatch: string;
    binaryMissing: string;
    binaryNotExecutable: string;
    binaryNotRegular: string;
    binarySizeMismatch: string;
    metadataInvalid: string;
    packageMissing: string;
    pathEscape: string;
    selfTestFailed: string;
    sourceBuildMissing: string;
    symlinkDisallowed: string;
    unsupportedLibc: string;
    unsupportedPlatform: string;
    versionMismatch: string;
    wrongTarget: string;
}>;

export interface RuntimeIdentity {
    readonly platform: string;
    readonly arch: string;
    readonly libc?: string;
}

export interface ResolverOptions {
    readonly runtime?: RuntimeIdentity;
    readonly locatePackage?: (packageName: string) => string | ReadonlyArray<string> | undefined;
    /** For an unreleased version: the absolute path of the source build to use instead of ERDEN_REASONER_BIN. */
    readonly sourceBuild?: string;
}

export interface InspectOptions extends ResolverOptions {
    readonly runSelfTest?: boolean;
}

export declare class BundledReasonerError extends Error {
    readonly code: string;
    readonly details: Readonly<Record<string, unknown>>;
}

export declare const detectRuntime: () => Readonly<RuntimeIdentity>;
export interface QualifiedRequiredTool {
    readonly name: 'erden-reasoner';
    readonly version: typeof TOOL_VERSION;
    readonly executableDigest: string;
    readonly adapterDigest: string;
    readonly calculusDigest: string;
}
export declare const resolveBundledReasonerArtifact: (options?: ResolverOptions) => Readonly<{
    path: string;
    requiredTool: Readonly<QualifiedRequiredTool>;
}>;
export declare const resolveBundledReasoner: (options?: ResolverOptions) => string;
export declare const runBundledReasonerKnownAnswer: (options?: ResolverOptions) => Readonly<{
    fixture: 'subclass-type';
    responseBytes: number;
    responseDigest: string;
    status: 'passed';
}>;
export declare const inspectBundledReasoner: (options?: InspectOptions) => Readonly<{
    availability: 'available' | 'unavailable';
    expectedPlatformPackage?: string;
    actualPlatformPackage?: string;
    packageVersion?: string;
    toolVersion?: string;
    path?: string;
    size?: number;
    digest?: string;
    target?: string;
    requiredTool?: Readonly<QualifiedRequiredTool>;
    failureCode?: string;
    /** Set when the runtime itself was refused (UNSUPPORTED_PLATFORM or UNSUPPORTED_LIBC). */
    supportedPlatforms?: ReadonlyArray<string>;
    selfTest: Readonly<{ status: 'not-run' | 'passed' | 'failed'; failureCode?: string }>;
}>;
