import { inspectBundledShaclEngine, type QualifiedShaclTool } from '@erden/shacl-distribution';

/** What `erden doctor` reports about the bundled SHACL engine: the reasoner's fields, without paths. */
export interface BundledShaclEngineDoctorInspection {
    readonly availability: 'available' | 'unavailable';
    readonly expectedPlatformPackage: string | null;
    readonly actualPlatformPackage: string | null;
    readonly packageVersion: string | null;
    readonly toolVersion: string | null;
    readonly size: number | null;
    readonly digest: string | null;
    readonly target: string | null;
    readonly tool: QualifiedShaclTool | null;
    readonly failureCode: string | null;
    /** The runtimes with a qualified SHACL engine, set only when this runtime was refused. */
    readonly supportedPlatforms: ReadonlyArray<string> | null;
    readonly selfTest: Readonly<{
        readonly status: 'not-run' | 'passed' | 'failed';
        readonly failureCode: string | null;
    }>;
}

/** Runs the SHACL engine resolver's integrity checks and its committed known-answer request, omitting paths. */
export function inspectNodeBundledShaclEngine(): BundledShaclEngineDoctorInspection {
    const inspection = inspectBundledShaclEngine({ runSelfTest: true });
    return Object.freeze({
        availability: inspection.availability,
        expectedPlatformPackage: inspection.expectedPlatformPackage ?? null,
        actualPlatformPackage: inspection.actualPlatformPackage ?? null,
        packageVersion: inspection.packageVersion ?? null,
        toolVersion: inspection.toolVersion ?? null,
        size: inspection.size ?? null,
        digest: inspection.digest ?? null,
        target: inspection.target ?? null,
        tool: inspection.tool === undefined ? null : Object.freeze({ ...inspection.tool }),
        failureCode: inspection.failureCode ?? null,
        supportedPlatforms:
            inspection.supportedPlatforms === undefined ? null : Object.freeze([...inspection.supportedPlatforms]),
        selfTest: Object.freeze({
            status: inspection.selfTest.status,
            failureCode: inspection.selfTest.failureCode ?? null,
        }),
    });
}
