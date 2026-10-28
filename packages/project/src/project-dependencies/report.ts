import { Result, Schema } from 'effect';
import { valid, validRange } from 'semver';

import { isCanonicalOntologyIri, isScopedAlias } from '@erden/contracts';

import { InstallProjectReportSchema, decodeInstallProjectReport } from '../install/index.js';

export const PROJECT_DEPENDENCIES_REPORT_VERSION = 'erden.dependency-change-report/v1' as const;

const SHA = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const OptionalText = Schema.Union([Schema.String, Schema.Null]);
const OptionalSha = Schema.Union([SHA, Schema.Null]);

export const ProjectDependenciesReportSchema = Schema.Struct({
    schema: Schema.Literal(PROJECT_DEPENDENCIES_REPORT_VERSION),
    operation: Schema.Literals(['add', 'remove']),
    project: Schema.Struct({ canonicalIri: Schema.String, alias: Schema.String }),
    dependency: Schema.Struct({
        identifier: Schema.String,
        previousRange: OptionalText,
        nextRange: OptionalText,
        canonicalIri: Schema.String,
    }),
    state: Schema.Struct({
        status: Schema.Literals(['unchanged', 'written']),
        manifestFormat: Schema.Literals(['json', 'jsonc', 'yaml', 'toml']),
        manifestSha256: SHA,
        lockSha256: SHA,
    }),
    resolution: Schema.Literals(['existing-lock', 'full-graph', 'pruned-exact']),
    packageChanges: Schema.Array(
        Schema.Struct({
            canonicalIri: Schema.String,
            beforeVersion: OptionalText,
            beforeSha256: OptionalSha,
            afterVersion: OptionalText,
            afterSha256: OptionalSha,
        }),
    ),
    installation: InstallProjectReportSchema,
    warnings: Schema.Array(Schema.Literals(['full-graph-reresolved', 'jsonc-presentation-lost'])),
    outcome: Schema.Literal('installed'),
});

export type ProjectDependenciesReport = typeof ProjectDependenciesReportSchema.Type;

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
function deepFreeze<Value>(value: Value): Value {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

export function decodeProjectDependenciesReport(input: unknown): ProjectDependenciesReport {
    let result;
    try {
        result = Schema.decodeUnknownResult(ProjectDependenciesReportSchema, {
            errors: 'all',
            onExcessProperty: 'error',
            reportInput: false,
        })(input);
    } catch (cause) {
        throw new TypeError('The dependency-change report does not match erden.dependency-change-report/v1', { cause });
    }
    if (Result.isFailure(result)) {
        throw new TypeError('The dependency-change report does not match erden.dependency-change-report/v1');
    }
    const report = result.success;
    decodeInstallProjectReport(report.installation);
    const existingLockLifecycle =
        report.resolution === 'existing-lock' &&
        report.operation === 'add' &&
        report.state.status === 'unchanged' &&
        report.dependency.previousRange !== null &&
        report.dependency.previousRange === report.dependency.nextRange &&
        report.packageChanges.length === 0 &&
        report.installation.lock.status === 'existing';
    const fullGraphLifecycle =
        report.resolution === 'full-graph' &&
        report.operation === 'add' &&
        report.state.status === 'written' &&
        report.installation.lock.status === 'written';
    const prunedExactLifecycle =
        report.resolution === 'pruned-exact' &&
        report.operation === 'remove' &&
        report.state.status === 'written' &&
        report.installation.lock.status === 'written';
    if (
        !isCanonicalOntologyIri(report.project.canonicalIri) ||
        !isScopedAlias(report.project.alias) ||
        (!isCanonicalOntologyIri(report.dependency.identifier) && !isScopedAlias(report.dependency.identifier)) ||
        !isCanonicalOntologyIri(report.dependency.canonicalIri) ||
        (report.dependency.previousRange !== null &&
            validRange(report.dependency.previousRange, { loose: false }) === null) ||
        (report.dependency.nextRange !== null && validRange(report.dependency.nextRange, { loose: false }) === null) ||
        report.installation.project.canonicalIri !== report.project.canonicalIri ||
        report.installation.project.alias !== report.project.alias ||
        report.installation.lock.sha256 !== report.state.lockSha256 ||
        report.installation.mode.offline ||
        report.installation.mode.frozenLockfile ||
        (report.operation === 'add' && report.dependency.nextRange === null) ||
        (report.operation === 'remove' &&
            (report.dependency.previousRange === null || report.dependency.nextRange !== null)) ||
        (!existingLockLifecycle && !fullGraphLifecycle && !prunedExactLifecycle)
    ) {
        throw new TypeError('The dependency-change report contains contradictory lifecycle truth');
    }
    for (let index = 0; index < report.packageChanges.length; index += 1) {
        const item = report.packageChanges[index] as (typeof report.packageChanges)[number];
        const previous = report.packageChanges[index - 1];
        if (previous !== undefined && compare(previous.canonicalIri, item.canonicalIri) >= 0) {
            throw new TypeError('Dependency package changes must be strictly sorted and unique');
        }
        if (
            (item.beforeVersion === null) !== (item.beforeSha256 === null) ||
            (item.afterVersion === null) !== (item.afterSha256 === null) ||
            !isCanonicalOntologyIri(item.canonicalIri) ||
            (item.beforeVersion !== null && valid(item.beforeVersion, { loose: false }) === null) ||
            (item.afterVersion !== null && valid(item.afterVersion, { loose: false }) === null) ||
            (item.beforeVersion === item.afterVersion && item.beforeSha256 === item.afterSha256)
        ) {
            throw new TypeError('Dependency package changes must describe an exact identity change');
        }
    }
    if (new Set(report.warnings).size !== report.warnings.length) {
        throw new TypeError('Dependency warnings must be unique');
    }
    const expectedWarnings = [
        ...(report.resolution === 'full-graph' ? ['full-graph-reresolved' as const] : []),
        ...(report.state.status === 'written' && report.state.manifestFormat === 'jsonc'
            ? ['jsonc-presentation-lost' as const]
            : []),
    ];
    if (
        report.warnings.length !== expectedWarnings.length ||
        report.warnings.some((warning, index) => warning !== expectedWarnings[index])
    ) {
        throw new TypeError('Dependency warnings do not match the observable rewrite behavior');
    }
    return deepFreeze(report);
}

export function encodeProjectDependenciesReport(input: ProjectDependenciesReport): string {
    const report = decodeProjectDependenciesReport(input);
    return `${JSON.stringify({
        dependency: report.dependency,
        installation: report.installation,
        operation: report.operation,
        outcome: report.outcome,
        packageChanges: report.packageChanges,
        project: report.project,
        resolution: report.resolution,
        schema: report.schema,
        state: report.state,
        warnings: report.warnings,
    })}\n`;
}
