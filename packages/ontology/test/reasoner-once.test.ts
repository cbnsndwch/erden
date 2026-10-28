import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computeReasonerInputDigest } from '@erden/reasoner-protocol';

import {
    decideAndMaterializeAssembledOntology,
    decideAssembledOntology,
    makeNodeOntologyPorts,
    makeOntologyService,
    materializeReasonerDecision,
    type AssembledOntology,
    type TurtleSourceDescriptor,
} from '../src/index.js';

import { assembleFixtures, sourceDescriptor, DEPENDENCY_OWNER } from './reasoner-helpers.js';

// Count the work one decision does, through the modules every caller imports it from.
const counts = vi.hoisted(() => ({
    validate: 0,
    snapshotCopy: 0,
    snapshotDigest: 0,
    inputDigest: 0,
    outputDigest: 0,
    responseDecode: 0,
    responseEncode: 0,
    responseCanonicalCheck: 0,
    requestDecode: 0,
    answerDigests: 0,
}));

// The values every canonical write of this decision was given, to show none of them is a part of the answer.
const canonicalWrites = vi.hoisted((): unknown[] => []);

vi.mock('../src/reasoner/validate.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/reasoner/validate.ts')>();
    return {
        ...original,
        assertValidExplicitAssembledOntology: (
            ...args: Parameters<typeof original.assertValidExplicitAssembledOntology>
        ) => {
            counts.validate += 1;
            original.assertValidExplicitAssembledOntology(...args);
        },
        validateExplicitAssembledOntology: (...args: Parameters<typeof original.validateExplicitAssembledOntology>) => {
            counts.validate += 1;
            return original.validateExplicitAssembledOntology(...args);
        },
    };
});

vi.mock('../src/reasoner/snapshot.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/reasoner/snapshot.ts')>();
    return {
        ...original,
        computeAssembledOntologySnapshotDigest: (
            ...args: Parameters<typeof original.computeAssembledOntologySnapshotDigest>
        ) => {
            counts.snapshotDigest += 1;
            return original.computeAssembledOntologySnapshotDigest(...args);
        },
        snapshotParsedAssembledOntology: (...args: Parameters<typeof original.snapshotParsedAssembledOntology>) => {
            counts.snapshotCopy += 1;
            return original.snapshotParsedAssembledOntology(...args);
        },
    };
});

vi.mock('../../../reasoner/protocol/src/evidence.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../reasoner/protocol/src/evidence.ts')>();
    return {
        ...original,
        computeReasonerInputDigest: (...args: Parameters<typeof original.computeReasonerInputDigest>) => {
            counts.inputDigest += 1;
            return original.computeReasonerInputDigest(...args);
        },
        computeDecidedOutputDigest: (...args: Parameters<typeof original.computeDecidedOutputDigest>) => {
            counts.outputDigest += 1;
            return original.computeDecidedOutputDigest(...args);
        },
        computeInferredJustificationDigest: (
            ...args: Parameters<typeof original.computeInferredJustificationDigest>
        ) => {
            counts.answerDigests += 1;
            return original.computeInferredJustificationDigest(...args);
        },
        computeUnsatisfiableJustificationDigest: (
            ...args: Parameters<typeof original.computeUnsatisfiableJustificationDigest>
        ) => {
            counts.answerDigests += 1;
            return original.computeUnsatisfiableJustificationDigest(...args);
        },
        aggregateJustificationDigest: (...args: Parameters<typeof original.aggregateJustificationDigest>) => {
            counts.answerDigests += 1;
            return original.aggregateJustificationDigest(...args);
        },
        computeCertificateDigest: (...args: Parameters<typeof original.computeCertificateDigest>) => {
            counts.answerDigests += 1;
            return original.computeCertificateDigest(...args);
        },
    };
});

vi.mock('../../../reasoner/protocol/src/canonical.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../reasoner/protocol/src/canonical.ts')>();
    return {
        ...original,
        decodeReasonerResponseJson: (...args: Parameters<typeof original.decodeReasonerResponseJson>) => {
            counts.responseDecode += 1;
            return original.decodeReasonerResponseJson(...args);
        },
        encodeReasonerResponseJson: (...args: Parameters<typeof original.encodeReasonerResponseJson>) => {
            counts.responseEncode += 1;
            return original.encodeReasonerResponseJson(...args);
        },
        assertCanonicalReasonerResponseJson: (
            ...args: Parameters<typeof original.assertCanonicalReasonerResponseJson>
        ) => {
            counts.responseCanonicalCheck += 1;
            return original.assertCanonicalReasonerResponseJson(...args);
        },
        decodeReasonerRequestJson: (...args: Parameters<typeof original.decodeReasonerRequestJson>) => {
            counts.requestDecode += 1;
            return original.decodeReasonerRequestJson(...args);
        },
        stringifyCanonicalJson: (...args: Parameters<typeof original.stringifyCanonicalJson>) => {
            canonicalWrites.push(args[0]);
            return original.stringifyCanonicalJson(...args);
        },
    };
});

function decide(assembled: AssembledOntology) {
    return Effect.runPromise(decideAndMaterializeAssembledOntology(assembled));
}

const PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

const ROOT_TEXT = `${PREFIXES}
ex:Parent a owl:Class . ex:Child a owl:Class ; rdfs:subClassOf ex:Parent .
ex:alice a ex:Child .
`;

function graph() {
    return assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text: ROOT_TEXT }]);
}

/** The graph as the check kernel gets it: from the ontology service's byte-backed assembly. */
function kernelGraph(
    descriptors: ReadonlyArray<TurtleSourceDescriptor> = [sourceDescriptor({ id: 'source:root', locator: 'root.ttl' })],
): Promise<AssembledOntology> {
    return Effect.runPromise(
        makeOntologyService(makeNodeOntologyPorts()).assembleByteBacked(
            descriptors.map((descriptor) => ({ descriptor, bytes: new TextEncoder().encode(ROOT_TEXT) })),
        ),
    );
}

function reset(): void {
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
        counts[key] = 0;
    }
    canonicalWrites.length = 0;
}

/** Every object and array under `value`. */
function parts(value: unknown, found = new Set<unknown>()): Set<unknown> {
    if (value !== null && typeof value === 'object' && !found.has(value)) {
        found.add(value);
        for (const item of Object.values(value)) {
            parts(item, found);
        }
    }
    return found;
}

beforeEach(reset);

describe('one decision computes each result once', () => {
    it('decides and materializes a graph it was given with one validation, one snapshot and no snapshot digest', async () => {
        const assembled = await graph();
        reset();
        const { decision, reasoned } = await Effect.runPromise(decideAndMaterializeAssembledOntology(assembled));
        expect(reasoned?.reasoning.inferredStatementCount).toBeGreaterThan(0);
        expect(decision.response.result.consistency).toBe('consistent');
        expect(counts).toEqual({
            validate: 1,
            snapshotCopy: 1,
            snapshotDigest: 0,
            inputDigest: 0,
            outputDigest: 0,
            responseDecode: 0,
            responseEncode: 0,
            responseCanonicalCheck: 0,
            requestDecode: 0,
            answerDigests: 0,
        });
    });

    it('builds the same reasoned graph as deciding and materializing separately, which keeps every binding check', async () => {
        const assembled = await graph();
        const fused = await Effect.runPromise(decideAndMaterializeAssembledOntology(assembled));
        reset();
        const decision = await Effect.runPromise(decideAssembledOntology(assembled));
        // decide alone: one validation and the snapshot digest that binds it to a later materialization.
        expect(counts).toMatchObject({ validate: 1, snapshotCopy: 1, snapshotDigest: 1, responseDecode: 0 });
        reset();
        const separate = materializeReasonerDecision(decision);
        // materializing a decision that crossed the API boundary validates, digests and normalizes again.
        expect(counts.validate).toBeGreaterThanOrEqual(1);
        expect(counts.snapshotDigest).toBe(1);
        expect(fused.reasoned?.provenance).toEqual(separate.provenance);
        expect(fused.reasoned?.reasoning).toEqual(separate.reasoning);
        expect(fused.reasoned?.dataset.getQuads(null, null, null, null).length).toBe(separate.dataset.size);
    });

    it('takes ownership of the assembly the check kernel hands over: no second validation, parse or copy', async () => {
        const validated = await Effect.runPromise(decideAndMaterializeAssembledOntology(await graph()));
        const owned = await kernelGraph();
        reset();
        const fused = await Effect.runPromise(decideAndMaterializeAssembledOntology(owned));
        expect(counts).toMatchObject({ validate: 0, snapshotCopy: 0, snapshotDigest: 0 });
        expect(fused.decision.normalization.wire).toBe(validated.decision.normalization.wire);
        expect(fused.reasoned?.provenance).toEqual(validated.reasoned?.provenance);
        expect(fused.reasoned?.sources).toEqual(validated.reasoned?.sources);
        expect(fused.reasoned?.reasoning).toEqual(validated.reasoned?.reasoning);
        expect(fused.reasoned?.dataset.size).toBe(validated.reasoned?.dataset.size);
        // Ownership is handed over once: the same graph given again is validated and copied like any other.
        reset();
        await Effect.runPromise(decideAndMaterializeAssembledOntology(owned));
        expect(counts).toMatchObject({ validate: 1, snapshotCopy: 1 });
    });

    it('still refuses an owned assembly that is not explicit reasoner input, as validation does', async () => {
        const inferred = {
            ...sourceDescriptor({ id: 'source:root', locator: 'root.ttl' }),
            provenance: Object.freeze({
                _tag: 'Inferred' as const,
                reasoner: 'erden-reasoner@0',
                operation: 'classify-and-materialize',
                statementId: 'statement:0',
                rule: 'rule',
                premises: Object.freeze(['axiom:a']),
                justificationDigest: `sha256:${'0'.repeat(64)}`,
                contributingSourceIds: Object.freeze(['source:root']),
                contributingOwners: Object.freeze([]),
                certificateDigest: `sha256:${'0'.repeat(64)}`,
            }),
        } as unknown as TurtleSourceDescriptor;
        const noRoot = sourceDescriptor({ id: 'source:root', locator: 'root.ttl', owner: DEPENDENCY_OWNER });
        for (const descriptors of [[inferred], [noRoot]]) {
            const expected = await Effect.runPromise(
                Effect.flip(decideAndMaterializeAssembledOntology({ ...(await kernelGraph(descriptors)) })),
            );
            const actual = await Effect.runPromise(
                Effect.flip(decideAndMaterializeAssembledOntology(await kernelGraph(descriptors))),
            );
            expect(actual).toMatchObject({ code: 'INVALID_ASSEMBLED_ONTOLOGY', message: expected.message });
        }
    });

    it('serializes the request and the answer once: the digests come from the bytes written and read', async () => {
        const assembled = await kernelGraph();
        reset();
        const { decision } = await Effect.runPromise(decideAndMaterializeAssembledOntology(assembled));
        expect(counts).toMatchObject({ inputDigest: 0, outputDigest: 0, responseDecode: 0, responseEncode: 0 });
        const request = decision.normalization.request;
        expect(computeReasonerInputDigest(request)).toBe(request.ontology.digest);
        expect(decision.normalization.wire).toContain(`"digest":"${request.ontology.digest}"`);
    });

    it('reads the answer once with JSON.parse and writes no part of it with the canonical writer (E1-S5)', async () => {
        const assembled = await kernelGraph();
        const parse = vi.spyOn(JSON, 'parse');
        reset();
        let decision: Awaited<ReturnType<typeof decide>>['decision'];
        let parsed: ReadonlyArray<string>;
        try {
            ({ decision } = await decide(assembled));
        } finally {
            parsed = parse.mock.calls.map(([text]) => text);
            parse.mockRestore();
        }
        const answers = parsed.filter((text) => text.startsWith('{"inputDigest":'));
        expect(answers).toHaveLength(1);
        expect(decision.response.result.outcome).toBe('decided');
        // No justification, aggregate, certificate or output digest through the public canonical writers...
        expect(counts).toMatchObject({ answerDigests: 0, outputDigest: 0, responseDecode: 0 });
        // ...and no canonical write of the answer, of any part of it, or of an object built around its parts.
        const answer = parts(decision.response);
        expect(answer.size).toBeGreaterThan(10);
        const touching = canonicalWrites.filter(
            (value) =>
                answer.has(value) ||
                (value !== null && typeof value === 'object' && Object.values(value).some((item) => answer.has(item))),
        );
        expect(touching).toEqual([]);
        expect(canonicalWrites.length).toBeGreaterThan(0);
    });
});
