import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Context, Effect } from 'effect';

import {
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    serializeLockfileBytes,
    type CurrentToolchainShape,
    type LockfileV1,
    type LockPackageNode,
    type LockToolchain,
    MANIFEST_FILENAMES,
} from '@erden/contracts';
import type { RegistryReleaseIndexReaderShape } from '@erden/contracts';
import { PACKAGE_CODEC_LIMITS, type PackageArchiveSource } from '@erden/package-format';

import {
    makeDependencyResolver,
    makeDependencyResolverFromReleaseIndex,
    isDependencyRegistryUnavailableError,
    isDependencyResolutionError,
    type DependencyArchiveReaderShape,
    type DependencyRegistryShape,
    type DependencyResolverShape,
} from '../dependencies/index.js';
import type { ApplicationOperation } from '../index.js';
import {
    nodeProjectDependencyStateService,
    isProjectDependencyStateError,
    type ProjectDependencyStateInspection,
    type ProjectDependencyStateServiceShape,
} from '../project-dependency-state/index.js';
import {
    nodeLocalPackageStore,
    nodeStoreEnvironment,
    resolveDefaultStoreRoot,
    type LockAvailability,
    type MaterializeLockResult,
    type PutPackageInput,
    type PutPackageResult,
    type RefreshProjectReferenceInput,
    type RefreshProjectReferenceResult,
    type RepairPackageResult,
} from '../store/index.js';

import {
    InstallProjectError,
    InstallProjectTransactionPendingError,
    InstallProjectUnavailableError,
    isInstallProjectError,
} from './errors.js';
import { decodeInstallProjectReport, INSTALL_REPORT_VERSION, type InstallProjectReport } from './report.js';

export interface InstallProjectOptions {
    readonly from?: string;
    readonly manifestPath?: string;
    readonly storeRoot?: string;
    readonly offline?: boolean;
    readonly frozenLockfile?: boolean;
}

export interface InstallProjectStoreShape {
    readonly refreshProjectReference: (
        input: RefreshProjectReferenceInput,
    ) => Effect.Effect<RefreshProjectReferenceResult, unknown>;
    readonly verifyLockAvailability: (
        input: Readonly<{ readonly storeRoot: string; readonly lock: LockfileV1 }>,
    ) => Effect.Effect<LockAvailability, unknown>;
    readonly put: (input: PutPackageInput) => Effect.Effect<PutPackageResult, unknown>;
    readonly repair: (input: PutPackageInput) => Effect.Effect<RepairPackageResult, unknown>;
    readonly materialize: (
        input: Readonly<{ readonly storeRoot: string; readonly projectRoot: string; readonly lock: LockfileV1 }>,
    ) => Effect.Effect<MaterializeLockResult, unknown>;
}

export interface InstallProjectRuntime {
    readonly defaultStoreRoot: () => string;
    /** Names the leftover transaction files of an interrupted install, for a refusal that recovery cannot fix. */
    readonly transactionResidue?: (
        input: Readonly<{ readonly from?: string; readonly manifestPath?: string }>,
    ) => Promise<ReadonlyArray<string>>;
}

export type InstallProjectStateShape = Pick<
    ProjectDependencyStateServiceShape,
    'inspect' | 'recheck' | 'write' | 'recover'
>;

const TRANSACTION_RESIDUE_PREFIX = '.erden.dependencies.';
const MAXIMUM_RESIDUE_SEARCH_DEPTH = 64;

/**
 * Lists `.erden.dependencies.*` basenames in the project directory: the selected manifest's directory, or the nearest
 * directory at or above `from` that holds residue or a manifest. Read-only and best effort.
 */
export async function nodeTransactionResidue(
    input: Readonly<{ readonly from?: string; readonly manifestPath?: string }>,
): Promise<ReadonlyArray<string>> {
    const start = resolve(input.from ?? process.cwd());
    let directory = input.manifestPath === undefined ? start : dirname(resolve(start, input.manifestPath));
    for (let depth = 0; depth < MAXIMUM_RESIDUE_SEARCH_DEPTH; depth += 1) {
        let names: ReadonlyArray<string>;
        try {
            names = await readdir(directory);
        } catch {
            return [];
        }
        const residue = names.filter((name) => name.startsWith(TRANSACTION_RESIDUE_PREFIX)).sort(compare);
        if (
            residue.length > 0 ||
            input.manifestPath !== undefined ||
            names.some((name) => (MANIFEST_FILENAMES as ReadonlyArray<string>).includes(name))
        ) {
            return residue;
        }
        const parent = dirname(directory);
        if (parent === directory) {
            return [];
        }
        directory = parent;
    }
    return [];
}

export interface InstallCommittedStateInput {
    readonly state: ProjectDependencyStateInspection;
    readonly toolchain: LockToolchain;
    readonly storeRoot?: string;
    readonly offline: boolean;
    readonly frozenLockfile: boolean;
    readonly lockStatus: 'existing' | 'written';
    readonly lockCleanup: 'clean' | 'cleanup-residue-retained';
}

export interface InstallCommittedStateServiceShape {
    readonly installCommitted: (
        input: InstallCommittedStateInput,
    ) => Effect.Effect<InstallProjectReport, InstallProjectError>;
}

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotOptions(
    input: InstallProjectOptions,
): Required<Pick<InstallProjectOptions, 'offline' | 'frozenLockfile'>> &
    Pick<InstallProjectOptions, 'from' | 'manifestPath' | 'storeRoot'> {
    try {
        const unknownInput: unknown = input;
        if (
            unknownInput === null ||
            typeof unknownInput !== 'object' ||
            Array.isArray(unknownInput) ||
            Object.getPrototypeOf(unknownInput) !== Object.prototype ||
            Object.getOwnPropertySymbols(unknownInput).length !== 0
        ) {
            throw new Error('options shape');
        }
        const allowed = new Set(['from', 'manifestPath', 'storeRoot', 'offline', 'frozenLockfile']);
        const values = new Map<string, unknown>();
        for (const key of Object.getOwnPropertyNames(unknownInput)) {
            if (!allowed.has(key)) {
                throw new Error('options field');
            }
            const descriptor = Object.getOwnPropertyDescriptor(unknownInput, key);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('options accessor');
            }
            values.set(key, descriptor.value);
        }
        const from = values.get('from');
        const manifestPath = values.get('manifestPath');
        const storeRoot = values.get('storeRoot');
        const offline = values.get('offline') ?? false;
        const frozenLockfile = values.get('frozenLockfile') ?? false;
        if (
            (from !== undefined && typeof from !== 'string') ||
            (manifestPath !== undefined && typeof manifestPath !== 'string') ||
            (storeRoot !== undefined && typeof storeRoot !== 'string') ||
            typeof offline !== 'boolean' ||
            typeof frozenLockfile !== 'boolean'
        ) {
            throw new Error('options value');
        }
        return Object.freeze({
            ...(from === undefined ? {} : { from }),
            ...(manifestPath === undefined ? {} : { manifestPath }),
            ...(storeRoot === undefined ? {} : { storeRoot }),
            offline,
            frozenLockfile,
        });
    } catch (cause) {
        throw new InstallProjectError('INSTALL_PROJECT_INVALID_INPUT', 'The install options are invalid', cause);
    }
}

function lockDigest(lock: LockfileV1): string {
    return createHash('sha256').update(serializeLockfileBytes(lock)).digest('hex');
}

function exactAvailabilityRecord(input: unknown): Record<string, unknown> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new TypeError('availability shape');
    }
    const expected = ['busy', 'corrupt', 'missing', 'packages', 'status'];
    const names = Object.getOwnPropertyNames(input).sort(compare);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        throw new TypeError('availability fields');
    }
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('availability descriptor');
        }
    }
    return input as Record<string, unknown>;
}

function availabilityDigests(input: unknown, allowed: ReadonlySet<string>, maximum: number): ReadonlyArray<string> {
    if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0 ||
        input.length > maximum
    ) {
        throw new TypeError('availability digest array');
    }
    const names = Object.getOwnPropertyNames(input);
    if (names.length !== input.length + 1 || !names.includes('length')) {
        throw new TypeError('availability sparse array');
    }
    const result: string[] = [];
    for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('availability digest descriptor');
        }
        const digest: unknown = descriptor.value;
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest) || !allowed.has(digest)) {
            throw new TypeError('availability digest');
        }
        const previous = result.at(-1);
        if (previous !== undefined && compare(previous, digest) >= 0) {
            throw new TypeError('availability digest order');
        }
        result.push(digest);
    }
    return Object.freeze(result);
}

export function decodeLockAvailability(lock: LockfileV1, input: unknown): LockAvailability {
    try {
        const record = exactAvailabilityRecord(input);
        const packages = record['packages'];
        if (!Number.isSafeInteger(packages) || Object.is(packages, -0) || packages !== lock.packages.length) {
            throw new TypeError('availability package count');
        }
        const expectedDigests = new Set(lock.packages.map(({ archiveSha256 }) => archiveSha256));
        const missing = availabilityDigests(record['missing'], expectedDigests, expectedDigests.size);
        const corrupt = availabilityDigests(record['corrupt'], expectedDigests, expectedDigests.size);
        const busy = availabilityDigests(record['busy'], expectedDigests, expectedDigests.size);
        const issueDigests = [...missing, ...corrupt, ...busy];
        if (new Set(issueDigests).size !== issueDigests.length) {
            throw new TypeError('availability sets overlap');
        }
        const status = record['status'];
        const hasIssues = issueDigests.length > 0;
        if ((status !== 'available' && status !== 'unavailable') || (status === 'available') === hasIssues) {
            throw new TypeError('availability status');
        }
        return Object.freeze({ status, packages, missing, corrupt, busy });
    } catch (cause) {
        throw new InstallProjectError(
            'INSTALL_PROJECT_STORE_FAILURE',
            'The local package store returned invalid availability truth',
            cause,
        );
    }
}

function unavailableSet(availability: LockAvailability): Set<string> {
    return new Set([...availability.missing, ...availability.corrupt]);
}

function nodeForDigest(lock: LockfileV1, digest: string): LockPackageNode {
    const node = lock.packages.find((candidate) => candidate.archiveSha256 === digest);
    if (node === undefined) {
        throw new InstallProjectError(
            'INSTALL_PROJECT_STORE_FAILURE',
            'Store availability referenced a digest outside the canonical lock',
        );
    }
    return node;
}

function mapFailure(code: InstallProjectError['code'], message: string) {
    return (cause: unknown): InstallProjectError =>
        isInstallProjectError(cause) ? cause : new InstallProjectError(code, message, cause);
}

function causedByUnavailableRegistry(cause: unknown): boolean {
    let current: unknown = cause;
    const seen = new Set<unknown>();
    for (let depth = 0; depth < 32; depth += 1) {
        if (isDependencyRegistryUnavailableError(current)) {
            return true;
        }
        if (!isDependencyResolutionError(current) || seen.has(current)) {
            return false;
        }
        seen.add(current);
        let descriptor: PropertyDescriptor | undefined;
        try {
            descriptor = Object.getOwnPropertyDescriptor(current, 'cause');
        } catch {
            return false;
        }
        if (
            descriptor === undefined ||
            !('value' in descriptor) ||
            descriptor.enumerable ||
            descriptor.configurable ||
            descriptor.writable
        ) {
            return false;
        }
        current = descriptor.value;
    }
    return false;
}

function exactMaterializationRecord(
    input: unknown,
    expected: ReadonlyArray<string>,
    label: string,
): ReadonlyMap<string, unknown> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new TypeError(`${label} shape`);
    }
    const names = Object.getOwnPropertyNames(input).sort(compare);
    const wanted = [...expected].sort(compare);
    if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) {
        throw new TypeError(`${label} fields`);
    }
    const values = new Map<string, unknown>();
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError(`${label} descriptor`);
        }
        values.set(name, descriptor.value);
    }
    return values;
}

function nonnegativeCount(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
        throw new TypeError(`${label} count`);
    }
    return value as number;
}

export function decodeRefreshProjectReferenceResult(lock: LockfileV1, input: unknown): RefreshProjectReferenceResult {
    try {
        const record = exactMaterializationRecord(
            input,
            ['generationSha256', 'lockSha256', 'packages', 'registrationId', 'status'],
            'project registration',
        );
        const status = record.get('status');
        const registrationId = record.get('registrationId');
        const generationSha256 = record.get('generationSha256');
        const observedLockSha256 = record.get('lockSha256');
        const packages = nonnegativeCount(record.get('packages'), 'project registration package');
        if (
            (status !== 'registered' && status !== 'hit') ||
            typeof registrationId !== 'string' ||
            !/^[0-9a-f]{64}$/u.test(registrationId) ||
            typeof generationSha256 !== 'string' ||
            !/^[0-9a-f]{64}$/u.test(generationSha256) ||
            observedLockSha256 !== lockDigest(lock) ||
            packages !== lock.packages.length
        ) {
            throw new TypeError('project registration truth');
        }
        return Object.freeze({ status, registrationId, generationSha256, lockSha256: observedLockSha256, packages });
    } catch (cause) {
        throw new InstallProjectError(
            'INSTALL_PROJECT_STORE_FAILURE',
            'The local package store returned invalid project registration truth',
            cause,
        );
    }
}

function assertMaterializationStrategyTruth(
    status: 'hit' | 'materialized',
    packages: number,
    strategies: Readonly<{
        readonly clone: number;
        readonly hardlink: number;
        readonly copy: number;
    }>,
): void {
    const total = BigInt(strategies.clone) + BigInt(strategies.hardlink) + BigInt(strategies.copy);
    const packageCount = BigInt(packages);
    const maximum = packageCount * BigInt(PACKAGE_CODEC_LIMITS.maxEntries);
    if (
        (status === 'hit' && total !== 0n) ||
        (status === 'materialized' && packages === 0 && total !== 0n) ||
        (status === 'materialized' && packages > 0 && total < packageCount) ||
        total > maximum
    ) {
        throw new TypeError('materialization strategy truth');
    }
}

export function decodeMaterializeLockResult(lock: LockfileV1, input: unknown): MaterializeLockResult {
    try {
        const record = exactMaterializationRecord(
            input,
            ['cleanup', 'manifestDependencySha256', 'packages', 'status', 'strategies'],
            'materialization',
        );
        const status = record.get('status');
        const cleanup = record.get('cleanup');
        const manifestDependencySha256 = record.get('manifestDependencySha256');
        const packages = nonnegativeCount(record.get('packages'), 'materialization package');
        if (
            (status !== 'hit' && status !== 'materialized') ||
            (cleanup !== 'clean' && cleanup !== 'cleanup-residue-retained') ||
            manifestDependencySha256 !== lock.manifestDependencySha256 ||
            packages !== lock.packages.length
        ) {
            throw new TypeError('materialization identity truth');
        }
        const strategyRecord = exactMaterializationRecord(
            record.get('strategies'),
            ['clone', 'copy', 'hardlink'],
            'materialization strategies',
        );
        const strategies = Object.freeze({
            clone: nonnegativeCount(strategyRecord.get('clone'), 'clone strategy'),
            hardlink: nonnegativeCount(strategyRecord.get('hardlink'), 'hardlink strategy'),
            copy: nonnegativeCount(strategyRecord.get('copy'), 'copy strategy'),
        });
        assertMaterializationStrategyTruth(status, packages, strategies);
        return Object.freeze({ status, cleanup, manifestDependencySha256, packages, strategies });
    } catch (cause) {
        throw new InstallProjectError(
            'INSTALL_PROJECT_STORE_FAILURE',
            'The local package store returned invalid materialization truth',
            cause,
        );
    }
}

function resolutionFailure(cause: unknown): InstallProjectError {
    return causedByUnavailableRegistry(cause)
        ? new InstallProjectError(
              'INSTALL_PROJECT_REGISTRY_UNAVAILABLE',
              'No production dependency registry transport is configured',
              cause,
          )
        : isDependencyResolutionError(cause) && cause.code === 'toolchain-incompatible'
          ? // The resolver names the dependency and the toolchain; the remedy is a republish, not a local fix.
            new InstallProjectError('INSTALL_PROJECT_RESOLUTION_FAILED', cause.message, cause)
          : mapFailure('INSTALL_PROJECT_RESOLUTION_FAILED', 'The dependency closure could not be resolved')(cause);
}

function stateFailure(message: string) {
    return mapFailure('INSTALL_PROJECT_LOCK_INVALID', message);
}

function stateInspectFailure(cause: unknown): InstallProjectError {
    return isProjectDependencyStateError(cause) && cause.code === 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE'
        ? new InstallProjectError(
              'INSTALL_PROJECT_MANIFEST_UNAVAILABLE',
              'The project manifest could not be located, decoded, or authenticated',
              cause,
          )
        : stateFailure('The project manifest and erden.lock could not be authenticated')(cause);
}

function withTerminalStateRecheck<Value>(
    effect: Effect.Effect<Value, InstallProjectError>,
    revision: ProjectDependencyStateInspection['revision'],
    states: Pick<ProjectDependencyStateServiceShape, 'recheck'>,
): Effect.Effect<Value, InstallProjectError> {
    return Effect.matchEffect(effect, {
        onFailure: (failure) =>
            states.recheck({ revision }).pipe(
                Effect.mapError(stateFailure('The project dependency state changed while install was running')),
                Effect.flatMap(() => Effect.fail(failure)),
            ),
        onSuccess: (value) =>
            states
                .recheck({ revision })
                .pipe(
                    Effect.mapError(stateFailure('The project dependency state changed while install was running')),
                    Effect.as(value),
                ),
    });
}

function runInstallCommittedState(
    input: InstallCommittedStateInput,
    states: Pick<ProjectDependencyStateServiceShape, 'recheck'>,
    archives: DependencyArchiveReaderShape,
    store: InstallProjectStoreShape,
    runtime: InstallProjectRuntime,
): Effect.Effect<InstallProjectReport, InstallProjectError> {
    const state = input.state;
    const lockInspection = state.lockInspection;
    if (lockInspection.status !== 'available') {
        return Effect.fail(
            new InstallProjectError(
                'INSTALL_PROJECT_LOCK_INVALID',
                'A canonical matching erden.lock is required before installation',
            ),
        );
    }
    const lock = lockInspection.lock;
    const project = state.project;
    const storeRootEffect = Effect.try({
        try: () => input.storeRoot ?? runtime.defaultStoreRoot(),
        catch: mapFailure('INSTALL_PROJECT_INVALID_INPUT', 'The local package store root is unavailable'),
    });
    const install = Effect.gen(function* () {
        const storeRoot = yield* storeRootEffect;
        yield* states
            .recheck({ revision: state.revision })
            .pipe(Effect.mapError(stateFailure('The project dependency state changed before store registration')));
        const registrationInput = yield* store
            .refreshProjectReference({
                storeRoot,
                projectRoot: project.projectRoot,
                manifestPath: project.filePath,
                manifestSha256: createHash('sha256').update(state.manifestBytes).digest('hex'),
                lock,
            })
            .pipe(
                Effect.mapError(
                    mapFailure(
                        'INSTALL_PROJECT_STORE_FAILURE',
                        'The project store reference could not be refreshed safely',
                    ),
                ),
            );
        yield* Effect.try({
            try: () => decodeRefreshProjectReferenceResult(lock, registrationInput),
            catch: mapFailure(
                'INSTALL_PROJECT_STORE_FAILURE',
                'The local package store returned invalid project registration truth',
            ),
        });
        yield* states
            .recheck({ revision: state.revision })
            .pipe(
                Effect.mapError(
                    stateFailure('The project dependency state changed while its store reference was refreshed'),
                ),
            );
        const initialAvailabilityInput = yield* store
            .verifyLockAvailability({ storeRoot, lock })
            .pipe(
                Effect.mapError(
                    mapFailure('INSTALL_PROJECT_STORE_FAILURE', 'The local package store could not be verified'),
                ),
            );
        const availability = yield* Effect.try({
            try: () => decodeLockAvailability(lock, initialAvailabilityInput),
            catch: mapFailure(
                'INSTALL_PROJECT_STORE_FAILURE',
                'The local package store returned invalid availability truth',
            ),
        });
        if (availability.busy.length > 0) {
            return yield* Effect.fail(new InstallProjectUnavailableError(availability));
        }
        if (input.offline && availability.status === 'unavailable') {
            return yield* Effect.fail(new InstallProjectUnavailableError(availability));
        }
        const fetched: string[] = [];
        const repaired: string[] = [];
        const unavailable = unavailableSet(availability);
        if (unavailable.size > 0) {
            const origin = lock.registryOrigin;
            if (origin === null) {
                return yield* Effect.fail(new InstallProjectUnavailableError(availability));
            }
            for (const digest of [...unavailable].sort(compare)) {
                const node = nodeForDigest(lock, digest);
                const operation = availability.corrupt.includes(digest) ? ('repair' as const) : ('put' as const);
                yield* Effect.acquireUseRelease(
                    Effect.try({
                        try: () => {
                            const controller = new AbortController();
                            const pending = archives.fetchArchive(origin, node, controller.signal);
                            return Object.freeze({ controller, pending });
                        },
                        catch: mapFailure(
                            'INSTALL_PROJECT_REGISTRY_UNAVAILABLE',
                            'The dependency registry could not provide a locked archive',
                        ),
                    }),
                    ({ pending }) =>
                        Effect.gen(function* () {
                            const archive = yield* Effect.tryPromise({
                                try: async (): Promise<PackageArchiveSource | null> => await pending,
                                catch: mapFailure(
                                    'INSTALL_PROJECT_REGISTRY_UNAVAILABLE',
                                    'The dependency registry could not provide a locked archive',
                                ),
                            });
                            if (archive === null) {
                                return yield* Effect.fail(
                                    new InstallProjectError(
                                        'INSTALL_PROJECT_REGISTRY_UNAVAILABLE',
                                        'The dependency registry does not contain an exact locked archive',
                                    ),
                                );
                            }
                            if (operation === 'repair') {
                                yield* store
                                    .repair({ storeRoot, expected: node, toolchain: input.toolchain, archive })
                                    .pipe(
                                        Effect.mapError(
                                            mapFailure(
                                                'INSTALL_PROJECT_STORE_FAILURE',
                                                'A corrupt locked package could not be repaired safely',
                                            ),
                                        ),
                                    );
                            } else {
                                yield* store
                                    .put({ storeRoot, expected: node, toolchain: input.toolchain, archive })
                                    .pipe(
                                        Effect.mapError(
                                            mapFailure(
                                                'INSTALL_PROJECT_STORE_FAILURE',
                                                'A locked package could not be ingested safely',
                                            ),
                                        ),
                                    );
                            }
                        }),
                    ({ controller, pending }) =>
                        Effect.promise(async () => {
                            controller.abort();
                            await pending.catch(() => undefined);
                        }),
                );
                if (operation === 'repair') {
                    repaired.push(digest);
                } else {
                    fetched.push(digest);
                }
            }
            const finalAvailabilityInput = yield* store
                .verifyLockAvailability({ storeRoot, lock })
                .pipe(
                    Effect.mapError(
                        mapFailure(
                            'INSTALL_PROJECT_STORE_FAILURE',
                            'The acquired package closure could not be reverified',
                        ),
                    ),
                );
            const finalAvailability = yield* Effect.try({
                try: () => decodeLockAvailability(lock, finalAvailabilityInput),
                catch: mapFailure(
                    'INSTALL_PROJECT_STORE_FAILURE',
                    'The acquired package closure returned invalid availability truth',
                ),
            });
            if (finalAvailability.status === 'unavailable') {
                return yield* Effect.fail(new InstallProjectUnavailableError(finalAvailability));
            }
        }
        const materializedInput = yield* store
            .materialize({ storeRoot, projectRoot: project.projectRoot, lock })
            .pipe(
                Effect.mapError(
                    mapFailure(
                        'INSTALL_PROJECT_STORE_FAILURE',
                        'The exact locked project closure could not be materialized',
                    ),
                ),
            );
        const materialized = yield* Effect.try({
            try: () => decodeMaterializeLockResult(lock, materializedInput),
            catch: mapFailure(
                'INSTALL_PROJECT_STORE_FAILURE',
                'The local package store returned invalid materialization truth',
            ),
        });
        const changed = new Set([...fetched, ...repaired]);
        const reused = [...new Set(lock.packages.map(({ archiveSha256 }) => archiveSha256))]
            .filter((digest) => !changed.has(digest))
            .sort(compare);
        return yield* Effect.try({
            try: () =>
                decodeInstallProjectReport({
                    schema: INSTALL_REPORT_VERSION,
                    project: { canonicalIri: project.manifest.canonicalIri, alias: project.manifest.alias },
                    mode: { offline: input.offline, frozenLockfile: input.frozenLockfile },
                    lock: { status: input.lockStatus, cleanup: input.lockCleanup, sha256: lockDigest(lock) },
                    packages: {
                        total: lock.packages.length,
                        reused,
                        fetched: fetched.sort(compare),
                        repaired: repaired.sort(compare),
                    },
                    materialization: {
                        status: materialized.status,
                        cleanup: materialized.cleanup,
                        strategies: materialized.strategies,
                    },
                    outcome: 'installed',
                }),
            catch: mapFailure(
                'INSTALL_PROJECT_STORE_FAILURE',
                'The deterministic install report could not be constructed',
            ),
        });
    });
    return withTerminalStateRecheck(install, state.revision, states);
}

function runInstallProject(
    input: InstallProjectOptions,
    states: InstallProjectStateShape,
    toolchains: CurrentToolchainShape,
    resolver: DependencyResolverShape,
    committed: InstallCommittedStateServiceShape,
    runtime: InstallProjectRuntime,
): Effect.Effect<InstallProjectReport, InstallProjectError> {
    return Effect.gen(function* () {
        const options = yield* Effect.try({
            try: () => snapshotOptions(input),
            catch: mapFailure('INSTALL_PROJECT_INVALID_INPUT', 'The install options are invalid'),
        });
        const toolchain = yield* toolchains
            .inspect()
            .pipe(
                Effect.mapError(
                    mapFailure(
                        'INSTALL_PROJECT_TOOLCHAIN_UNAVAILABLE',
                        'The current dependency toolchain is unavailable',
                    ),
                ),
            );
        const selection = {
            ...(options.from === undefined ? {} : { from: options.from }),
            ...(options.manifestPath === undefined ? {} : { explicitPath: options.manifestPath }),
            toolchain,
        };
        // An interrupted install leaves a transaction that read-only inspection refuses. Install is the writer, so it
        // runs the existing writer recovery first: authenticated residue rolls back or forward, and install proceeds.
        let state = yield* states.inspect(selection).pipe(
            Effect.catch((cause) =>
                isProjectDependencyStateError(cause) && cause.code === 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT'
                    ? states.recover(selection).pipe(
                          Effect.catch((recoveryCause) =>
                              Effect.promise(async () =>
                                  runtime.transactionResidue === undefined
                                      ? []
                                      : await runtime
                                            .transactionResidue({
                                                ...(options.from === undefined ? {} : { from: options.from }),
                                                ...(options.manifestPath === undefined
                                                    ? {}
                                                    : { manifestPath: options.manifestPath }),
                                            })
                                            .catch(() => []),
                              ).pipe(
                                  Effect.flatMap((residue) =>
                                      Effect.fail(new InstallProjectTransactionPendingError(residue, recoveryCause)),
                                  ),
                              ),
                          ),
                      )
                    : Effect.fail(stateInspectFailure(cause)),
            ),
        );
        const prepare = Effect.gen(function* () {
            let lockStatus: 'existing' | 'written' = 'existing';
            if (state.lockInspection.status !== 'available') {
                if (options.frozenLockfile) {
                    return yield* Effect.fail(
                        new InstallProjectError(
                            'INSTALL_PROJECT_FROZEN_LOCK_REQUIRED',
                            'A canonical matching erden.lock is required by frozen-lockfile mode',
                        ),
                    );
                }
                const dependencyCount = Object.keys(state.project.manifest.dependencies).length;
                let lock: LockfileV1;
                if (dependencyCount === 0) {
                    lock = yield* Effect.try({
                        try: () => makeEmptyLockfile(state.project.manifest, toolchain),
                        catch: mapFailure(
                            'INSTALL_PROJECT_RESOLUTION_FAILED',
                            'The canonical empty dependency closure could not be resolved',
                        ),
                    });
                } else {
                    if (options.offline) {
                        return yield* Effect.fail(
                            new InstallProjectError(
                                'INSTALL_PROJECT_OFFLINE_LOCK_REQUIRED',
                                'Offline install requires a canonical matching erden.lock for nonempty dependencies',
                            ),
                        );
                    }
                    const resolved = yield* resolver
                        .resolve({
                            manifest: state.project.manifest,
                            toolchain,
                            ...(state.lockInspection.lock === null ? {} : { existingLock: state.lockInspection.lock }),
                        })
                        .pipe(Effect.mapError(resolutionFailure));
                    lock = resolved.lock;
                }
                const written = yield* states
                    .write({
                        revision: state.revision,
                        manifest: { kind: 'preserve' },
                        lock,
                    })
                    .pipe(
                        Effect.mapError(stateFailure('The canonical project dependency state could not be published')),
                    );
                state = written.state;
                lockStatus = 'written';
            }
            return Object.freeze({ state, lockStatus });
        });
        const initialRevision = state.revision;
        const prepared = yield* Effect.matchEffect(prepare, {
            onFailure: (failure) =>
                states.recheck({ revision: initialRevision }).pipe(
                    Effect.mapError(
                        stateFailure('The project dependency state changed while install was preparing its lock'),
                    ),
                    Effect.flatMap(() => Effect.fail(failure)),
                ),
            onSuccess: Effect.succeed,
        });
        return yield* committed.installCommitted({
            state: prepared.state,
            toolchain,
            ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
            offline: options.offline,
            frozenLockfile: options.frozenLockfile,
            lockStatus: prepared.lockStatus,
            lockCleanup: 'clean',
        });
    });
}

export interface InstallProjectServiceShape {
    readonly install: (options?: InstallProjectOptions) => Effect.Effect<InstallProjectReport, InstallProjectError>;
}

export const InstallProjectService = Context.Service<InstallProjectServiceShape>(
    '@erden/project/InstallProjectService',
);

export function makeInstallProjectService(
    states: InstallProjectStateShape,
    toolchains: CurrentToolchainShape,
    registry: DependencyRegistryShape,
    store: InstallProjectStoreShape,
    runtime: InstallProjectRuntime,
): InstallProjectServiceShape {
    return makeInstallProjectServiceWithResolver(
        states,
        toolchains,
        makeDependencyResolver(registry),
        registry,
        store,
        runtime,
    );
}

export function makeInstallProjectServiceWithResolver(
    states: InstallProjectStateShape,
    toolchains: CurrentToolchainShape,
    resolver: DependencyResolverShape,
    archives: DependencyArchiveReaderShape,
    store: InstallProjectStoreShape,
    runtime: InstallProjectRuntime,
): InstallProjectServiceShape {
    const committed = makeInstallCommittedStateService(states, archives, store, runtime);
    return Object.freeze({
        install: (options: InstallProjectOptions = {}) =>
            runInstallProject(options, states, toolchains, resolver, committed, runtime),
    });
}

export function makeInstallCommittedStateService(
    states: Pick<ProjectDependencyStateServiceShape, 'recheck'>,
    archives: DependencyArchiveReaderShape,
    store: InstallProjectStoreShape,
    runtime: InstallProjectRuntime,
): InstallCommittedStateServiceShape {
    return Object.freeze({
        installCommitted: (input: InstallCommittedStateInput) =>
            runInstallCommittedState(input, states, archives, store, runtime),
    });
}

export function makeNodeInstallCommittedStateService(
    archives: DependencyArchiveReaderShape,
): InstallCommittedStateServiceShape {
    return makeInstallCommittedStateService(
        nodeProjectDependencyStateService,
        archives,
        nodeLocalPackageStore,
        Object.freeze({
            defaultStoreRoot: () => resolveDefaultStoreRoot(nodeStoreEnvironment()),
            transactionResidue: nodeTransactionResidue,
        }),
    );
}

export function makeNodeInstallProjectService(registry: DependencyRegistryShape): InstallProjectServiceShape {
    return makeInstallProjectService(
        nodeProjectDependencyStateService,
        nodeCurrentToolchainService,
        registry,
        nodeLocalPackageStore,
        Object.freeze({
            defaultStoreRoot: () => resolveDefaultStoreRoot(nodeStoreEnvironment()),
            transactionResidue: nodeTransactionResidue,
        }),
    );
}

export function makeNodeInstallProjectServiceFromReleaseIndex(
    index: RegistryReleaseIndexReaderShape,
    archives: DependencyArchiveReaderShape,
): InstallProjectServiceShape {
    return makeInstallProjectServiceWithResolver(
        nodeProjectDependencyStateService,
        nodeCurrentToolchainService,
        makeDependencyResolverFromReleaseIndex(index),
        archives,
        nodeLocalPackageStore,
        Object.freeze({
            defaultStoreRoot: () => resolveDefaultStoreRoot(nodeStoreEnvironment()),
            transactionResidue: nodeTransactionResidue,
        }),
    );
}

export function installProject(
    options: InstallProjectOptions = {},
): Effect.Effect<InstallProjectReport, InstallProjectError, Context.Service.Identifier<typeof InstallProjectService>> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(InstallProjectService);
        return yield* service.install(options);
    });
}

export function defineInstallProjectOperation(
    options: InstallProjectOptions = {},
): ApplicationOperation<
    'InstallProject',
    InstallProjectReport,
    InstallProjectError,
    Context.Service.Identifier<typeof InstallProjectService>
> {
    return Object.freeze({ name: 'InstallProject', effect: installProject(options) });
}
