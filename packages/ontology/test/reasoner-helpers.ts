import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { Effect } from 'effect';

import {
    bindDecidedEvidence,
    decodeReasonerRequestJson,
    encodeReasonerResponseJson,
    type DecidedEvidence,
    type ReasonerRequest,
    type ReasonerResponse,
} from '@erden/reasoner-protocol';

import {
    ResourceAccessError,
    assembleOntology,
    type AssembledOntology,
    type ProjectSourceOwner,
    type ReasonerProcessPort,
    type ReasonerProcessRequest,
    type ReasonerSpawner,
    type TextResourcePort,
    type TurtleSourceDescriptor,
} from '../src/index.js';

export const ROOT_OWNER: ProjectSourceOwner = Object.freeze({
    canonicalIri: 'https://example.test/root',
    role: 'root',
    ownedIriPrefixes: Object.freeze(['https://example.test/root#']),
});

export const DEPENDENCY_OWNER: ProjectSourceOwner = Object.freeze({
    canonicalIri: 'https://example.test/dependency',
    role: 'dependency',
    ownedIriPrefixes: Object.freeze(['https://example.test/dependency#']),
});

export interface SourceFixture {
    readonly id: string;
    readonly locator: string;
    readonly text?: string;
    readonly bytes?: Uint8Array;
    readonly owner?: ProjectSourceOwner;
}

export function sourceDescriptor(fixture: SourceFixture): TurtleSourceDescriptor {
    return Object.freeze({
        id: fixture.id,
        owner: fixture.owner ?? ROOT_OWNER,
        locator: fixture.locator,
        baseIri: (fixture.owner ?? ROOT_OWNER).canonicalIri,
        mediaType: 'text/turtle',
        provenance: Object.freeze({ _tag: 'Asserted' as const }),
    });
}

export function memoryResourcePort(fixtures: ReadonlyArray<SourceFixture>): TextResourcePort {
    const byLocator = new Map(fixtures.map((fixture) => [fixture.locator, fixture]));
    return Object.freeze({
        readBytes: (locator: string) => {
            const fixture = byLocator.get(locator);
            if (fixture === undefined) {
                return Effect.fail(new ResourceAccessError(locator, 'missing fixture'));
            }
            return Effect.succeed(fixture.bytes ?? new TextEncoder().encode(fixture.text ?? ''));
        },
        readText: (locator: string) => {
            const fixture = byLocator.get(locator);
            if (fixture === undefined) {
                return Effect.fail(new ResourceAccessError(locator, 'missing fixture'));
            }
            if (fixture.text !== undefined) {
                return Effect.succeed(fixture.text);
            }
            try {
                return Effect.succeed(new TextDecoder('utf-8', { fatal: true }).decode(fixture.bytes));
            } catch (cause) {
                return Effect.fail(new ResourceAccessError(locator, cause));
            }
        },
        listFiles: () => Effect.succeed([]),
    });
}

export async function assembleFixtures(fixtures: ReadonlyArray<SourceFixture>): Promise<AssembledOntology> {
    return Effect.runPromise(assembleOntology(memoryResourcePort(fixtures), fixtures.map(sourceDescriptor)));
}

function emptyEvidence(): DecidedEvidence {
    return {
        outcome: 'decided',
        completeness: 'complete',
        consistency: 'consistent',
        asserted: [],
        inferred: [],
        unsatisfiableClasses: [],
        diagnostics: [],
    };
}

export function decidedResponseFor(
    request: ReasonerRequest,
    evidence: DecidedEvidence = emptyEvidence(),
): ReasonerResponse {
    return {
        protocolVersion: request.protocolVersion,
        kind: 'ReasonerResponse',
        requestId: request.requestId,
        profile: request.profile,
        tool: request.requiredTool,
        inputDigest: request.ontology.digest,
        result: bindDecidedEvidence(request, evidence, { name: 'ontology-client-test', version: '1' }),
    };
}

export type ResponseTransform = (response: ReasonerResponse, request: ReasonerRequest) => string | Uint8Array;

export function dynamicResponsePort(
    transform: ResponseTransform = (response) => encodeReasonerResponseJson(response),
): ReasonerProcessPort {
    return Object.freeze({
        run: ({ wire }: ReasonerProcessRequest) =>
            Effect.sync(() => {
                const request = decodeReasonerRequestJson(wire);
                const response = decidedResponseFor(request);
                const output = transform(response, request);
                return Object.freeze({
                    stdout: typeof output === 'string' ? Buffer.from(output) : output,
                    stderrBytes: 0,
                    exitCode: 0,
                });
            }),
    });
}

export interface FakeChildControl {
    readonly child: ChildProcessWithoutNullStreams;
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    readonly stdinBytes: () => Buffer;
    readonly close: (code: number | null) => void;
    readonly killCalls: ReadonlyArray<NodeJS.Signals | number | undefined>;
}

export function makeFakeChild(): FakeChildControl {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const input: Buffer[] = [];
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    let closed = false;
    stdin.on('data', (chunk: Buffer | Uint8Array | string) => input.push(Buffer.from(chunk)));
    function close(code: number | null): void {
        if (closed) {
            return;
        }
        closed = true;
        emitter.emit('close', code, code === null ? 'SIGKILL' : null);
    }
    Object.assign(emitter, {
        stdin,
        stdout,
        stderr,
        kill: (signal?: NodeJS.Signals | number) => {
            killCalls.push(signal);
            queueMicrotask(() => {
                close(null);
            });
            return true;
        },
    });
    return Object.freeze({
        child: emitter as ChildProcessWithoutNullStreams,
        stdout,
        stderr,
        stdinBytes: () => Buffer.concat(input),
        close,
        killCalls,
    });
}

export function fakeSpawner(
    behavior: (control: FakeChildControl) => void,
    capture?: (command: string, args: ReadonlyArray<string>, options: Parameters<ReasonerSpawner>[2]) => void,
): ReasonerSpawner {
    return (command, args, options) => {
        const control = makeFakeChild();
        capture?.(command, args, options);
        queueMicrotask(() => {
            behavior(control);
        });
        return control.child;
    };
}
