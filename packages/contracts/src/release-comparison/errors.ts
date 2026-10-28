export type ReleaseComparisonErrorCode =
    | 'COMPARISON_INPUT_INVALID'
    | 'COMPARISON_STATE_CONFLICT'
    | 'COMPARISON_NOT_FOUND'
    | 'COMPARISON_UNAVAILABLE';

const messages: Readonly<Record<ReleaseComparisonErrorCode, string>> = Object.freeze({
    COMPARISON_INPUT_INVALID: 'The release comparison input is invalid',
    COMPARISON_STATE_CONFLICT: 'The release comparison evidence is invalid',
    COMPARISON_NOT_FOUND: 'The release comparison is not available',
    COMPARISON_UNAVAILABLE: 'Release comparison is temporarily unavailable',
});
const knownErrors = new WeakSet<object>();

export class ReleaseComparisonError extends Error {
    readonly code: ReleaseComparisonErrorCode;

    constructor(code: ReleaseComparisonErrorCode) {
        super(messages[code]);
        this.name = 'ReleaseComparisonError';
        this.code = code;
        knownErrors.add(this);
        Object.freeze(this);
    }
}

export function isReleaseComparisonError(input: unknown): input is ReleaseComparisonError {
    return input !== null && typeof input === 'object' && knownErrors.has(input);
}
