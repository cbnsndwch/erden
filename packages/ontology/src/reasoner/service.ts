import { Context, Effect } from 'effect';

import type { AssembledOntology, ReasonedOntology } from '../model.js';

import {
    OntologyInconsistencyError,
    ReasonerMaterializationError,
    ReasonerNormalizationError,
    ReasonerProcessError,
} from './errors.js';
import {
    decideAndMaterializeAssembledOntology,
    decideAssembledOntology,
    type DecideAssembledOntologyOptions,
    type DecidedAndMaterialized,
    type ReasonerArtifactResolver,
    type ReasonerProcessPort,
    type TrustedReasonerDecision,
} from './process.js';

export type ReasonerServiceError =
    | ReasonerNormalizationError
    | ReasonerProcessError
    | OntologyInconsistencyError
    | ReasonerMaterializationError;

export interface ReasonerServiceShape {
    readonly decide: (
        graph: AssembledOntology,
        options?: ReasonerServiceOptions,
    ) => Effect.Effect<TrustedReasonerDecision, ReasonerNormalizationError | ReasonerProcessError>;
    /**
     * Decides and, when the answer is consistent and carries no error diagnostic, materializes in the same step;
     * the check kernel's path. `decide` followed by `materializeReasonerDecision` gives the same result with every
     * binding check repeated.
     */
    readonly decideAndMaterialize: (
        graph: AssembledOntology,
        options?: ReasonerServiceOptions,
    ) => Effect.Effect<
        DecidedAndMaterialized,
        ReasonerNormalizationError | ReasonerProcessError | ReasonerMaterializationError
    >;
    readonly reason: (
        graph: AssembledOntology,
        options?: ReasonerServiceOptions,
    ) => Effect.Effect<ReasonedOntology, ReasonerServiceError>;
}

/** Per-call options; the process and the artifact belong to the service's composition. */
export type ReasonerServiceOptions = Omit<DecideAssembledOntologyOptions, 'process' | 'artifact'>;

export const ReasonerService = Context.Service<ReasonerServiceShape>('@erden/ontology/ReasonerService');

/**
 * The qualified bundled reasoner unless `artifact` names another build; only measurement and qualification
 * harnesses pass one, with the identity that build answers with.
 */
export function makeReasonerService(
    process?: ReasonerProcessPort,
    artifact?: ReasonerArtifactResolver,
): ReasonerServiceShape {
    function decide(
        graph: Parameters<ReasonerServiceShape['decide']>[0],
        options: Parameters<ReasonerServiceShape['decide']>[1] = {},
    ): ReturnType<ReasonerServiceShape['decide']> {
        return decideAssembledOntology(graph, composed(options));
    }
    function composed(options: ReasonerServiceOptions): DecideAssembledOntologyOptions {
        return {
            ...options,
            ...(process === undefined ? {} : { process }),
            ...(artifact === undefined ? {} : { artifact }),
        };
    }
    function decideAndMaterialize(
        graph: Parameters<ReasonerServiceShape['decideAndMaterialize']>[0],
        options: Parameters<ReasonerServiceShape['decideAndMaterialize']>[1] = {},
    ): ReturnType<ReasonerServiceShape['decideAndMaterialize']> {
        return decideAndMaterializeAssembledOntology(graph, composed(options));
    }
    function reason(
        graph: Parameters<ReasonerServiceShape['reason']>[0],
        options: Parameters<ReasonerServiceShape['reason']>[1] = {},
    ): ReturnType<ReasonerServiceShape['reason']> {
        return decideAndMaterializeAssembledOntology(graph, composed(options), 'consistent').pipe(
            Effect.flatMap(({ decision, reasoned }) =>
                reasoned === null
                    ? Effect.fail(
                          new OntologyInconsistencyError(decision.response.result.diagnostics.map((item) => item.code)),
                      )
                    : Effect.succeed(reasoned),
            ),
        );
    }
    return Object.freeze({
        decide,
        decideAndMaterialize,
        reason,
    });
}

export const nodeReasonerService = makeReasonerService();
