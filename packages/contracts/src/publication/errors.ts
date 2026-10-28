export type PublicationErrorCode =
    | 'PUBLICATION_ACTIVE_ATTEMPT'
    | 'PUBLICATION_CANDIDATE_INVALID'
    | 'PUBLICATION_DEPENDENCY_INELIGIBLE'
    | 'PUBLICATION_IDEMPOTENCY_CONFLICT'
    | 'PUBLICATION_INPUT_INVALID'
    | 'PUBLICATION_LEASE_LOST'
    | 'PUBLICATION_NOT_FOUND'
    | 'PUBLICATION_OBJECT_INVALID'
    | 'PUBLICATION_OBJECT_TRANSIENT'
    | 'PUBLICATION_POLICY_CHANGED'
    | 'PUBLICATION_REPOSITORY_TRANSIENT'
    | 'PUBLICATION_STATE_CONFLICT'
    | 'PUBLICATION_VERSION_IMMUTABLE';

const publicationErrors = new WeakSet<object>();

const safeMessages: Readonly<Record<PublicationErrorCode, string>> = Object.freeze({
    PUBLICATION_ACTIVE_ATTEMPT: 'A publication attempt is already active',
    PUBLICATION_CANDIDATE_INVALID: 'The publication candidate is invalid',
    PUBLICATION_DEPENDENCY_INELIGIBLE: 'The publication dependency closure is not eligible',
    PUBLICATION_IDEMPOTENCY_CONFLICT: 'The publication idempotency key is already bound to a different intent',
    PUBLICATION_INPUT_INVALID: 'The publication input is invalid',
    PUBLICATION_LEASE_LOST: 'The publication validation lease is no longer current',
    PUBLICATION_NOT_FOUND: 'The publication resource was not found',
    PUBLICATION_OBJECT_INVALID: 'A publication object is invalid',
    PUBLICATION_OBJECT_TRANSIENT: 'Publication object storage is temporarily unavailable',
    PUBLICATION_POLICY_CHANGED: 'Publication authority or project policy changed',
    PUBLICATION_REPOSITORY_TRANSIENT: 'The publication repository is temporarily unavailable',
    PUBLICATION_STATE_CONFLICT: 'The publication state conflicts with this operation',
    PUBLICATION_VERSION_IMMUTABLE: 'The publication version already exists',
});

const safeCodes = new Set<PublicationErrorCode>(Object.keys(safeMessages) as PublicationErrorCode[]);

function ownSafeCode(input: unknown): PublicationErrorCode | null {
    try {
        if (input === null || typeof input !== 'object' || !publicationErrors.has(input)) {
            return null;
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, 'code');
        return descriptor !== undefined &&
            'value' in descriptor &&
            typeof descriptor.value === 'string' &&
            safeCodes.has(descriptor.value as PublicationErrorCode)
            ? (descriptor.value as PublicationErrorCode)
            : null;
    } catch {
        return null;
    }
}

export class PublicationError extends Error {
    readonly code: PublicationErrorCode;

    constructor(code: PublicationErrorCode, message: string) {
        super(message);
        this.name = 'PublicationError';
        this.code = safeCodes.has(code) ? code : 'PUBLICATION_STATE_CONFLICT';
        publicationErrors.add(this);
        Object.freeze(this);
    }
}

export function isPublicationError(value: unknown): value is PublicationError {
    return ownSafeCode(value) !== null;
}

export function normalizePublicationError(
    error: unknown,
    fallback: PublicationErrorCode = 'PUBLICATION_STATE_CONFLICT',
): PublicationError {
    const code = ownSafeCode(error) ?? (safeCodes.has(fallback) ? fallback : 'PUBLICATION_STATE_CONFLICT');
    return new PublicationError(code, safeMessages[code]);
}

export function redactPublicationError(error: unknown): PublicationError {
    return normalizePublicationError(error);
}

export function publicationInputInvalid(): PublicationError {
    return new PublicationError('PUBLICATION_INPUT_INVALID', 'The publication input is invalid');
}

export function publicationNotFound(): PublicationError {
    return new PublicationError('PUBLICATION_NOT_FOUND', 'The publication resource was not found');
}
