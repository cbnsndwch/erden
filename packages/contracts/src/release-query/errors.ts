import type { ReleaseQueryRejectionReason } from './model.js';

export type ReleaseQueryErrorCode =
    | 'RELEASE_QUERY_INPUT_INVALID'
    | 'RELEASE_QUERY_REJECTED'
    | 'RELEASE_QUERY_NOT_FOUND'
    | 'RELEASE_QUERY_BUSY'
    | 'RELEASE_QUERY_STATE_CONFLICT'
    | 'RELEASE_QUERY_UNAVAILABLE';

const messages: Readonly<Record<ReleaseQueryErrorCode, string>> = Object.freeze({
    RELEASE_QUERY_INPUT_INVALID: 'The release query input is invalid',
    RELEASE_QUERY_REJECTED: 'The release query is outside the supported language or limits',
    RELEASE_QUERY_NOT_FOUND: 'The release query target is not available',
    RELEASE_QUERY_BUSY: 'Release query capacity is exhausted',
    RELEASE_QUERY_STATE_CONFLICT: 'The release query evidence is invalid',
    RELEASE_QUERY_UNAVAILABLE: 'Release query is temporarily unavailable',
});
const knownErrors = new WeakSet<object>();

/** Fixed message and closed reason; never carries a cause, query text, or release identity. */
export class ReleaseQueryError extends Error {
    readonly code: ReleaseQueryErrorCode;
    readonly reason: ReleaseQueryRejectionReason | null;

    constructor(code: ReleaseQueryErrorCode, reason: ReleaseQueryRejectionReason | null = null) {
        super(messages[code]);
        this.name = 'ReleaseQueryError';
        this.code = code;
        this.reason = code === 'RELEASE_QUERY_REJECTED' ? (reason ?? 'syntax') : null;
        knownErrors.add(this);
        Object.freeze(this);
    }
}

export function isReleaseQueryError(input: unknown): input is ReleaseQueryError {
    return input !== null && typeof input === 'object' && knownErrors.has(input);
}

export function rejectQuery(reason: ReleaseQueryRejectionReason): never {
    throw new ReleaseQueryError('RELEASE_QUERY_REJECTED', reason);
}
