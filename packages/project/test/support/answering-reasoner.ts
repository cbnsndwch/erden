// A reasoner process port that answers every request as a consistent decision with no inferences, under the tool
// the request names: a stand-in for a reasoner build other than the bundled one, which answers with its own identity.
import { Effect } from 'effect';

import type { ReasonerProcessPort, ReasonerProcessRequest } from '@erden/ontology';
import { bindDecidedEvidence, decodeReasonerRequestJson, encodeReasonerResponseJson } from '@erden/reasoner-protocol';

export function answeringReasonerPort(calls: { count: number } = { count: 0 }): ReasonerProcessPort {
    return Object.freeze({
        run: ({ wire }: ReasonerProcessRequest) =>
            Effect.sync(() => {
                calls.count += 1;
                const request = decodeReasonerRequestJson(wire);
                const response = {
                    protocolVersion: request.protocolVersion,
                    kind: 'ReasonerResponse' as const,
                    requestId: request.requestId,
                    profile: request.profile,
                    tool: request.requiredTool,
                    inputDigest: request.ontology.digest,
                    result: bindDecidedEvidence(
                        request,
                        {
                            outcome: 'decided',
                            completeness: 'complete',
                            consistency: 'consistent',
                            asserted: [],
                            inferred: [],
                            unsatisfiableClasses: [],
                            diagnostics: [],
                        },
                        { name: 'answering-reasoner-test', version: '1' },
                    ),
                };
                return {
                    stdout: new TextEncoder().encode(encodeReasonerResponseJson(response)),
                    stderrBytes: 0,
                    exitCode: 0,
                };
            }),
    });
}
