import { isAbsolute } from 'node:path';

import { Result, Schema } from 'effect';
import { valid } from 'semver';

import { LOCKFILE_LIMITS, isCanonicalOntologyIri, isScopedAlias } from '@erden/contracts';
import { PACKAGE_CODEC_LIMITS } from '@erden/package-format';

export const PACK_REPORT_VERSION = 'erden.pack-report/v1' as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const ExactVersion = Schema.String.check(
    Schema.isPattern(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    ),
);
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const PackProjectReportSchema = Schema.Struct({
    schema: Schema.Literal(PACK_REPORT_VERSION),
    project: Schema.Struct({ alias: Schema.String, canonicalIri: Schema.String }),
    version: ExactVersion,
    output: Schema.Struct({
        path: Schema.String,
        status: Schema.Literals(['written', 'hit']),
        cleanup: Schema.Literals(['clean', 'cleanup-residue-retained']),
    }),
    archive: Schema.Struct({
        byteSize: Count,
        sha256: Schema.String.check(Schema.isPattern(SHA256)),
        manifestSha256: Schema.String.check(Schema.isPattern(SHA256)),
        fileCount: Count,
        directDependencyCount: Count,
    }),
    outcome: Schema.Literal('packed'),
});
export type PackProjectReport = typeof PackProjectReportSchema.Type;

function freeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            freeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function assertPlainInput(input: unknown): void {
    const pending: unknown[] = [input];
    let nodes = 0;
    while (pending.length > 0) {
        const value = pending.pop();
        if (value === null || typeof value !== 'object') {
            continue;
        }
        nodes += 1;
        if (
            nodes > 32 ||
            Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Object.getOwnPropertySymbols(value).length !== 0
        ) {
            throw new TypeError('closed report shape');
        }
        for (const name of Object.getOwnPropertyNames(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new TypeError('closed report descriptor');
            }
            pending.push(descriptor.value);
        }
    }
}

export function decodePackProjectReport(input: unknown): PackProjectReport {
    let result;
    try {
        assertPlainInput(input);
        result = Schema.decodeUnknownResult(PackProjectReportSchema, {
            errors: 'all',
            onExcessProperty: 'error',
            reportInput: false,
        })(input);
    } catch (cause) {
        throw new TypeError('The pack report does not match erden.pack-report/v1', { cause });
    }
    if (Result.isFailure(result)) {
        throw new TypeError('The pack report does not match erden.pack-report/v1');
    }
    const report = result.success;
    if (
        !isCanonicalOntologyIri(report.project.canonicalIri) ||
        !isScopedAlias(report.project.alias) ||
        valid(report.version, { loose: false }) === null ||
        !isAbsolute(report.output.path) ||
        !report.output.path.endsWith('.erdenpkg') ||
        report.output.path.includes('\0')
    ) {
        throw new TypeError('The pack report identity is invalid');
    }
    for (const count of [report.archive.byteSize, report.archive.fileCount, report.archive.directDependencyCount]) {
        if (!Number.isSafeInteger(count) || count < 0 || Object.is(count, -0)) {
            throw new TypeError('The pack report count is invalid');
        }
    }
    if (
        report.archive.byteSize > PACKAGE_CODEC_LIMITS.maxCompressedBytes ||
        report.archive.fileCount > PACKAGE_CODEC_LIMITS.maxEntries ||
        report.archive.directDependencyCount > LOCKFILE_LIMITS.maxDirectDependencies ||
        (report.output.status === 'hit' && report.output.cleanup !== 'clean')
    ) {
        throw new TypeError('The pack report violates a closed v1 invariant');
    }
    return freeze(report);
}

export function encodePackProjectReport(input: PackProjectReport): string {
    const report = decodePackProjectReport(input);
    return `${JSON.stringify({
        archive: {
            byteSize: report.archive.byteSize,
            directDependencyCount: report.archive.directDependencyCount,
            fileCount: report.archive.fileCount,
            manifestSha256: report.archive.manifestSha256,
            sha256: report.archive.sha256,
        },
        outcome: report.outcome,
        output: { cleanup: report.output.cleanup, path: report.output.path, status: report.output.status },
        project: { alias: report.project.alias, canonicalIri: report.project.canonicalIri },
        schema: report.schema,
        version: report.version,
    })}\n`;
}
