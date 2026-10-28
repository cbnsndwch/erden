import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import {
    RDF_COMPARISON_LIMITS as LIMITS,
    RdfComparisonError,
    type RdfComparisonProjection,
    type RdfComparisonComplete,
} from './model.js';
import { decodeRdfWorkerMessage, decodeRdfWorkerResult } from './result.js';
import { rdfComparisonWorker } from './worker.js';

const require = createRequire(import.meta.url);
let activeWorkers = 0;

type Outcome = { readonly value: RdfComparisonProjection } | { readonly error: RdfComparisonError };

/** Parse bounded N-Quads without dereferencing IRIs. No caller-controlled resource limits. */
export function normalizeRdfComparison(input: string, signal?: AbortSignal): Promise<RdfComparisonProjection> {
    return normalizeRdfWithinDeadline(input, signal, performance.now());
}

/** Internal composition: encoding and worker cleanup share the original fixed deadline. */
export async function normalizeRdfWithinDeadline(
    input: string,
    signal: AbortSignal | undefined,
    started: number,
): Promise<RdfComparisonProjection> {
    return runWorker(input, signal, started, false);
}

/** Verify stored component structure and canonical RDF bytes. This does not authenticate the containing object. */
export async function validateRdfComparisonBytes(
    input: Uint8Array,
    signal?: AbortSignal,
): Promise<RdfComparisonComplete> {
    const started = performance.now();
    let encoded: string;
    try {
        if (!(input instanceof Uint8Array) || input.byteLength > LIMITS.maxOutputBytes) {
            throw new Error();
        }
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
        const value = decodeRdfWorkerResult(text);
        if (value.kind !== 'complete') {
            throw new Error();
        }
        encoded = JSON.stringify(value);
    } catch {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
    const result = await runWorker(encoded, signal, started, true);
    if (result.kind !== 'complete') {
        throw new RdfComparisonError(
            result.reason === 'canonicalization-limit' ? 'RDF_COMPARISON_UNAVAILABLE' : 'RDF_COMPARISON_INPUT_INVALID',
        );
    }
    if (JSON.stringify(result) !== encoded) {
        throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
    }
    return result;
}

async function runWorker(
    input: string,
    signal: AbortSignal | undefined,
    started: number,
    verification: boolean,
): Promise<RdfComparisonProjection> {
    if (signal?.aborted) {
        throw new RdfComparisonError('RDF_COMPARISON_CANCELLED');
    }
    if (performance.now() - started >= LIMITS.maxMilliseconds) {
        throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
    }
    if (typeof input !== 'string' || !input.isWellFormed()) {
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
    if (Buffer.byteLength(input) > LIMITS.maxInputBytes) {
        return Object.freeze({ schema: 'erden.rdf-components/v1', kind: 'summary', reason: 'input-limit' });
    }
    if (activeWorkers >= LIMITS.maxWorkers) {
        throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
    }
    let worker: Worker;
    try {
        worker = new Worker(
            `(${rdfComparisonWorker.toString()})(specifier => import(specifier)).catch(() => process.exit(1));`,
            {
                eval: true,
                execArgv: [],
                env: {},
                stdout: true,
                stderr: true,
                resourceLimits: {
                    maxOldGenerationSizeMb: LIMITS.maxOldGenerationSizeMb,
                    maxYoungGenerationSizeMb: 16,
                    stackSizeMb: 4,
                },
                workerData: {
                    input,
                    verification,
                    n3Path: require.resolve('n3'),
                    canonicalizerPath: require.resolve('rdf-canonize'),
                    limits: LIMITS,
                },
            },
        );
    } catch {
        throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
    }
    activeWorkers += 1;
    return new Promise<RdfComparisonProjection>((resolve, reject) => {
        let settled = false;
        let released = false;
        function release(): void {
            if (!released) {
                released = true;
                activeWorkers -= 1;
            }
        }
        worker.once('exit', release);
        const timer = setTimeout(deadline, Math.max(1, LIMITS.maxMilliseconds - (performance.now() - started)));
        function deadline(): void {
            const error = new RdfComparisonError(
                signal?.aborted ? 'RDF_COMPARISON_CANCELLED' : 'RDF_COMPARISON_UNAVAILABLE',
            );
            // A stalled termination must not leave the caller waiting past its deadline.
            // The concurrency slot is still held until termination or exit is confirmed.
            reject(error);
            finish({ error });
        }
        function finish(outcome: Outcome): void {
            if (settled) {
                return;
            }
            settled = true;
            signal?.removeEventListener('abort', cancelled);
            void worker.terminate().then(
                () => {
                    clearTimeout(timer);
                    release();
                    if (signal?.aborted) {
                        reject(new RdfComparisonError('RDF_COMPARISON_CANCELLED'));
                    } else if (performance.now() - started >= LIMITS.maxMilliseconds) {
                        reject(new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE'));
                    } else if ('error' in outcome) {
                        reject(outcome.error);
                    } else {
                        resolve(outcome.value);
                    }
                },
                () => {
                    clearTimeout(timer);
                    // Retain the slot until exit proves this worker has stopped.
                    reject(new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE'));
                },
            );
        }
        function unavailable(): void {
            finish({ error: new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE') });
        }
        function cancelled(): void {
            finish({ error: new RdfComparisonError('RDF_COMPARISON_CANCELLED') });
        }
        signal?.addEventListener('abort', cancelled, { once: true });
        if (signal?.aborted) {
            cancelled();
        }
        worker.once('error', unavailable);
        worker.once('exit', unavailable);
        worker.stdout.on('data', unavailable);
        worker.stderr.on('data', unavailable);
        worker.once('message', (message: unknown) => {
            try {
                finish({ value: decodeRdfWorkerMessage(message) });
            } catch (error) {
                finish({
                    error:
                        error instanceof RdfComparisonError
                            ? error
                            : new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE'),
                });
            }
        });
    });
}
