import { createHash } from 'node:crypto';

import { normalizeReasonerRequest, normalizeReasonerResponse, stringifyCanonicalJson } from './canonical.js';
import { ERDEN_PROOF_CHECKER_ID, ERDEN_PROOF_CHECKER_SHA256, REASONER_PROTOCOL_VERSION } from './profile.js';
import { assertValidReasonerProof } from './proof-walk.js';
import type {
    CheckedCertificate,
    DecidedResult,
    InferredStatement,
    Lemma,
    ReasonerRequest,
    ReasonerResponse,
} from './schema.js';

export type DecidedEvidence = Omit<DecidedResult, 'certificate'>;

export interface CertificateCheckerIdentity {
    readonly name: string;
    readonly version: string;
}

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

export function sha256CanonicalJson(value: Parameters<typeof stringifyCanonicalJson>[0]): string {
    return `sha256:${createHash('sha256').update(stringifyCanonicalJson(value)).digest('hex')}`;
}

function placeholderCertificate(request: ReasonerRequest): CheckedCertificate {
    return {
        decision: 'Decided',
        checked: true,
        checkerName: 'pending',
        checkerVersion: 'pending',
        proofCheckerId: ERDEN_PROOF_CHECKER_ID,
        proofCheckerDigest: ERDEN_PROOF_CHECKER_SHA256,
        inputDigest: ZERO_DIGEST,
        outputDigest: ZERO_DIGEST,
        calculusDigest: request.requiredTool.calculusDigest,
        certificateDigest: ZERO_DIGEST,
        justificationDigest: ZERO_DIGEST,
    };
}

function normalizeEvidence(request: ReasonerRequest, evidence: DecidedEvidence): DecidedEvidence {
    const response: ReasonerResponse = {
        protocolVersion: REASONER_PROTOCOL_VERSION,
        kind: 'ReasonerResponse',
        requestId: request.requestId,
        profile: request.profile,
        tool: request.requiredTool,
        inputDigest: request.ontology.digest,
        result: { ...evidence, certificate: placeholderCertificate(request) },
    };
    const normalized = normalizeReasonerResponse(response);
    if (normalized.result.outcome !== 'decided') {
        throw new TypeError('Expected decided evidence');
    }
    const { certificate: _certificate, ...result } = normalized.result;
    void _certificate;
    return result;
}

export function computeReasonerInputDigest(request: ReasonerRequest): string {
    const normalized = normalizeReasonerRequest(request);
    return sha256CanonicalJson({
        axioms: normalized.ontology.axioms,
        sources: normalized.ontology.sources,
    });
}

export function computeInferredJustificationDigest(statement: InferredStatement): string {
    return sha256CanonicalJson({
        graph: statement.graph,
        id: statement.id,
        object: statement.object,
        predicate: statement.predicate,
        premiseIds: [...statement.provenance.premiseIds].sort(),
        rule: statement.provenance.rule,
        subject: statement.subject,
    });
}

export function computeLemmaJustificationDigest(lemma: Lemma): string {
    return sha256CanonicalJson({
        conclusion: lemma.conclusion,
        id: lemma.id,
        premiseIds: [...lemma.premiseIds].sort(),
        rule: lemma.rule,
    });
}

export function computeUnsatisfiableJustificationDigest(item: DecidedResult['unsatisfiableClasses'][number]): string {
    return sha256CanonicalJson({
        classIri: item.classIri,
        premiseIds: [...item.premiseIds].sort(),
    });
}

/**
 * The aggregate justification digest from per-statement justification digests already computed, in evidence order:
 * `computeAggregateJustificationDigest` without recomputing each statement's digest.
 */
export function aggregateJustificationDigest(
    inferred: ReadonlyArray<{ readonly id: string; readonly justificationDigest: string }>,
    unsatisfiableClasses: ReadonlyArray<{ readonly classIri: string; readonly justificationDigest: string }>,
    lemmas?: ReadonlyArray<{ readonly id: string; readonly justificationDigest: string }>,
): string {
    return sha256CanonicalJson({
        inferred: inferred.map(({ id, justificationDigest }) => ({ id, justificationDigest })),
        // Absent without lemmas, so a V1 answer's aggregate is the one proof checker v2 computed.
        ...(lemmas === undefined || lemmas.length === 0
            ? {}
            : { lemmas: lemmas.map(({ id, justificationDigest }) => ({ id, justificationDigest })) }),
        unsatisfiableClasses: unsatisfiableClasses.map(({ classIri, justificationDigest }) => ({
            classIri,
            justificationDigest,
        })),
    });
}

export function computeAggregateJustificationDigest(evidence: DecidedEvidence): string {
    return aggregateJustificationDigest(
        evidence.inferred.map((statement) => ({
            id: statement.id,
            justificationDigest: computeInferredJustificationDigest(statement),
        })),
        evidence.unsatisfiableClasses.map((item) => ({
            classIri: item.classIri,
            justificationDigest: computeUnsatisfiableJustificationDigest(item),
        })),
        evidence.lemmas?.map((lemma) => ({
            id: lemma.id,
            justificationDigest: computeLemmaJustificationDigest(lemma),
        })),
    );
}

export function computeDecidedOutputDigest(evidence: DecidedEvidence): string {
    return sha256CanonicalJson(evidence);
}

export function computeCertificateDigest(certificate: CheckedCertificate): string {
    const { certificateDigest: _certificateDigest, ...boundEvidence } = certificate;
    void _certificateDigest;
    return sha256CanonicalJson(boundEvidence);
}

/** Builds fixture or adapter evidence with every digest bound to canonical data. */
export function bindDecidedEvidence(
    request: ReasonerRequest,
    evidence: DecidedEvidence,
    checker: CertificateCheckerIdentity,
): DecidedResult {
    const normalized = normalizeEvidence(request, evidence);
    assertValidReasonerProof(request, normalized);
    const withJustifications = normalizeEvidence(request, {
        ...normalized,
        inferred: normalized.inferred.map((statement) => ({
            ...statement,
            provenance: {
                ...statement.provenance,
                justificationDigest: computeInferredJustificationDigest(statement),
            },
        })),
        unsatisfiableClasses: normalized.unsatisfiableClasses.map((item) => ({
            ...item,
            justificationDigest: computeUnsatisfiableJustificationDigest(item),
        })),
        ...(normalized.lemmas === undefined
            ? {}
            : {
                  lemmas: normalized.lemmas.map((lemma) => ({
                      ...lemma,
                      justificationDigest: computeLemmaJustificationDigest(lemma),
                  })) as unknown as typeof normalized.lemmas,
              }),
    });
    const certificateWithoutDigest = {
        decision: 'Decided' as const,
        checked: true as const,
        checkerName: checker.name,
        checkerVersion: checker.version,
        proofCheckerId: ERDEN_PROOF_CHECKER_ID,
        proofCheckerDigest: ERDEN_PROOF_CHECKER_SHA256,
        inputDigest: computeReasonerInputDigest(request),
        outputDigest: computeDecidedOutputDigest(withJustifications),
        calculusDigest: request.requiredTool.calculusDigest,
        justificationDigest: computeAggregateJustificationDigest(withJustifications),
    };
    const certificate: CheckedCertificate = {
        ...certificateWithoutDigest,
        certificateDigest: sha256CanonicalJson(certificateWithoutDigest),
    };
    return { ...withJustifications, certificate };
}
