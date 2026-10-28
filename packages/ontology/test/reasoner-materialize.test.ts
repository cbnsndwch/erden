import { Effect } from 'effect';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';

import { encodeReasonerResponseJson, type DecidedEvidence } from '@erden/reasoner-protocol';

import { decideAssembledOntology, materializeReasonerDecision, quadKey } from '../src/index.js';

import { assembleFixtures, decidedResponseFor, dynamicResponsePort } from './reasoner-helpers.js';

const PREFIXES = `
@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

describe('verified inference materialization boundaries', () => {
    it('retains verified inferred provenance when the entailed conclusion is already explicit', async () => {
        const graph = await assembleFixtures([
            {
                id: 'source:root',
                locator: 'root.ttl',
                text: `${PREFIXES}
ex:Child rdfs:subClassOf ex:Parent .
ex:alice a ex:Child, ex:Parent .
`,
            },
        ]);
        const process = dynamicResponsePort((_empty, request) => {
            const subclass = request.ontology.axioms.find((axiom) => axiom.kind === 'SubClassOf');
            const child = request.ontology.axioms.find(
                (axiom) =>
                    axiom.kind === 'ClassAssertion' &&
                    axiom.classExpression.kind === 'NamedClass' &&
                    axiom.classExpression.iri === 'https://example.test/root#Child',
            );
            if (subclass === undefined || child === undefined) {
                throw new TypeError('Expected proof premises');
            }
            const evidence: DecidedEvidence = {
                outcome: 'decided',
                completeness: 'complete',
                consistency: 'consistent',
                asserted: [],
                inferred: [
                    {
                        id: 'inferred:explicit-conclusion',
                        subject: 'https://example.test/root#alice',
                        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
                        object: 'https://example.test/root#Parent',
                        graph: { kind: 'DefaultGraph' },
                        provenance: {
                            kind: 'inferred',
                            rule: 'subclass-type',
                            premiseIds: [child.id, subclass.id],
                            justificationDigest: `sha256:${'0'.repeat(64)}`,
                        },
                    },
                ],
                unsatisfiableClasses: [],
                diagnostics: [],
            };
            return encodeReasonerResponseJson(decidedResponseFor(request, evidence));
        });
        const reasoned = materializeReasonerDecision(
            await Effect.runPromise(decideAssembledOntology(graph, { process })),
        );
        expect(reasoned.reasoning.inferredStatementCount).toBe(1);
        expect(reasoned.reasoning.materializedStatementCount).toBe(0);
        const quad = reasoned.dataset.getQuads(
            DataFactory.namedNode('https://example.test/root#alice'),
            DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            DataFactory.namedNode('https://example.test/root#Parent'),
            null,
        )[0];
        if (quad === undefined) {
            throw new TypeError('Expected explicit conclusion');
        }
        const provenance = reasoned.provenance.find((item) => item.key === quadKey(quad));
        expect(provenance?.asserted).toHaveLength(1);
        expect(provenance?.inferred).toHaveLength(1);
        expect(provenance?.inferred[0]?.provenance.statementId).toBe('inferred:explicit-conclusion');
    });

    it('deduplicates project owners by role and canonical IRI while merging sorted unique prefixes', async () => {
        const firstOwner = {
            canonicalIri: 'https://example.test/project',
            role: 'root' as const,
            ownedIriPrefixes: ['https://example.test/project#z'],
        };
        const secondOwner = {
            canonicalIri: 'https://example.test/project',
            role: 'root' as const,
            ownedIriPrefixes: ['https://example.test/project#a', 'https://example.test/project#z'],
        };
        const graph = await assembleFixtures([
            {
                id: 'source:classes',
                locator: 'classes.ttl',
                owner: firstOwner,
                text: `${PREFIXES} ex:Child rdfs:subClassOf ex:Parent .`,
            },
            {
                id: 'source:data',
                locator: 'data.ttl',
                owner: secondOwner,
                text: `${PREFIXES} ex:alice a ex:Child .`,
            },
        ]);
        const reasoned = materializeReasonerDecision(await Effect.runPromise(decideAssembledOntology(graph)));
        const quad = reasoned.dataset.getQuads(
            DataFactory.namedNode('https://example.test/root#alice'),
            DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            DataFactory.namedNode('https://example.test/root#Parent'),
            null,
        )[0];
        if (quad === undefined) {
            throw new TypeError('Expected inferred conclusion');
        }
        const provenance = reasoned.provenance.find((item) => item.key === quadKey(quad));
        expect(provenance?.inferred[0]?.provenance.contributingOwners).toEqual([
            {
                canonicalIri: 'https://example.test/project',
                role: 'root',
                ownedIriPrefixes: ['https://example.test/project#a', 'https://example.test/project#z'],
            },
        ]);
    });
});
