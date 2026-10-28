import { performance } from 'node:perf_hooks';

import type { ReasonerPhase } from '@erden/ontology';

/**
 * The phases of one check, in the order a check runs them: reading the lock, the closure and the sources; parsing
 * and identifying the union; the reasoner's own steps; closed-world validation; constructing and encoding the report.
 */
export type CheckPhase = 'load' | 'parse' | ReasonerPhase | 'validate' | 'report';

export const CHECK_PHASES: ReadonlyArray<CheckPhase> = Object.freeze([
    'load',
    'parse',
    'snapshot',
    'normalize',
    'reasoner',
    'verify',
    'materialize',
    'validate',
    'report',
]);

/**
 * The phase-timing port. `mark` charges the time since the previous mark (or since the timer was made) to the phase
 * that just ended. A check given no timer reads no clock.
 */
export interface CheckPhaseTimer {
    readonly mark: (phase: CheckPhase) => void;
}

/** The no-op adapter: a timer that records nothing. */
export const noopCheckPhaseTimer: CheckPhaseTimer = Object.freeze({
    mark: () => undefined,
});

export interface RecordingCheckPhaseTimer extends CheckPhaseTimer {
    /** Milliseconds per phase so far; a phase never marked is 0. */
    readonly phases: () => Readonly<Record<CheckPhase, number>>;
}

/** The recording adapter, on a monotonic clock. */
export function makeRecordingCheckPhaseTimer(now: () => number = () => performance.now()): RecordingCheckPhaseTimer {
    const totals = new Map<CheckPhase, number>(CHECK_PHASES.map((phase) => [phase, 0]));
    let last = now();
    return Object.freeze({
        mark: (phase: CheckPhase) => {
            const current = now();
            totals.set(phase, (totals.get(phase) ?? 0) + (current - last));
            last = current;
        },
        phases: () =>
            Object.freeze(Object.fromEntries(CHECK_PHASES.map((phase) => [phase, totals.get(phase) ?? 0]))) as Readonly<
                Record<CheckPhase, number>
            >,
    });
}
