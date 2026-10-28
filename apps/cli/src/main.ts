import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { Effect } from 'effect';

import {
    beginCliDeviceLogin,
    deleteStoredCliCredentialRevision,
    exchangeCliDeviceLogin,
    readStoredCliCredential,
    revokeCliDeviceCredential,
    RegistryClientError,
    writeStoredCliCredential,
    type ClientDeviceChallenge,
    type ClientDeviceExchange,
    type StoredCliCredential,
    type StoredCliCredentialRevision,
} from '@erden/client';
import {
    CheckProjectOperationalError,
    DEVICE_LOGIN_LIMITS,
    encodeCheckProjectReport,
    type ManifestSerializationFormat,
    isCanonicalOntologyIri,
    isScopedAlias,
    normalizeRegistryOrigin,
} from '@erden/contracts';
import {
    DoctorOperationalError,
    InitProjectError,
    InstallProjectError,
    ProjectDependenciesError,
    ProjectPathError,
    PackProjectError,
    isPackProjectError,
    StoreMaintenanceError,
    isStoreMaintenanceError,
    StorePathError,
    encodeDoctorReport,
    encodeInitProjectReport,
    encodeInstallProjectReport,
    encodeProjectDependenciesReport,
    encodeProjectDependencyUpdateReport,
    encodeProjectPathReport,
    encodePackProjectReport,
    encodeStorePruneReport,
    encodeStoreStatusReport,
    encodeStorePathReport,
    nodeCheckProjectService,
    nodeDoctorService,
    nodeInitProjectService,
    makeNodeInstallProjectServiceFromReleaseIndex,
    makeNodeProjectDependenciesServiceFromReleaseIndex,
    nodeProjectPathService,
    nodePackProjectService,
    nodeStoreMaintenanceService,
    nodeStorePathService,
    renderCheckProjectError,
    renderCheckProjectReport,
    renderDoctorError,
    renderDoctorReport,
    renderInitProjectError,
    renderInitProjectReport,
    renderInstallProjectError,
    renderInstallProjectReport,
    renderProjectDependenciesError,
    renderProjectDependenciesReport,
    renderProjectDependencyUpdateError,
    renderProjectDependencyUpdateReport,
    renderProjectPathError,
    renderProjectPathReport,
    renderPackProjectError,
    renderPackProjectReport,
    renderStoreMaintenanceError,
    renderStorePruneReport,
    renderStoreStatusReport,
    STORE_PRUNE_REACQUISITION_WARNING,
    toolchainGuidance,
    renderStorePathError,
    renderStorePathReport,
    type CheckProjectServiceShape,
    type DoctorServiceShape,
    type InitProjectServiceShape,
    type InstallProjectServiceShape,
    type ProjectDependenciesServiceShape,
    type ProjectPathServiceShape,
    type PackProjectServiceShape,
    type StoreMaintenanceServiceShape,
    type StorePathServiceShape,
    isProjectDependenciesError,
    parseAddDependencySpec,
    loadManifest,
    parseReasonerLimits,
    ReasonerLimitSettingError,
    type ReasonerLimits,
} from '@erden/project';

import { nodeCliQueryRuntime, runQueryCommand, type CliQueryRuntime } from './query.js';
import {
    CliRegistryUsageError,
    makeNodeCliDependencyRegistryComposition,
    nodeCliPublicationRuntime,
    runPublicationCommand,
    runPublishCommand,
    type CliPublicationRuntime,
} from './registry.js';

export type { CliPublicationRuntime } from './registry.js';
export type { CliQueryRuntime } from './query.js';

export const CLI_EXIT = Object.freeze({
    success: 0,
    semanticFailure: 1,
    usage: 2,
    operational: 3,
} as const);

export const CLI_HELP = `Erden CLI: check, package, and publish ontologies (also available as den)

Usage:
  erden init <dir> [--format <json|jsonc|yml|yaml|toml>] [--canonical-iri <iri>] [--alias <@scope/name>] [--owned-prefix <iri>]... [--json]
  erden check [project-dir] [--config <file>] [--offline] [--json]
  erden install [project-dir] [--config <file>] [--offline] [--frozen-lockfile] [--json]
  erden add <identifier>@<range> [--config <file>] [--json]
  erden remove <identifier> [--config <file>] [--json]
  erden update [identifier] [--config <file>] [--json]
  erden pack <version> [project-dir] [--config <file>] [--output <file>] [--json]
  erden publish <version> [project-dir] [--config <file>] [--output <file>] [--create [--visibility public|private] [--yes]] [--json]
  erden publication <attempt-id> [--registry <origin>] [--wait] [--report] [--json]
  erden query <identifier>@<version> (--file <path> | --stdin) [--registry <origin>] [--json | --sparql-json]
  erden path <layer> [--config <file>] [--json]
  erden store path [--json]
  erden store status [--json]
  erden store prune [--dry-run] [--json]
  erden doctor [--json]
  erden login [--registry <origin>]
  erden logout [--registry <origin>]
  erden help

Use den in place of erden for any command.
Docs: https://erden.sh

Registry transport:
  Add, install, login, logout, publish, publication status, and query use one origin-scoped credential when present.
  Query text is read only from a file or standard input, never from the command line.

Reasoner limits (check):
  ERDEN_REASONER_MAX_WALL_TIME_MS, ERDEN_REASONER_MAX_INPUT_AXIOMS, ERDEN_REASONER_MAX_INFERENCES, and
  ERDEN_REASONER_MAX_REQUEST_BYTES (the request and its answer) set the reasoner budget. Set the same values as a
  registry to predict its publication verdict.
`;

export interface CliServices {
    readonly check: CheckProjectServiceShape;
    readonly init: InitProjectServiceShape;
    readonly doctor: DoctorServiceShape;
    readonly install: InstallProjectServiceShape;
    readonly dependencies: ProjectDependenciesServiceShape;
    readonly path: ProjectPathServiceShape;
    readonly pack: PackProjectServiceShape;
    readonly storePath: StorePathServiceShape;
    readonly storeMaintenance: StoreMaintenanceServiceShape;
}

export interface CliTextSink {
    readonly write: (text: string) => void;
}

export interface CliRuntime {
    readonly cwd: () => string;
    readonly stdout: CliTextSink;
    readonly stderr: CliTextSink;
    readonly services: CliServices;
    readonly authentication?: CliAuthenticationRuntime;
    readonly publication?: CliPublicationRuntime;
    readonly query?: CliQueryRuntime;
    /** The process environment; only the documented `ERDEN_REASONER_MAX_*` settings are read from it. */
    readonly environment?: () => Readonly<Record<string, string | undefined>>;
}

export interface CliAuthenticationRuntime {
    readonly begin: (registryOrigin: string, requestId: string, signal?: AbortSignal) => Promise<ClientDeviceChallenge>;
    readonly exchange: (
        registryOrigin: string,
        deviceSecret: string,
        signal?: AbortSignal,
    ) => Promise<ClientDeviceExchange>;
    readonly revoke: (registryOrigin: string, credential: string, signal?: AbortSignal) => Promise<void>;
    readonly read: (registryOrigin: string) => StoredCliCredentialRevision | null;
    readonly write: (value: StoredCliCredential) => StoredCliCredentialRevision;
    readonly remove: (revision: StoredCliCredentialRevision) => boolean;
    readonly requestId: () => string;
    readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    readonly now: () => number;
}

const nodeCliStdout: CliTextSink = Object.freeze({ write: (text: string) => process.stdout.write(text) });
const nodeCliStderr: CliTextSink = Object.freeze({ write: (text: string) => process.stderr.write(text) });
const nodeCliDependencyRegistry = makeNodeCliDependencyRegistryComposition(nodeCliStderr);

export const nodeCliRuntime: CliRuntime = Object.freeze({
    cwd: () => process.cwd(),
    stdout: nodeCliStdout,
    stderr: nodeCliStderr,
    services: Object.freeze({
        check: nodeCheckProjectService,
        init: nodeInitProjectService,
        doctor: nodeDoctorService,
        install: makeNodeInstallProjectServiceFromReleaseIndex(
            nodeCliDependencyRegistry.releaseIndex,
            nodeCliDependencyRegistry.archives,
        ),
        dependencies: makeNodeProjectDependenciesServiceFromReleaseIndex(
            nodeCliDependencyRegistry.releaseIndex,
            nodeCliDependencyRegistry.archives,
        ),
        path: nodeProjectPathService,
        pack: nodePackProjectService,
        storePath: nodeStorePathService,
        storeMaintenance: nodeStoreMaintenanceService,
    }),
    authentication: Object.freeze({
        begin: async (registryOrigin: string, requestId: string, signal?: AbortSignal) =>
            await beginCliDeviceLogin(registryOrigin, requestId, undefined, signal),
        exchange: async (registryOrigin: string, deviceSecret: string, signal?: AbortSignal) =>
            await exchangeCliDeviceLogin(registryOrigin, deviceSecret, undefined, signal),
        revoke: async (registryOrigin: string, credential: string, signal?: AbortSignal) => {
            await revokeCliDeviceCredential(registryOrigin, credential, undefined, signal);
        },
        read: (registryOrigin: string) => readStoredCliCredential(registryOrigin),
        write: (value: StoredCliCredential) => writeStoredCliCredential(value),
        remove: (revision: StoredCliCredentialRevision) => deleteStoredCliCredentialRevision(revision),
        requestId: () => randomBytes(32).toString('base64url'),
        sleep: async (milliseconds: number, signal?: AbortSignal) => {
            await new Promise<void>((resolve, reject) => {
                function abort(): void {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', abort);
                    reject(new Error('Device login was cancelled'));
                }
                const timer = setTimeout(() => {
                    signal?.removeEventListener('abort', abort);
                    resolve();
                }, milliseconds);
                if (signal?.aborted === true) {
                    abort();
                } else {
                    signal?.addEventListener('abort', abort, { once: true });
                }
            });
        },
        now: () => Date.now(),
    }),
    publication: nodeCliPublicationRuntime,
    query: nodeCliQueryRuntime,
    environment: () => process.env,
});

class CliUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliUsageError';
    }
}

function terminalText(value: string): string {
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

function usageFailure(runtime: CliRuntime, message: string): number {
    runtime.stderr.write(`Erden usage error: ${terminalText(message)}\n\n${CLI_HELP}`);
    return CLI_EXIT.usage;
}

function unexpectedOperationalFailure(runtime: CliRuntime): number {
    runtime.stderr.write('Erden could not complete [CLI_OPERATIONAL_FAILURE]\n');
    return CLI_EXIT.operational;
}

const HTTP_CREDENTIAL_WARNING =
    'WARNING: This registry uses HTTP. Authentication secrets may be intercepted or altered in transit.';
const MAXIMUM_LOGIN_POLLS =
    Math.ceil(DEVICE_LOGIN_LIMITS.deviceLifetimeMilliseconds / DEVICE_LOGIN_LIMITS.initialPollIntervalMilliseconds) + 1;
const CLI_AUTHENTICATION_ATTEMPTS = 3;
const CLI_AUTHENTICATION_RETRY_MILLISECONDS = 100;

function authenticationTime(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new Error('The device login clock is invalid');
    }
    return value;
}

async function retryCliAuthentication<Value>(
    authentication: CliAuthenticationRuntime,
    operation: () => Promise<Value>,
    signal?: AbortSignal,
): Promise<Value> {
    for (let attempt = 0; attempt < CLI_AUTHENTICATION_ATTEMPTS; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            const retry =
                error instanceof RegistryClientError &&
                (error.code === 'CLIENT_RETRYABLE' ||
                    error.code === 'CLIENT_TIMEOUT' ||
                    error.code === 'CLIENT_TRANSPORT');
            if (!retry || attempt + 1 === CLI_AUTHENTICATION_ATTEMPTS || signal?.aborted === true) {
                throw error;
            }
            await authentication.sleep(CLI_AUTHENTICATION_RETRY_MILLISECONDS * 2 ** attempt, signal);
        }
    }
    throw new RegistryClientError('CLIENT_TRANSPORT');
}

function authenticationOrigin(explicit: string | undefined, runtime: CliRuntime): string {
    const raw = explicit ?? loadManifest({ from: runtime.cwd() }).manifest.registry;
    if (raw === undefined) {
        throw new CliUsageError('login/logout requires --registry or a nearest project registry');
    }
    const origin = normalizeRegistryOrigin(raw);
    if (origin !== raw) {
        throw new CliUsageError('registry must be one canonical HTTP(S) origin');
    }
    return origin;
}

function authenticationArguments(command: 'login' | 'logout', arguments_: ReadonlyArray<string>): string | undefined {
    let registry: string | undefined;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument !== '--registry') {
            throw new CliUsageError(`unknown ${command} argument: ${argument}`);
        }
        if (registry !== undefined) {
            throw new CliUsageError('--registry may be specified only once');
        }
        registry = requireValue(arguments_, index, argument);
        index += 1;
    }
    return registry;
}

async function loginCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    const explicit = authenticationArguments('login', arguments_);
    const authentication = runtime.authentication;
    if (authentication === undefined) {
        return unexpectedOperationalFailure(runtime);
    }
    const origin = authenticationOrigin(explicit, runtime);
    const startedAt = authenticationTime(authentication.now());
    const localDeadline = authenticationTime(startedAt + DEVICE_LOGIN_LIMITS.deviceLifetimeMilliseconds);
    const cancellation = new AbortController();
    const deadlineTimer = setTimeout(() => {
        cancellation.abort();
    }, DEVICE_LOGIN_LIMITS.deviceLifetimeMilliseconds);
    deadlineTimer.unref();
    try {
        const requestId = authentication.requestId();
        const challenge = await retryCliAuthentication(
            authentication,
            async () => await authentication.begin(origin, requestId, cancellation.signal),
            cancellation.signal,
        );
        if (
            !Number.isSafeInteger(challenge.expiresAt) ||
            challenge.expiresAt < 0 ||
            !Number.isSafeInteger(challenge.intervalSeconds) ||
            challenge.intervalSeconds * 1000 < DEVICE_LOGIN_LIMITS.initialPollIntervalMilliseconds ||
            challenge.intervalSeconds * 1000 > DEVICE_LOGIN_LIMITS.maximumPollIntervalMilliseconds
        ) {
            throw new Error('The device login challenge is invalid');
        }
        const challengeDeadline = Math.min(challenge.expiresAt, localDeadline);
        runtime.stdout.write(
            `Open ${terminalText(challenge.verificationUrl)} and enter code ${terminalText(challenge.userCode)}\n`,
        );
        let warned = false;
        let interval = challenge.intervalSeconds;
        for (
            let poll = 0;
            poll < MAXIMUM_LOGIN_POLLS && authenticationTime(authentication.now()) < challengeDeadline;
            poll += 1
        ) {
            if (origin.startsWith('http://') && !warned) {
                runtime.stderr.write(`${HTTP_CREDENTIAL_WARNING}\n`);
                warned = true;
            }
            const exchanged = await retryCliAuthentication(
                authentication,
                async () => await authentication.exchange(origin, challenge.deviceSecret, cancellation.signal),
                cancellation.signal,
            );
            if (exchanged.status === 'credential') {
                const now = authenticationTime(authentication.now());
                if (!Number.isSafeInteger(exchanged.expiresAt) || exchanged.expiresAt <= now) {
                    throw new Error('The device credential expiry is invalid');
                }
                const expiresAt = Math.min(
                    exchanged.expiresAt,
                    authenticationTime(now + DEVICE_LOGIN_LIMITS.credentialLifetimeMilliseconds),
                );
                authentication.write(
                    Object.freeze({
                        schema: 'erden.cli-credential/v1',
                        origin,
                        credential: exchanged.credential,
                        expiresAt,
                    }),
                );
                runtime.stdout.write(`Logged in to ${terminalText(origin)}\n`);
                return CLI_EXIT.success;
            }
            if (exchanged.status === 'denied' || exchanged.status === 'invalid') {
                runtime.stderr.write('Erden login was denied or expired [DEVICE_LOGIN_CLOSED]\n');
                return CLI_EXIT.operational;
            }
            if (!('intervalSeconds' in exchanged)) {
                throw new Error('The device exchange response is invalid');
            }
            if (
                !Number.isSafeInteger(exchanged.intervalSeconds) ||
                exchanged.intervalSeconds * 1000 < DEVICE_LOGIN_LIMITS.initialPollIntervalMilliseconds ||
                exchanged.intervalSeconds * 1000 > DEVICE_LOGIN_LIMITS.maximumPollIntervalMilliseconds
            ) {
                throw new Error('The device exchange interval is invalid');
            }
            interval = exchanged.intervalSeconds;
            const remaining = challengeDeadline - authenticationTime(authentication.now());
            if (remaining <= 0) {
                break;
            }
            await authentication.sleep(Math.min(interval * 1000, remaining), cancellation.signal);
        }
        runtime.stderr.write('Erden login expired [DEVICE_LOGIN_EXPIRED]\n');
        return CLI_EXIT.operational;
    } catch {
        runtime.stderr.write(
            cancellation.signal.aborted
                ? 'Erden login expired [DEVICE_LOGIN_EXPIRED]\n'
                : 'Erden login could not complete [DEVICE_LOGIN_FAILED]\n',
        );
        return CLI_EXIT.operational;
    } finally {
        clearTimeout(deadlineTimer);
    }
}

async function logoutCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    const explicit = authenticationArguments('logout', arguments_);
    const authentication = runtime.authentication;
    if (authentication === undefined) {
        return unexpectedOperationalFailure(runtime);
    }
    const origin = authenticationOrigin(explicit, runtime);
    try {
        const revision = authentication.read(origin);
        if (revision === null) {
            runtime.stdout.write(`No credential is stored for ${terminalText(origin)}\n`);
            return CLI_EXIT.success;
        }
        if (origin.startsWith('http://')) {
            runtime.stderr.write(`${HTTP_CREDENTIAL_WARNING}\n`);
        }
        await retryCliAuthentication(authentication, async () => {
            await authentication.revoke(origin, revision.value.credential);
        });
        authentication.remove(revision);
        runtime.stdout.write(`Logged out from ${terminalText(origin)}\n`);
        return CLI_EXIT.success;
    } catch {
        runtime.stderr.write('Erden logout could not complete [DEVICE_LOGOUT_FAILED]\n');
        return CLI_EXIT.operational;
    }
}

function requireValue(arguments_: ReadonlyArray<string>, index: number, flag: string): string {
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('-')) {
        throw new CliUsageError(`${flag} requires a value`);
    }
    return value;
}

function markOnce(seen: Set<string>, flag: string): void {
    if (seen.has(flag)) {
        throw new CliUsageError(`${flag} may be specified only once`);
    }
    seen.add(flag);
}

function reasonerLimits(runtime: CliRuntime): ReasonerLimits {
    try {
        return parseReasonerLimits(runtime.environment?.() ?? {});
    } catch (cause) {
        throw new CliUsageError(
            cause instanceof ReasonerLimitSettingError ? cause.message : 'a reasoner limit setting is invalid',
        );
    }
}

async function checkCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    let offline = false;
    let json = false;
    let config: string | undefined;
    const positional: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--offline') {
            markOnce(seen, argument);
            offline = true;
        } else if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--config') {
            markOnce(seen, argument);
            config = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown check flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length > 1) {
        throw new CliUsageError('check accepts at most one project directory');
    }
    if (config !== undefined && positional.length !== 0) {
        throw new CliUsageError('check cannot combine a project directory with --config');
    }
    const limits = reasonerLimits(runtime);
    try {
        const cwd = runtime.cwd();
        const report = await Effect.runPromise(
            runtime.services.check.check({
                from: positional[0] === undefined ? cwd : resolve(cwd, positional[0]),
                ...(config === undefined ? {} : { manifestPath: resolve(cwd, config) }),
                offline,
                reasonerLimits: limits,
            }),
        );
        runtime.stdout.write(json ? encodeCheckProjectReport(report) : renderCheckProjectReport(report));
        return report.outcome === 'passed' ? CLI_EXIT.success : CLI_EXIT.semanticFailure;
    } catch (cause) {
        const error =
            cause instanceof CheckProjectOperationalError
                ? cause
                : new CheckProjectOperationalError(
                      'CHECK_OPERATION_FAILED',
                      'validation',
                      'The project check could not complete',
                  );
        runtime.stderr.write(renderCheckProjectError(error));
        return CLI_EXIT.operational;
    }
}

const FORMATS = new Set<ManifestSerializationFormat>(['json', 'jsonc', 'yml', 'yaml', 'toml']);

async function initCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    let format: ManifestSerializationFormat | undefined;
    let canonicalIri: string | undefined;
    let alias: string | undefined;
    let json = false;
    const ownedIriPrefixes: string[] = [];
    const positional: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--format') {
            markOnce(seen, argument);
            const value = requireValue(arguments_, index, argument);
            if (!FORMATS.has(value as ManifestSerializationFormat)) {
                throw new CliUsageError(`unsupported manifest format: ${value}`);
            }
            format = value as ManifestSerializationFormat;
            index += 1;
        } else if (argument === '--canonical-iri') {
            markOnce(seen, argument);
            canonicalIri = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument === '--alias') {
            markOnce(seen, argument);
            alias = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument === '--owned-prefix') {
            ownedIriPrefixes.push(requireValue(arguments_, index, argument));
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown init flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length !== 1) {
        throw new CliUsageError('init requires exactly one target directory');
    }
    try {
        const report = await Effect.runPromise(
            runtime.services.init.init({
                targetDirectory: positional[0] as string,
                from: runtime.cwd(),
                ...(format === undefined ? {} : { format }),
                ...(canonicalIri === undefined ? {} : { canonicalIri }),
                ...(alias === undefined ? {} : { alias }),
                ...(ownedIriPrefixes.length === 0 ? {} : { ownedIriPrefixes }),
            }),
        );
        runtime.stdout.write(json ? encodeInitProjectReport(report) : renderInitProjectReport(report));
        return CLI_EXIT.success;
    } catch (cause) {
        const error =
            cause instanceof InitProjectError
                ? cause
                : new InitProjectError('INIT_TRANSACTION_FAILED', 'The project could not be initialized');
        runtime.stderr.write(withToolchainGuidance(renderInitProjectError(error), error));
        return CLI_EXIT.operational;
    }
}

/** A failed command's rendering, followed by the next step when this source checkout has no reasoner build. */
function withToolchainGuidance(rendered: string, error: unknown): string {
    const guidance = toolchainGuidance(error);
    return guidance === null ? rendered : `${rendered}Next step: ${guidance}\n`;
}

async function doctorCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    let json = false;
    const seen = new Set<string>();
    for (const argument of arguments_) {
        if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else {
            throw new CliUsageError(
                argument.startsWith('-')
                    ? `unknown doctor flag: ${argument}`
                    : 'doctor does not accept positional arguments',
            );
        }
    }
    try {
        const report = await Effect.runPromise(runtime.services.doctor.inspect());
        runtime.stdout.write(json ? encodeDoctorReport(report) : renderDoctorReport(report));
        return report.outcome === 'passed' ? CLI_EXIT.success : CLI_EXIT.semanticFailure;
    } catch (cause) {
        const error = cause instanceof DoctorOperationalError ? cause : new DoctorOperationalError();
        runtime.stderr.write(renderDoctorError(error));
        return CLI_EXIT.operational;
    }
}

async function installCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    let offline = false;
    let frozenLockfile = false;
    let json = false;
    let config: string | undefined;
    const positional: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--offline') {
            markOnce(seen, argument);
            offline = true;
        } else if (argument === '--frozen-lockfile') {
            markOnce(seen, argument);
            frozenLockfile = true;
        } else if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--config') {
            markOnce(seen, argument);
            config = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown install flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length > 1) {
        throw new CliUsageError('install accepts at most one project directory');
    }
    if (config !== undefined && positional.length !== 0) {
        throw new CliUsageError('install cannot combine a project directory with --config');
    }
    try {
        const cwd = runtime.cwd();
        const report = await Effect.runPromise(
            runtime.services.install.install({
                ...(config === undefined
                    ? { from: positional[0] === undefined ? cwd : resolve(cwd, positional[0]) }
                    : { manifestPath: resolve(cwd, config) }),
                offline,
                frozenLockfile,
            }),
        );
        runtime.stdout.write(json ? encodeInstallProjectReport(report) : renderInstallProjectReport(report));
        return CLI_EXIT.success;
    } catch (cause) {
        const error =
            cause instanceof InstallProjectError
                ? cause
                : new InstallProjectError('INSTALL_PROJECT_STORE_FAILURE', 'The project install could not complete');
        runtime.stderr.write(withToolchainGuidance(renderInstallProjectError(error), error));
        return CLI_EXIT.operational;
    }
}

async function dependencyCommand(
    command: 'add' | 'remove',
    arguments_: ReadonlyArray<string>,
    runtime: CliRuntime,
): Promise<number> {
    let json = false;
    let config: string | undefined;
    const positional: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--config') {
            markOnce(seen, argument);
            config = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown ${command} flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length !== 1) {
        throw new CliUsageError(
            `${command} requires exactly one dependency ${command === 'add' ? 'specification' : 'identifier'}`,
        );
    }
    let addSpec: ReturnType<typeof parseAddDependencySpec> | undefined;
    if (command === 'add') {
        try {
            addSpec = parseAddDependencySpec(positional[0] as string);
        } catch {
            throw new CliUsageError(
                'add requires <identifier>@<range> with a valid authored identifier and semantic-version range',
            );
        }
    }
    try {
        const cwd = runtime.cwd();
        const selection = config === undefined ? { from: cwd } : { manifestPath: resolve(cwd, config) };
        const report =
            command === 'add'
                ? await Effect.runPromise(
                      runtime.services.dependencies.add({
                          identifier: (addSpec as NonNullable<typeof addSpec>).identifier,
                          range: (addSpec as NonNullable<typeof addSpec>).range,
                          ...selection,
                      }),
                  )
                : await Effect.runPromise(
                      runtime.services.dependencies.remove({
                          identifier: positional[0] as string,
                          ...selection,
                      }),
                  );
        runtime.stdout.write(json ? encodeProjectDependenciesReport(report) : renderProjectDependenciesReport(report));
        return CLI_EXIT.success;
    } catch (cause) {
        const error = isProjectDependenciesError(cause)
            ? cause
            : new ProjectDependenciesError(
                  'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                  'The project dependency change could not complete',
              );
        runtime.stderr.write(withToolchainGuidance(renderProjectDependenciesError(error), error));
        return CLI_EXIT.operational;
    }
}

async function updateCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    let json = false;
    let config: string | undefined;
    const positional: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--config') {
            markOnce(seen, argument);
            config = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown update flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length > 1) {
        throw new CliUsageError('update accepts at most one exact authored dependency identifier');
    }
    const identifier = positional[0];
    if (identifier !== undefined && !isScopedAlias(identifier) && !isCanonicalOntologyIri(identifier)) {
        throw new CliUsageError('update target must be one exact authored alias or canonical IRI');
    }
    try {
        const cwd = runtime.cwd();
        const report = await Effect.runPromise(
            runtime.services.dependencies.update({
                ...(identifier === undefined ? {} : { identifier }),
                ...(config === undefined ? { from: cwd } : { manifestPath: resolve(cwd, config) }),
            }),
        );
        runtime.stdout.write(
            json ? encodeProjectDependencyUpdateReport(report) : renderProjectDependencyUpdateReport(report),
        );
        return CLI_EXIT.success;
    } catch (cause) {
        const error = isProjectDependenciesError(cause)
            ? cause
            : new ProjectDependenciesError(
                  'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                  'The project dependency update could not complete',
              );
        runtime.stderr.write(withToolchainGuidance(renderProjectDependencyUpdateError(error), error));
        return CLI_EXIT.operational;
    }
}

async function pathCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    let json = false;
    let config: string | undefined;
    const positional: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--config') {
            markOnce(seen, argument);
            config = requireValue(arguments_, index, argument);
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown path flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length !== 1) {
        throw new CliUsageError('path requires exactly one layer identifier');
    }
    try {
        const cwd = runtime.cwd();
        const report = await Effect.runPromise(
            runtime.services.path.path({
                identifier: positional[0] as string,
                ...(config === undefined ? { from: cwd } : { manifestPath: resolve(cwd, config) }),
            }),
        );
        runtime.stdout.write(json ? encodeProjectPathReport(report) : renderProjectPathReport(report));
        return CLI_EXIT.success;
    } catch (cause) {
        const error =
            cause instanceof ProjectPathError
                ? cause
                : new ProjectPathError('PROJECT_PATH_STORE_FAILURE', 'The project layer path could not be resolved');
        runtime.stderr.write(withToolchainGuidance(renderProjectPathError(error), error));
        return CLI_EXIT.operational;
    }
}

async function packCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    const seen = new Set<string>();
    const positional: string[] = [];
    let config: string | undefined;
    let output: string | undefined;
    let json = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--config' || argument === '--output') {
            markOnce(seen, argument);
            const value = requireValue(arguments_, index, argument);
            if (argument === '--config') {
                config = value;
            } else {
                output = value;
            }
            index += 1;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown pack flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length < 1 || positional.length > 2) {
        throw new CliUsageError('pack requires a version and accepts at most one project directory');
    }
    if (config !== undefined && positional.length === 2) {
        throw new CliUsageError('pack cannot combine a project directory with --config');
    }
    const cwd = runtime.cwd();
    try {
        const report = await Effect.runPromise(
            runtime.services.pack.pack({
                version: positional[0] as string,
                ...(config === undefined
                    ? positional[1] === undefined
                        ? { from: cwd }
                        : { from: resolve(cwd, positional[1]) }
                    : { manifestPath: resolve(cwd, config) }),
                ...(output === undefined ? {} : { outputPath: resolve(cwd, output) }),
            }),
        );
        runtime.stdout.write(json ? encodePackProjectReport(report) : renderPackProjectReport(report));
        return CLI_EXIT.success;
    } catch (cause) {
        const error = isPackProjectError(cause)
            ? cause
            : new PackProjectError('PACK_PROJECT_TRANSACTION_FAILED', 'The project package could not be created');
        runtime.stderr.write(withToolchainGuidance(renderPackProjectError(error), error));
        return CLI_EXIT.operational;
    }
}

async function storeCommand(arguments_: ReadonlyArray<string>, runtime: CliRuntime): Promise<number> {
    let json = false;
    let dryRun = false;
    const positional: string[] = [];
    const seen = new Set<string>();
    for (const argument of arguments_) {
        if (argument === '--json') {
            markOnce(seen, argument);
            json = true;
        } else if (argument === '--dry-run') {
            markOnce(seen, argument);
            dryRun = true;
        } else if (argument.startsWith('-')) {
            throw new CliUsageError(`unknown store flag: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length !== 1 || !['path', 'status', 'prune'].includes(positional[0] as string)) {
        throw new CliUsageError('store requires exactly one path, status, or prune subcommand');
    }
    const command = positional[0] as 'path' | 'status' | 'prune';
    if (dryRun && command !== 'prune') {
        throw new CliUsageError('--dry-run is available only for store prune');
    }
    try {
        if (command === 'path') {
            const report = await Effect.runPromise(runtime.services.storePath.path());
            runtime.stdout.write(json ? encodeStorePathReport(report) : renderStorePathReport(report));
            return CLI_EXIT.success;
        }
        if (command === 'status') {
            const report = await Effect.runPromise(runtime.services.storeMaintenance.status());
            runtime.stdout.write(json ? encodeStoreStatusReport(report) : renderStoreStatusReport(report));
            return report.outcome === 'healthy' ? CLI_EXIT.success : CLI_EXIT.semanticFailure;
        }
        if (!dryRun) {
            runtime.stderr.write(`${STORE_PRUNE_REACQUISITION_WARNING}\n`);
        }
        const report = await Effect.runPromise(runtime.services.storeMaintenance.prune({ dryRun }));
        runtime.stdout.write(json ? encodeStorePruneReport(report) : renderStorePruneReport(report));
        return CLI_EXIT.success;
    } catch (cause) {
        if (command !== 'path') {
            const error = isStoreMaintenanceError(cause)
                ? cause
                : new StoreMaintenanceError(
                      'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                      'The local store maintenance operation could not complete',
                  );
            runtime.stderr.write(renderStoreMaintenanceError(error));
            return CLI_EXIT.operational;
        }
        const error =
            cause instanceof StorePathError
                ? cause
                : new StorePathError(
                      'STORE_PATH_ENVIRONMENT_UNAVAILABLE',
                      'The default local package store path is unavailable',
                  );
        runtime.stderr.write(renderStorePathError(error));
        return CLI_EXIT.operational;
    }
}

export async function runCli(arguments_: ReadonlyArray<string>, runtime: CliRuntime = nodeCliRuntime): Promise<number> {
    const command = arguments_[0];
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
        if (arguments_.length > 1) {
            return usageFailure(runtime, 'help does not accept additional arguments');
        }
        runtime.stdout.write(CLI_HELP);
        return CLI_EXIT.success;
    }
    try {
        if (command === 'check') {
            return await checkCommand(arguments_.slice(1), runtime);
        }
        if (command === 'init') {
            return await initCommand(arguments_.slice(1), runtime);
        }
        if (command === 'doctor') {
            return await doctorCommand(arguments_.slice(1), runtime);
        }
        if (command === 'install') {
            return await installCommand(arguments_.slice(1), runtime);
        }
        if (command === 'add' || command === 'remove') {
            return await dependencyCommand(command, arguments_.slice(1), runtime);
        }
        if (command === 'update') {
            return await updateCommand(arguments_.slice(1), runtime);
        }
        if (command === 'pack') {
            return await packCommand(arguments_.slice(1), runtime);
        }
        if (command === 'publish') {
            return await runPublishCommand(arguments_.slice(1), {
                cwd: runtime.cwd,
                stdout: runtime.stdout,
                stderr: runtime.stderr,
                pack: runtime.services.pack,
                ...(runtime.publication === undefined ? {} : { publication: runtime.publication }),
            });
        }
        if (command === 'publication') {
            return await runPublicationCommand(arguments_.slice(1), {
                cwd: runtime.cwd,
                stdout: runtime.stdout,
                stderr: runtime.stderr,
                pack: runtime.services.pack,
                ...(runtime.publication === undefined ? {} : { publication: runtime.publication }),
            });
        }
        if (command === 'query') {
            return await runQueryCommand(arguments_.slice(1), {
                cwd: runtime.cwd,
                stdout: runtime.stdout,
                stderr: runtime.stderr,
                ...(runtime.query === undefined ? {} : { query: runtime.query }),
            });
        }
        if (command === 'path') {
            return await pathCommand(arguments_.slice(1), runtime);
        }
        if (command === 'store') {
            return await storeCommand(arguments_.slice(1), runtime);
        }
        if (command === 'login') {
            return await loginCommand(arguments_.slice(1), runtime);
        }
        if (command === 'logout') {
            return await logoutCommand(arguments_.slice(1), runtime);
        }
        throw new CliUsageError(`unknown command: ${command}`);
    } catch (cause) {
        return cause instanceof CliUsageError || cause instanceof CliRegistryUsageError
            ? usageFailure(runtime, cause.message)
            : unexpectedOperationalFailure(runtime);
    }
}
