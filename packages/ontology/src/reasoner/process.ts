import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

import { Effect, Result } from 'effect';

import {
    BundledReasonerError,
    resolveBundledReasonerArtifact,
    type QualifiedRequiredTool,
} from '@erden/reasoner-distribution';
import {
    MAX_REASONER_WIRE_BYTES,
    assertTrustedDecidedResponse,
    getReasonerEnvelopeIssues,
    makeReasonerTrustExpectation,
    openReasonerResponseJson,
    type OpenedReasonerResponse,
    type ReasonerResponse,
} from '@erden/reasoner-protocol';

import type { AssembledOntology, ReasonedOntology } from '../model.js';

import {
    ReasonerMaterializationError,
    ReasonerNormalizationError,
    ReasonerProcessError,
    TrustedNegativeReasonerOutcomeError,
} from './errors.js';
import {
    DEFAULT_REASONER_LIMITS,
    reasonerLimitSetting,
    reasonerWireCeiling,
    type ReasonerRequestLimits,
} from './limits.js';
import { buildReasonedOntology } from './materialize.js';
import {
    leftOutAfterRefusal,
    normalizeValidatedAssembledOntology,
    type NormalizedReasonerInput,
    type NormalizeReasonerOptions,
} from './normalize.js';
import { takeAssembledOntology } from './ownership.js';
import type { ProfilePartitionReason } from './partition.js';
import { computeAssembledOntologySnapshotDigest, snapshotParsedAssembledOntology } from './snapshot.js';
import { assertExplicitReasonerInput, validateExplicitAssembledOntology } from './validate.js';

/** Diagnostics are bounded and deliberately excluded from deterministic semantic results. */
export const MAX_REASONER_STDERR_BYTES = 65_536 as const;
export const REASONER_PARENT_DEADLINE_GRACE_MS = 2_000 as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ReasonerArtifact {
    readonly path: string;
    readonly requiredTool: QualifiedRequiredTool;
}

export interface ReasonerProcessRequest {
    readonly path: string;
    readonly wire: string;
    readonly timeoutMs: number;
    /** Largest answer read before the process is killed; the protocol's hard ceiling when absent. */
    readonly maxResponseBytes?: number;
}

export interface ReasonerProcessOutput {
    readonly stdout: Uint8Array;
    readonly stderrBytes: number;
    readonly exitCode: number;
}

export interface ReasonerProcessPort {
    readonly run: (request: ReasonerProcessRequest) => Effect.Effect<ReasonerProcessOutput, ReasonerProcessError>;
}

export type ReasonerSpawner = (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnOptionsWithoutStdio & { readonly stdio: readonly ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

export interface ReasonerClock {
    readonly now: () => number;
    readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface NodeReasonerProcessOptions {
    readonly spawn?: ReasonerSpawner;
    readonly clock?: ReasonerClock;
}

const systemClock: ReasonerClock = Object.freeze({
    now: () => performance.now(),
    setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer);
    },
});

function processError(
    code: ReasonerProcessError['code'],
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): ReasonerProcessError {
    return new ReasonerProcessError(code, message, details, cause);
}

function requestTooLarge(actualBytes: number, maximumBytes: number): ReasonerProcessError {
    return processError(
        'REQUEST_TOO_LARGE',
        `Canonical reasoner request is ${String(actualBytes)} bytes, over the ${String(maximumBytes)}-byte protocol ceiling`,
        { actualBytes, maximumBytes },
    );
}

/** The sources that contribute the most axioms to a request, largest first, at most three. */
export interface ReasonerRequestSourceShare {
    readonly sourceId: string;
    readonly locator: string;
    readonly axioms: number;
}

function largestSources(normalization: NormalizedReasonerInput): ReadonlyArray<ReasonerRequestSourceShare> {
    const counts = new Map<string, number>();
    for (const binding of normalization.axiomBindings) {
        counts.set(binding.sourceId, (counts.get(binding.sourceId) ?? 0) + 1);
    }
    return normalization.sourceBindings
        .map((binding) => ({
            sourceId: binding.sourceId,
            locator: binding.locator,
            sourceIndex: binding.sourceIndex,
            axioms: counts.get(binding.sourceId) ?? 0,
        }))
        .filter((share) => share.axioms > 0)
        .sort((left, right) => right.axioms - left.axioms || left.sourceIndex - right.sourceIndex)
        .slice(0, 3)
        .map(({ sourceId, locator, axioms }) => Object.freeze({ sourceId, locator, axioms }));
}

/** The ceiling for one request and its answer: the setting, held to what the bundled reasoner reads. */
interface WireCeiling {
    readonly bytes: number;
    readonly settingBytes: number;
    readonly reasonerVersion: string;
}

function wireCeiling(settingBytes: number, artifact: ReasonerArtifact): WireCeiling {
    const reasonerBytes = reasonerWireCeiling(artifact.requiredTool.version);
    return Object.freeze({
        bytes: Math.min(settingBytes, reasonerBytes, MAX_REASONER_WIRE_BYTES),
        settingBytes,
        reasonerVersion: artifact.requiredTool.version,
    });
}

function requestOverCeiling(
    normalization: NormalizedReasonerInput,
    actualBytes: number,
    ceiling: WireCeiling,
): ReasonerProcessError {
    const setting = reasonerLimitSetting('maxRequestBytes');
    const details = {
        actualBytes,
        maximumBytes: ceiling.bytes,
        variable: setting.variable,
        hardMaximumBytes: MAX_REASONER_WIRE_BYTES,
        sources: largestSources(normalization),
    };
    if (ceiling.bytes < ceiling.settingBytes) {
        return processError(
            'REQUEST_TOO_LARGE',
            `Canonical reasoner request is ${String(actualBytes)} bytes, over the ${String(ceiling.bytes)}-byte ceiling of the bundled reasoner ${ceiling.reasonerVersion}; ${setting.variable} is ${String(ceiling.settingBytes)}, but the bundled reasoner reads no more`,
            { ...details, settingBytes: ceiling.settingBytes, reasonerVersion: ceiling.reasonerVersion },
        );
    }
    return processError(
        'REQUEST_TOO_LARGE',
        `Canonical reasoner request is ${String(actualBytes)} bytes, over the ${String(ceiling.bytes)}-byte request ceiling; ${setting.variable} sets it (${String(setting.minimum)} to ${String(setting.maximum)} bytes)`,
        details,
    );
}

function responseOverCeiling(actualBytes: number, maximumBytes: number): ReasonerProcessError {
    const setting = reasonerLimitSetting('maxRequestBytes');
    return processError(
        'STDOUT_OVERFLOW',
        `Bundled reasoner answer is over the ${String(maximumBytes)}-byte ceiling for one request and its answer; ${setting.variable} sets it (${String(setting.minimum)} to ${String(setting.maximum)} bytes)`,
        { actualBytes, maximumBytes, variable: setting.variable },
    );
}

export function makeNodeReasonerProcessPort(options: NodeReasonerProcessOptions = {}): ReasonerProcessPort {
    const spawnProcess = options.spawn ?? spawn;
    const clock = options.clock ?? systemClock;
    return Object.freeze({
        run: ({ path, wire, timeoutMs, maxResponseBytes = MAX_REASONER_WIRE_BYTES }: ReasonerProcessRequest) =>
            Effect.tryPromise({
                try: (signal) =>
                    new Promise<ReasonerProcessOutput>((resolve, reject) => {
                        const stdout: Buffer[] = [];
                        let stdoutBytes = 0;
                        let stderrBytes = 0;
                        let terminalError: ReasonerProcessError | undefined;
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        let child: ChildProcessWithoutNullStreams | undefined;
                        const deadline = clock.now() + timeoutMs;
                        if (!isAbsolute(path)) {
                            reject(
                                processError(
                                    'INVALID_EXECUTABLE_PATH',
                                    'Bundled reasoner path must be the validated absolute resolver path',
                                ),
                            );
                            return;
                        }
                        const requestBytes = Buffer.byteLength(wire, 'utf8');
                        if (requestBytes > MAX_REASONER_WIRE_BYTES) {
                            reject(requestTooLarge(requestBytes, MAX_REASONER_WIRE_BYTES));
                            return;
                        }
                        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
                            reject(
                                processError(
                                    'PROCESS_TIMEOUT',
                                    'Parent process deadline must be a positive safe integer',
                                ),
                            );
                            return;
                        }
                        const cleanEnvironment = { ...process.env };
                        delete cleanEnvironment.ERDEN_REASONER_TEST_WORKER_MODE;
                        function markFailed(error: ReasonerProcessError): void {
                            if (terminalError !== undefined) {
                                return;
                            }
                            terminalError = error;
                            try {
                                child?.kill('SIGKILL');
                            } catch {
                                // A concurrently closed direct supervisor is already reaped by its close event.
                            }
                        }
                        function scheduleDeadline(): void {
                            const remaining = deadline - clock.now();
                            if (remaining <= 0) {
                                markFailed(
                                    processError(
                                        'PROCESS_TIMEOUT',
                                        `Bundled reasoner exceeded the parent process deadline of ${String(timeoutMs)} ms (the ERDEN_REASONER_MAX_WALL_TIME_MS budget plus ${String(REASONER_PARENT_DEADLINE_GRACE_MS)} ms)`,
                                        { timeoutMs },
                                    ),
                                );
                                return;
                            }
                            timer = clock.setTimer(scheduleDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
                        }
                        try {
                            child = spawnProcess(path, [], {
                                env: cleanEnvironment,
                                shell: false,
                                stdio: ['pipe', 'pipe', 'pipe'],
                                windowsHide: true,
                            });
                        } catch (cause) {
                            reject(
                                processError('PROCESS_SPAWN_FAILED', 'Could not spawn the bundled reasoner', {}, cause),
                            );
                            return;
                        }
                        const spawned = child;
                        function onStdout(chunk: Buffer | Uint8Array | string): void {
                            if (terminalError !== undefined) {
                                return;
                            }
                            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
                            stdoutBytes += bytes.byteLength;
                            if (stdoutBytes > maxResponseBytes) {
                                markFailed(
                                    processError(
                                        'STDOUT_OVERFLOW',
                                        `Bundled reasoner stdout exceeded the ${String(maxResponseBytes)}-byte ceiling for one answer`,
                                        { actualBytesAtFailure: stdoutBytes, maximumBytes: maxResponseBytes },
                                    ),
                                );
                                return;
                            }
                            stdout.push(bytes);
                        }
                        function onStderr(chunk: Buffer | Uint8Array | string): void {
                            if (terminalError !== undefined) {
                                return;
                            }
                            const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
                            stderrBytes += bytes;
                            if (stderrBytes > MAX_REASONER_STDERR_BYTES) {
                                markFailed(
                                    processError(
                                        'STDERR_OVERFLOW',
                                        'Bundled reasoner diagnostics exceeded the bounded stderr ceiling',
                                        { actualBytesAtFailure: stderrBytes, maximumBytes: MAX_REASONER_STDERR_BYTES },
                                    ),
                                );
                            }
                        }
                        function onSpawnError(cause: Error): void {
                            markFailed(
                                processError('PROCESS_SPAWN_FAILED', 'Could not spawn the bundled reasoner', {}, cause),
                            );
                        }
                        function onStdinError(cause: Error): void {
                            markFailed(
                                processError(
                                    'STDIN_FAILED',
                                    'Could not write the canonical request to the bundled reasoner',
                                    {},
                                    cause,
                                ),
                            );
                        }
                        function onStdoutError(cause: Error): void {
                            markFailed(
                                processError(
                                    'STDOUT_STREAM_FAILED',
                                    'Could not read the bundled reasoner protocol response stream',
                                    {},
                                    cause,
                                ),
                            );
                        }
                        function onStderrError(cause: Error): void {
                            markFailed(
                                processError(
                                    'STDERR_STREAM_FAILED',
                                    'Could not drain the bundled reasoner diagnostics stream',
                                    {},
                                    cause,
                                ),
                            );
                        }
                        function onAbort(): void {
                            markFailed(
                                processError('PROCESS_INTERRUPTED', 'Bundled reasoner invocation was interrupted'),
                            );
                        }
                        spawned.stdout.on('data', onStdout);
                        spawned.stderr.on('data', onStderr);
                        spawned.stdout.once('error', onStdoutError);
                        spawned.stderr.once('error', onStderrError);
                        spawned.once('error', onSpawnError);
                        spawned.stdin.once('error', onStdinError);
                        signal.addEventListener('abort', onAbort, { once: true });
                        spawned.once('close', (code) => {
                            if (timer !== undefined) {
                                clock.clearTimer(timer);
                            }
                            spawned.stdout.off('data', onStdout);
                            spawned.stderr.off('data', onStderr);
                            spawned.stdout.off('error', onStdoutError);
                            spawned.stderr.off('error', onStderrError);
                            spawned.off('error', onSpawnError);
                            spawned.stdin.off('error', onStdinError);
                            signal.removeEventListener('abort', onAbort);
                            if (terminalError !== undefined) {
                                reject(terminalError);
                                return;
                            }
                            if (code !== 0) {
                                reject(
                                    processError(
                                        'NONZERO_EXIT',
                                        'Bundled reasoner exited without a successful protocol response',
                                        { exitCode: code },
                                    ),
                                );
                                return;
                            }
                            resolve(
                                Object.freeze({
                                    stdout: Buffer.concat(stdout, stdoutBytes),
                                    stderrBytes,
                                    exitCode: code,
                                }),
                            );
                        });
                        scheduleDeadline();
                        if (signal.aborted) {
                            onAbort();
                        } else {
                            try {
                                // One end(payload) delegates backpressure buffering to Node without a second write.
                                spawned.stdin.end(Buffer.from(wire, 'utf8'));
                            } catch (cause) {
                                onStdinError(cause instanceof Error ? cause : new Error(String(cause)));
                            }
                        }
                    }),
                catch: (cause) =>
                    cause instanceof ReasonerProcessError
                        ? cause
                        : processError(
                              'PROCESS_SPAWN_FAILED',
                              'Bundled reasoner process failed unexpectedly',
                              {},
                              cause,
                          ),
            }),
    });
}

export const nodeReasonerProcessPort = makeNodeReasonerProcessPort();

export interface TrustedReasonerDecision {
    readonly graph: AssembledOntology;
    readonly graphDigest: string;
    readonly normalization: NormalizedReasonerInput;
    readonly artifact: ReasonerArtifact;
    readonly response: ReasonerResponse & {
        readonly result: Extract<ReasonerResponse['result'], { readonly outcome: 'decided' }>;
    };
    readonly stderrBytes: number;
}

/** The steps of one decision, in the order a decision runs them. */
export type ReasonerPhase = 'snapshot' | 'normalize' | 'reasoner' | 'verify' | 'materialize';

/**
 * Phase timing: `mark` charges the time since the previous mark to the phase that just ended. Absent, nothing is
 * timed and no clock is read.
 */
export interface ReasonerPhaseTimer {
    readonly mark: (phase: ReasonerPhase) => void;
}

/** Where the reasoner binary is and the identity it must answer with; the qualified bundled build when absent. */
export type ReasonerArtifactResolver = () => ReasonerArtifact;

/** The reasoner a project's toolchain names, as erden.lock records it: its version and calculus digest. */
export interface LockedReasoner {
    readonly version: string;
    readonly calculusDigest: string;
}

export interface DecideAssembledOntologyOptions extends Omit<NormalizeReasonerOptions, 'limits' | 'forced'> {
    /** The request limits, and the ceiling for the request and its answer (the default when absent). */
    readonly limits?: ReasonerRequestLimits & { readonly maxRequestBytes?: number };
    /**
     * The reasoner the caller checked the project's locks against. A decision on any other reasoner is refused
     * before the request is built, so a verdict is never given under an engine identity the lock does not name.
     */
    readonly lockedReasoner?: LockedReasoner;
    readonly process?: ReasonerProcessPort;
    readonly artifact?: ReasonerArtifactResolver;
    readonly timer?: ReasonerPhaseTimer;
}

function resolveArtifact(): ReasonerArtifact {
    try {
        const artifact = resolveBundledReasonerArtifact();
        return Object.freeze({ path: artifact.path, requiredTool: artifact.requiredTool });
    } catch (cause) {
        const details = cause instanceof BundledReasonerError ? { distributionCode: cause.code, ...cause.details } : {};
        throw processError(
            'BUNDLED_REASONER_UNAVAILABLE',
            'The qualified bundled reasoner is unavailable or failed integrity validation',
            details,
            cause,
        );
    }
}

function decodeTrustedResponse(
    normalization: NormalizedReasonerInput,
    artifact: ReasonerArtifact,
    output: ReasonerProcessOutput,
    maxResponseBytes: number,
): TrustedReasonerDecision['response'] {
    if (!(output.stdout instanceof Uint8Array)) {
        throw processError('INVALID_PROCESS_OUTPUT', 'Reasoner process port returned a non-byte stdout value');
    }
    if (
        !Number.isSafeInteger(output.stderrBytes) ||
        output.stderrBytes < 0 ||
        output.stderrBytes > MAX_REASONER_STDERR_BYTES
    ) {
        throw processError('INVALID_PROCESS_OUTPUT', 'Reasoner process port returned an invalid stderr byte count', {
            stderrBytes: output.stderrBytes,
            maximumBytes: MAX_REASONER_STDERR_BYTES,
        });
    }
    if (!Number.isSafeInteger(output.exitCode) || output.exitCode !== 0) {
        throw processError('NONZERO_EXIT', 'Reasoner process port returned a nonzero or invalid exit code', {
            exitCode: output.exitCode,
        });
    }
    if (output.stdout.byteLength > maxResponseBytes) {
        throw responseOverCeiling(output.stdout.byteLength, maxResponseBytes);
    }
    if (output.stdout.byteLength === 0) {
        throw processError('EMPTY_RESPONSE', 'Bundled reasoner returned no protocol response');
    }
    let text: string;
    if (
        output.stdout.byteLength >= 3 &&
        output.stdout[0] === 0xef &&
        output.stdout[1] === 0xbb &&
        output.stdout[2] === 0xbf
    ) {
        throw processError('INVALID_RESPONSE_UTF8', 'Bundled reasoner response must not begin with a UTF-8 BOM');
    }
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output.stdout);
    } catch (cause) {
        throw processError('INVALID_RESPONSE_UTF8', 'Bundled reasoner response is not valid UTF-8', {}, cause);
    }
    let opened: OpenedReasonerResponse;
    try {
        // One decode and one canonical write, in which the evidence is written once for its output digest.
        opened = openReasonerResponseJson(text);
    } catch (cause) {
        throw processError(
            'MALFORMED_RESPONSE',
            'Bundled reasoner response is not one strict V1 protocol response',
            {},
            cause,
        );
    }
    if (!opened.canonical) {
        throw processError(
            'NONCANONICAL_RESPONSE',
            'Bundled reasoner response is not the canonical V1 protocol encoding',
        );
    }
    const response = opened.response;
    // The request was sealed by normalization and the answer opened above, so the protocol's checks read the input
    // and output digests computed from their text, and the decided check reuses this envelope check.
    const expectation = makeReasonerTrustExpectation(artifact.requiredTool);
    const envelopeIssues = getReasonerEnvelopeIssues(normalization.request, response, expectation);
    if (envelopeIssues.length > 0) {
        throw processError(
            'UNTRUSTED_RESPONSE',
            'Bundled reasoner response envelope failed caller-owned identity and input checks',
            {},
            new TypeError(`Reasoner response envelope failed closed: ${envelopeIssues.join(', ')}`),
        );
    }
    if (response.result.outcome === 'refused') {
        throw new TrustedNegativeReasonerOutcomeError({
            outcome: 'refused',
            reason: response.result.reason,
            protocolVersion: response.protocolVersion,
            requestId: response.requestId,
            profile: response.profile,
            tool: response.tool,
            inputDigest: response.inputDigest,
            diagnostics: response.result.diagnostics,
            inputAxiomCount: normalization.request.ontology.axioms.length,
            partition: normalization.partition,
            axiomRoots: normalization.axiomRoots,
        });
    }
    if (response.result.outcome === 'incompatible') {
        throw new TrustedNegativeReasonerOutcomeError({
            outcome: 'incompatible',
            reason: response.result.reason,
            protocolVersion: response.protocolVersion,
            requestId: response.requestId,
            profile: response.profile,
            tool: response.tool,
            inputDigest: response.inputDigest,
            diagnostics: response.result.diagnostics,
            inputAxiomCount: normalization.request.ontology.axioms.length,
            partition: normalization.partition,
            axiomRoots: normalization.axiomRoots,
            expected: response.result.expected,
            actual: response.result.actual,
        });
    }
    try {
        assertTrustedDecidedResponse(normalization.request, response, expectation);
    } catch (cause) {
        throw processError(
            'UNTRUSTED_RESPONSE',
            'Bundled reasoner response failed pinned identity, provenance, digest, or proof verification',
            {},
            cause,
        );
    }
    return response as TrustedReasonerDecision['response'];
}

/** The request one decision prepared: its snapshot and its normalization. */
interface PreparedDecision {
    readonly snapshot: AssembledOntology;
    readonly artifact: ReasonerArtifact;
    readonly normalization: NormalizedReasonerInput;
}

function validationError(cause: unknown): ReasonerNormalizationError {
    return cause instanceof ReasonerNormalizationError
        ? cause
        : new ReasonerNormalizationError(
              'INVALID_ASSEMBLED_ONTOLOGY',
              'Could not validate the explicit assembled ontology before reasoning',
              {},
              cause,
          );
}

/**
 * The graph a decision reasons over. A graph handed over by byte-backed assembly is used as it is, checked only
 * against the rules on reasoner input: its digests, text, quads and provenance are assembly's own results. Any other
 * graph is validated once, which parses every source from its exact text, and snapshotted from those quads.
 */
function decisionGraph(
    graph: AssembledOntology,
    owned: boolean,
): Effect.Effect<AssembledOntology, ReasonerNormalizationError> {
    if (owned) {
        return Effect.try({
            try: () => {
                assertExplicitReasonerInput(graph);
                return graph;
            },
            catch: validationError,
        });
    }
    return Effect.gen(function* () {
        const parsed = yield* Effect.try({
            try: () => validateExplicitAssembledOntology(graph),
            catch: validationError,
        });
        return yield* Effect.try({
            try: () => snapshotParsedAssembledOntology(graph, parsed),
            catch: (cause) =>
                new ReasonerNormalizationError(
                    'INVALID_REASONER_INPUT',
                    'Could not snapshot the assembled ontology before reasoning',
                    {},
                    cause,
                ),
        });
    });
}

/** Prepares the decision's graph once and normalizes it without validating it again. */
function prepareDecision(
    graph: AssembledOntology,
    options: DecideAssembledOntologyOptions,
    owned = false,
): Effect.Effect<PreparedDecision, ReasonerNormalizationError | ReasonerProcessError> {
    return Effect.gen(function* () {
        const snapshot = yield* decisionGraph(graph, owned);
        options.timer?.mark('snapshot');
        const artifact = yield* Effect.try({
            try: options.artifact ?? resolveArtifact,
            catch: (cause) =>
                cause instanceof ReasonerProcessError
                    ? cause
                    : processError('BUNDLED_REASONER_UNAVAILABLE', 'Could not resolve the bundled reasoner', {}, cause),
        });
        const locked = options.lockedReasoner;
        if (
            locked !== undefined &&
            (artifact.requiredTool.version !== locked.version ||
                artifact.requiredTool.calculusDigest !== locked.calculusDigest)
        ) {
            return yield* Effect.fail(
                processError(
                    'REASONER_NOT_LOCKED',
                    `The reasoner ${artifact.requiredTool.version} (calculus ${artifact.requiredTool.calculusDigest}) is not the reasoner ${locked.version} (calculus ${locked.calculusDigest}) the project's toolchain was checked against`,
                    { reasoner: artifact.requiredTool, locked },
                ),
            );
        }
        // The graph was validated or is assembly's own, held by this decision alone.
        const normalization = yield* normalizeDecision(snapshot, artifact, options);
        return { snapshot, artifact, normalization };
    });
}

function normalizeDecision(
    snapshot: AssembledOntology,
    artifact: ReasonerArtifact,
    options: DecideAssembledOntologyOptions,
    forced?: ReadonlyMap<string, ProfilePartitionReason>,
): Effect.Effect<NormalizedReasonerInput, ReasonerNormalizationError> {
    return Effect.try({
        try: () => {
            const normalization = normalizeValidatedAssembledOntology(snapshot, artifact.requiredTool, {
                ...options,
                ...(forced === undefined ? {} : { forced }),
            });
            options.timer?.mark('normalize');
            return normalization;
        },
        catch: (cause) =>
            cause instanceof ReasonerNormalizationError
                ? cause
                : new ReasonerNormalizationError(
                      'INVALID_REASONER_INPUT',
                      'Could not normalize the assembled ontology for reasoning',
                      {},
                      cause,
                  ),
    });
}

/**
 * Asks the reasoner. When it refuses statements report mode lists instead (a union domain whose case split cannot
 * stay local), and they belong only to projects in report mode, they are left out as findings and the rest is asked
 * again; in refuse mode, or for any other refusal, the refusal stands. Each pass leaves out at least one more root
 * statement, so this ends.
 */
function askLeavingOut(
    first: PreparedDecision,
    options: DecideAssembledOntologyOptions,
): Effect.Effect<
    {
        readonly prepared: PreparedDecision;
        readonly response: TrustedReasonerDecision['response'];
        readonly stderrBytes: number;
    },
    ReasonerNormalizationError | ReasonerProcessError
> {
    return Effect.gen(function* () {
        let prepared = first;
        let forced: ReadonlyMap<string, ProfilePartitionReason> = new Map();
        for (;;) {
            const outcome = yield* Effect.result(askReasoner(prepared, options));
            if (Result.isSuccess(outcome)) {
                return { prepared, ...outcome.success };
            }
            const error = outcome.failure;
            const next =
                error instanceof TrustedNegativeReasonerOutcomeError && error.context.outcome === 'refused'
                    ? leftOutAfterRefusal(prepared.snapshot, prepared.normalization, error.context.diagnostics, forced)
                    : null;
            if (next === null) {
                return yield* Effect.fail(error);
            }
            forced = next;
            const normalization = yield* normalizeDecision(prepared.snapshot, prepared.artifact, options, forced);
            prepared = { ...prepared, normalization };
        }
    });
}

/** Sends the prepared request to the reasoner and verifies its answer once. */
function askReasoner(
    { artifact, normalization }: PreparedDecision,
    options: DecideAssembledOntologyOptions,
): Effect.Effect<
    { readonly response: TrustedReasonerDecision['response']; readonly stderrBytes: number },
    ReasonerProcessError
> {
    return Effect.gen(function* () {
        const requestBytes = Buffer.byteLength(normalization.wire, 'utf8');
        const ceiling = wireCeiling(
            options.limits?.maxRequestBytes ?? DEFAULT_REASONER_LIMITS.maxRequestBytes,
            artifact,
        );
        if (requestBytes > ceiling.bytes) {
            return yield* Effect.fail(requestOverCeiling(normalization, requestBytes, ceiling));
        }
        const outerTimeout = Math.min(
            Number.MAX_SAFE_INTEGER,
            normalization.request.limits.maxWallTimeMs + REASONER_PARENT_DEADLINE_GRACE_MS,
        );
        const output = yield* (options.process ?? nodeReasonerProcessPort).run({
            path: artifact.path,
            wire: normalization.wire,
            timeoutMs: outerTimeout,
            maxResponseBytes: ceiling.bytes,
        });
        options.timer?.mark('reasoner');
        const response = yield* Effect.try({
            try: () => decodeTrustedResponse(normalization, artifact, output, ceiling.bytes),
            catch: (cause) =>
                cause instanceof ReasonerProcessError
                    ? cause
                    : processError('UNTRUSTED_RESPONSE', 'Could not validate reasoner response', {}, cause),
        });
        options.timer?.mark('verify');
        return { response, stderrBytes: output.stderrBytes };
    });
}

export function decideAssembledOntology(
    graph: AssembledOntology,
    options: DecideAssembledOntologyOptions = {},
): Effect.Effect<TrustedReasonerDecision, ReasonerNormalizationError | ReasonerProcessError> {
    return Effect.gen(function* () {
        const { prepared, response, stderrBytes } = yield* askLeavingOut(
            yield* prepareDecision(graph, options),
            options,
        );
        // Binds this decision to a later, separate materialization; the fused path below needs no such binding.
        const graphDigest = computeAssembledOntologySnapshotDigest(prepared.snapshot);
        return Object.freeze({
            graph: prepared.snapshot,
            graphDigest,
            normalization: prepared.normalization,
            artifact: prepared.artifact,
            response,
            stderrBytes,
        });
    });
}

/** A decision made and materialized in one step: its request and trusted answer, for the reports. */
export type ReasonerCheckDecision = Omit<TrustedReasonerDecision, 'graph' | 'graphDigest'>;

export interface DecidedAndMaterialized {
    readonly decision: ReasonerCheckDecision;
    /** The reasoned ontology; null when the answer is inconsistent or carries an error diagnostic. */
    readonly reasoned: ReasonedOntology | null;
}

/** When a decision is materialized: whenever it is consistent, or only when it also carries no error diagnostic. */
export type MaterializeWhen = 'consistent' | 'consistent-without-errors';

/**
 * Decides and, when the answer allows it, materializes in one step. The snapshot, the normalized request and the
 * trusted answer are made here and handed to materialization before any of them is returned, so the binding checks
 * `materializeReasonerDecision` runs on a decision that crossed an API boundary (validating, digesting and
 * normalizing the snapshot again, and re-running the trust checks) would recompute values nothing could change.
 * A graph straight from the ontology service's byte-backed assembly, as the check kernel passes it, is taken over
 * instead of validated and copied (`ownership.ts`); its holder must not write to it afterwards.
 */
export function decideAndMaterializeAssembledOntology(
    graph: AssembledOntology,
    options: DecideAssembledOntologyOptions = {},
    when: MaterializeWhen = 'consistent-without-errors',
): Effect.Effect<
    DecidedAndMaterialized,
    ReasonerNormalizationError | ReasonerProcessError | ReasonerMaterializationError
> {
    return Effect.gen(function* () {
        const { prepared, response, stderrBytes } = yield* askLeavingOut(
            yield* prepareDecision(graph, options, takeAssembledOntology(graph)),
            options,
        );
        const decision: ReasonerCheckDecision = Object.freeze({
            normalization: prepared.normalization,
            artifact: prepared.artifact,
            response,
            stderrBytes,
        });
        const result = response.result;
        if (
            result.consistency !== 'consistent' ||
            (when === 'consistent-without-errors' && result.diagnostics.some((item) => item.severity === 'error'))
        ) {
            return Object.freeze({ decision, reasoned: null });
        }
        const reasoned = yield* Effect.try({
            try: () => buildReasonedOntology(prepared.snapshot, prepared.normalization, prepared.artifact, response),
            catch: (cause) =>
                cause instanceof ReasonerMaterializationError
                    ? cause
                    : new ReasonerMaterializationError('Could not materialize verified reasoner output', cause),
        });
        options.timer?.mark('materialize');
        return Object.freeze({ decision, reasoned });
    });
}
