// Handing an assembled graph from the ontology service's byte-backed assembly to the reasoner's fused path. Not
// exported from the package: only `OntologyService.assembleByteBacked` offers a graph, and only
// `decideAndMaterializeAssembledOntology` takes one.
//
// Assembly decodes every source's bytes, hashes them, parses them and builds the dataset and its provenance from
// those quads. Validating such a graph before reasoning decodes, hashes and parses every source again to arrive at
// the values assembly has just computed, and snapshotting it copies a graph no one else will write. A graph taken
// here skips both; it is still checked against the rules on what may be reasoner input.
import type { AssembledOntology } from '../model.js';

interface Offer {
    readonly dataset: AssembledOntology['dataset'];
    readonly sources: AssembledOntology['sources'];
    readonly provenance: AssembledOntology['provenance'];
    readonly datasetSize: number;
    readonly sourceCount: number;
    readonly provenanceCount: number;
}

const offers = new WeakMap<AssembledOntology, Offer>();

/** Records that byte-backed assembly built `graph`, so its first holder may hand it to the fused path. */
export function offerAssembledOntology(graph: AssembledOntology): AssembledOntology {
    offers.set(
        graph,
        Object.freeze({
            dataset: graph.dataset,
            sources: graph.sources,
            provenance: graph.provenance,
            datasetSize: graph.dataset.size,
            sourceCount: graph.sources.length,
            provenanceCount: graph.provenance.length,
        }),
    );
    return graph;
}

/**
 * Takes ownership of an offered graph, once: true when byte-backed assembly built `graph` and it still holds the
 * dataset, sources and provenance assembly gave it, of the sizes assembly gave them. The holder hands the graph
 * over by passing it and writes to it no more. Any other graph, or one taken already, is validated and copied.
 */
export function takeAssembledOntology(graph: AssembledOntology): boolean {
    const offer = offers.get(graph);
    if (offer === undefined) {
        return false;
    }
    offers.delete(graph);
    return (
        graph.dataset === offer.dataset &&
        graph.sources === offer.sources &&
        graph.provenance === offer.provenance &&
        graph.dataset.size === offer.datasetSize &&
        graph.sources.length === offer.sourceCount &&
        graph.provenance.length === offer.provenanceCount
    );
}
