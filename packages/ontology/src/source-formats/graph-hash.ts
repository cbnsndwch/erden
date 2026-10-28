import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { Effect } from 'effect';
import type { Quad } from 'n3';

import type { AssembledOntology } from '../model.js';
import { compareCodePoints } from '../order.js';

import { ontologyParserForMediaType, parserIdentity, type OntologyMediaType } from './formats.js';

interface Canonicalizer {
    readonly canonize: (
        input: ReadonlyArray<Quad>,
        options: { readonly algorithm: 'RDFC-1.0'; readonly maxDeepIterations: number },
    ) => Promise<string>;
}

const canonicalizer = createRequire(import.meta.url)('rdf-canonize') as unknown as Canonicalizer;

/**
 * The RDFC-1.0 work bound: at most this many runs of the Hash N-Degree Quads algorithm, counting recursive runs,
 * per source graph. It is a count, not a clock, so the CLI and the server reach the same answer on the same graph.
 *
 * It is an absolute number, not rdf-canonize's work factor: the factor allows one run per non-unique blank node,
 * and each run on a blank-node chain copies an issuer as long as the chain, so a 20,000-node chain took quadratic
 * time and exhausted the heap before the bound fired. The real upstreams need at most 34 runs (PROV-O); a graph
 * that needs more than this bound gets no hash.
 */
export const GRAPH_HASH_MAX_DEEP_ITERATIONS = 1_000;

/**
 * The SHA-256 of a graph's RDFC-1.0 canonical N-Quads: the same graph gives the same hash whatever its
 * serialization or blank-node labels, so any RDFC-1.0 tool can compare a mirror with its upstream file.
 * Undefined when canonicalization exceeds its work bound.
 */
export async function canonicalGraphHash(quads: ReadonlyArray<Quad>): Promise<string | undefined> {
    try {
        const canonical = await canonicalizer.canonize(quads, {
            algorithm: 'RDFC-1.0',
            maxDeepIterations: GRAPH_HASH_MAX_DEEP_ITERATIONS,
        });
        return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
    } catch {
        return undefined;
    }
}

export interface OntologySourceIdentity {
    readonly sourceId: string;
    readonly mediaType: OntologyMediaType;
    /** `name@version` of the pinned parser that read the source. */
    readonly parser: string;
    readonly graphHash?: string;
}

/** Identifies every loaded source by format, parser and canonical graph, from the assembled quad provenance. */
export function identifyOntologySources(
    graph: AssembledOntology,
): Effect.Effect<ReadonlyArray<OntologySourceIdentity>> {
    return Effect.promise(async () => {
        const quadsBySource = new Map<string, Quad[]>();
        for (const entry of graph.provenance) {
            for (const contributor of entry.asserted) {
                const quads = quadsBySource.get(contributor.sourceId) ?? [];
                quads.push(entry.quad);
                quadsBySource.set(contributor.sourceId, quads);
            }
        }
        const identities: OntologySourceIdentity[] = [];
        const sources = [...graph.sources].sort((left, right) =>
            compareCodePoints(left.descriptor.id, right.descriptor.id),
        );
        for (const source of sources) {
            const mediaType = source.descriptor.mediaType;
            const graphHash = await canonicalGraphHash(quadsBySource.get(source.descriptor.id) ?? []);
            identities.push(
                Object.freeze({
                    sourceId: source.descriptor.id,
                    mediaType,
                    parser: parserIdentity(ontologyParserForMediaType(mediaType)),
                    ...(graphHash === undefined ? {} : { graphHash }),
                }),
            );
        }
        return Object.freeze(identities);
    });
}
