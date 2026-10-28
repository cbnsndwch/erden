export type ArtifactFileErrorCode =
    | 'ARTIFACT_FILE_CURSOR_INVALID'
    | 'ARTIFACT_FILE_INPUT_INVALID'
    | 'ARTIFACT_FILE_LIMIT_EXCEEDED'
    | 'ARTIFACT_FILE_STATE_CONFLICT'
    | 'ARTIFACT_FILE_UNAVAILABLE';

const messages: Readonly<Record<ArtifactFileErrorCode, string>> = Object.freeze({
    ARTIFACT_FILE_CURSOR_INVALID: 'The artifact file cursor is invalid',
    ARTIFACT_FILE_INPUT_INVALID: 'The artifact file request is invalid',
    ARTIFACT_FILE_LIMIT_EXCEEDED: 'The artifact file request exceeds a closed limit',
    ARTIFACT_FILE_STATE_CONFLICT: 'The authenticated artifact file state is invalid',
    ARTIFACT_FILE_UNAVAILABLE: 'Artifact files are temporarily unavailable',
});

const instances = new WeakSet<object>();
const codes = new Set<ArtifactFileErrorCode>(Object.keys(messages) as ArtifactFileErrorCode[]);

export class ArtifactFileError extends Error {
    readonly code: ArtifactFileErrorCode;

    constructor(code: ArtifactFileErrorCode) {
        const safe = codes.has(code) ? code : 'ARTIFACT_FILE_UNAVAILABLE';
        super(messages[safe]);
        this.name = 'ArtifactFileError';
        this.code = safe;
        instances.add(this);
        Object.freeze(this);
    }
}

export function isArtifactFileError(input: unknown): input is ArtifactFileError {
    try {
        return (
            input !== null &&
            typeof input === 'object' &&
            instances.has(input) &&
            codes.has((input as ArtifactFileError).code)
        );
    } catch {
        return false;
    }
}

export function normalizeArtifactFileError(
    input: unknown,
    fallback: ArtifactFileErrorCode,
    allowed: ReadonlySet<ArtifactFileErrorCode>,
): ArtifactFileError {
    return new ArtifactFileError(isArtifactFileError(input) && allowed.has(input.code) ? input.code : fallback);
}
