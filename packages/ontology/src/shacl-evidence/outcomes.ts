import { performance } from 'node:perf_hooks';

import { RDF_COMPARISON_LIMITS, RdfComparisonError, type RdfComparisonComplete } from '../comparison-rdf/model.js';
import { normalizeRdfWithinDeadline } from '../comparison-rdf/normalize.js';

import type { ShaclEvidence, ShaclSelfTestEvidence } from './model.js';
import { selectShaclOutcomeContext } from './outcome-context.js';
import { encodeShaclContexts } from './project-encoding.js';
import { SHACL_RDF_LIMITS, ShaclProjectionCapacity, type ShaclRdfSummary } from './project-model.js';
import { assertProjectionRecord, expectProjectionValue } from './project-shape.js';

const SCHEMA = 'erden.shacl-outcomes/v1' as const;
export type ShaclOutcomeProjection =
    | Readonly<{ schema: typeof SCHEMA; kind: 'complete'; selfTestCount: number; rdf: RdfComparisonComplete }>
    | (Readonly<{ schema: typeof SCHEMA }> & Omit<ShaclRdfSummary, 'schema'>)
    | Readonly<{
          schema: typeof SCHEMA;
          kind: 'summary';
          stage: 'self-tests';
          reason: 'source-limit' | 'term-limit' | 'output-limit';
      }>;

/** Reports and typed self-tests with their identifying blank-node context; unrelated data/definitions are excluded. */
export async function normalizeShaclOutcomes(
    input: ShaclEvidence,
    selfTests: ShaclSelfTestEvidence,
    signal?: AbortSignal,
): Promise<ShaclOutcomeProjection> {
    const started = performance.now();
    function check(): void {
        if (signal?.aborted) {
            throw new RdfComparisonError('RDF_COMPARISON_CANCELLED');
        }
        if (performance.now() - started >= RDF_COMPARISON_LIMITS.maxMilliseconds) {
            throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
        }
    }
    check();
    try {
        assertProjectionRecord(input);
        assertProjectionRecord(selfTests);
        expectProjectionValue(input.schema, 'erden.shacl-capture/v1');
        expectProjectionValue(selfTests.schema, 'erden.shacl-self-tests/v1');
        if (input.kind === 'summary') {
            assertProjectionRecord(input, ['schema', 'kind', 'reason']);
            if (!['source-limit', 'statement-limit', 'term-limit', 'output-limit'].includes(input.reason)) {
                throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
            }
            return Object.freeze({ schema: SCHEMA, kind: 'summary', stage: 'capture', reason: input.reason });
        }
        if (selfTests.kind === 'summary') {
            assertProjectionRecord(selfTests, ['schema', 'kind', 'reason']);
            if (!['source-limit', 'term-limit', 'output-limit'].includes(selfTests.reason)) {
                throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
            }
            return Object.freeze({ schema: SCHEMA, kind: 'summary', stage: 'self-tests', reason: selfTests.reason });
        }
        expectProjectionValue(input.kind, 'complete');
        expectProjectionValue(selfTests.kind, 'complete');
        const selected = selectShaclOutcomeContext(input, selfTests, check);
        const encoded = encodeShaclContexts(selected, check, selfTests, true);
        const selfTestCount = selfTests.results.length;
        const rdf = await normalizeRdfWithinDeadline(encoded.nquads, signal, started);
        check();
        if (rdf.kind === 'summary') {
            return Object.freeze({ schema: SCHEMA, kind: 'summary', stage: 'normalization', reason: rdf.reason });
        }
        const result = Object.freeze({ schema: SCHEMA, kind: 'complete' as const, selfTestCount, rdf });
        if (Buffer.byteLength(JSON.stringify(result)) > SHACL_RDF_LIMITS.maxOutputBytes) {
            return Object.freeze({ schema: SCHEMA, kind: 'summary', stage: 'projection', reason: 'output-limit' });
        }
        check();
        return result;
    } catch (cause) {
        check();
        if (cause instanceof ShaclProjectionCapacity) {
            return Object.freeze({ ...cause.summary, schema: SCHEMA });
        }
        if (cause instanceof RdfComparisonError) {
            throw cause;
        }
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
}
