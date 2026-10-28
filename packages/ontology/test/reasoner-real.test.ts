import { Effect } from 'effect';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';

import { encodeReasonerResponseJson } from '@erden/reasoner-protocol';

import {
    OntologyInconsistencyError,
    ReasonerProcessError,
    decideAssembledOntology,
    materializeReasonerDecision,
    quadKey,
    validateShacl,
    type ShapeSourceDescriptor,
} from '../src/index.js';

import { DEPENDENCY_OWNER, ROOT_OWNER, assembleFixtures, memoryResourcePort } from './reasoner-helpers.js';

const PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix dep: <https://example.test/dependency#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

describe('qualified bundled reasoner through the production ontology import graph', () => {
    it('verifies, materializes, attributes, and exposes dependency inference to SHACL deterministically', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                owner: ROOT_OWNER,
                text: `${PREFIXES}
ex:Child a owl:Class .
ex:alice a ex:Child ; rdfs:label "Alice" .
`,
            },
            {
                id: 'source:dependency',
                locator: 'dependency.ttl',
                owner: DEPENDENCY_OWNER,
                text: `${PREFIXES}
dep:Parent a owl:Class .
ex:Child rdfs:subClassOf dep:Parent .
`,
            },
        ]);
        const first = await Effect.runPromise(decideAssembledOntology(graph));
        const second = await Effect.runPromise(decideAssembledOntology(graph));
        expect(first.normalization.wire).toBe(second.normalization.wire);
        expect(encodeReasonerResponseJson(first.response)).toBe(encodeReasonerResponseJson(second.response));
        expect(first.response.result.consistency).toBe('consistent');
        expect(first.response.result.certificate.checked).toBe(true);

        const reasoned = materializeReasonerDecision(first);
        expect(reasoned.dataset.size).toBe(graph.dataset.size + 1);
        expect(
            reasoned.dataset.countQuads(
                DataFactory.namedNode('https://example.test/root#alice'),
                DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
                DataFactory.namedNode('https://example.test/dependency#Parent'),
                null,
            ),
        ).toBe(1);
        expect(
            reasoned.dataset.countQuads(
                DataFactory.namedNode('https://example.test/root#alice'),
                DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
                null,
                null,
            ),
        ).toBe(1);
        expect(
            first.response.result.asserted.some(
                (statement) => statement.predicate === 'http://www.w3.org/2000/01/rdf-schema#label',
            ),
        ).toBe(false);
        const labelQuad = reasoned.dataset.getQuads(
            DataFactory.namedNode('https://example.test/root#alice'),
            DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
            null,
            null,
        )[0];
        if (labelQuad === undefined) {
            throw new TypeError('Expected retained explicit annotation');
        }
        expect(reasoned.provenance.find((item) => item.key === quadKey(labelQuad))).toMatchObject({
            asserted: [expect.objectContaining({ sourceId: 'source:root' })],
            inferred: [],
        });
        expect(reasoned.reasoning.assertedStatements.length).toBeLessThan(graph.dataset.size);
        const inferredStatement = reasoned.reasoning.inferredStatements.find(
            (item) =>
                item.subject === 'https://example.test/root#alice' &&
                item.object === 'https://example.test/dependency#Parent',
        );
        expect(inferredStatement).toBeDefined();
        const inferredQuad = reasoned.dataset.getQuads(
            DataFactory.namedNode('https://example.test/root#alice'),
            DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            DataFactory.namedNode('https://example.test/dependency#Parent'),
            null,
        )[0];
        if (inferredQuad === undefined) {
            throw new TypeError('Expected materialized inference');
        }
        const provenance = reasoned.provenance.find((item) => item.key === quadKey(inferredQuad));
        expect(provenance?.asserted).toEqual([]);
        expect(provenance?.inferred.map((item) => item.sourceId)).toEqual(['source:dependency', 'source:root']);
        const inference = provenance?.inferred[0]?.provenance;
        expect(inference).toMatchObject({
            _tag: 'Inferred',
            statementId: inferredStatement?.id,
            rule: 'subclass-type',
            justificationDigest: inferredStatement?.provenance.justificationDigest,
            certificateDigest: reasoned.reasoning.certificate.certificateDigest,
            contributingSourceIds: ['source:dependency', 'source:root'],
        });
        expect(inference?.contributingOwners.map((owner) => owner.role)).toEqual(['dependency', 'root']);
        expect(inference?.premises).toEqual(inferredStatement?.provenance.premiseIds);

        const shapeText = `${PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:InferredParentShape a sh:NodeShape ;
  sh:targetClass ex:Child ;
  sh:property [ sh:path rdf:type ; sh:hasValue dep:Parent ; sh:message "parent type must be inferred" ] .
`;
        const shape: ShapeSourceDescriptor = Object.freeze({
            id: 'shape:root',
            owner: ROOT_OWNER,
            locator: 'shape.ttl',
            baseIri: ROOT_OWNER.canonicalIri,
            mediaType: 'text/turtle',
        });
        const resources = memoryResourcePort([{ id: 'shape:root', locator: 'shape.ttl', text: shapeText }]);
        const before = await Effect.runPromise(validateShacl(resources, first.graph, [shape], true));
        const after = await Effect.runPromise(validateShacl(resources, reasoned, [shape], true));
        expect(before).toMatchObject({ conforms: false, counts: { violation: 1 } });
        expect(after).toMatchObject({ conforms: true, counts: { violation: 0 } });
    });

    it('surfaces unsatisfiable named classes without treating them as global inconsistency', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES}
ex:Impossible rdfs:subClassOf ex:Person, ex:Machine .
ex:Person owl:disjointWith ex:Machine .
`,
            },
        ]);
        const reasoned = materializeReasonerDecision(await Effect.runPromise(decideAssembledOntology(graph)));
        expect(reasoned.reasoning.consistency).toBe('consistent');
        expect(reasoned.reasoning.unsatisfiableClasses).toEqual([
            expect.objectContaining({
                classIri: 'https://example.test/root#Impossible',
                contributingSourceIds: ['source:root'],
            }),
        ]);
    });

    it('derives contributing project owners transitively through inferred proof premises', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                owner: ROOT_OWNER,
                text: `${PREFIXES}
ex:B rdfs:subClassOf ex:C .
ex:alice a ex:A .
`,
            },
            {
                id: 'source:dependency',
                locator: 'dependency.ttl',
                owner: DEPENDENCY_OWNER,
                text: `${PREFIXES} ex:A rdfs:subClassOf ex:B .`,
            },
        ]);
        const reasoned = materializeReasonerDecision(await Effect.runPromise(decideAssembledOntology(graph)));
        const conclusion = reasoned.dataset.getQuads(
            DataFactory.namedNode('https://example.test/root#alice'),
            DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            DataFactory.namedNode('https://example.test/root#C'),
            null,
        )[0];
        if (conclusion === undefined) {
            throw new TypeError('Expected transitive type conclusion');
        }
        const provenance = reasoned.provenance.find((item) => item.key === quadKey(conclusion))?.inferred[0]
            ?.provenance;
        expect(provenance?.premises.some((premise) => premise.startsWith('inferred:'))).toBe(true);
        expect(provenance?.contributingSourceIds).toEqual(['source:dependency', 'source:root']);
        expect(provenance?.contributingOwners.map((owner) => owner.role)).toEqual(['dependency', 'root']);
    });

    it('blocks globally inconsistent decisions and trusted reasoner refusals', async () => {
        const inconsistent = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES}
ex:Person owl:disjointWith ex:Machine .
ex:alice a ex:Person, ex:Machine .
`,
            },
        ]);
        const decision = await Effect.runPromise(decideAssembledOntology(inconsistent));
        expect(decision.response.result.consistency).toBe('inconsistent');
        expect(() => materializeReasonerDecision(decision)).toThrow(OntologyInconsistencyError);

        const unsupported = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES}
ex:s owl:bottomObjectProperty ex:o .
`,
            },
        ]);
        const refusal = await Effect.runPromise(Effect.flip(decideAssembledOntology(unsupported)));
        expect(refusal).toBeInstanceOf(ReasonerProcessError);
        expect(refusal).toMatchObject({ code: 'REASONER_REFUSED' });

        const outside = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES}
ex:p a owl:ObjectProperty, owl:AsymmetricProperty .
`,
            },
        ]);
        const listed = await Effect.runPromise(Effect.flip(decideAssembledOntology(outside)));
        expect(listed).toMatchObject({
            code: 'OUTSIDE_PROFILE',
            details: { findings: [{ construct: 'owl:AsymmetricProperty', subject: 'https://example.test/root#p' }] },
        });
    });

    it('runs the requalified UTF-16 union-order path on the host binary', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES}
ex:p a owl:DatatypeProperty ;
  rdfs:domain [ owl:unionOf (<https://example.test/😀> <https://example.test/>) ] .
`,
            },
        ]);
        const decision = await Effect.runPromise(decideAssembledOntology(graph));
        expect(decision.response.result).toMatchObject({ outcome: 'decided', consistency: 'consistent' });
    });
});
