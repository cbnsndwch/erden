import { detectRuntime, inspectBundledReasoner, type QualifiedRequiredTool } from '@erden/reasoner-distribution';

export interface BundledReasonerDoctorInspection {
    readonly runtime: Readonly<{ readonly platform: string; readonly arch: string; readonly libc: string | null }>;
    readonly availability: 'available' | 'unavailable';
    readonly expectedPlatformPackage: string | null;
    readonly actualPlatformPackage: string | null;
    readonly packageVersion: string | null;
    readonly toolVersion: string | null;
    readonly size: number | null;
    readonly digest: string | null;
    readonly target: string | null;
    readonly requiredTool: QualifiedRequiredTool | null;
    readonly failureCode: string | null;
    /** The runtimes with a qualified reasoner, set only when this runtime was refused. */
    readonly supportedPlatforms: ReadonlyArray<string> | null;
    readonly selfTest: Readonly<{
        readonly status: 'not-run' | 'passed' | 'failed';
        readonly failureCode: string | null;
    }>;
}

/** Runs resolver integrity checks and the committed known-answer test, omitting all physical paths. */
export function inspectNodeBundledReasoner(): BundledReasonerDoctorInspection {
    const runtime = detectRuntime();
    const inspection = inspectBundledReasoner({ runSelfTest: true });
    return Object.freeze({
        runtime: Object.freeze({
            platform: runtime.platform,
            arch: runtime.arch,
            libc: runtime.libc ?? null,
        }),
        availability: inspection.availability,
        expectedPlatformPackage: inspection.expectedPlatformPackage ?? null,
        actualPlatformPackage: inspection.actualPlatformPackage ?? null,
        packageVersion: inspection.packageVersion ?? null,
        toolVersion: inspection.toolVersion ?? null,
        size: inspection.size ?? null,
        digest: inspection.digest ?? null,
        target: inspection.target ?? null,
        requiredTool: inspection.requiredTool === undefined ? null : Object.freeze({ ...inspection.requiredTool }),
        failureCode: inspection.failureCode ?? null,
        supportedPlatforms:
            inspection.supportedPlatforms === undefined ? null : Object.freeze([...inspection.supportedPlatforms]),
        selfTest: Object.freeze({
            status: inspection.selfTest.status,
            failureCode: inspection.selfTest.failureCode ?? null,
        }),
    });
}
