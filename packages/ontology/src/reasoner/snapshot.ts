import { createHash } from 'node:crypto';

import { Store, type Quad } from 'n3';

import { stringifyCanonicalJson, type JsonValue } from '@erden/reasoner-protocol';

import { quadKey } from '../assembly.js';
import type {
    AssembledOntology,
    DataSourceProvenance,
    ProjectSourceOwner,
    QuadContributor,
    QuadProvenance,
} from '../model.js';
import { compareCodePoints } from '../order.js';
import { parseOntologySourceText } from '../source-formats/parse.js';

function cloneOwner(owner: ProjectSourceOwner): ProjectSourceOwner {
    return Object.freeze({
        canonicalIri: owner.canonicalIri,
        role: owner.role,
        ownedIriPrefixes: Object.freeze([...owner.ownedIriPrefixes]),
    });
}

function cloneSourceProvenance(provenance: DataSourceProvenance): DataSourceProvenance {
    return provenance._tag === 'Asserted'
        ? Object.freeze({ ...provenance })
        : Object.freeze({
              ...provenance,
              premises: Object.freeze([...provenance.premises]),
              contributingSourceIds: Object.freeze([...provenance.contributingSourceIds]),
              contributingOwners: Object.freeze(provenance.contributingOwners.map(cloneOwner)),
          });
}

function cloneContributor(contributor: QuadContributor): QuadContributor {
    return Object.freeze({
        sourceId: contributor.sourceId,
        sourceIndex: contributor.sourceIndex,
        owner: cloneOwner(contributor.owner),
        locator: contributor.locator,
        provenance: cloneSourceProvenance(contributor.provenance),
    });
}

/**
 * Captures the exact explicit graph and attribution passed to a reasoner invocation.
 * N3 stores remain mutable by design, so consumers must still verify this snapshot's
 * canonical normalization immediately before materialization.
 */
export function snapshotAssembledOntology(graph: AssembledOntology): AssembledOntology {
    return snapshotParsedAssembledOntology(
        graph,
        graph.sources.map((source) => parseOntologySourceText(source.descriptor, source.text)),
    );
}

/**
 * Internal: `snapshotAssembledOntology` from quads already parsed from each source's exact text, in source order,
 * as `validateExplicitAssembledOntology` returns them; the snapshot's dataset is built from fresh quads either way.
 */
export function snapshotParsedAssembledOntology(
    graph: AssembledOntology,
    parsed: ReadonlyArray<ReadonlyArray<Quad>>,
): AssembledOntology {
    const quads = parsed.flat();
    const dataset = new Store(quads);
    const quadByKey = new Map(dataset.getQuads(null, null, null, null).map((quad) => [quadKey(quad), quad]));
    const sources = Object.freeze(
        graph.sources.map((source) =>
            Object.freeze({
                descriptor: Object.freeze({
                    ...source.descriptor,
                    owner: cloneOwner(source.descriptor.owner),
                    provenance: cloneSourceProvenance(source.descriptor.provenance),
                }),
                sourceIndex: source.sourceIndex,
                tripleCount: source.tripleCount,
                contentDigest: source.contentDigest,
                bytes: Uint8Array.from(source.bytes),
                text: source.text,
            }),
        ),
    );
    const provenance: ReadonlyArray<QuadProvenance> = Object.freeze(
        graph.provenance
            .map((entry): QuadProvenance => {
                const quad = quadByKey.get(entry.key);
                if (quad === undefined) {
                    throw new TypeError(`Ontology provenance ${entry.key} does not identify a dataset quad`);
                }
                return Object.freeze({
                    key: entry.key,
                    quad,
                    asserted: Object.freeze(entry.asserted.map((item) => cloneContributor(item) as typeof item)),
                    inferred: Object.freeze(entry.inferred.map((item) => cloneContributor(item) as typeof item)),
                });
            })
            .sort((left, right) => compareCodePoints(left.key, right.key)),
    );
    return Object.freeze({ dataset, sources, provenance });
}

function ownerValue(owner: ProjectSourceOwner): JsonValue {
    return {
        canonicalIri: owner.canonicalIri,
        role: owner.role,
        ownedIriPrefixes: [...owner.ownedIriPrefixes],
    };
}

function provenanceValue(provenance: DataSourceProvenance): JsonValue {
    return provenance._tag === 'Asserted'
        ? {
              _tag: provenance._tag,
              ...(provenance.revision === undefined ? {} : { revision: provenance.revision }),
          }
        : {
              _tag: provenance._tag,
              reasoner: provenance.reasoner,
              operation: provenance.operation,
              statementId: provenance.statementId,
              rule: provenance.rule,
              premises: [...provenance.premises],
              justificationDigest: provenance.justificationDigest,
              contributingSourceIds: [...provenance.contributingSourceIds],
              contributingOwners: provenance.contributingOwners.map(ownerValue),
              certificateDigest: provenance.certificateDigest,
          };
}

function contributorValue(contributor: QuadContributor): JsonValue {
    return {
        sourceId: contributor.sourceId,
        sourceIndex: contributor.sourceIndex,
        owner: ownerValue(contributor.owner),
        locator: contributor.locator,
        provenance: provenanceValue(contributor.provenance),
    };
}

/** Full local RDF/provenance identity; unlike the wire digest it does not collapse RDF spellings. */
export function computeAssembledOntologySnapshotDigest(graph: AssembledOntology): string {
    const value: JsonValue = {
        quads: graph.dataset.getQuads(null, null, null, null).map(quadKey).sort(compareCodePoints),
        sources: [...graph.sources]
            .sort((left, right) => compareCodePoints(left.descriptor.id, right.descriptor.id))
            .map((source) => ({
                id: source.descriptor.id,
                owner: ownerValue(source.descriptor.owner),
                locator: source.descriptor.locator,
                baseIri: source.descriptor.baseIri,
                mediaType: source.descriptor.mediaType,
                // Present only in report mode, so refuse-mode snapshot digests are unchanged.
                ...(source.descriptor.outsideProfile === 'report' ? { outsideProfile: 'report' } : {}),
                provenance: provenanceValue(source.descriptor.provenance),
                sourceIndex: source.sourceIndex,
                tripleCount: source.tripleCount,
                contentDigest: source.contentDigest,
                bytes: Buffer.from(source.bytes).toString('base64'),
                text: source.text,
            })),
        provenance: [...graph.provenance]
            .sort((left, right) => compareCodePoints(left.key, right.key))
            .map((entry) => ({
                key: entry.key,
                quad: quadKey(entry.quad),
                asserted: entry.asserted.map(contributorValue),
                inferred: entry.inferred.map(contributorValue),
            })),
    };
    return `sha256:${createHash('sha256').update(stringifyCanonicalJson(value)).digest('hex')}`;
}
