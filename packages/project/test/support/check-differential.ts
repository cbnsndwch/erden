// The differential comparator: a candidate check (a fused, reused or seeded path) against a from-scratch check of
// the same project. It compares what a check decides, runs the proof verifier over the candidate's evidence when it
// has some, and in strict mode requires identical report bytes. Proof checking certifies soundness only, so a
// dropped inference is the case only this comparison catches.
import { Effect, Result } from 'effect';

import { encodeCheckProjectReport, type CheckProjectError, type CheckProjectReport } from '@erden/contracts';
import {
    materializeReasonerDecision,
    OntologyInconsistencyError,
    ReasonerMaterializationError,
    type ReasonerCheckDecision,
    type ReasonerServiceShape,
    type TrustedReasonerDecision,
} from '@erden/ontology';
import { assertValidReasonerProof, type ReasonerRequest } from '@erden/reasoner-protocol';

import type { CheckProjectOptions, CheckProjectServiceShape } from '../../src/index.js';

type DecidedResult = TrustedReasonerDecision['response']['result'];

/** What one check of a project ended with, and the reasoner evidence behind it when it reached a decision. */
export type CheckRun = (
    | { readonly kind: 'report'; readonly report: CheckProjectReport }
    | { readonly kind: 'error'; readonly error: CheckProjectError }
) & {
    readonly evidence?: { readonly request: ReasonerRequest; readonly result: DecidedResult };
};

export interface CheckDifference {
    /** Which comparison failed: `outcome`, `refusal`, `consistency`, `asserted`, `inferred`, `unsatisfiable`, ... */
    readonly comparison: string;
    /** The first differing statement, JSON path or value. */
    readonly detail: string;
}

export interface CompareCheckRunsOptions {
    /** Also require identical report bytes, naming the first differing JSON path. */
    readonly strict?: boolean;
}

function triple(subject: string, predicate: string, object: unknown): string {
    return `${subject} ${predicate} ${typeof object === 'string' ? object : JSON.stringify(object)}`;
}

function setDifference(
    comparison: string,
    candidate: ReadonlyArray<string>,
    reference: ReadonlyArray<string>,
): CheckDifference | null {
    const left = new Set(candidate);
    const right = new Set(reference);
    const missing = [...right].filter((item) => !left.has(item)).sort();
    const extra = [...left].filter((item) => !right.has(item)).sort();
    if (missing.length > 0) {
        return { comparison, detail: `missing from the candidate: ${missing[0] ?? ''}` };
    }
    if (extra.length > 0) {
        return { comparison, detail: `only in the candidate: ${extra[0] ?? ''}` };
    }
    return null;
}

/** The first JSON path at which two values differ, or null when they are equal. */
export function firstJsonDifference(candidate: unknown, reference: unknown, path = '$'): string | null {
    if (Object.is(candidate, reference)) {
        return null;
    }
    if (Array.isArray(candidate) && Array.isArray(reference)) {
        const length = Math.max(candidate.length, reference.length);
        for (let index = 0; index < length; index += 1) {
            const found = firstJsonDifference(candidate[index], reference[index], `${path}[${String(index)}]`);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }
    if (
        candidate !== null &&
        reference !== null &&
        typeof candidate === 'object' &&
        typeof reference === 'object' &&
        !Array.isArray(candidate) &&
        !Array.isArray(reference)
    ) {
        const left = candidate as Readonly<Record<string, unknown>>;
        const right = reference as Readonly<Record<string, unknown>>;
        for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
            const found = firstJsonDifference(left[key], right[key], `${path}.${key}`);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }
    return path;
}

function refusalKey(error: CheckProjectError): string {
    return JSON.stringify({
        name: error.name,
        code: error.code,
        stage: error.stage,
        diagnostics: error.diagnostics.map((item) => ({ code: item.code, message: item.message })),
    });
}

function verdictOf(report: CheckProjectReport): string {
    const reasoning = report.reasoning;
    return `${reasoning.outcome} ${String(reasoning.consistency)} ${JSON.stringify(reasoning.negativeOutcome)}`;
}

function inferredOf(report: CheckProjectReport): ReadonlyArray<string> {
    return report.reasoning.inferred.map((item) => triple(item.subject, item.predicate, item.object));
}

function unsatisfiableOf(report: CheckProjectReport): ReadonlyArray<string> {
    return report.reasoning.unsatisfiableClasses.map((item) => item.classIri);
}

function diagnosticsOf(report: CheckProjectReport): ReadonlyArray<string> {
    return report.reasoning.diagnostics.map((item) => `${item.severity} ${item.code}`);
}

function stagesOf(report: CheckProjectReport): ReadonlyArray<string> {
    return Object.entries(report.stages).map(
        ([stage, value]) => `${stage} ${value.status} ${[...value.failureCodes].sort().join(',')}`,
    );
}

function assertedOf(evidence: NonNullable<CheckRun['evidence']>): ReadonlyArray<string> {
    return evidence.result.asserted.map((item) => triple(item.subject, item.predicate, item.object));
}

function compareReports(candidate: CheckProjectReport, reference: CheckProjectReport): CheckDifference | null {
    if (candidate.outcome !== reference.outcome) {
        return { comparison: 'outcome', detail: `${candidate.outcome} instead of ${reference.outcome}` };
    }
    if (verdictOf(candidate) !== verdictOf(reference)) {
        return { comparison: 'consistency', detail: `${verdictOf(candidate)} instead of ${verdictOf(reference)}` };
    }
    return (
        setDifference('inferred', inferredOf(candidate), inferredOf(reference)) ??
        setDifference('unsatisfiable', unsatisfiableOf(candidate), unsatisfiableOf(reference)) ??
        setDifference('diagnostics', diagnosticsOf(candidate), diagnosticsOf(reference)) ??
        setDifference('stages', stagesOf(candidate), stagesOf(reference))
    );
}

/**
 * Compares a candidate check with the from-scratch check of the same project; null when they agree. Both must
 * refuse with the same code and diagnostics, or both report the same outcome, verdict, inferred statements,
 * unsatisfiable classes, diagnostics and stage results; the candidate's evidence must pass the proof verifier.
 */
export function compareCheckRuns(
    candidate: CheckRun,
    reference: CheckRun,
    options: CompareCheckRunsOptions = {},
): CheckDifference | null {
    if (candidate.kind !== reference.kind) {
        return {
            comparison: 'refusal',
            detail: `the candidate ended with ${candidate.kind}, the reference with ${reference.kind}`,
        };
    }
    if (candidate.kind === 'error' && reference.kind === 'error') {
        const left = refusalKey(candidate.error);
        const right = refusalKey(reference.error);
        return left === right ? null : { comparison: 'refusal', detail: `${left} instead of ${right}` };
    }
    if (candidate.kind !== 'report' || reference.kind !== 'report') {
        return null;
    }
    const reports = compareReports(candidate.report, reference.report);
    if (reports !== null) {
        return reports;
    }
    if (candidate.evidence !== undefined && reference.evidence !== undefined) {
        const assertedDifference = setDifference(
            'asserted',
            assertedOf(candidate.evidence),
            assertedOf(reference.evidence),
        );
        if (assertedDifference !== null) {
            return assertedDifference;
        }
    }
    if (candidate.evidence !== undefined) {
        const { certificate: _certificate, ...evidence } = candidate.evidence.result;
        void _certificate;
        try {
            assertValidReasonerProof(candidate.evidence.request, evidence);
        } catch (cause) {
            return { comparison: 'proof', detail: cause instanceof Error ? cause.message : String(cause) };
        }
    }
    if (options.strict === true) {
        let left: string;
        try {
            left = encodeCheckProjectReport(candidate.report);
        } catch (cause) {
            return {
                comparison: 'report-bytes',
                detail: `the candidate report does not encode: ${cause instanceof Error ? cause.message : String(cause)}`,
            };
        }
        const right = encodeCheckProjectReport(reference.report);
        if (left !== right) {
            return {
                comparison: 'report-bytes',
                detail: firstJsonDifference(JSON.parse(left), JSON.parse(right)) ?? 'the encodings differ',
            };
        }
    }
    return null;
}

/** A reasoner service that records the evidence of every decision the check kernel asks it for, for `runCheck`. */
export function capturingReasoner(base: ReasonerServiceShape): {
    readonly reasoner: ReasonerServiceShape;
    readonly last: () => CheckRun['evidence'];
} {
    let evidence: CheckRun['evidence'];
    function record(decision: ReasonerCheckDecision): void {
        evidence = { request: decision.normalization.request, result: decision.response.result };
    }
    const reasoner: ReasonerServiceShape = {
        ...base,
        decideAndMaterialize: (graph, options) =>
            base.decideAndMaterialize(graph, options).pipe(
                Effect.tap(({ decision }) =>
                    Effect.sync(() => {
                        record(decision);
                    }),
                ),
            ),
    };
    return { reasoner, last: () => evidence };
}

function materializeSeparately(
    decision: TrustedReasonerDecision,
): Effect.Effect<ReturnType<typeof materializeReasonerDecision> | null, ReasonerMaterializationError> {
    const result = decision.response.result;
    if (result.consistency !== 'consistent' || result.diagnostics.some((item) => item.severity === 'error')) {
        return Effect.succeed(null);
    }
    return Effect.try({
        try: () => materializeReasonerDecision(decision),
        catch: (cause) =>
            cause instanceof ReasonerMaterializationError
                ? cause
                : new ReasonerMaterializationError(
                      cause instanceof OntologyInconsistencyError ? 'Inconsistent' : 'Could not materialize',
                      cause,
                  ),
    });
}

/**
 * The from-scratch reference for the fused path: `decide`, then the standalone `materializeReasonerDecision`,
 * which validates, digests, normalizes and verifies everything again before building the reasoned graph.
 */
export function separateReasoner(base: ReasonerServiceShape): ReasonerServiceShape {
    return {
        ...base,
        decideAndMaterialize: (graph, options) =>
            base.decide(graph, options).pipe(
                Effect.flatMap((decision) =>
                    materializeSeparately(decision).pipe(
                        Effect.map((reasoned) => ({
                            decision: {
                                normalization: decision.normalization,
                                artifact: decision.artifact,
                                response: decision.response,
                                stderrBytes: decision.stderrBytes,
                            },
                            reasoned,
                        })),
                    ),
                ),
            ),
    };
}

/** Runs one check and returns what it ended with; `evidence` reads the decision a capturing reasoner recorded. */
export async function runCheck(
    service: CheckProjectServiceShape,
    options: CheckProjectOptions,
    evidence?: () => CheckRun['evidence'],
): Promise<CheckRun> {
    const result = await Effect.runPromise(Effect.result(service.check(options)));
    const captured = evidence?.();
    const extra = captured === undefined ? {} : { evidence: captured };
    return Result.isSuccess(result)
        ? { kind: 'report', report: result.success, ...extra }
        : { kind: 'error', error: result.failure, ...extra };
}
