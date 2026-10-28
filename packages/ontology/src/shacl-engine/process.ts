// Running `erden-shacl`: one process per request, or a long-lived session (`--serve`) that answers many requests in
// order and keeps the shapes graphs it compiled. Wall time is enforced here: on expiry the process is killed and the
// request fails closed. Every answer goes through `decodeTrustedShaclAnswer` before it is returned.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { MAX_SHACL_WIRE_BYTES } from './identity.js';
import {
    decodeTrustedShaclAnswer,
    encodeShaclRequest,
    ShaclAnswerUntrustedError,
    type EncodedShaclRequest,
    type ShaclRefusal,
    type ShaclRequestInput,
    type TrustedShaclAnswer,
} from './protocol.js';

const MAX_STDERR_BYTES = 65_536;

export type ShaclProcessFailure = 'spawn' | 'timeout' | 'exit' | 'stderr' | 'output-limit' | 'closed';

/** The process did not give an answer: it could not start, ran out of time, failed or wrote outside the protocol. */
export class ShaclProcessError extends Error {
    readonly code: 'SHACL_BUDGET_EXHAUSTED' | 'SHACL_ENGINE_FAILED';
    readonly failure: ShaclProcessFailure;
    readonly detail: string;

    constructor(failure: ShaclProcessFailure, detail: string) {
        super(
            failure === 'timeout'
                ? `erden-shacl did not answer within its wall-time limit (${detail})`
                : `erden-shacl did not give an answer (${failure}): ${detail}`,
        );
        this.name = 'ShaclProcessError';
        this.code = failure === 'timeout' ? 'SHACL_BUDGET_EXHAUSTED' : 'SHACL_ENGINE_FAILED';
        this.failure = failure;
        this.detail = detail;
    }
}

export interface ShaclRunOptions {
    /** Wall-time limit for the request, in milliseconds. */
    readonly maxWallTimeMs: number;
    /** Extra environment for the process (for example `RAYON_NUM_THREADS`); the parent's is inherited. */
    readonly env?: Readonly<Record<string, string>>;
}

function processEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
    return extra === undefined ? process.env : { ...process.env, ...extra };
}

/** One process, one request, one trusted answer or refusal. */
export function runShaclRequest(
    executable: string,
    request: EncodedShaclRequest,
    options: ShaclRunOptions,
): Promise<TrustedShaclAnswer | ShaclRefusal> {
    return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(executable, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                env: processEnvironment(options.env),
            });
        } catch (cause) {
            reject(new ShaclProcessError('spawn', cause instanceof Error ? cause.message : String(cause)));
            return;
        }
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderr = '';
        let failure: ShaclProcessError | undefined;
        // A failure settles the request at once; the process is killed and its later events are ignored.
        function fail(error: ShaclProcessError): void {
            if (failure === undefined) {
                failure = error;
                reject(error);
            }
            child.kill('SIGKILL');
        }
        const timer = setTimeout(() => {
            fail(new ShaclProcessError('timeout', `${String(options.maxWallTimeMs)} ms`));
        }, options.maxWallTimeMs);
        child.stdout.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_SHACL_WIRE_BYTES) {
                fail(new ShaclProcessError('output-limit', `more than ${String(MAX_SHACL_WIRE_BYTES)} bytes`));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            if (stderr.length < MAX_STDERR_BYTES) {
                stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
            }
        });
        child.on('error', (error) => {
            fail(new ShaclProcessError('spawn', error.message));
        });
        // A process that exits before reading its request closes the pipe; the exit status reports it.
        child.stdin.on('error', () => {});
        child.on('close', (status, signal) => {
            clearTimeout(timer);
            if (failure !== undefined) {
                return;
            }
            if (status !== 0) {
                reject(new ShaclProcessError('exit', `${String(status ?? signal)}: ${stderr.trim()}`));
                return;
            }
            if (stderr !== '') {
                reject(new ShaclProcessError('stderr', stderr.trim()));
                return;
            }
            try {
                resolve(decodeTrustedShaclAnswer(Buffer.concat(stdout).toString('utf8'), request));
            } catch (error) {
                reject(error instanceof Error ? error : new ShaclAnswerUntrustedError(String(error)));
            }
        });
        child.stdin.end(request.line);
    });
}

interface Pending {
    readonly request: EncodedShaclRequest;
    readonly resolve: (answer: TrustedShaclAnswer | ShaclRefusal) => void;
    readonly reject: (error: unknown) => void;
    readonly timer: NodeJS.Timeout;
}

export interface ShaclSessionOptions extends ShaclRunOptions {
    /** Compiled shapes graphs the process keeps (`SESSION_SHAPES_CACHE` in the Rust program). */
    readonly shapesCache?: number;
}

/**
 * A long-lived `erden-shacl --serve` process. Requests are answered in the order they were sent. A shapes graph the
 * session has sent before goes by digest alone; if the process no longer holds it, the request is sent again with the
 * text. A deadline, a crash, stderr output or an untrusted answer ends the process and fails every request in flight;
 * the next request starts a fresh one.
 */
export class ShaclSession {
    readonly #executable: string;
    readonly #options: ShaclSessionOptions;
    #child: ChildProcessWithoutNullStreams | undefined;
    #pending: Pending[] = [];
    #buffer = '';
    /** Shapes digests the current process has compiled, least recently used first. */
    #held: string[] = [];
    #starts = 0;

    constructor(executable: string, options: ShaclSessionOptions) {
        this.#executable = executable;
        this.#options = options;
    }

    /** How many processes this session has started (a restart after a failure adds one). */
    get starts(): number {
        return this.#starts;
    }

    #start(): ChildProcessWithoutNullStreams {
        const child = spawn(this.#executable, ['--serve'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: processEnvironment(this.#options.env),
        });
        this.#starts += 1;
        this.#held = [];
        this.#buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            this.#receive(child, chunk);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            this.#end(child, new ShaclProcessError('stderr', chunk.trim().slice(0, MAX_STDERR_BYTES)));
        });
        child.on('error', (error) => {
            this.#end(child, new ShaclProcessError('spawn', error.message));
        });
        child.stdin.on('error', () => {});
        child.on('close', (status, signal) => {
            this.#end(
                child,
                new ShaclProcessError('closed', `the session process ended (${String(status ?? signal)})`),
            );
        });
        this.#child = child;
        return child;
    }

    #receive(child: ChildProcessWithoutNullStreams, chunk: string): void {
        this.#buffer += chunk;
        if (this.#buffer.length > MAX_SHACL_WIRE_BYTES) {
            this.#end(child, new ShaclProcessError('output-limit', `more than ${String(MAX_SHACL_WIRE_BYTES)} bytes`));
            return;
        }
        let newline = this.#buffer.indexOf('\n');
        while (newline >= 0 && this.#child === child) {
            const line = this.#buffer.slice(0, newline + 1);
            this.#buffer = this.#buffer.slice(newline + 1);
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#end(child, new ShaclProcessError('exit', 'the session wrote an answer nobody asked for'));
                return;
            }
            clearTimeout(pending.timer);
            try {
                const answer = decodeTrustedShaclAnswer(line, pending.request);
                if (answer.outcome === 'validated' || answer.code !== 'shapes-not-loaded') {
                    this.#hold(pending.request.shapesKey, answer.outcome === 'validated');
                }
                pending.resolve(answer);
            } catch (error) {
                pending.reject(error instanceof Error ? error : new ShaclAnswerUntrustedError(String(error)));
                if (error instanceof ShaclAnswerUntrustedError) {
                    this.#end(child, new ShaclProcessError('exit', 'the session gave an untrusted answer'));
                    return;
                }
            }
            newline = this.#buffer.indexOf('\n');
        }
    }

    #hold(key: string, compiled: boolean): void {
        this.#held = this.#held.filter((held) => held !== key);
        if (compiled) {
            this.#held.push(key);
            const limit = this.#options.shapesCache ?? 8;
            while (this.#held.length > limit) {
                this.#held.shift();
            }
        }
    }

    #end(child: ChildProcessWithoutNullStreams, error: ShaclProcessError): void {
        if (this.#child !== child) {
            return;
        }
        this.#child = undefined;
        child.kill('SIGKILL');
        const pending = this.#pending;
        this.#pending = [];
        for (const item of pending) {
            clearTimeout(item.timer);
            item.reject(error);
        }
    }

    #send(request: EncodedShaclRequest): Promise<TrustedShaclAnswer | ShaclRefusal> {
        const child = this.#child ?? this.#start();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#end(child, new ShaclProcessError('timeout', `${String(this.#options.maxWallTimeMs)} ms`));
            }, this.#options.maxWallTimeMs);
            this.#pending.push({ request, resolve, reject, timer });
            child.stdin.write(request.line);
        });
    }

    /** Validates through the session; the shapes text is sent only when this process has not compiled it. */
    async validate(input: Omit<ShaclRequestInput, 'omitShapesText'>): Promise<TrustedShaclAnswer | ShaclRefusal> {
        const key = `${input.shapes.digest}\u0000${input.shapesGraphIri ?? ''}`;
        const held = this.#child !== undefined && this.#held.includes(key);
        const answer = await this.#send(encodeShaclRequest({ ...input, omitShapesText: held }));
        if (held && answer.outcome === 'refused' && answer.code === 'shapes-not-loaded') {
            return this.#send(encodeShaclRequest({ ...input, omitShapesText: false }));
        }
        return answer;
    }

    /** Ends the process; requests in flight fail. */
    close(): void {
        if (this.#child !== undefined) {
            const child = this.#child;
            this.#end(child, new ShaclProcessError('closed', 'the session was closed'));
        }
    }
}
