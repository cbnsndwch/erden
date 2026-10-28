import { createHash } from 'node:crypto';

import { valid, validRange } from 'semver';

import { PACKAGE_CODEC_LIMITS, type ReferenceResolvedDependency } from '@erden/package-format';

import { decodeCheckProjectReport, type CheckProjectReport } from '../check/report.js';
import { decodeLockToolchain, LOCKFILE_LIMITS, type LockToolchain } from '../lock/index.js';
import { isCanonicalOntologyIri, isRegistryOrigin, isScopedAlias, normalizeRegistryOrigin } from '../manifest/index.js';

import { publicationInputInvalid } from './errors.js';

export interface PublicationCandidateValidationResult {
    readonly status: 'passed' | 'failed';
    readonly project: Readonly<{
        readonly canonicalIri: string;
        readonly preferredAlias: string;
        readonly registryOrigin: string;
        readonly version: string;
    }>;
    readonly archive: Readonly<{
        readonly revision: string;
        readonly sha256: string;
        readonly byteSize: number;
        readonly manifestSha256: string;
    }>;
    readonly toolchain: LockToolchain;
    readonly directDependencies: ReadonlyArray<ReferenceResolvedDependency>;
    readonly dependencies: ReadonlyArray<
        Readonly<{
            readonly canonicalIri: string;
            readonly version: string;
            readonly archiveSha256: string;
        }>
    >;
    readonly report: CheckProjectReport;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const EXACT_SEMVER =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const textEncoder = new TextEncoder();

export const PUBLICATION_LIMITS = Object.freeze({
    maxIdBytes: 128,
    maxIdempotencyKeyBytes: 128,
    maxCandidateBytes: PACKAGE_CODEC_LIMITS.maxCompressedBytes,
    maxReportBytes: 64 * 1024 * 1024,
    maxDependencies: LOCKFILE_LIMITS.maxDirectDependencies,
    maxClosure: LOCKFILE_LIMITS.maxPackages,
    maxPreflightFailures: 3,
    maxValidationExecutions: 3,
    maxClaimRequestRecords: 100_000,
    maxGeneratedIdSearch: 100_000,
    retryBackoffMilliseconds: Object.freeze([1_000, 5_000]),
});

export type PublicationVisibility = 'private' | 'public';
export type PublicationAttemptState = 'failed' | 'queued' | 'succeeded' | 'validating';
export type PublicationFailureKind = 'candidate' | 'operational' | 'operational-exhausted' | 'policy' | 'semantic';

export const PUBLICATION_FAILURE_RULES = Object.freeze({
    CHECK_PUBLICATION_CANDIDATE_CHANGED: Object.freeze({ kind: 'candidate', validation: 'null' }),
    CHECK_PUBLICATION_CANDIDATE_CONSUMED: Object.freeze({ kind: 'candidate', validation: 'null' }),
    CHECK_PUBLICATION_CANDIDATE_INVALID: Object.freeze({ kind: 'candidate', validation: 'null' }),
    CHECK_PUBLICATION_DEPENDENCY_INVALID: Object.freeze({ kind: 'candidate', validation: 'null' }),
    PUBLICATION_CANDIDATE_INVALID: Object.freeze({ kind: 'candidate', validation: 'null' }),
    PUBLICATION_CANDIDATE_OBJECT_INVALID: Object.freeze({ kind: 'candidate', validation: 'null' }),
    PUBLICATION_CANDIDATE_VALIDATION_FAILED: Object.freeze({ kind: 'candidate', validation: 'null' }),
    PUBLICATION_DEPENDENCY_INELIGIBLE: Object.freeze({ kind: 'policy', validation: 'null' }),
    PUBLICATION_POLICY_CHANGED: Object.freeze({ kind: 'policy', validation: 'null' }),
    PUBLICATION_PREFLIGHT_DEFECT: Object.freeze({ kind: 'operational', validation: 'null' }),
    PUBLICATION_PREFLIGHT_RETRY_EXHAUSTED: Object.freeze({ kind: 'operational-exhausted', validation: 'null' }),
    PUBLICATION_SEMANTIC_VALIDATION_FAILED: Object.freeze({ kind: 'semantic', validation: 'failed' }),
    PUBLICATION_VALIDATION_RESULT_INVALID: Object.freeze({ kind: 'candidate', validation: 'null' }),
    PUBLICATION_VALIDATION_RESULT_MISMATCH: Object.freeze({ kind: 'candidate', validation: 'null' }),
    PUBLICATION_VALIDATION_RETRY_EXHAUSTED: Object.freeze({ kind: 'operational-exhausted', validation: 'null' }),
    PUBLICATION_VALIDATION_RUNNER_DEFECT: Object.freeze({ kind: 'operational', validation: 'null' }),
    PUBLICATION_VALIDATOR_DEFECT: Object.freeze({ kind: 'operational', validation: 'null' }),
    PUBLICATION_VERSION_IMMUTABLE: Object.freeze({ kind: 'policy', validation: 'null' }),
});

export interface PublicationActor {
    readonly kind: 'authenticated-user';
    readonly userId: string;
}

export type PublicationCreateIntent = false | Readonly<{ readonly visibility: PublicationVisibility }>;

export type PublicationProvenance =
    | Readonly<{ readonly kind: 'unavailable' }>
    | Readonly<{ readonly kind: 'git'; readonly revision: string; readonly dirty: boolean }>;

export interface PublicationDependencyRelease {
    readonly canonicalIri: string;
    readonly version: string;
    readonly archiveSha256: string;
}

export interface LegacyAuthenticatedPublicationCandidateReceiptV1 {
    readonly internalRef: string;
    readonly revision: string;
    readonly archiveSha256: string;
    readonly byteSize: number;
    readonly manifestSha256: string;
    readonly canonicalIri: string;
    readonly preferredAlias: string;
    readonly registryOrigin: string;
    readonly version: string;
    readonly toolchain: LockToolchain;
    readonly dependencies: ReadonlyArray<ReferenceResolvedDependency>;
    readonly closure: ReadonlyArray<PublicationDependencyRelease>;
}

export const PUBLICATION_PUBLIC_METADATA_LIMITS = Object.freeze({
    maxTitleBytes: 256,
    maxDescriptionBytes: 4_096,
});

export interface PublicationCandidatePublicMetadata {
    readonly title: string | null;
    readonly description: string | null;
}

export interface AuthenticatedPublicationCandidateReceiptV2 extends LegacyAuthenticatedPublicationCandidateReceiptV1 {
    readonly schema: 'erden.publication-candidate-receipt/v2';
    readonly metadata: PublicationCandidatePublicMetadata;
}

export type AuthenticatedPublicationCandidateReceipt =
    | LegacyAuthenticatedPublicationCandidateReceiptV1
    | AuthenticatedPublicationCandidateReceiptV2;

export interface PublicationReportReceipt {
    readonly attemptId: string;
    readonly claimToken: string;
    readonly fence: number;
    readonly internalRef: string;
    readonly revision: string;
    readonly sha256: string;
    readonly byteSize: number;
}

declare const authenticatedPublicationReportReceipt: unique symbol;
export type AuthenticatedPublicationReportReceipt = PublicationReportReceipt &
    Readonly<{
        readonly [authenticatedPublicationReportReceipt]: true;
    }>;

export interface QueuePublicationInput {
    readonly actor: PublicationActor;
    readonly idempotencyKey: string;
    readonly candidateRef: string;
    readonly create: PublicationCreateIntent;
    readonly provenance: PublicationProvenance;
}

export interface PublicationProjectView {
    readonly canonicalIri: string;
    readonly preferredAlias: string;
    readonly visibility: PublicationVisibility;
}

export interface PublicationAttemptView {
    readonly schema: 'erden.publication-attempt/v1';
    readonly attemptId: string;
    readonly state: PublicationAttemptState;
    readonly project: PublicationProjectView;
    readonly version: string;
    readonly validationExecutions: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly failure: null | Readonly<{
        readonly kind: PublicationFailureKind;
        readonly code: string;
    }>;
    readonly report: null | Readonly<{ readonly sha256: string; readonly byteSize: number }>;
    readonly release: null | Readonly<{ readonly archiveSha256: string; readonly byteSize: number }>;
}

export type PublicationReportStageStatus = 'failed' | 'not-run' | 'passed' | 'skipped';

export interface PublicationReportSummaryV1 {
    readonly schema: 'erden.publication-report-summary/v1';
    readonly attemptId: string;
    readonly outcome: 'failed' | 'succeeded';
    readonly failure: null | Readonly<{
        readonly kind: PublicationFailureKind;
        readonly code: string;
    }>;
    readonly report: Readonly<{ readonly sha256: string; readonly byteSize: number }>;
    readonly validation: null | Readonly<{
        readonly status: 'failed' | 'passed';
        readonly stages: Readonly<{
            readonly citations: PublicationReportStageStatus;
            readonly competencyQuestions: PublicationReportStageStatus;
            readonly core: PublicationReportStageStatus;
            readonly reasoning: PublicationReportStageStatus;
            readonly shacl: PublicationReportStageStatus;
            readonly sources: PublicationReportStageStatus;
        }>;
        readonly warningCount: number;
        readonly shaclCounts: null | Readonly<{
            readonly info: number;
            readonly violation: number;
            readonly warning: number;
        }>;
        readonly competencyQuestionCounts: null | Readonly<{
            readonly dormant: number;
            readonly executed: number;
        }>;
    }>;
}

export const PUBLICATION_QUERY_LIMITS = Object.freeze({
    maxStatusBytes: 64 * 1_024,
    maxReportSummaryBytes: 64 * 1_024,
});

export interface PublicationFailureReportDocument {
    readonly schema: 'erden.publication-report/v1';
    readonly outcome: 'failed';
    readonly attemptId: string;
    readonly failure: Readonly<{
        readonly kind: PublicationFailureKind;
        readonly code: string;
    }>;
    readonly validation: PublicationCandidateValidationResult | null;
}

export interface PublicationSuccessReportDocument {
    readonly schema: 'erden.publication-report/v1';
    readonly outcome: 'succeeded';
    readonly attemptId: string;
    readonly failure: null;
    readonly validation: PublicationCandidateValidationResult;
}

export type PublicationReportDocument = PublicationFailureReportDocument | PublicationSuccessReportDocument;

export interface PublicationProjectRecord extends PublicationProjectView {
    readonly projectId: string;
    readonly ownerOrganizationId: string;
    readonly active: boolean;
}

export interface PublicationClaim {
    readonly requestId: string;
    readonly claimToken: string;
    readonly workerId: string;
    readonly fence: number;
    readonly claimedAt: number;
    readonly leaseUntil: number;
}

export interface PublicationClaimRequest {
    readonly workerId: string;
    readonly requestId: string;
}

interface PublicationAttemptBase {
    readonly attemptId: string;
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly intentFingerprint: string;
    readonly project: PublicationProjectRecord;
    readonly candidate: AuthenticatedPublicationCandidateReceipt;
    readonly provenance: PublicationProvenance;
    readonly preflightFailures: number;
    readonly validationExecutions: number;
    readonly createdAt: number;
    readonly updatedAt: number;
}

export interface QueuedPublicationAttempt extends PublicationAttemptBase {
    readonly state: 'queued';
    readonly nextClaimAt: number;
}

export interface ValidatingPublicationAttempt extends PublicationAttemptBase {
    readonly state: 'validating';
    readonly claim: PublicationClaim;
    readonly finalization: PublicationPendingFinalization | null;
}

export interface FailedPublicationAttempt extends PublicationAttemptBase {
    readonly state: 'failed';
    readonly failureKind: PublicationFailureKind;
    readonly failureCode: string;
    readonly report: PublicationReportReceipt;
    readonly completedAt: number;
}

export interface SucceededPublicationAttempt extends PublicationAttemptBase {
    readonly state: 'succeeded';
    readonly report: PublicationReportReceipt;
    readonly releaseId: string;
    readonly completedAt: number;
}

export type PublicationAttempt =
    | FailedPublicationAttempt
    | QueuedPublicationAttempt
    | SucceededPublicationAttempt
    | ValidatingPublicationAttempt;

export interface PublicationPendingFailure {
    readonly outcome: 'failed';
    readonly kind: PublicationFailureKind;
    readonly code: string;
    readonly report: PublicationFailureReportDocument;
}

export interface PublicationPendingSuccess {
    readonly outcome: 'succeeded';
    readonly result: PublicationCandidateValidationResult;
    readonly report: PublicationSuccessReportDocument;
}

export type PublicationPendingFinalization = PublicationPendingFailure | PublicationPendingSuccess;

export interface PublicationReleaseRecord {
    readonly releaseId: string;
    readonly project: PublicationProjectRecord;
    readonly version: string;
    readonly candidate: AuthenticatedPublicationCandidateReceipt;
    readonly report: PublicationReportReceipt;
    readonly dependencies: ReadonlyArray<ReferenceResolvedDependency>;
    readonly closure: ReadonlyArray<PublicationDependencyRelease>;
    readonly publishedAt: number;
}

export interface PublicationReleaseView {
    readonly schema: 'erden.publication-release/v1';
    readonly project: PublicationProjectView;
    readonly version: string;
    readonly archive: Readonly<{ readonly sha256: string; readonly byteSize: number }>;
    readonly dependencies: ReadonlyArray<ReferenceResolvedDependency>;
    readonly closure: ReadonlyArray<PublicationDependencyRelease>;
    readonly publishedAt: number;
}

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function record(input: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw publicationInputInvalid();
    }
    const names = Object.getOwnPropertyNames(input).sort(compare);
    const expected = [...keys].sort(compare);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        throw publicationInputInvalid();
    }
    const result: Record<string, unknown> = {};
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw publicationInputInvalid();
        }
        result[name] = descriptor.value;
    }
    return Object.freeze(result);
}

function dense(input: unknown, maximum: number): ReadonlyArray<unknown> {
    if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw publicationInputInvalid();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > maximum
    ) {
        throw publicationInputInvalid();
    }
    const length = lengthDescriptor.value as number;
    if (Object.getOwnPropertyNames(input).length !== length + 1) {
        throw publicationInputInvalid();
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw publicationInputInvalid();
        }
        result.push(descriptor.value);
    }
    return result;
}

function opaque(input: unknown): string {
    if (
        typeof input !== 'string' ||
        !input.isWellFormed() ||
        !OPAQUE_ID.test(input) ||
        textEncoder.encode(input).byteLength > PUBLICATION_LIMITS.maxIdBytes
    ) {
        throw publicationInputInvalid();
    }
    return input;
}

function nonnegative(input: unknown): number {
    if (!Number.isSafeInteger(input) || typeof input !== 'number' || input < 0 || Object.is(input, -0)) {
        throw publicationInputInvalid();
    }
    return input;
}

function positiveBounded(input: unknown, maximum: number): number {
    const value = nonnegative(input);
    if (value === 0 || value > maximum) {
        throw publicationInputInvalid();
    }
    return value;
}

function sha256(input: unknown): string {
    if (typeof input !== 'string' || !SHA256.test(input)) {
        throw publicationInputInvalid();
    }
    return input;
}

function boundedScalar(input: unknown): string {
    if (
        typeof input !== 'string' ||
        !input.isWellFormed() ||
        textEncoder.encode(input).byteLength > LOCKFILE_LIMITS.maxScalarBytes
    ) {
        throw publicationInputInvalid();
    }
    return input;
}

function exactVersion(input: unknown): string {
    const value = boundedScalar(input);
    if (!EXACT_SEMVER.test(value) || valid(value, { loose: false }) === null) {
        throw publicationInputInvalid();
    }
    return value;
}

function decodeEdge(input: unknown): ReferenceResolvedDependency {
    const value = record(input, ['archiveSha256', 'canonicalIri', 'requested', 'version']);
    const canonicalIri = boundedScalar(value['canonicalIri']);
    const requested = boundedScalar(value['requested']);
    if (!isCanonicalOntologyIri(canonicalIri) || validRange(requested, { loose: false }) === null) {
        throw publicationInputInvalid();
    }
    return Object.freeze({
        requested,
        canonicalIri,
        version: exactVersion(value['version']),
        archiveSha256: sha256(value['archiveSha256']),
    });
}

function decodeDependencyRelease(input: unknown): PublicationDependencyRelease {
    const value = record(input, ['archiveSha256', 'canonicalIri', 'version']);
    const canonicalIri = boundedScalar(value['canonicalIri']);
    if (!isCanonicalOntologyIri(canonicalIri)) {
        throw publicationInputInvalid();
    }
    return Object.freeze({
        canonicalIri,
        version: exactVersion(value['version']),
        archiveSha256: sha256(value['archiveSha256']),
    });
}

function canonicalArray<
    Value extends {
        readonly canonicalIri: string;
    },
>(input: unknown, maximum: number, decode: (value: unknown) => Value): ReadonlyArray<Value> {
    const values = dense(input, maximum).map(decode);
    for (let index = 1; index < values.length; index += 1) {
        const prior = values[index - 1];
        const current = values[index];
        if (prior === undefined || current === undefined || compare(prior.canonicalIri, current.canonicalIri) >= 0) {
            throw publicationInputInvalid();
        }
    }
    return Object.freeze(values);
}

export function decodePublicationActor(input: unknown): PublicationActor {
    try {
        const value = record(input, ['kind', 'userId']);
        if (value['kind'] !== 'authenticated-user') {
            throw publicationInputInvalid();
        }
        return Object.freeze({ kind: 'authenticated-user', userId: opaque(value['userId']) });
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationOpaqueId(input: unknown): string {
    try {
        return opaque(input);
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationExactVersion(input: unknown): string {
    try {
        return exactVersion(input);
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationCanonicalIri(input: unknown): string {
    const value = boundedScalar(input);
    if (!isCanonicalOntologyIri(value)) {
        throw publicationInputInvalid();
    }
    return value;
}

function decodeLegacyCandidateReceipt(input: unknown): LegacyAuthenticatedPublicationCandidateReceiptV1 {
    try {
        const value = record(input, [
            'archiveSha256',
            'byteSize',
            'canonicalIri',
            'closure',
            'dependencies',
            'internalRef',
            'manifestSha256',
            'preferredAlias',
            'registryOrigin',
            'revision',
            'toolchain',
            'version',
        ]);
        const canonicalIri = boundedScalar(value['canonicalIri']);
        const preferredAlias = boundedScalar(value['preferredAlias']);
        const registryOrigin = boundedScalar(value['registryOrigin']);
        if (
            !isCanonicalOntologyIri(canonicalIri) ||
            !isScopedAlias(preferredAlias) ||
            !isRegistryOrigin(registryOrigin) ||
            normalizeRegistryOrigin(registryOrigin) !== registryOrigin
        ) {
            throw publicationInputInvalid();
        }
        const dependencies = canonicalArray(value['dependencies'], PUBLICATION_LIMITS.maxDependencies, decodeEdge);
        const closure = canonicalArray(value['closure'], PUBLICATION_LIMITS.maxClosure, decodeDependencyRelease);
        const closureByIri = new Map(closure.map((dependency) => [dependency.canonicalIri, dependency]));
        for (const edge of dependencies) {
            const locked = closureByIri.get(edge.canonicalIri);
            if (
                locked === undefined ||
                locked.version !== edge.version ||
                locked.archiveSha256 !== edge.archiveSha256
            ) {
                throw publicationInputInvalid();
            }
        }
        return Object.freeze({
            internalRef: opaque(value['internalRef']),
            revision: opaque(value['revision']),
            archiveSha256: sha256(value['archiveSha256']),
            byteSize: positiveBounded(value['byteSize'], PUBLICATION_LIMITS.maxCandidateBytes),
            manifestSha256: sha256(value['manifestSha256']),
            canonicalIri,
            preferredAlias,
            registryOrigin,
            version: exactVersion(value['version']),
            toolchain: decodeLockToolchain(value['toolchain']),
            dependencies,
            closure,
        });
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationCandidatePublicMetadata(input: unknown): PublicationCandidatePublicMetadata {
    try {
        const value = record(input, ['description', 'title']);
        function decode(raw: unknown, maximum: number): string | null {
            if (raw === null) {
                return null;
            }
            if (
                typeof raw !== 'string' ||
                raw.length === 0 ||
                !raw.isWellFormed() ||
                textEncoder.encode(raw).byteLength > maximum
            ) {
                throw publicationInputInvalid();
            }
            return raw;
        }
        return Object.freeze({
            title: decode(value['title'], PUBLICATION_PUBLIC_METADATA_LIMITS.maxTitleBytes),
            description: decode(value['description'], PUBLICATION_PUBLIC_METADATA_LIMITS.maxDescriptionBytes),
        });
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodeCandidateReceipt(input: unknown): AuthenticatedPublicationCandidateReceipt {
    try {
        const value = record(input, [
            'archiveSha256',
            'byteSize',
            'canonicalIri',
            'closure',
            'dependencies',
            'internalRef',
            'manifestSha256',
            'metadata',
            'preferredAlias',
            'registryOrigin',
            'revision',
            'schema',
            'toolchain',
            'version',
        ]);
        if (value['schema'] !== 'erden.publication-candidate-receipt/v2') {
            throw publicationInputInvalid();
        }
        const legacy = decodeLegacyCandidateReceipt({
            archiveSha256: value['archiveSha256'],
            byteSize: value['byteSize'],
            canonicalIri: value['canonicalIri'],
            closure: value['closure'],
            dependencies: value['dependencies'],
            internalRef: value['internalRef'],
            manifestSha256: value['manifestSha256'],
            preferredAlias: value['preferredAlias'],
            registryOrigin: value['registryOrigin'],
            revision: value['revision'],
            toolchain: value['toolchain'],
            version: value['version'],
        });
        return Object.freeze({
            ...legacy,
            schema: 'erden.publication-candidate-receipt/v2',
            metadata: decodePublicationCandidatePublicMetadata(value['metadata']),
        });
    } catch {
        return decodeLegacyCandidateReceipt(input);
    }
}

export function publicationCandidatePublicMetadata(
    receipt: AuthenticatedPublicationCandidateReceipt,
): PublicationCandidatePublicMetadata {
    return 'schema' in receipt ? receipt.metadata : Object.freeze({ title: null, description: null });
}

export function decodeReportReceipt(input: unknown): PublicationReportReceipt {
    try {
        const value = record(input, [
            'attemptId',
            'byteSize',
            'claimToken',
            'fence',
            'internalRef',
            'revision',
            'sha256',
        ]);
        return Object.freeze({
            attemptId: opaque(value['attemptId']),
            claimToken: opaque(value['claimToken']),
            fence: positiveBounded(value['fence'], Number.MAX_SAFE_INTEGER),
            internalRef: opaque(value['internalRef']),
            revision: opaque(value['revision']),
            sha256: sha256(value['sha256']),
            byteSize: positiveBounded(value['byteSize'], PUBLICATION_LIMITS.maxReportBytes),
        });
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationClaimRequest(input: unknown): PublicationClaimRequest {
    try {
        const value = record(input, ['requestId', 'workerId']);
        return Object.freeze({
            workerId: opaque(value['workerId']),
            requestId: opaque(value['requestId']),
        });
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationClaim(input: unknown): PublicationClaim {
    try {
        const value = record(input, ['claimToken', 'claimedAt', 'fence', 'leaseUntil', 'requestId', 'workerId']);
        const claimedAt = nonnegative(value['claimedAt']);
        const leaseUntil = nonnegative(value['leaseUntil']);
        const fence = positiveBounded(value['fence'], Number.MAX_SAFE_INTEGER);
        if (leaseUntil <= claimedAt) {
            throw publicationInputInvalid();
        }
        return Object.freeze({
            requestId: opaque(value['requestId']),
            claimToken: opaque(value['claimToken']),
            workerId: opaque(value['workerId']),
            fence,
            claimedAt,
            leaseUntil,
        });
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationValidationResult(input: unknown): PublicationCandidateValidationResult {
    try {
        const value = record(input, [
            'archive',
            'dependencies',
            'directDependencies',
            'project',
            'report',
            'status',
            'toolchain',
        ]);
        const project = record(value['project'], ['canonicalIri', 'preferredAlias', 'registryOrigin', 'version']);
        const archive = record(value['archive'], ['byteSize', 'manifestSha256', 'revision', 'sha256']);
        const canonicalIri = boundedScalar(project['canonicalIri']);
        const preferredAlias = boundedScalar(project['preferredAlias']);
        const registryOrigin = boundedScalar(project['registryOrigin']);
        if (
            (value['status'] !== 'failed' && value['status'] !== 'passed') ||
            !isCanonicalOntologyIri(canonicalIri) ||
            !isScopedAlias(preferredAlias) ||
            !isRegistryOrigin(registryOrigin) ||
            normalizeRegistryOrigin(registryOrigin) !== registryOrigin
        ) {
            throw publicationInputInvalid();
        }
        const report = decodeCheckProjectReport(value['report']);
        if (report.outcome !== value['status']) {
            throw publicationInputInvalid();
        }
        return Object.freeze({
            status: value['status'],
            project: Object.freeze({
                canonicalIri,
                preferredAlias,
                registryOrigin,
                version: exactVersion(project['version']),
            }),
            archive: Object.freeze({
                revision: opaque(archive['revision']),
                sha256: sha256(archive['sha256']),
                byteSize: positiveBounded(archive['byteSize'], PUBLICATION_LIMITS.maxCandidateBytes),
                manifestSha256: sha256(archive['manifestSha256']),
            }),
            toolchain: decodeLockToolchain(value['toolchain']),
            directDependencies: canonicalArray(
                value['directDependencies'],
                PUBLICATION_LIMITS.maxDependencies,
                decodeEdge,
            ),
            dependencies: canonicalArray(value['dependencies'], PUBLICATION_LIMITS.maxClosure, decodeDependencyRelease),
            report,
        });
    } catch {
        throw publicationInputInvalid();
    }
}

export interface PublicationFailureIdentity {
    readonly kind: PublicationFailureKind;
    readonly code: string;
    readonly validation: 'failed' | 'null';
}

export interface PublicationFailureBinding extends PublicationFailureIdentity {
    readonly result: PublicationCandidateValidationResult | null;
}

export function decodePublicationFailureIdentity(kindInput: unknown, codeInput: unknown): PublicationFailureIdentity {
    try {
        if (typeof codeInput !== 'string') {
            throw publicationInputInvalid();
        }
        const descriptor = Object.getOwnPropertyDescriptor(PUBLICATION_FAILURE_RULES, codeInput);
        const rule: unknown = descriptor?.value;
        if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
            throw publicationInputInvalid();
        }
        const kind = Object.getOwnPropertyDescriptor(rule, 'kind');
        const validation = Object.getOwnPropertyDescriptor(rule, 'validation');
        const kindValue: unknown = kind?.value;
        const validationValue: unknown = validation?.value;
        if (
            kind === undefined ||
            !('value' in kind) ||
            kindValue !== kindInput ||
            (kindValue !== 'candidate' &&
                kindValue !== 'operational' &&
                kindValue !== 'operational-exhausted' &&
                kindValue !== 'policy' &&
                kindValue !== 'semantic') ||
            validation === undefined ||
            !('value' in validation) ||
            (validationValue !== 'failed' && validationValue !== 'null')
        ) {
            throw publicationInputInvalid();
        }
        return Object.freeze({ kind: kindValue, code: codeInput, validation: validationValue });
    } catch {
        throw publicationInputInvalid();
    }
}

export function decodePublicationFailureBinding(
    kindInput: unknown,
    codeInput: unknown,
    validationInput: unknown,
): PublicationFailureBinding {
    const identity = decodePublicationFailureIdentity(kindInput, codeInput);
    if (identity.validation === 'null') {
        if (validationInput !== null) {
            throw publicationInputInvalid();
        }
        return Object.freeze({ ...identity, result: null });
    }
    const result = decodePublicationValidationResult(validationInput);
    if (result.status !== 'failed') {
        throw publicationInputInvalid();
    }
    return Object.freeze({ ...identity, result });
}

export function decodePublicationReportDocument(input: unknown): PublicationReportDocument {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            throw publicationInputInvalid();
        }
        const outcome = Object.getOwnPropertyDescriptor(input, 'outcome');
        if (outcome === undefined || !('value' in outcome) || !outcome.enumerable) {
            throw publicationInputInvalid();
        }
        if (outcome.value === 'failed') {
            const value = record(input, ['attemptId', 'failure', 'outcome', 'schema', 'validation']);
            const failure = record(value['failure'], ['code', 'kind']);
            if (value['schema'] !== 'erden.publication-report/v1') {
                throw publicationInputInvalid();
            }
            const binding = decodePublicationFailureBinding(failure['kind'], failure['code'], value['validation']);
            return Object.freeze({
                schema: 'erden.publication-report/v1',
                outcome: 'failed',
                attemptId: opaque(value['attemptId']),
                failure: Object.freeze({ kind: binding.kind, code: binding.code }),
                validation: binding.result,
            });
        }
        if (outcome.value !== 'succeeded') {
            throw publicationInputInvalid();
        }
        const value = record(input, ['attemptId', 'failure', 'outcome', 'schema', 'validation']);
        if (value['schema'] !== 'erden.publication-report/v1' || value['failure'] !== null) {
            throw publicationInputInvalid();
        }
        const validation = decodePublicationValidationResult(value['validation']);
        if (validation.status !== 'passed') {
            throw publicationInputInvalid();
        }
        return Object.freeze({
            schema: 'erden.publication-report/v1',
            outcome: 'succeeded',
            attemptId: opaque(value['attemptId']),
            failure: null,
            validation,
        });
    } catch {
        throw publicationInputInvalid();
    }
}

function decodeCreate(input: unknown): PublicationCreateIntent {
    if (input === false) {
        return false;
    }
    const value = record(input, ['visibility']);
    const visibility = value['visibility'];
    if (visibility !== 'private' && visibility !== 'public') {
        throw publicationInputInvalid();
    }
    return Object.freeze({ visibility });
}

function decodeProvenance(input: unknown): PublicationProvenance {
    if (input !== null && typeof input === 'object') {
        const kind = Object.getOwnPropertyDescriptor(input, 'kind');
        if (kind !== undefined && 'value' in kind && kind.value === 'unavailable') {
            record(input, ['kind']);
            return Object.freeze({ kind: 'unavailable' });
        }
    }
    const value = record(input, ['dirty', 'kind', 'revision']);
    if (
        value['kind'] !== 'git' ||
        typeof value['revision'] !== 'string' ||
        !GIT_REVISION.test(value['revision']) ||
        typeof value['dirty'] !== 'boolean'
    ) {
        throw publicationInputInvalid();
    }
    return Object.freeze({ kind: 'git', revision: value['revision'], dirty: value['dirty'] });
}

export function decodeQueuePublicationInput(input: unknown): QueuePublicationInput {
    try {
        const value = record(input, ['actor', 'candidateRef', 'create', 'idempotencyKey', 'provenance']);
        const key = value['idempotencyKey'];
        if (
            typeof key !== 'string' ||
            !key.isWellFormed() ||
            !IDEMPOTENCY_KEY.test(key) ||
            textEncoder.encode(key).byteLength > PUBLICATION_LIMITS.maxIdempotencyKeyBytes
        ) {
            throw publicationInputInvalid();
        }
        return Object.freeze({
            actor: decodePublicationActor(value['actor']),
            idempotencyKey: key,
            candidateRef: opaque(value['candidateRef']),
            create: decodeCreate(value['create']),
            provenance: decodeProvenance(value['provenance']),
        });
    } catch {
        throw publicationInputInvalid();
    }
}

export function publicationIntentFingerprint(
    input: QueuePublicationInput,
    candidate: AuthenticatedPublicationCandidateReceipt,
): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                create: input.create,
                provenance: input.provenance,
                candidate: {
                    archiveSha256: candidate.archiveSha256,
                    byteSize: candidate.byteSize,
                    manifestSha256: candidate.manifestSha256,
                    canonicalIri: candidate.canonicalIri,
                    preferredAlias: candidate.preferredAlias,
                    registryOrigin: candidate.registryOrigin,
                    version: candidate.version,
                    toolchain: candidate.toolchain,
                    dependencies: candidate.dependencies,
                    closure: candidate.closure,
                },
            }),
        )
        .digest('hex');
}

export function projectOrganizationSlug(alias: string): string {
    return alias.slice(1, alias.indexOf('/'));
}

export function releaseKey(canonicalIri: string, version: string): string {
    return `${canonicalIri}\u0000${version}`;
}

export function dependencyReleaseKey(dependency: PublicationDependencyRelease): string {
    return `${dependency.canonicalIri}\u0000${dependency.version}\u0000${dependency.archiveSha256}`;
}

export function validationMatchesCandidate(
    result: PublicationCandidateValidationResult,
    candidate: AuthenticatedPublicationCandidateReceipt,
): boolean {
    return (
        result.project.canonicalIri === candidate.canonicalIri &&
        result.project.preferredAlias === candidate.preferredAlias &&
        result.project.registryOrigin === candidate.registryOrigin &&
        result.project.version === candidate.version &&
        result.archive.revision === candidate.revision &&
        result.archive.sha256 === candidate.archiveSha256 &&
        result.archive.byteSize === candidate.byteSize &&
        result.archive.manifestSha256 === candidate.manifestSha256 &&
        JSON.stringify(result.toolchain) === JSON.stringify(candidate.toolchain) &&
        JSON.stringify(result.directDependencies) === JSON.stringify(candidate.dependencies) &&
        JSON.stringify(result.dependencies) === JSON.stringify(candidate.closure)
    );
}

export function publicationValidationFingerprint(
    result: PublicationCandidateValidationResult,
    candidate: AuthenticatedPublicationCandidateReceipt,
): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                candidate: {
                    revision: candidate.revision,
                    registryOrigin: candidate.registryOrigin,
                    dependencies: candidate.dependencies,
                    closure: candidate.closure,
                },
                result,
            }),
        )
        .digest('hex');
}

export function publicationAttemptView(attempt: PublicationAttempt): PublicationAttemptView {
    return Object.freeze({
        schema: 'erden.publication-attempt/v1',
        attemptId: attempt.attemptId,
        state: attempt.state,
        project: Object.freeze({
            canonicalIri: attempt.project.canonicalIri,
            preferredAlias: attempt.project.preferredAlias,
            visibility: attempt.project.visibility,
        }),
        version: attempt.candidate.version,
        validationExecutions: attempt.validationExecutions,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
        failure:
            attempt.state === 'failed' ? Object.freeze({ kind: attempt.failureKind, code: attempt.failureCode }) : null,
        report:
            attempt.state === 'failed' || attempt.state === 'succeeded'
                ? Object.freeze({ sha256: attempt.report.sha256, byteSize: attempt.report.byteSize })
                : null,
        release:
            attempt.state === 'succeeded'
                ? Object.freeze({
                      archiveSha256: attempt.candidate.archiveSha256,
                      byteSize: attempt.candidate.byteSize,
                  })
                : null,
    });
}

function decodePublicationProjectView(input: unknown): PublicationProjectView {
    const value = record(input, ['canonicalIri', 'preferredAlias', 'visibility']);
    const canonicalIri = boundedScalar(value['canonicalIri']);
    const preferredAlias = boundedScalar(value['preferredAlias']);
    const visibility = value['visibility'];
    if (
        !isCanonicalOntologyIri(canonicalIri) ||
        !isScopedAlias(preferredAlias) ||
        (visibility !== 'private' && visibility !== 'public')
    ) {
        throw publicationInputInvalid();
    }
    return Object.freeze({ canonicalIri, preferredAlias, visibility });
}

function decodePublicationFailureView(input: unknown): Readonly<{
    readonly kind: PublicationFailureKind;
    readonly code: string;
}> {
    const value = record(input, ['code', 'kind']);
    const failure = decodePublicationFailureIdentity(value['kind'], value['code']);
    return Object.freeze({ kind: failure.kind, code: failure.code });
}

function decodePublicationDigestView(
    input: unknown,
    digestField: 'archiveSha256' | 'sha256',
    maximumBytes: number,
): Readonly<{
    readonly sha256: string;
    readonly byteSize: number;
}> {
    const value = record(input, [digestField, 'byteSize']);
    return Object.freeze({
        sha256: sha256(value[digestField]),
        byteSize: positiveBounded(value['byteSize'], maximumBytes),
    });
}

export function decodePublicationAttemptView(input: unknown): PublicationAttemptView {
    try {
        const value = record(input, [
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
        if (value['schema'] !== 'erden.publication-attempt/v1') {
            throw publicationInputInvalid();
        }
        const state = value['state'];
        if (state !== 'failed' && state !== 'queued' && state !== 'succeeded' && state !== 'validating') {
            throw publicationInputInvalid();
        }
        const createdAt = nonnegative(value['createdAt']);
        const updatedAt = nonnegative(value['updatedAt']);
        const validationExecutions = nonnegative(value['validationExecutions']);
        if (updatedAt < createdAt || validationExecutions > PUBLICATION_LIMITS.maxValidationExecutions) {
            throw publicationInputInvalid();
        }
        const failure = value['failure'] === null ? null : decodePublicationFailureView(value['failure']);
        const report =
            value['report'] === null
                ? null
                : decodePublicationDigestView(value['report'], 'sha256', PUBLICATION_LIMITS.maxReportBytes);
        const archive =
            value['release'] === null
                ? null
                : decodePublicationDigestView(value['release'], 'archiveSha256', PUBLICATION_LIMITS.maxCandidateBytes);
        if (
            (state === 'failed' && (failure === null || report === null || archive !== null)) ||
            (state === 'succeeded' && (failure !== null || report === null || archive === null)) ||
            ((state === 'queued' || state === 'validating') &&
                (failure !== null || report !== null || archive !== null))
        ) {
            throw publicationInputInvalid();
        }
        return Object.freeze({
            schema: 'erden.publication-attempt/v1',
            attemptId: opaque(value['attemptId']),
            state,
            project: decodePublicationProjectView(value['project']),
            version: exactVersion(value['version']),
            validationExecutions,
            createdAt,
            updatedAt,
            failure,
            report,
            release:
                archive === null
                    ? null
                    : Object.freeze({
                          archiveSha256: archive.sha256,
                          byteSize: archive.byteSize,
                      }),
        });
    } catch {
        throw publicationInputInvalid();
    }
}

function decodePublicationReportStageStatus(input: unknown): PublicationReportStageStatus {
    if (input !== 'failed' && input !== 'not-run' && input !== 'passed' && input !== 'skipped') {
        throw publicationInputInvalid();
    }
    return input;
}

function decodePublicationReportSummaryValidation(
    input: unknown,
): NonNullable<PublicationReportSummaryV1['validation']> {
    const value = record(input, ['competencyQuestionCounts', 'shaclCounts', 'stages', 'status', 'warningCount']);
    const status = value['status'];
    if (status !== 'failed' && status !== 'passed') {
        throw publicationInputInvalid();
    }
    const stages = record(value['stages'], [
        'citations',
        'competencyQuestions',
        'core',
        'reasoning',
        'shacl',
        'sources',
    ]);
    const shacl = value['shaclCounts'] === null ? null : record(value['shaclCounts'], ['info', 'violation', 'warning']);
    const competencyQuestions =
        value['competencyQuestionCounts'] === null
            ? null
            : record(value['competencyQuestionCounts'], ['dormant', 'executed']);
    return Object.freeze({
        status,
        stages: Object.freeze({
            citations: decodePublicationReportStageStatus(stages['citations']),
            competencyQuestions: decodePublicationReportStageStatus(stages['competencyQuestions']),
            core: decodePublicationReportStageStatus(stages['core']),
            reasoning: decodePublicationReportStageStatus(stages['reasoning']),
            shacl: decodePublicationReportStageStatus(stages['shacl']),
            sources: decodePublicationReportStageStatus(stages['sources']),
        }),
        warningCount: nonnegative(value['warningCount']),
        shaclCounts:
            shacl === null
                ? null
                : Object.freeze({
                      info: nonnegative(shacl['info']),
                      violation: nonnegative(shacl['violation']),
                      warning: nonnegative(shacl['warning']),
                  }),
        competencyQuestionCounts:
            competencyQuestions === null
                ? null
                : Object.freeze({
                      dormant: nonnegative(competencyQuestions['dormant']),
                      executed: nonnegative(competencyQuestions['executed']),
                  }),
    });
}

export function decodePublicationReportSummary(input: unknown): PublicationReportSummaryV1 {
    try {
        const value = record(input, ['attemptId', 'failure', 'outcome', 'report', 'schema', 'validation']);
        if (value['schema'] !== 'erden.publication-report-summary/v1') {
            throw publicationInputInvalid();
        }
        const outcome = value['outcome'];
        if (outcome !== 'failed' && outcome !== 'succeeded') {
            throw publicationInputInvalid();
        }
        const failure = value['failure'] === null ? null : decodePublicationFailureView(value['failure']);
        const validation =
            value['validation'] === null ? null : decodePublicationReportSummaryValidation(value['validation']);
        if (outcome === 'succeeded') {
            if (failure !== null || validation?.status !== 'passed') {
                throw publicationInputInvalid();
            }
        } else {
            if (failure === null) {
                throw publicationInputInvalid();
            }
            const identity = decodePublicationFailureIdentity(failure.kind, failure.code);
            if (
                (identity.validation === 'failed' && validation?.status !== 'failed') ||
                (identity.validation === 'null' && validation !== null)
            ) {
                throw publicationInputInvalid();
            }
        }
        const report = decodePublicationDigestView(value['report'], 'sha256', PUBLICATION_LIMITS.maxReportBytes);
        const summary = Object.freeze({
            schema: 'erden.publication-report-summary/v1' as const,
            attemptId: opaque(value['attemptId']),
            outcome,
            failure,
            report,
            validation,
        });
        if (encodeCanonicalPublicationJson(summary).byteLength > PUBLICATION_QUERY_LIMITS.maxReportSummaryBytes) {
            throw publicationInputInvalid();
        }
        return summary;
    } catch {
        throw publicationInputInvalid();
    }
}

type CanonicalPublicationJson =
    | null
    | boolean
    | number
    | string
    | ReadonlyArray<CanonicalPublicationJson>
    | { readonly [key: string]: CanonicalPublicationJson };

function canonicalizePublicationJson(input: unknown): CanonicalPublicationJson {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') {
        return input;
    }
    if (typeof input === 'number' && Number.isFinite(input) && !Object.is(input, -0)) {
        return input;
    }
    if (Array.isArray(input)) {
        return input.map(canonicalizePublicationJson);
    }
    if (typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
        const result: Record<string, CanonicalPublicationJson> = {};
        for (const key of Object.getOwnPropertyNames(input).sort(compare)) {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw publicationInputInvalid();
            }
            result[key] = canonicalizePublicationJson(descriptor.value);
        }
        return result;
    }
    throw publicationInputInvalid();
}

function encodeCanonicalPublicationJson(input: unknown): Uint8Array {
    return textEncoder.encode(`${JSON.stringify(canonicalizePublicationJson(input))}\n`);
}

export function encodePublicationAttemptView(input: PublicationAttemptView): Uint8Array {
    const bytes = encodeCanonicalPublicationJson(decodePublicationAttemptView(input));
    if (bytes.byteLength > PUBLICATION_QUERY_LIMITS.maxStatusBytes) {
        throw publicationInputInvalid();
    }
    return bytes;
}

export function publicationReportSummary(
    rawReceipt: PublicationReportReceipt,
    rawDocument: PublicationReportDocument,
): PublicationReportSummaryV1 {
    const receipt = decodeReportReceipt(rawReceipt);
    const document = decodePublicationReportDocument(rawDocument);
    const documentBytes = encodeCanonicalPublicationJson(document);
    if (
        document.attemptId !== receipt.attemptId ||
        documentBytes.byteLength !== receipt.byteSize ||
        createHash('sha256').update(documentBytes).digest('hex') !== receipt.sha256
    ) {
        throw publicationInputInvalid();
    }
    const report = Object.freeze({ sha256: receipt.sha256, byteSize: receipt.byteSize });
    const validation =
        document.validation === null
            ? null
            : Object.freeze({
                  status: document.validation.status,
                  stages: Object.freeze({
                      citations: document.validation.report.stages.citations.status,
                      competencyQuestions: document.validation.report.stages.competencyQuestions.status,
                      core: document.validation.report.stages.core.status,
                      reasoning: document.validation.report.stages.reasoning.status,
                      shacl: document.validation.report.stages.shacl.status,
                      sources: document.validation.report.stages.sources.status,
                  }),
                  warningCount: document.validation.report.warnings.length,
                  shaclCounts:
                      document.validation.report.stages.shacl.details === null
                          ? null
                          : Object.freeze({
                                info: document.validation.report.stages.shacl.details.counts.info,
                                violation: document.validation.report.stages.shacl.details.counts.violation,
                                warning: document.validation.report.stages.shacl.details.counts.warning,
                            }),
                  competencyQuestionCounts:
                      document.validation.report.stages.competencyQuestions.details === null
                          ? null
                          : Object.freeze({
                                dormant: document.validation.report.stages.competencyQuestions.details.dormant,
                                executed: document.validation.report.stages.competencyQuestions.details.executed,
                            }),
              });
    const summary: PublicationReportSummaryV1 = Object.freeze({
        schema: 'erden.publication-report-summary/v1',
        attemptId: document.attemptId,
        outcome: document.outcome,
        failure: document.failure === null ? null : Object.freeze({ ...document.failure }),
        report,
        validation,
    });
    if (encodeCanonicalPublicationJson(summary).byteLength > PUBLICATION_QUERY_LIMITS.maxReportSummaryBytes) {
        throw publicationInputInvalid();
    }
    return summary;
}

export function encodePublicationReportSummary(input: PublicationReportSummaryV1): Uint8Array {
    const bytes = encodeCanonicalPublicationJson(decodePublicationReportSummary(input));
    if (bytes.byteLength > PUBLICATION_QUERY_LIMITS.maxReportSummaryBytes) {
        throw publicationInputInvalid();
    }
    return bytes;
}

export function publicationReleaseView(release: PublicationReleaseRecord): PublicationReleaseView {
    return Object.freeze({
        schema: 'erden.publication-release/v1',
        project: Object.freeze({
            canonicalIri: release.project.canonicalIri,
            preferredAlias: release.project.preferredAlias,
            visibility: release.project.visibility,
        }),
        version: release.version,
        archive: Object.freeze({ sha256: release.candidate.archiveSha256, byteSize: release.candidate.byteSize }),
        dependencies: Object.freeze(release.dependencies.map((dependency) => Object.freeze({ ...dependency }))),
        closure: Object.freeze(release.closure.map((dependency) => Object.freeze({ ...dependency }))),
        publishedAt: release.publishedAt,
    });
}

export function isLeaseLive(claim: PublicationClaim, databaseTime: number): boolean {
    return databaseTime >= claim.claimedAt && databaseTime < claim.leaseUntil;
}

export function isActiveAttempt(attempt: PublicationAttempt): boolean {
    return attempt.state === 'queued' || attempt.state === 'validating';
}
