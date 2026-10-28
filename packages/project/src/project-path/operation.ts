import { dirname, isAbsolute, resolve } from 'node:path';

import { Context, Effect } from 'effect';

import {
    decodeLockfileValue,
    decodeLockToolchain,
    nodeCurrentToolchainService,
    serializeLockfileBytes,
    type CurrentToolchainShape,
    type LockfileV1,
    isCanonicalOntologyIri,
    isScopedAlias,
    normalizeManifestV1,
    type LoadedManifestV1,
    type ManifestFormat,
} from '@erden/contracts';

import type { ApplicationOperation } from '../index.js';
import {
    nodeProjectDependencyStateService,
    isProjectDependencyStateError,
    type ProjectDependencyStateServiceShape,
} from '../project-dependency-state/index.js';
import type { ProjectLockInspection } from '../project-lock/index.js';
import {
    LocalPackageStoreError,
    nodeLocalPackageStore,
    type PathForLayerInput,
    type ResolvedLayerPath,
} from '../store/index.js';

import { ProjectPathError } from './errors.js';
import { decodeProjectPathReport, PROJECT_PATH_REPORT_VERSION, type ProjectPathReport } from './report.js';

export interface ProjectPathOptions {
    readonly identifier: string;
    readonly from?: string;
    readonly manifestPath?: string;
}

export type ProjectPathStateShape = Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck'>;

export interface ProjectPathStoreShape {
    readonly pathForLayer: (input: PathForLayerInput) => Effect.Effect<ResolvedLayerPath, unknown>;
}

function exactRecord(input: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new TypeError('record shape');
    }
    const names = Object.getOwnPropertyNames(input).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        throw new TypeError('record fields');
    }
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('record descriptor');
        }
    }
    return input as Record<string, unknown>;
}

function snapshotOptions(
    input: ProjectPathOptions,
): Readonly<Required<Pick<ProjectPathOptions, 'identifier'>> & Pick<ProjectPathOptions, 'from' | 'manifestPath'>> {
    try {
        const record = exactRecord(input, Object.getOwnPropertyNames(input));
        const allowed = new Set(['identifier', 'from', 'manifestPath']);
        if (Object.keys(record).some((key) => !allowed.has(key))) {
            throw new TypeError('option field');
        }
        const identifier = record['identifier'];
        const from = record['from'];
        const manifestPath = record['manifestPath'];
        if (
            typeof identifier !== 'string' ||
            (!isCanonicalOntologyIri(identifier) && !isScopedAlias(identifier)) ||
            (from !== undefined && (typeof from !== 'string' || from.length === 0 || from.includes('\0'))) ||
            (manifestPath !== undefined &&
                (typeof manifestPath !== 'string' || manifestPath.length === 0 || manifestPath.includes('\0'))) ||
            (from !== undefined && manifestPath !== undefined)
        ) {
            throw new TypeError('option value');
        }
        return Object.freeze({
            identifier,
            ...(from === undefined ? {} : { from }),
            ...(manifestPath === undefined ? {} : { manifestPath }),
        });
    } catch (cause) {
        throw new ProjectPathError('PROJECT_PATH_INVALID_INPUT', 'The path options are invalid', cause);
    }
}

const FORMATS = new Set<ManifestFormat>(['json', 'jsonc', 'yaml', 'toml']);

function snapshotProject(input: unknown): LoadedManifestV1 {
    const record = exactRecord(input, [
        'filePath',
        'format',
        'manifest',
        'projectRoot',
        'resolvedCitationRoots',
        'resolvedSources',
    ]);
    const format = record['format'];
    const filePath = record['filePath'];
    const projectRoot = record['projectRoot'];
    if (
        typeof format !== 'string' ||
        !FORMATS.has(format as ManifestFormat) ||
        typeof filePath !== 'string' ||
        !isAbsolute(filePath) ||
        filePath.includes('\0') ||
        typeof projectRoot !== 'string' ||
        !isAbsolute(projectRoot) ||
        projectRoot.includes('\0') ||
        resolve(dirname(filePath)) !== resolve(projectRoot)
    ) {
        throw new TypeError('project location');
    }
    const manifest = normalizeManifestV1(record['manifest']);
    return Object.freeze({
        format: format as ManifestFormat,
        filePath: resolve(filePath),
        projectRoot: resolve(projectRoot),
        manifest,
        // ProjectPath intentionally has no source-reading capability. These loaded
        // manifest fields are discarded rather than traversing unneeded port data.
        resolvedSources: Object.freeze({
            ontology: Object.freeze([]),
            shapes: Object.freeze([]),
            competencyQuestions: Object.freeze([]),
        }),
        resolvedCitationRoots: Object.freeze({}),
    });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return Buffer.from(left).equals(Buffer.from(right));
}

function snapshotInspection(input: unknown): ProjectLockInspection {
    const record = exactRecord(input, ['canonicalBytes', 'lock', 'reasons', 'status']);
    const status = record['status'];
    const reasons = record['reasons'];
    if (
        !Array.isArray(reasons) ||
        Object.getPrototypeOf(reasons) !== Array.prototype ||
        Object.getOwnPropertyNames(reasons).length !== reasons.length + 1
    ) {
        throw new TypeError('lock reasons');
    }
    const reasonSnapshot: string[] = [];
    for (let index = 0; index < reasons.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(reasons, String(index));
        if (
            descriptor === undefined ||
            !('value' in descriptor) ||
            !descriptor.enumerable ||
            typeof descriptor.value !== 'string'
        ) {
            throw new TypeError('lock reason');
        }
        reasonSnapshot.push(descriptor.value);
    }
    if (status === 'missing') {
        if (record['lock'] !== null || record['canonicalBytes'] !== null || reasonSnapshot.length !== 0) {
            throw new TypeError('missing lock truth');
        }
        return Object.freeze({ status, lock: null, canonicalBytes: null, reasons: Object.freeze([]) });
    }
    if (status !== 'available' && status !== 'stale') {
        throw new TypeError('lock status');
    }
    const lock = decodeLockfileValue(record['lock']);
    const canonicalBytes = record['canonicalBytes'];
    if (!(canonicalBytes instanceof Uint8Array)) {
        throw new TypeError('lock bytes');
    }
    const copiedBytes = Uint8Array.from(canonicalBytes);
    if (
        !bytesEqual(copiedBytes, serializeLockfileBytes(lock)) ||
        (status === 'available' && reasonSnapshot.length !== 0) ||
        (status === 'stale' && reasonSnapshot.length === 0)
    ) {
        throw new TypeError('lock inspection truth');
    }
    return status === 'available'
        ? Object.freeze({ status, lock, canonicalBytes: copiedBytes, reasons: Object.freeze([]) })
        : (Object.freeze({
              status,
              lock,
              canonicalBytes: copiedBytes,
              reasons: Object.freeze(reasonSnapshot),
          }) as ProjectLockInspection);
}

function snapshotLayer(input: unknown, identifier: string, lock: LockfileV1): ResolvedLayerPath {
    const record = exactRecord(input, ['archiveSha256', 'canonicalIri', 'identifier', 'path', 'version']);
    const canonicalIri = record['canonicalIri'];
    const version = record['version'];
    const archiveSha256 = record['archiveSha256'];
    const path = record['path'];
    if (
        record['identifier'] !== identifier ||
        typeof canonicalIri !== 'string' ||
        typeof version !== 'string' ||
        typeof archiveSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(archiveSha256) ||
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        path.includes('\0')
    ) {
        throw new TypeError('layer truth');
    }
    const expectedIri = identifier.startsWith('@')
        ? lock.aliasMappings.find(({ alias }) => alias === identifier)?.canonicalIri
        : identifier;
    const node = lock.packages.find((candidate) => candidate.canonicalIri === canonicalIri);
    if (
        expectedIri !== canonicalIri ||
        node === undefined ||
        node.version !== version ||
        node.archiveSha256 !== archiveSha256
    ) {
        throw new TypeError('layer identity');
    }
    return Object.freeze({ identifier, canonicalIri, version, archiveSha256, path });
}

function mapFailure(code: ProjectPathError['code'], message: string) {
    return (cause: unknown): ProjectPathError =>
        cause instanceof ProjectPathError ? cause : new ProjectPathError(code, message, cause);
}

function stateInspectFailure(cause: unknown): ProjectPathError {
    return isProjectDependencyStateError(cause) && cause.code === 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE'
        ? new ProjectPathError(
              'PROJECT_PATH_MANIFEST_UNAVAILABLE',
              'The project manifest could not be located, decoded, or authenticated',
              cause,
          )
        : new ProjectPathError(
              'PROJECT_PATH_LOCK_INVALID',
              'The project dependency state could not be authenticated',
              cause,
          );
}

function storeFailure(cause: unknown): ProjectPathError {
    if (cause instanceof ProjectPathError) {
        return cause;
    }
    if (cause instanceof LocalPackageStoreError) {
        if (cause.code === 'LAYER_NOT_FOUND') {
            return new ProjectPathError(
                'PROJECT_PATH_LAYER_NOT_FOUND',
                'The requested layer is not present in the authenticated installation',
                cause,
            );
        }
        if (
            cause.code === 'INSTALL_MISSING' ||
            cause.code === 'INSTALL_BUSY' ||
            cause.code === 'INSTALL_REPAIR_REQUIRED'
        ) {
            return new ProjectPathError(
                'PROJECT_PATH_INSTALL_UNAVAILABLE',
                'Run erden install to create the authenticated project dependency closure',
                cause,
            );
        }
    }
    return new ProjectPathError(
        'PROJECT_PATH_STORE_FAILURE',
        'The authenticated project layer could not be resolved',
        cause,
    );
}

function runProjectPath(
    input: ProjectPathOptions,
    states: ProjectPathStateShape,
    toolchains: CurrentToolchainShape,
    store: ProjectPathStoreShape,
): Effect.Effect<ProjectPathReport, ProjectPathError> {
    return Effect.gen(function* () {
        const options = yield* Effect.try({
            try: () => snapshotOptions(input),
            catch: mapFailure('PROJECT_PATH_INVALID_INPUT', 'The path options are invalid'),
        });
        const toolchainInput = yield* toolchains
            .inspect()
            .pipe(
                Effect.mapError(
                    mapFailure('PROJECT_PATH_TOOLCHAIN_UNAVAILABLE', 'The current dependency toolchain is unavailable'),
                ),
            );
        const toolchain = yield* Effect.try({
            try: () => decodeLockToolchain(toolchainInput),
            catch: mapFailure('PROJECT_PATH_TOOLCHAIN_UNAVAILABLE', 'The current dependency toolchain is unavailable'),
        });
        const state = yield* states
            .inspect({
                ...(options.from === undefined ? {} : { from: options.from }),
                ...(options.manifestPath === undefined ? {} : { explicitPath: options.manifestPath }),
                toolchain,
            })
            .pipe(Effect.mapError(stateInspectFailure));
        const project = yield* Effect.try({
            try: () => snapshotProject(state.project),
            catch: mapFailure(
                'PROJECT_PATH_MANIFEST_UNAVAILABLE',
                'The project manifest returned invalid project truth',
            ),
        });
        const inspection = yield* Effect.try({
            try: () => snapshotInspection(state.lockInspection),
            catch: mapFailure('PROJECT_PATH_LOCK_INVALID', 'The project lock returned invalid authentication truth'),
        });
        const body = Effect.gen(function* () {
            if (inspection.status === 'missing') {
                return yield* Effect.fail(
                    new ProjectPathError(
                        'PROJECT_PATH_LOCK_REQUIRED',
                        'Run erden install to create the canonical project lock',
                    ),
                );
            }
            if (inspection.status === 'stale') {
                return yield* Effect.fail(
                    new ProjectPathError(
                        'PROJECT_PATH_LOCK_STALE',
                        'Run erden install to update the stale project lock',
                    ),
                );
            }
            const layerInput = yield* store
                .pathForLayer({
                    projectRoot: project.projectRoot,
                    lock: inspection.lock,
                    identifier: options.identifier,
                })
                .pipe(Effect.mapError(storeFailure));
            const layer = yield* Effect.try({
                try: () => snapshotLayer(layerInput, options.identifier, inspection.lock),
                catch: storeFailure,
            });
            return yield* Effect.try({
                try: () =>
                    decodeProjectPathReport({
                        schema: PROJECT_PATH_REPORT_VERSION,
                        project: { canonicalIri: project.manifest.canonicalIri, alias: project.manifest.alias },
                        layer,
                        outcome: 'resolved',
                    }),
                catch: mapFailure(
                    'PROJECT_PATH_STORE_FAILURE',
                    'The deterministic path report could not be constructed',
                ),
            });
        });
        return yield* Effect.matchEffect(body, {
            onFailure: (failure) =>
                states.recheck({ revision: state.revision }).pipe(
                    Effect.mapError(
                        mapFailure(
                            'PROJECT_PATH_LOCK_INVALID',
                            'The project dependency state changed while resolving the layer path',
                        ),
                    ),
                    Effect.flatMap(() => Effect.fail(failure)),
                ),
            onSuccess: (report) =>
                states
                    .recheck({ revision: state.revision })
                    .pipe(
                        Effect.mapError(
                            mapFailure(
                                'PROJECT_PATH_LOCK_INVALID',
                                'The project dependency state changed while resolving the layer path',
                            ),
                        ),
                        Effect.as(report),
                    ),
        });
    });
}

export interface ProjectPathServiceShape {
    readonly path: (options: ProjectPathOptions) => Effect.Effect<ProjectPathReport, ProjectPathError>;
}

export const ProjectPathService = Context.Service<ProjectPathServiceShape>('@erden/project/ProjectPathService');

export function makeProjectPathService(
    states: ProjectPathStateShape,
    toolchains: CurrentToolchainShape,
    store: ProjectPathStoreShape,
): ProjectPathServiceShape {
    return Object.freeze({
        path: (options: ProjectPathOptions) => runProjectPath(options, states, toolchains, store),
    });
}

export const nodeProjectPathService = makeProjectPathService(
    nodeProjectDependencyStateService,
    nodeCurrentToolchainService,
    Object.freeze({ pathForLayer: nodeLocalPackageStore.pathForLayer }),
);

export function projectPath(
    options: ProjectPathOptions,
): Effect.Effect<ProjectPathReport, ProjectPathError, Context.Service.Identifier<typeof ProjectPathService>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(ProjectPathService)).path(options);
    });
}

export function defineProjectPathOperation(
    options: ProjectPathOptions,
): ApplicationOperation<
    'ProjectPath',
    ProjectPathReport,
    ProjectPathError,
    Context.Service.Identifier<typeof ProjectPathService>
> {
    return Object.freeze({ name: 'ProjectPath', effect: projectPath(options) });
}
