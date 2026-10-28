import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
    getExactRegistryRelease,
    queryRegistryRelease,
    readStoredCliCredential,
    RegistryClientError,
    resolveRegistryAlias,
    type GetExactRegistryReleaseRequest,
    type QueryRegistryReleaseRequest,
    type RegistryReleaseQueryOutcome,
    type ResolveRegistryAliasRequest,
    type StoredCliCredentialRevision,
} from '@erden/client';
import {
    RELEASE_QUERY_LIMITS,
    decodePublicationExactVersion,
    isCanonicalOntologyIri,
    isScopedAlias,
    normalizeRegistryOrigin,
    parseCliCredential,
    type RegistryAliasResolutionV1,
    type RegistryReleaseIndexEntryV1,
    type ReleaseQueryResultEnvelopeV1,
    type ReleaseQueryResultTerm,
} from '@erden/contracts';
import { loadManifest } from '@erden/project';

import { CliRegistryUsageError, HTTP_CREDENTIAL_WARNING, terminalText, type CliRegistryTextSink } from './registry.js';

const MAXIMUM_QUERY_BYTES = RELEASE_QUERY_LIMITS.maxQueryBytes;

export interface CliQueryRuntime {
    readonly readCredential: (registryOrigin: string) => StoredCliCredentialRevision | null;
    readonly resolveAlias: (input: ResolveRegistryAliasRequest) => Promise<RegistryAliasResolutionV1>;
    readonly getExactRelease: (input: GetExactRegistryReleaseRequest) => Promise<RegistryReleaseIndexEntryV1>;
    readonly query: (input: QueryRegistryReleaseRequest) => Promise<RegistryReleaseQueryOutcome>;
    /** Read at most `maximum + 1` bytes from a regular file without following a final symbolic link. */
    readonly readFile: (path: string, maximum: number) => Promise<Uint8Array>;
    /** Read at most `maximum + 1` bytes from standard input. */
    readonly readStdin: (maximum: number) => Promise<Uint8Array>;
    readonly now: () => number;
}

export interface CliQueryCommandContext {
    readonly cwd: () => string;
    readonly stdout: CliRegistryTextSink;
    readonly stderr: CliRegistryTextSink;
    readonly query?: CliQueryRuntime;
}

interface QueryArguments {
    readonly identifier: string;
    readonly version: string;
    readonly source: Readonly<{ kind: 'file'; path: string }> | Readonly<{ kind: 'stdin' }>;
    readonly registry?: string;
    readonly output: 'table' | 'json' | 'sparql-json';
}

class QueryRefused extends Error {
    readonly code: string;
    readonly reason: string | null;
    constructor(code: string, reason: string | null) {
        super(code);
        this.code = code;
        this.reason = reason;
    }
}

class QueryFailed extends Error {
    readonly code: string;
    constructor(code: string) {
        super(code);
        this.code = code;
    }
}

function splitSpecification(input: string): Readonly<{ identifier: string; version: string }> {
    for (let index = input.lastIndexOf('@'); index > 0; index = input.lastIndexOf('@', index - 1)) {
        const identifier = input.slice(0, index);
        if (isScopedAlias(identifier) || isCanonicalOntologyIri(identifier)) {
            try {
                return Object.freeze({ identifier, version: decodePublicationExactVersion(input.slice(index + 1)) });
            } catch {
                break;
            }
        }
    }
    throw new CliRegistryUsageError('query requires <identifier>@<exact-version>');
}

function canonicalRegistry(value: string): string {
    try {
        if (normalizeRegistryOrigin(value) !== value) {
            throw new Error();
        }
        return value;
    } catch {
        throw new CliRegistryUsageError('--registry must be one canonical HTTP(S) origin');
    }
}

function parseQueryArguments(arguments_: ReadonlyArray<string>): QueryArguments {
    const positional: string[] = [];
    const seen = new Set<string>();
    let file: string | undefined;
    let registry: string | undefined;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--offline') {
            throw new CliRegistryUsageError('query runs on the registry and cannot be used with --offline');
        }
        if (['--stdin', '--json', '--sparql-json', '--file', '--registry'].includes(argument)) {
            if (seen.has(argument)) {
                throw new CliRegistryUsageError(`${argument} may be specified only once`);
            }
            seen.add(argument);
        }
        if (argument === '--file' || argument === '--registry') {
            const value = arguments_[index + 1];
            if (value === undefined || value.startsWith('-')) {
                throw new CliRegistryUsageError(`${argument} requires a value`);
            }
            if (argument === '--file') {
                file = value;
            } else {
                registry = canonicalRegistry(value);
            }
            index += 1;
        } else if (argument.startsWith('-') && !seen.has(argument)) {
            throw new CliRegistryUsageError(`unknown query flag: ${argument}`);
        } else if (!argument.startsWith('-')) {
            positional.push(argument);
        }
    }
    if (positional.length !== 1) {
        throw new CliRegistryUsageError('query requires exactly one <identifier>@<exact-version>');
    }
    if ((file === undefined) === !seen.has('--stdin')) {
        throw new CliRegistryUsageError('query requires exactly one of --file <path> or --stdin');
    }
    if (seen.has('--json') && seen.has('--sparql-json')) {
        throw new CliRegistryUsageError('--json and --sparql-json cannot be combined');
    }
    return Object.freeze({
        ...splitSpecification(positional[0] as string),
        source: file === undefined ? { kind: 'stdin' as const } : { kind: 'file' as const, path: file },
        ...(registry === undefined ? {} : { registry }),
        output: seen.has('--json') ? 'json' : seen.has('--sparql-json') ? 'sparql-json' : 'table',
    });
}

function queryOrigin(explicit: string | undefined, cwd: string): string {
    if (explicit !== undefined) {
        return explicit;
    }
    let registry: string | undefined;
    try {
        registry = loadManifest({ from: cwd }).manifest.registry;
    } catch {
        registry = undefined;
    }
    if (registry === undefined || normalizeRegistryOrigin(registry) !== registry) {
        throw new CliRegistryUsageError('query requires --registry or a nearest project registry');
    }
    return registry;
}

function optionalBearer(runtime: CliQueryRuntime, origin: string, stderr: CliRegistryTextSink): string | undefined {
    const revision = runtime.readCredential(origin);
    if (revision === null) {
        return undefined;
    }
    const now = runtime.now();
    if (
        revision.value.origin !== origin ||
        parseCliCredential(revision.value.credential) === null ||
        !Number.isSafeInteger(now) ||
        revision.value.expiresAt <= now
    ) {
        throw new QueryFailed('CLI_QUERY_UNAUTHORIZED');
    }
    if (origin.startsWith('http://')) {
        stderr.write(`${HTTP_CREDENTIAL_WARNING}\n`);
    }
    return revision.value.credential;
}

async function queryBytes(options: QueryArguments, context: CliQueryCommandContext, runtime: CliQueryRuntime) {
    const bytes =
        options.source.kind === 'file'
            ? await runtime.readFile(resolve(context.cwd(), options.source.path), MAXIMUM_QUERY_BYTES)
            : await runtime.readStdin(MAXIMUM_QUERY_BYTES);
    if (bytes.byteLength > MAXIMUM_QUERY_BYTES) {
        throw new QueryRefused('RELEASE_QUERY_TOO_LARGE', 'query-too-large');
    }
    if (bytes.byteLength === 0) {
        throw new CliRegistryUsageError('query text is empty');
    }
    return bytes;
}

async function concealed<Value>(operation: () => Promise<Value>): Promise<Value> {
    try {
        return await operation();
    } catch (cause) {
        if (cause instanceof RegistryClientError && cause.code === 'CLIENT_NOT_FOUND') {
            throw new QueryRefused('RELEASE_QUERY_NOT_FOUND', null);
        }
        throw cause;
    }
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function termText(term: ReleaseQueryResultTerm | undefined): string {
    if (term === undefined) {
        return '';
    }
    if (term.type === 'uri') {
        return `<${term.value}>`;
    }
    if (term.type === 'bnode') {
        return `_:${term.value}`;
    }
    const lexical = `"${term.value}"`;
    return term['xml:lang'] !== undefined
        ? `${lexical}@${term['xml:lang']}`
        : term.datatype !== undefined
          ? `${lexical}^^<${term.datatype}>`
          : lexical;
}

/** Alignment counts graphemes; terminal escaping has already made every cell printable. */
function displayWidth(text: string): number {
    return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)).length;
}

function renderTable(envelope: ReleaseQueryResultEnvelopeV1): string {
    const result = envelope.result;
    if ('boolean' in result) {
        return `${String(result.boolean)}\n`;
    }
    const columns = result.head.vars;
    const rows = result.results.bindings.map((binding) =>
        columns.map((name) => terminalText(termText(Object.hasOwn(binding, name) ? binding[name] : undefined))),
    );
    const header = columns.map((name) => `?${name}`);
    const widths = header.map((name, column) =>
        Math.max(displayWidth(name), ...rows.map((row) => displayWidth(row[column] ?? ''))),
    );
    function line(cells: ReadonlyArray<string>): string {
        return cells
            .map((cell, column) => cell.padEnd(widths[column] ?? 0))
            .join(' | ')
            .trimEnd();
    }
    const table = columns.length === 0 ? '' : `${[line(header), ...rows.map(line)].join('\n')}\n`;
    const count = result.results.bindings.length;
    return `${table}${String(count)} ${count === 1 ? 'row' : 'rows'}\n`;
}

function bindingLine(envelope: ReleaseQueryResultEnvelopeV1): string {
    const binding = envelope.binding;
    return `Release ${terminalText(binding.release.canonicalIri)}@${terminalText(binding.release.version)} archive ${binding.release.archiveSha256} dataset ${binding.dataset.sha256} query ${envelope.query.sha256} result ${envelope.resultSha256}\n`;
}

/**
 * JSON already escapes C0 controls; C1 controls, bidirectional controls, and line separators pass through and can
 * drive a terminal. They only occur inside JSON strings, so a `\\u` escape keeps the document JSON-equal.
 */
function terminalSafeJson(text: string): string {
    return text.replace(
        /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

function render(options: QueryArguments, envelope: ReleaseQueryResultEnvelopeV1, bytes: Uint8Array): string {
    if (options.output === 'json') {
        return terminalSafeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    const result = `${canonicalJson(envelope.result)}\n`;
    if (createHash('sha256').update(result).digest('hex') !== envelope.resultSha256) {
        throw new QueryFailed('CLI_QUERY_FAILED');
    }
    return options.output === 'sparql-json'
        ? terminalSafeJson(result)
        : `${renderTable(envelope)}${bindingLine(envelope)}`;
}

async function execute(
    options: QueryArguments,
    context: CliQueryCommandContext,
    runtime: CliQueryRuntime,
    signal: AbortSignal,
): Promise<number> {
    const registryOrigin = queryOrigin(options.registry, context.cwd());
    const query = await queryBytes(options, context, runtime);
    const bearer = optionalBearer(runtime, registryOrigin, context.stderr);
    const credential = bearer === undefined ? {} : { bearer };
    const canonicalIri = isScopedAlias(options.identifier)
        ? (
              await concealed(
                  async () =>
                      await runtime.resolveAlias({ registryOrigin, alias: options.identifier, signal, ...credential }),
              )
          ).canonicalIri
        : options.identifier;
    const exact = await concealed(
        async () =>
            await runtime.getExactRelease({
                registryOrigin,
                canonicalIri,
                version: options.version,
                signal,
                ...credential,
            }),
    );
    const outcome = await runtime.query({
        registryOrigin,
        canonicalIri: exact.canonicalIri,
        version: exact.release.version,
        archiveSha256: exact.release.archiveSha256,
        query,
        signal,
        ...credential,
    });
    if (outcome.kind === 'refused') {
        if (outcome.status === 503) {
            throw new QueryFailed(outcome.code);
        }
        throw new QueryRefused(outcome.code, outcome.reason);
    }
    context.stdout.write(render(options, outcome.envelope, outcome.bytes));
    return 0;
}

function failureCode(cause: unknown, signal: AbortSignal): string {
    if (cause instanceof QueryFailed) {
        return cause.code;
    }
    if (signal.aborted || (cause instanceof RegistryClientError && cause.code === 'CLIENT_TIMEOUT')) {
        return 'CLI_QUERY_TIMEOUT';
    }
    if (cause instanceof RegistryClientError) {
        if (cause.code === 'CLIENT_UNAUTHORIZED') {
            return 'CLI_QUERY_UNAUTHORIZED';
        }
        if (cause.code === 'CLIENT_NOT_FOUND') {
            return 'CLI_QUERY_UNSUPPORTED';
        }
    }
    return 'CLI_QUERY_FAILED';
}

/** `erden query`: one bounded read-only query over one exact registry release. Query text never comes from argv. */
export async function runQueryCommand(
    arguments_: ReadonlyArray<string>,
    context: CliQueryCommandContext,
): Promise<number> {
    const options = parseQueryArguments(arguments_);
    const runtime = context.query;
    if (runtime === undefined) {
        context.stderr.write('Erden query could not complete [CLI_QUERY_FAILED]\n');
        return 3;
    }
    const cancellation = new AbortController();
    const timer = setTimeout(() => {
        cancellation.abort();
    }, RELEASE_QUERY_LIMITS.requestMilliseconds + 30_000);
    timer.unref();
    try {
        return await execute(options, context, runtime, cancellation.signal);
    } catch (cause) {
        if (cause instanceof CliRegistryUsageError) {
            throw cause;
        }
        if (cause instanceof QueryRefused) {
            context.stderr.write(
                `Erden query refused [${cause.code}${cause.reason === null ? '' : `: ${cause.reason}`}]\n`,
            );
            return 1;
        }
        context.stderr.write(`Erden query could not complete [${failureCode(cause, cancellation.signal)}]\n`);
        return 3;
    } finally {
        clearTimeout(timer);
    }
}

async function readBounded(handle: FileHandle, maximum: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(maximum + 1);
    let length = 0;
    while (length < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, null);
        if (bytesRead === 0) {
            break;
        }
        length += bytesRead;
    }
    return buffer.slice(0, length);
}

/** Regular files only: a symbolic link, device, FIFO, or a file replaced between checks is refused. */
export async function readCliQueryFile(path: string, maximum: number): Promise<Uint8Array> {
    let handle: FileHandle | undefined;
    try {
        const before = await lstat(path, { bigint: true });
        if (!before.isFile()) {
            throw new QueryFailed('CLI_QUERY_FILE_INVALID');
        }
        handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new QueryFailed('CLI_QUERY_FILE_INVALID');
        }
        return await readBounded(handle, maximum);
    } catch {
        throw new QueryFailed('CLI_QUERY_FILE_INVALID');
    } finally {
        await handle?.close();
    }
}

/** Reads standard input until end, stopping one byte past the limit so oversize input is detected, not truncated. */
export async function readCliQueryStdin(maximum: number): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        chunks.push(bytes);
        length += bytes.byteLength;
        if (length > maximum) {
            process.stdin.destroy();
            break;
        }
    }
    return Buffer.concat(chunks, length).subarray(0, Math.min(length, maximum + 1));
}

export const nodeCliQueryRuntime: CliQueryRuntime = Object.freeze({
    readCredential: (registryOrigin: string) => readStoredCliCredential(registryOrigin),
    resolveAlias: async (input: ResolveRegistryAliasRequest) => await resolveRegistryAlias(input),
    getExactRelease: async (input: GetExactRegistryReleaseRequest) => await getExactRegistryRelease(input),
    query: async (input: QueryRegistryReleaseRequest) => await queryRegistryRelease(input),
    readFile: readCliQueryFile,
    readStdin: readCliQueryStdin,
    now: () => Date.now(),
});
