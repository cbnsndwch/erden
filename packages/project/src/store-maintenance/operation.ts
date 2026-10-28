import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

import { Context, Effect } from 'effect';

import {
    nodeCurrentToolchainService,
    serializeLockfileBytes,
    type CurrentToolchainShape,
    type LockToolchain,
    isCanonicalOntologyIri,
    isScopedAlias,
} from '@erden/contracts';

import type { ApplicationOperation } from '../index.js';
import {
    isProjectDependencyStateError,
    nodeProjectDependencyStateService,
    type ProjectDependencyStateServiceShape,
} from '../project-dependency-state/index.js';
import {
    nodeLocalPackageStore,
    nodeStoreEnvironment,
    resolveDefaultStoreRoot,
    type LocalPackageStoreShape,
    type StoreIndexInspection,
    type PruneStoreResult,
    type StoreObjectIndexEntry,
    type StoreProjectReferenceGeneration,
} from '../store/index.js';

import { isStoreMaintenanceError, StoreMaintenanceError } from './errors.js';
import {
    decodeStorePruneReport,
    decodeStoreStatusReport,
    STORE_PRUNE_REACQUISITION_WARNING,
    STORE_PRUNE_REPORT_VERSION,
    STORE_STATUS_REPORT_VERSION,
    type StorePruneReport,
    type StoreStatusReport,
} from './report.js';

export interface StoreMaintenanceRuntime {
    readonly defaultStoreRoot: () => string;
}

export type StoreMaintenanceIndexShape = Pick<LocalPackageStoreShape, 'inspectStoreIndex' | 'pruneStore'>;
export type StoreMaintenanceStateShape = Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck'>;

const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
function generationKey(item: Pick<StoreProjectReferenceGeneration, 'registrationId' | 'generationSha256'>): string {
    return `${item.registrationId}.${item.generationSha256}`;
}

function dataRecord(input: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new TypeError('record shape');
    }
    const names = Object.getOwnPropertyNames(input).sort(compare);
    const expected = [...keys].sort(compare);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        throw new TypeError('record keys');
    }
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('record descriptor');
        }
    }
    return input as Record<string, unknown>;
}

function dataArray(input: unknown, maximum: number): ReadonlyArray<unknown> {
    if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0 ||
        input.length > maximum
    ) {
        throw new TypeError('array shape');
    }
    const names = Object.getOwnPropertyNames(input);
    if (names.length !== input.length + 1 || !names.includes('length')) {
        throw new TypeError('array closure');
    }
    const values: unknown[] = [];
    for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('array descriptor');
        }
        values.push(descriptor.value);
    }
    return values;
}

function digestArray(input: unknown, maximum: number): ReadonlyArray<string> {
    const values = dataArray(input, maximum).map((value) => {
        if (typeof value !== 'string' || !SHA256.test(value)) {
            throw new TypeError('digest');
        }
        return value;
    });
    for (let index = 1; index < values.length; index += 1) {
        if (compare(values[index - 1] ?? '', values[index] ?? '') >= 0) {
            throw new TypeError('digest order');
        }
    }
    return Object.freeze(values);
}

function snapshotToolchain(input: unknown): LockToolchain {
    const record = dataRecord(input, ['validator', 'reasoner']);
    function requirement(value: unknown) {
        const item = dataRecord(value, ['version', 'sha256']);
        if (typeof item['version'] !== 'string' || typeof item['sha256'] !== 'string' || !SHA256.test(item['sha256'])) {
            throw new TypeError('tool requirement');
        }
        return Object.freeze({ version: item['version'], sha256: item['sha256'] });
    }
    return Object.freeze({ validator: requirement(record['validator']), reasoner: requirement(record['reasoner']) });
}

function safeAbsolutePath(input: unknown): string {
    if (
        typeof input !== 'string' ||
        input.length === 0 ||
        !input.isWellFormed() ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(input) ||
        (!posix.isAbsolute(input) && !win32.isAbsolute(input))
    ) {
        throw new TypeError('private path');
    }
    return input;
}

function snapshotReference(input: unknown): StoreProjectReferenceGeneration {
    const record = dataRecord(input, [
        'registrationId',
        'generationSha256',
        'previous',
        'projectRoot',
        'manifestPath',
        'project',
        'manifestSha256',
        'lockSha256',
        'manifestDependencySha256',
        'toolchain',
        'archiveSha256s',
        'rootStatus',
    ]);
    const registrationId = record['registrationId'];
    const generationSha256 = record['generationSha256'];
    const manifestSha256 = record['manifestSha256'];
    const lockSha256 = record['lockSha256'];
    const manifestDependencySha256 = record['manifestDependencySha256'];
    if (
        typeof registrationId !== 'string' ||
        !SHA256.test(registrationId) ||
        typeof generationSha256 !== 'string' ||
        !SHA256.test(generationSha256) ||
        typeof manifestSha256 !== 'string' ||
        !SHA256.test(manifestSha256) ||
        typeof lockSha256 !== 'string' ||
        !SHA256.test(lockSha256) ||
        typeof manifestDependencySha256 !== 'string' ||
        !SHA256.test(manifestDependencySha256)
    ) {
        throw new TypeError('reference digest');
    }
    const project = dataRecord(record['project'], ['canonicalIri', 'alias']);
    if (
        typeof project['canonicalIri'] !== 'string' ||
        !isCanonicalOntologyIri(project['canonicalIri']) ||
        typeof project['alias'] !== 'string' ||
        !isScopedAlias(project['alias'])
    ) {
        throw new TypeError('reference project');
    }
    const previous =
        record['previous'] === null
            ? null
            : (() => {
                  const item = dataRecord(record['previous'], ['registrationId', 'generationSha256']);
                  if (
                      typeof item['registrationId'] !== 'string' ||
                      !SHA256.test(item['registrationId']) ||
                      typeof item['generationSha256'] !== 'string' ||
                      !SHA256.test(item['generationSha256'])
                  ) {
                      throw new TypeError('reference predecessor');
                  }
                  return Object.freeze({
                      registrationId: item['registrationId'],
                      generationSha256: item['generationSha256'],
                  });
              })();
    const rootStatus = record['rootStatus'];
    if (rootStatus !== 'present' && rootStatus !== 'missing' && rootStatus !== 'unavailable') {
        throw new TypeError('reference root status');
    }
    return Object.freeze({
        registrationId,
        generationSha256,
        previous,
        projectRoot: safeAbsolutePath(record['projectRoot']),
        manifestPath: safeAbsolutePath(record['manifestPath']),
        project: Object.freeze({ canonicalIri: project['canonicalIri'], alias: project['alias'] }),
        manifestSha256,
        lockSha256,
        manifestDependencySha256,
        toolchain: snapshotToolchain(record['toolchain']),
        archiveSha256s: digestArray(record['archiveSha256s'], 4096),
        rootStatus,
    });
}

function snapshotObject(input: unknown): StoreObjectIndexEntry {
    const record = dataRecord(input, ['archiveSha256', 'status', 'archiveByteSize', 'logicalByteSize']);
    const archiveSha256 = record['archiveSha256'];
    const status = record['status'];
    if (
        typeof archiveSha256 !== 'string' ||
        !SHA256.test(archiveSha256) ||
        (status !== 'available' && status !== 'busy' && status !== 'corrupt')
    ) {
        throw new TypeError('object entry');
    }
    const archiveByteSize = record['archiveByteSize'];
    const logicalByteSize = record['logicalByteSize'];
    if (status === 'available') {
        if (
            typeof archiveByteSize !== 'number' ||
            !Number.isSafeInteger(archiveByteSize) ||
            Object.is(archiveByteSize, -0) ||
            archiveByteSize < 0 ||
            typeof logicalByteSize !== 'string' ||
            !DECIMAL.test(logicalByteSize)
        ) {
            throw new TypeError('object sizes');
        }
        return Object.freeze({ archiveSha256, status, archiveByteSize, logicalByteSize });
    }
    if (archiveByteSize !== null || logicalByteSize !== null) {
        throw new TypeError('object unavailable sizes');
    }
    return Object.freeze({ archiveSha256, status, archiveByteSize: null, logicalByteSize: null });
}

export function decodeStoreIndexInspection(input: unknown): StoreIndexInspection {
    try {
        const record = dataRecord(input, [
            'store',
            'transaction',
            'registrations',
            'corruptRegistrationIds',
            'busyRegistrationIds',
            'objects',
        ]);
        const store = record['store'];
        const transaction = record['transaction'];
        if ((store !== 'missing' && store !== 'available') || (transaction !== 'idle' && transaction !== 'busy')) {
            throw new TypeError('index state');
        }
        const registrations = dataArray(record['registrations'], 16384)
            .map(snapshotReference)
            .sort((left, right) => compare(generationKey(left), generationKey(right)));
        const objects = dataArray(record['objects'], 100000)
            .map(snapshotObject)
            .sort((left, right) => compare(left.archiveSha256, right.archiveSha256));
        if (
            new Set(registrations.map(generationKey)).size !== registrations.length ||
            new Set(objects.map(({ archiveSha256 }) => archiveSha256)).size !== objects.length
        ) {
            throw new TypeError('index duplicates');
        }
        const corruptRegistrationIds = digestArray(record['corruptRegistrationIds'], 16384);
        const busyRegistrationIds = digestArray(record['busyRegistrationIds'], 16384);
        if (
            store === 'missing' &&
            (transaction !== 'idle' ||
                registrations.length !== 0 ||
                objects.length !== 0 ||
                corruptRegistrationIds.length !== 0 ||
                busyRegistrationIds.length !== 0)
        ) {
            throw new TypeError('missing store truth');
        }
        return Object.freeze({
            store,
            transaction,
            registrations: Object.freeze(registrations),
            corruptRegistrationIds,
            busyRegistrationIds,
            objects: Object.freeze(objects),
        });
    } catch (cause) {
        throw new StoreMaintenanceError(
            'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
            'The local store index returned invalid authenticated truth',
            cause,
        );
    }
}

function sameToolchain(left: LockToolchain, right: LockToolchain): boolean {
    return (
        left.validator.version === right.validator.version &&
        left.validator.sha256 === right.validator.sha256 &&
        left.reasoner.version === right.reasoner.version &&
        left.reasoner.sha256 === right.reasoner.sha256
    );
}

function currentStateMatches(
    reference: StoreProjectReferenceGeneration,
    state: Awaited<
        ReturnType<ProjectDependencyStateServiceShape['inspect']> extends Effect.Effect<infer Value, unknown>
            ? Value
            : never
    >,
): boolean {
    if (state.lockInspection.status !== 'available') {
        return false;
    }
    const lock = state.lockInspection.lock;
    const archiveSha256s = [...new Set(lock.packages.map(({ archiveSha256 }) => archiveSha256))].sort(compare);
    return (
        state.project.projectRoot === reference.projectRoot &&
        state.project.filePath === reference.manifestPath &&
        state.project.manifest.canonicalIri === reference.project.canonicalIri &&
        state.project.manifest.alias === reference.project.alias &&
        createHash('sha256').update(state.manifestBytes).digest('hex') === reference.manifestSha256 &&
        createHash('sha256').update(serializeLockfileBytes(lock)).digest('hex') === reference.lockSha256 &&
        lock.manifestDependencySha256 === reference.manifestDependencySha256 &&
        sameToolchain(lock.toolchain, reference.toolchain) &&
        archiveSha256s.length === reference.archiveSha256s.length &&
        archiveSha256s.every((digest, index) => digest === reference.archiveSha256s[index])
    );
}

function runStoreStatus(
    states: StoreMaintenanceStateShape,
    toolchains: CurrentToolchainShape,
    store: StoreMaintenanceIndexShape,
    runtime: StoreMaintenanceRuntime,
): Effect.Effect<StoreStatusReport, StoreMaintenanceError> {
    return Effect.gen(function* () {
        const storeRoot = yield* Effect.try({
            try: runtime.defaultStoreRoot,
            catch: (cause) =>
                new StoreMaintenanceError(
                    'STORE_MAINTENANCE_ENVIRONMENT_UNAVAILABLE',
                    'The default local package store is unavailable',
                    cause,
                ),
        });
        const rawIndex = yield* store
            .inspectStoreIndex({ storeRoot })
            .pipe(
                Effect.mapError(
                    (cause) =>
                        new StoreMaintenanceError(
                            'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                            'The local package store could not be authenticated',
                            cause,
                        ),
                ),
            );
        const index = yield* Effect.try({
            try: () => decodeStoreIndexInspection(rawIndex),
            catch: (cause) => cause as StoreMaintenanceError,
        });
        const busyRegistrationIds = index.busyRegistrationIds;
        const busyRegistrationIdSet = new Set(busyRegistrationIds);
        const corruptRegistrationIds = index.corruptRegistrationIds.filter(
            (registrationId) => !busyRegistrationIdSet.has(registrationId),
        );
        const issueRegistrationIds = new Set([...busyRegistrationIds, ...corruptRegistrationIds]);
        const registrations = index.registrations.filter(
            ({ registrationId }) => !issueRegistrationIds.has(registrationId),
        );
        const toolchain =
            registrations.length === 0
                ? undefined
                : yield* toolchains
                      .inspect()
                      .pipe(
                          Effect.mapError(
                              (cause) =>
                                  new StoreMaintenanceError(
                                      'STORE_MAINTENANCE_PROJECT_UNAVAILABLE',
                                      'The current dependency toolchain is unavailable',
                                      cause,
                                  ),
                          ),
                      );
        const byRoot = new Map<string, StoreProjectReferenceGeneration[]>();
        for (const reference of registrations) {
            const values = byRoot.get(reference.projectRoot) ?? [];
            values.push(reference);
            byRoot.set(reference.projectRoot, values);
        }
        const current: StoreStatusReport['registrations']['current'][number][] = [];
        const superseded: StoreStatusReport['registrations']['superseded'][number][] = [];
        const orphaned: StoreStatusReport['registrations']['orphaned'][number][] = [];
        const stale: StoreStatusReport['registrations']['stale'][number][] = [];
        const referencedDigests = new Set<string>();
        const allByKey = new Map(index.registrations.map((reference) => [generationKey(reference), reference]));
        for (const values of byRoot.values()) {
            const keys = new Set(values.map(generationKey));
            const byKey = new Map(values.map((reference) => [generationKey(reference), reference]));
            const predecessorKeys = new Set<string>();
            for (const value of values) {
                if (value.previous !== null) {
                    const key = `${value.previous.registrationId}.${value.previous.generationSha256}`;
                    if (key === generationKey(value)) {
                        return yield* Effect.fail(
                            new StoreMaintenanceError(
                                'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                                'A store registration history contains a self-link',
                            ),
                        );
                    }
                    const previous = allByKey.get(key);
                    if (previous !== undefined && previous.projectRoot !== value.projectRoot) {
                        return yield* Effect.fail(
                            new StoreMaintenanceError(
                                'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                                'A store registration predecessor belongs to a different project root',
                            ),
                        );
                    }
                    if (keys.has(key)) {
                        predecessorKeys.add(key);
                    }
                }
            }
            for (const start of values) {
                const visited = new Set<string>();
                let value: StoreProjectReferenceGeneration | undefined = start;
                while (value !== undefined && value.previous !== null) {
                    const key = generationKey(value);
                    if (visited.has(key)) {
                        return yield* Effect.fail(
                            new StoreMaintenanceError(
                                'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                                'A store registration history contains a cycle',
                            ),
                        );
                    }
                    visited.add(key);
                    value = byKey.get(`${value.previous.registrationId}.${value.previous.generationSha256}`);
                }
            }
            const heads = values.filter((value) => !predecessorKeys.has(generationKey(value)));
            if (heads.length !== 1) {
                return yield* Effect.fail(
                    new StoreMaintenanceError(
                        'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                        'A store registration history is ambiguous',
                    ),
                );
            }
            const head = heads[0] as StoreProjectReferenceGeneration;
            if (head.rootStatus === 'missing') {
                for (const value of values) {
                    orphaned.push({
                        registrationId: value.registrationId,
                        generationSha256: value.generationSha256,
                        project: value.project,
                    });
                }
                continue;
            }
            for (const value of values.filter((candidate) => candidate !== head)) {
                superseded.push({
                    registrationId: value.registrationId,
                    generationSha256: value.generationSha256,
                    project: value.project,
                });
            }
            for (const digest of head.archiveSha256s) {
                referencedDigests.add(digest);
            }
            if (head.rootStatus === 'unavailable') {
                stale.push({
                    registrationId: head.registrationId,
                    generationSha256: head.generationSha256,
                    project: head.project,
                    issue: 'unavailable',
                });
                continue;
            }
            if (toolchain === undefined) {
                return yield* Effect.fail(
                    new StoreMaintenanceError(
                        'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                        'A registered project has no authenticated current toolchain',
                    ),
                );
            }
            const inspected = yield* Effect.matchEffect(
                states.inspect({ explicitPath: head.manifestPath, toolchain }),
                {
                    onFailure: (left) => Effect.succeed({ _tag: 'Left' as const, left }),
                    onSuccess: (right) => Effect.succeed({ _tag: 'Right' as const, right }),
                },
            );
            if (inspected._tag === 'Left') {
                if (
                    !isProjectDependencyStateError(inspected.left) ||
                    inspected.left.code === 'PROJECT_DEPENDENCY_STATE_IO_FAILURE' ||
                    inspected.left.code === 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE'
                ) {
                    return yield* Effect.fail(
                        new StoreMaintenanceError(
                            'STORE_MAINTENANCE_PROJECT_UNAVAILABLE',
                            'A registered project could not be inspected safely',
                            inspected.left,
                        ),
                    );
                }
                stale.push({
                    registrationId: head.registrationId,
                    generationSha256: head.generationSha256,
                    project: head.project,
                    issue:
                        inspected.left.code === 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT'
                            ? 'transaction-present'
                            : 'unavailable',
                });
                continue;
            }
            if (!currentStateMatches(head, inspected.right)) {
                stale.push({
                    registrationId: head.registrationId,
                    generationSha256: head.generationSha256,
                    project: head.project,
                    issue: 'state-mismatch',
                });
                continue;
            }
            yield* states
                .recheck({ revision: inspected.right.revision })
                .pipe(
                    Effect.mapError(
                        (cause) =>
                            new StoreMaintenanceError(
                                'STORE_MAINTENANCE_PROJECT_UNAVAILABLE',
                                'A registered project changed during status inspection',
                                cause,
                            ),
                    ),
                );
            current.push({
                registrationId: head.registrationId,
                generationSha256: head.generationSha256,
                project: head.project,
                lockSha256: head.lockSha256,
                packages: head.archiveSha256s.length,
            });
        }
        const available = new Set(
            index.objects.filter(({ status }) => status === 'available').map(({ archiveSha256 }) => archiveSha256),
        );
        const busy = index.objects
            .filter(({ status }) => status === 'busy')
            .map(({ archiveSha256 }) => archiveSha256)
            .sort(compare);
        const corrupt = index.objects
            .filter(({ status }) => status === 'corrupt')
            .map(({ archiveSha256 }) => archiveSha256)
            .sort(compare);
        const existing = new Set(index.objects.map(({ archiveSha256 }) => archiveSha256));
        const referenced = [...referencedDigests].filter((digest) => available.has(digest)).sort(compare);
        const unreferenced = [...available].filter((digest) => !referencedDigests.has(digest)).sort(compare);
        const missingReferenced = [...referencedDigests].filter((digest) => !existing.has(digest)).sort(compare);
        const logicalBytes = index.objects
            .filter(({ status }) => status === 'available')
            .reduce((total, object) => total + BigInt(object.logicalByteSize ?? '0'), 0n)
            .toString(10);
        const unreferencedLogicalBytes = index.objects
            .filter(({ status, archiveSha256 }) => status === 'available' && !referencedDigests.has(archiveSha256))
            .reduce((total, object) => total + BigInt(object.logicalByteSize ?? '0'), 0n)
            .toString(10);
        current.sort((left, right) =>
            compare(
                `${left.registrationId}.${left.generationSha256}`,
                `${right.registrationId}.${right.generationSha256}`,
            ),
        );
        superseded.sort((left, right) =>
            compare(
                `${left.registrationId}.${left.generationSha256}`,
                `${right.registrationId}.${right.generationSha256}`,
            ),
        );
        orphaned.sort((left, right) =>
            compare(
                `${left.registrationId}.${left.generationSha256}`,
                `${right.registrationId}.${right.generationSha256}`,
            ),
        );
        stale.sort((left, right) =>
            compare(
                `${left.registrationId}.${left.generationSha256}`,
                `${right.registrationId}.${right.generationSha256}`,
            ),
        );
        const hasIssues =
            index.transaction === 'busy' ||
            stale.length > 0 ||
            corruptRegistrationIds.length > 0 ||
            busyRegistrationIds.length > 0 ||
            missingReferenced.length > 0 ||
            busy.length > 0 ||
            corrupt.length > 0;
        return yield* Effect.try({
            try: () =>
                decodeStoreStatusReport({
                    schema: STORE_STATUS_REPORT_VERSION,
                    store: index.store,
                    transaction: index.transaction,
                    registrations: {
                        total: registrations.length,
                        current,
                        superseded,
                        orphaned,
                        stale,
                        corrupt: corruptRegistrationIds,
                        busy: busyRegistrationIds,
                    },
                    objects: {
                        total: index.objects.length,
                        referenced,
                        unreferenced,
                        missingReferenced,
                        busy,
                        corrupt,
                        logicalBytes,
                        unreferencedLogicalBytes,
                    },
                    outcome: hasIssues ? 'issues' : 'healthy',
                }),
            catch: (cause) =>
                new StoreMaintenanceError(
                    'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                    'The deterministic store status report could not be constructed',
                    cause,
                ),
        });
    });
}

export interface StoreMaintenanceServiceShape {
    readonly status: () => Effect.Effect<StoreStatusReport, StoreMaintenanceError>;
    readonly prune: (options: StorePruneOptions) => Effect.Effect<StorePruneReport, StoreMaintenanceError>;
}

export interface StorePruneOptions {
    readonly dryRun?: boolean;
}

function snapshotPruneOptions(input: StorePruneOptions): Readonly<{
    readonly dryRun: boolean;
}> {
    try {
        const unknownInput: unknown = input;
        if (
            unknownInput === null ||
            typeof unknownInput !== 'object' ||
            Array.isArray(unknownInput) ||
            Object.getPrototypeOf(unknownInput) !== Object.prototype ||
            Object.getOwnPropertySymbols(unknownInput).length !== 0
        ) {
            throw new TypeError('prune options shape');
        }
        const names = Object.getOwnPropertyNames(unknownInput);
        if (names.some((name) => name !== 'dryRun') || names.length > 1) {
            throw new TypeError('prune options field');
        }
        const descriptor = Object.getOwnPropertyDescriptor(unknownInput, 'dryRun');
        if (descriptor !== undefined && (!('value' in descriptor) || !descriptor.enumerable)) {
            throw new TypeError('prune options descriptor');
        }
        const dryRun: unknown =
            descriptor === undefined
                ? false
                : (
                      descriptor as unknown as {
                          readonly value: unknown;
                      }
                  ).value;
        if (typeof dryRun !== 'boolean') {
            throw new TypeError('prune options');
        }
        return Object.freeze({ dryRun });
    } catch (cause) {
        throw new StoreMaintenanceError(
            'STORE_MAINTENANCE_INVALID_INPUT',
            'The store prune options are invalid',
            cause,
        );
    }
}

function pruneReportFromStatus(status: StoreStatusReport, dryRun: boolean): StorePruneReport {
    if (
        status.transaction === 'busy' ||
        status.registrations.stale.length > 0 ||
        status.registrations.corrupt.length > 0 ||
        status.registrations.busy.length > 0 ||
        status.objects.busy.length > 0 ||
        status.objects.corrupt.length > 0
    ) {
        throw new StoreMaintenanceError(
            'STORE_MAINTENANCE_PRUNE_BLOCKED',
            'The local store contains ambiguous, busy, corrupt, or stale truth and cannot be pruned',
        );
    }
    const retired = [...status.registrations.superseded, ...status.registrations.orphaned].sort((left, right) =>
        compare(`${left.registrationId}.${left.generationSha256}`, `${right.registrationId}.${right.generationSha256}`),
    );
    const empty = retired.length === 0 && status.objects.unreferenced.length === 0;
    return decodeStorePruneReport({
        schema: STORE_PRUNE_REPORT_VERSION,
        warning: STORE_PRUNE_REACQUISITION_WARNING,
        dryRun,
        registrations: { total: retired.length, retired },
        objects: {
            total: status.objects.unreferenced.length,
            removed: status.objects.unreferenced,
            logicalBytes: status.objects.unreferencedLogicalBytes,
        },
        outcome: empty ? 'nothing-to-prune' : dryRun ? 'planned' : 'pruned',
    });
}

function snapshotPruneResult(input: unknown): PruneStoreResult {
    const value = dataRecord(input, [
        'status',
        'registrations',
        'objects',
        'logicalBytes',
        'registrationGenerations',
        'archiveSha256s',
        'cleanup',
    ]);
    if (
        (value['status'] !== 'pruned' && value['status'] !== 'hit') ||
        value['cleanup'] !== 'clean' ||
        !Number.isSafeInteger(value['registrations']) ||
        Object.is(value['registrations'], -0) ||
        Number(value['registrations']) < 0 ||
        !Number.isSafeInteger(value['objects']) ||
        Object.is(value['objects'], -0) ||
        Number(value['objects']) < 0 ||
        typeof value['logicalBytes'] !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/u.test(value['logicalBytes'])
    ) {
        throw new TypeError('prune result header');
    }
    const registrationGenerations = dataArray(value['registrationGenerations'], 16384)
        .map((item) => {
            const record = dataRecord(item, ['registrationId', 'generationSha256', 'project']);
            const project = dataRecord(record['project'], ['canonicalIri', 'alias']);
            if (
                typeof record['registrationId'] !== 'string' ||
                !SHA256.test(record['registrationId']) ||
                typeof record['generationSha256'] !== 'string' ||
                !SHA256.test(record['generationSha256']) ||
                typeof project['canonicalIri'] !== 'string' ||
                !isCanonicalOntologyIri(project['canonicalIri']) ||
                typeof project['alias'] !== 'string' ||
                !isScopedAlias(project['alias'])
            ) {
                throw new TypeError('prune result registration');
            }
            return Object.freeze({
                registrationId: record['registrationId'],
                generationSha256: record['generationSha256'],
                project: Object.freeze({ canonicalIri: project['canonicalIri'], alias: project['alias'] }),
            });
        })
        .sort((left, right) =>
            compare(
                `${left.registrationId}.${left.generationSha256}`,
                `${right.registrationId}.${right.generationSha256}`,
            ),
        );
    const archiveSha256s = digestArray(value['archiveSha256s'], 100000);
    if (
        registrationGenerations.length !== value['registrations'] ||
        archiveSha256s.length !== value['objects'] ||
        (value['status'] === 'hit' &&
            (registrationGenerations.length !== 0 || archiveSha256s.length !== 0 || value['logicalBytes'] !== '0'))
    ) {
        throw new TypeError('prune result truth');
    }
    return Object.freeze({
        status: value['status'],
        registrations: value['registrations'],
        objects: value['objects'],
        logicalBytes: value['logicalBytes'],
        registrationGenerations: Object.freeze(registrationGenerations),
        archiveSha256s,
        cleanup: 'clean',
    });
}

function reportFromPruneResult(result: PruneStoreResult): StorePruneReport {
    return decodeStorePruneReport({
        schema: STORE_PRUNE_REPORT_VERSION,
        warning: STORE_PRUNE_REACQUISITION_WARNING,
        dryRun: false,
        registrations: { total: result.registrations, retired: result.registrationGenerations },
        objects: { total: result.objects, removed: result.archiveSha256s, logicalBytes: result.logicalBytes },
        outcome: result.registrations === 0 && result.objects === 0 ? 'nothing-to-prune' : 'pruned',
    });
}

export const StoreMaintenanceService = Context.Service<StoreMaintenanceServiceShape>(
    '@erden/project/StoreMaintenanceService',
);

export function makeStoreMaintenanceService(
    states: StoreMaintenanceStateShape,
    toolchains: CurrentToolchainShape,
    store: StoreMaintenanceIndexShape,
    runtime: StoreMaintenanceRuntime,
): StoreMaintenanceServiceShape {
    return Object.freeze({
        status: () => runStoreStatus(states, toolchains, store, runtime),
        prune: (input: StorePruneOptions) =>
            Effect.gen(function* () {
                const options = yield* Effect.try({
                    try: () => snapshotPruneOptions(input),
                    catch: (cause) =>
                        isStoreMaintenanceError(cause)
                            ? cause
                            : new StoreMaintenanceError(
                                  'STORE_MAINTENANCE_INVALID_INPUT',
                                  'The store prune options are invalid',
                                  cause,
                              ),
                });
                const storeRoot = yield* Effect.try({
                    try: runtime.defaultStoreRoot,
                    catch: (cause) =>
                        new StoreMaintenanceError(
                            'STORE_MAINTENANCE_ENVIRONMENT_UNAVAILABLE',
                            'The default local package store is unavailable',
                            cause,
                        ),
                });
                const status = yield* runStoreStatus(
                    states,
                    toolchains,
                    store,
                    Object.freeze({ defaultStoreRoot: () => storeRoot }),
                );
                if (!options.dryRun && status.transaction === 'busy') {
                    const recoveredInput = yield* store
                        .pruneStore({ storeRoot, registrationGenerations: [], archiveSha256s: [] })
                        .pipe(
                            Effect.mapError(
                                (cause) =>
                                    new StoreMaintenanceError(
                                        'STORE_MAINTENANCE_PRUNE_BLOCKED',
                                        'The interrupted store administration transaction could not be recovered safely',
                                        cause,
                                    ),
                            ),
                        );
                    const recovered = yield* Effect.try({
                        try: () => snapshotPruneResult(recoveredInput),
                        catch: (cause) =>
                            new StoreMaintenanceError(
                                'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                                'The local store returned invalid recovery truth',
                                cause,
                            ),
                    });
                    const after = yield* runStoreStatus(
                        states,
                        toolchains,
                        store,
                        Object.freeze({ defaultStoreRoot: () => storeRoot }),
                    );
                    if (after.transaction !== 'idle') {
                        return yield* Effect.fail(
                            new StoreMaintenanceError(
                                'STORE_MAINTENANCE_PRUNE_BLOCKED',
                                'The recovered store administration transaction remains active',
                            ),
                        );
                    }
                    return yield* Effect.try({
                        try: () => reportFromPruneResult(recovered),
                        catch: (cause) =>
                            new StoreMaintenanceError(
                                'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                                'The recovered prune report could not be constructed',
                                cause,
                            ),
                    });
                }
                const planned = yield* Effect.try({
                    try: () => pruneReportFromStatus(status, options.dryRun),
                    catch: (cause) =>
                        isStoreMaintenanceError(cause)
                            ? cause
                            : new StoreMaintenanceError(
                                  'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                                  'The deterministic prune report could not be constructed',
                                  cause,
                              ),
                });
                if (options.dryRun || planned.outcome === 'nothing-to-prune') {
                    return planned;
                }
                const rawResult = yield* store
                    .pruneStore({
                        storeRoot,
                        registrationGenerations: planned.registrations.retired.map(
                            ({ registrationId, generationSha256 }) => ({ registrationId, generationSha256 }),
                        ),
                        archiveSha256s: planned.objects.removed,
                    })
                    .pipe(
                        Effect.mapError(
                            (cause) =>
                                new StoreMaintenanceError(
                                    'STORE_MAINTENANCE_PRUNE_BLOCKED',
                                    'The authenticated store prune could not complete safely',
                                    cause,
                                ),
                        ),
                    );
                const result = yield* Effect.try({
                    try: () => snapshotPruneResult(rawResult),
                    catch: (cause) =>
                        new StoreMaintenanceError(
                            'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                            'The local store returned invalid prune truth',
                            cause,
                        ),
                });
                if (
                    result.status !== 'pruned' ||
                    result.registrations !== planned.registrations.total ||
                    result.objects !== planned.objects.total ||
                    result.logicalBytes !== planned.objects.logicalBytes ||
                    result.registrationGenerations.some((item, index) => {
                        const expected = planned.registrations.retired[index];
                        return (
                            expected === undefined ||
                            item.registrationId !== expected.registrationId ||
                            item.generationSha256 !== expected.generationSha256 ||
                            item.project.canonicalIri !== expected.project.canonicalIri ||
                            item.project.alias !== expected.project.alias
                        );
                    }) ||
                    result.archiveSha256s.some((digest, index) => digest !== planned.objects.removed[index])
                ) {
                    return yield* Effect.fail(
                        new StoreMaintenanceError(
                            'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                            'The local store returned inconsistent prune truth',
                        ),
                    );
                }
                return yield* Effect.try({
                    try: () => decodeStorePruneReport({ ...planned, dryRun: false, outcome: 'pruned' }),
                    catch: (cause) =>
                        new StoreMaintenanceError(
                            'STORE_MAINTENANCE_INDEX_UNAVAILABLE',
                            'The deterministic prune result could not be constructed',
                            cause,
                        ),
                });
            }),
    });
}

export const nodeStoreMaintenanceService = makeStoreMaintenanceService(
    nodeProjectDependencyStateService,
    nodeCurrentToolchainService,
    nodeLocalPackageStore,
    Object.freeze({ defaultStoreRoot: () => resolveDefaultStoreRoot(nodeStoreEnvironment()) }),
);

export function storeStatus(): Effect.Effect<
    StoreStatusReport,
    StoreMaintenanceError,
    Context.Service.Identifier<typeof StoreMaintenanceService>
> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(StoreMaintenanceService)).status();
    });
}

export function pruneStore(
    options: StorePruneOptions = {},
): Effect.Effect<StorePruneReport, StoreMaintenanceError, Context.Service.Identifier<typeof StoreMaintenanceService>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(StoreMaintenanceService)).prune(options);
    });
}

export function defineStoreStatusOperation(): ApplicationOperation<
    'StoreStatus',
    StoreStatusReport,
    StoreMaintenanceError,
    Context.Service.Identifier<typeof StoreMaintenanceService>
> {
    return Object.freeze({ name: 'StoreStatus', effect: storeStatus() });
}

export function defineStorePruneOperation(
    options: StorePruneOptions = {},
): ApplicationOperation<
    'StorePrune',
    StorePruneReport,
    StoreMaintenanceError,
    Context.Service.Identifier<typeof StoreMaintenanceService>
> {
    return Object.freeze({ name: 'StorePrune', effect: pruneStore(options) });
}
