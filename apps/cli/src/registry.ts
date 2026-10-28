import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Effect } from 'effect';

import {
    getExactRegistryRelease,
    getPublicationAttempt,
    getPublicationReport,
    listRegistryReleases,
    openRegistryArchive,
    readStoredCliCredential,
    RegistryClientError,
    resolveRegistryAlias,
    uploadPublication,
    type GetExactRegistryReleaseRequest,
    type ListRegistryReleasesRequest,
    type OpenRegistryArchiveRequest,
    type PublicationUploadInput,
    type RegistryArchiveReadLease,
    type ResolveRegistryAliasRequest,
    type StoredCliCredentialRevision,
} from '@erden/client';
import {
    decodePublicationExactVersion,
    decodePublicationOpaqueId,
    encodePublicationAttemptView,
    encodePublicationReportSummary,
    normalizeRegistryOrigin,
    parseCliCredential,
    type PublicationAttemptView,
    type PublicationReportSummaryV1,
    type RegistryReleaseIndexReaderShape,
} from '@erden/contracts';
import {
    decodePackProjectReport,
    loadManifest,
    PackProjectError,
    renderPackProjectError,
    toolchainGuidance,
    type DependencyArchiveReaderShape,
    type PackProjectReport,
    type PackProjectServiceShape,
} from '@erden/project';

export const HTTP_CREDENTIAL_WARNING =
    'WARNING: This registry uses HTTP. Authentication secrets may be intercepted or altered in transit.';
const PUBLICATION_POLL_INTERVAL_MILLISECONDS = 1_000;
const PUBLICATION_WAIT_MILLISECONDS = 5 * 60 * 1_000;
const PUBLICATION_MAXIMUM_POLLS = PUBLICATION_WAIT_MILLISECONDS / PUBLICATION_POLL_INTERVAL_MILLISECONDS + 1;
const PUBLICATION_UPLOAD_MILLISECONDS = 5 * 60 * 1_000;
const ARCHIVE_CHUNK_BYTES = 64 * 1_024;

export class CliRegistryUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliRegistryUsageError';
    }
}

export interface CliRegistryTextSink {
    readonly write: (text: string) => void;
}

export interface CliDependencyRegistryRuntime {
    readonly readCredential: (registryOrigin: string) => StoredCliCredentialRevision | null;
    readonly resolveAlias: (input: ResolveRegistryAliasRequest) => ReturnType<typeof resolveRegistryAlias>;
    readonly listReleases: (input: ListRegistryReleasesRequest) => ReturnType<typeof listRegistryReleases>;
    readonly getExactRelease: (input: GetExactRegistryReleaseRequest) => ReturnType<typeof getExactRegistryRelease>;
    readonly openArchive: (input: OpenRegistryArchiveRequest) => Promise<RegistryArchiveReadLease>;
    readonly now: () => number;
}

export interface CliDependencyRegistryComposition {
    readonly releaseIndex: RegistryReleaseIndexReaderShape;
    readonly archives: DependencyArchiveReaderShape;
}

export interface CliPublicationRuntime {
    readonly readCredential: (registryOrigin: string) => StoredCliCredentialRevision | null;
    readonly upload: (input: PublicationUploadInput) => Promise<PublicationAttemptView>;
    readonly getAttempt: (
        input: Readonly<{
            readonly registryOrigin: string;
            readonly attemptId: string;
            readonly bearer: string;
            readonly signal?: AbortSignal;
        }>,
    ) => Promise<PublicationAttemptView>;
    readonly getReport: (
        input: Readonly<{
            readonly registryOrigin: string;
            readonly attemptId: string;
            readonly bearer: string;
            readonly signal?: AbortSignal;
        }>,
    ) => Promise<PublicationReportSummaryV1>;
    readonly archiveSource: (report: PackProjectReport) => Promise<PublicationUploadInput['open']>;
    readonly interactive: () => boolean;
    readonly confirmCreate: (
        input: Readonly<{
            readonly alias: string;
            readonly canonicalIri: string;
            readonly visibility: 'private' | 'public';
        }>,
    ) => Promise<boolean>;
    readonly now: () => number;
    readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface CliRegistryCommandContext {
    readonly cwd: () => string;
    readonly stdout: CliRegistryTextSink;
    readonly stderr: CliRegistryTextSink;
    readonly pack: PackProjectServiceShape;
    readonly publication?: CliPublicationRuntime;
}

interface FileIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly nlink: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
}

function identity(value: BigIntStats): FileIdentity {
    return Object.freeze({
        dev: value.dev,
        ino: value.ino,
        mode: value.mode,
        nlink: value.nlink,
        size: value.size,
        mtimeNs: value.mtimeNs,
        ctimeNs: value.ctimeNs,
    });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function safeArchiveIdentity(value: BigIntStats, report: PackProjectReport): FileIdentity {
    if (
        !value.isFile() ||
        value.isSymbolicLink() ||
        value.nlink !== 1n ||
        value.size !== BigInt(report.archive.byteSize)
    ) {
        throw new Error('unsafe publication archive');
    }
    return identity(value);
}

async function closeHandle(handle: FileHandle | undefined): Promise<void> {
    if (handle !== undefined) {
        await handle.close();
    }
}

export async function makeNodePublicationArchiveSource(
    rawReport: PackProjectReport,
): Promise<PublicationUploadInput['open']> {
    const report = decodePackProjectReport(rawReport);
    const path = report.output.path;
    const canonicalPath = await realpath(path);
    if (canonicalPath !== resolve(path)) {
        throw new Error('unsafe publication archive path');
    }
    const snapshot = safeArchiveIdentity(await lstat(path, { bigint: true }), report);
    return () =>
        Object.freeze({
            [Symbol.asyncIterator]: async function* (): AsyncGenerator<Uint8Array> {
                if (
                    (await realpath(path)) !== canonicalPath ||
                    !sameIdentity(snapshot, safeArchiveIdentity(await lstat(path, { bigint: true }), report))
                ) {
                    throw new Error('publication archive changed');
                }
                let handle: FileHandle | undefined;
                try {
                    handle = await open(path, 'r');
                    const opened = safeArchiveIdentity(await handle.stat({ bigint: true }), report);
                    if (!sameIdentity(snapshot, opened)) {
                        throw new Error('publication archive changed');
                    }
                    const buffer = new Uint8Array(ARCHIVE_CHUNK_BYTES);
                    let position = 0;
                    while (position < report.archive.byteSize) {
                        const length = Math.min(buffer.byteLength, report.archive.byteSize - position);
                        const { bytesRead } = await handle.read(buffer, 0, length, position);
                        if (bytesRead < 1 || bytesRead > length) {
                            throw new Error('publication archive read failed');
                        }
                        position += bytesRead;
                        yield buffer.slice(0, bytesRead);
                    }
                    const afterHandle = safeArchiveIdentity(await handle.stat({ bigint: true }), report);
                    const afterPath = safeArchiveIdentity(await lstat(path, { bigint: true }), report);
                    if (
                        !sameIdentity(snapshot, afterHandle) ||
                        !sameIdentity(snapshot, afterPath) ||
                        (await realpath(path)) !== canonicalPath
                    ) {
                        throw new Error('publication archive changed');
                    }
                } finally {
                    await closeHandle(handle);
                }
            },
        });
}

function safeTime(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new Error('invalid CLI clock');
    }
    return value;
}

function optionalReadCredential(
    runtime: CliDependencyRegistryRuntime,
    registryOrigin: string,
    stderr: CliRegistryTextSink,
): string | undefined {
    const revision = runtime.readCredential(registryOrigin);
    if (revision === null) {
        return undefined;
    }
    if (
        revision.value.origin !== registryOrigin ||
        parseCliCredential(revision.value.credential) === null ||
        revision.value.expiresAt <= safeTime(runtime.now())
    ) {
        throw new RegistryClientError('CLIENT_UNAUTHORIZED');
    }
    if (registryOrigin.startsWith('http://')) {
        stderr.write(`${HTTP_CREDENTIAL_WARNING}\n`);
    }
    return revision.value.credential;
}

async function notFoundAsNull<Value>(operation: () => Promise<Value>): Promise<Value | null> {
    try {
        return await operation();
    } catch (cause) {
        if (cause instanceof RegistryClientError && cause.code === 'CLIENT_NOT_FOUND') {
            return null;
        }
        throw cause;
    }
}

export function makeCliDependencyRegistryComposition(
    runtime: CliDependencyRegistryRuntime,
    stderr: CliRegistryTextSink,
): CliDependencyRegistryComposition {
    function bearer(registryOrigin: string): string | undefined {
        return optionalReadCredential(runtime, registryOrigin, stderr);
    }
    const releaseIndex = Object.freeze<RegistryReleaseIndexReaderShape>({
        resolveAlias: async (registryOrigin, alias, signal) => {
            const credentialValue = bearer(registryOrigin);
            return await notFoundAsNull(
                async () =>
                    await runtime.resolveAlias({
                        registryOrigin,
                        alias,
                        ...(credentialValue === undefined ? {} : { bearer: credentialValue }),
                        ...(signal === undefined ? {} : { signal }),
                    }),
            );
        },
        listPage: async (registryOrigin, canonicalIri, cursor, signal) => {
            const credentialValue = bearer(registryOrigin);
            return await notFoundAsNull(
                async () =>
                    await runtime.listReleases({
                        registryOrigin,
                        canonicalIri,
                        cursor,
                        ...(credentialValue === undefined ? {} : { bearer: credentialValue }),
                        ...(signal === undefined ? {} : { signal }),
                    }),
            );
        },
        getExactRelease: async (registryOrigin, canonicalIri, version, signal) => {
            const credentialValue = bearer(registryOrigin);
            return await notFoundAsNull(
                async () =>
                    await runtime.getExactRelease({
                        registryOrigin,
                        canonicalIri,
                        version,
                        ...(credentialValue === undefined ? {} : { bearer: credentialValue }),
                        ...(signal === undefined ? {} : { signal }),
                    }),
            );
        },
    });
    const archives = Object.freeze<DependencyArchiveReaderShape>({
        fetchArchive: async (registryOrigin, locked, signal) => {
            const credentialValue = bearer(registryOrigin);
            const lease = await notFoundAsNull(
                async () =>
                    await runtime.openArchive({
                        registryOrigin,
                        canonicalIri: locked.canonicalIri,
                        version: locked.version,
                        archiveSha256: locked.archiveSha256,
                        ...(credentialValue === undefined ? {} : { bearer: credentialValue }),
                        ...(signal === undefined ? {} : { signal }),
                    }),
            );
            if (lease === null) {
                return null;
            }
            return Object.freeze({
                [Symbol.asyncIterator]: async function* (): AsyncGenerator<Uint8Array> {
                    try {
                        for await (const chunk of lease.bytes) {
                            yield chunk;
                        }
                    } finally {
                        await lease.close();
                    }
                },
            });
        },
    });
    return Object.freeze({ releaseIndex, archives });
}

export function makeNodeCliDependencyRegistryComposition(
    stderr: CliRegistryTextSink,
): CliDependencyRegistryComposition {
    return makeCliDependencyRegistryComposition(
        Object.freeze({
            readCredential: (registryOrigin: string) => readStoredCliCredential(registryOrigin),
            resolveAlias: async (input: ResolveRegistryAliasRequest) => await resolveRegistryAlias(input),
            listReleases: async (input: ListRegistryReleasesRequest) => await listRegistryReleases(input),
            getExactRelease: async (input: GetExactRegistryReleaseRequest) => await getExactRegistryRelease(input),
            openArchive: async (input: OpenRegistryArchiveRequest) => await openRegistryArchive(input),
            now: () => Date.now(),
        }),
        stderr,
    );
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
        function aborted(): void {
            clearTimeout(timer);
            signal?.removeEventListener('abort', aborted);
            reject(new Error('publication wait cancelled'));
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', aborted);
            resolvePromise();
        }, milliseconds);
        if (signal?.aborted === true) {
            aborted();
        } else {
            signal?.addEventListener('abort', aborted, { once: true });
        }
    });
}

export const nodeCliPublicationRuntime: CliPublicationRuntime = Object.freeze({
    readCredential: (registryOrigin: string) => readStoredCliCredential(registryOrigin),
    upload: async (input: PublicationUploadInput) => await uploadPublication(input),
    getAttempt: async (input: Parameters<CliPublicationRuntime['getAttempt']>[0]) => await getPublicationAttempt(input),
    getReport: async (input: Parameters<CliPublicationRuntime['getReport']>[0]) => await getPublicationReport(input),
    archiveSource: makeNodePublicationArchiveSource,
    interactive: () => process.stdin.isTTY && process.stderr.isTTY,
    confirmCreate: async ({
        alias,
        canonicalIri,
        visibility,
    }: Parameters<CliPublicationRuntime['confirmCreate']>[0]) => {
        function terminal(value: string): string {
            return terminalText(value);
        }
        const prompt = `Create registry project?\nAlias: ${terminal(alias)}\nCanonical IRI: ${terminal(canonicalIri)}\nVisibility: ${visibility}\nContinue? [y/N] `;
        const interface_ = createInterface({ input: process.stdin, output: process.stderr });
        try {
            return /^(?:y|yes)$/iu.test((await interface_.question(prompt)).trim());
        } finally {
            interface_.close();
        }
    },
    now: () => Date.now(),
    sleep,
});

export function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) =>
                character === '\n'
                    ? '\\n'
                    : character === '\r'
                      ? '\\r'
                      : character === '\t'
                        ? '\\t'
                        : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

function markOnce(seen: Set<string>, flag: string): void {
    if (seen.has(flag)) {
        throw new CliRegistryUsageError(`${flag} may be specified only once`);
    }
    seen.add(flag);
}

function requireValue(arguments_: ReadonlyArray<string>, index: number, flag: string): string {
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('-')) {
        throw new CliRegistryUsageError(`${flag} requires a value`);
    }
    return value;
}

interface PublishArguments {
    readonly version: string;
    readonly projectDirectory?: string;
    readonly config?: string;
    readonly output?: string;
    readonly create: boolean;
    readonly visibility?: 'private' | 'public';
    readonly yes: boolean;
    readonly json: boolean;
}

function parsePublishArguments(arguments_: ReadonlyArray<string>): PublishArguments {
    const positional: string[] = [];
    const seen = new Set<string>();
    let config: string | undefined;
    let output: string | undefined;
    let create = false;
    let visibility: 'private' | 'public' | undefined;
    let yes = false;
    let json = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--create' || argument === '--yes' || argument === '--json') {
            markOnce(seen, argument);
            if (argument === '--create') {
                create = true;
            } else if (argument === '--yes') {
                yes = true;
            } else {
                json = true;
            }
        } else if (argument === '--config' || argument === '--output' || argument === '--visibility') {
            markOnce(seen, argument);
            const value = requireValue(arguments_, index, argument);
            if (argument === '--config') {
                config = value;
            } else if (argument === '--output') {
                output = value;
            } else {
                if (value !== 'private' && value !== 'public') {
                    throw new CliRegistryUsageError('--visibility must be public or private');
                }
                visibility = value;
            }
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliRegistryUsageError(`unknown publish flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length < 1 || positional.length > 2) {
        throw new CliRegistryUsageError('publish requires a version and accepts at most one project directory');
    }
    let version: string;
    try {
        version = decodePublicationExactVersion(positional[0]);
    } catch {
        throw new CliRegistryUsageError('publish requires one exact semantic version');
    }
    if (config !== undefined && positional.length === 2) {
        throw new CliRegistryUsageError('publish cannot combine a project directory with --config');
    }
    if (!create && (visibility !== undefined || yes)) {
        throw new CliRegistryUsageError('--visibility and --yes require --create');
    }
    if (yes && visibility === undefined) {
        throw new CliRegistryUsageError('--yes requires an explicit --visibility');
    }
    return Object.freeze({
        version,
        ...(positional[1] === undefined ? {} : { projectDirectory: positional[1] }),
        ...(config === undefined ? {} : { config }),
        ...(output === undefined ? {} : { output }),
        create,
        ...(visibility === undefined ? {} : { visibility }),
        yes,
        json,
    });
}

interface PublicationArguments {
    readonly attemptId: string;
    readonly registry?: string;
    readonly wait: boolean;
    readonly report: boolean;
    readonly json: boolean;
}

function parsePublicationArguments(arguments_: ReadonlyArray<string>): PublicationArguments {
    const positional: string[] = [];
    const seen = new Set<string>();
    let registry: string | undefined;
    let wait = false;
    let report = false;
    let json = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--wait' || argument === '--report' || argument === '--json') {
            markOnce(seen, argument);
            if (argument === '--wait') {
                wait = true;
            } else if (argument === '--report') {
                report = true;
            } else {
                json = true;
            }
        } else if (argument === '--registry') {
            markOnce(seen, argument);
            registry = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliRegistryUsageError(`unknown publication flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length !== 1) {
        throw new CliRegistryUsageError('publication requires exactly one attempt id');
    }
    let attemptId: string;
    try {
        attemptId = decodePublicationOpaqueId(positional[0]);
    } catch {
        throw new CliRegistryUsageError('publication requires one canonical attempt id');
    }
    if (registry !== undefined) {
        try {
            const canonical = normalizeRegistryOrigin(registry);
            if (canonical !== registry) {
                throw new Error();
            }
            registry = canonical;
        } catch {
            throw new CliRegistryUsageError('--registry must be one canonical HTTP(S) origin');
        }
    }
    return Object.freeze({ attemptId, ...(registry === undefined ? {} : { registry }), wait, report, json });
}

function selection(
    cwd: string,
    projectDirectory: string | undefined,
    config: string | undefined,
): Readonly<{
    readonly from?: string;
    readonly explicitPath?: string;
}> {
    return config === undefined
        ? Object.freeze({ from: projectDirectory === undefined ? cwd : resolve(cwd, projectDirectory) })
        : Object.freeze({ explicitPath: resolve(cwd, config) });
}

function registryFromManifest(manifest: ReturnType<typeof loadManifest>): string {
    const registry = manifest.manifest.registry;
    if (registry === undefined || normalizeRegistryOrigin(registry) !== registry) {
        throw new Error('project registry unavailable');
    }
    return registry;
}

function credential(runtime: CliPublicationRuntime, registryOrigin: string): string {
    const revision = runtime.readCredential(registryOrigin);
    if (
        revision === null ||
        revision.value.origin !== registryOrigin ||
        parseCliCredential(revision.value.credential) === null ||
        revision.value.expiresAt <= safeTime(runtime.now())
    ) {
        throw new Error('publication credential unavailable');
    }
    return revision.value.credential;
}

function appendIdempotencyPart(hash: ReturnType<typeof createHash>, value: string): void {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';');
}

export function publicationIdempotencyKey(
    registryOrigin: string,
    report: PackProjectReport,
    create: false | 'private' | 'public',
): string {
    if (normalizeRegistryOrigin(registryOrigin) !== registryOrigin) {
        throw new TypeError('publication registry origin is not canonical');
    }
    const value = decodePackProjectReport(report);
    const hash = createHash('sha256').update('erden.cli-publish-idempotency/v1\0');
    for (const part of [
        registryOrigin,
        value.project.canonicalIri,
        value.project.alias,
        value.version,
        value.archive.sha256,
        String(value.archive.byteSize),
        value.archive.manifestSha256,
        create === false ? 'existing' : `create:${create}`,
    ]) {
        appendIdempotencyPart(hash, part);
    }
    return `publish:${hash.digest('hex')}`;
}

function emitWarning(origin: string, stderr: CliRegistryTextSink): void {
    if (origin.startsWith('http://')) {
        stderr.write(`${HTTP_CREDENTIAL_WARNING}\n`);
    }
}

function renderAttempt(attempt: PublicationAttemptView): string {
    const failure =
        attempt.failure === null
            ? ''
            : `\nFailure: ${terminalText(attempt.failure.kind)}/${terminalText(attempt.failure.code)}`;
    return `Publication ${terminalText(attempt.attemptId)}: ${terminalText(attempt.state)}\nProject: ${terminalText(attempt.project.preferredAlias)}@${terminalText(attempt.version)} (${terminalText(attempt.project.canonicalIri)})\nVisibility: ${attempt.project.visibility}${failure}\n`;
}

/**
 * The members-only browser report for an attempt, in the canonical `%3A` form the registry serves directly. Human
 * output only: `--json` stays the closed `erden.publication-attempt/v1` and `erden.cli-publication/v1` encodings.
 */
export function publicationReportPageUrl(registryOrigin: string, attemptId: string): string {
    return `${registryOrigin}/publications/${encodeURIComponent(attemptId)}/report`;
}

function renderReportPage(registryOrigin: string, attempt: PublicationAttemptView): string {
    return `Report page: ${terminalText(publicationReportPageUrl(registryOrigin, attempt.attemptId))}\n`;
}

function renderReport(report: PublicationReportSummaryV1): string {
    const validation = report.validation;
    if (validation === null) {
        return `Report: ${report.outcome}\n`;
    }
    const stages = Object.entries(validation.stages)
        .map(([name, status]) => `${terminalText(name)}=${terminalText(status)}`)
        .join(', ');
    const shacl =
        validation.shaclCounts === null
            ? ''
            : `\nSHACL: violation=${String(validation.shaclCounts.violation)}, warning=${String(validation.shaclCounts.warning)}, info=${String(validation.shaclCounts.info)}`;
    const questions =
        validation.competencyQuestionCounts === null
            ? ''
            : `\nCompetency questions: executed=${String(validation.competencyQuestionCounts.executed)}, dormant=${String(validation.competencyQuestionCounts.dormant)}`;
    return `Report: ${report.outcome}\nValidation: ${validation.status}\nStages: ${stages}\nWarnings: ${String(validation.warningCount)}${shacl}${questions}\n`;
}

function canonicalCombinedOutput(attempt: PublicationAttemptView, report: PublicationReportSummaryV1): string {
    const attemptValue: unknown = JSON.parse(new TextDecoder().decode(encodePublicationAttemptView(attempt)));
    const reportValue: unknown = JSON.parse(new TextDecoder().decode(encodePublicationReportSummary(report)));
    return `${JSON.stringify({ attempt: attemptValue, report: reportValue, schema: 'erden.cli-publication/v1' })}\n`;
}

/** The next step when packing failed because this source checkout has no reasoner build. */
function publishGuidance(cause: unknown): string {
    const guidance = toolchainGuidance(cause);
    return guidance === null ? '' : `Next step: ${guidance}\n`;
}

export async function runPublishCommand(
    arguments_: ReadonlyArray<string>,
    context: CliRegistryCommandContext,
): Promise<number> {
    const options = parsePublishArguments(arguments_);
    const runtime = context.publication;
    if (runtime === undefined) {
        context.stderr.write('Erden publish could not complete [CLI_PUBLISH_FAILED]\n');
        return 3;
    }
    if (options.create && !options.yes && !runtime.interactive()) {
        throw new CliRegistryUsageError('noninteractive creation requires --visibility and --yes');
    }
    const cwd = context.cwd();
    const selected = selection(cwd, options.projectDirectory, options.config);
    try {
        const before = loadManifest(selected);
        const registryOrigin = registryFromManifest(before);
        const visibility = options.create ? (options.visibility ?? 'private') : undefined;
        if (options.create && !options.yes) {
            const confirmed = await runtime.confirmCreate(
                Object.freeze({
                    alias: before.manifest.alias,
                    canonicalIri: before.manifest.canonicalIri,
                    visibility: visibility as 'private' | 'public',
                }),
            );
            if (!confirmed) {
                context.stdout.write('Publication cancelled.\n');
                return 0;
            }
        }
        const bearer = credential(runtime, registryOrigin);
        const report = decodePackProjectReport(
            await Effect.runPromise(
                context.pack.pack({
                    version: options.version,
                    ...(options.config === undefined
                        ? options.projectDirectory === undefined
                            ? { from: cwd }
                            : { from: resolve(cwd, options.projectDirectory) }
                        : { manifestPath: resolve(cwd, options.config) }),
                    ...(options.output === undefined ? {} : { outputPath: resolve(cwd, options.output) }),
                }),
            ),
        );
        const after = loadManifest({ explicitPath: before.filePath });
        if (
            after.filePath !== before.filePath ||
            after.projectRoot !== before.projectRoot ||
            registryFromManifest(after) !== registryOrigin ||
            after.manifest.alias !== before.manifest.alias ||
            after.manifest.canonicalIri !== before.manifest.canonicalIri ||
            report.project.alias !== before.manifest.alias ||
            report.project.canonicalIri !== before.manifest.canonicalIri ||
            report.version !== options.version
        ) {
            throw new Error('project changed during publication');
        }
        const create = options.create ? (visibility as 'private' | 'public') : false;
        const openArchive = await runtime.archiveSource(report);
        const idempotencyKey = publicationIdempotencyKey(registryOrigin, report, create);
        const cancellation = new AbortController();
        const timer = setTimeout(() => {
            cancellation.abort();
        }, PUBLICATION_UPLOAD_MILLISECONDS);
        timer.unref();
        let attempt: PublicationAttemptView;
        try {
            emitWarning(registryOrigin, context.stderr);
            attempt = await runtime.upload(
                Object.freeze({
                    registryOrigin,
                    bearer,
                    create,
                    idempotencyKey,
                    archiveSha256: report.archive.sha256,
                    byteSize: report.archive.byteSize,
                    open: openArchive,
                    signal: cancellation.signal,
                }),
            );
        } finally {
            clearTimeout(timer);
        }
        if (
            attempt.project.preferredAlias !== report.project.alias ||
            attempt.project.canonicalIri !== report.project.canonicalIri ||
            attempt.version !== report.version ||
            (create !== false && attempt.project.visibility !== create)
        ) {
            throw new Error('publication response mismatch');
        }
        context.stdout.write(
            options.json
                ? new TextDecoder().decode(encodePublicationAttemptView(attempt))
                : `${renderAttempt(attempt)}${renderReportPage(registryOrigin, attempt)}`,
        );
        return attempt.state === 'failed' ? 1 : 0;
    } catch (cause) {
        // A local packing refusal (for example a stale erden.lock) is the author's to fix, so it keeps its own
        // message and remedy; nothing has been uploaded.
        context.stderr.write(
            cause instanceof PackProjectError
                ? `Erden publish could not complete [CLI_PUBLISH_FAILED]\n${renderPackProjectError(cause)}${publishGuidance(cause)}`
                : 'Erden publish could not complete [CLI_PUBLISH_FAILED]\n',
        );
        return 3;
    }
}

function publicationOrigin(explicit: string | undefined, cwd: string): string {
    if (explicit !== undefined) {
        return explicit;
    }
    return registryFromManifest(loadManifest({ from: cwd }));
}

function active(attempt: PublicationAttemptView): boolean {
    return attempt.state === 'queued' || attempt.state === 'validating';
}

export async function runPublicationCommand(
    arguments_: ReadonlyArray<string>,
    context: CliRegistryCommandContext,
): Promise<number> {
    const options = parsePublicationArguments(arguments_);
    const runtime = context.publication;
    if (runtime === undefined) {
        context.stderr.write('Erden publication query could not complete [CLI_PUBLICATION_FAILED]\n');
        return 3;
    }
    const cancellation = new AbortController();
    const deadlineTimer = setTimeout(() => {
        cancellation.abort();
    }, PUBLICATION_WAIT_MILLISECONDS);
    deadlineTimer.unref();
    try {
        const registryOrigin = publicationOrigin(options.registry, context.cwd());
        const bearer = credential(runtime, registryOrigin);
        const started = safeTime(runtime.now());
        const deadline = safeTime(started + PUBLICATION_WAIT_MILLISECONDS);
        emitWarning(registryOrigin, context.stderr);
        let attempt = await runtime.getAttempt(
            Object.freeze({
                registryOrigin,
                attemptId: options.attemptId,
                bearer,
                signal: cancellation.signal,
            }),
        );
        let polls = 1;
        while (options.wait && active(attempt) && polls < PUBLICATION_MAXIMUM_POLLS) {
            const now = safeTime(runtime.now());
            if (now >= deadline) {
                break;
            }
            await runtime.sleep(Math.min(PUBLICATION_POLL_INTERVAL_MILLISECONDS, deadline - now), cancellation.signal);
            attempt = await runtime.getAttempt(
                Object.freeze({
                    registryOrigin,
                    attemptId: options.attemptId,
                    bearer,
                    signal: cancellation.signal,
                }),
            );
            polls += 1;
        }
        if (options.wait && active(attempt)) {
            context.stderr.write('Erden publication wait expired [CLI_PUBLICATION_TIMEOUT]\n');
            return 3;
        }
        let report: PublicationReportSummaryV1 | undefined;
        if (options.report) {
            if (active(attempt)) {
                context.stderr.write('Erden publication report is not ready [CLI_PUBLICATION_ACTIVE]\n');
                return 3;
            }
            report = await runtime.getReport(
                Object.freeze({
                    registryOrigin,
                    attemptId: options.attemptId,
                    bearer,
                    signal: cancellation.signal,
                }),
            );
            if (
                report.attemptId !== attempt.attemptId ||
                report.outcome !== (attempt.state === 'succeeded' ? 'succeeded' : 'failed')
            ) {
                throw new Error('publication report mismatch');
            }
        }
        context.stdout.write(
            options.json
                ? report === undefined
                    ? new TextDecoder().decode(encodePublicationAttemptView(attempt))
                    : canonicalCombinedOutput(attempt, report)
                : `${renderAttempt(attempt)}${report === undefined ? '' : renderReport(report)}${renderReportPage(registryOrigin, attempt)}`,
        );
        return attempt.state === 'failed' ? 1 : 0;
    } catch {
        context.stderr.write(
            cancellation.signal.aborted
                ? 'Erden publication wait expired [CLI_PUBLICATION_TIMEOUT]\n'
                : 'Erden publication query could not complete [CLI_PUBLICATION_FAILED]\n',
        );
        return 3;
    } finally {
        clearTimeout(deadlineTimer);
    }
}
