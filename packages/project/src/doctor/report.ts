import { Result, Schema } from 'effect';

export const DOCTOR_REPORT_VERSION = 'erden.doctor-report/v1' as const;
export const REQUIRED_NODE_VERSION = '24.17.0' as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u;
const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const NullableText = Schema.NullOr(Schema.NonEmptyString);
const NullableIdentifier = Schema.NullOr(Schema.String.check(Schema.isPattern(IDENTIFIER)));
const NullableDigest = Schema.NullOr(Schema.String.check(Schema.isPattern(SHA256)));

const RequiredTool = Schema.Struct({
    name: Schema.NonEmptyString,
    version: Schema.NonEmptyString,
    executableDigest: Schema.String.check(Schema.isPattern(SHA256)),
    adapterDigest: Schema.String.check(Schema.isPattern(SHA256)),
    calculusDigest: Schema.String.check(Schema.isPattern(SHA256)),
});

const ShaclTool = Schema.Struct({
    name: Schema.Literal('erden-shacl'),
    version: Schema.NonEmptyString,
    engineDigest: Schema.String.check(Schema.isPattern(SHA256)),
    executableDigest: Schema.String.check(Schema.isPattern(SHA256)),
});

/** The bundled SHACL engine (erden-shacl), reported like the reasoner; absent from reports written before it shipped. */
const ShaclEngineSection = Schema.Struct({
    availability: Schema.Literals(['available', 'unavailable']),
    expectedPlatformPackage: NullableText,
    actualPlatformPackage: NullableText,
    packageVersion: NullableText,
    toolVersion: NullableText,
    size: Schema.NullOr(NonNegativeInteger),
    digest: NullableDigest,
    target: NullableText,
    tool: Schema.NullOr(ShaclTool),
    failureCode: NullableIdentifier,
    supportedPlatforms: Schema.NullOr(Schema.Array(Schema.NonEmptyString)),
    selfTest: Schema.Struct({
        status: Schema.Literals(['passed', 'failed']),
        failureCode: NullableIdentifier,
    }),
});

export const DoctorReportSchema = Schema.Struct({
    schema: Schema.Literal(DOCTOR_REPORT_VERSION),
    node: Schema.Struct({
        requiredVersion: Schema.Literal(REQUIRED_NODE_VERSION),
        runtimeVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u)),
        status: Schema.Literals(['passed', 'failed']),
    }),
    reasoner: Schema.Struct({
        runtime: Schema.Struct({
            platform: Schema.NonEmptyString,
            arch: Schema.NonEmptyString,
            libc: NullableText,
        }),
        availability: Schema.Literals(['available', 'unavailable']),
        expectedPlatformPackage: NullableText,
        actualPlatformPackage: NullableText,
        packageVersion: NullableText,
        toolVersion: NullableText,
        size: Schema.NullOr(NonNegativeInteger),
        digest: NullableDigest,
        target: NullableText,
        requiredTool: Schema.NullOr(RequiredTool),
        failureCode: NullableIdentifier,
        supportedPlatforms: Schema.NullOr(Schema.Array(Schema.NonEmptyString)),
        selfTest: Schema.Struct({
            status: Schema.Literals(['passed', 'failed']),
            failureCode: NullableIdentifier,
        }),
    }),
    shaclEngine: Schema.optionalKey(ShaclEngineSection),
    outcome: Schema.Literals(['passed', 'failed']),
});

export type DoctorReport = typeof DoctorReportSchema.Type;

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

export function decodeDoctorReport(input: unknown): DoctorReport {
    const result = Schema.decodeUnknownResult(DoctorReportSchema, {
        errors: 'all',
        onExcessProperty: 'error',
        reportInput: false,
    })(input);
    if (Result.isFailure(result)) {
        throw new TypeError(`Invalid ${DOCTOR_REPORT_VERSION} document`, { cause: result.failure });
    }
    const report = result.success;
    const nodePassed = report.node.runtimeVersion === report.node.requiredVersion;
    if ((report.node.status === 'passed') !== nodePassed) {
        throw new TypeError('Doctor Node status contradicts its versions');
    }
    const reasonerPassed = report.reasoner.availability === 'available' && report.reasoner.selfTest.status === 'passed';
    if (reasonerPassed) {
        if (
            report.reasoner.requiredTool === null ||
            report.reasoner.failureCode !== null ||
            report.reasoner.supportedPlatforms !== null ||
            report.reasoner.digest !== report.reasoner.requiredTool.executableDigest ||
            report.reasoner.selfTest.failureCode !== null ||
            report.reasoner.expectedPlatformPackage === null ||
            report.reasoner.actualPlatformPackage === null ||
            report.reasoner.expectedPlatformPackage !== report.reasoner.actualPlatformPackage ||
            report.reasoner.size === null ||
            report.reasoner.size <= 0 ||
            report.reasoner.target === null ||
            report.reasoner.packageVersion === null ||
            report.reasoner.toolVersion === null ||
            report.reasoner.requiredTool.name !== 'erden-reasoner' ||
            report.reasoner.packageVersion !== report.reasoner.toolVersion ||
            report.reasoner.toolVersion !== report.reasoner.requiredTool.version
        ) {
            throw new TypeError('A healthy reasoner doctor report requires complete authenticated identity');
        }
    } else if (
        report.reasoner.failureCode === null ||
        report.reasoner.selfTest.status !== 'failed' ||
        report.reasoner.selfTest.failureCode !== report.reasoner.failureCode ||
        report.reasoner.requiredTool !== null
    ) {
        throw new TypeError('An unhealthy reasoner doctor report requires a deterministic failure code');
    }
    const shacl = report.shaclEngine;
    const shaclPassed =
        shacl === undefined || (shacl.availability === 'available' && shacl.selfTest.status === 'passed');
    if (shacl !== undefined) {
        if (shaclPassed) {
            if (
                shacl.tool === null ||
                shacl.failureCode !== null ||
                shacl.supportedPlatforms !== null ||
                shacl.digest !== shacl.tool.executableDigest ||
                shacl.selfTest.failureCode !== null ||
                shacl.expectedPlatformPackage === null ||
                shacl.expectedPlatformPackage !== shacl.actualPlatformPackage ||
                shacl.size === null ||
                shacl.size <= 0 ||
                shacl.target === null ||
                shacl.packageVersion === null ||
                shacl.packageVersion !== shacl.toolVersion ||
                shacl.toolVersion !== shacl.tool.version
            ) {
                throw new TypeError('A healthy SHACL engine doctor report requires complete authenticated identity');
            }
        } else if (
            shacl.failureCode === null ||
            shacl.selfTest.status !== 'failed' ||
            shacl.selfTest.failureCode !== shacl.failureCode ||
            shacl.tool !== null
        ) {
            throw new TypeError('An unhealthy SHACL engine doctor report requires a deterministic failure code');
        }
    }
    const outcome = nodePassed && reasonerPassed && shaclPassed ? 'passed' : 'failed';
    if (report.outcome !== outcome) {
        throw new TypeError('Doctor outcome contradicts its checks');
    }
    return deepFreeze(report);
}

export function encodeDoctorReport(report: DoctorReport): string {
    const checked = decodeDoctorReport(report);
    return `${JSON.stringify({
        node: checked.node,
        outcome: checked.outcome,
        reasoner: {
            actualPlatformPackage: checked.reasoner.actualPlatformPackage,
            availability: checked.reasoner.availability,
            digest: checked.reasoner.digest,
            expectedPlatformPackage: checked.reasoner.expectedPlatformPackage,
            failureCode: checked.reasoner.failureCode,
            packageVersion: checked.reasoner.packageVersion,
            requiredTool: checked.reasoner.requiredTool,
            runtime: checked.reasoner.runtime,
            selfTest: checked.reasoner.selfTest,
            size: checked.reasoner.size,
            supportedPlatforms: checked.reasoner.supportedPlatforms,
            target: checked.reasoner.target,
            toolVersion: checked.reasoner.toolVersion,
        },
        schema: checked.schema,
        ...(checked.shaclEngine === undefined
            ? {}
            : {
                  shaclEngine: {
                      actualPlatformPackage: checked.shaclEngine.actualPlatformPackage,
                      availability: checked.shaclEngine.availability,
                      digest: checked.shaclEngine.digest,
                      expectedPlatformPackage: checked.shaclEngine.expectedPlatformPackage,
                      failureCode: checked.shaclEngine.failureCode,
                      packageVersion: checked.shaclEngine.packageVersion,
                      selfTest: checked.shaclEngine.selfTest,
                      size: checked.shaclEngine.size,
                      supportedPlatforms: checked.shaclEngine.supportedPlatforms,
                      target: checked.shaclEngine.target,
                      tool: checked.shaclEngine.tool,
                      toolVersion: checked.shaclEngine.toolVersion,
                  },
              }),
    })}\n`;
}
