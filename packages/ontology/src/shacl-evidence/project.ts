import { performance } from 'node:perf_hooks';

import { RDF_COMPARISON_LIMITS, RdfComparisonError } from '../comparison-rdf/model.js';
import { normalizeRdfWithinDeadline } from '../comparison-rdf/normalize.js';

import type { ShaclEvidence } from './model.js';
import { encodeShaclContexts } from './project-encoding.js';
import { SHACL_RDF_LIMITS, ShaclProjectionCapacity, type ShaclRdfProjection } from './project-model.js';
import { assertProjectionRecord, expectProjectionValue } from './project-shape.js';

/** Preserve contextual blank-node links. This projection neither authenticates nor authorizes a publication. */
export async function normalizeShaclEvidence(input: ShaclEvidence, signal?: AbortSignal): Promise<ShaclRdfProjection> {
    const started = performance.now();
    function checkDeadline(): void {
        if (signal?.aborted) {
            throw new RdfComparisonError('RDF_COMPARISON_CANCELLED');
        }
        if (performance.now() - started >= RDF_COMPARISON_LIMITS.maxMilliseconds) {
            throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
        }
    }
    checkDeadline();
    try {
        assertProjectionRecord(input);
        expectProjectionValue(input.schema, 'erden.shacl-capture/v1');
        if (input.kind === 'summary') {
            assertProjectionRecord(input, ['schema', 'kind', 'reason']);
            if (!['source-limit', 'statement-limit', 'term-limit', 'output-limit'].includes(input.reason)) {
                throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
            }
            checkDeadline();
            return Object.freeze({
                schema: 'erden.shacl-rdf/v1',
                kind: 'summary',
                stage: 'capture',
                reason: input.reason,
            });
        }
        expectProjectionValue(input.kind, 'complete');
        assertProjectionRecord(input, ['schema', 'kind', 'data', 'shapes', 'report']);
        const encoded = encodeShaclContexts(input, checkDeadline);
        const rdf = await normalizeRdfWithinDeadline(encoded.nquads, signal, started);
        checkDeadline();
        if (rdf.kind === 'summary') {
            return Object.freeze({
                schema: 'erden.shacl-rdf/v1',
                kind: 'summary',
                stage: 'normalization',
                reason: rdf.reason,
            });
        }
        const result = Object.freeze({
            schema: 'erden.shacl-rdf/v1' as const,
            kind: 'complete' as const,
            sources: encoded.sources,
            quadCounts: encoded.quadCounts,
            rdf,
        });
        const bytes = Buffer.byteLength(JSON.stringify(result));
        checkDeadline();
        return bytes > SHACL_RDF_LIMITS.maxOutputBytes
            ? Object.freeze({
                  schema: 'erden.shacl-rdf/v1',
                  kind: 'summary',
                  stage: 'projection',
                  reason: 'output-limit',
              })
            : result;
    } catch (error) {
        checkDeadline();
        if (error instanceof ShaclProjectionCapacity) {
            return error.summary;
        }
        if (error instanceof RdfComparisonError) {
            throw error;
        }
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
}
