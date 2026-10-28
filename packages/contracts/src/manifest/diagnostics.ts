import { compareCodePoints } from './constants.js';

export type ManifestDiagnosticCode =
    | 'duplicate-key'
    | 'invalid-dependency-identifier'
    | 'invalid-schema-version'
    | 'missing-schema-version'
    | 'syntax'
    | 'unknown-field'
    | 'unsupported-field'
    | 'unsupported-schema-version'
    | 'validation';

export interface SourceLocation {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly offset: number;
}

export interface ManifestDiagnostic {
    readonly code: ManifestDiagnosticCode;
    readonly message: string;
    readonly path: ReadonlyArray<string | number>;
    readonly location: SourceLocation;
    readonly suggestion?: string;
}

function compareNumbers(left: number, right: number): number {
    return left - right;
}

export function compareManifestDiagnostics(left: ManifestDiagnostic, right: ManifestDiagnostic): number {
    return (
        compareCodePoints(left.location.file, right.location.file) ||
        compareNumbers(left.location.line, right.location.line) ||
        compareNumbers(left.location.column, right.location.column) ||
        compareCodePoints(left.code, right.code) ||
        compareCodePoints(JSON.stringify(left.path), JSON.stringify(right.path)) ||
        compareCodePoints(left.message, right.message)
    );
}

export function sortManifestDiagnostics(
    diagnostics: ReadonlyArray<ManifestDiagnostic>,
): ReadonlyArray<ManifestDiagnostic> {
    return [...diagnostics].sort(compareManifestDiagnostics);
}

function formatPath(path: ReadonlyArray<string | number>): string {
    return path.length === 0
        ? '<root>'
        : path.map((segment) => (typeof segment === 'number' ? `[${String(segment)}]` : segment)).join('.');
}

export function formatManifestDiagnostic(diagnostic: ManifestDiagnostic): string {
    const suggestion =
        diagnostic.suggestion === undefined ? '' : ` Did you mean ${JSON.stringify(diagnostic.suggestion)}?`;
    return (
        `${diagnostic.location.file}:${String(diagnostic.location.line)}:${String(diagnostic.location.column)} ` +
        `[${diagnostic.code}] ${formatPath(diagnostic.path)}: ${diagnostic.message}${suggestion}`
    );
}

export class ManifestParseError extends Error {
    readonly code = 'MANIFEST_PARSE_ERROR';
    readonly diagnostics: ReadonlyArray<ManifestDiagnostic>;

    constructor(diagnostics: ReadonlyArray<ManifestDiagnostic>) {
        const sorted = sortManifestDiagnostics(diagnostics);
        super(sorted.map(formatManifestDiagnostic).join('\n'));
        this.name = 'ManifestParseError';
        this.diagnostics = sorted;
    }
}

export class ManifestNotFoundError extends Error {
    readonly code = 'MANIFEST_NOT_FOUND';
    readonly searchFrom: string;

    constructor(searchFrom: string, recognizedNames: ReadonlyArray<string>) {
        super(
            `No Erden manifest was found in ${searchFrom} or any parent. ` +
                `Recognized filenames: ${recognizedNames.join(', ')}`,
        );
        this.name = 'ManifestNotFoundError';
        this.searchFrom = searchFrom;
    }
}

export class ManifestAmbiguityError extends Error {
    readonly code = 'MANIFEST_AMBIGUOUS';
    readonly directory: string;
    readonly candidates: ReadonlyArray<string>;

    constructor(directory: string, candidates: ReadonlyArray<string>) {
        super(`Multiple Erden manifests were found in ${directory}: ${candidates.join(', ')}`);
        this.name = 'ManifestAmbiguityError';
        this.directory = directory;
        this.candidates = candidates;
    }
}

export class InvalidManifestPathError extends Error {
    readonly code = 'INVALID_MANIFEST_PATH';
    readonly filePath: string;

    constructor(filePath: string, reason: string) {
        super(`Invalid Erden manifest path ${filePath}: ${reason}`);
        this.name = 'InvalidManifestPathError';
        this.filePath = filePath;
    }
}

export class ManifestIoError extends Error {
    readonly code = 'MANIFEST_IO_ERROR';
    readonly filePath: string;
    override readonly cause: unknown;

    constructor(filePath: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Could not read Erden manifest ${filePath}: ${detail}`);
        this.name = 'ManifestIoError';
        this.filePath = filePath;
        this.cause = cause;
    }
}

export function pathKey(path: ReadonlyArray<string | number>): string {
    return JSON.stringify(path);
}

export function locationAtOffset(file: string, text: string, rawOffset: number): SourceLocation {
    const offset = Math.max(0, Math.min(rawOffset, text.length));
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < offset; index += 1) {
        const character = text.charCodeAt(index);
        if (character === 10) {
            line += 1;
            lineStart = index + 1;
        }
    }
    return { file, line, column: offset - lineStart + 1, offset };
}

function levenshteinDistance(left: string, right: string): number {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const substitution =
                (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
            current[rightIndex] = Math.min(
                (current[rightIndex - 1] ?? 0) + 1,
                (previous[rightIndex] ?? 0) + 1,
                substitution,
            );
        }
        for (let index = 0; index < current.length; index += 1) {
            previous[index] = current[index] ?? 0;
        }
    }
    return previous[right.length] ?? right.length;
}

export function suggestKnownField(unknown: string, knownFields: ReadonlyArray<string>): string | undefined {
    const ranked = knownFields
        .map((field) => ({ field, distance: levenshteinDistance(unknown, field) }))
        .sort((left, right) => left.distance - right.distance || compareCodePoints(left.field, right.field));
    const best = ranked[0];
    if (best === undefined) {
        return undefined;
    }
    const threshold = Math.max(1, Math.min(3, Math.floor(Math.max(unknown.length, best.field.length) / 3)));
    return best.distance <= threshold ? best.field : undefined;
}
