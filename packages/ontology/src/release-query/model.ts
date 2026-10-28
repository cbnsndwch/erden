/** Engine policy constants. Covered by the release query policy digest; never configurable by operators. */
export const RELEASE_QUERY_ENGINE_LIMITS = Object.freeze({
    maxEngineInputBytes: 24 * 1_048_576,
    maxResultRows: 1_000,
    maxResultBytes: 4 * 1_048_576,
    maxTermValueBytes: 64 * 1_024,
    workerMilliseconds: 10_000,
    workerOldSpaceMb: 64,
    workerSemiSpaceMb: 8,
    workerWasmPages: 2_048,
    workerHeaderBytes: 64 * 1_024,
    /**
     * UTF-8 bytes of the canonical engine text. Canonical text has no control characters, so JSON string encoding
     * at most doubles it; twice this bound plus the fixed header fields stays under `workerHeaderBytes`.
     */
    maxEngineQueryBytes: 24 * 1_024,
    workerStdoutBytes: 4 * 1_048_576 + 64 * 1_024,
    workerStderrBytes: 64 * 1_024,
    maxEngineProcesses: 2,
    loadChunkBytes: 64 * 1_024,
});

/** The pinned engine identity. A different package version or byte stream makes the engine unavailable. */
export const RELEASE_QUERY_ENGINE = Object.freeze({
    name: 'oxigraph',
    version: '0.5.9',
    wasmSha256: '7c1ac853a1940cc774821de9f8868b1cba886e54adb1dc6671df1f4290cc8ee0',
    glueSha256: '8aea3c9f7bc802b0883a8c6c21a03a6ca650f666eae42193174a1763fccfcf89',
});

export const RELEASE_QUERY_WORKER_FLAGS = Object.freeze([
    '--permission',
    '--disallow-code-generation-from-strings',
    '--no-addons',
    '--disable-proto=delete',
    `--max-old-space-size=${String(RELEASE_QUERY_ENGINE_LIMITS.workerOldSpaceMb)}`,
    `--max-semi-space-size=${String(RELEASE_QUERY_ENGINE_LIMITS.workerSemiSpaceMb)}`,
    `--wasm-max-mem-pages=${String(RELEASE_QUERY_ENGINE_LIMITS.workerWasmPages)}`,
    '--no-warnings',
    '--input-type=module',
]);

/**
 * One canonical component: N-Triples lines of exactly `<term> <term> <term> .` with single spaces, loaded
 * `multiplicity` times. The confined worker gives instance `k` of component `c` in graph `g` the blank-node label
 * prefix `q{g}{c}_{k}_`, so isomorphic instances stay distinct; the parent never expands them.
 */
export interface ReleaseQueryEngineComponent {
    readonly nquads: Uint8Array;
    readonly multiplicity: number;
}

export interface ReleaseQueryEngineInput {
    /** Components of the declared graph; every statement is in the default graph of its byte stream. */
    readonly declared: ReadonlyArray<ReleaseQueryEngineComponent>;
    /** Components of the inferred delta graph. */
    readonly inferred: ReadonlyArray<ReleaseQueryEngineComponent>;
    readonly datasetSha256: string;
    /** Canonical SPARQL produced by the release query serializer, never caller text. */
    readonly engineQuery: string;
    readonly form: 'select' | 'ask';
}

export type ReleaseQueryEngineResult =
    | Readonly<{ outcome: 'complete'; result: string }>
    | Readonly<{ outcome: 'row-limit' | 'result-byte-limit' | 'resource-limit' | 'time-limit' | 'query-rejected' }>;

export type ReleaseQueryEngineErrorCode = 'ENGINE_BUSY' | 'ENGINE_CANCELLED' | 'ENGINE_UNAVAILABLE';

const messages: Readonly<Record<ReleaseQueryEngineErrorCode, string>> = Object.freeze({
    ENGINE_BUSY: 'Release query engine capacity is exhausted',
    ENGINE_CANCELLED: 'The release query engine run was cancelled',
    ENGINE_UNAVAILABLE: 'The release query engine is unavailable',
});

export class ReleaseQueryEngineError extends Error {
    readonly code: ReleaseQueryEngineErrorCode;

    constructor(code: ReleaseQueryEngineErrorCode) {
        super(messages[code]);
        this.name = 'ReleaseQueryEngineError';
        this.code = code;
        Object.freeze(this);
    }
}

export interface ReleaseQueryEngineShape {
    readonly execute: (input: ReleaseQueryEngineInput, signal: AbortSignal) => Promise<ReleaseQueryEngineResult>;
}

export interface NodeReleaseQueryEngine extends ReleaseQueryEngineShape {
    /** Verify the pinned engine and run a known-answer query. Resolves false, never throws, when unavailable. */
    readonly start: () => Promise<boolean>;
    readonly state: () => 'idle' | 'starting' | 'ready' | 'unavailable' | 'closed';
    /** SIGKILL every running worker and wait for their exits. */
    readonly close: () => Promise<void>;
}
