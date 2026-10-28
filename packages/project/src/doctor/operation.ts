import { Context, Effect } from 'effect';

import {
    inspectNodeBundledReasoner,
    inspectNodeBundledShaclEngine,
    type BundledReasonerDoctorInspection,
    type BundledShaclEngineDoctorInspection,
} from '@erden/ontology';

import type { ApplicationOperation } from '../index.js';

import { DoctorOperationalError } from './errors.js';
import { decodeDoctorReport, DOCTOR_REPORT_VERSION, REQUIRED_NODE_VERSION, type DoctorReport } from './report.js';

export interface DoctorRuntimePort {
    readonly nodeVersion: () => string;
    readonly inspectReasoner: () => BundledReasonerDoctorInspection;
    /** The bundled SHACL engine; a port without it reports the reasoner only. */
    readonly inspectShaclEngine?: () => BundledShaclEngineDoctorInspection;
}

export const nodeDoctorRuntimePort: DoctorRuntimePort = Object.freeze({
    nodeVersion: () => process.versions.node,
    inspectReasoner: inspectNodeBundledReasoner,
    inspectShaclEngine: inspectNodeBundledShaclEngine,
});

function shaclEngineSection(shacl: BundledShaclEngineDoctorInspection) {
    const passed = shacl.availability === 'available' && shacl.selfTest.status === 'passed';
    return {
        section: {
            availability: shacl.availability,
            expectedPlatformPackage: shacl.expectedPlatformPackage,
            actualPlatformPackage: shacl.actualPlatformPackage,
            packageVersion: shacl.packageVersion,
            toolVersion: shacl.toolVersion,
            size: shacl.size,
            digest: shacl.digest,
            target: shacl.target,
            tool: shacl.tool,
            failureCode: shacl.failureCode,
            supportedPlatforms: shacl.supportedPlatforms,
            selfTest: {
                status: passed ? ('passed' as const) : ('failed' as const),
                failureCode: shacl.selfTest.failureCode ?? shacl.failureCode,
            },
        },
        passed,
    };
}

function runDoctor(runtime: DoctorRuntimePort): Effect.Effect<DoctorReport, DoctorOperationalError> {
    return Effect.try({
        try: () => {
            const nodeVersion = runtime.nodeVersion();
            const reasoner = runtime.inspectReasoner();
            const reasonerPassed = reasoner.availability === 'available' && reasoner.selfTest.status === 'passed';
            const shacl =
                runtime.inspectShaclEngine === undefined ? undefined : shaclEngineSection(runtime.inspectShaclEngine());
            return decodeDoctorReport({
                schema: DOCTOR_REPORT_VERSION,
                node: {
                    requiredVersion: REQUIRED_NODE_VERSION,
                    runtimeVersion: nodeVersion,
                    status: nodeVersion === REQUIRED_NODE_VERSION ? 'passed' : 'failed',
                },
                reasoner: {
                    runtime: reasoner.runtime,
                    availability: reasoner.availability,
                    expectedPlatformPackage: reasoner.expectedPlatformPackage,
                    actualPlatformPackage: reasoner.actualPlatformPackage,
                    packageVersion: reasoner.packageVersion,
                    toolVersion: reasoner.toolVersion,
                    size: reasoner.size,
                    digest: reasoner.digest,
                    target: reasoner.target,
                    requiredTool: reasoner.requiredTool,
                    failureCode: reasoner.failureCode,
                    supportedPlatforms: reasoner.supportedPlatforms,
                    selfTest: {
                        status: reasonerPassed ? 'passed' : 'failed',
                        failureCode: reasoner.selfTest.failureCode ?? reasoner.failureCode,
                    },
                },
                ...(shacl === undefined ? {} : { shaclEngine: shacl.section }),
                outcome:
                    nodeVersion === REQUIRED_NODE_VERSION && reasonerPassed && (shacl?.passed ?? true)
                        ? 'passed'
                        : 'failed',
            });
        },
        catch: (cause) => new DoctorOperationalError(cause),
    });
}

export function doctor(): Effect.Effect<
    DoctorReport,
    DoctorOperationalError,
    Context.Service.Identifier<typeof DoctorService>
> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(DoctorService);
        return yield* service.inspect();
    });
}

export function defineDoctorOperation(): ApplicationOperation<
    'Doctor',
    DoctorReport,
    DoctorOperationalError,
    Context.Service.Identifier<typeof DoctorService>
> {
    return Object.freeze({ name: 'Doctor', effect: doctor() });
}

export interface DoctorServiceShape {
    readonly inspect: () => Effect.Effect<DoctorReport, DoctorOperationalError>;
}

export const DoctorService = Context.Service<DoctorServiceShape>('@erden/project/DoctorService');

export function makeDoctorService(runtime: DoctorRuntimePort): DoctorServiceShape {
    return Object.freeze({
        inspect: () => runDoctor(runtime),
    });
}

export const nodeDoctorService = makeDoctorService(nodeDoctorRuntimePort);
