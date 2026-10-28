// Tampered answers from the real bundled reasoner, refused alike on every path a decision takes: `decide`, the fused
// path on a graph it validates and copies, and the fused path on a graph byte-backed assembly handed over. The
// expected refusals and issue lists are the ones `decide` gave before E1 (76d1a42), so the digests the protocol now
// reads from the text it wrote or read (sealed requests, opened answers) catch what the recomputed ones caught.
/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access,
   typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-return --
   a forger edits answers as untyped JSON, which is the point of these cases. */
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import * as protocol from '@erden/reasoner-protocol';

import {
    decideAndMaterializeAssembledOntology,
    decideAssembledOntology,
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerProcessPort,
    type ReasonerProcessPort,
    type ReasonerProcessRequest,
} from '../src/index.js';

import { assembleFixtures, sourceDescriptor } from './reasoner-helpers.js';

type Json = any;

const TEXT = `@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:A a owl:Class ; rdfs:subClassOf ex:B . ex:B a owl:Class ; rdfs:subClassOf ex:C . ex:C a owl:Class .
ex:Unrelated a owl:Class . ex:x a ex:A .
`;

/** Rebinds every digest of an answer to its (changed) evidence, as a forger who knows the protocol would. */
function rebind(raw: Json): Json {
    const response = protocol.normalizeReasonerResponse(raw) as Json;
    const inferred = response.result.inferred.map((statement: Json) => ({
        ...statement,
        provenance: {
            ...statement.provenance,
            justificationDigest: protocol.computeInferredJustificationDigest(statement),
        },
    }));
    const { certificate, ...evidence } = { ...response.result, inferred };
    const bound = {
        ...certificate,
        inputDigest: response.inputDigest,
        outputDigest: protocol.computeDecidedOutputDigest(evidence),
        justificationDigest: protocol.computeAggregateJustificationDigest(evidence),
    };
    bound.certificateDigest = protocol.computeCertificateDigest(bound);
    return { ...response, result: { ...evidence, certificate: bound } };
}

function canonical(value: Json): string {
    return protocol.stringifyCanonicalJson(protocol.normalizeReasonerResponse(value));
}

const CASES: Record<string, readonly [(response: Json) => string, string]> = {
    untouched: [(r) => canonical(r), 'accepted inferred=3'],
    'rebound, nothing changed': [(r) => canonical(rebind(r)), 'accepted inferred=3'],
    'forged inference, digests rebound': [
        (r) => {
            const first = r.result.inferred[0];
            const forged = { ...first, id: `${String(first.id)}x`, object: 'https://example.test/root#Unrelated' };
            return canonical(rebind({ ...r, result: { ...r.result, inferred: [...r.result.inferred, forged] } }));
        },
        'refused UNTRUSTED_RESPONSE Reasoner response failed closed: not-entailed',
    ],
    'claimed justification digest changed, aggregate over the claimed ones': [
        (r) => {
            const inferred = r.result.inferred.map((statement: Json, index: number) =>
                index === 0
                    ? {
                          ...statement,
                          provenance: { ...statement.provenance, justificationDigest: `sha256:${'7'.repeat(64)}` },
                      }
                    : statement,
            );
            const { certificate, ...evidence } = { ...r.result, inferred };
            const aggregate = protocol.sha256CanonicalJson({
                inferred: inferred.map((statement: Json) => ({
                    id: statement.id,
                    justificationDigest: statement.provenance.justificationDigest,
                })),
                unsatisfiableClasses: evidence.unsatisfiableClasses.map((item: Json) => ({
                    classIri: item.classIri,
                    justificationDigest: item.justificationDigest,
                })),
            });
            const bound = {
                ...certificate,
                outputDigest: protocol.computeDecidedOutputDigest(evidence),
                justificationDigest: aggregate,
            };
            bound.certificateDigest = protocol.computeCertificateDigest(bound);
            return canonical({ ...r, result: { ...evidence, certificate: bound } });
        },
        'refused UNTRUSTED_RESPONSE Reasoner response failed closed: certificate-justification-digest, inferred-justification-digest',
    ],
    'input digest replaced in answer and certificate, rebound': [
        (r) => canonical(rebind({ ...r, inputDigest: `sha256:${'5'.repeat(64)}` })),
        'refused UNTRUSTED_RESPONSE Reasoner response envelope failed closed: input-digest',
    ],
    'inferred order reversed (non-canonical)': [
        (r) => `${JSON.stringify({ ...r, result: { ...r.result, inferred: [...r.result.inferred].reverse() } })}\n`,
        'refused NONCANONICAL_RESPONSE ',
    ],
    'tool version changed': [
        (r) => canonical({ ...r, tool: { ...r.tool, version: `${String(r.tool.version)}-x` } }),
        'refused UNTRUSTED_RESPONSE Reasoner response envelope failed closed: tool-version',
    ],
    'request id changed': [
        (r) => canonical({ ...r, requestId: `${String(r.requestId)}0` }),
        'refused UNTRUSTED_RESPONSE Reasoner response envelope failed closed: request-id',
    ],
    'dropped inference, digests rebound': [
        (r) => canonical(rebind({ ...r, result: { ...r.result, inferred: r.result.inferred.slice(1) } })),
        'refused UNTRUSTED_RESPONSE Reasoner response failed closed: missing-premise, missing-proof-premise, not-entailed',
    ],
    'premise id swapped to another axiom': [
        (r) => {
            const inferred = r.result.inferred.map((statement: Json, index: number) =>
                index === 0
                    ? {
                          ...statement,
                          provenance: { ...statement.provenance, premiseIds: [r.result.asserted.at(-1).id] },
                      }
                    : statement,
            );
            return canonical(rebind({ ...r, result: { ...r.result, inferred } }));
        },
        'refused UNTRUSTED_RESPONSE Reasoner response failed closed: not-entailed',
    ],
};

/** The bundled reasoner, with its answer passed through `transform`. */
function tampering(transform: (response: Json) => string): ReasonerProcessPort {
    return Object.freeze({
        run: (request: ReasonerProcessRequest) =>
            nodeReasonerProcessPort.run(request).pipe(
                Effect.map((output) => ({
                    ...output,
                    stdout: Buffer.from(transform(JSON.parse(Buffer.from(output.stdout).toString('utf8')))),
                })),
            ),
    });
}

async function outcome(effect: Effect.Effect<Json, Json>): Promise<string> {
    const result = await Effect.runPromise(Effect.result(effect));
    if (result._tag === 'Success') {
        const response = result.success.response ?? result.success.decision.response;
        return `accepted inferred=${String(response.result.inferred.length)}`;
    }
    const failure = result.failure;
    return `refused ${String(failure.code)} ${String(failure.cause?.message ?? '').slice(0, 160)}`;
}

describe('tampered answers through the bundled reasoner', () => {
    it('are refused alike by decide, by the fused path and by the fused path on a handed-over graph', async () => {
        const assembled = await assembleFixtures([{ id: 'source:root', locator: 'root.ttl', text: TEXT }]);
        const ontology = makeOntologyService(makeNodeOntologyPorts());
        const rows: Record<string, Record<string, string>> = {};
        const expected: Record<string, Record<string, string>> = {};
        for (const [name, [transform, refusal]] of Object.entries(CASES)) {
            const process = tampering(transform);
            const owned = await Effect.runPromise(
                ontology.assembleByteBacked([
                    {
                        descriptor: sourceDescriptor({ id: 'source:root', locator: 'root.ttl' }),
                        bytes: new TextEncoder().encode(TEXT),
                    },
                ]),
            );
            rows[name] = {
                decide: await outcome(decideAssembledOntology(assembled, { process })),
                fused: await outcome(decideAndMaterializeAssembledOntology(assembled, { process })),
                owned: await outcome(decideAndMaterializeAssembledOntology(owned, { process })),
            };
            expected[name] = { decide: refusal, fused: refusal, owned: refusal };
        }
        expect(rows).toEqual(expected);
    }, 120_000);
});
