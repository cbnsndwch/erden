import { Effect } from 'effect';

// The port `erden check` validates through, and its Node adapter: the bundled erden-shacl, resolved only when a check
// has shapes, run as one process per request under the wall-time limit.
import { BundledShaclEngineError, resolveBundledShaclEngine } from '@erden/shacl-distribution';

import { ShaclEngineUnavailableError, ShaclLimitsError } from '../errors.js';

import { shaclEngineTool, type ShaclEngineTool } from './identity.js';
import { runShaclRequest, ShaclProcessError } from './process.js';
import {
    ShaclAnswerUntrustedError,
    type EncodedShaclRequest,
    type ShaclRefusal,
    type TrustedShaclAnswer,
} from './protocol.js';

export type ShaclEngineRunError = ShaclProcessError | ShaclAnswerUntrustedError;

/** A resolved engine: the identity every answer must carry, and one request in, one checked answer out. */
export interface ShaclEngineHandle {
    readonly tool: ShaclEngineTool;
    readonly run: (
        request: EncodedShaclRequest,
    ) => Effect.Effect<TrustedShaclAnswer | ShaclRefusal, ShaclEngineRunError>;
}

export interface ShaclEnginePort {
    /** Resolves the qualified engine. Called once per check, and only when the check has shapes. */
    readonly resolve: () => Effect.Effect<ShaclEngineHandle, ShaclEngineUnavailableError | ShaclLimitsError>;
}

export const SHACL_WALL_TIME_VARIABLE = 'ERDEN_SHACL_MAX_WALL_TIME_MS' as const;
export const SHACL_WALL_TIME_LIMITS = Object.freeze({ defaultValue: 120_000, minimum: 1_000, maximum: 600_000 });

/** The wall-time limit for one SHACL request: `ERDEN_SHACL_MAX_WALL_TIME_MS`, or 120 s. */
export function shaclMaxWallTimeMs(environment: Readonly<Record<string, string | undefined>>): number {
    const raw = environment[SHACL_WALL_TIME_VARIABLE];
    if (raw === undefined || raw === '') {
        return SHACL_WALL_TIME_LIMITS.defaultValue;
    }
    const value = /^[0-9]{1,9}$/u.test(raw) ? Number(raw) : Number.NaN;
    if (!(value >= SHACL_WALL_TIME_LIMITS.minimum && value <= SHACL_WALL_TIME_LIMITS.maximum)) {
        throw new ShaclLimitsError(
            SHACL_WALL_TIME_VARIABLE,
            SHACL_WALL_TIME_LIMITS.minimum,
            SHACL_WALL_TIME_LIMITS.maximum,
        );
    }
    return value;
}

/** A process failure in words that name no host path: the kind, and the limit or exit status where there is one. */
function pathFreeProcessError(error: ShaclProcessError, maxWallTimeMs: number): ShaclProcessError {
    switch (error.failure) {
        case 'timeout':
            return new ShaclProcessError('timeout', `${String(maxWallTimeMs)} ms, set by ${SHACL_WALL_TIME_VARIABLE}`);
        case 'exit':
            return new ShaclProcessError(
                'exit',
                `the process exited with status ${error.detail.replace(/:.*$/su, '')}`,
            );
        case 'spawn':
            return new ShaclProcessError('spawn', 'the process could not be started');
        case 'stderr':
            return new ShaclProcessError('stderr', 'the process wrote to its error stream');
        case 'output-limit':
            return new ShaclProcessError('output-limit', 'the answer exceeded the wire limit');
        case 'closed':
            return new ShaclProcessError('closed', 'the process closed before answering');
    }
}

/** The Node adapter: the bundled erden-shacl for this platform, checked by the resolver before every check. */
export const nodeShaclEnginePort: ShaclEnginePort = Object.freeze({
    resolve: () =>
        Effect.try({
            try: () => {
                const maxWallTimeMs = shaclMaxWallTimeMs(process.env);
                const resolved = resolveBundledShaclEngine();
                const tool = shaclEngineTool(resolved.tool.executableDigest);
                if (resolved.tool.engineDigest !== tool.engineDigest || resolved.tool.version !== tool.version) {
                    throw new ShaclEngineUnavailableError(
                        'ENGINE_IDENTITY_MISMATCH',
                        'the installed package is not the erden-shacl release this Erden was built against',
                    );
                }
                const handle: ShaclEngineHandle = Object.freeze({
                    tool,
                    run: (request: EncodedShaclRequest) =>
                        Effect.tryPromise({
                            try: () => runShaclRequest(resolved.path, request, { maxWallTimeMs }),
                            catch: (cause): ShaclEngineRunError =>
                                cause instanceof ShaclProcessError
                                    ? pathFreeProcessError(cause, maxWallTimeMs)
                                    : cause instanceof ShaclAnswerUntrustedError
                                      ? cause
                                      : new ShaclAnswerUntrustedError(
                                            cause instanceof Error ? cause.message : String(cause),
                                        ),
                        }),
                });
                return handle;
            },
            catch: (cause) =>
                cause instanceof ShaclLimitsError || cause instanceof ShaclEngineUnavailableError
                    ? cause
                    : cause instanceof BundledShaclEngineError
                      ? new ShaclEngineUnavailableError(cause.code, cause.message)
                      : new ShaclEngineUnavailableError(
                            'RESOLVER_FAILED',
                            cause instanceof Error ? cause.message : String(cause),
                        ),
        }),
});
