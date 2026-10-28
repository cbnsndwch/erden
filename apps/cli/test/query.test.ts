import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    RegistryClientError,
    type QueryRegistryReleaseRequest,
    type RegistryReleaseQueryOutcome,
    type StoredCliCredentialRevision,
} from '@erden/client';
import {
    decodeReleaseQueryResultEnvelope,
    normalizeManifestV1,
    serializeManifestV1,
    type ReleaseQueryResultEnvelopeV1,
} from '@erden/contracts';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { CLI_EXIT, runCli, type CliRuntime, type CliServices } from '../src/main.js';
import { readCliQueryFile, type CliQueryRuntime } from '../src/query.js';

const ORIGIN = 'https://registry.example.test';
const IRI = 'https://example.test/query';
const ALIAS = '@example/query';
const ARCHIVE = 'a'.repeat(64);
const BEARER = 'erden_cli_v1_d1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const QUERY = 'SELECT ?c ?label WHERE { ?c <http://www.w3.org/2000/01/rdf-schema#label> ?label }';
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

function tempRoot(): string {
    const root = makeTestTempRoot('erden-cli-query-');
    roots.push(root);
    return root;
}

function sortedJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(sortedJson).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function envelope(result: unknown, form: 'select' | 'ask' = 'select'): ReleaseQueryResultEnvelopeV1 {
    return decodeReleaseQueryResultEnvelope({
        schema: 'erden.release-query-result/v1',
        binding: {
            release: { registryOrigin: ORIGIN, canonicalIri: IRI, version: '1.2.3', archiveSha256: ARCHIVE },
            evidence: { kind: 'comparison-profile', sha256: 'b'.repeat(64) },
            dataset: { sha256: 'c'.repeat(64), quadCounts: { declared: 4, inferred: 1 } },
            toolchain: {
                reasoner: { version: '1.0.0', sha256: 'd'.repeat(64) },
                validator: { version: '1.0.0', sha256: 'e'.repeat(64) },
            },
            reasoningProfile: { id: 'erden.reasoning/v1', sha256: 'f'.repeat(64) },
            engine: { name: 'oxigraph', version: '0.5.9', wasmSha256: '1'.repeat(64) },
            policy: { id: 'erden.release-query-policy/v1', sha256: '2'.repeat(64) },
        },
        query: { form, sha256: '3'.repeat(64) },
        result,
        resultSha256: createHash('sha256')
            .update(`${sortedJson(result)}\n`)
            .digest('hex'),
    });
}

const SELECT = envelope({
    head: { vars: ['c', 'label'] },
    results: {
        bindings: [
            {
                c: { type: 'uri', value: 'https://example.test/query#Root' },
                label: { type: 'literal', value: 'Root\u001b[31m\u202e\u009b', 'xml:lang': 'en' },
            },
            { c: { type: 'bnode', value: 'b0' } },
        ],
    },
});

function complete(value: ReleaseQueryResultEnvelopeV1): RegistryReleaseQueryOutcome {
    return {
        kind: 'complete',
        envelope: value,
        bytes: new TextEncoder().encode(`${sortedJson(value)}\n`),
    };
}

interface Harness {
    readonly runtime: CliRuntime;
    readonly stdout: string[];
    readonly stderr: string[];
    readonly queries: QueryRegistryReleaseRequest[];
    readonly calls: string[];
}

function harness(
    options: Readonly<{
        cwd?: string;
        outcome?: RegistryReleaseQueryOutcome | Error;
        credential?: StoredCliCredentialRevision | null;
        stdin?: Uint8Array;
        aliasMissing?: boolean;
    }> = {},
): Harness {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const queries: QueryRegistryReleaseRequest[] = [];
    const calls: string[] = [];
    const query: CliQueryRuntime = {
        readCredential: () => options.credential ?? null,
        resolveAlias: (input) => {
            calls.push(`alias:${input.alias}:${input.bearer ?? '-'}`);
            if (options.aliasMissing === true) {
                return Promise.reject(new RegistryClientError('CLIENT_NOT_FOUND'));
            }
            return Promise.resolve({
                schema: 'erden.registry-alias-resolution/v1',
                registryOrigin: input.registryOrigin,
                alias: input.alias,
                canonicalIri: IRI,
            });
        },
        getExactRelease: (input) => {
            calls.push(`exact:${input.canonicalIri}@${input.version}:${input.bearer ?? '-'}`);
            return Promise.resolve({
                schema: 'erden.registry-release-index-entry/v1',
                registryOrigin: input.registryOrigin,
                canonicalIri: input.canonicalIri,
                release: {
                    version: input.version,
                    archiveSha256: ARCHIVE,
                    toolchain: {
                        reasoner: { version: '1.0.0', sha256: 'd'.repeat(64) },
                        validator: { version: '1.0.0', sha256: 'e'.repeat(64) },
                    },
                    dependencies: [],
                },
            } as never);
        },
        query: (input) => {
            queries.push(input);
            const outcome = options.outcome ?? complete(SELECT);
            return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
        },
        readFile: readCliQueryFile,
        readStdin: (maximum) =>
            Promise.resolve((options.stdin ?? new TextEncoder().encode(QUERY)).slice(0, maximum + 1)),
        now: () => 1_000,
    };
    const unused = new Proxy({}, { get: () => () => undefined }) as unknown as CliServices;
    return {
        stdout,
        stderr,
        queries,
        calls,
        runtime: {
            cwd: () => options.cwd ?? '/',
            stdout: { write: (text) => stdout.push(text) },
            stderr: { write: (text) => stderr.push(text) },
            services: unused,
            query,
        },
    };
}

describe('erden query', () => {
    it('resolves an alias, binds the exact archive, and prints an escaped table with a binding line', async () => {
        const run = harness();
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], run.runtime)).toBe(
            CLI_EXIT.success,
        );
        expect(run.calls).toEqual([`alias:${ALIAS}:-`, `exact:${IRI}@1.2.3:-`]);
        expect(run.queries).toHaveLength(1);
        expect(run.queries[0]).toMatchObject({
            registryOrigin: ORIGIN,
            canonicalIri: IRI,
            version: '1.2.3',
            archiveSha256: ARCHIVE,
        });
        expect(new TextDecoder().decode(run.queries[0]?.query)).toBe(QUERY);
        expect(run.queries[0]?.bearer).toBeUndefined();
        const output = run.stdout.join('');
        expect(output).toContain('?c');
        expect(output).toContain('<https://example.test/query#Root>');
        expect(output).toContain('"Root\\u001b[31m\\u202e\\u009b"@en');
        expect(output).toContain('_:b0');
        expect(output).toContain('2 rows\n');
        expect(output).toContain(`Release ${IRI}@1.2.3 archive ${ARCHIVE} dataset ${'c'.repeat(64)}`);
        expect(output).not.toMatch(/[\u001b\u202e\u009b]/u);
        expect(run.stderr).toEqual([]);
    });

    it('prints the verbatim envelope with --json and the canonical result with --sparql-json', async () => {
        const json = harness();
        expect(await runCli(['query', `${IRI}@1.2.3`, '--stdin', '--registry', ORIGIN, '--json'], json.runtime)).toBe(
            0,
        );
        expect(json.calls).toEqual([`exact:${IRI}@1.2.3:-`]);
        expect(JSON.parse(json.stdout.join(''))).toEqual(JSON.parse(sortedJson(SELECT)));
        expect(json.stdout.join('')).not.toMatch(/[\u001b\u202e\u009b]/u);
        expect(json.stdout.join('')).toContain('\\u202e\\u009b');
        const sparql = harness();
        expect(
            await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN, '--sparql-json'], sparql.runtime),
        ).toBe(0);
        expect(JSON.parse(sparql.stdout.join(''))).toEqual(JSON.parse(sortedJson(SELECT.result)));
        expect(sparql.stdout.join('')).not.toMatch(/[\u202e\u009b]/u);
        const ask = harness({ outcome: complete(envelope({ head: {}, boolean: true }, 'ask')) });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], ask.runtime)).toBe(0);
        expect(ask.stdout.join('')).toMatch(/^true\nRelease /u);
    });

    it.each([
        [
            { kind: 'refused', status: 422, code: 'RELEASE_QUERY_REJECTED', reason: 'service-forbidden' },
            1,
            '[RELEASE_QUERY_REJECTED: service-forbidden]',
        ],
        [
            { kind: 'refused', status: 422, code: 'RELEASE_QUERY_LIMIT_EXCEEDED', reason: 'row-limit' },
            1,
            '[RELEASE_QUERY_LIMIT_EXCEEDED: row-limit]',
        ],
        [
            { kind: 'refused', status: 409, code: 'RELEASE_QUERY_DATASET_UNAVAILABLE', reason: 'dataset-missing' },
            1,
            '[RELEASE_QUERY_DATASET_UNAVAILABLE: dataset-missing]',
        ],
        [
            { kind: 'refused', status: 404, code: 'RELEASE_QUERY_NOT_FOUND', reason: null },
            1,
            '[RELEASE_QUERY_NOT_FOUND]',
        ],
        [{ kind: 'refused', status: 503, code: 'RELEASE_QUERY_BUSY', reason: null }, 3, '[RELEASE_QUERY_BUSY]'],
        [new RegistryClientError('CLIENT_UNAUTHORIZED'), 3, '[CLI_QUERY_UNAUTHORIZED]'],
        [new RegistryClientError('CLIENT_NOT_FOUND'), 3, '[CLI_QUERY_UNSUPPORTED]'],
        [new RegistryClientError('CLIENT_TIMEOUT'), 3, '[CLI_QUERY_TIMEOUT]'],
        [new RegistryClientError('CLIENT_RESPONSE_INVALID'), 3, '[CLI_QUERY_FAILED]'],
    ] as const)('maps %o to exit %i', async (outcome, code, message) => {
        const run = harness({ outcome: outcome as RegistryReleaseQueryOutcome | Error });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], run.runtime)).toBe(code);
        expect(run.stdout).toEqual([]);
        expect(run.stderr.join('')).toContain(message);
        expect(run.stderr.join('')).not.toContain('SELECT');
    });

    it('conceals a missing alias as not found without running a query', async () => {
        const run = harness({ aliasMissing: true });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], run.runtime)).toBe(1);
        expect(run.stderr).toEqual(['Erden query refused [RELEASE_QUERY_NOT_FOUND]\n']);
        expect(run.queries).toEqual([]);
    });

    it('uses a valid stored credential for every read and refuses an expired one', async () => {
        function credential(expiresAt: number, origin = ORIGIN): StoredCliCredentialRevision {
            return {
                value: { schema: 'erden.cli-credential/v1', origin, credential: BEARER, expiresAt },
            } as StoredCliCredentialRevision;
        }
        const valid = harness({ credential: credential(5_000) });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], valid.runtime)).toBe(0);
        expect(valid.calls).toEqual([`alias:${ALIAS}:${BEARER}`, `exact:${IRI}@1.2.3:${BEARER}`]);
        expect(valid.queries[0]?.bearer).toBe(BEARER);
        const expired = harness({ credential: credential(1_000) });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], expired.runtime)).toBe(3);
        expect(expired.stderr).toEqual(['Erden query could not complete [CLI_QUERY_UNAUTHORIZED]\n']);
        expect(expired.calls).toEqual([]);
        const http = harness({ credential: credential(5_000, 'http://registry.example.test') });
        expect(
            await runCli(
                ['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', 'http://registry.example.test'],
                http.runtime,
            ),
        ).toBe(0);
        expect(http.stderr.join('')).toContain('WARNING: This registry uses HTTP.');
    });

    it('reads a regular file relative to the working directory and the nearest project registry', async () => {
        const root = tempRoot();
        mkdirSync(join(root, 'queries'));
        writeFileSync(join(root, 'queries', 'classes.rq'), QUERY);
        writeFileSync(
            join(root, 'erden.config.json'),
            serializeManifestV1(
                normalizeManifestV1({
                    schemaVersion: 1,
                    canonicalIri: 'https://example.test/project',
                    alias: '@example/project',
                    ownedIriPrefixes: ['https://example.test/project#'],
                    sources: { ontology: ['ontology.ttl'] },
                    registry: ORIGIN,
                }),
                'json',
            ),
        );
        const run = harness({ cwd: root });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--file', 'queries/classes.rq'], run.runtime)).toBe(0);
        expect(new TextDecoder().decode(run.queries[0]?.query)).toBe(QUERY);
        expect(run.queries[0]?.registryOrigin).toBe(ORIGIN);
    });

    it('refuses symbolic links, FIFOs, directories, and oversized files without a request', async () => {
        const root = tempRoot();
        writeFileSync(join(root, 'target.rq'), QUERY);
        symlinkSync(join(root, 'target.rq'), join(root, 'link.rq'));
        const fifo = spawnSync('mkfifo', [join(root, 'pipe.rq')]).status === 0;
        mkdirSync(join(root, 'directory.rq'));
        writeFileSync(join(root, 'large.rq'), 'x'.repeat(8_193));
        for (const [file, code, message] of [
            ['link.rq', 3, '[CLI_QUERY_FILE_INVALID]'],
            ...(fifo ? ([['pipe.rq', 3, '[CLI_QUERY_FILE_INVALID]']] as const) : []),
            ['directory.rq', 3, '[CLI_QUERY_FILE_INVALID]'],
            ['missing.rq', 3, '[CLI_QUERY_FILE_INVALID]'],
            ['large.rq', 1, '[RELEASE_QUERY_TOO_LARGE: query-too-large]'],
        ] as const) {
            const run = harness({ cwd: root });
            expect(
                await runCli(['query', `${ALIAS}@1.2.3`, '--file', file, '--registry', ORIGIN], run.runtime),
                file,
            ).toBe(code);
            expect(run.stderr.join('')).toContain(message);
            expect(run.queries).toEqual([]);
            expect(run.calls).toEqual([]);
        }
    });

    it('refuses oversized standard input without a request', async () => {
        const run = harness({ stdin: new Uint8Array(9_000).fill(32) });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], run.runtime)).toBe(1);
        expect(run.stderr).toEqual(['Erden query refused [RELEASE_QUERY_TOO_LARGE: query-too-large]\n']);
        expect(run.calls).toEqual([]);
    });

    it.each([
        ['no source', ['query', `${ALIAS}@1.2.3`, '--registry', ORIGIN]],
        ['two sources', ['query', `${ALIAS}@1.2.3`, '--stdin', '--file', 'x.rq', '--registry', ORIGIN]],
        [
            'query text in argv',
            ['query', `${ALIAS}@1.2.3`, 'SELECT * WHERE { ?s ?p ?o }', '--stdin', '--registry', ORIGIN],
        ],
        ['a range', ['query', `${ALIAS}@^1.2.3`, '--stdin', '--registry', ORIGIN]],
        ['no version', ['query', ALIAS, '--stdin', '--registry', ORIGIN]],
        ['offline', ['query', `${ALIAS}@1.2.3`, '--stdin', '--offline']],
        ['both outputs', ['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN, '--json', '--sparql-json']],
        ['a duplicate flag', ['query', `${ALIAS}@1.2.3`, '--stdin', '--stdin', '--registry', ORIGIN]],
        ['an unknown flag', ['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN, '--query']],
        ['a noncanonical registry', ['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', `${ORIGIN}/`]],
        ['no registry', ['query', `${ALIAS}@1.2.3`, '--stdin']],
    ])('treats %s as a usage error', async (_name, arguments_) => {
        const run = harness();
        expect(await runCli(arguments_, run.runtime)).toBe(CLI_EXIT.usage);
        expect(run.stderr.join('')).toContain('Erden usage error:');
        expect(run.stderr.join('')).not.toContain('SELECT * WHERE');
        expect(run.queries).toEqual([]);
    });

    it('treats empty query text as a usage error', async () => {
        const run = harness({ stdin: new Uint8Array(0) });
        expect(await runCli(['query', `${ALIAS}@1.2.3`, '--stdin', '--registry', ORIGIN], run.runtime)).toBe(2);
        expect(run.queries).toEqual([]);
    });
});
