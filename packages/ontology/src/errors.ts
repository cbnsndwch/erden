import type { RequiredStage } from './model.js';

export class OntologyAssemblyLimitError extends Error {
    readonly code = 'ONTOLOGY_ASSEMBLY_LIMIT';
    readonly limit: 'bytes' | 'statements';

    constructor(limit: 'bytes' | 'statements') {
        super('Ontology assembly exceeded its configured capacity');
        this.name = 'OntologyAssemblyLimitError';
        this.limit = limit;
    }
}

export class ResourceAccessError extends Error {
    readonly code = 'RESOURCE_ACCESS_ERROR';
    readonly locator: string;
    override readonly cause: unknown;

    constructor(locator: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Could not access ontology resource ${locator}: ${detail}`);
        this.name = 'ResourceAccessError';
        this.locator = locator;
        this.cause = cause;
    }
}

export class RequiredStageUnavailableError extends Error {
    readonly code = 'REQUIRED_STAGE_UNAVAILABLE';
    readonly stage: RequiredStage;
    readonly locator: string | null;
    override readonly cause: unknown;

    constructor(stage: RequiredStage, locator: string | null, cause: unknown) {
        const at = locator === null ? '' : ` at ${locator}`;
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Required ${stage} stage is unavailable${at}: ${detail}`);
        this.name = 'RequiredStageUnavailableError';
        this.stage = stage;
        this.locator = locator;
        this.cause = cause;
    }
}

export class UnsupportedSemanticFormatError extends Error {
    readonly code = 'UNSUPPORTED_SEMANTIC_FORMAT';
    readonly stage: RequiredStage;
    readonly locator: string;
    /** The first supported extension, kept for callers that predate multi-format sources. */
    readonly expectedExtension: string;
    readonly supportedExtensions: ReadonlyArray<string>;

    constructor(stage: RequiredStage, locator: string, expected: string | ReadonlyArray<string>) {
        const supported = Object.freeze(typeof expected === 'string' ? [expected] : [...expected]);
        super(
            `${locator} is not a supported ${stage} resource; expected ${supported.length === 1 ? (supported[0] ?? '') : `one of ${supported.join(', ')}`}`,
        );
        this.name = 'UnsupportedSemanticFormatError';
        this.stage = stage;
        this.locator = locator;
        this.expectedExtension = supported[0] ?? '';
        this.supportedExtensions = supported;
    }
}

export interface TurtleErrorLocation {
    readonly file: string;
    readonly line: number;
    readonly column: number;
}

export class TurtleSourceParseError extends Error {
    readonly code = 'TURTLE_SOURCE_PARSE_ERROR';
    readonly sourceId: string;
    readonly location: TurtleErrorLocation;
    override readonly cause: unknown;

    constructor(sourceId: string, location: TurtleErrorLocation, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`${location.file}:${String(location.line)}:${String(location.column)} ${detail}`);
        this.name = 'TurtleSourceParseError';
        this.sourceId = sourceId;
        this.location = location;
        this.cause = cause;
    }
}

export class TurtleSourceEncodingError extends Error {
    readonly code = 'TURTLE_SOURCE_ENCODING_ERROR';
    readonly sourceId: string;
    readonly locator: string;
    override readonly cause: unknown;

    constructor(sourceId: string, locator: string, cause: unknown) {
        super(`${locator} is not valid UTF-8 and cannot be used as ontology source ${sourceId}`);
        this.name = 'TurtleSourceEncodingError';
        this.sourceId = sourceId;
        this.locator = locator;
        this.cause = cause;
    }
}

export interface OntologySourceLocation {
    readonly file: string;
    readonly line?: number;
    readonly column?: number;
}

/** A syntax error from a non-Turtle ontology source; line and column are present when the parser reports them. */
export class OntologySourceParseError extends Error {
    readonly code = 'ONTOLOGY_SOURCE_PARSE_ERROR';
    readonly sourceId: string;
    readonly mediaType: string;
    readonly location: OntologySourceLocation;
    override readonly cause: unknown;

    constructor(sourceId: string, mediaType: string, location: OntologySourceLocation, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const at =
            location.line === undefined
                ? location.file
                : `${location.file}:${String(location.line)}${location.column === undefined ? '' : `:${String(location.column)}`}`;
        super(`${at} ${detail}`);
        this.name = 'OntologySourceParseError';
        this.sourceId = sourceId;
        this.mediaType = mediaType;
        this.location = location;
        this.cause = cause;
    }
}

export type OntologySourceRefusalReason =
    | 'xml-encoding-declaration'
    | 'xml-external-dtd'
    | 'xml-external-entity'
    | 'xml-parameter-entity'
    | 'xml-entity-reference-in-value'
    | 'xml-internal-subset-too-large'
    | 'xml-entity-expansion-too-large'
    | 'xml-malformed-document-type'
    | 'xml-nesting-too-deep'
    | 'jsonld-remote-context'
    | 'jsonld-nesting-too-deep'
    | 'jsonld-duplicate-key'
    | 'named-graph'
    | 'triple-term';

/** A well-formed source Erden will not read, refused before or instead of parsing. */
export class OntologySourceRefusedError extends Error {
    readonly code = 'ONTOLOGY_SOURCE_REFUSED';
    readonly sourceId: string;
    readonly locator: string;
    readonly reason: OntologySourceRefusalReason;
    readonly detail: string;

    constructor(sourceId: string, locator: string, reason: OntologySourceRefusalReason, detail: string) {
        super(`${locator} is refused (${reason}): ${detail}`);
        this.name = 'OntologySourceRefusedError';
        this.sourceId = sourceId;
        this.locator = locator;
        this.reason = reason;
        this.detail = detail;
    }
}

export class ShaclEngineError extends Error {
    readonly code = 'SHACL_ENGINE_ERROR';
    override readonly cause: unknown;

    constructor(cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`SHACL validation failed to execute: ${detail}`);
        this.name = 'ShaclEngineError';
        this.cause = cause;
    }
}

/**
 * erden-shacl refused the request: the shapes graph is one PurRDF will not validate (ill-formed, an unresolvable
 * import, an unsupported target or extension, a SPARQL query that does not prebind), or a limit was reached. The
 * check cannot decide, so it fails closed. `shape` and `locator` name the shape and its source file when the engine's
 * diagnostic names a declared shape.
 */
export class ShaclRefusedError extends Error {
    readonly code = 'SHACL_REFUSED';
    readonly engineCode: string;
    readonly detail: string;
    readonly graph: string | null;
    readonly shape: string | null;
    readonly locator: string | null;

    constructor(
        engineCode: string,
        detail: string,
        graph: string | null,
        shape: string | null,
        locator: string | null,
    ) {
        super(
            `erden-shacl refused the SHACL step (${engineCode})${shape === null ? '' : ` at shape ${shape}`}: ${detail}`,
        );
        this.name = 'ShaclRefusedError';
        this.engineCode = engineCode;
        this.detail = detail;
        this.graph = graph;
        this.shape = shape;
        this.locator = locator;
    }
}

/** No qualified erden-shacl binary is usable here: no package for this platform, or it failed its integrity check. */
export class ShaclEngineUnavailableError extends Error {
    readonly code = 'SHACL_ENGINE_UNAVAILABLE';
    /** The resolver's code, such as `UNSUPPORTED_PLATFORM` or `BINARY_DIGEST_MISMATCH`. */
    readonly failureCode: string;

    constructor(failureCode: string, detail: string) {
        super(`The bundled SHACL engine (erden-shacl) is unavailable [${failureCode}]: ${detail}`);
        this.name = 'ShaclEngineUnavailableError';
        this.failureCode = failureCode;
    }
}

/** `ERDEN_SHACL_MAX_WALL_TIME_MS` is not a whole number of milliseconds within its bounds. */
export class ShaclLimitsError extends Error {
    readonly code = 'SHACL_LIMITS_INVALID';

    constructor(variable: string, minimum: number, maximum: number) {
        super(`${variable} must be a whole number of milliseconds from ${String(minimum)} to ${String(maximum)}`);
        this.name = 'ShaclLimitsError';
    }
}

export class CitationMetadataAmbiguityError extends Error {
    readonly code = 'CITATION_METADATA_AMBIGUOUS';
    readonly observation: string;
    readonly predicate: string;
    readonly values: ReadonlyArray<string>;

    constructor(observation: string, predicate: string, values: ReadonlyArray<string>) {
        const sorted = Object.freeze([...new Set(values)].sort());
        super(`Citation ${observation} has multiple values for ${predicate}: ${sorted.join(', ')}`);
        this.name = 'CitationMetadataAmbiguityError';
        this.observation = observation;
        this.predicate = predicate;
        this.values = sorted;
    }
}

export class CompetencyQuestionArtifactError extends Error {
    readonly code = 'COMPETENCY_QUESTION_ARTIFACT_MISMATCH';
    readonly questionId: string;
    /** The question file, when the failure belongs to one question. */
    readonly locator?: string;

    constructor(questionId: string, cause?: unknown, locator?: string) {
        const detail = cause instanceof Error && cause.message.length > 0 ? `: ${cause.message}` : '';
        super(
            questionId === 'store'
                ? `Competency questions could not load the reasoned graph into the query engine${detail}`
                : `Competency question ${questionId} no longer matches its discovered byte snapshot${detail}`,
        );
        this.name = 'CompetencyQuestionArtifactError';
        this.questionId = questionId;
        if (locator !== undefined) {
            this.locator = locator;
        }
        this.cause = cause;
    }
}
