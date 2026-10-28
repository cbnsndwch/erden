import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import type { Quad } from 'n3';

import { quadKey } from '../assembly.js';
import type { AssembledOntology, LoadedTurtleSource, ProjectSourceOwner, QuadContributor } from '../model.js';
import { compareCodePoints } from '../order.js';
import { parseOntologySourceText } from '../source-formats/parse.js';

import { ReasonerNormalizationError } from './errors.js';

function fail(message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): never {
    throw new ReasonerNormalizationError('INVALID_ASSEMBLED_ONTOLOGY', message, details, cause);
}

function ownerIdentity(owner: ProjectSourceOwner): string {
    return JSON.stringify({
        canonicalIri: owner.canonicalIri,
        role: owner.role,
        ownedIriPrefixes: [...owner.ownedIriPrefixes],
    });
}

function assertedIdentity(provenance: { readonly _tag: 'Asserted'; readonly revision?: string }): string {
    return JSON.stringify({
        _tag: provenance._tag,
        ...(provenance.revision === undefined ? {} : { revision: provenance.revision }),
    });
}

interface ValidatedSource {
    readonly loaded: LoadedTurtleSource;
    readonly quads: ReadonlyArray<Quad>;
    readonly quadKeys: ReadonlySet<string>;
}

function validateSource(source: LoadedTurtleSource, expectedIndex: number): ValidatedSource {
    if (source.sourceIndex !== expectedIndex) {
        return fail('Loaded ontology source indices must match their exact array position', {
            sourceId: source.descriptor.id,
            expectedIndex,
            actualIndex: source.sourceIndex,
        });
    }
    if (!(source.bytes instanceof Uint8Array)) {
        return fail('Loaded ontology source bytes must be an exact Uint8Array snapshot', {
            sourceId: source.descriptor.id,
        });
    }
    const digest = `sha256:${createHash('sha256').update(source.bytes).digest('hex')}`;
    if (digest !== source.contentDigest) {
        return fail('Loaded ontology source byte digest does not match its exact bytes', {
            sourceId: source.descriptor.id,
            expectedDigest: digest,
            actualDigest: source.contentDigest,
        });
    }
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(source.bytes);
    } catch (cause) {
        return fail('Loaded ontology source bytes are not valid UTF-8', { sourceId: source.descriptor.id }, cause);
    }
    if (text !== source.text) {
        return fail('Loaded ontology source text does not match its exact decoded bytes', {
            sourceId: source.descriptor.id,
        });
    }
    let parsed;
    try {
        parsed = parseOntologySourceText(source.descriptor, text);
    } catch (cause) {
        return fail(
            'Loaded ontology source cannot be reparsed from its exact bytes',
            {
                sourceId: source.descriptor.id,
            },
            cause,
        );
    }
    if (parsed.length !== source.tripleCount) {
        return fail('Loaded ontology source triple count does not match reparsed content', {
            sourceId: source.descriptor.id,
            expectedTripleCount: parsed.length,
            actualTripleCount: source.tripleCount,
        });
    }
    return Object.freeze({
        loaded: source,
        quads: parsed,
        quadKeys: new Set(parsed.map(quadKey)),
    });
}

function validateContributor(
    contributor: QuadContributor & {
        readonly provenance: {
            readonly _tag: 'Asserted';
            readonly revision?: string;
        };
    },
    entryKey: string,
    source: ValidatedSource,
): void {
    const loaded = source.loaded;
    if (
        contributor.sourceIndex !== loaded.sourceIndex ||
        contributor.locator !== loaded.descriptor.locator ||
        ownerIdentity(contributor.owner) !== ownerIdentity(loaded.descriptor.owner) ||
        assertedIdentity(contributor.provenance) !==
            assertedIdentity(
                loaded.descriptor.provenance as {
                    readonly _tag: 'Asserted';
                    readonly revision?: string;
                },
            )
    ) {
        fail('Asserted quad contributor does not exactly match its loaded source descriptor', {
            sourceId: contributor.sourceId,
            quadKey: entryKey,
        });
    }
    if (!source.quadKeys.has(entryKey)) {
        fail('Asserted quad contributor attributes a quad absent from its loaded source bytes', {
            sourceId: contributor.sourceId,
            quadKey: entryKey,
        });
    }
}

/**
 * Internal: the rules of `assertValidExplicitAssembledOntology` on what may be reasoner input, in the order it applies them,
 * without re-deriving what byte-backed assembly computed (each source's digest, text and quads, the dataset and its
 * provenance): for a graph assembly built and handed over unchanged (`ownership.ts`), these are all that can fail.
 */
export function assertExplicitReasonerInput(graph: AssembledOntology): void {
    if (graph.sources.length === 0) {
        fail('Explicit reasoner input requires at least one loaded source');
    }
    const sourceIds = new Set<string>();
    const rootOwnerIris = new Set<string>();
    graph.sources.forEach((source, index) => {
        const id = source.descriptor.id;
        if (sourceIds.has(id)) {
            fail('Loaded ontology source IDs must be unique', { sourceId: id });
        }
        if (source.descriptor.provenance._tag !== 'Asserted') {
            fail('Reasoner input sources must be explicit rather than inferred', { sourceId: id });
        }
        const owner = source.descriptor.owner;
        if (owner.role === 'root') {
            rootOwnerIris.add(owner.canonicalIri);
        }
        if (source.sourceIndex !== index) {
            fail('Loaded ontology source indices must match their exact array position', {
                sourceId: id,
                expectedIndex: index,
                actualIndex: source.sourceIndex,
            });
        }
        sourceIds.add(id);
    });
    if (rootOwnerIris.size !== 1) {
        fail('Explicit reasoner input must contain exactly one distinct root project owner', {
            rootOwnerIris: [...rootOwnerIris].sort(compareCodePoints),
        });
    }
}

/** Validates the exported structural graph model before it crosses the reasoner trust boundary. */
export function assertValidExplicitAssembledOntology(graph: AssembledOntology): void {
    validateExplicitAssembledOntology(graph);
}

/**
 * Internal: `assertValidExplicitAssembledOntology`, returning the quads it parsed from each source's exact text, in
 * source order, so a snapshot of the same graph need not parse every source again.
 */
export function validateExplicitAssembledOntology(graph: AssembledOntology): ReadonlyArray<ReadonlyArray<Quad>> {
    if (graph.sources.length === 0) {
        fail('Explicit reasoner input requires at least one loaded source');
    }
    const sourceById = new Map<string, ValidatedSource>();
    const rootOwnerIris = new Set<string>();
    graph.sources.forEach((source, index) => {
        const id = source.descriptor.id;
        if (sourceById.has(id)) {
            fail('Loaded ontology source IDs must be unique', { sourceId: id });
        }
        if (source.descriptor.provenance._tag !== 'Asserted') {
            fail('Reasoner input sources must be explicit rather than inferred', { sourceId: id });
        }
        const owner = source.descriptor.owner;
        if (owner.role === 'root') {
            rootOwnerIris.add(owner.canonicalIri);
        }
        sourceById.set(id, validateSource(source, index));
    });
    if (rootOwnerIris.size !== 1) {
        fail('Explicit reasoner input must contain exactly one distinct root project owner', {
            rootOwnerIris: [...rootOwnerIris].sort(compareCodePoints),
        });
    }
    const datasetKeys = graph.dataset.getQuads(null, null, null, null).map(quadKey);
    const datasetKeySet = new Set(datasetKeys);
    if (datasetKeySet.size !== datasetKeys.length) {
        fail('Assembled ontology dataset contains duplicate quad identities');
    }
    const expectedDatasetKeys = new Set<string>();
    for (const source of sourceById.values()) {
        for (const key of source.quadKeys) {
            expectedDatasetKeys.add(key);
        }
    }
    const missingDataset = [...expectedDatasetKeys].filter((key) => !datasetKeySet.has(key)).sort(compareCodePoints);
    const extraDataset = [...datasetKeySet].filter((key) => !expectedDatasetKeys.has(key)).sort(compareCodePoints);
    if (missingDataset.length > 0 || extraDataset.length > 0) {
        fail('Assembled ontology dataset is not the exact union of its loaded source bytes', {
            missingDataset,
            extraDataset,
        });
    }
    const provenanceByKey = new Map<string, (typeof graph.provenance)[number]>();
    for (const entry of graph.provenance) {
        if (entry.key !== quadKey(entry.quad)) {
            fail('Quad provenance key does not match its attached quad', { entryKey: entry.key });
        }
        if (!datasetKeySet.has(entry.key)) {
            fail('Quad provenance entry has no corresponding dataset quad', { entryKey: entry.key });
        }
        if (provenanceByKey.has(entry.key)) {
            fail('Quad provenance keys must be unique', { entryKey: entry.key });
        }
        if (entry.asserted.length === 0 || entry.inferred.length !== 0) {
            fail(
                'Explicit reasoner input provenance requires asserted contributors and forbids inferred contributors',
                {
                    entryKey: entry.key,
                    assertedCount: entry.asserted.length,
                    inferredCount: entry.inferred.length,
                },
            );
        }
        const contributorIds = new Set<string>();
        for (const contributor of entry.asserted) {
            if (contributorIds.has(contributor.sourceId)) {
                fail('Asserted quad contributors must be unique by loaded source', {
                    entryKey: entry.key,
                    sourceId: contributor.sourceId,
                });
            }
            contributorIds.add(contributor.sourceId);
            const source =
                sourceById.get(contributor.sourceId) ??
                fail('Asserted quad contributor refers to an unknown loaded source', {
                    entryKey: entry.key,
                    sourceId: contributor.sourceId,
                });
            validateContributor(contributor, entry.key, source);
        }
        provenanceByKey.set(entry.key, entry);
    }
    if (provenanceByKey.size !== datasetKeySet.size) {
        fail('Dataset quads and provenance entries must form an exact bijection', {
            datasetQuadCount: datasetKeySet.size,
            provenanceEntryCount: provenanceByKey.size,
        });
    }
    for (const key of datasetKeySet) {
        if (!provenanceByKey.has(key)) {
            fail('Dataset quad is missing provenance', { quadKey: key });
        }
    }
    for (const [sourceId, source] of sourceById) {
        for (const key of source.quadKeys) {
            if (!provenanceByKey.get(key)?.asserted.some((item) => item.sourceId === sourceId)) {
                fail('Loaded source quad is missing its exact asserted contribution', { sourceId, quadKey: key });
            }
        }
    }
    return graph.sources.map((source) => sourceById.get(source.descriptor.id)?.quads ?? []);
}
