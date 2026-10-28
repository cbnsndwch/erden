import { Result, Schema } from 'effect';
import { rcompare, valid } from 'semver';

import { isCanonicalOntologyIri, isScopedAlias } from '@erden/contracts';

import { InstallProjectReportSchema, decodeInstallProjectReport } from '../install/index.js';

export const PROJECT_DEPENDENCY_UPDATE_REPORT_VERSION = 'erden.dependency-update-report/v1' as const;

const SHA = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const OptionalText = Schema.Union([Schema.String, Schema.Null]);
const OptionalSha = Schema.Union([SHA, Schema.Null]);

export const ProjectDependencyUpdateReportSchema = Schema.Struct({
    schema: Schema.Literal(PROJECT_DEPENDENCY_UPDATE_REPORT_VERSION),
    project: Schema.Struct({ canonicalIri: Schema.String, alias: Schema.String }),
    strategy: Schema.Literals(['full-graph', 'targeted-frozen']),
    target: Schema.Union([Schema.Null, Schema.Struct({ identifier: Schema.String, canonicalIri: Schema.String })]),
    state: Schema.Struct({
        status: Schema.Literals(['unchanged', 'written']),
        manifestFormat: Schema.Literals(['json', 'jsonc', 'yaml', 'toml']),
        manifestSha256: SHA,
        lockSha256: SHA,
    }),
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
    outcome: Schema.Literals(['updated', 'healed', 'unchanged']),
});

export type ProjectDependencyUpdateReport = typeof ProjectDependencyUpdateReportSchema.Type;

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

function isNewerExactVersion(after: string, before: string): boolean {
    const precedence = rcompare(after, before, { loose: false });
    return precedence < 0 || (precedence === 0 && compare(after, before) > 0);
}

export function decodeProjectDependencyUpdateReport(input: unknown): ProjectDependencyUpdateReport {
    let result;
    try {
        result = Schema.decodeUnknownResult(ProjectDependencyUpdateReportSchema, {
            errors: 'all',
            onExcessProperty: 'error',
            reportInput: false,
        })(input);
    } catch (cause) {
        throw new TypeError('The dependency-update report does not match erden.dependency-update-report/v1', { cause });
    }
    if (Result.isFailure(result)) {
        throw new TypeError('The dependency-update report does not match erden.dependency-update-report/v1');
    }
    const report = result.success;
    decodeInstallProjectReport(report.installation);
    const dispositions = [
        ...report.installation.packages.reused,
        ...report.installation.packages.fetched,
        ...report.installation.packages.repaired,
    ];
    const disposedDigests = new Set(dispositions);
    const didHeal =
        report.installation.packages.fetched.length > 0 ||
        report.installation.packages.repaired.length > 0 ||
        report.installation.materialization.status === 'materialized';
    const expectedOutcome = report.state.status === 'written' ? 'updated' : didHeal ? 'healed' : 'unchanged';
    if (
        !isCanonicalOntologyIri(report.project.canonicalIri) ||
        !isScopedAlias(report.project.alias) ||
        report.installation.project.canonicalIri !== report.project.canonicalIri ||
        report.installation.project.alias !== report.project.alias ||
        report.installation.lock.sha256 !== report.state.lockSha256 ||
        report.installation.mode.offline ||
        report.installation.mode.frozenLockfile ||
        report.outcome !== expectedOutcome ||
        (report.strategy === 'full-graph' && report.target !== null) ||
        (report.strategy === 'targeted-frozen' &&
            (report.target === null ||
                (!isScopedAlias(report.target.identifier) && !isCanonicalOntologyIri(report.target.identifier)) ||
                !isCanonicalOntologyIri(report.target.canonicalIri))) ||
        disposedDigests.size !== dispositions.length ||
        (report.state.status === 'written'
            ? report.packageChanges.length === 0 || report.installation.lock.status !== 'written'
            : report.packageChanges.length !== 0 || report.installation.lock.status !== 'existing')
    ) {
        throw new TypeError('The dependency-update report contains contradictory lifecycle truth');
    }
    let hasReleaseAdvancement = false;
    for (let index = 0; index < report.packageChanges.length; index += 1) {
        const item = report.packageChanges[index] as (typeof report.packageChanges)[number];
        const previous = report.packageChanges[index - 1];
        if (previous !== undefined && compare(previous.canonicalIri, item.canonicalIri) >= 0) {
            throw new TypeError('Dependency update package changes must be strictly sorted and unique');
        }
        if (
            (item.beforeVersion === null) !== (item.beforeSha256 === null) ||
            (item.afterVersion === null) !== (item.afterSha256 === null) ||
            !isCanonicalOntologyIri(item.canonicalIri) ||
            (item.beforeVersion !== null && valid(item.beforeVersion, { loose: false }) === null) ||
            (item.afterVersion !== null && valid(item.afterVersion, { loose: false }) === null) ||
            (item.afterSha256 !== null && !disposedDigests.has(item.afterSha256)) ||
            (item.beforeVersion !== null &&
                item.afterVersion !== null &&
                !isNewerExactVersion(item.afterVersion, item.beforeVersion))
        ) {
            throw new TypeError('Dependency update package changes must describe an exact identity change');
        }
        if (item.beforeVersion !== null && item.afterVersion !== null) {
            hasReleaseAdvancement = true;
        }
    }
    if (report.strategy === 'full-graph' && report.state.status === 'written' && !hasReleaseAdvancement) {
        throw new TypeError('A written full-graph update must advance at least one existing package release');
    }
    if (report.strategy === 'targeted-frozen' && report.state.status === 'written') {
        const target = report.target;
        const change =
            target === null
                ? undefined
                : report.packageChanges.find(({ canonicalIri }) => canonicalIri === target.canonicalIri);
        if (change?.beforeVersion === null || change?.beforeVersion === undefined || change.afterVersion === null) {
            throw new TypeError('A targeted update must advance its exact authored target release');
        }
    }
    return deepFreeze(report);
}

export function encodeProjectDependencyUpdateReport(input: ProjectDependencyUpdateReport): string {
    const report = decodeProjectDependencyUpdateReport(input);
    return `${JSON.stringify({
        installation: report.installation,
        outcome: report.outcome,
        packageChanges: report.packageChanges,
        project: report.project,
        schema: report.schema,
        state: report.state,
        strategy: report.strategy,
        target: report.target,
    })}\n`;
}
