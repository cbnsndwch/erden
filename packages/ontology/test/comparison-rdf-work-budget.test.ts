import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { RDF_COMPARISON_LIMITS, type RdfComparisonProjection } from '../src/comparison-rdf/model.js';
import { decodeRdfWorkerMessage } from '../src/comparison-rdf/result.js';
import { rdfComparisonWorker } from '../src/comparison-rdf/worker.js';

const require = createRequire(import.meta.url);

/** Inject small work budgets into the internal worker; public callers cannot set budgets. */
async function project(
    input: string,
    limits: Partial<Record<keyof typeof RDF_COMPARISON_LIMITS, number>>,
    verification = false,
): Promise<RdfComparisonProjection> {
    let message: unknown;
    async function load(specifier: string): Promise<unknown> {
        if (specifier === 'node:worker_threads') {
            return {
                parentPort: {
                    postMessage(value: unknown) {
                        message = value;
                    },
                },
                workerData: {
                    input,
                    verification,
                    n3Path: require.resolve('n3'),
                    canonicalizerPath: require.resolve('rdf-canonize'),
                    limits: { ...RDF_COMPARISON_LIMITS, ...limits },
                },
            };
        }
        return import(specifier);
    }
    await rdfComparisonWorker(load);
    return decodeRdfWorkerMessage(message);
}

describe('aggregate RDF canonicalization work', () => {
    it('shares verification hash budgets across stored components without expanding multiplicities', async () => {
        const value = await project('_:a <urn:p> "one" .\n_:b <urn:p> "two" .\n', {});
        expect(value.kind).toBe('complete');
        expect(await project(JSON.stringify(value), { maxHashOperations: 1 }, true)).toMatchObject({
            kind: 'summary',
            reason: 'canonicalization-limit',
        });
        expect(await project(JSON.stringify(value), { maxHashOperations: 2 }, true)).toEqual(value);
    });
    it('shares the hash-operation budget across disconnected components', async () => {
        expect(await project('_:a <urn:p> "one" .\n', { maxHashOperations: 1 })).toMatchObject({ kind: 'complete' });
        expect(await project('_:a <urn:p> "one" .\n_:b <urn:p> "one" .\n', { maxHashOperations: 1 })).toEqual({
            schema: 'erden.rdf-components/v1',
            kind: 'summary',
            reason: 'canonicalization-limit',
        });
    });

    it('shares hashed-byte capacity across disconnected components', async () => {
        const input = '_:a <urn:p> "one" .\n';
        const maxHashBytes = Buffer.byteLength(input);
        expect(await project(input, { maxHashBytes })).toMatchObject({ kind: 'complete' });
        expect(await project(input + '_:b <urn:p> "one" .\n', { maxHashBytes })).toEqual({
            schema: 'erden.rdf-components/v1',
            kind: 'summary',
            reason: 'canonicalization-limit',
        });
    });
});
