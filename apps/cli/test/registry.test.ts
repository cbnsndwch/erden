import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegistryClientError } from '@erden/client';
import type {
    OpenRegistryArchiveRequest,
    PublicationUploadInput,
    ResolveRegistryAliasRequest,
    StoredCliCredentialRevision,
} from '@erden/client';
import {
    decodePublicationAttemptView,
    normalizeManifestV1,
    serializeManifestV1,
    type PublicationAttemptView,
    type PublicationReportSummaryV1,
    type LockPackageNode,
} from '@erden/contracts';
import { PackProjectError, decodePackProjectReport, type PackProjectReport } from '@erden/project';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    CliRegistryUsageError,
    HTTP_CREDENTIAL_WARNING,
    makeCliDependencyRegistryComposition,
    makeNodePublicationArchiveSource,
    publicationIdempotencyKey,
    publicationReportPageUrl,
    runPublicationCommand,
    runPublishCommand,
    type CliPublicationRuntime,
    type CliDependencyRegistryRuntime,
    type CliRegistryCommandContext,
} from '../src/registry.js';

const ORIGIN = 'https://registry.example.test';
const HTTP_ORIGIN = 'http://registry.example.test';
const BEARER = 'erden_cli_v1_d1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const roots: string[] = [];

afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

function tempRoot(): string {
    const root = makeTestTempRoot('erden-cli-registry-');
    roots.push(root);
    return root;
}

function writeManifest(root: string, registry: string = ORIGIN): string {
    mkdirSync(root, { recursive: true, mode: 0o755 });
    const path = join(root, 'erden.config.json');
    writeFileSync(
        path,
        serializeManifestV1(
            normalizeManifestV1({
                schemaVersion: 1,
                canonicalIri: 'https://example.test/project',
                alias: '@example/project',
                ownedIriPrefixes: ['https://example.test/project#'],
                sources: { ontology: ['ontology.ttl'] },
                registry,
            }),
            'json',
        ),
        { mode: 0o644 },
    );
    return path;
}

function report(path: string, overrides: Partial<PackProjectReport> = {}): PackProjectReport {
    return decodePackProjectReport({
        schema: 'erden.pack-report/v1',
        project: { alias: '@example/project', canonicalIri: 'https://example.test/project' },
        version: '1.2.3',
        output: { path, status: 'written', cleanup: 'clean' },
        archive: {
            byteSize: 3,
            sha256: SHA_A,
            manifestSha256: SHA_B,
            fileCount: 1,
            directDependencyCount: 0,
        },
        outcome: 'packed',
        ...overrides,
    });
}

function attempt(
    state: PublicationAttemptView['state'] = 'queued',
    overrides: Partial<PublicationAttemptView> = {},
): PublicationAttemptView {
    const value: PublicationAttemptView = {
        attemptId: 'attempt-1',
        createdAt: 1,
        failure: state === 'failed' ? { code: 'PUBLICATION_CANDIDATE_OBJECT_INVALID', kind: 'candidate' } : null,
        project: {
            canonicalIri: 'https://example.test/project',
            preferredAlias: '@example/project',
            visibility: 'private',
        },
        release: state === 'succeeded' ? { archiveSha256: SHA_A, byteSize: 3 } : null,
        report: state === 'failed' || state === 'succeeded' ? { byteSize: 3, sha256: SHA_B } : null,
        schema: 'erden.publication-attempt/v1',
        state,
        updatedAt: state === 'queued' ? 1 : 2,
        validationExecutions: state === 'queued' ? 0 : 1,
        version: '1.2.3',
        ...overrides,
    };
    return Object.freeze(value);
}

function succeededReport(): PublicationReportSummaryV1 {
    const value: PublicationReportSummaryV1 = {
        attemptId: 'attempt-1',
        failure: null,
        outcome: 'succeeded',
        report: { byteSize: 3, sha256: SHA_B },
        schema: 'erden.publication-report-summary/v1',
        validation: {
            status: 'passed',
            stages: {
                citations: 'passed',
                competencyQuestions: 'passed',
                core: 'passed',
                reasoning: 'passed',
                shacl: 'passed',
                sources: 'passed',
            },
            warningCount: 0,
            shaclCounts: { info: 0, violation: 0, warning: 0 },
            competencyQuestionCounts: { dormant: 0, executed: 1 },
        },
    };
    return Object.freeze(value);
}

function credential(origin = ORIGIN, expiresAt = 10000, bearer = BEARER): StoredCliCredentialRevision {
    const value: StoredCliCredentialRevision = {
        path: '/credential',
        device: 1n,
        inode: 1n,
        sha256: SHA_A,
        value: { schema: 'erden.cli-credential/v1', origin, credential: bearer, expiresAt },
    };
    return Object.freeze(value);
}

function emptySource(): ReturnType<PublicationUploadInput['open']> {
    return Object.freeze({
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield Uint8Array.of(1, 2, 3);
        },
    });
}

function runtime(overrides: Partial<CliPublicationRuntime> = {}): CliPublicationRuntime {
    return {
        readCredential: (origin) => credential(origin),
        upload: () => Promise.resolve(attempt()),
        getAttempt: () => Promise.resolve(attempt()),
        getReport: () => Promise.resolve(succeededReport()),
        archiveSource: () => Promise.resolve(emptySource),
        interactive: () => false,
        confirmCreate: () => Promise.resolve(false),
        now: () => 0,
        sleep: () => Promise.resolve(),
        ...overrides,
    };
}

function context(
    root: string,
    value: PackProjectReport,
    publication: CliPublicationRuntime,
    writeStderr?: (text: string) => void,
    packOverride?: CliRegistryCommandContext['pack']['pack'],
): Readonly<{
    context: CliRegistryCommandContext;
    stdout: string[];
    stderr: string[];
    packCalls: () => number;
}> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let packCalls = 0;
    return {
        context: {
            cwd: () => root,
            stdout: {
                write: (text) => {
                    stdout.push(text);
                },
            },
            stderr: {
                write:
                    writeStderr ??
                    ((text) => {
                        stderr.push(text);
                    }),
            },
            pack: {
                pack:
                    packOverride ??
                    (() => {
                        packCalls += 1;
                        return Effect.succeed(value);
                    }),
            },
            publication,
        },
        stdout,
        stderr,
        packCalls: () => packCalls,
    };
}

function dependencyRuntime(overrides: Partial<CliDependencyRegistryRuntime> = {}): CliDependencyRegistryRuntime {
    return {
        readCredential: (origin) => credential(origin),
        resolveAlias: ({ registryOrigin, alias }) =>
            Promise.resolve(
                Object.freeze({
                    schema: 'erden.registry-alias-resolution/v1',
                    registryOrigin,
                    alias,
                    canonicalIri: 'https://example.test/package',
                }),
            ),
        listReleases: ({ registryOrigin, canonicalIri }) =>
            Promise.resolve(
                Object.freeze({
                    schema: 'erden.registry-release-index-page/v1',
                    registryOrigin,
                    canonicalIri,
                    watermark: SHA_A,
                    pageOrdinal: 0,
                    releaseCount: 0,
                    releases: Object.freeze([]),
                    nextCursor: null,
                }),
            ),
        getExactRelease: ({ registryOrigin, canonicalIri, version }) =>
            Promise.resolve(
                Object.freeze({
                    schema: 'erden.registry-release-index-entry/v1',
                    registryOrigin,
                    canonicalIri,
                    release: Object.freeze({
                        version,
                        archiveSha256: SHA_A,
                        toolchain: Object.freeze({
                            validator: Object.freeze({ version: '1.0.0', sha256: SHA_A }),
                            reasoner: Object.freeze({ version: '1.0.0', sha256: SHA_B }),
                        }),
                        dependencies: Object.freeze([]),
                    }),
                }),
            ),
        openArchive: () =>
            Promise.resolve(
                Object.freeze({
                    sha256: SHA_A,
                    byteSize: 3,
                    bytes: Object.freeze({
                        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                            await Promise.resolve();
                            yield Uint8Array.of(1, 2, 3);
                        },
                    }),
                    close: () => Promise.resolve(),
                }),
            ),
        now: () => 0,
        ...overrides,
    };
}

describe('CLI dependency registry composition', () => {
    it('passes one validated bearer and signal to compact metadata with an immediate HTTP warning', async () => {
        const calls: ResolveRegistryAliasRequest[] = [];
        const warnings: string[] = [];
        const composition = makeCliDependencyRegistryComposition(
            dependencyRuntime({
                readCredential: () => credential(HTTP_ORIGIN),
                resolveAlias: (input) => {
                    calls.push(input);
                    return dependencyRuntime().resolveAlias(input);
                },
            }),
            {
                write: (text) => {
                    warnings.push(text);
                },
            },
        );
        const controller = new AbortController();
        await expect(
            composition.releaseIndex.resolveAlias(HTTP_ORIGIN, '@example/package', controller.signal),
        ).resolves.toMatchObject({ canonicalIri: 'https://example.test/package' });
        expect(calls).toEqual([
            expect.objectContaining({
                registryOrigin: HTTP_ORIGIN,
                alias: '@example/package',
                bearer: BEARER,
                signal: controller.signal,
            }),
        ]);
        expect(warnings).toEqual([`${HTTP_CREDENTIAL_WARNING}\n`]);
    });

    it('maps exact not-found to null and rejects an expired credential before transport', async () => {
        let calls = 0;
        const absent = makeCliDependencyRegistryComposition(
            dependencyRuntime({
                readCredential: () => null,
                getExactRelease: () => Promise.reject(new RegistryClientError('CLIENT_NOT_FOUND')),
            }),
            { write: () => undefined },
        );
        await expect(
            absent.releaseIndex.getExactRelease(ORIGIN, 'https://example.test/package', '1.0.0'),
        ).resolves.toBeNull();

        const expired = makeCliDependencyRegistryComposition(
            dependencyRuntime({
                readCredential: () => credential(ORIGIN, 1),
                now: () => 1,
                listReleases: (input) => {
                    calls += 1;
                    return dependencyRuntime().listReleases(input);
                },
            }),
            { write: () => undefined },
        );
        await expect(expired.releaseIndex.listPage(ORIGIN, 'https://example.test/package', null)).rejects.toMatchObject(
            { code: 'CLIENT_UNAUTHORIZED' },
        );
        expect(calls).toBe(0);
    });

    it('streams an exact locked archive and awaits its close', async () => {
        let closed = 0;
        const opened: OpenRegistryArchiveRequest[] = [];
        const composition = makeCliDependencyRegistryComposition(
            dependencyRuntime({
                readCredential: () => null,
                openArchive: (input) => {
                    opened.push(input);
                    return Promise.resolve(
                        Object.freeze({
                            sha256: SHA_A,
                            byteSize: 3,
                            bytes: Object.freeze({
                                async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                                    await Promise.resolve();
                                    yield Uint8Array.of(1);
                                    yield Uint8Array.of(2, 3);
                                },
                            }),
                            close: async () => {
                                await Promise.resolve();
                                closed += 1;
                            },
                        }),
                    );
                },
            }),
            { write: () => undefined },
        );
        const locked: LockPackageNode = Object.freeze({
            canonicalIri: 'https://example.test/package',
            version: '1.0.0',
            archiveSha256: SHA_A,
            toolchain: Object.freeze({
                validator: Object.freeze({ version: '1.0.0', sha256: SHA_A }),
                reasoner: Object.freeze({ version: '1.0.0', sha256: SHA_B }),
            }),
            dependencies: Object.freeze([]),
        });
        const archive = await composition.archives.fetchArchive(ORIGIN, locked);
        const chunks: number[] = [];
        for await (const chunk of archive as AsyncIterable<Uint8Array>) {
            chunks.push(...chunk);
        }
        expect(chunks).toEqual([1, 2, 3]);
        expect(opened).toEqual([
            {
                registryOrigin: ORIGIN,
                canonicalIri: locked.canonicalIri,
                version: locked.version,
                archiveSha256: locked.archiveSha256,
            },
        ]);
        expect(closed).toBe(1);
    });
});

describe('CLI publication workflow', () => {
    it('packs exactly once, binds the stable descriptor, and emits only a canonical attempt', async () => {
        const root = tempRoot();
        writeManifest(root);
        const value = report(join(root, 'project-1.2.3.erdenpkg'));
        const uploads: PublicationUploadInput[] = [];
        const captured = context(
            root,
            value,
            runtime({
                upload: (input) => {
                    uploads.push(input);
                    return Promise.resolve(attempt());
                },
            }),
        );

        expect(await runPublishCommand(['1.2.3', '--json'], captured.context)).toBe(0);
        expect(captured.packCalls()).toBe(1);
        expect(uploads).toHaveLength(1);
        expect(uploads[0]).toMatchObject({
            registryOrigin: ORIGIN,
            bearer: BEARER,
            create: false,
            archiveSha256: SHA_A,
            byteSize: 3,
        });
        expect(uploads[0]?.idempotencyKey).toBe(publicationIdempotencyKey(ORIGIN, value, false));
        expect(uploads[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(captured.stderr).toEqual([]);
        expect(JSON.parse(captured.stdout.join(''))).toMatchObject({ attemptId: 'attempt-1', state: 'queued' });
        expect(captured.stdout.join('')).not.toContain(value.output.path);
        expect(captured.stdout.join('')).not.toContain(BEARER);
        // JSON stays the closed attempt contract, with no report link added.
        expect(() => decodePublicationAttemptView(JSON.parse(captured.stdout.join('')))).not.toThrow();
        expect(captured.stdout.join('')).not.toContain('/publications/');
    });

    it('prints the canonical report page after a human publish, with the attempt colon as %3A', async () => {
        const root = tempRoot();
        writeManifest(root);
        const value = report(join(root, 'project-1.2.3.erdenpkg'));
        const captured = context(
            root,
            value,
            runtime({ upload: () => Promise.resolve(attempt('queued', { attemptId: 'attempt:uvI-plIBQUxz' })) }),
        );
        expect(await runPublishCommand(['1.2.3'], captured.context)).toBe(0);
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout).toEqual([
            'Publication attempt:uvI-plIBQUxz: queued\nProject: @example/project@1.2.3 (https://example.test/project)\nVisibility: private\nReport page: https://registry.example.test/publications/attempt%3AuvI-plIBQUxz/report\n',
        ]);
    });

    it('uses only the authenticated manifest registry and stable semantic idempotency parts', () => {
        const one = report('/tmp/first.erdenpkg');
        const two = report('/private/second.erdenpkg', {
            output: {
                path: '/private/second.erdenpkg',
                status: 'hit',
                cleanup: 'clean',
            },
        });
        expect(publicationIdempotencyKey(ORIGIN, one, 'public')).toBe(publicationIdempotencyKey(ORIGIN, two, 'public'));
        expect(publicationIdempotencyKey(ORIGIN, one, false)).not.toBe(
            publicationIdempotencyKey(ORIGIN, one, 'private'),
        );
        expect(() => publicationIdempotencyKey(`${ORIGIN}/`, one, false)).toThrow();
    });

    it('prompts with only identity and default-private visibility, while denial packs nothing', async () => {
        const root = tempRoot();
        writeManifest(root);
        const prompts: unknown[] = [];
        const captured = context(
            root,
            report(join(root, 'project-1.2.3.erdenpkg')),
            runtime({
                interactive: () => true,
                confirmCreate: (input) => {
                    prompts.push(input);
                    return Promise.resolve(false);
                },
            }),
        );

        expect(await runPublishCommand(['1.2.3', '--create'], captured.context)).toBe(0);
        expect(prompts).toEqual([
            {
                alias: '@example/project',
                canonicalIri: 'https://example.test/project',
                visibility: 'private',
            },
        ]);
        expect(captured.packCalls()).toBe(0);
        expect(captured.stdout).toEqual(['Publication cancelled.\n']);
    });

    it('requires explicit noninteractive create consent and never packs malformed creation intent', async () => {
        const root = tempRoot();
        writeManifest(root);
        const captured = context(root, report(join(root, 'project-1.2.3.erdenpkg')), runtime());
        await expect(
            runPublishCommand(['1.2.3', '--create', '--visibility', 'private'], captured.context),
        ).rejects.toBeInstanceOf(CliRegistryUsageError);
        expect(captured.packCalls()).toBe(0);
    });

    it('fails closed before packing for absent, expired, or origin-substituted credentials', async () => {
        for (const revision of [
            null,
            credential(ORIGIN, 0),
            credential('https://foreign.example.test'),
            credential(ORIGIN, 10_000, 'malformed-credential'),
        ]) {
            const root = tempRoot();
            writeManifest(root);
            const captured = context(
                root,
                report(join(root, 'project-1.2.3.erdenpkg')),
                runtime({
                    readCredential: () => revision,
                }),
            );
            expect(await runPublishCommand(['1.2.3'], captured.context)).toBe(3);
            expect(captured.packCalls()).toBe(0);
            expect(captured.stdout).toEqual([]);
            expect(captured.stderr).toEqual(['Erden publish could not complete [CLI_PUBLISH_FAILED]\n']);
        }
        const root = tempRoot();
        writeManifest(root);
        const malformed = context(
            root,
            report(join(root, 'project-1.2.3.erdenpkg')),
            runtime({
                readCredential: () => {
                    throw new Error('malformed credential file');
                },
            }),
        );
        expect(await runPublishCommand(['1.2.3'], malformed.context)).toBe(3);
        expect(malformed.packCalls()).toBe(0);
    });

    it('stops before upload with the packing refusal and its remedy when the erden.lock is stale', async () => {
        const root = tempRoot();
        writeManifest(root);
        let uploads = 0;
        const captured = context(
            root,
            report(join(root, 'project-1.2.3.erdenpkg')),
            runtime({
                upload: () => {
                    uploads += 1;
                    return Promise.resolve(attempt());
                },
            }),
            undefined,
            () =>
                Effect.fail(
                    new PackProjectError(
                        'PACK_PROJECT_LOCK_INVALID',
                        'A canonical manifest-consistent erden.lock is required; run erden install first',
                    ),
                ),
        );
        expect(await runPublishCommand(['1.2.3'], captured.context)).toBe(3);
        expect(uploads).toBe(0);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toEqual([
            'Erden publish could not complete [CLI_PUBLISH_FAILED]\nErden pack failed [PACK_PROJECT_LOCK_INVALID]: A canonical manifest-consistent erden.lock is required; run erden install first\n',
        ]);
    });

    it('warns immediately before the first HTTP bearer request and does not retry not-found implicitly', async () => {
        const root = tempRoot();
        writeManifest(root, HTTP_ORIGIN);
        const events: string[] = [];
        const value = report(join(root, 'project-1.2.3.erdenpkg'));
        let uploads = 0;
        const captured = context(
            root,
            value,
            runtime({
                readCredential: () => credential(HTTP_ORIGIN),
                upload: () => {
                    uploads += 1;
                    events.push('request');
                    return Promise.reject(new Error('not found'));
                },
            }),
            (text) => {
                events.push(`stderr:${text}`);
            },
        );

        expect(await runPublishCommand(['1.2.3'], captured.context)).toBe(3);
        expect(uploads).toBe(1);
        expect(events).toEqual([
            'stderr:WARNING: This registry uses HTTP. Authentication secrets may be intercepted or altered in transit.\n',
            'request',
            'stderr:Erden publish could not complete [CLI_PUBLISH_FAILED]\n',
        ]);
    });

    it('rejects post-pack manifest drift and substituted response identity', async () => {
        const root = tempRoot();
        const manifestPath = writeManifest(root);
        const value = report(join(root, 'project-1.2.3.erdenpkg'));
        const drifted = context(root, value, runtime(), undefined, () => {
            writeFileSync(manifestPath, '{}\n');
            return Effect.succeed(value);
        });
        expect(await runPublishCommand(['1.2.3'], drifted.context)).toBe(3);

        writeManifest(root);
        const substituted = context(
            root,
            value,
            runtime({
                upload: () =>
                    Promise.resolve(
                        attempt('queued', {
                            project: { ...attempt().project, canonicalIri: 'https://foreign.example.test/project' },
                        }),
                    ),
            }),
        );
        expect(await runPublishCommand(['1.2.3'], substituted.context)).toBe(3);
    });

    it('bounds and cancels a stalled upload without leaking credentials or paths', async () => {
        vi.useFakeTimers();
        const root = tempRoot();
        writeManifest(root);
        const value = report(join(root, 'secret-project-1.2.3.erdenpkg'));
        let observed: AbortSignal | undefined;
        const captured = context(
            root,
            value,
            runtime({
                upload: ({ signal }) =>
                    new Promise((_resolve, reject) => {
                        observed = signal;
                        signal?.addEventListener(
                            'abort',
                            () => {
                                reject(new Error('cancelled'));
                            },
                            { once: true },
                        );
                    }),
            }),
        );
        const pending = runPublishCommand(['1.2.3'], captured.context);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
        expect(await pending).toBe(3);
        expect(observed?.aborted).toBe(true);
        expect(captured.stderr.join('')).not.toContain(BEARER);
        expect(captured.stderr.join('')).not.toContain(value.output.path);
    });

    it('preserves a terminal failed replay as a completed semantic result', async () => {
        const root = tempRoot();
        writeManifest(root);
        const captured = context(
            root,
            report(join(root, 'project-1.2.3.erdenpkg')),
            runtime({
                upload: () => Promise.resolve(attempt('failed')),
            }),
        );
        expect(await runPublishCommand(['1.2.3', '--json'], captured.context)).toBe(1);
        expect(JSON.parse(captured.stdout.join(''))).toMatchObject({ state: 'failed' });
        expect(captured.stderr).toEqual([]);
    });
});

describe('CLI publication archive source', () => {
    it('reopens stable bytes and rejects mutation, path swap, and hard links', async () => {
        const root = tempRoot();
        const path = join(root, 'archive.erdenpkg');
        const bytes = Buffer.alloc(70_000, 7);
        writeFileSync(path, bytes);
        const value = report(path, {
            archive: {
                byteSize: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                manifestSha256: SHA_B,
                fileCount: 1,
                directDependencyCount: 0,
            },
        });
        const stable = await makeNodePublicationArchiveSource(value);
        const received: Uint8Array[] = [];
        for await (const chunk of await stable()) {
            received.push(chunk.slice());
        }
        expect(Buffer.concat(received)).toEqual(bytes);

        writeFileSync(path, Buffer.alloc(bytes.byteLength, 8));
        await expect(async () => {
            for await (const chunk of await stable()) {
                if (chunk.byteLength === 0) {
                    throw new Error('empty chunk');
                }
            }
        }).rejects.toThrow('publication archive changed');

        writeFileSync(path, bytes);
        const swappable = await makeNodePublicationArchiveSource(value);
        renameSync(path, join(root, 'original.erdenpkg'));
        writeFileSync(path, bytes);
        await expect(async () => {
            for await (const chunk of await swappable()) {
                if (chunk.byteLength === 0) {
                    throw new Error('empty chunk');
                }
            }
        }).rejects.toThrow('publication archive changed');

        const linkedPath = join(root, 'linked.erdenpkg');
        linkSync(path, linkedPath);
        await expect(
            makeNodePublicationArchiveSource(
                report(linkedPath, {
                    archive: {
                        byteSize: bytes.byteLength,
                        sha256: createHash('sha256').update(bytes).digest('hex'),
                        manifestSha256: SHA_B,
                        fileCount: 1,
                        directDependencyCount: 0,
                    },
                }),
            ),
        ).rejects.toThrow('unsafe publication archive');
    });
});

describe('CLI publication status workflow', () => {
    it('polls at a fixed interval to terminal state and emits only compact canonical report output', async () => {
        const root = tempRoot();
        const sequence = [attempt(), attempt('succeeded')];
        const sleeps: number[] = [];
        const signals: AbortSignal[] = [];
        let now = 0;
        const captured = context(
            root,
            report(join(root, 'unused.erdenpkg')),
            runtime({
                getAttempt: ({ signal }) => {
                    if (signal !== undefined) {
                        signals.push(signal);
                    }
                    return Promise.resolve(sequence.shift() ?? attempt('succeeded'));
                },
                getReport: ({ signal }) => {
                    if (signal !== undefined) {
                        signals.push(signal);
                    }
                    return Promise.resolve(succeededReport());
                },
                now: () => now,
                sleep: (milliseconds, signal) => {
                    if (signal !== undefined) {
                        signals.push(signal);
                    }
                    sleeps.push(milliseconds);
                    now += milliseconds;
                    return Promise.resolve();
                },
            }),
        );
        expect(
            await runPublicationCommand(
                ['attempt-1', '--registry', ORIGIN, '--wait', '--report', '--json'],
                captured.context,
            ),
        ).toBe(0);
        expect(sleeps).toEqual([1_000]);
        expect(signals).toHaveLength(4);
        expect(signals.every((signal) => signal === signals[0] && !signal.aborted)).toBe(true);
        const output = JSON.parse(captured.stdout.join('')) as Record<string, unknown>;
        expect(output).toMatchObject({ schema: 'erden.cli-publication/v1' });
        expect(output).toHaveProperty('attempt.state', 'succeeded');
        expect(output).toHaveProperty('report.outcome', 'succeeded');
        for (const forbidden of ['credential', 'worker', 'internalRef', 'objectKey', '/private/']) {
            expect(captured.stdout.join('')).not.toContain(forbidden);
        }
    });

    it('aborts a stalled status read at the fixed command deadline without another request or residue', async () => {
        vi.useFakeTimers();
        const root = tempRoot();
        let calls = 0;
        let reports = 0;
        let aborts = 0;
        let listenerActive = false;
        let observed: AbortSignal | undefined;
        const captured = context(
            root,
            report(join(root, 'unused.erdenpkg')),
            runtime({
                getAttempt: ({ signal }) => {
                    calls += 1;
                    observed = signal;
                    return new Promise((_resolve, reject) => {
                        function aborted(): void {
                            aborts += 1;
                            listenerActive = false;
                            signal?.removeEventListener('abort', aborted);
                            reject(new Error(`cancelled ${BEARER} /private/status`));
                        }
                        listenerActive = true;
                        if (signal?.aborted === true) {
                            aborted();
                        } else {
                            signal?.addEventListener('abort', aborted, { once: true });
                        }
                    });
                },
                getReport: () => {
                    reports += 1;
                    return Promise.resolve(succeededReport());
                },
            }),
        );

        const pending = runPublicationCommand(
            ['attempt-1', '--registry', ORIGIN, '--wait', '--report'],
            captured.context,
        );
        await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1);
        expect({ calls, reports, aborts, listenerActive }).toEqual({
            calls: 1,
            reports: 0,
            aborts: 0,
            listenerActive: true,
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBe(3);
        expect(observed?.aborted).toBe(true);
        expect({ calls, reports, aborts, listenerActive }).toEqual({
            calls: 1,
            reports: 0,
            aborts: 1,
            listenerActive: false,
        });
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toEqual(['Erden publication wait expired [CLI_PUBLICATION_TIMEOUT]\n']);
        expect(captured.stderr.join('')).not.toContain(BEARER);
        expect(captured.stderr.join('')).not.toContain('/private/status');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds hostile nonadvancing polling and never requests an active report', async () => {
        const root = tempRoot();
        let calls = 0;
        let reports = 0;
        const captured = context(
            root,
            report(join(root, 'unused.erdenpkg')),
            runtime({
                getAttempt: () => {
                    calls += 1;
                    return Promise.resolve(attempt());
                },
                getReport: () => {
                    reports += 1;
                    return Promise.resolve(succeededReport());
                },
                now: () => 0,
                sleep: () => Promise.resolve(),
            }),
        );
        expect(
            await runPublicationCommand(['attempt-1', '--registry', ORIGIN, '--wait', '--report'], captured.context),
        ).toBe(3);
        expect(calls).toBe(301);
        expect(reports).toBe(0);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toEqual(['Erden publication wait expired [CLI_PUBLICATION_TIMEOUT]\n']);
    });

    it('warns exactly before the first HTTP status request and fails closed after revocation', async () => {
        const root = tempRoot();
        const events: string[] = [];
        const captured = context(
            root,
            report(join(root, 'unused.erdenpkg')),
            runtime({
                readCredential: () => credential(HTTP_ORIGIN),
                getAttempt: () => {
                    events.push('request');
                    return Promise.reject(new Error(`revoked ${BEARER}`));
                },
            }),
            (text) => {
                events.push(`stderr:${text}`);
            },
        );
        expect(await runPublicationCommand(['attempt-1', '--registry', HTTP_ORIGIN], captured.context)).toBe(3);
        expect(events).toEqual([
            'stderr:WARNING: This registry uses HTTP. Authentication secrets may be intercepted or altered in transit.\n',
            'request',
            'stderr:Erden publication query could not complete [CLI_PUBLICATION_FAILED]\n',
        ]);
        expect(events.join('')).not.toContain(BEARER);
    });

    it('classifies a terminal publication failure as a closed completed semantic result', async () => {
        const root = tempRoot();
        const captured = context(
            root,
            report(join(root, 'unused.erdenpkg')),
            runtime({
                getAttempt: () => Promise.resolve(attempt('failed')),
            }),
        );
        expect(await runPublicationCommand(['attempt-1', '--registry', ORIGIN], captured.context)).toBe(1);
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout).toEqual([
            'Publication attempt-1: failed\nProject: @example/project@1.2.3 (https://example.test/project)\nVisibility: private\nFailure: candidate/PUBLICATION_CANDIDATE_OBJECT_INVALID\nReport page: https://registry.example.test/publications/attempt-1/report\n',
        ]);
    });

    it('ends human status output with the canonical report page and keeps it out of JSON', async () => {
        const root = tempRoot();
        const id = 'attempt:uvI-plIBQUxz';
        const page = `${ORIGIN}/publications/attempt%3AuvI-plIBQUxz/report`;
        expect(publicationReportPageUrl(ORIGIN, id)).toBe(page);
        const captured = context(
            root,
            report(join(root, 'unused.erdenpkg')),
            runtime({
                getAttempt: () => Promise.resolve(attempt('succeeded', { attemptId: id })),
                getReport: () => Promise.resolve({ ...succeededReport(), attemptId: id }),
            }),
        );
        expect(await runPublicationCommand([id, '--registry', ORIGIN, '--report'], captured.context)).toBe(0);
        const human = captured.stdout.join('');
        expect(human).toContain('Report: succeeded\n');
        expect(human.endsWith(`Competency questions: executed=1, dormant=0\nReport page: ${page}\n`)).toBe(true);
        captured.stdout.length = 0;
        expect(await runPublicationCommand([id, '--registry', ORIGIN], captured.context)).toBe(0);
        expect(captured.stdout.join('').endsWith(`Visibility: private\nReport page: ${page}\n`)).toBe(true);
        for (const flags of [['--json'], ['--report', '--json']]) {
            captured.stdout.length = 0;
            expect(await runPublicationCommand([id, '--registry', ORIGIN, ...flags], captured.context)).toBe(0);
            const json = captured.stdout.join('');
            expect(json).not.toContain('/publications/');
            expect(json).not.toContain('Report page');
        }
    });
});
