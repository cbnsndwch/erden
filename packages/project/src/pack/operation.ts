import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { Context, Effect } from 'effect';
import { valid } from 'semver';

import {
    checkLockConsistency,
    decodeLockfileValue,
    decodeLockToolchain,
    nodeCurrentToolchainService,
    serializeLockfileBytes,
    type CurrentToolchainShape,
    type LockfileV1,
    compareCodePoints,
    MANIFEST_FILENAMES,
    manifestFormatForFilename,
    normalizeManifestV1,
    normalizePublicationManifestV1,
    type LoadedManifestV1,
} from '@erden/contracts';
import { ONTOLOGY_DIRECTORY_EXTENSION, ONTOLOGY_SOURCE_EXTENSIONS } from '@erden/ontology';
import {
    assertNoPortablePathConflicts,
    makePackageIgnorePolicy,
    normalizePackagePath,
    PACKAGE_CODEC_LIMITS,
    packageCodec,
    portablePathCollisionKey,
    validatePackageArchive,
    type EncodedPackage,
    type PackageEncodeInput,
    type PackageLogicalFile,
    type PackageManifestV1,
    type ReferenceResolvedDependency,
} from '@erden/package-format';

import type { ApplicationOperation } from '../index.js';
import {
    nodeProjectDependencyStateService,
    isProjectDependencyStateError,
    type ProjectDependencyStateServiceShape,
} from '../project-dependency-state/index.js';

import { PackProjectError, isPackProjectError } from './errors.js';
import { makeNodePackFileSystemPort, type PackFileSystemPort, type PackNodeOperations } from './filesystem.js';
import { decodePackProjectReport, PACK_REPORT_VERSION, type PackProjectReport } from './report.js';

export interface PackProjectOptions {
    readonly version: string;
    readonly from?: string;
    readonly manifestPath?: string;
    readonly outputPath?: string;
}

export interface PackProjectCodecShape {
    readonly encode: (input: PackageEncodeInput) => Effect.Effect<EncodedPackage, unknown>;
}

interface Identity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
}
interface RootSnapshot {
    readonly path: string;
    readonly realPathKey: string;
    readonly chain: ReadonlyArray<Readonly<{ path: string; identity: Identity }>>;
}
interface CapturedFile extends PackageLogicalFile {
    readonly bytes: Uint8Array;
    readonly identity: Identity;
}
interface CapturedDirectory {
    readonly path: string;
    readonly identity: Identity;
}
interface CapturedControl {
    readonly bytes: Uint8Array;
    readonly identity: Identity;
}
interface CapturedControls {
    readonly erdenIgnore?: CapturedControl;
    readonly gitIgnore?: CapturedControl;
}
interface TreeSnapshot {
    readonly files: ReadonlyArray<CapturedFile>;
    readonly directories: ReadonlyArray<CapturedDirectory>;
    readonly ignore: '.erdenignore' | '.gitignore' | null;
    readonly controls: CapturedControls;
}

function projectStateFailure(cause: unknown): PackProjectError {
    if (isProjectDependencyStateError(cause) && cause.code === 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT') {
        // Pack never writes project state; the writer, erden install, recovers an interrupted transaction.
        return new PackProjectError(
            'PACK_PROJECT_LOCK_INVALID',
            'An interrupted erden install left dependency transaction files; run erden install to recover them, then pack again',
            cause,
        );
    }
    return isProjectDependencyStateError(cause) && cause.code === 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE'
        ? new PackProjectError(
              'PACK_PROJECT_MANIFEST_UNAVAILABLE',
              'The selected project manifest is unavailable',
              cause,
          )
        : new PackProjectError(
              'PACK_PROJECT_LOCK_INVALID',
              'The selected project dependency state could not be authenticated',
              cause,
          );
}

const exactVersion =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const tokenPattern = /^[0-9A-Za-z_-]{16,128}$/u;
export const PACK_PROJECT_TRAVERSAL_LIMITS = Object.freeze({
    maxObservedEntries: PACKAGE_CODEC_LIMITS.maxEntries + 32,
    maxObservedNameBytes: PACKAGE_CODEC_LIMITS.maxEntries * PACKAGE_CODEC_LIMITS.maxPathBytes,
});
function errorCode(error: unknown): string | undefined {
    try {
        if (error === null || typeof error !== 'object') {
            return undefined;
        }
        const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
        return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
            ? descriptor.value
            : undefined;
    } catch {
        return undefined;
    }
}

function copyBoundedBytes(value: unknown, maximum: number): Uint8Array {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
        throw new Error('byte shape');
    }
    const length = (value as Uint8Array).byteLength;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
        throw new Error('byte bound');
    }
    const copied = Uint8Array.prototype.slice.call(value) as Uint8Array;
    if (copied.byteLength !== length) {
        throw new Error('byte mutation');
    }
    return copied;
}

function packError(cause: unknown): PackProjectError {
    return isPackProjectError(cause)
        ? cause
        : new PackProjectError('PACK_PROJECT_TRANSACTION_FAILED', 'The package could not be created safely', cause);
}

function snapshotOptions(
    input: PackProjectOptions,
): Readonly<Required<Pick<PackProjectOptions, 'version'>> & Omit<PackProjectOptions, 'version'>> {
    try {
        const value: unknown = input;
        if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Object.getOwnPropertySymbols(value).length !== 0
        ) {
            throw new Error('shape');
        }
        const allowed = new Set(['version', 'from', 'manifestPath', 'outputPath']);
        const values = new Map<string, unknown>();
        for (const name of Object.getOwnPropertyNames(value)) {
            if (!allowed.has(name)) {
                throw new Error('field');
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('descriptor');
            }
            values.set(name, descriptor.value);
        }
        const version = values.get('version');
        const from = values.get('from');
        const manifestPath = values.get('manifestPath');
        const outputPath = values.get('outputPath');
        if (
            typeof version !== 'string' ||
            !exactVersion.test(version) ||
            valid(version, { loose: false }) === null ||
            (from !== undefined && (typeof from !== 'string' || from.includes('\0'))) ||
            (manifestPath !== undefined && (typeof manifestPath !== 'string' || manifestPath.includes('\0'))) ||
            (outputPath !== undefined && (typeof outputPath !== 'string' || outputPath.includes('\0'))) ||
            (from !== undefined && manifestPath !== undefined)
        ) {
            throw new Error('value');
        }
        return Object.freeze({
            version,
            ...(from === undefined ? {} : { from }),
            ...(manifestPath === undefined ? {} : { manifestPath }),
            ...(outputPath === undefined ? {} : { outputPath }),
        });
    } catch (cause) {
        throw new PackProjectError('PACK_PROJECT_INVALID_INPUT', 'The pack options are invalid', cause);
    }
}

function snapshotLocation(input: unknown): Readonly<{
    filePath: string;
    projectRoot: string;
    format: LoadedManifestV1['format'];
}> {
    try {
        if (
            input === null ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.getPrototypeOf(input) !== Object.prototype ||
            Object.getOwnPropertySymbols(input).length !== 0
        ) {
            throw new Error('location shape');
        }
        const names = Object.getOwnPropertyNames(input).sort(compareCodePoints);
        if (names.join('\0') !== ['filePath', 'format', 'projectRoot'].join('\0')) {
            throw new Error('location fields');
        }
        const values = new Map<string, unknown>();
        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(input, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('location descriptor');
            }
            values.set(name, descriptor.value);
        }
        const filePath = values.get('filePath');
        const projectRoot = values.get('projectRoot');
        const format = values.get('format');
        const expectedFormat = typeof filePath === 'string' ? manifestFormatForFilename(basename(filePath)) : undefined;
        if (
            typeof filePath !== 'string' ||
            typeof projectRoot !== 'string' ||
            !isAbsolute(filePath) ||
            !isAbsolute(projectRoot) ||
            filePath.includes('\0') ||
            projectRoot.includes('\0') ||
            dirname(filePath) !== projectRoot ||
            expectedFormat === undefined ||
            format !== expectedFormat
        ) {
            throw new Error('location truth');
        }
        return Object.freeze({ filePath, projectRoot, format: expectedFormat });
    } catch (cause) {
        throw new PackProjectError(
            'PACK_PROJECT_MANIFEST_UNAVAILABLE',
            'The selected project manifest is unavailable',
            cause,
        );
    }
}

function snapshotParsedProject(
    input: unknown,
    location: ReturnType<typeof snapshotLocation>,
    projectRoot: string,
): LoadedManifestV1 {
    try {
        if (
            input === null ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.getPrototypeOf(input) !== Object.prototype ||
            Object.getOwnPropertySymbols(input).length !== 0
        ) {
            throw new Error('manifest output shape');
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, 'manifest');
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new Error('manifest output descriptor');
        }
        const manifest = normalizeManifestV1(descriptor.value);
        return Object.freeze({
            format: location.format,
            filePath: location.filePath,
            projectRoot,
            manifest,
            resolvedSources: Object.freeze({
                ontology: Object.freeze(manifest.sources.ontology.map((path) => join(projectRoot, path))),
                shapes: Object.freeze(manifest.sources.shapes.map((path) => join(projectRoot, path))),
                competencyQuestions: Object.freeze(
                    manifest.sources.competencyQuestions.map((path) => join(projectRoot, path)),
                ),
            }),
            resolvedCitationRoots: Object.freeze({}),
        });
    } catch (cause) {
        throw new PackProjectError(
            'PACK_PROJECT_MANIFEST_UNAVAILABLE',
            'The selected project manifest is unavailable',
            cause,
        );
    }
}

function identity(stats: BigIntStats): Identity {
    return Object.freeze({
        dev: stats.dev,
        ino: stats.ino,
        mode: stats.mode,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
    });
}
function sameIdentity(left: Identity, right: Identity): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}
function sameNode(left: Identity, right: Identity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function portableKey(value: string): string {
    return portablePathCollisionKey(value);
}

async function snapshotRoot(operations: PackNodeOperations, input: string): Promise<RootSnapshot> {
    if (!isAbsolute(input)) {
        throw new PackProjectError('PACK_PROJECT_SOURCE_INVALID', 'The project root is not one absolute directory');
    }
    const path = resolve(input);
    const root = parse(path).root;
    const parts = path.slice(root.length).split(sep).filter(Boolean);
    const chain: Array<
        Readonly<{
            path: string;
            identity: Identity;
        }>
    > = [];
    let current = root;
    for (const part of ['', ...parts]) {
        if (part.length > 0) {
            current = join(current, part);
        }
        const stats = await operations.lstat(current, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new PackProjectError('PACK_PROJECT_SOURCE_INVALID', 'The project root has an unsafe ancestor');
        }
        chain.push(Object.freeze({ path: current, identity: identity(stats) }));
    }
    const realPathKey = portableKey(resolve(await operations.realpath(path)));
    if (realPathKey !== portableKey(path)) {
        throw new PackProjectError(
            'PACK_PROJECT_SOURCE_INVALID',
            'The project root does not use its real filesystem spelling',
        );
    }
    return Object.freeze({ path, realPathKey, chain: Object.freeze(chain) });
}

async function recheckRoot(operations: PackNodeOperations, snapshot: RootSnapshot): Promise<void> {
    for (const entry of snapshot.chain) {
        const stats = await operations.lstat(entry.path, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink() || !sameNode(identity(stats), entry.identity)) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The project root changed while it was being packed',
            );
        }
    }
    if (portableKey(resolve(await operations.realpath(snapshot.path))) !== snapshot.realPathKey) {
        throw new PackProjectError('PACK_PROJECT_SOURCE_INVALID', 'The project root changed while it was being packed');
    }
}

async function readFile(
    operations: PackNodeOperations,
    path: string,
    maximum: number,
    signal: AbortSignal,
    requireSingleLink = true,
): Promise<
    Readonly<{
        bytes: Uint8Array;
        identity: Identity;
    }>
> {
    signal.throwIfAborted();
    const before = await operations.lstat(path, { bigint: true });
    if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        (requireSingleLink && before.nlink !== 1n) ||
        before.size < 0n ||
        before.size > BigInt(maximum)
    ) {
        throw new PackProjectError(
            'PACK_PROJECT_SOURCE_INVALID',
            'A selected package source is not one bounded unlinked regular file',
        );
    }
    const handle = await operations.open(path, 'r');
    let result:
        | Readonly<{
              bytes: Uint8Array;
              identity: Identity;
          }>
        | undefined;
    let failure: unknown;
    try {
        const opened = await operations.stat(handle);
        if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'A selected package source changed before it could be read',
            );
        }
        const bytes = new Uint8Array(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
            signal.throwIfAborted();
            const { bytesRead } = await operations.read(handle, bytes, offset, bytes.length - offset, offset);
            if (bytesRead <= 0 || bytesRead > bytes.length - offset) {
                throw new Error('short read');
            }
            offset += bytesRead;
        }
        const afterHandle = await operations.stat(handle);
        const afterPath = await operations.lstat(path, { bigint: true });
        if (
            !sameIdentity(identity(opened), identity(afterHandle)) ||
            !sameIdentity(identity(opened), identity(afterPath))
        ) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'A selected package source changed while it was being read',
            );
        }
        result = Object.freeze({ bytes, identity: identity(opened) });
    } catch (cause) {
        failure = cause;
    }
    try {
        await operations.close(handle);
    } catch (cause) {
        if (failure === undefined) {
            failure = cause;
        }
    }
    if (failure !== undefined) {
        throw packError(failure);
    }
    if (result === undefined) {
        throw new Error('file read did not produce a result');
    }
    return result;
}

async function rootControlBytes(
    operations: PackNodeOperations,
    root: string,
    signal: AbortSignal,
): Promise<CapturedControls> {
    const names = await readNames(operations, root);
    for (const expected of ['.erdenignore', '.gitignore', 'erden.lock', ...MANIFEST_FILENAMES]) {
        const collisions = names.filter(
            (name) => portablePathCollisionKey(name) === portablePathCollisionKey(expected),
        );
        if (collisions.some((name) => name !== expected) || collisions.length > 1) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The project root contains a case- or Unicode-ambiguous control entry',
            );
        }
    }
    const result: {
        erdenIgnore?: CapturedControl;
        gitIgnore?: CapturedControl;
    } = {};
    for (const [name, key] of [
        ['.erdenignore', 'erdenIgnore'],
        ['.gitignore', 'gitIgnore'],
    ] as const) {
        try {
            const stats = await operations.lstat(join(root, name), { bigint: true });
            if (!stats.isFile() || stats.isSymbolicLink()) {
                throw new PackProjectError(
                    'PACK_PROJECT_SOURCE_INVALID',
                    'A package ignore control is not a regular file',
                );
            }
            result[key] = await readFile(operations, join(root, name), PACKAGE_CODEC_LIMITS.maxEntryBytes, signal);
        } catch (cause) {
            if (errorCode(cause) !== 'ENOENT') {
                throw cause;
            }
        }
    }
    return Object.freeze(result);
}

async function readNames(operations: PackNodeOperations, directory: string): Promise<ReadonlyArray<string>> {
    const names: string[] = [];
    let nameBytes = 0;
    const stream = await operations.opendir(directory);
    for await (const entry of stream) {
        nameBytes += Buffer.byteLength(entry.name, 'utf8');
        names.push(entry.name);
        if (
            names.length > PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedEntries ||
            nameBytes > PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedNameBytes
        ) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'A package directory exceeds the bounded entry scan',
            );
        }
    }
    return Object.freeze(names.sort(compareCodePoints));
}

async function assertSibling(
    operations: PackNodeOperations,
    directory: string,
    expected: string,
    allowExact: boolean,
): Promise<void> {
    const names = await readNames(operations, directory);
    const folded = portablePathCollisionKey(expected);
    const collisions = names.filter((name) => portablePathCollisionKey(name) === folded);
    if (
        collisions.some((name) => name !== expected) ||
        collisions.length > 1 ||
        (allowExact ? !collisions.includes(expected) : collisions.includes(expected))
    ) {
        throw new PackProjectError(
            'PACK_PROJECT_OUTPUT_EXISTS',
            'The package output or transaction name has a portable filesystem collision',
        );
    }
}

async function captureTree(operations: PackNodeOperations, root: string, signal: AbortSignal): Promise<TreeSnapshot> {
    const controls = await rootControlBytes(operations, root, signal);
    const policy = makePackageIgnorePolicy({
        ...(controls.erdenIgnore === undefined ? {} : { erdenIgnore: controls.erdenIgnore.bytes }),
        ...(controls.gitIgnore === undefined ? {} : { gitIgnore: controls.gitIgnore.bytes }),
    });
    const files: CapturedFile[] = [];
    const directories: CapturedDirectory[] = [];
    const portableEntries: Array<
        Readonly<{
            path: string;
            kind: 'file' | 'directory';
        }>
    > = [];
    const seen = new Set<string>();
    let total = 0;
    let observed = 0;
    let observedNameBytes = 0;
    async function visit(directory: string, prefix: string): Promise<void> {
        const stream = await operations.opendir(directory);
        for await (const entry of stream) {
            signal.throwIfAborted();
            observed += 1;
            observedNameBytes += Buffer.byteLength(entry.name, 'utf8');
            if (
                observed > PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedEntries ||
                observedNameBytes > PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedNameBytes
            ) {
                throw new PackProjectError(
                    'PACK_PROJECT_SOURCE_INVALID',
                    'The observed project tree exceeds the closed traversal bound',
                );
            }
            const logical = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
            if (policy.isAlwaysExcluded(logical) || policy.isIgnored(logical)) {
                continue;
            }
            const path = join(directory, entry.name);
            const stats = await operations.lstat(path, { bigint: true });
            const normalized = normalizePackagePath(logical);
            if (stats.isDirectory() && !stats.isSymbolicLink()) {
                directories.push(Object.freeze({ path: normalized, identity: identity(stats) }));
                portableEntries.push(Object.freeze({ path: normalized, kind: 'directory' as const }));
                await visit(path, logical);
                continue;
            }
            if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
                throw new PackProjectError(
                    'PACK_PROJECT_SOURCE_INVALID',
                    'A selected package entry is not a regular unlinked file',
                );
            }
            const captured = await readFile(operations, path, PACKAGE_CODEC_LIMITS.maxEntryBytes, signal);
            const key = `${captured.identity.dev.toString()}:${captured.identity.ino.toString()}`;
            if (seen.has(key)) {
                throw new PackProjectError(
                    'PACK_PROJECT_SOURCE_INVALID',
                    'Selected package files share one physical identity',
                );
            }
            seen.add(key);
            total += captured.bytes.byteLength;
            if (
                files.length + 1 > PACKAGE_CODEC_LIMITS.maxEntries ||
                total > PACKAGE_CODEC_LIMITS.maxDecompressedBytes
            ) {
                throw new PackProjectError(
                    'PACK_PROJECT_SOURCE_INVALID',
                    'The selected project exceeds the package bounds',
                );
            }
            files.push(
                Object.freeze({
                    path: normalized,
                    bytes: captured.bytes,
                    executable: false,
                    identity: captured.identity,
                }),
            );
            portableEntries.push(Object.freeze({ path: normalized, kind: 'file' as const }));
        }
    }
    await visit(root, '');
    files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    directories.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    assertNoPortablePathConflicts(portableEntries);
    return Object.freeze({
        files: Object.freeze(files),
        directories: Object.freeze(directories),
        ignore: policy.selectedIgnoreFile,
        controls: Object.freeze(controls),
    });
}

async function captureProjectTree(
    operations: PackNodeOperations,
    root: string,
    signal: AbortSignal,
): Promise<TreeSnapshot> {
    try {
        return await captureTree(operations, root, signal);
    } catch (cause) {
        if (isPackProjectError(cause)) {
            throw cause;
        }
        throw new PackProjectError(
            'PACK_PROJECT_SOURCE_INVALID',
            'The project tree is not a safe deterministic package source',
            cause,
        );
    }
}

function sha(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}
function sameControl(left: CapturedControl | undefined, right: CapturedControl | undefined): boolean {
    return left === undefined
        ? right === undefined
        : right !== undefined && sameIdentity(left.identity, right.identity) && sha(left.bytes) === sha(right.bytes);
}
function sameTree(left: TreeSnapshot, right: TreeSnapshot): boolean {
    return (
        left.ignore === right.ignore &&
        sameControl(left.controls.erdenIgnore, right.controls.erdenIgnore) &&
        sameControl(left.controls.gitIgnore, right.controls.gitIgnore) &&
        left.directories.length === right.directories.length &&
        left.directories.every((directory, index) => {
            const other = right.directories[index];
            return (
                other !== undefined && directory.path === other.path && sameIdentity(directory.identity, other.identity)
            );
        }) &&
        left.files.length === right.files.length &&
        left.files.every((file, index) => {
            const other = right.files[index];
            return (
                other !== undefined &&
                file.path === other.path &&
                sameIdentity(file.identity, other.identity) &&
                sha(file.bytes) === sha(other.bytes)
            );
        })
    );
}

function dependencies(lock: LockfileV1): ReadonlyArray<ReferenceResolvedDependency> {
    const seen = new Set<string>();
    return Object.freeze(
        lock.directDependencies.map((direct) => {
            if (seen.has(direct.canonicalIri)) {
                throw new PackProjectError(
                    'PACK_PROJECT_DEPENDENCY_UNREPRESENTABLE',
                    'Package format v1 cannot represent multiple authored constraints for one canonical dependency',
                );
            }
            seen.add(direct.canonicalIri);
            return Object.freeze({
                requested: direct.requested,
                canonicalIri: direct.canonicalIri,
                version: direct.version,
                archiveSha256: direct.archiveSha256,
            });
        }),
    );
}

function manifestMatchesSnapshot(
    manifest: PackageManifestV1,
    project: LoadedManifestV1,
    version: string,
    toolchain: ReturnType<typeof decodeLockToolchain>,
    direct: ReadonlyArray<ReferenceResolvedDependency>,
    tree: TreeSnapshot,
): boolean {
    if (
        manifest.canonicalIri !== project.manifest.canonicalIri ||
        manifest.version !== version ||
        manifest.toolchain.validator.version !== toolchain.validator.version ||
        manifest.toolchain.validator.sha256 !== toolchain.validator.sha256 ||
        manifest.toolchain.reasoner.version !== toolchain.reasoner.version ||
        manifest.toolchain.reasoner.sha256 !== toolchain.reasoner.sha256 ||
        manifest.dependencies.length !== direct.length ||
        manifest.files.length !== tree.files.length
    ) {
        return false;
    }
    for (const expected of direct) {
        const actual = manifest.dependencies.find(({ canonicalIri }) => canonicalIri === expected.canonicalIri);
        if (
            actual === undefined ||
            actual.requested !== expected.requested ||
            actual.version !== expected.version ||
            actual.archiveSha256 !== expected.archiveSha256
        ) {
            return false;
        }
    }
    for (const expected of tree.files) {
        const actual = manifest.files.find(({ path }) => path === expected.path);
        if (
            actual === undefined ||
            actual.byteSize !== expected.bytes.byteLength ||
            actual.sha256 !== sha(expected.bytes) ||
            actual.executable
        ) {
            return false;
        }
    }
    return true;
}

function snapshotAvailableLock(
    input: unknown,
    project: LoadedManifestV1,
    toolchain: ReturnType<typeof decodeLockToolchain>,
): Readonly<{
    lock: LockfileV1;
    canonicalBytes: Uint8Array;
}> {
    try {
        if (
            input === null ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.getPrototypeOf(input) !== Object.prototype ||
            Object.getOwnPropertySymbols(input).length !== 0
        ) {
            throw new Error('inspection shape');
        }
        const names = Object.getOwnPropertyNames(input).sort(compareCodePoints);
        if (names.join('\0') !== ['canonicalBytes', 'lock', 'reasons', 'status'].join('\0')) {
            throw new Error('inspection fields');
        }
        const values = new Map<string, unknown>();
        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(input, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('inspection descriptor');
            }
            values.set(name, descriptor.value);
        }
        if (values.get('status') !== 'available') {
            throw new Error('inspection status');
        }
        const reasons = values.get('reasons');
        if (
            !Array.isArray(reasons) ||
            Object.getPrototypeOf(reasons) !== Array.prototype ||
            Object.getOwnPropertySymbols(reasons).length !== 0 ||
            Object.getOwnPropertyNames(reasons).join('\0') !== 'length' ||
            reasons.length !== 0
        ) {
            throw new Error('inspection reasons');
        }
        const lock = decodeLockfileValue(values.get('lock'));
        const rawBytes = values.get('canonicalBytes');
        const canonicalBytes = copyBoundedBytes(rawBytes, PACKAGE_CODEC_LIMITS.maxEntryBytes);
        const expected = serializeLockfileBytes(lock);
        if (
            canonicalBytes.byteLength !== expected.byteLength ||
            sha(canonicalBytes) !== sha(expected) ||
            checkLockConsistency(project.manifest, toolchain, lock).status !== 'consistent'
        ) {
            throw new Error('inspection truth');
        }
        return Object.freeze({ lock, canonicalBytes });
    } catch (cause) {
        throw new PackProjectError(
            'PACK_PROJECT_LOCK_INVALID',
            'A canonical manifest-consistent erden.lock is required; run erden install first',
            cause,
        );
    }
}

/**
 * Whether a selector resolves to at least one shipped file. An ontology file selector may name any format Erden
 * reads; a directory selector counts only its directory-format files (Turtle for ontology and shapes).
 */
function selectorIncluded(
    selector: string,
    fileExtensions: ReadonlyArray<string>,
    directoryExtension: string,
    paths: ReadonlySet<string>,
): boolean {
    let normalized: string;
    try {
        normalized = normalizePackagePath(selector);
    } catch {
        return false;
    }
    if (paths.has(normalized) && fileExtensions.some((extension) => normalized.endsWith(extension))) {
        return true;
    }
    const prefix = `${normalized}/`;
    return [...paths].some((path) => path.startsWith(prefix) && path.endsWith(directoryExtension));
}

function assertRequired(project: LoadedManifestV1, tree: TreeSnapshot): void {
    const paths = new Set(tree.files.map(({ path }) => path));
    const manifestName = basename(project.filePath);
    const manifests = tree.files.filter(
        ({ path }) => !path.includes('/') && (MANIFEST_FILENAMES as ReadonlyArray<string>).includes(path),
    );
    if (
        !(MANIFEST_FILENAMES as ReadonlyArray<string>).includes(manifestName) ||
        manifests.length !== 1 ||
        manifests[0]?.path !== manifestName ||
        !paths.has('erden.lock')
    ) {
        throw new PackProjectError(
            'PACK_PROJECT_REQUIRED_FILE_IGNORED',
            'The selected root manifest and canonical erden.lock must be shipped',
        );
    }
    for (const [selectors, fileExtensions, directoryExtension] of [
        [project.manifest.sources.ontology, ONTOLOGY_SOURCE_EXTENSIONS, ONTOLOGY_DIRECTORY_EXTENSION],
        [project.manifest.sources.shapes, ['.ttl'], '.ttl'],
        [project.manifest.sources.competencyQuestions, ['.rq'], '.rq'],
    ] as const) {
        for (const selector of selectors) {
            if (!selectorIncluded(selector, fileExtensions, directoryExtension, paths)) {
                throw new PackProjectError(
                    'PACK_PROJECT_REQUIRED_FILE_IGNORED',
                    'Every declared semantic selector must resolve to at least one shipped file',
                );
            }
        }
    }
}

function safeOutputName(alias: string, version: string): string {
    const name = `${alias.slice(1).replace('/', '-')}-${version}.erdenpkg`;
    let portable = false;
    try {
        portable = Buffer.byteLength(name) <= 240 && normalizePackagePath(name) === name;
    } catch {
        /* invalid */
    }
    if (!portable) {
        throw new PackProjectError(
            'PACK_PROJECT_INVALID_INPUT',
            'The default package filename is not portable; supply --output',
        );
    }
    return name;
}

function outputPathFor(options: ReturnType<typeof snapshotOptions>, project: LoadedManifestV1): string {
    const output =
        options.outputPath === undefined
            ? join(dirname(project.projectRoot), safeOutputName(project.manifest.alias, options.version))
            : options.outputPath;
    const outputName = basename(output);
    let portable = false;
    try {
        portable = normalizePackagePath(outputName) === outputName;
    } catch {
        /* invalid */
    }
    if (!isAbsolute(output) || !output.endsWith('.erdenpkg') || !portable) {
        throw new PackProjectError(
            'PACK_PROJECT_INVALID_INPUT',
            'The package output must be one absolute portable .erdenpkg path',
        );
    }
    const outside = relative(project.projectRoot, resolve(output));
    if (outside === '' || (!outside.startsWith(`..${sep}`) && outside !== '..' && !isAbsolute(outside))) {
        throw new PackProjectError(
            'PACK_PROJECT_INVALID_INPUT',
            'The package output must be strictly outside the project root',
        );
    }
    return resolve(output);
}

async function readExisting(
    operations: PackNodeOperations,
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<boolean> {
    try {
        const captured = await readFile(operations, path, bytes.byteLength, signal);
        const stats = await operations.lstat(path, { bigint: true });
        if (
            !sameIdentity(captured.identity, identity(stats)) ||
            stats.nlink !== 1n ||
            (operations.enforcePosixModes && (stats.mode & 4095n) !== 420n)
        ) {
            return false;
        }
        return captured.bytes.byteLength === bytes.byteLength && sha(captured.bytes) === sha(bytes);
    } catch (cause) {
        if (
            errorCode(cause) === 'ENOENT' ||
            (isPackProjectError(cause) && cause.code === 'PACK_PROJECT_SOURCE_INVALID')
        ) {
            return false;
        }
        throw cause;
    }
}

async function recheckOutputParent(
    operations: PackNodeOperations,
    snapshot: RootSnapshot,
    mutationAttempted: boolean,
): Promise<void> {
    try {
        await recheckRoot(operations, snapshot);
    } catch (cause) {
        throw new PackProjectError(
            mutationAttempted ? 'PACK_PROJECT_ROLLBACK_UNSAFE' : 'PACK_PROJECT_TRANSACTION_FAILED',
            mutationAttempted
                ? 'The package output parent changed after transaction mutation; inert evidence was retained'
                : 'The package output parent changed before publication',
            cause,
        );
    }
}

async function assertOutputSibling(
    operations: PackNodeOperations,
    parent: RootSnapshot,
    expected: string,
    allowExact: boolean,
    mutationAttempted: boolean,
): Promise<void> {
    await recheckOutputParent(operations, parent, mutationAttempted);
    await assertSibling(operations, parent.path, expected, allowExact);
    await recheckOutputParent(operations, parent, mutationAttempted);
}

async function ownedPublishedOutput(
    operations: PackNodeOperations,
    parent: RootSnapshot,
    path: string,
    bytes: Uint8Array,
    created: Identity | undefined,
): Promise<boolean> {
    if (created === undefined) {
        return false;
    }
    try {
        await recheckOutputParent(operations, parent, true);
        const captured = await readFile(operations, path, bytes.byteLength, new AbortController().signal, false);
        const stats = await operations.lstat(path, { bigint: true });
        const matches =
            sameIdentity(captured.identity, identity(stats)) &&
            stats.dev === created.dev &&
            stats.ino === created.ino &&
            stats.nlink >= 1n &&
            stats.nlink <= 2n &&
            (!operations.enforcePosixModes || (stats.mode & 4095n) === 420n) &&
            captured.bytes.byteLength === bytes.byteLength &&
            sha(captured.bytes) === sha(bytes);
        await recheckOutputParent(operations, parent, true);
        return matches;
    } catch {
        return false;
    }
}

async function cleanupOwnedStage(
    operations: PackNodeOperations,
    parent: RootSnapshot,
    stage: string,
    stageName: string,
    created: Identity | undefined,
    expectedPrefix: Uint8Array,
): Promise<boolean> {
    try {
        await assertOutputSibling(operations, parent, stageName, true, true);
        const stats = await operations.lstat(stage, { bigint: true });
        if (
            created === undefined ||
            stats.dev !== created.dev ||
            stats.ino !== created.ino ||
            !stats.isFile() ||
            stats.isSymbolicLink()
        ) {
            return false;
        }
        const captured = await readFile(
            operations,
            stage,
            expectedPrefix.byteLength,
            new AbortController().signal,
            false,
        );
        if (captured.bytes.byteLength !== expectedPrefix.byteLength || sha(captured.bytes) !== sha(expectedPrefix)) {
            return false;
        }
        const final = await operations.lstat(stage, { bigint: true });
        if (
            !sameIdentity(captured.identity, identity(final)) ||
            final.dev !== created.dev ||
            final.ino !== created.ino ||
            final.size !== BigInt(expectedPrefix.byteLength)
        ) {
            return false;
        }
        await assertOutputSibling(operations, parent, stageName, true, true);
        const immediatelyBeforeUnlink = await readFile(
            operations,
            stage,
            expectedPrefix.byteLength,
            new AbortController().signal,
            false,
        );
        if (sha(immediatelyBeforeUnlink.bytes) !== sha(expectedPrefix)) {
            return false;
        }
        const preUnlinkStats = await operations.lstat(stage, { bigint: true });
        if (
            !sameIdentity(immediatelyBeforeUnlink.identity, identity(preUnlinkStats)) ||
            preUnlinkStats.dev !== created.dev ||
            preUnlinkStats.ino !== created.ino
        ) {
            return false;
        }
        try {
            await operations.unlink(stage);
        } catch (cause) {
            await recheckOutputParent(operations, parent, true);
            try {
                await operations.lstat(stage, { bigint: true });
                return false;
            } catch (probe) {
                if (errorCode(probe) !== 'ENOENT') {
                    throw cause;
                }
            }
        }
        await recheckOutputParent(operations, parent, true);
        await assertOutputSibling(operations, parent, stageName, false, true);
        return true;
    } catch {
        return false;
    }
}

async function authenticatePublishedResidue(
    operations: PackNodeOperations,
    parent: RootSnapshot,
    path: string,
    name: string,
    stage: string,
    stageName: string,
    bytes: Uint8Array,
    created: Identity | undefined,
): Promise<boolean> {
    if (created === undefined) {
        return false;
    }
    try {
        await assertOutputSibling(operations, parent, name, true, true);
        await assertOutputSibling(operations, parent, stageName, true, true);
        const outputStats = await operations.lstat(path, { bigint: true });
        const stageStats = await operations.lstat(stage, { bigint: true });
        if (
            !outputStats.isFile() ||
            outputStats.isSymbolicLink() ||
            !stageStats.isFile() ||
            stageStats.isSymbolicLink() ||
            outputStats.dev !== created.dev ||
            outputStats.ino !== created.ino ||
            stageStats.dev !== created.dev ||
            stageStats.ino !== created.ino ||
            outputStats.nlink !== 2n ||
            stageStats.nlink !== 2n ||
            outputStats.size !== BigInt(bytes.byteLength) ||
            stageStats.size !== BigInt(bytes.byteLength) ||
            (operations.enforcePosixModes &&
                ((outputStats.mode & 4095n) !== 420n || (stageStats.mode & 4095n) !== 420n))
        ) {
            return false;
        }
        const outputBytes = await readFile(operations, path, bytes.byteLength, new AbortController().signal, false);
        const stageBytes = await readFile(operations, stage, bytes.byteLength, new AbortController().signal, false);
        if (sha(outputBytes.bytes) !== sha(bytes) || sha(stageBytes.bytes) !== sha(bytes)) {
            return false;
        }
        await assertOutputSibling(operations, parent, name, true, true);
        await assertOutputSibling(operations, parent, stageName, true, true);
        const finalOutput = await operations.lstat(path, { bigint: true });
        const finalStage = await operations.lstat(stage, { bigint: true });
        await recheckOutputParent(operations, parent, true);
        return (
            sameIdentity(outputBytes.identity, identity(finalOutput)) &&
            sameIdentity(stageBytes.identity, identity(finalStage)) &&
            finalOutput.dev === created.dev &&
            finalOutput.ino === created.ino &&
            finalOutput.nlink === 2n &&
            finalStage.dev === created.dev &&
            finalStage.ino === created.ino &&
            finalStage.nlink === 2n
        );
    } catch {
        return false;
    }
}

interface OutputPublication {
    readonly status: 'written' | 'hit';
    readonly cleanup: 'clean' | 'cleanup-residue-retained';
    readonly owned: Readonly<{
        readonly identity: Identity;
        readonly stage: string;
        readonly stageName: string;
    }> | null;
}

async function writeOutput(
    operations: PackNodeOperations,
    parent: RootSnapshot,
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<OutputPublication> {
    if (dirname(path) !== parent.path) {
        throw new PackProjectError('PACK_PROJECT_INVALID_INPUT', 'The package output parent snapshot is inconsistent');
    }
    const name = basename(path);
    await recheckOutputParent(operations, parent, false);
    const initialHit = await readExisting(operations, path, bytes, signal);
    await assertOutputSibling(operations, parent, name, initialHit, false);
    if (initialHit) {
        if (!(await readExisting(operations, path, bytes, signal))) {
            throw new PackProjectError(
                'PACK_PROJECT_OUTPUT_EXISTS',
                'The existing package output changed during authentication',
            );
        }
        await assertOutputSibling(operations, parent, name, true, false);
        if (!(await readExisting(operations, path, bytes, signal))) {
            throw new PackProjectError(
                'PACK_PROJECT_OUTPUT_EXISTS',
                'The existing package output changed during authentication',
            );
        }
        await recheckOutputParent(operations, parent, false);
        return Object.freeze({ status: 'hit', cleanup: 'clean', owned: null });
    }
    await recheckOutputParent(operations, parent, false);
    try {
        await operations.lstat(path, { bigint: true });
        throw new PackProjectError(
            'PACK_PROJECT_OUTPUT_EXISTS',
            'The package output already exists and is not the exact requested archive',
        );
    } catch (cause) {
        if (errorCode(cause) !== 'ENOENT') {
            throw cause;
        }
    }
    await recheckOutputParent(operations, parent, false);
    const token = operations.token();
    if (!tokenPattern.test(token)) {
        throw new PackProjectError('PACK_PROJECT_TRANSACTION_FAILED', 'The package transaction token is invalid');
    }
    const stageName = `.erden-pack-${sha(new TextEncoder().encode(name)).slice(0, 16)}-${token}`;
    const stage = join(parent.path, stageName);
    await assertOutputSibling(operations, parent, stageName, false, false);
    let handle: Awaited<ReturnType<PackNodeOperations['open']>> | undefined;
    let written = 0;
    let created: Identity | undefined;
    let mutationAttempted = false;
    let publicationAttempted = false;
    async function committed(cause?: unknown): Promise<OutputPublication> {
        const cleaned = await cleanupOwnedStage(operations, parent, stage, stageName, created, bytes);
        if (cleaned) {
            await assertOutputSibling(operations, parent, name, true, true);
            if (!(await readExisting(operations, path, bytes, new AbortController().signal))) {
                throw new PackProjectError(
                    'PACK_PROJECT_ROLLBACK_UNSAFE',
                    'The committed package could not be reauthenticated',
                    cause,
                );
            }
            await recheckOutputParent(operations, parent, true);
            if (created === undefined) {
                throw new PackProjectError(
                    'PACK_PROJECT_ROLLBACK_UNSAFE',
                    'The committed package ownership evidence is unavailable',
                    cause,
                );
            }
            return Object.freeze({
                status: 'written',
                cleanup: 'clean',
                owned: Object.freeze({ identity: created, stage, stageName }),
            });
        }
        if (await authenticatePublishedResidue(operations, parent, path, name, stage, stageName, bytes, created)) {
            if (created === undefined) {
                throw new PackProjectError(
                    'PACK_PROJECT_ROLLBACK_UNSAFE',
                    'The committed package ownership evidence is unavailable',
                    cause,
                );
            }
            return Object.freeze({
                status: 'written',
                cleanup: 'cleanup-residue-retained',
                owned: Object.freeze({ identity: created, stage, stageName }),
            });
        }
        throw new PackProjectError(
            'PACK_PROJECT_ROLLBACK_UNSAFE',
            'The committed package transaction residue could not be authenticated',
            cause,
        );
    }
    try {
        await recheckOutputParent(operations, parent, false);
        mutationAttempted = true;
        handle = await operations.open(stage, 'wx', 0o600);
        created = identity(await operations.stat(handle));
        await recheckOutputParent(operations, parent, true);
        await assertOutputSibling(operations, parent, stageName, true, true);
        await assertOutputSibling(operations, parent, name, false, true);
        while (written < bytes.byteLength) {
            signal.throwIfAborted();
            const result = await operations.write(handle, bytes, written, bytes.byteLength - written);
            if (result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - written) {
                throw new Error('short write');
            }
            written += result.bytesWritten;
        }
        await operations.sync(handle);
        await operations.close(handle);
        handle = undefined;
        await recheckOutputParent(operations, parent, true);
        await operations.chmod(stage, 0o644);
        await recheckOutputParent(operations, parent, true);
        if (!(await readExisting(operations, stage, bytes, signal))) {
            throw new Error('stage verification');
        }
        await assertOutputSibling(operations, parent, stageName, true, true);
        await assertOutputSibling(operations, parent, name, false, true);
        signal.throwIfAborted();
        publicationAttempted = true;
        try {
            await operations.link(stage, path);
        } catch (cause) {
            await recheckOutputParent(operations, parent, true);
            if (await ownedPublishedOutput(operations, parent, path, bytes, created)) {
                return await committed(cause);
            }
            if (errorCode(cause) === 'EEXIST') {
                throw new PackProjectError(
                    'PACK_PROJECT_OUTPUT_EXISTS',
                    'The package output appeared before publication',
                    cause,
                );
            }
            throw cause;
        }
        await recheckOutputParent(operations, parent, true);
        if (!(await ownedPublishedOutput(operations, parent, path, bytes, created))) {
            throw new Error('published verification');
        }
        await assertOutputSibling(operations, parent, stageName, true, true);
        await assertOutputSibling(operations, parent, name, true, true);
        return await committed();
    } catch (cause) {
        if (handle !== undefined) {
            await operations.close(handle).catch(() => undefined);
        }
        if (created === undefined && mutationAttempted) {
            let cleanAbsence = false;
            try {
                await recheckOutputParent(operations, parent, true);
                await assertSibling(operations, parent.path, stageName, false);
                await recheckOutputParent(operations, parent, true);
                cleanAbsence = true;
            } catch {
                /* an absent owned identity cannot authorize cleanup or adoption */
            }
            if (cleanAbsence) {
                throw cause;
            }
            throw new PackProjectError(
                'PACK_PROJECT_ROLLBACK_UNSAFE',
                'The package transaction retained inert evidence because stage creation could not be disproven',
                cause,
            );
        }
        await recheckOutputParent(operations, parent, mutationAttempted);
        if (publicationAttempted && (await ownedPublishedOutput(operations, parent, path, bytes, created))) {
            return await committed(cause);
        }
        const unsafe =
            mutationAttempted &&
            !(await cleanupOwnedStage(operations, parent, stage, stageName, created, bytes.subarray(0, written)));
        if (unsafe) {
            throw new PackProjectError(
                'PACK_PROJECT_ROLLBACK_UNSAFE',
                'The package transaction retained inert evidence because cleanup could not be authenticated',
                cause,
            );
        }
        throw cause;
    }
}

async function rollbackPublishedOutput(
    operations: PackNodeOperations,
    parent: RootSnapshot,
    path: string,
    bytes: Uint8Array,
    publication: OutputPublication,
): Promise<boolean> {
    const owned = publication.owned;
    if (publication.status !== 'written' || owned === null) {
        return publication.status === 'hit';
    }
    try {
        await recheckOutputParent(operations, parent, true);
        if (
            publication.cleanup === 'cleanup-residue-retained' &&
            !(await cleanupOwnedStage(operations, parent, owned.stage, owned.stageName, owned.identity, bytes))
        ) {
            return false;
        }
        await assertOutputSibling(operations, parent, basename(path), true, true);
        if (!(await ownedPublishedOutput(operations, parent, path, bytes, owned.identity))) {
            return false;
        }
        const before = await readFile(operations, path, bytes.byteLength, new AbortController().signal, false);
        const stats = await operations.lstat(path, { bigint: true });
        if (
            !sameIdentity(before.identity, identity(stats)) ||
            stats.dev !== owned.identity.dev ||
            stats.ino !== owned.identity.ino ||
            sha(before.bytes) !== sha(bytes)
        ) {
            return false;
        }
        try {
            await operations.unlink(path);
        } catch (cause) {
            await recheckOutputParent(operations, parent, true);
            try {
                await operations.lstat(path, { bigint: true });
                return false;
            } catch (probe) {
                if (errorCode(probe) !== 'ENOENT') {
                    throw cause;
                }
            }
        }
        await assertOutputSibling(operations, parent, basename(path), false, true);
        await recheckOutputParent(operations, parent, true);
        return true;
    } catch {
        return false;
    }
}

async function packPromise(
    input: PackProjectOptions,
    projectState: Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck'>,
    currentToolchain: CurrentToolchainShape,
    codec: PackProjectCodecShape,
    fileSystem: PackFileSystemPort,
    signal: AbortSignal,
): Promise<PackProjectReport> {
    const options = snapshotOptions(input);
    let toolchain;
    try {
        toolchain = decodeLockToolchain(await Effect.runPromise(currentToolchain.inspect()));
    } catch (cause) {
        throw new PackProjectError(
            'PACK_PROJECT_TOOLCHAIN_UNAVAILABLE',
            'The current validator and reasoner identity is unavailable',
            cause,
        );
    }
    let state;
    try {
        state = await Effect.runPromise(
            projectState.inspect({
                ...(options.from === undefined ? {} : { from: options.from }),
                ...(options.manifestPath === undefined ? {} : { explicitPath: options.manifestPath }),
                toolchain,
            }),
        );
    } catch (cause) {
        throw projectStateFailure(cause);
    }
    let publication: OutputPublication | undefined;
    let publishedOutputRoot: RootSnapshot | undefined;
    let publishedOutputPath: string | undefined;
    let publishedBytes: Uint8Array | undefined;
    try {
        const location = snapshotLocation({
            filePath: state.project.filePath,
            projectRoot: state.project.projectRoot,
            format: state.project.format,
        });
        if (!(MANIFEST_FILENAMES as ReadonlyArray<string>).includes(basename(location.filePath))) {
            throw new PackProjectError(
                'PACK_PROJECT_MANIFEST_UNAVAILABLE',
                'Pack requires one recognized root Erden manifest filename',
            );
        }
        let root: RootSnapshot;
        try {
            root = await snapshotRoot(fileSystem.operations, location.projectRoot);
        } catch (cause) {
            if (isPackProjectError(cause)) {
                throw cause;
            }
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The project root is unavailable or unsafe',
                cause,
            );
        }
        const first = await captureProjectTree(fileSystem.operations, root.path, signal);
        const manifestFile = first.files.find(({ path }) => path === basename(location.filePath));
        if (manifestFile === undefined) {
            throw new PackProjectError(
                'PACK_PROJECT_REQUIRED_FILE_IGNORED',
                'The selected root manifest must be shipped',
            );
        }
        if (sha(manifestFile.bytes) !== sha(state.manifestBytes)) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The shipped manifest changed after dependency-state authentication',
            );
        }
        const parsedProject = snapshotParsedProject(state.project, location, root.path);
        let project: LoadedManifestV1;
        try {
            const manifest = normalizePublicationManifestV1(parsedProject.manifest);
            project = Object.freeze({ ...parsedProject, manifest });
        } catch (cause) {
            throw new PackProjectError(
                'PACK_PROJECT_MANIFEST_NOT_PORTABLE',
                'A publishable package requires package-contained source selectors and citation roots',
                cause,
            );
        }
        const inspection = snapshotAvailableLock(state.lockInspection, project, toolchain);
        const lockFile = first.files.find(({ path }) => path === 'erden.lock');
        if (lockFile === undefined || sha(lockFile.bytes) !== sha(inspection.canonicalBytes)) {
            throw new PackProjectError(
                'PACK_PROJECT_LOCK_INVALID',
                'The shipped erden.lock does not match its authenticated canonical bytes',
            );
        }
        assertRequired(project, first);
        const direct = dependencies(inspection.lock);
        const second = await captureProjectTree(fileSystem.operations, root.path, signal);
        if (!sameTree(first, second)) {
            throw new PackProjectError('PACK_PROJECT_SOURCE_INVALID', 'The project changed while it was being packed');
        }
        await recheckRoot(fileSystem.operations, root);
        signal.throwIfAborted();
        let archiveBytes: Uint8Array;
        try {
            const encoded = await Effect.runPromise(
                codec.encode({
                    canonicalIri: project.manifest.canonicalIri,
                    version: options.version,
                    dependencies: direct,
                    validator: toolchain.validator,
                    reasoner: toolchain.reasoner,
                    files: Object.freeze(
                        second.files.map(({ path, bytes, executable }) =>
                            Object.freeze({
                                path,
                                bytes: Uint8Array.from(bytes),
                                executable,
                            }),
                        ),
                    ),
                }),
            );
            archiveBytes = copyBoundedBytes(encoded.archiveBytes, PACKAGE_CODEC_LIMITS.maxCompressedBytes);
        } catch (cause) {
            throw new PackProjectError(
                'PACK_PROJECT_CODEC_FAILURE',
                'The package codec could not encode the authenticated project snapshot',
                cause,
            );
        }
        let validated;
        try {
            validated = await Effect.runPromise(validatePackageArchive(archiveBytes));
        } catch (cause) {
            throw new PackProjectError(
                'PACK_PROJECT_CODEC_FAILURE',
                'The produced archive did not pass exact codec validation',
                cause,
            );
        }
        if (
            !digestPattern.test(validated.archiveSha256) ||
            sha(archiveBytes) !== validated.archiveSha256 ||
            validated.compressedBytes !== archiveBytes.byteLength ||
            !manifestMatchesSnapshot(validated.manifest, project, options.version, toolchain, direct, second)
        ) {
            throw new PackProjectError(
                'PACK_PROJECT_CODEC_FAILURE',
                'The package codec returned an inconsistent archive result',
            );
        }
        const outputPath = outputPathFor(options, project);
        let outputRoot: RootSnapshot;
        try {
            outputRoot = await snapshotRoot(fileSystem.operations, dirname(outputPath));
        } catch (cause) {
            throw new PackProjectError(
                'PACK_PROJECT_INVALID_INPUT',
                'The package output parent is unavailable or unsafe',
                cause,
            );
        }
        const finalSource = await captureProjectTree(fileSystem.operations, root.path, signal);
        if (!sameTree(second, finalSource)) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The project changed while the archive was being encoded',
            );
        }
        await recheckRoot(fileSystem.operations, outputRoot);
        await recheckRoot(fileSystem.operations, root);
        signal.throwIfAborted();
        try {
            await Effect.runPromise(projectState.recheck({ revision: state.revision }));
        } catch (cause) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The project dependency state changed before package publication',
                cause,
            );
        }
        publication = await writeOutput(fileSystem.operations, outputRoot, outputPath, archiveBytes, signal);
        publishedOutputRoot = outputRoot;
        publishedOutputPath = outputPath;
        publishedBytes = archiveBytes;
        await recheckRoot(fileSystem.operations, outputRoot);
        try {
            await Effect.runPromise(projectState.recheck({ revision: state.revision }));
        } catch (cause) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The project dependency state changed during package publication',
                cause,
            );
        }
        return decodePackProjectReport({
            schema: PACK_REPORT_VERSION,
            project: { alias: project.manifest.alias, canonicalIri: project.manifest.canonicalIri },
            version: options.version,
            output: { path: outputPath, status: publication.status, cleanup: publication.cleanup },
            archive: {
                byteSize: archiveBytes.byteLength,
                sha256: validated.archiveSha256,
                manifestSha256: validated.manifestSha256,
                fileCount: validated.manifest.files.length,
                directDependencyCount: direct.length,
            },
            outcome: 'packed',
        });
    } catch (cause) {
        let recheckFailure: unknown;
        try {
            await Effect.runPromise(projectState.recheck({ revision: state.revision }));
        } catch (failure) {
            recheckFailure = failure;
        }
        if (
            recheckFailure !== undefined &&
            publication?.status === 'written' &&
            publishedOutputRoot !== undefined &&
            publishedOutputPath !== undefined &&
            publishedBytes !== undefined
        ) {
            if (
                !(await rollbackPublishedOutput(
                    fileSystem.operations,
                    publishedOutputRoot,
                    publishedOutputPath,
                    publishedBytes,
                    publication,
                ))
            ) {
                throw new PackProjectError(
                    'PACK_PROJECT_ROLLBACK_UNSAFE',
                    'The published package could not be removed after project dependency state changed',
                    recheckFailure,
                );
            }
        }
        if (recheckFailure !== undefined) {
            throw new PackProjectError(
                'PACK_PROJECT_SOURCE_INVALID',
                'The project dependency state changed while packaging',
                recheckFailure,
            );
        }
        throw cause;
    }
}

export interface PackProjectServiceShape {
    readonly pack: (input: PackProjectOptions) => Effect.Effect<PackProjectReport, PackProjectError>;
}
export const PackProjectService = Context.Service<PackProjectServiceShape>('@erden/project/PackProjectService');

export function makePackProjectService(
    projectState: Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck'>,
    currentToolchain: CurrentToolchainShape,
    codec: PackProjectCodecShape,
    fileSystem: PackFileSystemPort,
): PackProjectServiceShape {
    return Object.freeze({
        pack: (input: PackProjectOptions) =>
            Effect.acquireUseRelease(
                Effect.sync(() => {
                    const controller = new AbortController();
                    const promise = packPromise(
                        input,
                        projectState,
                        currentToolchain,
                        codec,
                        fileSystem,
                        controller.signal,
                    ).catch((cause: unknown) => {
                        throw packError(cause);
                    });
                    return Object.freeze({ controller, promise });
                }),
                ({ promise }) => Effect.tryPromise({ try: () => promise, catch: packError }),
                ({ controller, promise }) =>
                    Effect.promise(async () => {
                        controller.abort();
                        await promise.catch(() => undefined);
                    }),
            ),
    });
}

export const nodePackProjectService = makePackProjectService(
    nodeProjectDependencyStateService,
    nodeCurrentToolchainService,
    // Deliberately resolved here to keep the operation injectable while node composition stays local-only.
    packageCodec,
    makeNodePackFileSystemPort(),
);

export function packProject(
    input: PackProjectOptions,
): Effect.Effect<PackProjectReport, PackProjectError, Context.Service.Identifier<typeof PackProjectService>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(PackProjectService)).pack(input);
    });
}

export function definePackProjectOperation(
    input: PackProjectOptions,
): ApplicationOperation<
    'PackProject',
    PackProjectReport,
    PackProjectError,
    Context.Service.Identifier<typeof PackProjectService>
> {
    return Object.freeze({ name: 'PackProject', effect: packProject(input) });
}
