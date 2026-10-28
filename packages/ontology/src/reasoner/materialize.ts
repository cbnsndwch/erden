import { DataFactory, Store, type Quad } from 'n3';

import {
    REASONER_OPERATION,
    assertTrustedDecidedResponse,
    makeReasonerTrustExpectation,
    type InferredStatement,
    type Lemma,
} from '@erden/reasoner-protocol';

import { quadKey } from '../assembly.js';
import type {
    LoadedTurtleSource,
    ProjectSourceOwner,
    QuadContributor,
    QuadProvenance,
    ReasonedOntology,
    UnsatisfiableNamedClass,
} from '../model.js';
import { RDF } from '../model.js';
import { compareCodePoints } from '../order.js';

import { OntologyInconsistencyError, ReasonerMaterializationError } from './errors.js';
import { normalizeAssembledOntology } from './normalize.js';
import type { NormalizedReasonerInput } from './normalize.js';
import type { ReasonerArtifact, TrustedReasonerDecision } from './process.js';
import { computeAssembledOntologySnapshotDigest } from './snapshot.js';
import { assertValidExplicitAssembledOntology } from './validate.js';

function cloneOwner(owner: ProjectSourceOwner): ProjectSourceOwner {
    return Object.freeze({
        canonicalIri: owner.canonicalIri,
        role: owner.role,
        ownedIriPrefixes: Object.freeze([...owner.ownedIriPrefixes]),
    });
}

function ownerIdentityKey(owner: ProjectSourceOwner): string {
    return JSON.stringify([owner.role, owner.canonicalIri]);
}

function statementQuad(statement: InferredStatement): Quad {
    const object =
        typeof statement.object === 'string'
            ? DataFactory.namedNode(statement.object)
            : statement.object.language === null
              ? DataFactory.literal(statement.object.lexicalForm, DataFactory.namedNode(statement.object.datatype))
              : (() => {
                    if (statement.object.datatype !== `${RDF}langString`) {
                        throw new ReasonerMaterializationError(
                            'An inferred language literal has a non-rdf:langString datatype',
                        );
                    }
                    return DataFactory.literal(statement.object.lexicalForm, statement.object.language);
                })();
    return DataFactory.quad(
        DataFactory.namedNode(statement.subject),
        DataFactory.namedNode(statement.predicate),
        object,
    );
}

function freezeContributor(contributor: QuadContributor): QuadContributor {
    return Object.freeze({
        sourceId: contributor.sourceId,
        sourceIndex: contributor.sourceIndex,
        owner: cloneOwner(contributor.owner),
        locator: contributor.locator,
        provenance:
            contributor.provenance._tag === 'Asserted'
                ? Object.freeze({ ...contributor.provenance })
                : Object.freeze({
                      ...contributor.provenance,
                      premises: Object.freeze([...contributor.provenance.premises]),
                      contributingSourceIds: Object.freeze([...contributor.provenance.contributingSourceIds]),
                      contributingOwners: Object.freeze(contributor.provenance.contributingOwners.map(cloneOwner)),
                  }),
    });
}

function freezeProvenance(entry: QuadProvenance, sourceIndices: ReadonlyMap<string, number>): QuadProvenance {
    return Object.freeze({
        key: entry.key,
        quad: entry.quad,
        asserted: Object.freeze(
            [...entry.asserted]
                .sort((left, right) => compareCodePoints(left.sourceId, right.sourceId))
                .map(
                    (item) =>
                        freezeContributor({
                            ...item,
                            sourceIndex: sourceIndices.get(item.sourceId) ?? item.sourceIndex,
                        }) as typeof item,
                ),
        ),
        inferred: Object.freeze(
            [...entry.inferred]
                .sort((left, right) =>
                    compareCodePoints(
                        `${left.provenance.statementId}\u0000${left.sourceId}`,
                        `${right.provenance.statementId}\u0000${right.sourceId}`,
                    ),
                )
                .map(
                    (item) =>
                        freezeContributor({
                            ...item,
                            sourceIndex: sourceIndices.get(item.sourceId) ?? item.sourceIndex,
                        }) as typeof item,
                ),
        ),
    });
}

function freezeLoadedSource(source: LoadedTurtleSource, sourceIndex: number): LoadedTurtleSource {
    return Object.freeze({
        descriptor: Object.freeze({
            ...source.descriptor,
            owner: cloneOwner(source.descriptor.owner),
            provenance: Object.freeze({ ...source.descriptor.provenance }),
        }),
        sourceIndex,
        tripleCount: source.tripleCount,
        contentDigest: source.contentDigest,
        bytes: Uint8Array.from(source.bytes),
        text: source.text,
    });
}

function freezeAssertedStatement(statement: TrustedReasonerDecision['response']['result']['asserted'][number]) {
    return Object.freeze({
        ...statement,
        graph: Object.freeze({ ...statement.graph }),
        object: typeof statement.object === 'string' ? statement.object : Object.freeze({ ...statement.object }),
        provenance: Object.freeze({ ...statement.provenance }),
    });
}

function freezePremiseIds(premiseIds: Readonly<[string, ...string[]]>): Readonly<[string, ...string[]]> {
    return Object.freeze([premiseIds[0], ...premiseIds.slice(1)]);
}

function freezeInferredStatement(statement: InferredStatement): InferredStatement {
    return Object.freeze({
        ...statement,
        graph: Object.freeze({ ...statement.graph }),
        object: typeof statement.object === 'string' ? statement.object : Object.freeze({ ...statement.object }),
        provenance: Object.freeze({
            ...statement.provenance,
            premiseIds: freezePremiseIds(statement.provenance.premiseIds),
        }),
    });
}

function freezeLemma(lemma: Lemma): Lemma {
    // Its conclusion is a decoded, already frozen class expression tree; the lemma itself is copied.
    return Object.freeze({ ...lemma, premiseIds: Object.freeze([...lemma.premiseIds]) });
}

export function materializeReasonerDecision(decision: TrustedReasonerDecision): ReasonedOntology {
    const graph = decision.graph;
    try {
        assertValidExplicitAssembledOntology(graph);
        if (computeAssembledOntologySnapshotDigest(graph) !== decision.graphDigest) {
            throw new ReasonerMaterializationError(
                'The full assembled RDF/provenance snapshot changed after the reasoner decision',
            );
        }
        const rebound = normalizeAssembledOntology(graph, decision.artifact.requiredTool, {
            limits: decision.normalization.request.limits,
        });
        if (rebound.wire !== decision.normalization.wire) {
            throw new ReasonerMaterializationError(
                'The snapshotted assembled ontology no longer matches the verified reasoner request',
            );
        }
    } catch (cause) {
        if (cause instanceof ReasonerMaterializationError) {
            throw cause;
        }
        throw new ReasonerMaterializationError(
            'Could not bind the verified reasoner decision to its snapshotted assembled ontology',
            cause,
        );
    }
    try {
        assertTrustedDecidedResponse(
            decision.normalization.request,
            decision.response,
            makeReasonerTrustExpectation(decision.artifact.requiredTool),
        );
    } catch (cause) {
        throw new ReasonerMaterializationError('Only a fully verified decided response may be materialized', cause);
    }
    return buildReasonedOntology(graph, decision.normalization, decision.artifact, decision.response);
}

/** The parts of one decision that building its reasoned graph reads. */
type DecidedResponse = TrustedReasonerDecision['response'];

/**
 * Internal: builds the reasoned graph of a decision whose snapshot, normalized request and trusted answer its caller
 * made itself and never handed out, so none of them can have changed since. `materializeReasonerDecision` checks
 * that binding first for a decision that crossed an API boundary.
 */
export function buildReasonedOntology(
    graph: TrustedReasonerDecision['graph'],
    normalization: NormalizedReasonerInput,
    artifact: ReasonerArtifact,
    response: DecidedResponse,
): ReasonedOntology {
    const result = response.result;
    if (result.consistency === 'inconsistent') {
        throw new OntologyInconsistencyError(result.diagnostics.map((item) => item.code));
    }
    const reasonedSources = Object.freeze(
        [...graph.sources]
            .sort((left, right) => compareCodePoints(left.descriptor.id, right.descriptor.id))
            .map(freezeLoadedSource),
    );
    const canonicalSourceIndices = new Map(reasonedSources.map((item) => [item.descriptor.id, item.sourceIndex]));
    const sourceById = new Map(normalization.sourceBindings.map((item) => [item.sourceId, item]));
    const axiomSources = new Map(normalization.axiomBindings.map((item) => [item.axiomId, [item.sourceId]]));
    const assertedSources = new Map(result.asserted.map((item) => [item.id, [item.provenance.sourceId]]));
    const inferredById = new Map(result.inferred.map((item) => [item.id, item]));
    // Horn answers also cite lemmas: proof steps whose conclusion is not an RDF statement. A lemma with no premises
    // (a conjunct of its own context) contributes no source; a statement still needs at least one.
    const lemmaById = new Map((result.lemmas ?? []).map((item) => [item.id, item]));
    const sourceMemo = new Map<string, ReadonlyArray<string>>();
    const resolving = new Set<string>();
    function contributingSources(premiseId: string): ReadonlyArray<string> {
        const direct = axiomSources.get(premiseId) ?? assertedSources.get(premiseId);
        if (direct !== undefined) {
            return direct;
        }
        const memo = sourceMemo.get(premiseId);
        if (memo !== undefined) {
            return memo;
        }
        const inferred = inferredById.get(premiseId);
        const lemma = lemmaById.get(premiseId);
        const premiseIds = inferred?.provenance.premiseIds ?? lemma?.premiseIds;
        if (premiseIds === undefined || resolving.has(premiseId)) {
            throw new ReasonerMaterializationError(
                `Proof premise ${premiseId} has no deterministic source attribution`,
            );
        }
        resolving.add(premiseId);
        const derived = sortedUnique(premiseIds.flatMap(contributingSources));
        resolving.delete(premiseId);
        if (derived.length === 0 && lemma === undefined) {
            throw new ReasonerMaterializationError(`Proof premise ${premiseId} has no contributing asserted source`);
        }
        sourceMemo.set(premiseId, derived);
        return derived;
    }
    function ownersForSources(sourceIds: ReadonlyArray<string>): ReadonlyArray<ProjectSourceOwner> {
        const byKey = new Map<
            string,
            {
                canonicalIri: string;
                role: ProjectSourceOwner['role'];
                prefixes: Set<string>;
            }
        >();
        for (const sourceId of sourceIds) {
            const source = sourceById.get(sourceId);
            if (source === undefined) {
                throw new ReasonerMaterializationError(`Proof refers to unknown ontology source ${sourceId}`);
            }
            const key = ownerIdentityKey(source.owner);
            const owner = byKey.get(key) ?? {
                canonicalIri: source.owner.canonicalIri,
                role: source.owner.role,
                prefixes: new Set<string>(),
            };
            for (const prefix of source.owner.ownedIriPrefixes) {
                owner.prefixes.add(prefix);
            }
            byKey.set(key, owner);
        }
        return Object.freeze(
            [...byKey]
                .sort(([left], [right]) => compareCodePoints(left, right))
                .map(([, owner]) =>
                    Object.freeze({
                        canonicalIri: owner.canonicalIri,
                        role: owner.role,
                        ownedIriPrefixes: Object.freeze([...owner.prefixes].sort(compareCodePoints)),
                    }),
                ),
        );
    }
    const dataset = new Store(graph.dataset.getQuads(null, null, null, null));
    const explicitKeys = new Set(graph.dataset.getQuads(null, null, null, null).map(quadKey));
    const provenanceByKey = new Map(
        graph.provenance.map((entry) => [entry.key, freezeProvenance(entry, canonicalSourceIndices)]),
    );
    let materializedStatementCount = 0;
    for (const statement of result.inferred) {
        const quad = statementQuad(statement);
        const key = quadKey(quad);
        const sourceIds = sortedUnique(statement.provenance.premiseIds.flatMap(contributingSources));
        if (sourceIds.length === 0) {
            throw new ReasonerMaterializationError(
                `Inferred statement ${statement.id} has no contributing asserted source`,
            );
        }
        const owners = ownersForSources(sourceIds);
        const inferredProvenance = Object.freeze({
            _tag: 'Inferred' as const,
            reasoner: `${artifact.requiredTool.name}@${artifact.requiredTool.version}`,
            operation: REASONER_OPERATION,
            statementId: statement.id,
            rule: statement.provenance.rule,
            premises: Object.freeze([...statement.provenance.premiseIds]),
            justificationDigest: statement.provenance.justificationDigest,
            contributingSourceIds: Object.freeze(sourceIds),
            contributingOwners: owners,
            certificateDigest: result.certificate.certificateDigest,
        });
        const inferred = sourceIds.map((sourceId) => {
            const source = sourceById.get(sourceId);
            if (source === undefined) {
                throw new ReasonerMaterializationError(`Inference refers to unknown source ${sourceId}`);
            }
            return Object.freeze({
                sourceId,
                sourceIndex: source.sourceIndex,
                owner: cloneOwner(source.owner),
                locator: source.locator,
                provenance: inferredProvenance,
            });
        });
        const existing = provenanceByKey.get(key);
        if (existing === undefined) {
            dataset.addQuad(quad);
            provenanceByKey.set(
                key,
                Object.freeze({
                    key,
                    quad,
                    asserted: Object.freeze([]),
                    inferred: Object.freeze(inferred),
                }),
            );
            if (!explicitKeys.has(key)) {
                materializedStatementCount += 1;
            }
        } else {
            provenanceByKey.set(
                key,
                Object.freeze({
                    ...existing,
                    inferred: Object.freeze(
                        [...existing.inferred, ...inferred].sort((left, right) =>
                            compareCodePoints(
                                `${left.provenance.statementId}\u0000${left.sourceId}`,
                                `${right.provenance.statementId}\u0000${right.sourceId}`,
                            ),
                        ),
                    ),
                }),
            );
        }
    }
    const unsatisfiableClasses: ReadonlyArray<UnsatisfiableNamedClass> = Object.freeze(
        result.unsatisfiableClasses.map((item) => {
            const sourceIds = sortedUnique(item.premiseIds.flatMap(contributingSources));
            return Object.freeze({
                classIri: item.classIri,
                premiseIds: Object.freeze([...item.premiseIds]),
                justificationDigest: item.justificationDigest,
                contributingSourceIds: Object.freeze(sourceIds),
                contributingOwners: ownersForSources(sourceIds),
            });
        }),
    );
    const provenance = Object.freeze(
        [...provenanceByKey.values()].sort((left, right) => compareCodePoints(left.key, right.key)),
    );
    return Object.freeze({
        dataset,
        sources: reasonedSources,
        provenance,
        reasoning: Object.freeze({
            consistency: 'consistent',
            protocolVersion: response.protocolVersion,
            profileId: response.profile.id,
            profileDigest: response.profile.digest,
            tool: Object.freeze({ ...response.tool }),
            inputDigest: response.inputDigest,
            certificate: Object.freeze({ ...result.certificate }),
            diagnostics: Object.freeze(
                result.diagnostics.map((item) =>
                    Object.freeze({
                        ...item,
                        axiomIds: Object.freeze([...item.axiomIds]),
                    }),
                ),
            ),
            assertedStatements: Object.freeze(result.asserted.map(freezeAssertedStatement)),
            inferredStatements: Object.freeze(result.inferred.map(freezeInferredStatement)),
            lemmas: Object.freeze((result.lemmas ?? []).map(freezeLemma)),
            unsatisfiableClasses,
            inferredStatementCount: result.inferred.length,
            materializedStatementCount,
        }),
    });
}

function sortedUnique(values: ReadonlyArray<string>): ReadonlyArray<string> {
    return [...new Set(values)].sort(compareCodePoints);
}
