import { posix, win32 } from 'node:path';

import { Result, Schema } from 'effect';

export const STORE_PATH_REPORT_VERSION = 'erden.store-path-report/v1' as const;

export const StorePathReportSchema = Schema.Struct({
    schema: Schema.Literal(STORE_PATH_REPORT_VERSION),
    storeRoot: Schema.NonEmptyString,
    outcome: Schema.Literal('resolved'),
});

export type StorePathReport = typeof StorePathReportSchema.Type;

export function decodeStorePathReport(input: unknown): StorePathReport {
    let result: ReturnType<ReturnType<typeof Schema.decodeUnknownResult<typeof StorePathReportSchema>>>;
    try {
        result = Schema.decodeUnknownResult(StorePathReportSchema, {
            errors: 'all',
            onExcessProperty: 'error',
            reportInput: false,
        })(input);
    } catch (cause) {
        throw new TypeError(`Invalid ${STORE_PATH_REPORT_VERSION} document`, { cause });
    }
    if (Result.isFailure(result)) {
        throw new TypeError(`Invalid ${STORE_PATH_REPORT_VERSION} document`, { cause: result.failure });
    }
    const report = result.success;
    if (
        /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f\uD800-\uDFFF]/u.test(
            report.storeRoot,
        ) ||
        (!posix.isAbsolute(report.storeRoot) && !win32.isAbsolute(report.storeRoot))
    ) {
        throw new TypeError('The store path report contains an unsafe or nonabsolute path');
    }
    return Object.freeze(report);
}

export function encodeStorePathReport(report: StorePathReport): string {
    const checked = decodeStorePathReport(report);
    return `${JSON.stringify({ outcome: checked.outcome, schema: checked.schema, storeRoot: checked.storeRoot })}\n`;
}
