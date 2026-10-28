export declare const PACKAGE_VERSION: '0.1.0+purrdf.3.0.1';
export declare const TOOL_NAME: 'erden-shacl';
export declare const TOOL_VERSION: typeof PACKAGE_VERSION;
export declare const SHACL_ENGINE_DIGEST: string;

export declare const QUALIFIED_SHACL_ARTIFACTS: Readonly<
    Record<
        string,
        Readonly<{
            packageName: string;
            description: string;
            runtime: Readonly<{ os: string; cpu: string; libc?: string }>;
            target: string;
            binaryPath: string;
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
    notMinted: string;
    packageMissing: string;
    pathEscape: string;
    selfTestFailed: string;
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
}

export interface InspectOptions extends ResolverOptions {
    readonly runSelfTest?: boolean;
}

export declare class BundledShaclEngineError extends Error {
    readonly code: string;
    readonly details: Readonly<Record<string, unknown>>;
}

export interface QualifiedShaclTool {
    readonly name: 'erden-shacl';
    readonly version: typeof TOOL_VERSION;
    readonly engineDigest: string;
    readonly executableDigest: string;
}

export declare const detectRuntime: () => Readonly<RuntimeIdentity>;
export declare const resolveBundledShaclEngine: (options?: ResolverOptions) => Readonly<{
    path: string;
    tool: Readonly<QualifiedShaclTool>;
}>;
export declare const runBundledShaclEngineKnownAnswer: (options?: ResolverOptions) => Readonly<{
    fixture: 'core-and-sparql';
    responseBytes: number;
    responseDigest: string;
    status: 'passed';
}>;
export declare const inspectBundledShaclEngine: (options?: InspectOptions) => Readonly<{
    availability: 'available' | 'unavailable';
    expectedPlatformPackage?: string;
    actualPlatformPackage?: string;
    packageVersion?: string;
    toolVersion?: string;
    path?: string;
    size?: number;
    digest?: string;
    target?: string;
    tool?: Readonly<QualifiedShaclTool>;
    failureCode?: string;
    supportedPlatforms?: ReadonlyArray<string>;
    selfTest: Readonly<{ status: 'not-run' | 'passed' | 'failed'; failureCode?: string }>;
}>;
