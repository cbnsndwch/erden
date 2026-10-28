import { posix, win32 } from 'node:path';

import { Result, Schema } from 'effect';
import { valid } from 'semver';

import { isCanonicalOntologyIri, isScopedAlias } from '@erden/contracts';

export const PROJECT_PATH_REPORT_VERSION = 'erden.path-report/v1' as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]+$/u;
const ALIAS = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const IDENTIFIER =
    /^(?:@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*|[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]+)$/u;
const VERSION =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const ProjectPathReportSchema = Schema.Struct({
    schema: Schema.Literal(PROJECT_PATH_REPORT_VERSION),
    project: Schema.Struct({
        canonicalIri: Schema.String.check(Schema.isPattern(IRI)),
        alias: Schema.String.check(Schema.isPattern(ALIAS)),
    }),
    layer: Schema.Struct({
        identifier: Schema.String.check(Schema.isPattern(IDENTIFIER)),
        canonicalIri: Schema.String.check(Schema.isPattern(IRI)),
        version: Schema.String.check(Schema.isPattern(VERSION)),
        archiveSha256: Schema.String.check(Schema.isPattern(SHA256)),
        path: Schema.NonEmptyString,
    }),
    outcome: Schema.Literal('resolved'),
});

export type ProjectPathReport = typeof ProjectPathReportSchema.Type;

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

export function decodeProjectPathReport(input: unknown): ProjectPathReport {
    let result: ReturnType<ReturnType<typeof Schema.decodeUnknownResult<typeof ProjectPathReportSchema>>>;
    try {
        result = Schema.decodeUnknownResult(ProjectPathReportSchema, {
            errors: 'all',
            onExcessProperty: 'error',
            reportInput: false,
        })(input);
    } catch (cause) {
        throw new TypeError(`Invalid ${PROJECT_PATH_REPORT_VERSION} document`, { cause });
    }
    if (Result.isFailure(result)) {
        throw new TypeError(`Invalid ${PROJECT_PATH_REPORT_VERSION} document`, { cause: result.failure });
    }
    const report = result.success;
    const safePath =
        !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f\uD800-\uDFFF]/u.test(
            report.layer.path,
        ) &&
        (posix.isAbsolute(report.layer.path) || win32.isAbsolute(report.layer.path));
    if (
        !isCanonicalOntologyIri(report.project.canonicalIri) ||
        !isScopedAlias(report.project.alias) ||
        (!isCanonicalOntologyIri(report.layer.identifier) && !isScopedAlias(report.layer.identifier)) ||
        !isCanonicalOntologyIri(report.layer.canonicalIri) ||
        valid(report.layer.version, { loose: false }) === null ||
        !safePath
    ) {
        throw new TypeError('The path report contains a noncanonical identity or unsafe physical path');
    }
    return deepFreeze(report);
}

export function encodeProjectPathReport(report: ProjectPathReport): string {
    const checked = decodeProjectPathReport(report);
    return `${JSON.stringify({
        layer: {
            archiveSha256: checked.layer.archiveSha256,
            canonicalIri: checked.layer.canonicalIri,
            identifier: checked.layer.identifier,
            path: checked.layer.path,
            version: checked.layer.version,
        },
        outcome: checked.outcome,
        project: {
            alias: checked.project.alias,
            canonicalIri: checked.project.canonicalIri,
        },
        schema: checked.schema,
    })}\n`;
}
