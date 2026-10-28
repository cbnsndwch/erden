import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workers: [] as FakeWorker[], failConstructor: false }));

class FakeWorker extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly terminate = vi.fn(() => {
        this.emit('exit', 1);
        return Promise.resolve(1);
    });
    constructor(
        readonly source: string,
        readonly options: Record<string, unknown>,
    ) {
        super();
        if (state.failConstructor) {
            throw new Error('private constructor diagnostic');
        }
        state.workers.push(this);
    }
}

vi.doMock('node:worker_threads', () => ({ Worker: FakeWorker }));
const { normalizeRdfComparison, validateRdfComparisonBytes } = await import('../src/comparison-rdf/normalize.js');

const empty = JSON.stringify({ schema: 'erden.rdf-components/v1', kind: 'complete', quadCount: 0, components: [] });

function latest(): FakeWorker {
    const worker = state.workers.at(-1);
    if (worker === undefined) {
        throw new Error('Missing fake worker');
    }
    return worker;
}

async function available(): Promise<void> {
    const pending = normalizeRdfComparison('');
    latest().emit('message', { kind: 'result', value: empty });
    await expect(pending).resolves.toMatchObject({ kind: 'complete', quadCount: 0 });
}

afterEach(() => {
    for (const worker of state.workers) {
        worker.emit('exit', 1);
        worker.stdout.destroy();
        worker.stderr.destroy();
    }
    state.workers.length = 0;
    state.failConstructor = false;
    vi.useRealTimers();
});

describe('RDF comparison worker lifecycle', () => {
    it('shares worker admission between normalization and persisted-component verification', async () => {
        const first = normalizeRdfComparison('');
        const firstWorker = latest();
        const second = normalizeRdfComparison('');
        const secondWorker = latest();
        await expect(validateRdfComparisonBytes(new TextEncoder().encode(empty))).rejects.toMatchObject({
            code: 'RDF_COMPARISON_UNAVAILABLE',
        });
        firstWorker.emit('message', { kind: 'result', value: empty });
        secondWorker.emit('message', { kind: 'result', value: empty });
        await Promise.all([first, second]);
        const verified = validateRdfComparisonBytes(new TextEncoder().encode(empty));
        expect(latest().options['workerData']).toMatchObject({ verification: true });
        latest().emit('message', { kind: 'result', value: empty });
        await expect(verified).resolves.toMatchObject({ kind: 'complete' });
    });

    it('treats verification work exhaustion as operational unavailability', async () => {
        const pending = validateRdfComparisonBytes(new TextEncoder().encode(empty));
        latest().emit('message', {
            kind: 'result',
            value: JSON.stringify({
                schema: 'erden.rdf-components/v1',
                kind: 'summary',
                reason: 'canonicalization-limit',
            }),
        });
        await expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        expect(latest().terminate).toHaveBeenCalledTimes(1);
    });

    it('rejects a substituted successful worker result during verification', async () => {
        const pending = validateRdfComparisonBytes(new TextEncoder().encode(empty));
        const nquads = '<urn:s> <urn:p> "different" .\n';
        latest().emit('message', {
            kind: 'result',
            value: JSON.stringify({
                schema: 'erden.rdf-components/v1',
                kind: 'complete',
                quadCount: 1,
                components: [
                    {
                        nquads,
                        sha256: createHash('sha256').update(nquads).digest('hex'),
                        multiplicity: 1,
                        quadCount: 1,
                    },
                ],
            }),
        });
        await expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
    });

    it('terminates on the watchdog deadline and releases the stopped worker slot', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = normalizeRdfComparison('');
        const rejected = expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        const worker = latest();
        await vi.advanceTimersByTimeAsync(5_001);
        await rejected;
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await available();
    });

    it('honors cancellation after a result while termination is still pending', async () => {
        const controller = new AbortController();
        const pending = normalizeRdfComparison('', controller.signal);
        const worker = latest();
        let stopped: ((code: number) => void) | undefined;
        worker.terminate.mockImplementation(
            () =>
                new Promise<number>((resolve) => {
                    stopped = resolve;
                }),
        );
        worker.emit('message', { kind: 'result', value: empty });
        controller.abort('private abort reason');
        if (stopped === undefined) {
            throw new Error('Termination was not started');
        }
        stopped(1);
        await expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_CANCELLED' });
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await available();
    });

    it.each(['error', 'exit', 'stdout', 'stderr'] as const)('redacts %s and stops exactly once', async (event) => {
        const pending = normalizeRdfComparison('');
        const worker = latest();
        if (event === 'stdout' || event === 'stderr') {
            worker[event].write('private worker diagnostic');
        } else {
            worker.emit(event, event === 'error' ? new Error('private worker diagnostic') : 1);
        }
        await expect(pending).rejects.toMatchObject({
            code: 'RDF_COMPARISON_UNAVAILABLE',
            message: 'RDF comparison normalization is temporarily unavailable',
        });
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await available();
    });

    it.each([
        null,
        { kind: 'result', value: empty, extra: 'private' },
        { kind: 'invalid', extra: 'private' },
        { kind: 'result', value: '{"schema":"erden.rdf-components/v1","kind":"summary","reason":"unknown"}' },
        {
            kind: 'result',
            value: '{"schema":"erden.rdf-components/v1","kind":"complete","quadCount":1,"components":[]}',
        },
        { kind: 'unavailable' },
        Object.create({ kind: 'invalid' }) as unknown,
    ])('rejects an invalid worker envelope without exposing its fields', async (message) => {
        const pending = normalizeRdfComparison('');
        latest().emit('message', message);
        await expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
    });

    it('does not invoke worker-envelope accessors', async () => {
        const getter = vi.fn(() => 'invalid');
        const pending = normalizeRdfComparison('');
        latest().emit('message', Object.defineProperty({}, 'kind', { enumerable: true, get: getter }));
        await expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        expect(getter).not.toHaveBeenCalled();
    });

    it('does not leak concurrency capacity after constructor failure', async () => {
        state.failConstructor = true;
        await expect(normalizeRdfComparison('')).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        state.failConstructor = false;
        await available();
        await available();
    });

    it('retains a slot after failed termination until exit proves the worker stopped', async () => {
        const first = normalizeRdfComparison('');
        const firstWorker = latest();
        firstWorker.terminate.mockRejectedValue(new Error('private termination error'));
        firstWorker.emit('message', { kind: 'result', value: empty });
        await expect(first).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        const second = normalizeRdfComparison('');
        const secondWorker = latest();
        await expect(normalizeRdfComparison('')).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        firstWorker.emit('exit', 1);
        await available();
        secondWorker.emit('message', { kind: 'result', value: empty });
        await expect(second).resolves.toMatchObject({ kind: 'complete' });
    });

    it('bounds caller waiting even when termination does not resolve', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = normalizeRdfComparison('');
        const rejected = expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        const worker = latest();
        let stopped: ((code: number) => void) | undefined;
        worker.terminate.mockImplementation(
            () =>
                new Promise<number>((resolve) => {
                    stopped = resolve;
                }),
        );
        worker.emit('message', { kind: 'result', value: empty });
        await vi.advanceTimersByTimeAsync(5_001);
        await rejected;
        const second = normalizeRdfComparison('');
        const secondWorker = latest();
        await expect(normalizeRdfComparison('')).rejects.toMatchObject({ code: 'RDF_COMPARISON_UNAVAILABLE' });
        if (stopped === undefined) {
            throw new Error('Termination was not started');
        }
        stopped(1);
        secondWorker.emit('message', { kind: 'result', value: empty });
        await expect(second).resolves.toMatchObject({ kind: 'complete' });
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await available();
    });

    it('keeps caller text in worker data and excludes inherited environment and execution flags', async () => {
        const input = "private-input'); process.stdout.write('injected'); //";
        const pending = normalizeRdfComparison(input);
        const worker = latest();
        expect(worker.source).not.toContain(input);
        expect(worker.options).toMatchObject({
            eval: true,
            execArgv: [],
            env: {},
            stdout: true,
            stderr: true,
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
            workerData: { input },
        });
        worker.emit('message', { kind: 'invalid' });
        await expect(pending).rejects.toMatchObject({ code: 'RDF_COMPARISON_INPUT_INVALID' });
    });
});
