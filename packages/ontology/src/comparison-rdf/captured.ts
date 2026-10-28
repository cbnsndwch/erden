import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { DataFactory, Writer, type Quad } from 'n3';

import type { CapturedQuad } from '../shacl-evidence/model.js';
import { ShaclProjectionCapacity } from '../shacl-evidence/project-model.js';
import {
    assertProjectionArray,
    assertProjectionArrayEntries,
    assertProjectionRecord,
} from '../shacl-evidence/project-shape.js';
import { makeShaclProjectionTerms } from '../shacl-evidence/project-terms.js';

import {
    RDF_COMPARISON_LIMITS as LIMITS,
    RdfComparisonError,
    type RdfComparisonProjection,
    type RdfComparisonSummaryReason,
} from './model.js';
import { normalizeRdfWithinDeadline } from './normalize.js';

export interface CapturedRdfContext {
    /** Caller-selected stable identity, independent of parser blank labels and source ordinals. */
    readonly id: string;
    readonly quads: ReadonlyArray<CapturedQuad>;
}

const NS = 'urn:erden:rdf-context:v1:';
const MAX_CONTEXTS = 4_096;
class Capacity extends Error {
    constructor(readonly reason: RdfComparisonSummaryReason) {
        super(reason);
    }
}

/** Normalize typed RDF without interpreting parser-local blank labels as release identities. */
export function normalizeCapturedRdf(
    input: ReadonlyArray<CapturedQuad>,
    signal?: AbortSignal,
): Promise<RdfComparisonProjection> {
    return normalize(input, null, signal);
}

/** Normalize source attribution in mapped graphs; this is contextual RDF, not the original union dataset. */
export function normalizeCapturedRdfContexts(
    input: ReadonlyArray<CapturedRdfContext>,
    signal?: AbortSignal,
): Promise<RdfComparisonProjection> {
    return normalize(null, input, signal);
}

async function normalize(
    input: ReadonlyArray<CapturedQuad> | null,
    contexts: ReadonlyArray<CapturedRdfContext> | null,
    signal?: AbortSignal,
): Promise<RdfComparisonProjection> {
    const started = performance.now();
    function check(): void {
        if (signal?.aborted) {
            throw new RdfComparisonError('RDF_COMPARISON_CANCELLED');
        }
        if (performance.now() - started >= LIMITS.maxMilliseconds) {
            throw new RdfComparisonError('RDF_COMPARISON_UNAVAILABLE');
        }
    }
    check();
    try {
        const terms = makeShaclProjectionTerms();
        const writer = new Writer({ format: 'N-Quads' });
        const lines: string[] = [];
        const graphNames = new Map<string, string>();
        let bytes = 0;
        let statements = 0;
        function write(quad: Quad): void {
            const line = writer.quadsToString([quad]);
            bytes += Buffer.byteLength(line);
            if (bytes > LIMITS.maxInputBytes) {
                throw new Capacity('input-limit');
            }
            lines.push(line);
        }
        function metadata(subject: Quad['subject'], predicate: string, object: Quad['object']): void {
            write(DataFactory.quad(subject, DataFactory.namedNode(NS + predicate), object));
        }
        function quads(values: ReadonlyArray<CapturedQuad>, context: Quad['subject'] | null): void {
            assertProjectionArray(values);
            if (statements + values.length > LIMITS.maxStatements) {
                throw new Capacity('statement-limit');
            }
            assertProjectionArrayEntries(values);
            const graphs = new Map<string, Quad['subject']>();
            for (const value of values) {
                check();
                statements += 1;
                const quad = terms.quad(value);
                if (context === null) {
                    write(quad);
                    continue;
                }
                const tuple = JSON.stringify([context.value, quad.graph.termType, quad.graph.value]) + '\n';
                let graph = graphs.get(tuple);
                if (graph === undefined) {
                    if (quad.graph.termType === 'BlankNode') {
                        graph = terms.graphNode();
                    } else {
                        const name = NS + 'graph:' + createHash('sha256').update(tuple).digest('hex');
                        const previous = graphNames.get(name);
                        if (previous !== undefined && previous !== tuple) {
                            throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
                        }
                        graphNames.set(name, tuple);
                        graph = DataFactory.namedNode(name);
                    }
                    graphs.set(tuple, graph);
                    metadata(graph, 'context', context);
                    metadata(
                        graph,
                        quad.graph.termType === 'DefaultGraph' ? 'defaultGraph' : 'graph',
                        quad.graph.termType === 'DefaultGraph' ? DataFactory.literal('true') : quad.graph,
                    );
                }
                write(DataFactory.quad(quad.subject, quad.predicate, quad.object, graph));
            }
        }
        if (input !== null) {
            quads(input, null);
        } else {
            assertProjectionArray(contexts);
            if (contexts === null) {
                throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
            }
            if (contexts.length > MAX_CONTEXTS) {
                throw new Capacity('input-limit');
            }
            assertProjectionArrayEntries(contexts);
            const ids = new Set<string>();
            for (const context of contexts) {
                check();
                assertProjectionRecord(context, ['id', 'quads']);
                const id = terms.charge(context.id, 1_024);
                if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/u.test(id) || ids.has(id)) {
                    throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
                }
                ids.add(id);
                const node = DataFactory.namedNode(NS + 'context:' + encodeURIComponent(id));
                metadata(node, 'id', DataFactory.literal(id));
                quads(context.quads, node);
            }
        }
        check();
        return await normalizeRdfWithinDeadline(lines.join(''), signal, started);
    } catch (cause) {
        check();
        if (cause instanceof Capacity) {
            return Object.freeze({ schema: 'erden.rdf-components/v1', kind: 'summary', reason: cause.reason });
        }
        if (cause instanceof ShaclProjectionCapacity) {
            const reason = cause.summary.reason;
            if (reason === 'term-limit' || reason === 'input-limit' || reason === 'blank-node-limit') {
                return Object.freeze({ schema: 'erden.rdf-components/v1', kind: 'summary', reason });
            }
        }
        if (cause instanceof RdfComparisonError) {
            throw cause;
        }
        throw new RdfComparisonError('RDF_COMPARISON_INPUT_INVALID');
    }
}
