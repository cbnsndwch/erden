import { Result, Schema } from 'effect';

export const INIT_REPORT_VERSION = 'erden.init-report/v1' as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]+$/u;
const ALIAS = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const PORTABLE_PATH =
    /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*[\\\u0000-\u001f\u007f-\u009f])[^/]+(?:\/[^/]+)*$/u;

const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const PortablePath = Schema.String.check(Schema.isPattern(PORTABLE_PATH));
const Sha256Digest = Schema.String.check(Schema.isPattern(SHA256));
const AbsoluteIri = Schema.String.check(Schema.isPattern(IRI));

export const InitProjectReportSchema = Schema.Struct({
    schema: Schema.Literal(INIT_REPORT_VERSION),
    manifest: Schema.Struct({
        format: Schema.Literals(['json', 'jsonc', 'yml', 'yaml', 'toml']),
        file: PortablePath,
        canonicalIri: AbsoluteIri,
        alias: Schema.String.check(Schema.isPattern(ALIAS)),
        ownedIriPrefixes: Schema.NonEmptyArray(AbsoluteIri),
    }),
    files: Schema.NonEmptyArray(
        Schema.Struct({
            path: PortablePath,
            bytes: NonNegativeInteger,
            contentDigest: Sha256Digest,
        }),
    ),
    outcome: Schema.Literal('initialized'),
});

export type InitProjectReport = typeof InitProjectReportSchema.Type;

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
const FILE_BY_FORMAT: Readonly<Record<InitProjectReport['manifest']['format'], string>> = Object.freeze({
    json: 'erden.config.json',
    jsonc: 'erden.config.jsonc',
    yml: 'erden.config.yml',
    yaml: 'erden.config.yaml',
    toml: 'erden.config.toml',
});

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

export function decodeInitProjectReport(input: unknown): InitProjectReport {
    const result = Schema.decodeUnknownResult(InitProjectReportSchema, {
        errors: 'all',
        onExcessProperty: 'error',
        reportInput: false,
    })(input);
    if (Result.isFailure(result)) {
        throw new TypeError(`Invalid ${INIT_REPORT_VERSION} document`, { cause: result.failure });
    }
    const report = result.success;
    for (let index = 1; index < report.files.length; index += 1) {
        const previous = report.files[index - 1];
        const current = report.files[index];
        if (previous !== undefined && current !== undefined && compareText(previous.path, current.path) >= 0) {
            throw new TypeError('Initialized files must be strictly sorted and unique');
        }
    }
    for (let index = 1; index < report.manifest.ownedIriPrefixes.length; index += 1) {
        const previous = report.manifest.ownedIriPrefixes[index - 1];
        const current = report.manifest.ownedIriPrefixes[index];
        if (previous !== undefined && current !== undefined && compareText(previous, current) >= 0) {
            throw new TypeError('Owned IRI prefixes must be strictly sorted and unique');
        }
    }
    if (report.manifest.file !== FILE_BY_FORMAT[report.manifest.format]) {
        throw new TypeError('Manifest format and filename must match');
    }
    if (
        report.files.length !== 3 ||
        report.files[0].path !== report.manifest.file ||
        report.files[1]?.path !== 'erden.lock' ||
        report.files[2]?.path !== 'ontology.ttl'
    ) {
        throw new TypeError('An init report must contain exactly its manifest, canonical lock, and one Turtle fixture');
    }
    return deepFreeze(report);
}

export function encodeInitProjectReport(report: InitProjectReport): string {
    const checked = decodeInitProjectReport(report);
    return `${JSON.stringify({
        files: checked.files.map((file) => ({
            bytes: file.bytes,
            contentDigest: file.contentDigest,
            path: file.path,
        })),
        manifest: {
            alias: checked.manifest.alias,
            canonicalIri: checked.manifest.canonicalIri,
            file: checked.manifest.file,
            format: checked.manifest.format,
            ownedIriPrefixes: checked.manifest.ownedIriPrefixes,
        },
        outcome: checked.outcome,
        schema: checked.schema,
    })}\n`;
}
