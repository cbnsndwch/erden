import { Result, Schema } from 'effect';

import { isCanonicalOntologyIri, isScopedAlias } from '@erden/contracts';
import { PACKAGE_CODEC_LIMITS } from '@erden/package-format';

export const INSTALL_REPORT_VERSION = 'erden.install-report/v1' as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]+$/u;
const ALIAS = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const Sha256 = Schema.String.check(Schema.isPattern(SHA256));
const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const InstallProjectReportSchema = Schema.Struct({
    schema: Schema.Literal(INSTALL_REPORT_VERSION),
    project: Schema.Struct({
        canonicalIri: Schema.String.check(Schema.isPattern(IRI)),
        alias: Schema.String.check(Schema.isPattern(ALIAS)),
    }),
    mode: Schema.Struct({
        offline: Schema.Boolean,
        frozenLockfile: Schema.Boolean,
    }),
    lock: Schema.Struct({
        status: Schema.Literals(['existing', 'written']),
        cleanup: Schema.Literals(['clean', 'cleanup-residue-retained']),
        sha256: Sha256,
    }),
    packages: Schema.Struct({
        total: NonNegativeInteger,
        reused: Schema.Array(Sha256),
        fetched: Schema.Array(Sha256),
        repaired: Schema.Array(Sha256),
    }),
    materialization: Schema.Struct({
        status: Schema.Literals(['materialized', 'hit']),
        cleanup: Schema.Literals(['clean', 'cleanup-residue-retained']),
        strategies: Schema.Struct({
            clone: NonNegativeInteger,
            hardlink: NonNegativeInteger,
            copy: NonNegativeInteger,
        }),
    }),
    outcome: Schema.Literal('installed'),
});

export type InstallProjectReport = typeof InstallProjectReportSchema.Type;

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function decodeInstallProjectReport(input: unknown): InstallProjectReport {
    let decoded: ReturnType<ReturnType<typeof Schema.decodeUnknownResult<typeof InstallProjectReportSchema>>>;
    try {
        decoded = Schema.decodeUnknownResult(InstallProjectReportSchema, {
            errors: 'all',
            onExcessProperty: 'error',
            reportInput: false,
        })(input);
    } catch (cause) {
        throw new TypeError('The install report does not match erden.install-report/v1', { cause });
    }
    if (Result.isFailure(decoded)) {
        throw new TypeError('The install report does not match erden.install-report/v1');
    }
    const report = decoded.success;
    if (!isCanonicalOntologyIri(report.project.canonicalIri) || !isScopedAlias(report.project.alias)) {
        throw new TypeError('The install report project identity is not canonical');
    }
    const numbers = [
        report.packages.total,
        report.materialization.strategies.clone,
        report.materialization.strategies.hardlink,
        report.materialization.strategies.copy,
    ];
    if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))) {
        throw new TypeError('Install report counts must be canonical nonnegative safe integers');
    }
    for (const values of [report.packages.reused, report.packages.fetched, report.packages.repaired]) {
        if (values.some((value, index) => index > 0 && compare(values[index - 1] ?? '', value) >= 0)) {
            throw new TypeError('Install package digest collections must be strictly sorted and unique');
        }
    }
    const sets = [report.packages.reused, report.packages.fetched, report.packages.repaired].map(
        (values) => new Set(values),
    );
    if (
        [...(sets[0] ?? [])].some((value) => sets[1]?.has(value) === true || sets[2]?.has(value) === true) ||
        [...(sets[1] ?? [])].some((value) => sets[2]?.has(value) === true) ||
        report.packages.total !== sets.reduce((total, set) => total + set.size, 0)
    ) {
        throw new TypeError('Install package disposition collections must be disjoint and complete');
    }
    const strategyTotal =
        BigInt(report.materialization.strategies.clone) +
        BigInt(report.materialization.strategies.hardlink) +
        BigInt(report.materialization.strategies.copy);
    const packageCount = BigInt(report.packages.total);
    const maximumStrategies = packageCount * BigInt(PACKAGE_CODEC_LIMITS.maxEntries);
    if (
        (report.materialization.status === 'hit' && strategyTotal !== 0n) ||
        (report.materialization.status === 'materialized' && report.packages.total === 0 && strategyTotal !== 0n) ||
        (report.materialization.status === 'materialized' &&
            report.packages.total > 0 &&
            strategyTotal < packageCount) ||
        strategyTotal > maximumStrategies
    ) {
        throw new TypeError('Install materialization strategy counts do not match the package closure');
    }
    return deepFreeze(report);
}

export function encodeInstallProjectReport(report: InstallProjectReport): string {
    const checked = decodeInstallProjectReport(report);
    return `${JSON.stringify({
        lock: {
            cleanup: checked.lock.cleanup,
            sha256: checked.lock.sha256,
            status: checked.lock.status,
        },
        materialization: {
            cleanup: checked.materialization.cleanup,
            status: checked.materialization.status,
            strategies: {
                clone: checked.materialization.strategies.clone,
                copy: checked.materialization.strategies.copy,
                hardlink: checked.materialization.strategies.hardlink,
            },
        },
        mode: {
            frozenLockfile: checked.mode.frozenLockfile,
            offline: checked.mode.offline,
        },
        outcome: checked.outcome,
        packages: {
            fetched: checked.packages.fetched,
            repaired: checked.packages.repaired,
            reused: checked.packages.reused,
            total: checked.packages.total,
        },
        project: {
            alias: checked.project.alias,
            canonicalIri: checked.project.canonicalIri,
        },
        schema: checked.schema,
    })}\n`;
}
