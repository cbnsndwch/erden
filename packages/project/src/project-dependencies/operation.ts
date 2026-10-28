import { createHash } from 'node:crypto';

import { Context, Effect } from 'effect';
import { validRange } from 'semver';

import {
    decodeLockfileValue,
    manifestDependencyProjectionSha256,
    nodeCurrentToolchainService,
    serializeLockfileBytes,
    type CurrentToolchainShape,
    type LockfileV1,
    type LockToolchain,
    compareCodePoints,
    isCanonicalOntologyIri,
    isScopedAlias,
    normalizeManifestV1,
    type ManifestV1,
} from '@erden/contracts';
import type { RegistryReleaseIndexReaderShape } from '@erden/contracts';

import {
    isDependencyRegistryUnavailableError,
    isDependencyResolutionError,
    makeDependencyResolver,
    makeDependencyResolverFromReleaseIndex,
    unavailableDependencyRegistry,
    type DependencyArchiveReaderShape,
    type DependencyRegistryShape,
    type DependencyResolverShape,
} from '../dependencies/index.js';
import type { ApplicationOperation } from '../index.js';
import {
    makeNodeInstallCommittedStateService,
    type InstallCommittedStateServiceShape,
    type InstallProjectReport,
} from '../install/index.js';
import {
    nodeProjectDependencyStateService,
    type ProjectDependencyStateInspection,
    type ProjectDependencyStateServiceShape,
    type ProjectDependencyStateWriteResult,
} from '../project-dependency-state/index.js';

import {
    ProjectDependenciesCommittedError,
    ProjectDependenciesError,
    ProjectDependenciesFrozenConflictError,
    isProjectDependenciesError,
} from './errors.js';
import {
    decodeProjectDependenciesReport,
    PROJECT_DEPENDENCIES_REPORT_VERSION,
    type ProjectDependenciesReport,
} from './report.js';
import {
    decodeProjectDependencyUpdateReport,
    PROJECT_DEPENDENCY_UPDATE_REPORT_VERSION,
    type ProjectDependencyUpdateReport,
} from './update-report.js';

export interface AddProjectDependencyOptions {
    readonly identifier: string;
    readonly range: string;
    readonly from?: string;
    readonly manifestPath?: string;
    readonly storeRoot?: string;
}

export interface RemoveProjectDependencyOptions {
    readonly identifier: string;
    readonly from?: string;
    readonly manifestPath?: string;
    readonly storeRoot?: string;
}

export interface UpdateProjectDependenciesOptions {
    readonly identifier?: string;
    readonly from?: string;
    readonly manifestPath?: string;
    readonly storeRoot?: string;
}

export function parseAddDependencySpec(input: string): Readonly<{
    readonly identifier: string;
    readonly range: string;
}> {
    if (typeof input !== 'string' || input.length === 0 || !input.isWellFormed()) {
        throw new TypeError('Dependency add requires <identifier>@<range>');
    }
    for (let index = input.lastIndexOf('@'); index > 0; index = input.lastIndexOf('@', index - 1)) {
        const identifier = input.slice(0, index);
        const range = input.slice(index + 1);
        if (
            (isScopedAlias(identifier) || isCanonicalOntologyIri(identifier)) &&
            range.length > 0 &&
            range.trim() === range &&
            validRange(range, { loose: false }) !== null
        ) {
            return Object.freeze({ identifier, range });
        }
    }
    throw new TypeError('Dependency add requires <identifier>@<range>');
}

export type ProjectDependenciesStateShape = Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck' | 'write'>;

function sha(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}
function lockSha(lock: LockfileV1): string {
    return sha(serializeLockfileBytes(lock));
}

function mapFailure(code: ProjectDependenciesError['code'], message: string) {
    return (cause: unknown): ProjectDependenciesError =>
        isProjectDependenciesError(cause) ? cause : new ProjectDependenciesError(code, message, cause);
}

function exactOptions(
    input: unknown,
    operation: 'add' | 'remove',
): Readonly<{
    identifier: string;
    range?: string;
    from?: string;
    manifestPath?: string;
    storeRoot?: string;
}> {
    try {
        if (
            input === null ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.getPrototypeOf(input) !== Object.prototype ||
            Object.getOwnPropertySymbols(input).length !== 0
        ) {
            throw new Error('shape');
        }
        const expected = new Set(
            operation === 'add'
                ? ['identifier', 'range', 'from', 'manifestPath', 'storeRoot']
                : ['identifier', 'from', 'manifestPath', 'storeRoot'],
        );
        const values = new Map<string, unknown>();
        for (const name of Object.getOwnPropertyNames(input)) {
            if (!expected.has(name)) {
                throw new Error('field');
            }
            const descriptor = Object.getOwnPropertyDescriptor(input, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('descriptor');
            }
            values.set(name, descriptor.value);
        }
        const identifier = values.get('identifier');
        const range = values.get('range');
        const from = values.get('from');
        const manifestPath = values.get('manifestPath');
        const storeRoot = values.get('storeRoot');
        if (
            typeof identifier !== 'string' ||
            (!isScopedAlias(identifier) && !isCanonicalOntologyIri(identifier)) ||
            (operation === 'add' &&
                (typeof range !== 'string' ||
                    range.trim() !== range ||
                    validRange(range, { loose: false }) === null)) ||
            (from !== undefined && (typeof from !== 'string' || from.length === 0 || from.includes('\0'))) ||
            (manifestPath !== undefined &&
                (typeof manifestPath !== 'string' || manifestPath.length === 0 || manifestPath.includes('\0'))) ||
            (storeRoot !== undefined &&
                (typeof storeRoot !== 'string' || storeRoot.length === 0 || storeRoot.includes('\0'))) ||
            (from !== undefined && manifestPath !== undefined)
        ) {
            throw new Error('value');
        }
        return Object.freeze({
            identifier,
            ...(range === undefined ? {} : { range: range as string }),
            ...(from === undefined ? {} : { from }),
            ...(manifestPath === undefined ? {} : { manifestPath }),
            ...(storeRoot === undefined ? {} : { storeRoot }),
        });
    } catch (cause) {
        throw new ProjectDependenciesError(
            'PROJECT_DEPENDENCIES_INVALID_INPUT',
            `The dependency ${operation} options are invalid`,
            cause,
        );
    }
}

function exactUpdateOptions(input: unknown): Readonly<{
    identifier?: string;
    from?: string;
    manifestPath?: string;
    storeRoot?: string;
}> {
    try {
        if (
            input === null ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.getPrototypeOf(input) !== Object.prototype ||
            Object.getOwnPropertySymbols(input).length !== 0
        ) {
            throw new Error('shape');
        }
        const expected = new Set(['identifier', 'from', 'manifestPath', 'storeRoot']);
        const values = new Map<string, unknown>();
        for (const name of Object.getOwnPropertyNames(input)) {
            if (!expected.has(name)) {
                throw new Error('field');
            }
            const descriptor = Object.getOwnPropertyDescriptor(input, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('descriptor');
            }
            values.set(name, descriptor.value);
        }
        const identifier = values.get('identifier');
        const from = values.get('from');
        const manifestPath = values.get('manifestPath');
        const storeRoot = values.get('storeRoot');
        if (
            (identifier !== undefined &&
                (typeof identifier !== 'string' ||
                    (!isScopedAlias(identifier) && !isCanonicalOntologyIri(identifier)))) ||
            (from !== undefined && (typeof from !== 'string' || from.length === 0 || from.includes('\0'))) ||
            (manifestPath !== undefined &&
                (typeof manifestPath !== 'string' || manifestPath.length === 0 || manifestPath.includes('\0'))) ||
            (storeRoot !== undefined &&
                (typeof storeRoot !== 'string' || storeRoot.length === 0 || storeRoot.includes('\0'))) ||
            (from !== undefined && manifestPath !== undefined)
        ) {
            throw new Error('value');
        }
        return Object.freeze({
            ...(identifier === undefined ? {} : { identifier }),
            ...(from === undefined ? {} : { from }),
            ...(manifestPath === undefined ? {} : { manifestPath }),
            ...(storeRoot === undefined ? {} : { storeRoot }),
        });
    } catch (cause) {
        throw new ProjectDependenciesError(
            'PROJECT_DEPENDENCIES_INVALID_INPUT',
            'The dependency update options are invalid',
            cause,
        );
    }
}

function inspectState(
    options: Readonly<{
        readonly from?: string;
        readonly manifestPath?: string;
    }>,
    toolchain: LockToolchain,
    states: ProjectDependenciesStateShape,
): Effect.Effect<ProjectDependencyStateInspection, ProjectDependenciesError> {
    return states
        .inspect({
            ...(options.from === undefined ? {} : { from: options.from }),
            ...(options.manifestPath === undefined ? {} : { explicitPath: options.manifestPath }),
            toolchain,
        })
        .pipe(
            Effect.mapError(
                mapFailure(
                    'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                    'The project dependency state could not be authenticated',
                ),
            ),
        );
}

function recheckBeforeFailure<Value>(
    effect: Effect.Effect<Value, ProjectDependenciesError>,
    state: ProjectDependencyStateInspection,
    states: ProjectDependenciesStateShape,
): Effect.Effect<Value, ProjectDependenciesError> {
    return Effect.matchEffect(effect, {
        onFailure: (failure) =>
            states.recheck({ revision: state.revision }).pipe(
                Effect.mapError(
                    mapFailure(
                        'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                        'The project dependency state changed before the dependency edit committed',
                    ),
                ),
                Effect.flatMap(() => Effect.fail(failure)),
            ),
        onSuccess: Effect.succeed,
    });
}

interface PackageChange {
    readonly canonicalIri: string;
    readonly beforeVersion: string | null;
    readonly beforeSha256: string | null;
    readonly afterVersion: string | null;
    readonly afterSha256: string | null;
}

function packageChanges(before: LockfileV1 | null, after: LockfileV1): ReadonlyArray<PackageChange> {
    const previous = new Map((before?.packages ?? []).map((node) => [node.canonicalIri, node]));
    const next = new Map(after.packages.map((node) => [node.canonicalIri, node]));
    const iris = [...new Set([...previous.keys(), ...next.keys()])].sort(compareCodePoints);
    return Object.freeze(
        iris.flatMap((canonicalIri) => {
            const left = previous.get(canonicalIri);
            const right = next.get(canonicalIri);
            if (left?.version === right?.version && left?.archiveSha256 === right?.archiveSha256) {
                return [];
            }
            return [
                Object.freeze({
                    canonicalIri,
                    beforeVersion: left?.version ?? null,
                    beforeSha256: left?.archiveSha256 ?? null,
                    afterVersion: right?.version ?? null,
                    afterSha256: right?.archiveSha256 ?? null,
                }),
            ];
        }),
    );
}

function changedManifest(manifest: ManifestV1, dependencies: Readonly<Record<string, string>>): ManifestV1 {
    return normalizeManifestV1({ ...manifest, dependencies });
}

function pruneLock(lock: LockfileV1, manifest: ManifestV1, removedIdentifier: string): LockfileV1 {
    const directDependencies = lock.directDependencies.filter(({ identifier }) => identifier !== removedIdentifier);
    const nodes = new Map(lock.packages.map((node) => [node.canonicalIri, node]));
    const reachable = new Set<string>();
    const pending = directDependencies
        .map(({ canonicalIri }) => canonicalIri)
        .sort(compareCodePoints)
        .reverse();
    while (pending.length > 0) {
        const canonicalIri = pending.pop() as string;
        if (reachable.has(canonicalIri)) {
            continue;
        }
        const node = nodes.get(canonicalIri);
        if (node === undefined) {
            throw new ProjectDependenciesError(
                'PROJECT_DEPENDENCIES_LOCK_REQUIRED',
                'The authenticated lock graph is incomplete',
            );
        }
        reachable.add(canonicalIri);
        for (const edge of [...node.dependencies]
            .sort((left, right) => compareCodePoints(left.canonicalIri, right.canonicalIri))
            .reverse()) {
            pending.push(edge.canonicalIri);
        }
    }
    const packages = lock.packages.filter(({ canonicalIri }) => reachable.has(canonicalIri));
    const aliases = new Set(
        directDependencies.filter(({ identifier }) => isScopedAlias(identifier)).map(({ identifier }) => identifier),
    );
    const aliasMappings = lock.aliasMappings.filter(({ alias }) => aliases.has(alias));
    const registryOrigin = directDependencies.length === 0 ? null : (manifest.registry ?? null);
    return decodeLockfileValue({
        lockfileVersion: 1,
        registryOrigin,
        manifestDependencySha256: manifestDependencyProjectionSha256({
            canonicalIri: manifest.canonicalIri,
            alias: manifest.alias,
            registryOrigin,
            dependencies: manifest.dependencies,
        }),
        root: lock.root,
        directDependencies,
        aliasMappings,
        packages,
        toolchain: lock.toolchain,
        counts: {
            directDependencies: directDependencies.length,
            aliasMappings: aliasMappings.length,
            packages: packages.length,
            edges: packages.reduce((total, node) => total + node.dependencies.length, 0),
        },
    });
}

function stateDigest(write: ProjectDependencyStateWriteResult): Readonly<{
    manifestSha256: string;
    lockSha256: string;
}> {
    return Object.freeze({ manifestSha256: write.manifest.sha256, lockSha256: write.lock.sha256 });
}

function installAfterCommit(
    state: ProjectDependencyStateInspection,
    toolchain: LockToolchain,
    storeRoot: string | undefined,
    lockStatus: 'existing' | 'written',
    installer: InstallCommittedStateServiceShape,
    errorCode: 'PROJECT_DEPENDENCIES_INSTALL_FAILED' | 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED',
): Effect.Effect<InstallProjectReport, ProjectDependenciesError> {
    return installer
        .installCommitted({
            state,
            toolchain,
            ...(storeRoot === undefined ? {} : { storeRoot }),
            offline: false,
            frozenLockfile: false,
            lockStatus,
            lockCleanup: 'clean',
        })
        .pipe(
            Effect.mapError(
                mapFailure(
                    errorCode,
                    errorCode === 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED'
                        ? 'The committed dependency state could not be installed'
                        : 'The existing dependency state could not be installed',
                ),
            ),
        );
}

function committedInstall(
    write: ProjectDependencyStateWriteResult,
    toolchain: LockToolchain,
    storeRoot: string | undefined,
    installer: InstallCommittedStateServiceShape,
): Effect.Effect<InstallProjectReport, ProjectDependenciesError> {
    return Effect.matchEffect(
        installAfterCommit(
            write.state,
            toolchain,
            storeRoot,
            'written',
            installer,
            'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED',
        ),
        {
            onFailure: (cause) => Effect.fail(new ProjectDependenciesCommittedError(stateDigest(write), cause)),
            onSuccess: Effect.succeed,
        },
    );
}

function makeReport(
    input: Readonly<{
        operation: 'add' | 'remove';
        state: ProjectDependencyStateInspection;
        stateStatus: 'unchanged' | 'written';
        manifestSha256: string;
        lockSha256: string;
        identifier: string;
        previousRange: string | null;
        nextRange: string | null;
        canonicalIri: string;
        resolution: 'existing-lock' | 'full-graph' | 'pruned-exact';
        changes: ReadonlyArray<PackageChange>;
        installation: InstallProjectReport;
        warnings: ReadonlyArray<'full-graph-reresolved' | 'jsonc-presentation-lost'>;
    }>,
): ProjectDependenciesReport {
    return decodeProjectDependenciesReport({
        schema: PROJECT_DEPENDENCIES_REPORT_VERSION,
        operation: input.operation,
        project: { canonicalIri: input.state.project.manifest.canonicalIri, alias: input.state.project.manifest.alias },
        dependency: {
            identifier: input.identifier,
            previousRange: input.previousRange,
            nextRange: input.nextRange,
            canonicalIri: input.canonicalIri,
        },
        state: {
            status: input.stateStatus,
            manifestFormat: input.state.project.format,
            manifestSha256: input.manifestSha256,
            lockSha256: input.lockSha256,
        },
        resolution: input.resolution,
        packageChanges: input.changes,
        installation: input.installation,
        warnings: input.warnings,
        outcome: 'installed',
    });
}

type ReportInput = Parameters<typeof makeReport>[0];

function reportEffect(input: ReportInput): Effect.Effect<ProjectDependenciesReport, ProjectDependenciesError> {
    return Effect.try({
        try: () => makeReport(input),
        catch: mapFailure(
            'PROJECT_DEPENDENCIES_REPORT_INVALID',
            'The dependency-change result could not be authenticated',
        ),
    });
}

function committedReport(
    write: ProjectDependencyStateWriteResult,
    input: ReportInput,
): Effect.Effect<ProjectDependenciesReport, ProjectDependenciesError> {
    return Effect.matchEffect(reportEffect(input), {
        onFailure: (cause) => Effect.fail(new ProjectDependenciesCommittedError(stateDigest(write), cause)),
        onSuccess: Effect.succeed,
    });
}

interface UpdateReportInput {
    readonly state: ProjectDependencyStateInspection;
    readonly stateStatus: 'unchanged' | 'written';
    readonly manifestSha256: string;
    readonly lockSha256: string;
    readonly strategy: 'full-graph' | 'targeted-frozen';
    readonly target: Readonly<{ readonly identifier: string; readonly canonicalIri: string }> | null;
    readonly changes: ReadonlyArray<PackageChange>;
    readonly installation: InstallProjectReport;
}

function updateReportEffect(
    input: UpdateReportInput,
): Effect.Effect<ProjectDependencyUpdateReport, ProjectDependenciesError> {
    return Effect.try({
        try: () => {
            const healed =
                input.installation.packages.fetched.length > 0 ||
                input.installation.packages.repaired.length > 0 ||
                input.installation.materialization.status === 'materialized';
            return decodeProjectDependencyUpdateReport({
                schema: PROJECT_DEPENDENCY_UPDATE_REPORT_VERSION,
                project: {
                    canonicalIri: input.state.project.manifest.canonicalIri,
                    alias: input.state.project.manifest.alias,
                },
                strategy: input.strategy,
                target: input.target,
                state: {
                    status: input.stateStatus,
                    manifestFormat: input.state.project.format,
                    manifestSha256: input.manifestSha256,
                    lockSha256: input.lockSha256,
                },
                packageChanges: input.changes,
                installation: input.installation,
                outcome: input.stateStatus === 'written' ? 'updated' : healed ? 'healed' : 'unchanged',
            });
        },
        catch: mapFailure(
            'PROJECT_DEPENDENCIES_REPORT_INVALID',
            'The dependency-update result could not be authenticated',
        ),
    });
}

function committedUpdateReport(
    write: ProjectDependencyStateWriteResult,
    input: UpdateReportInput,
): Effect.Effect<ProjectDependencyUpdateReport, ProjectDependenciesError> {
    return Effect.matchEffect(updateReportEffect(input), {
        onFailure: (cause) => Effect.fail(new ProjectDependenciesCommittedError(stateDigest(write), cause)),
        onSuccess: Effect.succeed,
    });
}

function resolutionError(cause: unknown): ProjectDependenciesError {
    if (isDependencyResolutionError(cause) && cause.code === 'frozen-shared-conflict') {
        return new ProjectDependenciesFrozenConflictError(cause.frozenCanonicalIris ?? [], cause);
    }
    if (isDependencyResolutionError(cause) && cause.code === 'catalog-identity-mismatch') {
        return new ProjectDependenciesError(
            'PROJECT_DEPENDENCIES_REGISTRY_INTEGRITY',
            'The registry changed the authenticated identity of an existing exact release',
            cause,
        );
    }
    if (isDependencyRegistryUnavailableError(cause)) {
        return new ProjectDependenciesError(
            'PROJECT_DEPENDENCIES_REGISTRY_UNAVAILABLE',
            'No production dependency registry transport is configured',
            cause,
        );
    }
    if (isDependencyResolutionError(cause)) {
        let nested: unknown = cause;
        for (let depth = 0; depth < 32; depth += 1) {
            if (isDependencyRegistryUnavailableError(nested)) {
                return new ProjectDependenciesError(
                    'PROJECT_DEPENDENCIES_REGISTRY_UNAVAILABLE',
                    'No production dependency registry transport is configured',
                    cause,
                );
            }
            if (!isDependencyResolutionError(nested)) {
                break;
            }
            let descriptor: PropertyDescriptor | undefined;
            try {
                descriptor = Object.getOwnPropertyDescriptor(nested, 'cause');
            } catch {
                break;
            }
            if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable) {
                break;
            }
            nested = descriptor.value;
        }
    }
    return new ProjectDependenciesError(
        'PROJECT_DEPENDENCIES_RESOLUTION_FAILED',
        'The complete dependency graph could not be resolved',
        cause,
    );
}

function runAdd(
    input: AddProjectDependencyOptions,
    states: ProjectDependenciesStateShape,
    toolchains: CurrentToolchainShape,
    resolver: DependencyResolverShape,
    installer: InstallCommittedStateServiceShape,
): Effect.Effect<ProjectDependenciesReport, ProjectDependenciesError> {
    return Effect.gen(function* () {
        const options = yield* Effect.try({
            try: () => exactOptions(input, 'add'),
            catch: mapFailure('PROJECT_DEPENDENCIES_INVALID_INPUT', 'The dependency add options are invalid'),
        });
        const toolchain = yield* toolchains
            .inspect()
            .pipe(
                Effect.mapError(
                    mapFailure(
                        'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                        'The current dependency toolchain is unavailable',
                    ),
                ),
            );
        const state = yield* inspectState(options, toolchain, states);
        const previousRange = state.project.manifest.dependencies[options.identifier];
        if (previousRange === options.range && state.lockInspection.status === 'available') {
            const direct = yield* recheckBeforeFailure(
                Effect.gen(function* () {
                    const found =
                        state.lockInspection.status === 'available'
                            ? state.lockInspection.lock.directDependencies.find(
                                  ({ identifier }) => identifier === options.identifier,
                              )
                            : undefined;
                    if (found === undefined) {
                        return yield* Effect.fail(
                            new ProjectDependenciesError(
                                'PROJECT_DEPENDENCIES_LOCK_REQUIRED',
                                'The matching lock does not contain the authored dependency',
                            ),
                        );
                    }
                    return found;
                }),
                state,
                states,
            );
            yield* states
                .recheck({ revision: state.revision })
                .pipe(
                    Effect.mapError(
                        mapFailure(
                            'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                            'The project dependency state changed before install healing',
                        ),
                    ),
                );
            const installation = yield* installAfterCommit(
                state,
                toolchain,
                options.storeRoot,
                'existing',
                installer,
                'PROJECT_DEPENDENCIES_INSTALL_FAILED',
            );
            return yield* reportEffect({
                operation: 'add',
                state,
                stateStatus: 'unchanged',
                manifestSha256: sha(state.manifestBytes),
                lockSha256: lockSha(state.lockInspection.lock),
                identifier: options.identifier,
                previousRange: previousRange as string,
                nextRange: options.range as string,
                canonicalIri: direct.canonicalIri,
                resolution: 'existing-lock',
                changes: [],
                installation,
                warnings: [],
            });
        }
        const before = state.lockInspection.lock;
        const dependencies = Object.fromEntries(Object.entries(state.project.manifest.dependencies));
        dependencies[options.identifier] = options.range as string;
        const manifest = changedManifest(state.project.manifest, dependencies);
        const plan = yield* recheckBeforeFailure(
            Effect.gen(function* () {
                if (manifest.registry === undefined) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_REGISTRY_REQUIRED',
                            'Add a registry origin to the project manifest before adding the first published dependency',
                        ),
                    );
                }
                const resolved = yield* resolver
                    .resolve({
                        manifest,
                        toolchain,
                        ...(before === null ? {} : { existingLock: before }),
                    })
                    .pipe(Effect.mapError(resolutionError));
                const added = resolved.lock.directDependencies.find(
                    ({ identifier }) => identifier === options.identifier,
                );
                if (added === undefined) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_RESOLUTION_FAILED',
                            'The resolved lock omitted the authored dependency',
                        ),
                    );
                }
                const duplicate =
                    state.project.manifest.dependencies[options.identifier] === undefined
                        ? resolved.lock.directDependencies.find(
                              ({ identifier, canonicalIri }) =>
                                  identifier !== options.identifier &&
                                  canonicalIri === added.canonicalIri &&
                                  state.project.manifest.dependencies[identifier] !== undefined,
                          )
                        : undefined;
                if (duplicate !== undefined) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_DUPLICATE_CANONICAL',
                            'That canonical dependency is already authored under another identifier; remove it before adding a new key',
                        ),
                    );
                }
                return Object.freeze({ manifest, lock: resolved.lock, added });
            }),
            state,
            states,
        );
        const write = yield* recheckBeforeFailure(
            states
                .write({
                    revision: state.revision,
                    manifest: { kind: 'replace', manifest: plan.manifest },
                    lock: plan.lock,
                })
                .pipe(
                    Effect.mapError(
                        mapFailure(
                            'PROJECT_DEPENDENCIES_COMMIT_FAILED',
                            'The dependency manifest and lock could not be committed',
                        ),
                    ),
                ),
            state,
            states,
        );
        const installation = yield* committedInstall(write, toolchain, options.storeRoot, installer);
        return yield* committedReport(write, {
            operation: 'add',
            state: write.state,
            stateStatus: 'written',
            manifestSha256: write.manifest.sha256,
            lockSha256: write.lock.sha256,
            identifier: options.identifier,
            previousRange: previousRange ?? null,
            nextRange: options.range as string,
            canonicalIri: plan.added.canonicalIri,
            resolution: 'full-graph',
            changes: packageChanges(before, plan.lock),
            installation,
            warnings: Object.freeze([
                'full-graph-reresolved',
                ...(state.project.format === 'jsonc' ? ['jsonc-presentation-lost' as const] : []),
            ]),
        });
    });
}

function runRemove(
    input: RemoveProjectDependencyOptions,
    states: ProjectDependenciesStateShape,
    toolchains: CurrentToolchainShape,
    installer: InstallCommittedStateServiceShape,
): Effect.Effect<ProjectDependenciesReport, ProjectDependenciesError> {
    return Effect.gen(function* () {
        const options = yield* Effect.try({
            try: () => exactOptions(input, 'remove'),
            catch: mapFailure('PROJECT_DEPENDENCIES_INVALID_INPUT', 'The dependency remove options are invalid'),
        });
        const toolchain = yield* toolchains
            .inspect()
            .pipe(
                Effect.mapError(
                    mapFailure(
                        'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                        'The current dependency toolchain is unavailable',
                    ),
                ),
            );
        const state = yield* inspectState(options, toolchain, states);
        const plan = yield* recheckBeforeFailure(
            Effect.gen(function* () {
                if (state.lockInspection.status !== 'available') {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_LOCK_REQUIRED',
                            'Remove requires a canonical matching erden.lock; run erden install first',
                        ),
                    );
                }
                const lock = state.lockInspection.lock;
                let direct = lock.directDependencies.find(({ identifier }) => identifier === options.identifier);
                if (direct === undefined && isCanonicalOntologyIri(options.identifier)) {
                    const matches = lock.directDependencies.filter(
                        ({ canonicalIri }) => canonicalIri === options.identifier,
                    );
                    if (matches.length > 1) {
                        return yield* Effect.fail(
                            new ProjectDependenciesError(
                                'PROJECT_DEPENDENCIES_AMBIGUOUS_IDENTIFIER',
                                'The canonical IRI is authored by more than one dependency key; remove an exact key',
                            ),
                        );
                    }
                    direct = matches[0];
                }
                if (direct === undefined) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_NOT_FOUND',
                            'The authored dependency was not found',
                        ),
                    );
                }
                const previousRange = state.project.manifest.dependencies[direct.identifier];
                if (previousRange === undefined) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_LOCK_REQUIRED',
                            'The authenticated lock and manifest disagree about the dependency key',
                        ),
                    );
                }
                const dependencies = Object.fromEntries(
                    Object.entries(state.project.manifest.dependencies).filter(
                        ([identifier]) => identifier !== direct.identifier,
                    ),
                );
                const manifest = changedManifest(state.project.manifest, dependencies);
                const pruned = yield* Effect.try({
                    try: () => pruneLock(lock, manifest, direct.identifier),
                    catch: mapFailure(
                        'PROJECT_DEPENDENCIES_LOCK_REQUIRED',
                        'The authenticated lock graph could not be pruned exactly',
                    ),
                });
                return Object.freeze({ lock, direct, previousRange, manifest, pruned });
            }),
            state,
            states,
        );
        const write = yield* recheckBeforeFailure(
            states
                .write({
                    revision: state.revision,
                    manifest: { kind: 'replace', manifest: plan.manifest },
                    lock: plan.pruned,
                })
                .pipe(
                    Effect.mapError(
                        mapFailure(
                            'PROJECT_DEPENDENCIES_COMMIT_FAILED',
                            'The dependency manifest and lock could not be committed',
                        ),
                    ),
                ),
            state,
            states,
        );
        const installation = yield* committedInstall(write, toolchain, options.storeRoot, installer);
        return yield* committedReport(write, {
            operation: 'remove',
            state: write.state,
            stateStatus: 'written',
            manifestSha256: write.manifest.sha256,
            lockSha256: write.lock.sha256,
            identifier: plan.direct.identifier,
            previousRange: plan.previousRange,
            nextRange: null,
            canonicalIri: plan.direct.canonicalIri,
            resolution: 'pruned-exact',
            changes: packageChanges(plan.lock, plan.pruned),
            installation,
            warnings: state.project.format === 'jsonc' ? Object.freeze(['jsonc-presentation-lost']) : Object.freeze([]),
        });
    });
}

function runUpdate(
    input: UpdateProjectDependenciesOptions,
    states: ProjectDependenciesStateShape,
    toolchains: CurrentToolchainShape,
    resolver: DependencyResolverShape,
    installer: InstallCommittedStateServiceShape,
): Effect.Effect<ProjectDependencyUpdateReport, ProjectDependenciesError> {
    return Effect.gen(function* () {
        const options = yield* Effect.try({
            try: () => exactUpdateOptions(input),
            catch: mapFailure('PROJECT_DEPENDENCIES_INVALID_INPUT', 'The dependency update options are invalid'),
        });
        const toolchain = yield* toolchains
            .inspect()
            .pipe(
                Effect.mapError(
                    mapFailure(
                        'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                        'The current dependency toolchain is unavailable',
                    ),
                ),
            );
        const state = yield* inspectState(options, toolchain, states);
        const plan = yield* recheckBeforeFailure(
            Effect.gen(function* () {
                if (state.lockInspection.status !== 'available') {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_LOCK_REQUIRED',
                            'Update requires a canonical matching erden.lock; run erden install first',
                        ),
                    );
                }
                const before = state.lockInspection.lock;
                const direct =
                    options.identifier === undefined
                        ? undefined
                        : before.directDependencies.find(({ identifier }) => identifier === options.identifier);
                if (options.identifier !== undefined && direct === undefined) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_NOT_FOUND',
                            'The exact authored dependency target was not found',
                        ),
                    );
                }
                if (before.packages.length > 0 && state.project.manifest.registry === undefined) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_REGISTRY_REQUIRED',
                            'Configure a registry origin before updating published dependencies',
                        ),
                    );
                }
                const resolved = yield* resolver
                    .resolve({
                        manifest: state.project.manifest,
                        toolchain,
                        existingLock: before,
                        selection:
                            options.identifier === undefined
                                ? { kind: 'update-full-graph' }
                                : { kind: 'update-targeted-frozen', identifier: options.identifier },
                    })
                    .pipe(Effect.mapError(resolutionError));
                const changes = packageChanges(before, resolved.lock);
                const beforeSha256 = lockSha(before);
                const afterSha256 = lockSha(resolved.lock);
                if ((changes.length === 0) !== (beforeSha256 === afterSha256)) {
                    return yield* Effect.fail(
                        new ProjectDependenciesError(
                            'PROJECT_DEPENDENCIES_RESOLUTION_FAILED',
                            'The dependency update produced contradictory exact lock changes',
                        ),
                    );
                }
                return Object.freeze({
                    before,
                    lock: resolved.lock,
                    changes,
                    beforeSha256,
                    afterSha256,
                    strategy: options.identifier === undefined ? ('full-graph' as const) : ('targeted-frozen' as const),
                    target:
                        direct === undefined
                            ? null
                            : Object.freeze({ identifier: direct.identifier, canonicalIri: direct.canonicalIri }),
                });
            }),
            state,
            states,
        );
        if (plan.changes.length === 0) {
            yield* states
                .recheck({ revision: state.revision })
                .pipe(
                    Effect.mapError(
                        mapFailure(
                            'PROJECT_DEPENDENCIES_STATE_UNAVAILABLE',
                            'The project dependency state changed before install healing',
                        ),
                    ),
                );
            const installation = yield* installAfterCommit(
                state,
                toolchain,
                options.storeRoot,
                'existing',
                installer,
                'PROJECT_DEPENDENCIES_INSTALL_FAILED',
            );
            return yield* updateReportEffect({
                state,
                stateStatus: 'unchanged',
                manifestSha256: sha(state.manifestBytes),
                lockSha256: plan.beforeSha256,
                strategy: plan.strategy,
                target: plan.target,
                changes: [],
                installation,
            });
        }
        const write = yield* recheckBeforeFailure(
            states
                .write({
                    revision: state.revision,
                    manifest: { kind: 'preserve' },
                    lock: plan.lock,
                })
                .pipe(
                    Effect.mapError(
                        mapFailure('PROJECT_DEPENDENCIES_COMMIT_FAILED', 'The updated lock could not be committed'),
                    ),
                ),
            state,
            states,
        );
        const installation = yield* committedInstall(write, toolchain, options.storeRoot, installer);
        return yield* committedUpdateReport(write, {
            state: write.state,
            stateStatus: 'written',
            manifestSha256: write.manifest.sha256,
            lockSha256: write.lock.sha256,
            strategy: plan.strategy,
            target: plan.target,
            changes: plan.changes,
            installation,
        });
    });
}

export interface ProjectDependenciesServiceShape {
    readonly add: (
        input: AddProjectDependencyOptions,
    ) => Effect.Effect<ProjectDependenciesReport, ProjectDependenciesError>;
    readonly remove: (
        input: RemoveProjectDependencyOptions,
    ) => Effect.Effect<ProjectDependenciesReport, ProjectDependenciesError>;
    readonly update: (
        input: UpdateProjectDependenciesOptions,
    ) => Effect.Effect<ProjectDependencyUpdateReport, ProjectDependenciesError>;
}

export const ProjectDependenciesService = Context.Service<ProjectDependenciesServiceShape>(
    '@erden/project/ProjectDependenciesService',
);

export function makeProjectDependenciesService(
    states: ProjectDependenciesStateShape,
    toolchains: CurrentToolchainShape,
    resolver: DependencyResolverShape,
    installer: InstallCommittedStateServiceShape,
): ProjectDependenciesServiceShape {
    return Object.freeze({
        add: (input: AddProjectDependencyOptions) => runAdd(input, states, toolchains, resolver, installer),
        remove: (input: RemoveProjectDependencyOptions) => runRemove(input, states, toolchains, installer),
        update: (input: UpdateProjectDependenciesOptions) => runUpdate(input, states, toolchains, resolver, installer),
    });
}

export function makeNodeProjectDependenciesService(registry: DependencyRegistryShape): ProjectDependenciesServiceShape {
    return makeProjectDependenciesService(
        nodeProjectDependencyStateService,
        nodeCurrentToolchainService,
        makeDependencyResolver(registry),
        makeNodeInstallCommittedStateService(registry),
    );
}

export function makeNodeProjectDependenciesServiceFromReleaseIndex(
    index: RegistryReleaseIndexReaderShape,
    archives: DependencyArchiveReaderShape,
): ProjectDependenciesServiceShape {
    const archiveInstaller = makeNodeInstallCommittedStateService(archives);
    const localInstaller = makeNodeInstallCommittedStateService(unavailableDependencyRegistry);
    const addResolver = makeDependencyResolverFromReleaseIndex(index);
    const unavailableResolver = makeDependencyResolver(unavailableDependencyRegistry);
    return Object.freeze({
        add: (input: AddProjectDependencyOptions) =>
            runAdd(
                input,
                nodeProjectDependencyStateService,
                nodeCurrentToolchainService,
                addResolver,
                archiveInstaller,
            ),
        remove: (input: RemoveProjectDependencyOptions) =>
            runRemove(input, nodeProjectDependencyStateService, nodeCurrentToolchainService, localInstaller),
        update: (input: UpdateProjectDependenciesOptions) =>
            runUpdate(
                input,
                nodeProjectDependencyStateService,
                nodeCurrentToolchainService,
                unavailableResolver,
                localInstaller,
            ),
    });
}

export const nodeProjectDependenciesService = makeNodeProjectDependenciesService(unavailableDependencyRegistry);

export function addProjectDependency(
    input: AddProjectDependencyOptions,
): Effect.Effect<
    ProjectDependenciesReport,
    ProjectDependenciesError,
    Context.Service.Identifier<typeof ProjectDependenciesService>
> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(ProjectDependenciesService)).add(input);
    });
}

export function removeProjectDependency(
    input: RemoveProjectDependencyOptions,
): Effect.Effect<
    ProjectDependenciesReport,
    ProjectDependenciesError,
    Context.Service.Identifier<typeof ProjectDependenciesService>
> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(ProjectDependenciesService)).remove(input);
    });
}

export function updateProjectDependencies(
    input: UpdateProjectDependenciesOptions,
): Effect.Effect<
    ProjectDependencyUpdateReport,
    ProjectDependenciesError,
    Context.Service.Identifier<typeof ProjectDependenciesService>
> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(ProjectDependenciesService)).update(input);
    });
}

export function defineAddProjectDependencyOperation(
    input: AddProjectDependencyOptions,
): ApplicationOperation<
    'AddProjectDependency',
    ProjectDependenciesReport,
    ProjectDependenciesError,
    Context.Service.Identifier<typeof ProjectDependenciesService>
> {
    return Object.freeze({ name: 'AddProjectDependency', effect: addProjectDependency(input) });
}

export function defineRemoveProjectDependencyOperation(
    input: RemoveProjectDependencyOptions,
): ApplicationOperation<
    'RemoveProjectDependency',
    ProjectDependenciesReport,
    ProjectDependenciesError,
    Context.Service.Identifier<typeof ProjectDependenciesService>
> {
    return Object.freeze({ name: 'RemoveProjectDependency', effect: removeProjectDependency(input) });
}

export function defineUpdateProjectDependenciesOperation(
    input: UpdateProjectDependenciesOptions,
): ApplicationOperation<
    'UpdateProjectDependencies',
    ProjectDependencyUpdateReport,
    ProjectDependenciesError,
    Context.Service.Identifier<typeof ProjectDependenciesService>
> {
    return Object.freeze({ name: 'UpdateProjectDependencies', effect: updateProjectDependencies(input) });
}
