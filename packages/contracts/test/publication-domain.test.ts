import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    PUBLICATION_LIMITS,
    PUBLICATION_QUERY_LIMITS,
    decodeCandidateReceipt,
    decodePublicationClaim,
    decodePublicationClaimRequest,
    decodePublicationAttemptView,
    decodePublicationReportSummary,
    decodeReportReceipt,
    encodePublicationAttemptView,
    encodePublicationReportSummary,
    decodeQueuePublicationInput,
    isPublicationError,
    nodeCurrentToolchainService,
    publicationAttemptView,
    publicationIntentFingerprint,
    publicationCandidatePublicMetadata,
    type QueuedPublicationAttempt,
} from '../src/index.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const TOOLCHAIN = Effect.runSync(nodeCurrentToolchainService.inspect());
function rawCandidate(): Record<string, unknown> {
    return {
        internalRef: 'candidate-1',
        revision: 'revision-1',
        archiveSha256: SHA_A,
        byteSize: 1024,
        manifestSha256: SHA_B,
        canonicalIri: 'https://example.test/root',
        preferredAlias: '@example/root',
        registryOrigin: 'https://registry.example.test',
        version: '1.2.3',
        toolchain: TOOLCHAIN,
        dependencies: [],
        closure: [],
    };
}
function rawQueue(): Record<string, unknown> {
    return {
        actor: { kind: 'authenticated-user', userId: 'user-1' },
        idempotencyKey: 'publish-1',
        candidateRef: 'candidate-1',
        create: { visibility: 'private' },
        provenance: { kind: 'unavailable' },
    };
}
function expectInputInvalid(read: () => unknown): void {
    try {
        read();
    } catch (error) {
        expect(isPublicationError(error) && error.code).toBe('PUBLICATION_INPUT_INVALID');
        return;
    }
    throw new Error('Expected strict publication decoding to fail');
}

describe('publication domain decoding', () => {
    it('binds idempotency to semantic intent while omitting only candidate storage locators', () => {
        const request = decodeQueuePublicationInput(rawQueue());
        const candidate = decodeCandidateReceipt(rawCandidate());
        const relocated = decodeCandidateReceipt({
            ...rawCandidate(),
            internalRef: 'candidate-2',
            revision: 'revision-2',
        });
        const expected = publicationIntentFingerprint(request, candidate);

        expect(
            publicationIntentFingerprint(Object.freeze({ ...request, candidateRef: relocated.internalRef }), relocated),
        ).toBe(expected);
        expect(
            publicationIntentFingerprint(
                request,
                decodeCandidateReceipt({
                    ...rawCandidate(),
                    archiveSha256: SHA_B,
                }),
            ),
        ).not.toBe(expected);
        expect(
            publicationIntentFingerprint(
                Object.freeze({
                    ...request,
                    create: Object.freeze({ visibility: 'public' as const }),
                }),
                candidate,
            ),
        ).not.toBe(expected);
        expect(
            publicationIntentFingerprint(
                Object.freeze({
                    ...request,
                    provenance: Object.freeze({ kind: 'git' as const, revision: 'c'.repeat(40), dirty: false }),
                }),
                candidate,
            ),
        ).not.toBe(expected);
    });
    it('decodes and deeply freezes one canonical candidate receipt', () => {
        const candidate = decodeCandidateReceipt(rawCandidate());
        expect(candidate).toMatchObject({ preferredAlias: '@example/root', version: '1.2.3' });
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(Object.isFrozen(candidate.dependencies)).toBe(true);
        expect(Object.isFrozen(candidate.closure)).toBe(true);
    });
    it('keeps legacy v1 exact while authenticating a disjoint metadata-bound v2 receipt', () => {
        const legacy = decodeCandidateReceipt(rawCandidate());
        expect(publicationCandidatePublicMetadata(legacy)).toEqual({ title: null, description: null });
        const v2 = decodeCandidateReceipt({
            ...rawCandidate(),
            schema: 'erden.publication-candidate-receipt/v2',
            metadata: { title: 'Public title', description: 'Public description' },
        });
        expect(publicationCandidatePublicMetadata(v2)).toEqual({
            title: 'Public title',
            description: 'Public description',
        });
        expect(publicationIntentFingerprint(decodeQueuePublicationInput(rawQueue()), v2)).toBe(
            publicationIntentFingerprint(decodeQueuePublicationInput(rawQueue()), legacy),
        );
        expectInputInvalid(() =>
            decodeCandidateReceipt({ ...rawCandidate(), metadata: { title: null, description: null } }),
        );
        expectInputInvalid(() =>
            decodeCandidateReceipt({
                ...rawCandidate(),
                schema: 'erden.publication-candidate-receipt/v2',
                metadata: { title: null, description: null },
                extra: true,
            }),
        );
        expectInputInvalid(() =>
            decodeCandidateReceipt({
                ...rawCandidate(),
                schema: 'erden.publication-candidate-receipt/v2',
                metadata: { title: 'x'.repeat(257), description: null },
            }),
        );
    });
    it('rejects proxies and accessors without invoking a hostile value getter', () => {
        const proxied = new Proxy(rawQueue(), {
            getPrototypeOf: () => {
                throw new Error('hostile proxy');
            },
        });
        expectInputInvalid(() => decodeQueuePublicationInput(proxied));

        let reads = 0;
        const accessor = rawQueue();
        Object.defineProperty(accessor, 'idempotencyKey', {
            enumerable: true,
            get: () => {
                reads += 1;
                return 'publish-1';
            },
        });
        expectInputInvalid(() => decodeQueuePublicationInput(accessor));
        expect(reads).toBe(0);
    });
    it('strictly decodes bounded claim requests and every safe claim field', () => {
        const request = decodePublicationClaimRequest({ workerId: 'worker-1', requestId: 'request-1' });
        const claim = decodePublicationClaim({
            ...request,
            claimToken: 'claim-1',
            fence: Number.MAX_SAFE_INTEGER,
            claimedAt: 1,
            leaseUntil: 2,
        });
        expect(claim).toEqual({
            workerId: 'worker-1',
            requestId: 'request-1',
            claimToken: 'claim-1',
            fence: Number.MAX_SAFE_INTEGER,
            claimedAt: 1,
            leaseUntil: 2,
        });
        expect(Object.isFrozen(claim)).toBe(true);

        expectInputInvalid(() =>
            decodePublicationClaimRequest({
                workerId: 'worker-1',
                requestId: 'x'.repeat(PUBLICATION_LIMITS.maxIdBytes + 1),
            }),
        );
        expectInputInvalid(() =>
            decodePublicationClaim({
                ...claim,
                fence: Number.MAX_SAFE_INTEGER + 1,
            }),
        );
        expectInputInvalid(() =>
            decodePublicationClaim({
                ...claim,
                leaseUntil: claim.claimedAt,
            }),
        );
        let reads = 0;
        const accessor = { workerId: 'worker-1' };
        Object.defineProperty(accessor, 'requestId', {
            enumerable: true,
            get: () => {
                reads += 1;
                return 'request-1';
            },
        });
        expectInputInvalid(() => decodePublicationClaimRequest(accessor));
        expect(reads).toBe(0);
    });
    it('rejects sparse, oversized, duplicate, unsorted, and incomplete dependency closures', () => {
        const sparse = rawCandidate();
        sparse['dependencies'] = new Array<unknown>(1);
        expectInputInvalid(() => decodeCandidateReceipt(sparse));

        const oversized = rawCandidate();
        oversized['dependencies'] = new Array<unknown>(PUBLICATION_LIMITS.maxDependencies + 1).fill({});
        expectInputInvalid(() => decodeCandidateReceipt(oversized));

        const dependencyA = {
            requested: '^1.0.0',
            canonicalIri: 'https://example.test/a',
            version: '1.0.0',
            archiveSha256: SHA_A,
        };
        const duplicate = rawCandidate();
        duplicate['dependencies'] = [dependencyA, dependencyA];
        duplicate['closure'] = [{ canonicalIri: 'https://example.test/a', version: '1.0.0', archiveSha256: SHA_A }];
        expectInputInvalid(() => decodeCandidateReceipt(duplicate));

        const unsorted = rawCandidate();
        unsorted['dependencies'] = [{ ...dependencyA, canonicalIri: 'https://example.test/b' }, dependencyA];
        unsorted['closure'] = [
            { canonicalIri: 'https://example.test/a', version: '1.0.0', archiveSha256: SHA_A },
            { canonicalIri: 'https://example.test/b', version: '1.0.0', archiveSha256: SHA_A },
        ];
        expectInputInvalid(() => decodeCandidateReceipt(unsorted));

        const missing = rawCandidate();
        missing['dependencies'] = [dependencyA];
        expectInputInvalid(() => decodeCandidateReceipt(missing));
    });
    it('rejects requested-range, digest, and exact-version substitutions', () => {
        for (const dependency of [
            {
                requested: 'not-a-range',
                canonicalIri: 'https://example.test/a',
                version: '1.0.0',
                archiveSha256: SHA_A,
            },
            {
                requested: `^1.0.0${' '.repeat(1_024)}`,
                canonicalIri: 'https://example.test/a',
                version: '1.0.0',
                archiveSha256: SHA_A,
            },
            { requested: '^1.0.0', canonicalIri: 'https://example.test/a', version: '1.0.1', archiveSha256: SHA_A },
            { requested: '^1.0.0', canonicalIri: 'https://example.test/a', version: '1.0.0', archiveSha256: SHA_B },
        ]) {
            const candidate = rawCandidate();
            candidate['dependencies'] = [dependency];
            candidate['closure'] = [{ canonicalIri: 'https://example.test/a', version: '1.0.0', archiveSha256: SHA_A }];
            expectInputInvalid(() => decodeCandidateReceipt(candidate));
        }
    });
    it('enforces candidate and report byte-size lifetime caps', () => {
        const empty = rawCandidate();
        empty['byteSize'] = 0;
        expectInputInvalid(() => decodeCandidateReceipt(empty));

        const oversized = rawCandidate();
        oversized['byteSize'] = PUBLICATION_LIMITS.maxCandidateBytes + 1;
        expectInputInvalid(() => decodeCandidateReceipt(oversized));
        expectInputInvalid(() =>
            decodeReportReceipt({
                internalRef: 'report-1',
                revision: 'revision-1',
                sha256: SHA_A,
                byteSize: PUBLICATION_LIMITS.maxReportBytes + 1,
            }),
        );
    });
    it('projects a closed public attempt without internal actor, token, provenance, object, or policy fields', () => {
        const candidate = decodeCandidateReceipt(rawCandidate());
        const attempt: QueuedPublicationAttempt = Object.freeze({
            attemptId: 'attempt-1',
            actorId: 'secret-user',
            idempotencyKey: 'secret-key',
            intentFingerprint: SHA_A,
            project: Object.freeze({
                projectId: 'project-1',
                ownerOrganizationId: 'secret-org',
                active: true,
                canonicalIri: candidate.canonicalIri,
                preferredAlias: candidate.preferredAlias,
                visibility: 'private',
            }),
            candidate,
            provenance: Object.freeze({ kind: 'git', revision: 'c'.repeat(40), dirty: true }),
            validationExecutions: 0,
            preflightFailures: 0,
            createdAt: 1,
            updatedAt: 1,
            state: 'queued',
            nextClaimAt: 1,
        });
        const view = publicationAttemptView(attempt);
        const wire = JSON.stringify(view);
        const encoded = new TextDecoder().decode(encodePublicationAttemptView(view));

        expect(Object.keys(view).sort()).toEqual([
            'attemptId',
            'createdAt',
            'failure',
            'project',
            'release',
            'report',
            'schema',
            'state',
            'updatedAt',
            'validationExecutions',
            'version',
        ]);
        for (const secret of [
            'secret-user',
            'secret-key',
            'secret-org',
            'project-1',
            'candidate-1',
            'revision-1',
            'cccccccc',
        ]) {
            expect(wire).not.toContain(secret);
            expect(encoded).not.toContain(secret);
        }
        expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
            PUBLICATION_QUERY_LIMITS.maxStatusBytes,
        );
        expect(encoded).toBe(
            `${JSON.stringify({
                attemptId: 'attempt-1',
                createdAt: 1,
                failure: null,
                project: {
                    canonicalIri: candidate.canonicalIri,
                    preferredAlias: candidate.preferredAlias,
                    visibility: 'private',
                },
                release: null,
                report: null,
                schema: 'erden.publication-attempt/v1',
                state: 'queued',
                updatedAt: 1,
                validationExecutions: 0,
                version: candidate.version,
            })}\n`,
        );
    });
    it('strictly decodes canonical attempt and compact report response shapes', () => {
        const attempt = decodePublicationAttemptView({
            attemptId: 'attempt-1',
            createdAt: 1,
            failure: { code: 'PUBLICATION_CANDIDATE_OBJECT_INVALID', kind: 'candidate' },
            project: {
                canonicalIri: 'https://example.test/root',
                preferredAlias: '@example/root',
                visibility: 'public',
            },
            release: null,
            report: { byteSize: 10, sha256: SHA_A },
            schema: 'erden.publication-attempt/v1',
            state: 'failed',
            updatedAt: 2,
            validationExecutions: 1,
            version: '1.2.3',
        });
        expect(
            decodePublicationAttemptView(JSON.parse(new TextDecoder().decode(encodePublicationAttemptView(attempt)))),
        ).toEqual(attempt);

        const summary = decodePublicationReportSummary({
            attemptId: 'attempt-1',
            failure: { code: 'PUBLICATION_CANDIDATE_OBJECT_INVALID', kind: 'candidate' },
            outcome: 'failed',
            report: { byteSize: 10, sha256: SHA_A },
            schema: 'erden.publication-report-summary/v1',
            validation: null,
        });
        expect(
            decodePublicationReportSummary(
                JSON.parse(new TextDecoder().decode(encodePublicationReportSummary(summary))),
            ),
        ).toEqual(summary);
        expect(Object.isFrozen(summary.report)).toBe(true);
    });
    it('rejects semantically impossible attempt and report response substitutions', () => {
        const queued = {
            attemptId: 'attempt-1',
            createdAt: 1,
            failure: null,
            project: {
                canonicalIri: 'https://example.test/root',
                preferredAlias: '@example/root',
                visibility: 'public',
            },
            release: null,
            report: null,
            schema: 'erden.publication-attempt/v1',
            state: 'queued',
            updatedAt: 1,
            validationExecutions: 0,
            version: '1.2.3',
        };
        expectInputInvalid(() =>
            decodePublicationAttemptView({ ...queued, release: { archiveSha256: SHA_A, byteSize: 1 } }),
        );
        expectInputInvalid(() => decodePublicationAttemptView({ ...queued, updatedAt: 0 }));
        expectInputInvalid(() => decodePublicationAttemptView({ ...queued, hidden: 'internal-object' }));
        expectInputInvalid(() =>
            decodePublicationReportSummary({
                attemptId: 'attempt-1',
                failure: { code: 'PUBLICATION_SEMANTIC_VALIDATION_FAILED', kind: 'semantic' },
                outcome: 'failed',
                report: { byteSize: 10, sha256: SHA_A },
                schema: 'erden.publication-report-summary/v1',
                validation: null,
            }),
        );
        expectInputInvalid(() =>
            decodePublicationReportSummary({
                attemptId: 'attempt-1',
                failure: null,
                outcome: 'succeeded',
                report: { byteSize: 10, sha256: SHA_A },
                schema: 'erden.publication-report-summary/v1',
                validation: {
                    competencyQuestionCounts: null,
                    shaclCounts: null,
                    stages: {
                        citations: 'passed',
                        competencyQuestions: 'skipped',
                        core: 'passed',
                        reasoning: 'passed',
                        shacl: 'skipped',
                        sources: 'passed',
                    },
                    status: 'failed',
                    warningCount: 0,
                },
            }),
        );
    });
});
