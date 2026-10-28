import { Context, Effect } from 'effect';

import { inspectNodeBundledReasoner, type BundledReasonerDoctorInspection } from '@erden/ontology';

import { LockfileError } from './errors.js';
import { decodeLockToolchain, type LockToolchain } from './schema.js';
import {
    assertValidatorProfileIntegrity,
    ERDEN_VALIDATOR_PROFILE_SHA256,
    ERDEN_VALIDATOR_PROFILE_VERSION,
} from './validator-profile.js';

/** Why this runtime has no bundled reasoner at all, as opposed to a broken or missing install. */
export interface RefusedReasonerRuntime {
    readonly failureCode: string;
    /** `platform/arch[/libc]`, as `erden doctor` prints the runtime. */
    readonly runtime: string;
    readonly supportedPlatforms: ReadonlyArray<string>;
}

export class CurrentToolchainError extends Error {
    readonly code = 'CURRENT_TOOLCHAIN_UNAVAILABLE' as const;
    override readonly cause!: unknown;
    readonly refusedRuntime: RefusedReasonerRuntime | undefined;
    /** The bundled reasoner resolver's code, such as `SOURCE_BUILD_MISSING`, when it named one. */
    readonly reasonerFailureCode: string | null;

    constructor(cause?: unknown, refusedRuntime?: RefusedReasonerRuntime, reasonerFailureCode: string | null = null) {
        super('The current Erden validator and bundled reasoner identity is unavailable');
        this.name = 'CurrentToolchainError';
        this.refusedRuntime = refusedRuntime;
        this.reasonerFailureCode = reasonerFailureCode;
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
}

export interface CurrentToolchainShape {
    readonly inspect: () => Effect.Effect<LockToolchain, CurrentToolchainError>;
}

export const CurrentToolchain = Context.Service<CurrentToolchainShape>('@erden/contracts/CurrentToolchain');

export function makeCurrentToolchainService(inspect: () => unknown): CurrentToolchainShape {
    let snapshot: LockToolchain | CurrentToolchainError | undefined;
    return Object.freeze({
        inspect: () =>
            Effect.try({
                try: () => {
                    if (snapshot instanceof CurrentToolchainError) {
                        throw snapshot;
                    }
                    if (snapshot !== undefined) {
                        return snapshot;
                    }
                    try {
                        snapshot = decodeLockToolchain(inspect());
                        return snapshot;
                    } catch (cause) {
                        const error = cause instanceof CurrentToolchainError ? cause : new CurrentToolchainError(cause);
                        snapshot = error;
                        throw error;
                    }
                },
                catch: (cause) => (cause instanceof CurrentToolchainError ? cause : new CurrentToolchainError(cause)),
            }),
    });
}

function inspectNodeCurrentToolchain(): LockToolchain {
    try {
        return projectCurrentToolchain(inspectNodeBundledReasoner());
    } catch (cause) {
        if (cause instanceof LockfileError || cause instanceof CurrentToolchainError) {
            throw cause;
        }
        throw new CurrentToolchainError(cause);
    }
}

const qualifiedDigest = /^sha256:[0-9a-f]{64}$/u;

function refusedRuntimeOf(reasoner: BundledReasonerDoctorInspection): RefusedReasonerRuntime | undefined {
    if (reasoner.failureCode === null || reasoner.supportedPlatforms === null) {
        return undefined;
    }
    const { platform, arch, libc } = reasoner.runtime;
    return Object.freeze({
        failureCode: reasoner.failureCode,
        runtime: libc === null ? `${platform}/${arch}` : `${platform}/${arch}/${libc}`,
        supportedPlatforms: reasoner.supportedPlatforms,
    });
}

/**
 * Projects a fully integrity-checked local artifact onto the platform-independent
 * semantic requirement stored in erden.lock. Runtime execution continues to bind
 * executable, adapter, and calculus digests through the qualified reasoner tool.
 */
/**
 * Projects a fully integrity-checked local artifact onto the platform-independent
 * semantic requirement stored in erden.lock. Runtime execution continues to bind
 * executable, adapter, and calculus digests through the qualified reasoner tool.
 */
export function projectCurrentToolchain(reasoner: BundledReasonerDoctorInspection): LockToolchain {
    assertValidatorProfileIntegrity();
    const tool = reasoner.requiredTool;
    if (
        reasoner.availability !== 'available' ||
        reasoner.failureCode !== null ||
        reasoner.selfTest.status !== 'passed' ||
        reasoner.selfTest.failureCode !== null ||
        tool === null ||
        reasoner.expectedPlatformPackage === null ||
        reasoner.actualPlatformPackage !== reasoner.expectedPlatformPackage ||
        reasoner.packageVersion !== tool.version ||
        reasoner.toolVersion !== tool.version ||
        reasoner.digest !== tool.executableDigest ||
        reasoner.size === null ||
        reasoner.size <= 0 ||
        reasoner.target === null ||
        !qualifiedDigest.test(tool.executableDigest) ||
        !qualifiedDigest.test(tool.adapterDigest) ||
        !qualifiedDigest.test(tool.calculusDigest)
    ) {
        throw new CurrentToolchainError(undefined, refusedRuntimeOf(reasoner), reasoner.failureCode);
    }
    return decodeLockToolchain({
        validator: {
            version: ERDEN_VALIDATOR_PROFILE_VERSION,
            sha256: ERDEN_VALIDATOR_PROFILE_SHA256,
        },
        reasoner: {
            version: tool.version,
            sha256: tool.calculusDigest.slice('sha256:'.length),
        },
    });
}

/** A fresh service over the real bundled reasoner; each instance inspects once and keeps that snapshot. */
export function makeNodeCurrentToolchainService(): CurrentToolchainShape {
    return makeCurrentToolchainService(inspectNodeCurrentToolchain);
}

export const nodeCurrentToolchainService = makeNodeCurrentToolchainService();
