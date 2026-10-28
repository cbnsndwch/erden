import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
    RELEASE_QUERY_ENGINE,
    RELEASE_QUERY_ENGINE_LIMITS as LIMITS,
    RELEASE_QUERY_WORKER_FLAGS,
    ReleaseQueryEngineError,
    type NodeReleaseQueryEngine,
    type ReleaseQueryEngineComponent,
    type ReleaseQueryEngineInput,
    type ReleaseQueryEngineResult,
} from './model.js';
import { releaseQueryWorker } from './worker.js';

const GRAPHS = Object.freeze({
    declared: 'urn:erden:release-query:v1:graph:declared',
    inferred: 'urn:erden:release-query:v1:graph:inferred',
});
const WORKER_SOURCE = `(${releaseQueryWorker.toString()})(specifier => import(specifier)).catch(() => process.exit(1));`;
const OUTCOMES = new Set(['complete', 'row-limit', 'result-byte-limit', 'resource-limit', 'query-rejected']);
const KNOWN_ANSWER = Object.freeze({
    declared: '<urn:erden:release-query:known-answer:s> <urn:erden:release-query:known-answer:p> "known answer" .\n',
    inferred:
        '<urn:erden:release-query:known-answer:s> <urn:erden:release-query:known-answer:q> <urn:erden:release-query:known-answer:o> .\n',
    query: 'SELECT ?value ?graph WHERE { { <urn:erden:release-query:known-answer:s> <urn:erden:release-query:known-answer:p> ?value . } UNION { GRAPH ?graph { <urn:erden:release-query:known-answer:s> <urn:erden:release-query:known-answer:q> ?value . } } } ORDER BY ASC(?graph) LIMIT 1001',
    result: '{"head":{"vars":["value","graph"]},"results":{"bindings":[{"value":{"type":"literal","value":"known answer"}},{"value":{"type":"uri","value":"urn:erden:release-query:known-answer:o"},"graph":{"type":"uri","value":"urn:erden:release-query:v1:graph:inferred"}}]}}',
});

export interface ConfinedWorkerRun {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: Buffer;
    readonly stdoutOverflow: boolean;
    readonly stderrOverflow: boolean;
    readonly timedOut: boolean;
    readonly cancelled: boolean;
    readonly spawnFailed: boolean;
}

export interface ConfinedWorkerRequest {
    readonly directory: string;
    readonly source: string;
    readonly input: ReadonlyArray<Uint8Array>;
    readonly signal: AbortSignal;
    readonly milliseconds: number;
}

/** Arguments for one confined worker: permission model, reads confined to the engine directory, fixed memory caps. */
export function releaseQueryWorkerArguments(directory: string, source: string): ReadonlyArray<string> {
    return Object.freeze([
        RELEASE_QUERY_WORKER_FLAGS[0] ?? '--permission',
        `--allow-fs-read=${directory}`,
        ...RELEASE_QUERY_WORKER_FLAGS.slice(1),
        '--eval',
        source,
        directory,
    ]);
}

/** Spawn one single-use worker with an empty environment. Resolves only after the process exit is observed. */
export function runConfinedReleaseQueryWorker(request: ConfinedWorkerRequest): Promise<ConfinedWorkerRun> {
    return new Promise<ConfinedWorkerRun>((resolvePromise) => {
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutOverflow = false;
        let timedOut = false;
        let cancelled = false;
        let settled = false;
        let child: ReturnType<typeof spawn>;
        function settle(code: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean): void {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            request.signal.removeEventListener('abort', abort);
            resolvePromise(
                Object.freeze({
                    code,
                    signal,
                    stdout: Buffer.concat(stdout, stdoutBytes),
                    stdoutOverflow,
                    stderrOverflow: stderrBytes > LIMITS.workerStderrBytes,
                    timedOut,
                    cancelled,
                    spawnFailed,
                }),
            );
        }
        function kill(): void {
            try {
                child.kill('SIGKILL');
            } catch {
                /* The exit event remains authoritative. */
            }
        }
        function abort(): void {
            cancelled = true;
            kill();
        }
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, request.milliseconds);
        try {
            child = spawn(process.execPath, releaseQueryWorkerArguments(request.directory, request.source), {
                cwd: request.directory,
                env: {},
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch {
            settle(null, null, true);
            return;
        }
        child.once('error', () => {
            kill();
            if (child.pid === undefined) {
                settle(null, null, true);
            }
        });
        // 'close', not 'exit': 'exit' can arrive before the last stdout chunk has been read (seen on Windows, where a
        // complete answer then decoded as an empty one). 'close' follows the exit and the end of all three pipes; the
        // worker can start no child process that could hold them open.
        child.once('close', (code, signal) => {
            settle(code, signal, false);
        });
        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdoutOverflow) {
                return;
            }
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes > LIMITS.workerStdoutBytes) {
                stdoutOverflow = true;
                stdout.length = 0;
                stdoutBytes = 0;
                kill();
                return;
            }
            stdout.push(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            // Counted, never retained or logged.
            stderrBytes += chunk.byteLength;
        });
        child.stdin?.on('error', () => undefined);
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) {
            abort();
        }
        for (const part of request.input) {
            child.stdin?.write(part);
        }
        child.stdin?.end();
    });
}

function decodeResponse(run: ConfinedWorkerRun): ReleaseQueryEngineResult {
    if (run.cancelled) {
        throw new ReleaseQueryEngineError('ENGINE_CANCELLED');
    }
    if (run.timedOut) {
        return Object.freeze({ outcome: 'time-limit' });
    }
    if (run.stdoutOverflow || run.signal === 'SIGABRT' || run.signal === 'SIGTRAP' || run.code === 134) {
        return Object.freeze({ outcome: 'resource-limit' });
    }
    if (run.spawnFailed || run.code !== 0 || run.signal !== null || run.stderrOverflow) {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    const newline = run.stdout.indexOf(10);
    if (newline < 1) {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let value: unknown;
    try {
        value = JSON.parse(decoder.decode(run.stdout.subarray(0, newline)));
    } catch {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort().join(',');
    const outcome = record['outcome'];
    if (
        record['schema'] !== 'erden.release-query-worker-response/v1' ||
        typeof outcome !== 'string' ||
        !OUTCOMES.has(outcome) ||
        keys !== (outcome === 'complete' ? 'outcome,resultBytes,schema' : 'outcome,schema')
    ) {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    const body = run.stdout.subarray(newline + 1);
    if (outcome !== 'complete') {
        if (body.byteLength !== 0) {
            throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
        }
        return Object.freeze({ outcome: outcome as Exclude<ReleaseQueryEngineResult['outcome'], 'complete'> });
    }
    const resultBytes = record['resultBytes'];
    if (
        typeof resultBytes !== 'number' ||
        !Number.isSafeInteger(resultBytes) ||
        resultBytes < 0 ||
        resultBytes > LIMITS.maxResultBytes ||
        body.byteLength !== resultBytes
    ) {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    let result: string;
    try {
        result = decoder.decode(body);
    } catch {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    return Object.freeze({ outcome: 'complete', result });
}

function sha256(bytes: Uint8Array | string): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** One graph body: per component, an ASCII `<multiplicity> <byteLength>` line followed by exactly its bytes. */
function frame(components: ReadonlyArray<ReleaseQueryEngineComponent>): Readonly<{
    parts: ReadonlyArray<Uint8Array>;
    byteLength: number;
    sha256: string;
}> {
    const hash = createHash('sha256');
    const parts: Uint8Array[] = [];
    let byteLength = 0;
    for (const component of components) {
        if (!Number.isSafeInteger(component.multiplicity) || component.multiplicity < 1) {
            throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
        }
        const record = Buffer.from(`${String(component.multiplicity)} ${String(component.nquads.byteLength)}\n`);
        for (const part of [record, component.nquads]) {
            hash.update(part);
            parts.push(part);
            byteLength += part.byteLength;
        }
    }
    return Object.freeze({ parts, byteLength, sha256: hash.digest('hex') });
}

function workerInput(input: ReleaseQueryEngineInput): ReadonlyArray<Uint8Array> {
    const declared = frame(input.declared);
    const inferred = frame(input.inferred);
    if (declared.byteLength + inferred.byteLength > LIMITS.maxEngineInputBytes) {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    const header = {
        schema: 'erden.release-query-worker-request/v1',
        query: input.engineQuery,
        form: input.form,
        seed: sha256(`erden.release-query-entropy/v1\n${input.datasetSha256}\n${sha256(input.engineQuery)}`),
        dataset: {
            sha256: input.datasetSha256,
            declared: { graph: GRAPHS.declared, byteLength: declared.byteLength, sha256: declared.sha256 },
            inferred: { graph: GRAPHS.inferred, byteLength: inferred.byteLength, sha256: inferred.sha256 },
        },
        limits: {
            headerBytes: LIMITS.workerHeaderBytes,
            inputBytes: LIMITS.maxEngineInputBytes,
            resultBytes: LIMITS.maxResultBytes,
            resultRows: LIMITS.maxResultRows,
            termBytes: LIMITS.maxTermValueBytes,
            chunkBytes: LIMITS.loadChunkBytes,
        },
    };
    const line = Buffer.from(`${JSON.stringify(header)}\n`);
    if (line.byteLength > LIMITS.workerHeaderBytes) {
        throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
    }
    return [line, ...declared.parts, ...inferred.parts];
}

/** Resolve the real engine directory and verify its pinned identity. Returns null when anything differs. */
export function verifyReleaseQueryEngineDirectory(): string | null {
    try {
        const require = createRequire(import.meta.url);
        const directory = realpathSync(dirname(require.resolve('oxigraph/package.json')));
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown };
        if (
            manifest.version !== RELEASE_QUERY_ENGINE.version ||
            sha256(readFileSync(join(directory, 'node_bg.wasm'))) !== RELEASE_QUERY_ENGINE.wasmSha256 ||
            sha256(readFileSync(join(directory, 'node.js'))) !== RELEASE_QUERY_ENGINE.glueSha256
        ) {
            return null;
        }
        return directory;
    } catch {
        return null;
    }
}

export interface NodeReleaseQueryEngineOptions {
    /** Test-only: replace the worker body to inject protocol faults. */
    readonly workerSource?: string;
    /** Test-only: shorten the per-run wall-clock budget. */
    readonly workerMilliseconds?: number;
    /** Test-only: start without the known-answer run, so injected fault workers reach the decoder. */
    readonly skipKnownAnswer?: boolean;
    /** Test-only: substitute the engine directory resolution. */
    readonly directory?: () => string | null;
}

/** Child-process adapter: one fresh confined process per query, at most two at once, no queue. */
export function makeNodeReleaseQueryEngine(options: NodeReleaseQueryEngineOptions = {}): NodeReleaseQueryEngine {
    let state: ReturnType<NodeReleaseQueryEngine['state']> = 'idle';
    let directory: string | null = null;
    let starting: Promise<boolean> | undefined;
    let active = 0;
    const running = new Set<{ controller: AbortController; exited: Promise<unknown> }>();
    const source = options.workerSource ?? WORKER_SOURCE;
    const milliseconds = options.workerMilliseconds ?? LIMITS.workerMilliseconds;

    async function run(input: ReleaseQueryEngineInput, signal: AbortSignal): Promise<ReleaseQueryEngineResult> {
        if (directory === null) {
            throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
        }
        if (signal.aborted) {
            throw new ReleaseQueryEngineError('ENGINE_CANCELLED');
        }
        if (active >= LIMITS.maxEngineProcesses) {
            throw new ReleaseQueryEngineError('ENGINE_BUSY');
        }
        if (Buffer.byteLength(input.engineQuery) > LIMITS.maxEngineQueryBytes) {
            throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
        }
        const parts = workerInput(input);
        const controller = new AbortController();
        function forward(): void {
            controller.abort();
        }
        signal.addEventListener('abort', forward, { once: true });
        active += 1;
        const exited = runConfinedReleaseQueryWorker({
            directory,
            source,
            input: parts,
            signal: controller.signal,
            milliseconds,
        });
        const entry = { controller, exited };
        running.add(entry);
        void exited.finally(() => {
            // The slot is released only after the worker's exit has been observed.
            active -= 1;
            running.delete(entry);
            signal.removeEventListener('abort', forward);
        });
        return decodeResponse(await exited);
    }

    async function start(): Promise<boolean> {
        directory = (options.directory ?? verifyReleaseQueryEngineDirectory)();
        if (directory === null) {
            state = 'unavailable';
            return false;
        }
        if (options.skipKnownAnswer === true) {
            state = 'ready';
            return true;
        }
        try {
            const result = await run(
                {
                    declared: [{ nquads: Buffer.from(KNOWN_ANSWER.declared), multiplicity: 1 }],
                    inferred: [{ nquads: Buffer.from(KNOWN_ANSWER.inferred), multiplicity: 1 }],
                    datasetSha256: sha256('erden.release-query-known-answer/v1'),
                    engineQuery: KNOWN_ANSWER.query,
                    form: 'select',
                },
                AbortSignal.timeout(LIMITS.workerMilliseconds * 2),
            );
            const ready = result.outcome === 'complete' && result.result === KNOWN_ANSWER.result;
            if (state !== 'closed') {
                state = ready ? 'ready' : 'unavailable';
            }
            return ready;
        } catch {
            if (state !== 'closed') {
                state = 'unavailable';
            }
            return false;
        }
    }

    return Object.freeze<NodeReleaseQueryEngine>({
        start: async () => {
            if (state === 'closed') {
                return false;
            }
            state = 'starting';
            starting ??= start();
            return await starting;
        },
        state: () => state,
        execute: async (input, signal) => {
            if (state !== 'ready') {
                throw new ReleaseQueryEngineError('ENGINE_UNAVAILABLE');
            }
            return await run(input, signal);
        },
        close: async () => {
            state = 'closed';
            const pending = [...running];
            for (const entry of pending) {
                entry.controller.abort();
            }
            await Promise.allSettled(pending.map((entry) => entry.exited));
        },
    });
}
