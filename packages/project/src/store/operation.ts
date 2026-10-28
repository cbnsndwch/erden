import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { Context, Effect } from 'effect';

import {
    decodeLockfileValue,
    decodeLockToolchain,
    type LockfileV1,
    type LockPackageNode,
    type LockToolchain,
    compareCodePoints,
} from '@erden/contracts';
import {
    decodeCanonicalPackageManifest,
    encodeCanonicalPackageManifest,
    extractPackageArchive,
    GENERATED_MANIFEST_PATH,
    normalizePackagePath,
    PACKAGE_CODEC_LIMITS,
    validatePackageArchive,
    type PackageArchiveSource,
    type PackageManifestV1,
    type ValidatedPackageArchive,
} from '@erden/package-format';

import type { ApplicationOperation } from '../index.js';

import { isLocalPackageStoreError, LocalPackageStoreError } from './errors.js';
import { makeNodeStoreFileSystemPort, type StoreFileSystemPort, type StoreNodeOperations } from './filesystem.js';
import {
    buildInstallMarker,
    buildStoreObjectMarker,
    decodeInstallMarker,
    decodeStoreAdminMarker,
    decodeStoreProjectReferenceMarker,
    decodeStoreObjectMarker,
    encodeInstallMarker,
    encodeStoreAdminMarker,
    encodeStoreProjectReferenceMarker,
    encodeStoreObjectMarker,
    buildStoreProjectReferenceMarker,
    lockSha256,
    registrationIdFor,
    STORE_MARKER_LIMITS,
    storeProjectReferenceGenerationSha256,
    type InstallMarker,
    type StoreAdminMarker,
    type StorePruneClosureEntry,
    type StorePruneDirectoryIdentity,
    type StorePruneFileIdentity,
    type StorePruneObjectPlanEntry,
    type StorePruneRegistrationPlanEntry,
    type StoreProjectReferenceMarker,
    type StoreMarkerFile,
    type StoreObjectMarker,
} from './marker.js';
import type {
    InspectInstallInput,
    InstalledClosureReaderShape,
    AuthenticatedInstalledFile,
    InspectPackageInput,
    InstallInspection,
    LockAvailability,
    MaterializeLockInput,
    MaterializeLockResult,
    PruneStoreInput,
    PruneStoreResult,
    PackageInspection,
    PathForLayerInput,
    PutPackageInput,
    PutPackageResult,
    RepairPackageResult,
    RefreshProjectReferenceInput,
    RefreshProjectReferenceResult,
    ReadInstalledLayerFileInput,
    ResolvedInstalledClosure,
    ResolvedLayerPath,
    InspectStoreIndexInput,
    StoreIndexInspection,
    StoreObjectIndexEntry,
    StoreProjectReferenceGeneration,
    VerifyLockAvailabilityInput,
} from './model.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[0-9A-Za-z_-]{16,128}$/u;
const STORE_MARKER = 'object.json';
const ARCHIVE_FILE = 'archive.erdenpkg';
const PACKAGE_DIRECTORY = 'package';
const INSTALL_MARKER = 'install.json';
const LAYERS_DIRECTORY = 'layers';
const REGISTRATIONS_DIRECTORY = 'registrations';
const STORE_ADMIN_MARKER = '.erden.store-admin.transaction.json';
const REGISTRATION_FINAL = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/u;
const REGISTRATION_STAGE = /^\.([0-9a-f]{64})\.([0-9a-f]{64})\.stage-([0-9A-Za-z_-]{16,128})\.json$/u;
const REGISTRATION_PRUNE = /^\.([0-9a-f]{64})\.([0-9a-f]{64})\.prune-([0-9A-Za-z_-]{16,128})\.json$/u;
const ADMIN_STAGE = /^\.erden\.store-admin\.stage-([0-9A-Za-z_-]{16,128})\.json$/u;
const OBJECT_TRANSACTION = /^\.([0-9a-f]{64})\.(stage|backup|prune)-([0-9A-Za-z_-]{16,128})$/u;

export const LOCAL_PACKAGE_STORE_LIMITS = Object.freeze({
    maxInstallEntries: 250_000,
    maxDirectoryEntries: 100_000,
    maxTraversalNameBytes: 64 * 1024 * 1024,
    maxRegistrations: 16_384,
    maxStoreObjects: 100_000,
});

interface FileIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly kind: 'directory' | 'file';
}

interface DirectoryRootSnapshot {
    readonly target: FileIdentity;
    readonly chain: ReadonlyArray<{ readonly path: string; readonly identity: FileIdentity }>;
}

interface VerifiedObject {
    readonly marker: StoreObjectMarker;
    readonly root: string;
    readonly identity: FileIdentity;
    readonly closure: ReadonlyMap<string, { readonly path: string; readonly identity: FileIdentity }>;
}

interface VerifiedPackageTree {
    readonly root: FileIdentity;
    readonly closure: ReadonlyMap<string, { readonly path: string; readonly identity: FileIdentity }>;
}

interface VerifiedInstall {
    readonly marker: InstallMarker;
    readonly root: FileIdentity;
    readonly closure: ReadonlyMap<string, { readonly path: string; readonly identity: FileIdentity }>;
    readonly objectMarkers: ReadonlyMap<string, StoreObjectMarker>;
}

interface InstalledClosureCapability {
    readonly projectRoot: string;
    readonly projectSnapshot: DirectoryRootSnapshot;
    readonly installRoot: string;
    readonly verified: VerifiedInstall;
    readonly layerDirectories: ReadonlyMap<string, string>;
}

interface OwnedTree {
    readonly root: FileIdentity;
    readonly entries: Map<string, FileIdentity>;
}

function deepFreeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function fromAbortableStorePromise<A>(
    operation: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, LocalPackageStoreError> {
    return Effect.acquireUseRelease(
        Effect.sync(() => {
            const controller = new AbortController();
            const promise = operation(controller.signal);
            return Object.freeze({ controller, promise });
        }),
        ({ promise }) => Effect.tryPromise({ try: () => promise, catch: storeError }),
        ({ controller, promise }) =>
            Effect.promise(async () => {
                controller.abort();
                await promise.catch(() => undefined);
            }),
    );
}

function storeError(error: unknown): LocalPackageStoreError {
    return isLocalPackageStoreError(error)
        ? error
        : new LocalPackageStoreError('STORE_IO_FAILURE', 'The local package store operation could not complete', error);
}

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

function assertAbsoluteRoot(value: string, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || value.includes('\0')) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', `${label} must be one absolute filesystem root`);
    }
    return resolve(value);
}

function identity(stats: BigIntStats): FileIdentity {
    const common = {
        dev: stats.dev,
        ino: stats.ino,
        mode: stats.mode,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
    };
    if (stats.isDirectory()) {
        return Object.freeze({ ...common, kind: 'directory' });
    }
    if (stats.isFile()) {
        return Object.freeze({ ...common, kind: 'file' });
    }
    throw new LocalPackageStoreError('STORE_REPAIR_REQUIRED', 'A store entry is not a regular file or directory');
}

function sameIdentity(left: FileIdentity, stats: BigIntStats): boolean {
    return (
        left.dev === stats.dev &&
        left.ino === stats.ino &&
        left.kind === (stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other')
    );
}

function sameSnapshot(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs &&
        left.kind === right.kind
    );
}

function physicalMode(stats: BigIntStats): number {
    return Number(stats.mode & 4095n);
}

function modeMatches(operations: StoreNodeOperations, stats: BigIntStats, expected: number): boolean {
    return !operations.enforcePosixModes || physicalMode(stats) === expected;
}

async function lstatOrNull(operations: StoreNodeOperations, path: string): Promise<BigIntStats | null> {
    try {
        return await operations.lstat(path, { bigint: true });
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function portableNameKey(value: string): string {
    return value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

interface DirectoryBudget {
    entries: number;
    nameBytes: number;
}

async function readDirectoryBounded(
    operations: StoreNodeOperations,
    path: string,
    budget: DirectoryBudget = {
        entries: LOCAL_PACKAGE_STORE_LIMITS.maxDirectoryEntries,
        nameBytes: LOCAL_PACKAGE_STORE_LIMITS.maxTraversalNameBytes,
    },
): Promise<string[]> {
    const directory = await operations.opendir(path);
    const names: string[] = [];
    try {
        for await (const entry of directory) {
            if (budget.entries <= 0) {
                throw new Error('directory entry bound');
            }
            const bytes = Buffer.byteLength(entry.name, 'utf8');
            if (bytes <= 0 || bytes > budget.nameBytes) {
                throw new Error('directory name byte bound');
            }
            budget.entries -= 1;
            budget.nameBytes -= bytes;
            names.push(entry.name);
        }
    } finally {
        await directory.close().catch(() => undefined);
    }
    return names;
}

async function assertNoPortableSibling(
    operations: StoreNodeOperations,
    parent: string,
    name: string,
    allowExact: boolean,
    code:
        | 'STORE_ROOT_UNAVAILABLE'
        | 'STORE_REPAIR_REQUIRED'
        | 'STORE_REFERENCE_INVALID'
        | 'STORE_ROLLBACK_UNSAFE'
        | 'INSTALL_REPAIR_REQUIRED' = 'STORE_ROOT_UNAVAILABLE',
): Promise<void> {
    const entries = await readDirectoryBounded(operations, parent);
    const wanted = portableNameKey(name);
    let exactFound = false;
    for (const entry of entries) {
        if (portableNameKey(entry) !== wanted) {
            continue;
        }
        if (allowExact && entry === name) {
            exactFound = true;
            continue;
        }
        throw new LocalPackageStoreError(code, 'A portable filesystem-name collision blocks the store operation');
    }
    if (allowExact && !exactFound) {
        throw new LocalPackageStoreError(code, 'The canonical filesystem entry disappeared during the store operation');
    }
}

async function assertNoSymlinkAncestors(operations: StoreNodeOperations, target: string): Promise<void> {
    const absolute = resolve(target);
    const root = parse(absolute).root;
    const parts = absolute
        .slice(root.length)
        .split(sep)
        .filter((part) => part.length > 0);
    let current = root;
    for (const part of parts) {
        current = join(current, part);
        const stats = await lstatOrNull(operations, current);
        if (stats === null) {
            break;
        }
        if (stats.isSymbolicLink()) {
            throw new LocalPackageStoreError(
                'STORE_ROOT_UNAVAILABLE',
                'A symbolic or reparse-point ancestor blocks the store operation',
            );
        }
    }
}

async function ensureDirectory(operations: StoreNodeOperations, path: string, mode: number): Promise<FileIdentity> {
    await assertNoSymlinkAncestors(operations, dirname(path));
    const before = await lstatOrNull(operations, path);
    if (before === null) {
        await operations.mkdir(path, { recursive: true, mode });
        await operations.chmod(path, mode);
    }
    const stats = await operations.lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink() || !modeMatches(operations, stats, mode)) {
        throw new LocalPackageStoreError(
            'STORE_ROOT_UNAVAILABLE',
            'A local package store directory is not private and regular',
        );
    }
    return identity(stats);
}

async function reserveTransactionDirectory(
    operations: StoreNodeOperations,
    path: string,
    code: 'STORE_ROLLBACK_UNSAFE' | 'INSTALL_ROLLBACK_UNSAFE',
    message: string,
): Promise<FileIdentity> {
    try {
        await operations.mkdir(path, { mode: 0o700 });
    } catch (error) {
        let present: BigIntStats | null;
        try {
            present = await lstatOrNull(operations, path);
        } catch {
            throw new LocalPackageStoreError(code, message, error);
        }
        if (present !== null) {
            throw new LocalPackageStoreError(code, message, error);
        }
        throw error;
    }
    try {
        const stats = await operations.lstat(path, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('reservation type');
        }
        return identity(stats);
    } catch (error) {
        throw new LocalPackageStoreError(code, message, error);
    }
}

async function snapshotDirectoryRoot(
    operations: StoreNodeOperations,
    path: string,
    code: 'STORE_ROOT_UNAVAILABLE' | 'INSTALL_REPAIR_REQUIRED' = 'STORE_ROOT_UNAVAILABLE',
    expectedMode?: number,
): Promise<DirectoryRootSnapshot> {
    await assertNoSymlinkAncestors(operations, path);
    const stats = await operations.lstat(path, { bigint: true });
    if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (expectedMode !== undefined && !modeMatches(operations, stats, expectedMode))
    ) {
        throw new LocalPackageStoreError(code, 'An operation root is not one regular directory');
    }
    const absolute = resolve(path);
    const root = parse(absolute).root;
    const parts = absolute
        .slice(root.length)
        .split(sep)
        .filter((part) => part.length > 0);
    const chain: Array<{
        readonly path: string;
        readonly identity: FileIdentity;
    }> = [];
    let current = root;
    const rootStats = await operations.lstat(root, { bigint: true });
    chain.push(Object.freeze({ path: root, identity: identity(rootStats) }));
    for (const part of parts) {
        current = join(current, part);
        const ancestorStats = await operations.lstat(current, { bigint: true });
        if (!ancestorStats.isDirectory() || ancestorStats.isSymbolicLink()) {
            throw new LocalPackageStoreError(code, 'An operation root ancestor is not one regular directory');
        }
        chain.push(Object.freeze({ path: current, identity: identity(ancestorStats) }));
    }
    return deepFreeze({ target: identity(stats), chain });
}

async function recheckDirectoryRoot(
    operations: StoreNodeOperations,
    path: string,
    expected: DirectoryRootSnapshot,
): Promise<void> {
    for (const ancestor of expected.chain) {
        const stats = await operations.lstat(ancestor.path, { bigint: true });
        if (!sameIdentity(ancestor.identity, stats) || ancestor.identity.mode !== stats.mode) {
            throw new LocalPackageStoreError(
                'STORE_ROOT_UNAVAILABLE',
                'An operation root or ancestor changed during the transaction',
            );
        }
    }
    const target = await operations.lstat(path, { bigint: true });
    if (!sameIdentity(expected.target, target) || expected.target.mode !== target.mode) {
        throw new LocalPackageStoreError('STORE_ROOT_UNAVAILABLE', 'An operation root changed during the transaction');
    }
}

function safeJoin(root: string, logicalPath: string): string {
    const target = resolve(root, ...logicalPath.split('/'));
    const inside = relative(root, target);
    if (inside.length === 0 || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new LocalPackageStoreError(
            'STORE_REPAIR_REQUIRED',
            'A package marker path escapes its authenticated layer',
        );
    }
    return target;
}

async function readHandleBytes(
    operations: StoreNodeOperations,
    handle: FileHandle,
    expectedSize?: number,
    maximumSize = PACKAGE_CODEC_LIMITS.maxEntryBytes,
): Promise<{
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly stats: BigIntStats;
}> {
    const before = await operations.stat(handle);
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error('not file');
    }
    const size = Number(before.size);
    if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > maximumSize ||
        (expectedSize !== undefined && size !== expectedSize)
    ) {
        throw new Error('file size');
    }
    const bytes = new Uint8Array(size);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < size) {
        const { bytesRead } = await operations.read(handle, bytes, offset, Math.min(65536, size - offset), offset);
        if (bytesRead <= 0) {
            throw new Error('short read');
        }
        hash.update(bytes.subarray(offset, offset + bytesRead));
        offset += bytesRead;
    }
    const after = await operations.stat(handle);
    const captured = identity(before);
    if (!sameIdentity(captured, after) || before.size !== after.size || before.mode !== after.mode) {
        throw new Error('file changed');
    }
    return Object.freeze({ bytes, sha256: hash.digest('hex'), stats: after });
}

async function readFileVerified(
    operations: StoreNodeOperations,
    path: string,
    expectedSize?: number,
    maximumSize = PACKAGE_CODEC_LIMITS.maxEntryBytes,
    expectedIdentity?: FileIdentity,
): Promise<{
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly stats: BigIntStats;
}> {
    const pathBefore = await operations.lstat(path, { bigint: true });
    if (
        !pathBefore.isFile() ||
        pathBefore.isSymbolicLink() ||
        (expectedIdentity !== undefined && !sameIdentity(expectedIdentity, pathBefore)) ||
        pathBefore.size > BigInt(maximumSize)
    ) {
        throw new Error('file path identity or size');
    }
    const handle = await operations.open(path, 'r');
    try {
        const opened = await operations.stat(handle);
        if (!sameIdentity(identity(pathBefore), opened)) {
            throw new Error('opened a different file');
        }
        const read = await readHandleBytes(operations, handle, expectedSize, maximumSize);
        const pathAfter = await operations.lstat(path, { bigint: true });
        if (!sameIdentity(identity(pathBefore), pathAfter) || !sameIdentity(identity(opened), pathAfter)) {
            throw new Error('file path changed');
        }
        return read;
    } finally {
        await operations.close(handle).catch(() => undefined);
    }
}

async function writeAll(operations: StoreNodeOperations, handle: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesWritten } = await operations.write(handle, bytes, offset, bytes.length - offset);
        if (bytesWritten <= 0) {
            throw new Error('zero-progress write');
        }
        offset += bytesWritten;
    }
}

async function collectClosure(
    operations: StoreNodeOperations,
    root: string,
    maximumEntries = PACKAGE_CODEC_LIMITS.maxEntries + PACKAGE_CODEC_LIMITS.maxPathDepth + 8,
): Promise<
    ReadonlyMap<
        string,
        {
            readonly path: string;
            readonly identity: FileIdentity;
        }
    >
> {
    const found = new Map<
        string,
        {
            readonly path: string;
            readonly identity: FileIdentity;
        }
    >();
    const pending = [''];
    const budget: DirectoryBudget = {
        entries: Math.min(maximumEntries, LOCAL_PACKAGE_STORE_LIMITS.maxInstallEntries),
        nameBytes: LOCAL_PACKAGE_STORE_LIMITS.maxTraversalNameBytes,
    };
    while (pending.length > 0) {
        const logicalParent = pending.pop();
        if (logicalParent === undefined) {
            continue;
        }
        const physicalParent = logicalParent.length === 0 ? root : safeJoin(root, logicalParent);
        const names = (await readDirectoryBounded(operations, physicalParent, budget)).sort(compareCodePoints);
        const portable = new Set<string>();
        for (const name of names) {
            const key = portableNameKey(name);
            if (portable.has(key)) {
                throw new Error('portable closure collision');
            }
            portable.add(key);
            const logical = logicalParent.length === 0 ? name : `${logicalParent}/${name}`;
            if (logical.split('/').length > PACKAGE_CODEC_LIMITS.maxPathDepth + 4) {
                throw new Error('closure depth bound');
            }
            const physical = safeJoin(root, logical);
            const stats = await operations.lstat(physical, { bigint: true });
            if (stats.isSymbolicLink()) {
                throw new Error('symlink closure');
            }
            const captured = identity(stats);
            found.set(logical, Object.freeze({ path: physical, identity: captured }));
            if (found.size > maximumEntries) {
                throw new Error('closure entry bound');
            }
            if (captured.kind === 'directory') {
                pending.push(logical);
            }
        }
    }
    return found;
}

function sameClosure(
    left: ReadonlyMap<
        string,
        {
            readonly identity: FileIdentity;
        }
    >,
    right: ReadonlyMap<
        string,
        {
            readonly identity: FileIdentity;
        }
    >,
): boolean {
    return (
        left.size === right.size &&
        [...left].every(([path, entry]) => {
            const current = right.get(path);
            return current !== undefined && sameSnapshot(current.identity, entry.identity);
        })
    );
}

async function captureOwnedPath(
    operations: StoreNodeOperations,
    tree: OwnedTree,
    root: string,
    logicalPath: string,
): Promise<void> {
    const stats = await operations.lstat(safeJoin(root, logicalPath), { bigint: true });
    if (stats.isSymbolicLink()) {
        throw new Error('owned path became a link');
    }
    tree.entries.set(logicalPath, identity(stats));
}

async function captureOwnedSubtree(
    operations: StoreNodeOperations,
    tree: OwnedTree,
    root: string,
    logicalRoot: string,
): Promise<void> {
    await captureOwnedPath(operations, tree, root, logicalRoot);
    const subtree = await collectClosure(operations, safeJoin(root, logicalRoot));
    for (const [path, entry] of subtree) {
        tree.entries.set(`${logicalRoot}/${path}`, entry.identity);
    }
}

async function removeOwnedTree(
    operations: StoreNodeOperations,
    root: string,
    owned: OwnedTree,
    requireMutationSnapshot = false,
): Promise<boolean> {
    try {
        const rootStats = await operations.lstat(root, { bigint: true });
        if (!sameIdentity(owned.root, rootStats)) {
            return false;
        }
        const actual = await collectClosure(
            operations,
            root,
            Math.min(owned.entries.size + 1, LOCAL_PACKAGE_STORE_LIMITS.maxInstallEntries),
        );
        for (const [path, entry] of actual) {
            const expected = owned.entries.get(path);
            if (
                expected === undefined ||
                (requireMutationSnapshot
                    ? !sameSnapshot(expected, entry.identity)
                    : expected.kind !== entry.identity.kind ||
                      expected.dev !== entry.identity.dev ||
                      expected.ino !== entry.identity.ino)
            ) {
                return false;
            }
        }
        const directories = [...actual.entries()]
            .filter(([, entry]) => entry.identity.kind === 'directory')
            .sort(
                ([left], [right]) => left.split('/').length - right.split('/').length || compareCodePoints(left, right),
            );
        const rootBeforeMode = await operations.lstat(root, { bigint: true });
        if (!sameIdentity(owned.root, rootBeforeMode)) {
            return false;
        }
        await operations.chmod(root, 0o700);
        for (const [, entry] of directories) {
            const current = await operations.lstat(entry.path, { bigint: true });
            if (!sameIdentity(entry.identity, current)) {
                return false;
            }
            await operations.chmod(entry.path, 0o700);
        }
        const ordered = [...actual.entries()].sort(([leftPath, left], [rightPath, right]) => {
            if (left.identity.kind !== right.identity.kind) {
                return left.identity.kind === 'file' ? -1 : 1;
            }
            return rightPath.split('/').length - leftPath.split('/').length || compareCodePoints(rightPath, leftPath);
        });
        for (const [path, entry] of ordered) {
            const current = await operations.lstat(entry.path, { bigint: true });
            if (!sameIdentity(entry.identity, current)) {
                return false;
            }
            if (entry.identity.kind === 'file') {
                await operations.rm(entry.path, { force: false });
            } else {
                await operations.rmdir(entry.path);
            }
            owned.entries.delete(path);
        }
        const finalRoot = await operations.lstat(root, { bigint: true });
        if (!sameIdentity(owned.root, finalRoot) || (await readDirectoryBounded(operations, root)).length !== 0) {
            return false;
        }
        await operations.rmdir(root);
        return true;
    } catch {
        return false;
    }
}

function impliedDirectories(files: ReadonlyArray<StoreMarkerFile>): Set<string> {
    const directories = new Set<string>(['.erden']);
    for (const file of files) {
        const parts = file.path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
            directories.add(parts.slice(0, index).join('/'));
        }
    }
    return directories;
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function assertManifestIdentity(
    manifest: PackageManifestV1,
    expected: LockPackageNode,
    toolchain: LockToolchain,
): void {
    if (
        manifest.canonicalIri !== expected.canonicalIri ||
        manifest.version !== expected.version ||
        !sameJson(manifest.dependencies, expected.dependencies) ||
        !sameJson(manifest.toolchain, toolchain)
    ) {
        throw new LocalPackageStoreError(
            'STORE_PACKAGE_IDENTITY_MISMATCH',
            'The package archive does not match its locked identity and toolchain',
        );
    }
}

function snapshotExpectedPackageNode(input: LockPackageNode, toolchain: LockToolchain): LockPackageNode {
    try {
        const canonicalIri = input.canonicalIri;
        const version = input.version;
        const archiveSha256 = input.archiveSha256;
        const dependencies = input.dependencies;
        if (typeof archiveSha256 !== 'string' || !SHA256.test(archiveSha256)) {
            throw new Error('archive digest');
        }
        const manifest = decodeCanonicalPackageManifest(
            encodeCanonicalPackageManifest({
                formatVersion: 1,
                archiveRoot: 'package/',
                generatedManifestPath: GENERATED_MANIFEST_PATH,
                canonicalIri,
                version,
                dependencies,
                toolchain,
                files: [],
            }),
        );
        return deepFreeze({
            canonicalIri: manifest.canonicalIri,
            version: manifest.version,
            archiveSha256,
            dependencies: manifest.dependencies.map((edge) => ({ ...edge })),
        });
    } catch (error) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The expected locked package node is invalid', error);
    }
}

async function verifyPackageTree(
    operations: StoreNodeOperations,
    packageRoot: string,
    marker: StoreObjectMarker,
): Promise<VerifiedPackageTree> {
    const packageRootStats = await operations.lstat(packageRoot, { bigint: true });
    if (
        !packageRootStats.isDirectory() ||
        packageRootStats.isSymbolicLink() ||
        !modeMatches(operations, packageRootStats, 0o555)
    ) {
        throw new Error('package root');
    }
    const maximumClosure = marker.files.length + impliedDirectories(marker.files).size + 1;
    const closure = await collectClosure(operations, packageRoot, maximumClosure);
    const manifestPath = safeJoin(packageRoot, GENERATED_MANIFEST_PATH);
    const manifestEntry = closure.get(GENERATED_MANIFEST_PATH);
    if (manifestEntry?.identity.kind !== 'file') {
        throw new Error('manifest entry');
    }
    const manifestRead = await readFileVerified(
        operations,
        manifestPath,
        undefined,
        PACKAGE_CODEC_LIMITS.maxEntryBytes,
        manifestEntry.identity,
    );
    if (manifestRead.sha256 !== marker.manifestSha256 || !modeMatches(operations, manifestRead.stats, 0o444)) {
        throw new Error('manifest binding');
    }
    const manifest = decodeCanonicalPackageManifest(manifestRead.bytes);
    if (
        manifest.canonicalIri !== marker.canonicalIri ||
        manifest.version !== marker.version ||
        !sameJson(manifest.dependencies, marker.dependencies) ||
        !sameJson(manifest.toolchain, marker.toolchain) ||
        !sameJson(
            manifest.files.map((file) => ({
                path: file.path,
                byteSize: file.byteSize,
                sha256: file.sha256,
                logicalMode: file.executable ? 0o755 : 0o644,
            })),
            marker.files,
        )
    ) {
        throw new Error('package manifest truth');
    }
    const expectedFiles = new Set(marker.files.map(({ path }) => path));
    expectedFiles.add(GENERATED_MANIFEST_PATH);
    const expectedDirectories = impliedDirectories(marker.files);
    if (closure.size !== expectedFiles.size + expectedDirectories.size) {
        throw new Error('package closure size');
    }
    for (const directory of expectedDirectories) {
        const entry = closure.get(directory);
        if (entry?.identity.kind !== 'directory') {
            throw new Error('package directory');
        }
        const stats = await operations.lstat(entry.path, { bigint: true });
        if (!sameIdentity(entry.identity, stats) || !modeMatches(operations, stats, 0o555)) {
            throw new Error('package directory identity');
        }
    }
    for (const file of marker.files) {
        const entry = closure.get(file.path);
        if (entry?.identity.kind !== 'file') {
            throw new Error('package file');
        }
        const read = await readFileVerified(operations, entry.path, file.byteSize, file.byteSize, entry.identity);
        const expectedPhysical = file.logicalMode === 0o755 ? 0o555 : 0o444;
        if (read.sha256 !== file.sha256 || !modeMatches(operations, read.stats, expectedPhysical)) {
            throw new Error('package file binding');
        }
    }
    const finalClosure = await collectClosure(operations, packageRoot, maximumClosure);
    const packageRootAfter = await operations.lstat(packageRoot, { bigint: true });
    if (
        !sameClosure(closure, finalClosure) ||
        !sameIdentity(identity(packageRootStats), packageRootAfter) ||
        packageRootStats.mode !== packageRootAfter.mode
    ) {
        throw new Error('package closure changed');
    }
    return deepFreeze({ root: identity(packageRootAfter), closure: finalClosure });
}

function objectPath(storeRoot: string, digest: string): string {
    return join(storeRoot, 'objects', digest);
}

async function verifyObjectAt(
    operations: StoreNodeOperations,
    root: string,
    archiveSha256: string,
    expected?: LockPackageNode,
    toolchain?: LockToolchain,
): Promise<VerifiedObject> {
    const rootStats = await operations.lstat(root, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !modeMatches(operations, rootStats, 0o555)) {
        throw new Error('object root');
    }
    const rootNames = (await readDirectoryBounded(operations, root, { entries: 4, nameBytes: 1024 })).sort(
        compareCodePoints,
    );
    if (!sameJson(rootNames, [ARCHIVE_FILE, STORE_MARKER, PACKAGE_DIRECTORY].sort(compareCodePoints))) {
        throw new Error('object closure');
    }
    const markerPath = join(root, STORE_MARKER);
    const markerIdentity = identity(await operations.lstat(markerPath, { bigint: true }));
    const markerRead = await readFileVerified(operations, markerPath, undefined, 16 * 1024 * 1024, markerIdentity);
    if (!modeMatches(operations, markerRead.stats, 0o444)) {
        throw new Error('marker mode');
    }
    const marker = decodeStoreObjectMarker(markerRead.bytes);
    if (marker.archiveSha256 !== archiveSha256) {
        throw new Error('object digest directory');
    }
    const objectClosureLimit = marker.files.length + impliedDirectories(marker.files).size + 4;
    const initialClosure = await collectClosure(operations, root, objectClosureLimit);
    if (expected !== undefined && toolchain !== undefined) {
        if (
            marker.canonicalIri !== expected.canonicalIri ||
            marker.version !== expected.version ||
            !sameJson(marker.dependencies, expected.dependencies) ||
            !sameJson(marker.toolchain, toolchain)
        ) {
            throw new Error('object expected identity');
        }
    }
    const archivePath = join(root, ARCHIVE_FILE);
    const archiveIdentity = identity(await operations.lstat(archivePath, { bigint: true }));
    const capturedMarker = initialClosure.get(STORE_MARKER)?.identity;
    const capturedArchive = initialClosure.get(ARCHIVE_FILE)?.identity;
    if (
        capturedMarker === undefined ||
        capturedArchive === undefined ||
        capturedMarker.dev !== markerIdentity.dev ||
        capturedMarker.ino !== markerIdentity.ino ||
        capturedArchive.dev !== archiveIdentity.dev ||
        capturedArchive.ino !== archiveIdentity.ino
    ) {
        throw new Error('object closure identity');
    }
    const archiveRead = await readFileVerified(
        operations,
        archivePath,
        marker.archiveByteSize,
        PACKAGE_CODEC_LIMITS.maxCompressedBytes,
        archiveIdentity,
    );
    if (archiveRead.sha256 !== archiveSha256 || !modeMatches(operations, archiveRead.stats, 0o444)) {
        throw new Error('archive binding');
    }
    const validated = await Effect.runPromise(validatePackageArchive(archiveRead.bytes));
    if (
        validated.archiveSha256 !== marker.archiveSha256 ||
        validated.manifestSha256 !== marker.manifestSha256 ||
        validated.compressedBytes !== marker.archiveByteSize ||
        !sameJson(
            validated.files.map((file) => ({
                path: file.path,
                byteSize: file.byteSize,
                sha256: file.sha256,
                logicalMode: file.mode,
            })),
            marker.files,
        )
    ) {
        throw new Error('archive marker truth');
    }
    assertManifestIdentity(
        validated.manifest,
        {
            canonicalIri: marker.canonicalIri,
            version: marker.version,
            archiveSha256: marker.archiveSha256,
            dependencies: marker.dependencies,
        },
        marker.toolchain,
    );
    await verifyPackageTree(operations, join(root, PACKAGE_DIRECTORY), marker);
    const finalClosure = await collectClosure(operations, root, objectClosureLimit);
    const rootAfter = await operations.lstat(root, { bigint: true });
    if (
        !sameClosure(initialClosure, finalClosure) ||
        !sameIdentity(identity(rootStats), rootAfter) ||
        rootStats.mode !== rootAfter.mode ||
        !modeMatches(operations, rootAfter, 0o555)
    ) {
        throw new Error('object changed');
    }
    return deepFreeze({ marker, root, identity: identity(rootAfter), closure: finalClosure });
}

function ownedFromObject(verified: VerifiedObject): OwnedTree {
    return {
        root: verified.identity,
        entries: new Map([...verified.closure].map(([path, entry]) => [path, entry.identity])),
    };
}

async function captureBoundedOwnedTree(operations: StoreNodeOperations, root: string): Promise<OwnedTree> {
    const stats = await operations.lstat(root, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new LocalPackageStoreError(
            'STORE_REPAIR_REQUIRED',
            'The corrupt store object is not one bounded regular directory',
        );
    }
    const closure = await collectClosure(
        operations,
        root,
        PACKAGE_CODEC_LIMITS.maxEntries + PACKAGE_CODEC_LIMITS.maxPathDepth + 8,
    );
    return {
        root: identity(stats),
        entries: new Map([...closure].map(([path, entry]) => [path, entry.identity])),
    };
}

async function pathTreeMatchesSnapshot(
    operations: StoreNodeOperations,
    root: string,
    expected: OwnedTree,
): Promise<boolean> {
    const rootStats = await operations.lstat(root, { bigint: true });
    if (!sameIdentity(expected.root, rootStats) || expected.root.mode !== rootStats.mode) {
        return false;
    }
    const closure = await collectClosure(operations, root, expected.entries.size + 1);
    return (
        closure.size === expected.entries.size &&
        [...closure].every(([path, entry]) => {
            const captured = expected.entries.get(path);
            return captured !== undefined && sameSnapshot(captured, entry.identity);
        })
    );
}

async function hasObjectTransactionResidue(
    operations: StoreNodeOperations,
    objectsRoot: string,
    archiveSha256: string,
): Promise<boolean> {
    const exactStagePrefix = `.${archiveSha256}.stage-`;
    const exactBackupPrefix = `.${archiveSha256}.backup-`;
    const foldedStagePrefix = portableNameKey(exactStagePrefix);
    const foldedBackupPrefix = portableNameKey(exactBackupPrefix);
    let busy = false;
    for (const name of await readDirectoryBounded(operations, objectsRoot)) {
        const folded = portableNameKey(name);
        const stage = folded.startsWith(foldedStagePrefix);
        const backup = folded.startsWith(foldedBackupPrefix);
        if (!stage && !backup) {
            continue;
        }
        const exactPrefix = stage ? exactStagePrefix : exactBackupPrefix;
        const token = name.slice(exactPrefix.length);
        if (!name.startsWith(exactPrefix) || !TOKEN.test(token)) {
            throw new LocalPackageStoreError(
                'STORE_REPAIR_REQUIRED',
                'A noncanonical store transaction name requires explicit repair',
            );
        }
        const stats = await lstatOrNull(operations, join(objectsRoot, name));
        if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) {
            throw new LocalPackageStoreError(
                'STORE_REPAIR_REQUIRED',
                'A store transaction residue is not one regular directory',
            );
        }
        busy = true;
    }
    return busy;
}

async function inspectObject(
    operations: StoreNodeOperations,
    storeRoot: string,
    archiveSha256: string,
): Promise<{
    readonly inspection: PackageInspection;
    readonly object?: VerifiedObject;
}> {
    if (!SHA256.test(archiveSha256)) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'A locked archive digest must be lowercase SHA-256');
    }
    function missing(status: 'missing' | 'busy'): {
        readonly inspection: PackageInspection;
    } {
        return {
            inspection: deepFreeze({
                status,
                archiveSha256,
                canonicalIri: null,
                version: null,
                fileCount: null,
            }),
        };
    }
    const storeStats = await lstatOrNull(operations, storeRoot);
    if (storeStats === null) {
        return missing('missing');
    }
    const storeSnapshot = await snapshotDirectoryRoot(operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const objects = join(storeRoot, 'objects');
    const objectsStats = await lstatOrNull(operations, objects);
    await assertNoPortableSibling(operations, storeRoot, 'objects', objectsStats !== null);
    if (objectsStats === null) {
        await recheckDirectoryRoot(operations, storeRoot, storeSnapshot);
        return missing('missing');
    }
    const objectsSnapshot = await snapshotDirectoryRoot(operations, objects, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const busy = await hasObjectTransactionResidue(operations, objects, archiveSha256);
    async function finish<
        A extends {
            readonly inspection: PackageInspection;
            readonly object?: VerifiedObject;
        },
    >(value: A, exactObjectExists: boolean): Promise<A> {
        await assertNoPortableSibling(operations, objects, archiveSha256, exactObjectExists, 'STORE_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, storeRoot, storeSnapshot);
        await recheckDirectoryRoot(operations, objects, objectsSnapshot);
        return value;
    }
    const root = objectPath(storeRoot, archiveSha256);
    const existing = await lstatOrNull(operations, root);
    await assertNoPortableSibling(operations, objects, archiveSha256, existing !== null, 'STORE_REPAIR_REQUIRED');
    if (existing === null) {
        return await finish(missing(busy ? 'busy' : 'missing'), false);
    }
    try {
        const verified = await verifyObjectAt(operations, root, archiveSha256);
        return await finish(
            {
                inspection: deepFreeze({
                    status: 'available',
                    archiveSha256,
                    canonicalIri: verified.marker.canonicalIri,
                    version: verified.marker.version,
                    fileCount: verified.marker.files.length,
                }),
                object: verified,
            },
            true,
        );
    } catch {
        return await finish(
            {
                inspection: deepFreeze({
                    status: 'repair-required',
                    archiveSha256,
                    canonicalIri: null,
                    version: null,
                    fileCount: null,
                }),
            },
            true,
        );
    }
}

interface VerifiedProjectReference {
    readonly marker: StoreProjectReferenceMarker;
    readonly generationSha256: string;
    readonly path: string;
    readonly identity: FileIdentity;
    readonly rootStatus: 'present' | 'missing' | 'unavailable';
}

interface RegistrationScan {
    readonly references: ReadonlyArray<VerifiedProjectReference>;
    readonly corruptRegistrationIds: ReadonlyArray<string>;
    readonly busyRegistrationIds: ReadonlyArray<string>;
}

type RegistrationAdminMarker = Extract<StoreAdminMarker, { readonly kind: 'registration' }>;

function adminBytes(marker: StoreAdminMarker): Uint8Array {
    return encodeStoreAdminMarker(marker);
}

function exactDataRecord(input: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
    if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Object.getOwnPropertySymbols(input).length !== 0
    ) {
        throw new Error('record shape');
    }
    const names = Object.getOwnPropertyNames(input).sort(compareCodePoints);
    const expected = [...keys].sort(compareCodePoints);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        throw new Error('record keys');
    }
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new Error('record descriptor');
        }
    }
    return input as Record<string, unknown>;
}

function decodeAdminMarker(bytes: Uint8Array): StoreAdminMarker {
    return decodeStoreAdminMarker(bytes);
}

async function pathStatus(
    operations: StoreNodeOperations,
    path: string,
): Promise<'present' | 'missing' | 'unavailable'> {
    try {
        const stats = await operations.lstat(path, { bigint: true });
        return stats.isDirectory() && !stats.isSymbolicLink() ? 'present' : 'unavailable';
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? 'missing' : 'unavailable';
    }
}

async function scanRegistrations(
    operations: StoreNodeOperations,
    registrationsRoot: string,
): Promise<RegistrationScan> {
    const names = (await readDirectoryBounded(operations, registrationsRoot)).sort(compareCodePoints);
    if (names.length > LOCAL_PACKAGE_STORE_LIMITS.maxRegistrations * 2) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_INVALID',
            'The store registration index exceeds its closed entry bound',
        );
    }
    const portable = new Set<string>();
    const references: VerifiedProjectReference[] = [];
    const corrupt = new Set<string>();
    const busy = new Set<string>();
    for (const name of names) {
        const key = portableNameKey(name);
        if (portable.has(key)) {
            throw new LocalPackageStoreError(
                'STORE_REFERENCE_INVALID',
                'A portable registration-name collision requires repair',
            );
        }
        portable.add(key);
        const stage = REGISTRATION_STAGE.exec(name);
        if (stage !== null) {
            busy.add(stage[1] as string);
            continue;
        }
        const prune = REGISTRATION_PRUNE.exec(name);
        if (prune !== null) {
            busy.add(prune[1] as string);
            continue;
        }
        const final = REGISTRATION_FINAL.exec(name);
        if (final === null) {
            throw new LocalPackageStoreError(
                'STORE_REFERENCE_INVALID',
                'An unknown registration entry requires repair',
            );
        }
        const registrationId = final[1] as string;
        const generationSha256 = final[2] as string;
        const path = join(registrationsRoot, name);
        try {
            const read = await readFileVerified(
                operations,
                path,
                undefined,
                STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            );
            const marker = decodeStoreProjectReferenceMarker(read.bytes);
            if (
                marker.registrationId !== registrationId ||
                storeProjectReferenceGenerationSha256(marker) !== generationSha256 ||
                !modeMatches(operations, read.stats, 0o444)
            ) {
                throw new Error('registration binding');
            }
            references.push(
                Object.freeze({
                    marker,
                    generationSha256,
                    path,
                    identity: identity(read.stats),
                    rootStatus: await pathStatus(operations, marker.projectRoot),
                }),
            );
        } catch {
            corrupt.add(registrationId);
        }
    }
    references.sort((left, right) =>
        compareCodePoints(
            `${left.marker.registrationId}.${left.generationSha256}`,
            `${right.marker.registrationId}.${right.generationSha256}`,
        ),
    );
    return deepFreeze({
        references,
        corruptRegistrationIds: [...corrupt].sort(compareCodePoints),
        busyRegistrationIds: [...busy].sort(compareCodePoints),
    });
}

function registrationHead(
    references: ReadonlyArray<VerifiedProjectReference>,
    projectRoot: string,
): VerifiedProjectReference | null {
    const sameRoot = references.filter(({ marker }) => marker.projectRoot === projectRoot);
    if (sameRoot.length === 0) {
        return null;
    }
    const allByKey = new Map(
        references.map((item) => [`${item.marker.registrationId}.${item.generationSha256}`, item]),
    );
    const sameByKey = new Map(sameRoot.map((item) => [`${item.marker.registrationId}.${item.generationSha256}`, item]));
    const predecessors = new Set<string>();
    for (const item of sameRoot) {
        if (item.marker.previous === null) {
            continue;
        }
        const ownKey = `${item.marker.registrationId}.${item.generationSha256}`;
        const previousKey = `${item.marker.previous.registrationId}.${item.marker.previous.generationSha256}`;
        if (previousKey === ownKey) {
            throw new LocalPackageStoreError(
                'STORE_REFERENCE_INVALID',
                'A store registration generation cannot name itself as predecessor',
            );
        }
        const previous = allByKey.get(previousKey);
        if (previous !== undefined && previous.marker.projectRoot !== projectRoot) {
            throw new LocalPackageStoreError(
                'STORE_REFERENCE_INVALID',
                'A store registration predecessor belongs to a different project root',
            );
        }
        if (sameByKey.has(previousKey)) {
            predecessors.add(previousKey);
        }
    }
    for (const start of sameRoot) {
        const visited = new Set<string>();
        let current: VerifiedProjectReference | undefined = start;
        while (current !== undefined && current.marker.previous !== null) {
            const key = `${current.marker.registrationId}.${current.generationSha256}`;
            if (visited.has(key)) {
                throw new LocalPackageStoreError(
                    'STORE_REFERENCE_INVALID',
                    'The store registration history contains a cycle',
                );
            }
            visited.add(key);
            const previousKey = `${current.marker.previous.registrationId}.${current.marker.previous.generationSha256}`;
            current = sameByKey.get(previousKey);
        }
    }
    const heads = sameRoot.filter(
        ({ marker, generationSha256 }) => !predecessors.has(`${marker.registrationId}.${generationSha256}`),
    );
    if (heads.length !== 1) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_INVALID',
            'The store registration history has ambiguous current generations',
        );
    }
    return heads[0] as VerifiedProjectReference;
}

async function terminalRegistrationHead(
    operations: StoreNodeOperations,
    registrationsRoot: string,
    projectRoot: string,
    expectedMarker: StoreProjectReferenceMarker,
    expectedGenerationSha256: string,
    expectedIdentity?: FileIdentity,
    allowLinkCtimeDrift = false,
): Promise<VerifiedProjectReference> {
    const scan = await scanRegistrations(operations, registrationsRoot);
    if (scan.corruptRegistrationIds.length !== 0 || scan.busyRegistrationIds.length !== 0) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_INVALID',
            'The registration index changed before refresh completion',
        );
    }
    const head = registrationHead(scan.references, projectRoot);
    if (
        head === null ||
        head.generationSha256 !== expectedGenerationSha256 ||
        !Buffer.from(encodeStoreProjectReferenceMarker(head.marker)).equals(
            Buffer.from(encodeStoreProjectReferenceMarker(expectedMarker)),
        ) ||
        (expectedIdentity !== undefined &&
            (allowLinkCtimeDrift
                ? !(
                      expectedIdentity.kind === 'file' &&
                      head.identity.kind === 'file' &&
                      expectedIdentity.dev === head.identity.dev &&
                      expectedIdentity.ino === head.identity.ino &&
                      expectedIdentity.mode === head.identity.mode &&
                      expectedIdentity.size === head.identity.size &&
                      expectedIdentity.mtimeNs === head.identity.mtimeNs
                  )
                : !sameSnapshot(expectedIdentity, head.identity)))
    ) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_INVALID',
            'The current registration generation changed before refresh completion',
        );
    }
    const expectedNames = scan.references.map(({ path }) => basename(path)).sort(compareCodePoints);
    const finalNames = (await readDirectoryBounded(operations, registrationsRoot)).sort(compareCodePoints);
    if (expectedNames.length !== finalNames.length || expectedNames.some((name, index) => name !== finalNames[index])) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_INVALID',
            'The registration index changed at the refresh boundary',
        );
    }
    try {
        await assertNoPortableSibling(
            operations,
            registrationsRoot,
            basename(head.path),
            true,
            'STORE_REFERENCE_INVALID',
        );
        const final = await readFileVerified(
            operations,
            head.path,
            Number(head.identity.size),
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            head.identity,
        );
        if (
            !sameSnapshot(head.identity, identity(final.stats)) ||
            !Buffer.from(final.bytes).equals(Buffer.from(encodeStoreProjectReferenceMarker(expectedMarker)))
        ) {
            throw new Error('registration drift');
        }
    } catch (cause) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_INVALID',
            'The current registration file changed at the refresh boundary',
            cause,
        );
    }
    return head;
}

function exactReferenceInput(input: RefreshProjectReferenceInput): Readonly<{
    readonly storeRoot: string;
    readonly projectRoot: string;
    readonly manifestPath: string;
    readonly manifestSha256: string;
    readonly lock: LockfileV1;
}> {
    try {
        const record = exactDataRecord(input, ['storeRoot', 'projectRoot', 'manifestPath', 'manifestSha256', 'lock']);
        const storeRoot = record['storeRoot'];
        const projectRoot = record['projectRoot'];
        const manifestPath = record['manifestPath'];
        const manifestSha256 = record['manifestSha256'];
        if (
            typeof storeRoot !== 'string' ||
            typeof projectRoot !== 'string' ||
            typeof manifestPath !== 'string' ||
            typeof manifestSha256 !== 'string' ||
            !SHA256.test(manifestSha256)
        ) {
            throw new Error('reference input');
        }
        return Object.freeze({
            storeRoot: assertAbsoluteRoot(storeRoot, 'The store root'),
            projectRoot: assertAbsoluteRoot(projectRoot, 'The project root'),
            manifestPath: assertAbsoluteRoot(manifestPath, 'The manifest path'),
            manifestSha256,
            lock: decodeLockfileValue(record['lock']),
        });
    } catch (cause) {
        if (isLocalPackageStoreError(cause)) {
            throw cause;
        }
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The project reference input is invalid', cause);
    }
}

function referenceMatchesLock(
    marker: StoreProjectReferenceMarker,
    input: ReturnType<typeof exactReferenceInput>,
): boolean {
    return (
        marker.manifestPath === input.manifestPath &&
        marker.manifestSha256 === input.manifestSha256 &&
        marker.lockSha256 === lockSha256(input.lock) &&
        marker.project.canonicalIri === input.lock.root.canonicalIri &&
        marker.project.alias === input.lock.root.alias
    );
}

async function removeAuthenticatedFile(
    operations: StoreNodeOperations,
    path: string,
    expected: Readonly<{
        readonly identity: FileIdentity;
        readonly sha256: string;
        readonly bytes: Uint8Array;
    }>,
    maximum: number,
    validate: (bytes: Uint8Array) => void = () => undefined,
): Promise<void> {
    const parent = dirname(path);
    const name = basename(path);
    const parentSnapshot = await snapshotDirectoryRoot(operations, parent, 'STORE_ROOT_UNAVAILABLE', 0o700);
    await assertNoPortableSibling(operations, parent, name, true, 'STORE_ROLLBACK_UNSAFE');
    const read = await readFileVerified(operations, path, expected.bytes.byteLength, maximum, expected.identity);
    const finalIdentity = identity(read.stats);
    if (
        !sameSnapshot(expected.identity, finalIdentity) ||
        read.sha256 !== expected.sha256 ||
        !Buffer.from(read.bytes).equals(Buffer.from(expected.bytes))
    ) {
        throw new LocalPackageStoreError('STORE_ROLLBACK_UNSAFE', 'A store transaction file changed before cleanup');
    }
    validate(read.bytes);
    const immediatelyBefore = identity(await operations.lstat(path, { bigint: true }));
    if (!sameSnapshot(expected.identity, immediatelyBefore)) {
        throw new LocalPackageStoreError(
            'STORE_ROLLBACK_UNSAFE',
            'A store transaction file changed at the cleanup boundary',
        );
    }
    await recheckDirectoryRoot(operations, parent, parentSnapshot);
    try {
        await operations.rm(path, { force: false });
    } catch (cause) {
        if ((await lstatOrNull(operations, path)) !== null) {
            throw cause;
        }
    }
    if ((await lstatOrNull(operations, path)) !== null) {
        throw new LocalPackageStoreError('STORE_ROLLBACK_UNSAFE', 'A store transaction file reappeared after cleanup');
    }
    await assertNoPortableSibling(operations, parent, name, false, 'STORE_ROLLBACK_UNSAFE');
    await recheckDirectoryRoot(operations, parent, parentSnapshot);
}

interface AuthenticatedAdminInspection {
    readonly marker: StoreAdminMarker;
    readonly bytesSha256: string;
    readonly sha256: string;
    readonly bytes: Uint8Array;
    readonly identity: FileIdentity;
}

function cleanupSnapshot(read: Awaited<ReturnType<typeof readFileVerified>>): Readonly<{
    readonly identity: FileIdentity;
    readonly sha256: string;
    readonly bytes: Uint8Array;
}> {
    return Object.freeze({
        identity: identity(read.stats),
        sha256: read.sha256,
        bytes: Uint8Array.from(read.bytes),
    });
}

function validateAdminCleanup(expected: StoreAdminMarker) {
    return (bytes: Uint8Array): void => {
        const decoded = decodeAdminMarker(bytes);
        if (
            decoded.kind !== expected.kind ||
            decoded.token !== expected.token ||
            !Buffer.from(adminBytes(decoded)).equals(Buffer.from(adminBytes(expected)))
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'A store administration file changed semantic identity before cleanup',
            );
        }
    };
}

function validateRegistrationCleanup(registrationId: string, generationSha256: string) {
    return (bytes: Uint8Array): void => {
        const decoded = decodeStoreProjectReferenceMarker(bytes);
        if (
            decoded.registrationId !== registrationId ||
            storeProjectReferenceGenerationSha256(decoded) !== generationSha256
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'A registration transaction file changed semantic identity before cleanup',
            );
        }
    };
}

async function adminInspection(
    operations: StoreNodeOperations,
    storeRoot: string,
): Promise<AuthenticatedAdminInspection | null> {
    const path = join(storeRoot, STORE_ADMIN_MARKER);
    const stats = await lstatOrNull(operations, path);
    await assertNoPortableSibling(operations, storeRoot, STORE_ADMIN_MARKER, stats !== null, 'STORE_REPAIR_REQUIRED');
    if (stats === null) {
        return null;
    }
    const first = await readFileVerified(operations, path, undefined, STORE_MARKER_LIMITS.maxAdminMarkerBytes);
    const captured = identity(first.stats);
    const marker = decodeAdminMarker(first.bytes);
    await assertNoPortableSibling(operations, storeRoot, STORE_ADMIN_MARKER, true, 'STORE_REPAIR_REQUIRED');
    const final = await readFileVerified(
        operations,
        path,
        first.bytes.byteLength,
        STORE_MARKER_LIMITS.maxAdminMarkerBytes,
        captured,
    );
    if (
        !sameSnapshot(captured, identity(final.stats)) ||
        final.sha256 !== first.sha256 ||
        !Buffer.from(final.bytes).equals(Buffer.from(first.bytes))
    ) {
        throw new LocalPackageStoreError(
            'STORE_REPAIR_REQUIRED',
            'The store administration marker changed during inspection',
        );
    }
    return Object.freeze({
        marker,
        bytesSha256: final.sha256,
        sha256: final.sha256,
        bytes: Uint8Array.from(final.bytes),
        identity: captured,
    });
}

async function scanStoreAdminResidues(
    operations: StoreNodeOperations,
    storeRoot: string,
): Promise<
    Readonly<{
        readonly active: Awaited<ReturnType<typeof adminInspection>>;
        readonly stageNames: ReadonlyArray<string>;
    }>
> {
    const names = (await readDirectoryBounded(operations, storeRoot, { entries: 16, nameBytes: 8192 })).sort(
        compareCodePoints,
    );
    const portable = new Set<string>();
    const stages: string[] = [];
    for (const name of names) {
        const key = portableNameKey(name);
        if (portable.has(key)) {
            throw new LocalPackageStoreError(
                'STORE_REPAIR_REQUIRED',
                'A portable store administration-name collision requires repair',
            );
        }
        portable.add(key);
        if (name === 'objects' || name === REGISTRATIONS_DIRECTORY || name === STORE_ADMIN_MARKER) {
            continue;
        }
        const stage = ADMIN_STAGE.exec(name);
        if (stage === null) {
            throw new LocalPackageStoreError('STORE_REPAIR_REQUIRED', 'An unknown store-root entry requires repair');
        }
        stages.push(name);
    }
    const active = await adminInspection(operations, storeRoot);
    return deepFreeze({ active, stageNames: stages });
}

async function assertStoreAdministrationIdle(operations: StoreNodeOperations, storeRoot: string): Promise<void> {
    const state = await scanStoreAdminResidues(operations, storeRoot);
    if (state.active !== null || state.stageNames.length > 0) {
        throw new LocalPackageStoreError('STORE_OBJECT_BUSY', 'A store administration transaction is active');
    }
}

async function recoverRegistrationAdmin(
    operations: StoreNodeOperations,
    storeRoot: string,
    registrationsRoot: string,
): Promise<void> {
    let active = await adminInspection(operations, storeRoot);
    if (active === null) {
        return;
    }
    const { marker } = active;
    if (marker.kind !== 'registration') {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_BUSY',
            'A store prune transaction must be recovered before registration refresh',
        );
    }
    const registrationMarker = marker;
    const stagePath = join(registrationsRoot, marker.stageName);
    const finalPath = join(registrationsRoot, marker.finalName);
    async function authenticateFinal(): Promise<Awaited<ReturnType<typeof readFileVerified>>> {
        await assertNoPortableSibling(
            operations,
            registrationsRoot,
            registrationMarker.finalName,
            true,
            'STORE_ROLLBACK_UNSAFE',
        );
        const final = await readFileVerified(
            operations,
            finalPath,
            undefined,
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
        );
        const decoded = decodeStoreProjectReferenceMarker(final.bytes);
        if (
            decoded.registrationId !== registrationMarker.registrationId ||
            storeProjectReferenceGenerationSha256(decoded) !== registrationMarker.generationSha256 ||
            !sameRenamedStoredFile(registrationMarker.stageIdentity, final.stats)
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The interrupted registration destination is not the authenticated generation',
            );
        }
        return final;
    }
    const finalStats = await lstatOrNull(operations, finalPath);
    let finalRead: Awaited<ReturnType<typeof readFileVerified>> | null = null;
    if (finalStats !== null) {
        finalRead = await authenticateFinal();
    }
    const stageStats = await lstatOrNull(operations, stagePath);
    if (stageStats !== null) {
        const stage = await readFileVerified(
            operations,
            stagePath,
            undefined,
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
        );
        const decoded = decodeStoreProjectReferenceMarker(stage.bytes);
        if (
            decoded.registrationId !== marker.registrationId ||
            storeProjectReferenceGenerationSha256(decoded) !== marker.generationSha256 ||
            (finalRead === null
                ? !sameStoredFile(marker.stageIdentity, stage.stats)
                : !sameRenamedStoredFile(marker.stageIdentity, stage.stats) ||
                  stage.stats.dev !== finalRead.stats.dev ||
                  stage.stats.ino !== finalRead.stats.ino)
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The interrupted registration stage is not authenticated',
            );
        }
        await removeAuthenticatedFile(
            operations,
            stagePath,
            cleanupSnapshot(stage),
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            validateRegistrationCleanup(marker.registrationId, marker.generationSha256),
        );
    }
    if (finalStats === null) {
        // Publication never became visible; the complete immutable stage was safely retired above.
    }
    const adminStagePath = join(storeRoot, `.erden.store-admin.stage-${marker.token}.json`);
    if ((await lstatOrNull(operations, adminStagePath)) !== null) {
        const adminStage = await readFileVerified(
            operations,
            adminStagePath,
            undefined,
            STORE_MARKER_LIMITS.maxAdminMarkerBytes,
        );
        const decoded = decodeAdminMarker(adminStage.bytes);
        if (
            decoded.kind !== 'registration' ||
            decoded.registrationId !== marker.registrationId ||
            decoded.generationSha256 !== marker.generationSha256 ||
            adminStage.sha256 !== active.bytesSha256 ||
            adminStage.stats.dev !== active.identity.dev ||
            adminStage.stats.ino !== active.identity.ino
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The interrupted administration stage is not authenticated',
            );
        }
        await removeAuthenticatedFile(
            operations,
            adminStagePath,
            cleanupSnapshot(adminStage),
            STORE_MARKER_LIMITS.maxAdminMarkerBytes,
            validateAdminCleanup(marker),
        );
        active = await adminInspection(operations, storeRoot);
        if (
            active === null ||
            active.marker.kind !== 'registration' ||
            active.marker.token !== marker.token ||
            !Buffer.from(active.bytes).equals(Buffer.from(adminStage.bytes))
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The active registration marker changed during stage cleanup',
            );
        }
    }
    if (finalRead !== null) {
        finalRead = await authenticateFinal();
    }
    await removeAuthenticatedFile(
        operations,
        join(storeRoot, STORE_ADMIN_MARKER),
        active,
        STORE_MARKER_LIMITS.maxAdminMarkerBytes,
        validateAdminCleanup(marker),
    );
    const recovered = await scanStoreAdminResidues(operations, storeRoot);
    if (recovered.active !== null || recovered.stageNames.length !== 0) {
        throw new LocalPackageStoreError(
            'STORE_ROLLBACK_UNSAFE',
            'Registration recovery retained administration residue',
        );
    }
    if (finalRead !== null) {
        await authenticateFinal();
    }
}

async function writeVerifiedFile(
    operations: StoreNodeOperations,
    path: string,
    bytes: Uint8Array,
    mode: number,
): Promise<{
    readonly sha256: string;
    readonly identity: FileIdentity;
}> {
    const parent = dirname(path);
    const name = basename(path);
    const parentSnapshot = await snapshotDirectoryRoot(operations, parent, 'STORE_ROOT_UNAVAILABLE', 0o700);
    await assertNoPortableSibling(operations, parent, name, false, 'STORE_REPAIR_REQUIRED');
    let handle: FileHandle | undefined;
    let created: FileIdentity | undefined;
    try {
        handle = await operations.open(path, 'wx', 0o600);
        created = identity(await operations.stat(handle));
        await writeAll(operations, handle, bytes);
        await operations.sync(handle);
        await operations.close(handle);
        handle = undefined;
        await recheckDirectoryRoot(operations, parent, parentSnapshot);
        await operations.chmod(path, mode);
        await recheckDirectoryRoot(operations, parent, parentSnapshot);
        const read = await readFileVerified(operations, path, bytes.byteLength, bytes.byteLength, created);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const final = identity(await operations.lstat(path, { bigint: true }));
        if (
            read.sha256 !== sha256 ||
            !sameSnapshot(identity(read.stats), final) ||
            !modeMatches(operations, read.stats, mode)
        ) {
            throw new Error('published file truth');
        }
        await assertNoPortableSibling(operations, parent, name, true, 'STORE_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, parent, parentSnapshot);
        return Object.freeze({ sha256, identity: final });
    } catch (cause) {
        if (handle !== undefined) {
            await operations.close(handle).catch(() => undefined);
        }
        if (created === undefined) {
            try {
                await recheckDirectoryRoot(operations, parent, parentSnapshot);
                await assertNoPortableSibling(operations, parent, name, false, 'STORE_REPAIR_REQUIRED');
                await recheckDirectoryRoot(operations, parent, parentSnapshot);
            } catch {
                throw new LocalPackageStoreError(
                    'STORE_ROLLBACK_UNSAFE',
                    'A store transaction file may have been created without authenticated ownership',
                    cause,
                );
            }
            throw cause;
        }
        let removed = false;
        try {
            await recheckDirectoryRoot(operations, parent, parentSnapshot);
            await assertNoPortableSibling(operations, parent, name, true, 'STORE_REPAIR_REQUIRED');
            const current = await operations.lstat(path, { bigint: true });
            if (!sameIdentity(created, current) || current.size < 0n || current.size > BigInt(bytes.byteLength)) {
                throw new Error('created file identity or size changed');
            }
            const length = Number(current.size);
            const read = await readFileVerified(operations, path, length, bytes.byteLength, created);
            const expectedPrefix = bytes.subarray(0, length);
            const final = identity(await operations.lstat(path, { bigint: true }));
            if (
                !Buffer.from(read.bytes).equals(Buffer.from(expectedPrefix)) ||
                !sameSnapshot(identity(read.stats), final)
            ) {
                throw new Error('created file content changed');
            }
            await recheckDirectoryRoot(operations, parent, parentSnapshot);
            try {
                await operations.rm(path, { force: false });
            } catch (removeCause) {
                if ((await lstatOrNull(operations, path)) !== null) {
                    throw removeCause;
                }
            }
            await assertNoPortableSibling(operations, parent, name, false, 'STORE_REPAIR_REQUIRED');
            await recheckDirectoryRoot(operations, parent, parentSnapshot);
            removed = true;
        } catch {
            /* preserve unauthenticated evidence */
        }
        if (!removed) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'A store transaction file could not be cleaned with authenticated ownership',
                cause,
            );
        }
        throw cause;
    }
}

async function refreshProjectReferencePromise(
    rawInput: RefreshProjectReferenceInput,
    fileSystem: StoreFileSystemPort,
    signal: AbortSignal,
): Promise<RefreshProjectReferenceResult> {
    const operations = fileSystem.operations;
    const input = exactReferenceInput(rawInput);
    const pathStyle = process.platform === 'win32' ? ('win32' as const) : ('posix' as const);
    const projectReal = await operations.realpath(input.projectRoot);
    const manifestReal = await operations.realpath(input.manifestPath);
    if (
        typeof projectReal !== 'string' ||
        typeof manifestReal !== 'string' ||
        resolve(dirname(manifestReal)) !== resolve(projectReal)
    ) {
        throw new LocalPackageStoreError(
            'STORE_INVALID_INPUT',
            'The selected manifest is not one root-level project manifest',
        );
    }
    const registrationId = registrationIdFor(pathStyle, manifestReal);
    await ensureDirectory(operations, input.storeRoot, 0o700);
    const storeSnapshot = await snapshotDirectoryRoot(operations, input.storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const registrationsRoot = join(input.storeRoot, REGISTRATIONS_DIRECTORY);
    const registrationsBefore = await lstatOrNull(operations, registrationsRoot);
    await assertNoPortableSibling(operations, input.storeRoot, REGISTRATIONS_DIRECTORY, registrationsBefore !== null);
    await ensureDirectory(operations, registrationsRoot, 0o700);
    const registrationsSnapshot = await snapshotDirectoryRoot(
        operations,
        registrationsRoot,
        'STORE_ROOT_UNAVAILABLE',
        0o700,
    );
    const administration = await scanStoreAdminResidues(operations, input.storeRoot);
    const expectedInterruptedAdminStage =
        administration.active?.marker.kind === 'registration'
            ? `.erden.store-admin.stage-${administration.active.marker.token}.json`
            : null;
    if (
        administration.stageNames.length > 0 &&
        (expectedInterruptedAdminStage === null ||
            administration.stageNames.length !== 1 ||
            administration.stageNames[0] !== expectedInterruptedAdminStage)
    ) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_BUSY',
            'A store administration stage requires recovery before registration refresh',
        );
    }
    await recoverRegistrationAdmin(operations, input.storeRoot, registrationsRoot);
    const recoveredAdministration = await scanStoreAdminResidues(operations, input.storeRoot);
    if (recoveredAdministration.active !== null || recoveredAdministration.stageNames.length > 0) {
        throw new LocalPackageStoreError('STORE_REFERENCE_BUSY', 'A store administration transaction remains active');
    }
    const scan = await scanRegistrations(operations, registrationsRoot);
    if (scan.corruptRegistrationIds.length > 0 || scan.busyRegistrationIds.length > 0) {
        throw new LocalPackageStoreError(
            'STORE_REFERENCE_INVALID',
            'The store registration index requires repair before refresh',
        );
    }
    const head = registrationHead(scan.references, projectReal);
    if (
        head !== null &&
        referenceMatchesLock(head.marker, { ...input, projectRoot: projectReal, manifestPath: manifestReal })
    ) {
        await recheckDirectoryRoot(operations, input.storeRoot, storeSnapshot);
        await recheckDirectoryRoot(operations, registrationsRoot, registrationsSnapshot);
        const terminalHead = await terminalRegistrationHead(
            operations,
            registrationsRoot,
            projectReal,
            head.marker,
            head.generationSha256,
            head.identity,
        );
        return deepFreeze({
            status: 'hit',
            registrationId,
            generationSha256: terminalHead.generationSha256,
            lockSha256: terminalHead.marker.lockSha256,
            packages: terminalHead.marker.archiveSha256s.length,
        });
    }
    const marker = buildStoreProjectReferenceMarker({
        registrationId,
        pathStyle,
        previous:
            head === null
                ? null
                : {
                      registrationId: head.marker.registrationId,
                      generationSha256: head.generationSha256,
                  },
        projectRoot: projectReal,
        manifestPath: manifestReal,
        project: input.lock.root,
        manifestSha256: input.manifestSha256,
        lock: input.lock,
    });
    const bytes = encodeStoreProjectReferenceMarker(marker);
    const generationSha256 = storeProjectReferenceGenerationSha256(marker);
    const token = operations.token();
    if (!TOKEN.test(token)) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The registration transaction token is invalid');
    }
    const stageName = `.${registrationId}.${generationSha256}.stage-${token}.json`;
    const finalName = `${registrationId}.${generationSha256}.json`;
    const adminStageName = `.erden.store-admin.stage-${token}.json`;
    const stagePath = join(registrationsRoot, stageName);
    const finalPath = join(registrationsRoot, finalName);
    const adminStagePath = join(input.storeRoot, adminStageName);
    await assertNoPortableSibling(operations, registrationsRoot, stageName, false, 'STORE_REPAIR_REQUIRED');
    await assertNoPortableSibling(operations, registrationsRoot, finalName, false, 'STORE_REPAIR_REQUIRED');
    await assertNoPortableSibling(operations, input.storeRoot, adminStageName, false, 'STORE_REPAIR_REQUIRED');
    await assertNoPortableSibling(operations, input.storeRoot, STORE_ADMIN_MARKER, false, 'STORE_REPAIR_REQUIRED');
    let stage: Awaited<ReturnType<typeof writeVerifiedFile>> | undefined;
    let adminStage: Awaited<ReturnType<typeof writeVerifiedFile>> | undefined;
    let admin: RegistrationAdminMarker | undefined;
    let encodedAdmin: Uint8Array | undefined;
    try {
        stage = await writeVerifiedFile(operations, stagePath, bytes, 0o444);
        admin = Object.freeze({
            format: 'erden.store-admin-transaction/v1',
            kind: 'registration',
            token,
            stageName,
            finalName,
            registrationId,
            generationSha256,
            stageIdentity: storedFileIdentity(stage.identity),
        });
        encodedAdmin = adminBytes(admin);
        adminStage = await writeVerifiedFile(operations, adminStagePath, encodedAdmin, 0o444);
        signal.throwIfAborted();
        await recheckDirectoryRoot(operations, input.storeRoot, storeSnapshot);
        await recheckDirectoryRoot(operations, registrationsRoot, registrationsSnapshot);
        await operations.link(adminStagePath, join(input.storeRoot, STORE_ADMIN_MARKER));
        const active = await adminInspection(operations, input.storeRoot);
        if (
            active === null ||
            active.marker.kind !== 'registration' ||
            active.marker.generationSha256 !== generationSha256 ||
            active.identity.dev !== adminStage.identity.dev ||
            active.identity.ino !== adminStage.identity.ino
        ) {
            throw new Error('admin publication');
        }
        await operations.link(stagePath, finalPath);
        const published = await readFileVerified(operations, finalPath, bytes.byteLength, bytes.byteLength);
        if (
            published.sha256 !== stage.sha256 ||
            published.stats.dev !== stage.identity.dev ||
            published.stats.ino !== stage.identity.ino
        ) {
            throw new Error('reference publication');
        }
        await assertNoPortableSibling(operations, registrationsRoot, finalName, true, 'STORE_REPAIR_REQUIRED');
        const stageCleanup = await readFileVerified(
            operations,
            stagePath,
            bytes.byteLength,
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            stage.identity,
        );
        if (stageCleanup.stats.dev !== published.stats.dev || stageCleanup.stats.ino !== published.stats.ino) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The registration publication link changed before stage cleanup',
            );
        }
        await removeAuthenticatedFile(
            operations,
            stagePath,
            cleanupSnapshot(stageCleanup),
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            validateRegistrationCleanup(registrationId, generationSha256),
        );
        const adminStageCleanup = await readFileVerified(
            operations,
            adminStagePath,
            encodedAdmin.byteLength,
            STORE_MARKER_LIMITS.maxAdminMarkerBytes,
            adminStage.identity,
        );
        if (
            adminStageCleanup.stats.dev !== active.identity.dev ||
            adminStageCleanup.stats.ino !== active.identity.ino
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The administration publication link changed before stage cleanup',
            );
        }
        await removeAuthenticatedFile(
            operations,
            adminStagePath,
            cleanupSnapshot(adminStageCleanup),
            STORE_MARKER_LIMITS.maxAdminMarkerBytes,
            validateAdminCleanup(admin),
        );
        const activeAfterStage = await adminInspection(operations, input.storeRoot);
        if (
            activeAfterStage === null ||
            activeAfterStage.marker.kind !== 'registration' ||
            activeAfterStage.marker.token !== token ||
            activeAfterStage.identity.dev !== active.identity.dev ||
            activeAfterStage.identity.ino !== active.identity.ino ||
            !Buffer.from(activeAfterStage.bytes).equals(Buffer.from(encodedAdmin))
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The active registration marker changed before final cleanup',
            );
        }
        await removeAuthenticatedFile(
            operations,
            join(input.storeRoot, STORE_ADMIN_MARKER),
            activeAfterStage,
            STORE_MARKER_LIMITS.maxAdminMarkerBytes,
            validateAdminCleanup(admin),
        );
        const idle = await scanStoreAdminResidues(operations, input.storeRoot);
        if (idle.active !== null || idle.stageNames.length !== 0) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'Registration publication retained administration residue',
            );
        }
        await recheckDirectoryRoot(operations, input.storeRoot, storeSnapshot);
        await recheckDirectoryRoot(operations, registrationsRoot, registrationsSnapshot);
        const terminalHead = await terminalRegistrationHead(
            operations,
            registrationsRoot,
            projectReal,
            marker,
            generationSha256,
            stage.identity,
            true,
        );
        return deepFreeze({
            status: 'registered',
            registrationId,
            generationSha256: terminalHead.generationSha256,
            lockSha256: terminalHead.marker.lockSha256,
            packages: terminalHead.marker.archiveSha256s.length,
        });
    } catch (error) {
        let active: Awaited<ReturnType<typeof adminInspection>>;
        try {
            active = await adminInspection(operations, input.storeRoot);
        } catch (inspectionError) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'Registration administration truth became ambiguous',
                inspectionError,
            );
        }
        const activeIsOurs =
            active !== null &&
            active.marker.kind === 'registration' &&
            active.marker.token === token &&
            active.marker.registrationId === registrationId &&
            active.marker.generationSha256 === generationSha256 &&
            adminStage !== undefined &&
            active.bytesSha256 === adminStage.sha256 &&
            active.identity.dev === adminStage.identity.dev &&
            active.identity.ino === adminStage.identity.ino;
        if (activeIsOurs) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'Registration retained authenticated transaction evidence',
                error,
            );
        }
        if (stage !== undefined && (await lstatOrNull(operations, stagePath)) !== null) {
            try {
                await removeAuthenticatedFile(
                    operations,
                    stagePath,
                    { identity: stage.identity, sha256: stage.sha256, bytes },
                    STORE_MARKER_LIMITS.maxProjectReferenceBytes,
                    validateRegistrationCleanup(registrationId, generationSha256),
                );
            } catch (cleanupError) {
                throw new LocalPackageStoreError(
                    'STORE_ROLLBACK_UNSAFE',
                    'The losing registration stage could not be retired safely',
                    cleanupError,
                );
            }
        }
        if (adminStage !== undefined && (await lstatOrNull(operations, adminStagePath)) !== null) {
            if (admin === undefined || encodedAdmin === undefined) {
                throw new LocalPackageStoreError(
                    'STORE_ROLLBACK_UNSAFE',
                    'The losing administration stage has no authenticated marker truth',
                );
            }
            try {
                await removeAuthenticatedFile(
                    operations,
                    adminStagePath,
                    { identity: adminStage.identity, sha256: adminStage.sha256, bytes: encodedAdmin },
                    STORE_MARKER_LIMITS.maxAdminMarkerBytes,
                    validateAdminCleanup(admin),
                );
            } catch (cleanupError) {
                throw new LocalPackageStoreError(
                    'STORE_ROLLBACK_UNSAFE',
                    'The losing administration stage could not be retired safely',
                    cleanupError,
                );
            }
        }
        if (active !== null) {
            throw new LocalPackageStoreError(
                'STORE_REFERENCE_BUSY',
                'Another store administration transaction became active',
                error,
            );
        }
        throw error;
    }
}

async function inspectStoreIndexPromise(
    rawInput: InspectStoreIndexInput,
    fileSystem: StoreFileSystemPort,
): Promise<StoreIndexInspection> {
    const record = exactDataRecord(rawInput, ['storeRoot']);
    const rawRoot = record['storeRoot'];
    if (typeof rawRoot !== 'string') {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The store index input is invalid');
    }
    const storeRoot = assertAbsoluteRoot(rawRoot, 'The store root');
    const rootStats = await lstatOrNull(fileSystem.operations, storeRoot);
    if (rootStats === null) {
        return deepFreeze({
            store: 'missing',
            transaction: 'idle',
            registrations: [],
            corruptRegistrationIds: [],
            busyRegistrationIds: [],
            objects: [],
        });
    }
    const operations = fileSystem.operations;
    const storeSnapshot = await snapshotDirectoryRoot(operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const administration = await scanStoreAdminResidues(operations, storeRoot);
    const active = administration.active;
    const registrationsRoot = join(storeRoot, REGISTRATIONS_DIRECTORY);
    const registrationsStats = await lstatOrNull(operations, registrationsRoot);
    await assertNoPortableSibling(operations, storeRoot, REGISTRATIONS_DIRECTORY, registrationsStats !== null);
    const registrationScan =
        registrationsStats === null
            ? deepFreeze({ references: [], corruptRegistrationIds: [], busyRegistrationIds: [] })
            : await scanRegistrations(operations, registrationsRoot);
    const objectsRoot = join(storeRoot, 'objects');
    const objectsStats = await lstatOrNull(operations, objectsRoot);
    await assertNoPortableSibling(operations, storeRoot, 'objects', objectsStats !== null);
    const objects: StoreObjectIndexEntry[] = [];
    if (objectsStats !== null) {
        const objectsSnapshot = await snapshotDirectoryRoot(operations, objectsRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
        const names = (await readDirectoryBounded(operations, objectsRoot)).sort(compareCodePoints);
        if (names.length > LOCAL_PACKAGE_STORE_LIMITS.maxStoreObjects * 3) {
            throw new LocalPackageStoreError(
                'STORE_REPAIR_REQUIRED',
                'The store object index exceeds its closed entry bound',
            );
        }
        const busy = new Set<string>();
        const finals: string[] = [];
        const portable = new Set<string>();
        for (const name of names) {
            const key = portableNameKey(name);
            if (portable.has(key)) {
                throw new LocalPackageStoreError(
                    'STORE_REPAIR_REQUIRED',
                    'A portable store-object collision requires repair',
                );
            }
            portable.add(key);
            if (SHA256.test(name)) {
                finals.push(name);
                continue;
            }
            const transaction = OBJECT_TRANSACTION.exec(name);
            if (transaction === null) {
                throw new LocalPackageStoreError(
                    'STORE_REPAIR_REQUIRED',
                    'An unknown store-object entry requires repair',
                );
            }
            busy.add(transaction[1] as string);
        }
        for (const digest of finals) {
            if (busy.has(digest)) {
                objects.push(
                    Object.freeze({
                        archiveSha256: digest,
                        status: 'busy',
                        archiveByteSize: null,
                        logicalByteSize: null,
                    }),
                );
                continue;
            }
            try {
                const verified = await verifyObjectAt(operations, join(objectsRoot, digest), digest);
                const logical = verified.marker.files.reduce(
                    (total, file) => total + BigInt(file.byteSize),
                    BigInt(verified.marker.archiveByteSize),
                );
                objects.push(
                    Object.freeze({
                        archiveSha256: digest,
                        status: 'available',
                        archiveByteSize: verified.marker.archiveByteSize,
                        logicalByteSize: logical.toString(10),
                    }),
                );
            } catch {
                objects.push(
                    Object.freeze({
                        archiveSha256: digest,
                        status: 'corrupt',
                        archiveByteSize: null,
                        logicalByteSize: null,
                    }),
                );
            }
        }
        for (const digest of [...busy].filter((digest) => !finals.includes(digest)).sort(compareCodePoints)) {
            objects.push(
                Object.freeze({ archiveSha256: digest, status: 'busy', archiveByteSize: null, logicalByteSize: null }),
            );
        }
        objects.sort((left, right) => compareCodePoints(left.archiveSha256, right.archiveSha256));
        await recheckDirectoryRoot(operations, objectsRoot, objectsSnapshot);
    }
    const registrations: StoreProjectReferenceGeneration[] = registrationScan.references.map((reference) =>
        deepFreeze({
            registrationId: reference.marker.registrationId,
            generationSha256: reference.generationSha256,
            previous: reference.marker.previous,
            projectRoot: reference.marker.projectRoot,
            manifestPath: reference.marker.manifestPath,
            project: reference.marker.project,
            manifestSha256: reference.marker.manifestSha256,
            lockSha256: reference.marker.lockSha256,
            manifestDependencySha256: reference.marker.manifestDependencySha256,
            toolchain: reference.marker.toolchain,
            archiveSha256s: reference.marker.archiveSha256s,
            rootStatus: reference.rootStatus,
        }),
    );
    await recheckDirectoryRoot(operations, storeRoot, storeSnapshot);
    return deepFreeze({
        store: 'available',
        transaction: active === null && administration.stageNames.length === 0 ? 'idle' : 'busy',
        registrations,
        corruptRegistrationIds: registrationScan.corruptRegistrationIds,
        busyRegistrationIds: registrationScan.busyRegistrationIds,
        objects,
    });
}

function storedDirectoryIdentity(input: FileIdentity): StorePruneDirectoryIdentity {
    if (input.kind !== 'directory') {
        throw new LocalPackageStoreError('STORE_PRUNE_BLOCKED', 'A prune parent is not one authenticated directory');
    }
    return Object.freeze({
        dev: input.dev.toString(10),
        ino: input.ino.toString(10),
        mode: input.mode.toString(10),
        kind: 'directory',
    });
}

function storedFileIdentity(input: FileIdentity): StorePruneFileIdentity {
    if (input.kind !== 'file') {
        throw new LocalPackageStoreError('STORE_PRUNE_BLOCKED', 'A prune source is not one authenticated file');
    }
    return Object.freeze({
        dev: input.dev.toString(10),
        ino: input.ino.toString(10),
        mode: input.mode.toString(10),
        size: input.size.toString(10),
        mtimeNs: input.mtimeNs.toString(10),
        ctimeNs: input.ctimeNs.toString(10),
        kind: 'file',
    });
}

function sameStoredDirectory(expected: StorePruneDirectoryIdentity, stats: BigIntStats): boolean {
    return (
        stats.isDirectory() &&
        !stats.isSymbolicLink() &&
        stats.dev.toString(10) === expected.dev &&
        stats.ino.toString(10) === expected.ino &&
        stats.mode.toString(10) === expected.mode
    );
}

function sameStoredFile(expected: StorePruneFileIdentity, stats: BigIntStats): boolean {
    return (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.dev.toString(10) === expected.dev &&
        stats.ino.toString(10) === expected.ino &&
        stats.mode.toString(10) === expected.mode &&
        stats.size.toString(10) === expected.size &&
        stats.mtimeNs.toString(10) === expected.mtimeNs &&
        stats.ctimeNs.toString(10) === expected.ctimeNs
    );
}

function sameRenamedStoredFile(expected: StorePruneFileIdentity, stats: BigIntStats): boolean {
    return (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.dev.toString(10) === expected.dev &&
        stats.ino.toString(10) === expected.ino &&
        stats.mode.toString(10) === expected.mode &&
        stats.size.toString(10) === expected.size &&
        stats.mtimeNs.toString(10) === expected.mtimeNs
    );
}

function directoryNamesSha256(names: ReadonlyArray<string>): string {
    return createHash('sha256')
        .update(new TextEncoder().encode(`${JSON.stringify([...names].sort(compareCodePoints))}\n`))
        .digest('hex');
}

function exactPruneInput(input: PruneStoreInput): Readonly<{
    readonly storeRoot: string;
    readonly registrationGenerations: ReadonlyArray<
        Readonly<{
            readonly registrationId: string;
            readonly generationSha256: string;
        }>
    >;
    readonly archiveSha256s: ReadonlyArray<string>;
}> {
    try {
        const value = exactDataRecord(input, ['storeRoot', 'registrationGenerations', 'archiveSha256s']);
        if (typeof value['storeRoot'] !== 'string') {
            throw new Error('prune root');
        }
        function decodeArray<Output>(
            raw: unknown,
            maximum: number,
            decode: (item: unknown) => Output,
        ): ReadonlyArray<Output> {
            if (
                !Array.isArray(raw) ||
                Object.getPrototypeOf(raw) !== Array.prototype ||
                Object.getOwnPropertySymbols(raw).length !== 0 ||
                raw.length > maximum ||
                Object.getOwnPropertyNames(raw).length !== raw.length + 1
            ) {
                throw new Error('prune array');
            }
            const output: Output[] = [];
            for (let index = 0; index < raw.length; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
                if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                    throw new Error('prune array descriptor');
                }
                output.push(decode(descriptor.value));
            }
            return Object.freeze(output);
        }
        const registrationGenerations = decodeArray(
            value['registrationGenerations'],
            LOCAL_PACKAGE_STORE_LIMITS.maxRegistrations,
            (item) => {
                const record = exactDataRecord(item, ['registrationId', 'generationSha256']);
                if (
                    typeof record['registrationId'] !== 'string' ||
                    !SHA256.test(record['registrationId']) ||
                    typeof record['generationSha256'] !== 'string' ||
                    !SHA256.test(record['generationSha256'])
                ) {
                    throw new Error('prune registration key');
                }
                return Object.freeze({
                    registrationId: record['registrationId'],
                    generationSha256: record['generationSha256'],
                });
            },
        );
        const archiveSha256s = decodeArray(
            value['archiveSha256s'],
            LOCAL_PACKAGE_STORE_LIMITS.maxStoreObjects,
            (item) => {
                if (typeof item !== 'string' || !SHA256.test(item)) {
                    throw new Error('prune digest');
                }
                return item;
            },
        );
        const registrationKeys = registrationGenerations.map(
            ({ registrationId, generationSha256 }) => `${registrationId}.${generationSha256}`,
        );
        if (
            registrationKeys.some(
                (key, index) => index > 0 && compareCodePoints(registrationKeys[index - 1] ?? '', key) >= 0,
            ) ||
            archiveSha256s.some(
                (digest, index) => index > 0 && compareCodePoints(archiveSha256s[index - 1] ?? '', digest) >= 0,
            )
        ) {
            throw new Error('prune input order');
        }
        return Object.freeze({
            storeRoot: assertAbsoluteRoot(value['storeRoot'], 'The store root'),
            registrationGenerations,
            archiveSha256s,
        });
    } catch (cause) {
        if (isLocalPackageStoreError(cause)) {
            throw cause;
        }
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The store prune input is invalid', cause);
    }
}

async function closurePlan(
    operations: StoreNodeOperations,
    verified: VerifiedObject,
): Promise<ReadonlyArray<StorePruneClosureEntry>> {
    const entries: StorePruneClosureEntry[] = [];
    for (const [path, entry] of [...verified.closure].sort(([left], [right]) => compareCodePoints(left, right))) {
        if (entry.identity.kind === 'directory') {
            entries.push(Object.freeze({ path, identity: storedDirectoryIdentity(entry.identity), sha256: null }));
            continue;
        }
        if (entry.identity.size < 0n || entry.identity.size > BigInt(PACKAGE_CODEC_LIMITS.maxCompressedBytes)) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_LIMIT',
                'A prune source file exceeds the authenticated read bound',
            );
        }
        const read = await readFileVerified(
            operations,
            entry.path,
            Number(entry.identity.size),
            Number(entry.identity.size),
            entry.identity,
        );
        entries.push(Object.freeze({ path, identity: storedFileIdentity(identity(read.stats)), sha256: read.sha256 }));
    }
    return Object.freeze(entries);
}

function conceptualProjection(
    names: ReadonlyArray<string>,
    entries: ReadonlyArray<{
        readonly sourceName: string;
        readonly quarantineName: string;
    }>,
): ReadonlyArray<string> {
    const output = new Set(names);
    for (const entry of entries) {
        const source = output.has(entry.sourceName);
        const quarantine = output.has(entry.quarantineName);
        if (source && quarantine) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_INTERRUPTED',
                'A prune source and quarantine are both present',
            );
        }
        if (quarantine) {
            output.delete(entry.quarantineName);
        }
        if (!source) {
            output.add(entry.sourceName);
        }
    }
    return [...output].sort(compareCodePoints);
}

async function assertPruneProgress(
    operations: StoreNodeOperations,
    storeRoot: string,
    marker: Extract<
        StoreAdminMarker,
        {
            readonly kind: 'prune';
        }
    >,
): Promise<void> {
    const objectsRoot = join(storeRoot, 'objects');
    const registrationsRoot = join(storeRoot, REGISTRATIONS_DIRECTORY);
    if (
        !sameStoredDirectory(marker.basis.store, await operations.lstat(storeRoot, { bigint: true })) ||
        !sameStoredDirectory(marker.basis.objects, await operations.lstat(objectsRoot, { bigint: true })) ||
        !sameStoredDirectory(marker.basis.registrations, await operations.lstat(registrationsRoot, { bigint: true }))
    ) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_INTERRUPTED',
            'A prune parent directory changed during the transaction',
        );
    }
    const stageName = `.erden.store-admin.stage-${marker.token}.json`;
    const storeNames = await readDirectoryBounded(operations, storeRoot, { entries: 16, nameBytes: 8192 });
    const storeConceptual = storeNames.filter((name) => name !== STORE_ADMIN_MARKER && name !== stageName);
    if (
        directoryNamesSha256(storeConceptual) !== marker.basis.storeEntriesSha256 ||
        directoryNamesSha256(
            conceptualProjection(await readDirectoryBounded(operations, objectsRoot), marker.plan.objects),
        ) !== marker.basis.objectsEntriesSha256 ||
        directoryNamesSha256(
            conceptualProjection(await readDirectoryBounded(operations, registrationsRoot), marker.plan.registrations),
        ) !== marker.basis.registrationsEntriesSha256
    ) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_INTERRUPTED',
            'The store projection changed outside the authenticated prune plan',
        );
    }
    const fixed = await readFileVerified(
        operations,
        join(storeRoot, STORE_ADMIN_MARKER),
        undefined,
        STORE_MARKER_LIMITS.maxAdminMarkerBytes,
    );
    const decoded = decodeStoreAdminMarker(fixed.bytes);
    if (decoded.kind !== 'prune' || decoded.token !== marker.token) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_INTERRUPTED',
            'The active prune marker changed during the transaction',
        );
    }
}

async function assertPruneFinal(
    operations: StoreNodeOperations,
    storeRoot: string,
    marker: Extract<
        StoreAdminMarker,
        {
            readonly kind: 'prune';
        }
    >,
): Promise<void> {
    const objectsRoot = join(storeRoot, 'objects');
    const registrationsRoot = join(storeRoot, REGISTRATIONS_DIRECTORY);
    if (
        !sameStoredDirectory(marker.basis.store, await operations.lstat(storeRoot, { bigint: true })) ||
        !sameStoredDirectory(marker.basis.objects, await operations.lstat(objectsRoot, { bigint: true })) ||
        !sameStoredDirectory(marker.basis.registrations, await operations.lstat(registrationsRoot, { bigint: true }))
    ) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A completed prune parent directory changed');
    }
    const storeNames = await readDirectoryBounded(operations, storeRoot, { entries: 16, nameBytes: 8192 });
    if (
        storeNames.includes(STORE_ADMIN_MARKER) ||
        storeNames.some((name) => ADMIN_STAGE.test(name)) ||
        directoryNamesSha256(storeNames) !== marker.basis.storeEntriesSha256
    ) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_INTERRUPTED',
            'A completed prune retained administration residue',
        );
    }
    const objectNames = await readDirectoryBounded(operations, objectsRoot);
    const registrationNames = await readDirectoryBounded(operations, registrationsRoot);
    if (
        marker.plan.objects.some(
            ({ sourceName, quarantineName }) =>
                objectNames.includes(sourceName) || objectNames.includes(quarantineName),
        ) ||
        marker.plan.registrations.some(
            ({ sourceName, quarantineName }) =>
                registrationNames.includes(sourceName) || registrationNames.includes(quarantineName),
        ) ||
        directoryNamesSha256(conceptualProjection(objectNames, marker.plan.objects)) !==
            marker.basis.objectsEntriesSha256 ||
        directoryNamesSha256(conceptualProjection(registrationNames, marker.plan.registrations)) !==
            marker.basis.registrationsEntriesSha256
    ) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'The completed prune projection is not exact');
    }
}

async function reproveRegistrationPlan(
    operations: StoreNodeOperations,
    registrationsRoot: string,
    entry: StorePruneRegistrationPlanEntry,
): Promise<void> {
    if (entry.reason === 'orphaned') {
        if ((await pathStatus(operations, entry.record.projectRoot)) !== 'missing') {
            throw new LocalPackageStoreError('STORE_PRUNE_BLOCKED', 'A registered project is no longer proven absent');
        }
        return;
    }
    const headPath = join(
        registrationsRoot,
        `${entry.currentHead.registrationId}.${entry.currentHead.generationSha256}.json`,
    );
    const head = await readFileVerified(operations, headPath, undefined, STORE_MARKER_LIMITS.maxProjectReferenceBytes);
    if (head.sha256 !== entry.currentHead.sha256) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_BLOCKED',
            'The current project registration changed before superseded cleanup',
        );
    }
    const marker = decodeStoreProjectReferenceMarker(head.bytes);
    if (marker.projectRoot !== entry.record.projectRoot) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_BLOCKED',
            'A superseded registration no longer belongs to the authenticated current project',
        );
    }
}

async function renamePlannedEntry(
    operations: StoreNodeOperations,
    source: string,
    quarantine: string,
    verify: (path: string) => Promise<void>,
): Promise<void> {
    if ((await lstatOrNull(operations, quarantine)) !== null) {
        if ((await lstatOrNull(operations, source)) !== null) {
            throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'Both prune source and quarantine exist');
        }
        await verify(quarantine);
        return;
    }
    if ((await lstatOrNull(operations, source)) === null) {
        return;
    }
    await verify(source);
    try {
        await operations.rename(source, quarantine);
    } catch (cause) {
        const sourceAfter = await lstatOrNull(operations, source);
        const quarantineAfter = await lstatOrNull(operations, quarantine);
        if (sourceAfter !== null || quarantineAfter === null) {
            throw cause;
        }
    }
    await verify(quarantine);
    if ((await lstatOrNull(operations, source)) !== null) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune source reappeared after quarantine');
    }
}

async function verifyRegistrationPlanFile(
    operations: StoreNodeOperations,
    path: string,
    entry: StorePruneRegistrationPlanEntry,
    renamed = false,
): Promise<void> {
    const read = await readFileVerified(
        operations,
        path,
        Number(BigInt(entry.identity.size)),
        STORE_MARKER_LIMITS.maxProjectReferenceBytes,
    );
    if (
        !(renamed ? sameRenamedStoredFile(entry.identity, read.stats) : sameStoredFile(entry.identity, read.stats)) ||
        read.sha256 !== entry.sha256
    ) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune registration file changed');
    }
}

async function verifyObjectPlanRoot(
    operations: StoreNodeOperations,
    path: string,
    entry: StorePruneObjectPlanEntry,
): Promise<void> {
    const stats = await operations.lstat(path, { bigint: true });
    if (!sameStoredDirectory(entry.identity, stats)) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune object directory changed');
    }
    const closure = await collectClosure(operations, path, entry.closure.length + 1);
    if (closure.size !== entry.closure.length) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune object closure changed before quarantine');
    }
    for (const planned of entry.closure) {
        const actual = closure.get(planned.path);
        if (actual === undefined) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_INTERRUPTED',
                'A prune object entry disappeared before quarantine',
            );
        }
        if (planned.identity.kind === 'directory') {
            if (!sameStoredDirectory(planned.identity, await operations.lstat(actual.path, { bigint: true }))) {
                throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune object directory entry changed');
            }
        } else {
            const read = await readFileVerified(
                operations,
                actual.path,
                Number(BigInt(planned.identity.size)),
                Number(BigInt(planned.identity.size)),
            );
            if (!sameStoredFile(planned.identity, read.stats) || read.sha256 !== planned.sha256) {
                throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune object file changed');
            }
        }
    }
}

async function removePlannedObject(
    operations: StoreNodeOperations,
    quarantine: string,
    entry: StorePruneObjectPlanEntry,
): Promise<void> {
    const rootStats = await lstatOrNull(operations, quarantine);
    if (rootStats === null) {
        return;
    }
    if (
        !rootStats.isDirectory() ||
        rootStats.dev.toString(10) !== entry.identity.dev ||
        rootStats.ino.toString(10) !== entry.identity.ino
    ) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune quarantine directory changed');
    }
    const planned = new Map(entry.closure.map((item) => [item.path, item]));
    const actual = await collectClosure(operations, quarantine, entry.closure.length + 1);
    const markerPresent = actual.has(STORE_MARKER);
    if (!markerPresent && actual.size > 0) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune quarantine lost its ownership sentinel');
    }
    for (const [path, item] of actual) {
        const expected = planned.get(path);
        if (expected === undefined) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_INTERRUPTED',
                'A foreign entry appeared in a prune quarantine',
            );
        }
        const stats = await operations.lstat(item.path, { bigint: true });
        if (expected.identity.kind === 'directory') {
            if (
                !stats.isDirectory() ||
                stats.dev.toString(10) !== expected.identity.dev ||
                stats.ino.toString(10) !== expected.identity.ino ||
                (stats.mode.toString(10) !== expected.identity.mode && !modeMatches(operations, stats, 0o700))
            ) {
                throw new LocalPackageStoreError(
                    'STORE_PRUNE_INTERRUPTED',
                    'A prune quarantine directory entry changed',
                );
            }
        } else {
            const read = await readFileVerified(
                operations,
                item.path,
                Number(BigInt(expected.identity.size)),
                Number(BigInt(expected.identity.size)),
            );
            if (!sameStoredFile(expected.identity, read.stats) || read.sha256 !== expected.sha256) {
                throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune quarantine file entry changed');
            }
        }
    }
    if (actual.size === 0) {
        await operations.rmdir(quarantine);
        return;
    }
    if (rootStats.mode.toString(10) !== entry.identity.mode && !modeMatches(operations, rootStats, 0o700)) {
        throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune quarantine root mode changed');
    }
    await operations.chmod(quarantine, 0o700);
    const directories = [...actual]
        .filter(([, item]) => item.identity.kind === 'directory')
        .sort(([left], [right]) => left.split('/').length - right.split('/').length || compareCodePoints(left, right));
    for (const [, item] of directories) {
        await operations.chmod(item.path, 0o700);
    }
    const files = [...actual]
        .filter(([path, item]) => item.identity.kind === 'file' && path !== STORE_MARKER)
        .sort(([left], [right]) => compareCodePoints(left, right));
    for (const [path, item] of files) {
        const expected = planned.get(path);
        if (expected?.identity.kind !== 'file') {
            throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune file plan is incomplete');
        }
        const read = await readFileVerified(
            operations,
            item.path,
            Number(BigInt(expected.identity.size)),
            Number(BigInt(expected.identity.size)),
        );
        if (!sameStoredFile(expected.identity, read.stats) || read.sha256 !== expected.sha256) {
            throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune file changed before deletion');
        }
        await operations.rm(item.path, { force: false });
    }
    const directoryPaths = [...actual]
        .filter(([, item]) => item.identity.kind === 'directory')
        .sort(([left], [right]) => right.split('/').length - left.split('/').length || compareCodePoints(right, left));
    for (const [, item] of directoryPaths) {
        const stats = await operations.lstat(item.path, { bigint: true });
        if (!stats.isDirectory() || (await readDirectoryBounded(operations, item.path)).length !== 0) {
            throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'A prune directory is not empty at deletion');
        }
        await operations.rmdir(item.path);
    }
    const markerPath = join(quarantine, STORE_MARKER);
    if ((await lstatOrNull(operations, markerPath)) !== null) {
        const expected = planned.get(STORE_MARKER);
        if (expected?.identity.kind !== 'file') {
            throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'The prune ownership sentinel is not planned');
        }
        const read = await readFileVerified(
            operations,
            markerPath,
            Number(BigInt(expected.identity.size)),
            Number(BigInt(expected.identity.size)),
        );
        if (!sameStoredFile(expected.identity, read.stats) || read.sha256 !== expected.sha256) {
            throw new LocalPackageStoreError('STORE_PRUNE_INTERRUPTED', 'The prune ownership sentinel changed');
        }
        await operations.rm(markerPath, { force: false });
    }
    const finalRoot = await operations.lstat(quarantine, { bigint: true });
    if (
        finalRoot.dev.toString(10) !== entry.identity.dev ||
        finalRoot.ino.toString(10) !== entry.identity.ino ||
        (await readDirectoryBounded(operations, quarantine)).length !== 0
    ) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_INTERRUPTED',
            'The prune quarantine root is not authenticated and empty',
        );
    }
    await operations.rmdir(quarantine);
}

async function executePruneMarker(
    operations: StoreNodeOperations,
    storeRoot: string,
    marker: Extract<
        StoreAdminMarker,
        {
            readonly kind: 'prune';
        }
    >,
    signal: AbortSignal,
): Promise<void> {
    const objectsRoot = join(storeRoot, 'objects');
    const registrationsRoot = join(storeRoot, REGISTRATIONS_DIRECTORY);
    const stagePath = join(storeRoot, `.erden.store-admin.stage-${marker.token}.json`);
    const storeWindow = await snapshotDirectoryRoot(operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const objectsWindow = await snapshotDirectoryRoot(operations, objectsRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const registrationsWindow = await snapshotDirectoryRoot(
        operations,
        registrationsRoot,
        'STORE_ROOT_UNAVAILABLE',
        0o700,
    );
    await assertPruneProgress(operations, storeRoot, marker);
    for (const entry of marker.plan.registrations) {
        signal.throwIfAborted();
        await reproveRegistrationPlan(operations, registrationsRoot, entry);
        await assertPruneProgress(operations, storeRoot, marker);
        await renamePlannedEntry(
            operations,
            join(registrationsRoot, entry.sourceName),
            join(registrationsRoot, entry.quarantineName),
            async (path) => {
                await verifyRegistrationPlanFile(operations, path, entry, path.endsWith(entry.quarantineName));
            },
        );
        await assertPruneProgress(operations, storeRoot, marker);
    }
    for (const entry of marker.plan.objects) {
        signal.throwIfAborted();
        await assertPruneProgress(operations, storeRoot, marker);
        const source = join(objectsRoot, entry.sourceName);
        const quarantine = join(objectsRoot, entry.quarantineName);
        const sourceStats = await lstatOrNull(operations, source);
        const quarantineStats = await lstatOrNull(operations, quarantine);
        if (sourceStats === null && quarantineStats !== null) {
            if (
                !quarantineStats.isDirectory() ||
                quarantineStats.isSymbolicLink() ||
                quarantineStats.dev.toString(10) !== entry.identity.dev ||
                quarantineStats.ino.toString(10) !== entry.identity.ino
            ) {
                throw new LocalPackageStoreError(
                    'STORE_PRUNE_INTERRUPTED',
                    'A progressive prune object quarantine changed identity',
                );
            }
            // A retained quarantine may already be a strict authenticated subset of the
            // original closure. assertPruneProgress binds its name and the deletion pass
            // below authenticates every remaining entry plus the marker sentinel.
        } else {
            await renamePlannedEntry(operations, source, quarantine, async (path) => {
                await verifyObjectPlanRoot(operations, path, entry);
            });
        }
        await assertPruneProgress(operations, storeRoot, marker);
    }
    for (const entry of marker.plan.registrations) {
        signal.throwIfAborted();
        await reproveRegistrationPlan(operations, registrationsRoot, entry);
        const quarantine = join(registrationsRoot, entry.quarantineName);
        if ((await lstatOrNull(operations, quarantine)) !== null) {
            await verifyRegistrationPlanFile(operations, quarantine, entry, true);
            await operations.rm(quarantine, { force: false });
        }
        await assertPruneProgress(operations, storeRoot, marker);
    }
    for (const entry of marker.plan.objects) {
        signal.throwIfAborted();
        await removePlannedObject(operations, join(objectsRoot, entry.quarantineName), entry);
        await assertPruneProgress(operations, storeRoot, marker);
    }
    for (const entry of marker.plan.registrations) {
        await reproveRegistrationPlan(operations, registrationsRoot, entry);
    }
    await assertPruneProgress(operations, storeRoot, marker);
    if ((await lstatOrNull(operations, stagePath)) !== null) {
        const stage = await readFileVerified(operations, stagePath, undefined, STORE_MARKER_LIMITS.maxAdminMarkerBytes);
        const fixed = await adminInspection(operations, storeRoot);
        if (
            fixed === null ||
            fixed.marker.kind !== 'prune' ||
            fixed.marker.token !== marker.token ||
            stage.sha256 !== fixed.bytesSha256 ||
            !Buffer.from(stage.bytes).equals(Buffer.from(fixed.bytes)) ||
            stage.stats.dev !== fixed.identity.dev ||
            stage.stats.ino !== fixed.identity.ino
        ) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_INTERRUPTED',
                'The prune marker stage changed before cleanup',
            );
        }
        await removeAuthenticatedFile(
            operations,
            stagePath,
            cleanupSnapshot(stage),
            STORE_MARKER_LIMITS.maxAdminMarkerBytes,
            validateAdminCleanup(marker),
        );
    }
    await assertPruneProgress(operations, storeRoot, marker);
    await recheckDirectoryRoot(operations, storeRoot, storeWindow);
    await recheckDirectoryRoot(operations, objectsRoot, objectsWindow);
    await recheckDirectoryRoot(operations, registrationsRoot, registrationsWindow);
    signal.throwIfAborted();
    const fixed = await adminInspection(operations, storeRoot);
    if (
        fixed === null ||
        fixed.marker.kind !== 'prune' ||
        fixed.marker.token !== marker.token ||
        !Buffer.from(fixed.bytes).equals(Buffer.from(adminBytes(marker)))
    ) {
        throw new LocalPackageStoreError(
            'STORE_PRUNE_INTERRUPTED',
            'The completed prune marker changed before retirement',
        );
    }
    await removeAuthenticatedFile(
        operations,
        join(storeRoot, STORE_ADMIN_MARKER),
        fixed,
        STORE_MARKER_LIMITS.maxAdminMarkerBytes,
        validateAdminCleanup(marker),
    );
    await assertPruneFinal(operations, storeRoot, marker);
    await recheckDirectoryRoot(operations, storeRoot, storeWindow);
    await recheckDirectoryRoot(operations, objectsRoot, objectsWindow);
    await recheckDirectoryRoot(operations, registrationsRoot, registrationsWindow);
}

async function pruneStorePromise(
    rawInput: PruneStoreInput,
    fileSystem: StoreFileSystemPort,
    signal: AbortSignal,
): Promise<PruneStoreResult> {
    const input = exactPruneInput(rawInput);
    const operations = fileSystem.operations;
    if ((await lstatOrNull(operations, input.storeRoot)) === null) {
        if (input.registrationGenerations.length === 0 && input.archiveSha256s.length === 0) {
            return deepFreeze({
                status: 'hit',
                registrations: 0,
                objects: 0,
                logicalBytes: '0',
                registrationGenerations: [],
                archiveSha256s: [],
                cleanup: 'clean',
            });
        }
        throw new LocalPackageStoreError('STORE_ROOT_UNAVAILABLE', 'The local package store is unavailable');
    }
    const storeSnapshot = await snapshotDirectoryRoot(operations, input.storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const objectsRoot = join(input.storeRoot, 'objects');
    const registrationsRoot = join(input.storeRoot, REGISTRATIONS_DIRECTORY);
    const administration = await scanStoreAdminResidues(operations, input.storeRoot);
    if (administration.active?.marker.kind === 'prune') {
        try {
            await executePruneMarker(operations, input.storeRoot, administration.active.marker, signal);
            return deepFreeze({
                status: 'pruned',
                registrations: administration.active.marker.plan.registrations.length,
                objects: administration.active.marker.plan.objects.length,
                logicalBytes: administration.active.marker.plan.objects
                    .reduce((total, object) => total + BigInt(object.logicalByteSize), 0n)
                    .toString(10),
                registrationGenerations: administration.active.marker.plan.registrations.map((entry) => ({
                    registrationId: entry.registrationId,
                    generationSha256: entry.generationSha256,
                    project: entry.record.project,
                })),
                archiveSha256s: administration.active.marker.plan.objects.map(({ archiveSha256 }) => archiveSha256),
                cleanup: 'clean',
            });
        } catch (cause) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_INTERRUPTED',
                'The interrupted store prune could not be completed safely',
                cause,
            );
        }
    } else if (administration.active !== null || administration.stageNames.length > 0) {
        throw new LocalPackageStoreError('STORE_PRUNE_BLOCKED', 'Another store administration transaction is active');
    }
    if (input.registrationGenerations.length === 0 && input.archiveSha256s.length === 0) {
        return deepFreeze({
            status: 'hit',
            registrations: 0,
            objects: 0,
            logicalBytes: '0',
            registrationGenerations: [],
            archiveSha256s: [],
            cleanup: 'clean',
        });
    }
    if ((await lstatOrNull(operations, objectsRoot)) === null) {
        await ensureDirectory(operations, objectsRoot, 0o700);
    }
    if ((await lstatOrNull(operations, registrationsRoot)) === null) {
        await ensureDirectory(operations, registrationsRoot, 0o700);
    }
    const objectsSnapshot = await snapshotDirectoryRoot(operations, objectsRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const registrationsSnapshot = await snapshotDirectoryRoot(
        operations,
        registrationsRoot,
        'STORE_ROOT_UNAVAILABLE',
        0o700,
    );
    const references = await scanRegistrations(operations, registrationsRoot);
    if (references.corruptRegistrationIds.length > 0 || references.busyRegistrationIds.length > 0) {
        throw new LocalPackageStoreError('STORE_PRUNE_BLOCKED', 'The store registration index is not safe to prune');
    }
    const referenceByKey = new Map(
        references.references.map((reference) => [
            `${reference.marker.registrationId}.${reference.generationSha256}`,
            reference,
        ]),
    );
    const headByRoot = new Map<string, VerifiedProjectReference>();
    const projectAbsentByRoot = new Map<string, boolean>();
    for (const root of new Set(references.references.map(({ marker }) => marker.projectRoot))) {
        const head = registrationHead(references.references, root);
        if (head !== null) {
            headByRoot.set(root, head);
            projectAbsentByRoot.set(root, (await pathStatus(operations, root)) === 'missing');
        }
    }
    const registrationPlans: StorePruneRegistrationPlanEntry[] = [];
    for (const key of input.registrationGenerations) {
        const reference = referenceByKey.get(`${key.registrationId}.${key.generationSha256}`);
        if (reference === undefined) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_BLOCKED',
                'A requested registration generation is unavailable',
            );
        }
        const head = headByRoot.get(reference.marker.projectRoot);
        const projectAbsent = projectAbsentByRoot.get(reference.marker.projectRoot);
        if (head === undefined || projectAbsent === undefined) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_BLOCKED',
                'A requested registration history has no authenticated head',
            );
        }
        const reason = projectAbsent ? ('orphaned' as const) : ('superseded' as const);
        if (head === reference && !projectAbsent) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_BLOCKED',
                'A current registration may be retired only for a proven-absent project',
            );
        }
        const source = await readFileVerified(
            operations,
            reference.path,
            undefined,
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            reference.identity,
        );
        const headRead = await readFileVerified(
            operations,
            head.path,
            undefined,
            STORE_MARKER_LIMITS.maxProjectReferenceBytes,
            head.identity,
        );
        registrationPlans.push(
            deepFreeze({
                registrationId: reference.marker.registrationId,
                generationSha256: reference.generationSha256,
                reason,
                currentHead: {
                    registrationId: head.marker.registrationId,
                    generationSha256: head.generationSha256,
                    sha256: headRead.sha256,
                },
                sourceName: `${reference.marker.registrationId}.${reference.generationSha256}.json`,
                quarantineName: `.${reference.marker.registrationId}.${reference.generationSha256}.prune-PENDING.json`,
                identity: storedFileIdentity(identity(source.stats)),
                sha256: source.sha256,
                record: reference.marker,
            }),
        );
    }
    const protectedDigests = new Set<string>();
    for (const [root, head] of headByRoot) {
        if (projectAbsentByRoot.get(root) === false) {
            for (const digest of head.marker.archiveSha256s) {
                protectedDigests.add(digest);
            }
        }
    }
    const objectPlans: StorePruneObjectPlanEntry[] = [];
    let logicalBytes = 0n;
    for (const archiveSha256 of input.archiveSha256s) {
        if (protectedDigests.has(archiveSha256)) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_BLOCKED',
                'A requested object remains referenced by a registered project',
            );
        }
        const verified = await verifyObjectAt(operations, join(objectsRoot, archiveSha256), archiveSha256).catch(
            (cause: unknown) => {
                throw new LocalPackageStoreError(
                    'STORE_PRUNE_BLOCKED',
                    'A requested object is not fully authenticated',
                    cause,
                );
            },
        );
        const objectLogicalBytes = verified.marker.files.reduce(
            (total, file) => total + BigInt(file.byteSize),
            BigInt(verified.marker.archiveByteSize),
        );
        logicalBytes += objectLogicalBytes;
        objectPlans.push(
            deepFreeze({
                archiveSha256,
                sourceName: archiveSha256,
                quarantineName: `.${archiveSha256}.prune-PENDING`,
                identity: storedDirectoryIdentity(verified.identity),
                marker: verified.marker,
                closure: await closurePlan(operations, verified),
                logicalByteSize: objectLogicalBytes.toString(10),
            }),
        );
    }
    const token = operations.token();
    if (!TOKEN.test(token)) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The prune transaction token is invalid');
    }
    const withTokenRegistrations = registrationPlans.map((entry) =>
        deepFreeze({
            ...entry,
            quarantineName: `.${entry.registrationId}.${entry.generationSha256}.prune-${token}.json`,
        }),
    );
    const withTokenObjects = objectPlans.map((entry) =>
        deepFreeze({ ...entry, quarantineName: `.${entry.archiveSha256}.prune-${token}` }),
    );
    const storeNames = await readDirectoryBounded(operations, input.storeRoot, { entries: 16, nameBytes: 8192 });
    const objectNames = await readDirectoryBounded(operations, objectsRoot);
    const registrationNames = await readDirectoryBounded(operations, registrationsRoot);
    const marker: Extract<
        StoreAdminMarker,
        {
            readonly kind: 'prune';
        }
    > = deepFreeze({
        format: 'erden.store-admin-transaction/v1',
        kind: 'prune',
        token,
        basis: {
            store: storedDirectoryIdentity(storeSnapshot.target),
            objects: storedDirectoryIdentity(objectsSnapshot.target),
            registrations: storedDirectoryIdentity(registrationsSnapshot.target),
            storeEntriesSha256: directoryNamesSha256(storeNames),
            objectsEntriesSha256: directoryNamesSha256(objectNames),
            registrationsEntriesSha256: directoryNamesSha256(registrationNames),
        },
        plan: { registrations: withTokenRegistrations, objects: withTokenObjects },
    });
    const bytes = encodeStoreAdminMarker(marker);
    const stageName = `.erden.store-admin.stage-${token}.json`;
    const stagePath = join(input.storeRoot, stageName);
    await assertNoPortableSibling(operations, input.storeRoot, stageName, false, 'STORE_REPAIR_REQUIRED');
    await assertNoPortableSibling(operations, input.storeRoot, STORE_ADMIN_MARKER, false, 'STORE_REPAIR_REQUIRED');
    let stage: Awaited<ReturnType<typeof writeVerifiedFile>> | undefined;
    try {
        stage = await writeVerifiedFile(operations, stagePath, bytes, 0o444);
        await recheckDirectoryRoot(operations, input.storeRoot, storeSnapshot);
        await recheckDirectoryRoot(operations, objectsRoot, objectsSnapshot);
        await recheckDirectoryRoot(operations, registrationsRoot, registrationsSnapshot);
        signal.throwIfAborted();
        await operations.link(stagePath, join(input.storeRoot, STORE_ADMIN_MARKER));
        const active = await adminInspection(operations, input.storeRoot);
        if (
            active?.marker.kind !== 'prune' ||
            active.marker.token !== token ||
            active.bytesSha256 !== stage.sha256 ||
            active.identity.dev !== stage.identity.dev ||
            active.identity.ino !== stage.identity.ino
        ) {
            throw new Error('prune marker publication');
        }
        await executePruneMarker(operations, input.storeRoot, active.marker, signal);
    } catch (cause) {
        let active: Awaited<ReturnType<typeof adminInspection>>;
        try {
            active = await adminInspection(operations, input.storeRoot);
        } catch (inspectionError) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_INTERRUPTED',
                'The store prune administration truth became ambiguous',
                inspectionError,
            );
        }
        const activeIsOurs =
            active?.marker.kind === 'prune' &&
            active.marker.token === token &&
            stage !== undefined &&
            active.bytesSha256 === stage.sha256 &&
            active.identity.dev === stage.identity.dev &&
            active.identity.ino === stage.identity.ino;
        if (activeIsOurs) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_INTERRUPTED',
                'The store prune was interrupted and retained authenticated recovery evidence',
                cause,
            );
        }
        if (stage !== undefined && (await lstatOrNull(operations, stagePath)) !== null) {
            try {
                await removeAuthenticatedFile(
                    operations,
                    stagePath,
                    { identity: stage.identity, sha256: stage.sha256, bytes },
                    STORE_MARKER_LIMITS.maxAdminMarkerBytes,
                    validateAdminCleanup(marker),
                );
            } catch (cleanupError) {
                throw new LocalPackageStoreError(
                    'STORE_PRUNE_INTERRUPTED',
                    'The losing prune stage could not be retired safely',
                    cleanupError,
                );
            }
        }
        if (active !== null) {
            throw new LocalPackageStoreError(
                'STORE_PRUNE_BLOCKED',
                'Another store administration transaction became active',
                cause,
            );
        }
        throw cause;
    }
    return deepFreeze({
        status: 'pruned',
        registrations: marker.plan.registrations.length,
        objects: marker.plan.objects.length,
        logicalBytes: logicalBytes.toString(10),
        registrationGenerations: marker.plan.registrations.map((entry) => ({
            registrationId: entry.registrationId,
            generationSha256: entry.generationSha256,
            project: entry.record.project,
        })),
        archiveSha256s: marker.plan.objects.map(({ archiveSha256 }) => archiveSha256),
        cleanup: 'clean',
    });
}

async function* archiveChunks(source: PackageArchiveSource): AsyncIterable<Uint8Array> {
    if (source instanceof Uint8Array) {
        yield source;
        return;
    }
    const iterator = source[Symbol.asyncIterator]();
    try {
        for (;;) {
            const item = await iterator.next();
            if (item.done) {
                return;
            }
            if (!(item.value instanceof Uint8Array)) {
                throw new Error('archive chunk');
            }
            yield item.value;
        }
    } finally {
        await iterator.return?.();
    }
}

function teeArchive(
    operations: StoreNodeOperations,
    source: PackageArchiveSource,
    handle: FileHandle,
    state: {
        bytes: number;
        digest?: string;
        failure?: LocalPackageStoreError;
    },
    signal: AbortSignal,
): AsyncIterable<Uint8Array> {
    return {
        async *[Symbol.asyncIterator]() {
            const hash = createHash('sha256');
            for await (const chunk of archiveChunks(source)) {
                if (signal.aborted) {
                    throw new Error('aborted');
                }
                const chunkByteLength = chunk.byteLength;
                if (chunkByteLength > PACKAGE_CODEC_LIMITS.maxCompressedBytes - state.bytes) {
                    const failure = new LocalPackageStoreError(
                        'STORE_INVALID_INPUT',
                        'The package archive exceeds the closed compressed-byte bound',
                    );
                    state.failure = failure;
                    throw failure;
                }
                const snapshot = Uint8Array.from(chunk);
                if (snapshot.byteLength !== chunkByteLength) {
                    throw new Error('archive chunk changed');
                }
                await writeAll(operations, handle, snapshot);
                hash.update(snapshot);
                state.bytes += snapshot.byteLength;
                yield snapshot;
            }
            await operations.sync(handle);
            state.digest = hash.digest('hex');
        },
    };
}

async function protectExtractedPackage(
    operations: StoreNodeOperations,
    packageRoot: string,
    marker: StoreObjectMarker,
): Promise<void> {
    for (const file of marker.files) {
        await operations.chmod(safeJoin(packageRoot, file.path), file.logicalMode === 0o755 ? 0o555 : 0o444);
    }
    await operations.chmod(safeJoin(packageRoot, GENERATED_MANIFEST_PATH), 0o444);
    const directories = [...impliedDirectories(marker.files)].sort(
        (left, right) => right.split('/').length - left.split('/').length,
    );
    for (const directory of directories) {
        await operations.chmod(safeJoin(packageRoot, directory), 0o555);
    }
    await operations.chmod(packageRoot, 0o555);
}

async function putPackagePromise(
    input: PutPackageInput,
    fileSystem: StoreFileSystemPort,
    signal: AbortSignal,
): Promise<PutPackageResult> {
    const operations = fileSystem.operations;
    const storeRoot = assertAbsoluteRoot(input.storeRoot, 'The store root');
    const toolchain = decodeLockToolchain(input.toolchain);
    const expected = snapshotExpectedPackageNode(input.expected, toolchain);
    const archiveInput = input.archive;
    let archive: PackageArchiveSource;
    if (archiveInput instanceof Uint8Array) {
        const byteLength = archiveInput.byteLength;
        if (byteLength > PACKAGE_CODEC_LIMITS.maxCompressedBytes) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The package archive exceeds the closed compressed-byte bound',
            );
        }
        const snapshot = Uint8Array.from(archiveInput);
        if (snapshot.byteLength !== byteLength) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The package archive input changed while it was captured',
            );
        }
        archive = snapshot;
    } else {
        archive = archiveInput;
    }
    await ensureDirectory(operations, storeRoot, 0o700);
    await assertStoreAdministrationIdle(operations, storeRoot);
    const storeRootIdentity = await snapshotDirectoryRoot(operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    await assertStoreAdministrationIdle(operations, storeRoot);
    const objectsRoot = join(storeRoot, 'objects');
    const objectsBefore = await lstatOrNull(operations, objectsRoot);
    await assertNoPortableSibling(operations, storeRoot, 'objects', objectsBefore !== null);
    await ensureDirectory(operations, objectsRoot, 0o700);
    const objectsRootIdentity = await snapshotDirectoryRoot(operations, objectsRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const existing = await inspectObject(operations, storeRoot, expected.archiveSha256);
    if (existing.inspection.status === 'available') {
        if (
            existing.object === undefined ||
            existing.object.marker.canonicalIri !== expected.canonicalIri ||
            existing.object.marker.version !== expected.version ||
            !sameJson(existing.object.marker.dependencies, expected.dependencies) ||
            !sameJson(existing.object.marker.toolchain, toolchain)
        ) {
            throw new LocalPackageStoreError(
                'STORE_PACKAGE_IDENTITY_MISMATCH',
                'The existing store object does not match the requested locked package',
            );
        }
        await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        await recheckDirectoryRoot(operations, objectsRoot, objectsRootIdentity);
        return deepFreeze({
            status: 'hit',
            archiveSha256: expected.archiveSha256,
            canonicalIri: expected.canonicalIri,
            version: expected.version,
            fileCount: existing.object.marker.files.length,
        });
    }
    if (existing.inspection.status === 'busy') {
        throw new LocalPackageStoreError(
            'STORE_OBJECT_BUSY',
            'The locked package object is being created by another operation',
        );
    }
    if (existing.inspection.status === 'repair-required') {
        throw new LocalPackageStoreError(
            'STORE_REPAIR_REQUIRED',
            'The locked package object is corrupt and requires explicit repair',
        );
    }
    const token = operations.token();
    if (!TOKEN.test(token)) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The store transaction token is invalid');
    }
    const stageName = `.${expected.archiveSha256}.stage-${token}`;
    const finalName = expected.archiveSha256;
    await assertNoPortableSibling(operations, objectsRoot, stageName, false);
    await assertNoPortableSibling(operations, objectsRoot, finalName, false);
    const stageRoot = join(objectsRoot, stageName);
    const stageIdentity = await reserveTransactionDirectory(
        operations,
        stageRoot,
        'STORE_ROLLBACK_UNSAFE',
        'The store transaction reservation could not be authenticated',
    );
    const owned: OwnedTree = { root: stageIdentity, entries: new Map() };
    let validated: ValidatedPackageArchive | undefined;
    let archiveHandle: FileHandle | undefined;
    try {
        const archivePath = join(stageRoot, ARCHIVE_FILE);
        archiveHandle = await operations.open(archivePath, 'wx', 0o600);
        owned.entries.set(ARCHIVE_FILE, identity(await operations.stat(archiveHandle)));
        const state: {
            bytes: number;
            digest?: string;
            failure?: LocalPackageStoreError;
        } = { bytes: 0 };
        const source = teeArchive(operations, archive, archiveHandle, state, signal);
        try {
            validated = await Effect.runPromise(
                extractPackageArchive(
                    source,
                    { destination: join(stageRoot, PACKAGE_DIRECTORY) },
                    fileSystem.extractionOperations,
                ),
                { signal },
            );
        } catch (error) {
            throw state.failure ?? error;
        }
        await captureOwnedSubtree(operations, owned, stageRoot, PACKAGE_DIRECTORY);
        await operations.close(archiveHandle);
        archiveHandle = undefined;
        if (state.digest !== expected.archiveSha256 || validated.archiveSha256 !== expected.archiveSha256) {
            throw new LocalPackageStoreError(
                'STORE_ARCHIVE_DIGEST_MISMATCH',
                'The package archive bytes do not match the locked digest',
            );
        }
        assertManifestIdentity(validated.manifest, expected, toolchain);
        const marker = buildStoreObjectMarker(expected, toolchain, validated);
        await operations.chmod(archivePath, 0o444);
        await protectExtractedPackage(operations, join(stageRoot, PACKAGE_DIRECTORY), marker);
        const markerPath = join(stageRoot, STORE_MARKER);
        const markerHandle = await operations.open(markerPath, 'wx', 0o600);
        try {
            owned.entries.set(STORE_MARKER, identity(await operations.stat(markerHandle)));
            await writeAll(operations, markerHandle, encodeStoreObjectMarker(marker));
            await operations.sync(markerHandle);
        } finally {
            await operations.close(markerHandle);
        }
        await operations.chmod(markerPath, 0o444);
        await operations.chmod(stageRoot, 0o555);
        await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        await recheckDirectoryRoot(operations, objectsRoot, objectsRootIdentity);
        await assertNoPortableSibling(operations, objectsRoot, finalName, false);
        if (signal.aborted) {
            throw new Error('aborted');
        }
        await verifyObjectAt(operations, stageRoot, expected.archiveSha256, expected, toolchain);
        if (!(await pathTreeMatchesOwned(operations, stageRoot, owned))) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The package object stage ownership changed before publication',
            );
        }
        signal.throwIfAborted();
        const finalRoot = objectPath(storeRoot, expected.archiveSha256);
        let renameError: unknown;
        try {
            await operations.rename(stageRoot, finalRoot);
        } catch (error) {
            renameError = error;
        }
        try {
            await verifyObjectAt(operations, finalRoot, expected.archiveSha256, expected, toolchain);
        } catch (error) {
            const finalStats = await lstatOrNull(operations, finalRoot);
            if (finalStats !== null && sameIdentity(owned.root, finalStats)) {
                if (!(await removeOwnedTree(operations, finalRoot, owned))) {
                    throw new LocalPackageStoreError(
                        'STORE_ROLLBACK_UNSAFE',
                        'A failed object publication left residue whose ownership changed',
                        error,
                    );
                }
            }
            throw renameError ?? error;
        }
        await assertNoPortableSibling(operations, objectsRoot, finalName, true, 'STORE_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        await recheckDirectoryRoot(operations, objectsRoot, objectsRootIdentity);
        return deepFreeze({
            status: 'stored',
            archiveSha256: expected.archiveSha256,
            canonicalIri: expected.canonicalIri,
            version: expected.version,
            fileCount: marker.files.length,
        });
    } catch (error) {
        if (archiveHandle !== undefined) {
            await operations.close(archiveHandle).catch(() => undefined);
        }
        const stageNow = await lstatOrNull(operations, stageRoot).catch(() => null);
        if (
            stageNow !== null &&
            sameIdentity(stageIdentity, stageNow) &&
            !(await removeOwnedTree(operations, stageRoot, owned))
        ) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'Package ingest failed and left inert transaction residue whose ownership could not be proven',
                error,
            );
        }
        throw error;
    }
}

async function restoreObjectBackup(
    operations: StoreNodeOperations,
    objectsRoot: string,
    backupRoot: string,
    backupName: string,
    finalRoot: string,
    archiveSha256: string,
    previous: OwnedTree,
): Promise<void> {
    try {
        await assertNoPortableSibling(operations, objectsRoot, backupName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, archiveSha256, false, 'STORE_REPAIR_REQUIRED');
        if (!(await pathTreeMatchesSnapshot(operations, backupRoot, previous))) {
            throw new Error('backup changed');
        }
        await assertNoPortableSibling(operations, objectsRoot, backupName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, archiveSha256, false, 'STORE_REPAIR_REQUIRED');
        let renameFailure: unknown;
        try {
            await operations.rename(backupRoot, finalRoot);
        } catch (error) {
            renameFailure = error;
        }
        if (!(await pathTreeMatchesSnapshot(operations, finalRoot, previous))) {
            throw renameFailure instanceof Error ? renameFailure : new Error('restore changed');
        }
        await assertNoPortableSibling(operations, objectsRoot, backupName, false, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, archiveSha256, true, 'STORE_REPAIR_REQUIRED');
    } catch (error) {
        throw new LocalPackageStoreError(
            'STORE_ROLLBACK_UNSAFE',
            'The quarantined corrupt store object could not be restored safely',
            error,
        );
    }
}

async function repairPackagePromise(
    input: PutPackageInput,
    fileSystem: StoreFileSystemPort,
    signal: AbortSignal,
): Promise<RepairPackageResult> {
    const operations = fileSystem.operations;
    const storeRoot = assertAbsoluteRoot(input.storeRoot, 'The store root');
    const toolchain = decodeLockToolchain(input.toolchain);
    const expected = snapshotExpectedPackageNode(input.expected, toolchain);
    const archiveInput = input.archive;
    let archive: PackageArchiveSource;
    if (archiveInput instanceof Uint8Array) {
        const byteLength = archiveInput.byteLength;
        if (byteLength > PACKAGE_CODEC_LIMITS.maxCompressedBytes) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The package archive exceeds the closed compressed-byte bound',
            );
        }
        const snapshot = Uint8Array.from(archiveInput);
        if (snapshot.byteLength !== byteLength) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The package archive input changed while it was captured',
            );
        }
        archive = snapshot;
    } else {
        archive = archiveInput;
    }
    const storeRootIdentity = await snapshotDirectoryRoot(operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    await assertStoreAdministrationIdle(operations, storeRoot);
    const objectsRoot = join(storeRoot, 'objects');
    const objectsRootIdentity = await snapshotDirectoryRoot(operations, objectsRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    if (await hasObjectTransactionResidue(operations, objectsRoot, expected.archiveSha256)) {
        throw new LocalPackageStoreError(
            'STORE_OBJECT_BUSY',
            'The corrupt store object already has transaction residue',
        );
    }
    const existing = await inspectObject(operations, storeRoot, expected.archiveSha256);
    if (existing.inspection.status === 'missing') {
        throw new LocalPackageStoreError('STORE_OBJECT_MISSING', 'The corrupt store object disappeared before repair');
    }
    if (existing.inspection.status === 'busy') {
        throw new LocalPackageStoreError(
            'STORE_OBJECT_BUSY',
            'The corrupt store object is being changed by another operation',
        );
    }
    if (existing.inspection.status === 'available') {
        if (
            existing.object === undefined ||
            existing.object.marker.canonicalIri !== expected.canonicalIri ||
            existing.object.marker.version !== expected.version ||
            !sameJson(existing.object.marker.dependencies, expected.dependencies) ||
            !sameJson(existing.object.marker.toolchain, toolchain)
        ) {
            throw new LocalPackageStoreError(
                'STORE_PACKAGE_IDENTITY_MISMATCH',
                'The repaired store object does not match the requested locked package',
            );
        }
        return deepFreeze({
            status: 'repaired',
            cleanup: 'clean',
            archiveSha256: expected.archiveSha256,
            canonicalIri: expected.canonicalIri,
            version: expected.version,
            fileCount: existing.object.marker.files.length,
        });
    }
    const finalRoot = objectPath(storeRoot, expected.archiveSha256);
    const previous = await captureBoundedOwnedTree(operations, finalRoot);
    const token = operations.token();
    if (!TOKEN.test(token)) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The repair transaction token is invalid');
    }
    const stageName = `.${expected.archiveSha256}.stage-${token}`;
    const backupName = `.${expected.archiveSha256}.backup-${token}`;
    const stageRoot = join(objectsRoot, stageName);
    const backupRoot = join(objectsRoot, backupName);
    await assertNoPortableSibling(operations, objectsRoot, stageName, false, 'STORE_REPAIR_REQUIRED');
    await assertNoPortableSibling(operations, objectsRoot, backupName, false, 'STORE_REPAIR_REQUIRED');
    await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, true, 'STORE_REPAIR_REQUIRED');
    const stageIdentity = await reserveTransactionDirectory(
        operations,
        stageRoot,
        'STORE_ROLLBACK_UNSAFE',
        'The repair stage reservation could not be authenticated',
    );
    const constructionOwned: OwnedTree = { root: stageIdentity, entries: new Map() };
    let replacementOwned: OwnedTree | undefined;
    let archiveHandle: FileHandle | undefined;
    let previousBackedUp = false;
    let marker: StoreObjectMarker | undefined;
    try {
        await assertNoPortableSibling(operations, objectsRoot, stageName, true, 'STORE_REPAIR_REQUIRED');
        const archivePath = join(stageRoot, ARCHIVE_FILE);
        archiveHandle = await operations.open(archivePath, 'wx', 0o600);
        constructionOwned.entries.set(ARCHIVE_FILE, identity(await operations.stat(archiveHandle)));
        const state: {
            bytes: number;
            digest?: string;
            failure?: LocalPackageStoreError;
        } = { bytes: 0 };
        let validated: ValidatedPackageArchive;
        try {
            validated = await Effect.runPromise(
                extractPackageArchive(
                    teeArchive(operations, archive, archiveHandle, state, signal),
                    { destination: join(stageRoot, PACKAGE_DIRECTORY) },
                    fileSystem.extractionOperations,
                ),
                { signal },
            );
        } catch (error) {
            throw state.failure ?? error;
        }
        await captureOwnedSubtree(operations, constructionOwned, stageRoot, PACKAGE_DIRECTORY);
        await operations.close(archiveHandle);
        archiveHandle = undefined;
        if (state.digest !== expected.archiveSha256 || validated.archiveSha256 !== expected.archiveSha256) {
            throw new LocalPackageStoreError(
                'STORE_ARCHIVE_DIGEST_MISMATCH',
                'The repair archive bytes do not match the locked digest',
            );
        }
        assertManifestIdentity(validated.manifest, expected, toolchain);
        marker = buildStoreObjectMarker(expected, toolchain, validated);
        await operations.chmod(archivePath, 0o444);
        await protectExtractedPackage(operations, join(stageRoot, PACKAGE_DIRECTORY), marker);
        const markerPath = join(stageRoot, STORE_MARKER);
        const markerHandle = await operations.open(markerPath, 'wx', 0o600);
        try {
            constructionOwned.entries.set(STORE_MARKER, identity(await operations.stat(markerHandle)));
            await writeAll(operations, markerHandle, encodeStoreObjectMarker(marker));
            await operations.sync(markerHandle);
        } finally {
            await operations.close(markerHandle);
        }
        await operations.chmod(markerPath, 0o444);
        await operations.chmod(stageRoot, 0o555);
        const verifiedStage = await verifyObjectAt(operations, stageRoot, expected.archiveSha256, expected, toolchain);
        replacementOwned = ownedFromObject(verifiedStage);
        await assertNoPortableSibling(operations, objectsRoot, stageName, true, 'STORE_REPAIR_REQUIRED');
        if (!(await pathTreeMatchesSnapshot(operations, stageRoot, replacementOwned))) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The repair stage changed before the corrupt object was quarantined',
            );
        }
        await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        await recheckDirectoryRoot(operations, objectsRoot, objectsRootIdentity);
        await assertNoPortableSibling(operations, objectsRoot, stageName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, backupName, false, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, true, 'STORE_REPAIR_REQUIRED');
        if (!(await pathTreeMatchesSnapshot(operations, finalRoot, previous))) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The corrupt store object changed before quarantine',
            );
        }
        signal.throwIfAborted();
        await assertNoPortableSibling(operations, objectsRoot, stageName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, backupName, false, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, true, 'STORE_REPAIR_REQUIRED');
        let backupRenameFailure: unknown;
        try {
            await operations.rename(finalRoot, backupRoot);
        } catch (error) {
            backupRenameFailure = error;
        }
        const finalAfterBackup = await lstatOrNull(operations, finalRoot);
        const backupAfterRename = await lstatOrNull(operations, backupRoot);
        // If the canonical object disappeared, quarantine ownership is uncertain until the
        // exact backup name and identity are authenticated. Preserve the verified repair
        // stage as evidence when a case/NFC alias (or another ambiguous move) hides it.
        previousBackedUp = finalAfterBackup === null;
        if (
            finalAfterBackup !== null ||
            backupAfterRename === null ||
            !sameIdentity(previous.root, backupAfterRename)
        ) {
            throw backupRenameFailure instanceof Error
                ? backupRenameFailure
                : new LocalPackageStoreError(
                      'STORE_ROLLBACK_UNSAFE',
                      'The corrupt store object quarantine could not be authenticated',
                  );
        }
        await assertNoPortableSibling(operations, objectsRoot, stageName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, backupName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, false, 'STORE_REPAIR_REQUIRED');
        if (!(await pathTreeMatchesSnapshot(operations, backupRoot, previous))) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The quarantined corrupt store object changed before replacement publication',
            );
        }
        await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, false, 'STORE_REPAIR_REQUIRED');
        await verifyObjectAt(operations, stageRoot, expected.archiveSha256, expected, toolchain);
        if (!(await pathTreeMatchesSnapshot(operations, stageRoot, replacementOwned))) {
            throw new LocalPackageStoreError(
                'STORE_ROLLBACK_UNSAFE',
                'The verified repair stage changed before publication',
            );
        }
        signal.throwIfAborted();
        await assertNoPortableSibling(operations, objectsRoot, stageName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, backupName, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, false, 'STORE_REPAIR_REQUIRED');
        let publicationFailure: unknown;
        try {
            await operations.rename(stageRoot, finalRoot);
        } catch (error) {
            publicationFailure = error;
        }
        try {
            await verifyObjectAt(operations, finalRoot, expected.archiveSha256, expected, toolchain);
            if (!(await pathTreeMatchesSnapshot(operations, finalRoot, replacementOwned))) {
                throw new Error('published replacement identity');
            }
        } catch (error) {
            const current = await lstatOrNull(operations, finalRoot);
            if (current !== null) {
                if (
                    !sameIdentity(replacementOwned.root, current) ||
                    !(await removeOwnedTree(operations, finalRoot, replacementOwned, true))
                ) {
                    throw new LocalPackageStoreError(
                        'STORE_ROLLBACK_UNSAFE',
                        'The failed repaired object could not be removed safely',
                        error,
                    );
                }
            }
            await restoreObjectBackup(
                operations,
                objectsRoot,
                backupRoot,
                backupName,
                finalRoot,
                expected.archiveSha256,
                previous,
            );
            previousBackedUp = false;
            throw publicationFailure ?? error;
        }
        await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, true, 'STORE_REPAIR_REQUIRED');
        await assertNoPortableSibling(operations, objectsRoot, stageName, false, 'STORE_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        await recheckDirectoryRoot(operations, objectsRoot, objectsRootIdentity);
        let cleanup: 'clean' | 'cleanup-residue-retained' = 'cleanup-residue-retained';
        try {
            await assertNoPortableSibling(operations, objectsRoot, backupName, true, 'STORE_REPAIR_REQUIRED');
            cleanup = (await removeOwnedTree(operations, backupRoot, previous, true))
                ? 'clean'
                : 'cleanup-residue-retained';
        } catch {
            cleanup = 'cleanup-residue-retained';
        }
        await verifyObjectAt(operations, finalRoot, expected.archiveSha256, expected, toolchain);
        await assertNoPortableSibling(operations, objectsRoot, expected.archiveSha256, true, 'STORE_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        await recheckDirectoryRoot(operations, objectsRoot, objectsRootIdentity);
        return deepFreeze({
            status: 'repaired',
            cleanup,
            archiveSha256: expected.archiveSha256,
            canonicalIri: expected.canonicalIri,
            version: expected.version,
            fileCount: marker.files.length,
        });
    } catch (error) {
        if (archiveHandle !== undefined) {
            await operations.close(archiveHandle).catch(() => undefined);
        }
        if (previousBackedUp) {
            const current = await lstatOrNull(operations, finalRoot).catch(() => null);
            if (current !== null) {
                if (
                    replacementOwned === undefined ||
                    !sameIdentity(replacementOwned.root, current) ||
                    !(await removeOwnedTree(operations, finalRoot, replacementOwned, true))
                ) {
                    throw new LocalPackageStoreError(
                        'STORE_ROLLBACK_UNSAFE',
                        'Repair failed with an unrecognized object at the canonical digest',
                        error,
                    );
                }
            }
            await restoreObjectBackup(
                operations,
                objectsRoot,
                backupRoot,
                backupName,
                finalRoot,
                expected.archiveSha256,
                previous,
            );
            previousBackedUp = false;
        }
        const stageNow = await lstatOrNull(operations, stageRoot).catch(() => null);
        const cleanupOwned = replacementOwned ?? constructionOwned;
        if (stageNow !== null && sameIdentity(cleanupOwned.root, stageNow)) {
            try {
                await assertNoPortableSibling(operations, objectsRoot, stageName, true, 'STORE_REPAIR_REQUIRED');
            } catch (nameError) {
                throw new LocalPackageStoreError(
                    'STORE_ROLLBACK_UNSAFE',
                    'Repair failed after the stage lost its canonical transaction name',
                    nameError,
                );
            }
            if (!(await removeOwnedTree(operations, stageRoot, cleanupOwned))) {
                throw new LocalPackageStoreError(
                    'STORE_ROLLBACK_UNSAFE',
                    'Repair failed and left inert stage residue whose ownership could not be proven',
                    error,
                );
            }
        }
        throw error;
    }
}

async function inspectPackagePromise(
    input: InspectPackageInput,
    fileSystem: StoreFileSystemPort,
): Promise<PackageInspection> {
    const storeRoot = assertAbsoluteRoot(input.storeRoot, 'The store root');
    const rootStats = await lstatOrNull(fileSystem.operations, storeRoot);
    const snapshot =
        rootStats === null
            ? undefined
            : await snapshotDirectoryRoot(fileSystem.operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const result = await inspectObject(fileSystem.operations, storeRoot, input.archiveSha256);
    if (snapshot !== undefined) {
        await recheckDirectoryRoot(fileSystem.operations, storeRoot, snapshot);
    }
    return result.inspection;
}

async function availabilityPromise(
    input: VerifyLockAvailabilityInput,
    fileSystem: StoreFileSystemPort,
): Promise<{
    readonly availability: LockAvailability;
    readonly objects: ReadonlyMap<string, StoreObjectMarker>;
}> {
    const lock = decodeLockfileValue(input.lock);
    const storeRoot = assertAbsoluteRoot(input.storeRoot, 'The store root');
    const rootStats = await lstatOrNull(fileSystem.operations, storeRoot);
    const storeSnapshot =
        rootStats === null
            ? undefined
            : await snapshotDirectoryRoot(fileSystem.operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const objectsRoot = join(storeRoot, 'objects');
    const objectRootStats = rootStats === null ? null : await lstatOrNull(fileSystem.operations, objectsRoot);
    const objectsSnapshot =
        objectRootStats === null
            ? undefined
            : await snapshotDirectoryRoot(fileSystem.operations, objectsRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    const missing: string[] = [];
    const corrupt: string[] = [];
    const busy: string[] = [];
    const objects = new Map<string, StoreObjectMarker>();
    const uniqueDigests = [...new Set(lock.packages.map(({ archiveSha256 }) => archiveSha256))].sort(compareCodePoints);
    for (const archiveSha256 of uniqueDigests) {
        const result = await inspectObject(fileSystem.operations, storeRoot, archiveSha256);
        if (result.inspection.status === 'missing') {
            missing.push(archiveSha256);
        } else if (result.inspection.status === 'busy') {
            busy.push(archiveSha256);
        } else if (result.inspection.status === 'repair-required') {
            corrupt.push(archiveSha256);
        } else if (result.object !== undefined) {
            const matchingNodes = lock.packages.filter((node) => node.archiveSha256 === archiveSha256);
            try {
                for (const node of matchingNodes) {
                    await verifyObjectAt(
                        fileSystem.operations,
                        result.object.root,
                        archiveSha256,
                        node,
                        lock.toolchain,
                    );
                }
                objects.set(archiveSha256, result.object.marker);
            } catch {
                corrupt.push(archiveSha256);
            }
        }
    }
    if (storeSnapshot !== undefined) {
        await recheckDirectoryRoot(fileSystem.operations, storeRoot, storeSnapshot);
    }
    if (objectsSnapshot !== undefined) {
        await recheckDirectoryRoot(fileSystem.operations, objectsRoot, objectsSnapshot);
    }
    return deepFreeze({
        availability: {
            status: missing.length === 0 && corrupt.length === 0 && busy.length === 0 ? 'available' : 'unavailable',
            packages: uniqueDigests.length,
            missing,
            corrupt,
            busy,
        },
        objects,
    });
}

async function verifyLockAvailabilityPromise(
    input: VerifyLockAvailabilityInput,
    fileSystem: StoreFileSystemPort,
): Promise<LockAvailability> {
    return (await availabilityPromise(input, fileSystem)).availability;
}

function expectedInstalledClosure(
    marker: InstallMarker,
    objectMarkers: ReadonlyMap<string, StoreObjectMarker>,
): Set<string> {
    const expected = new Set<string>([INSTALL_MARKER, LAYERS_DIRECTORY]);
    for (const layer of marker.layers) {
        const base = `${LAYERS_DIRECTORY}/${layer.directory}`;
        expected.add(base);
        const object = objectMarkers.get(layer.archiveSha256);
        if (object === undefined) {
            throw new Error('missing object marker');
        }
        for (const directory of impliedDirectories(object.files)) {
            expected.add(`${base}/${directory}`);
        }
        for (const file of object.files) {
            expected.add(`${base}/${file.path}`);
        }
        expected.add(`${base}/${GENERATED_MANIFEST_PATH}`);
    }
    return expected;
}

async function verifyInstallAt(
    operations: StoreNodeOperations,
    installRoot: string,
    expectedLock?: LockfileV1,
): Promise<VerifiedInstall> {
    const rootStats = await operations.lstat(installRoot, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !modeMatches(operations, rootStats, 0o555)) {
        throw new Error('install root');
    }
    const markerPath = join(installRoot, INSTALL_MARKER);
    const markerIdentity = identity(await operations.lstat(markerPath, { bigint: true }));
    const markerRead = await readFileVerified(operations, markerPath, undefined, 64 * 1024 * 1024, markerIdentity);
    if (!modeMatches(operations, markerRead.stats, 0o444)) {
        throw new Error('install marker mode');
    }
    const marker = decodeInstallMarker(markerRead.bytes);
    if (
        expectedLock !== undefined &&
        (marker.lockSha256 !== lockSha256(expectedLock) ||
            marker.manifestDependencySha256 !== expectedLock.manifestDependencySha256 ||
            !sameJson(marker.toolchain, expectedLock.toolchain))
    ) {
        throw new Error('install lock binding');
    }
    if (expectedLock !== undefined && marker.layers.length !== expectedLock.packages.length) {
        throw new Error('install layer count');
    }
    const nodes = new Map((expectedLock?.packages ?? []).map((node) => [node.canonicalIri, node]));
    const objectMarkers = new Map<string, StoreObjectMarker>();
    const aggregate = new Map<string, FileIdentity>();
    aggregate.set(INSTALL_MARKER, markerIdentity);
    const layersPath = join(installRoot, LAYERS_DIRECTORY);
    const layersIdentity = identity(await operations.lstat(layersPath, { bigint: true }));
    if (layersIdentity.kind !== 'directory') {
        throw new Error('layers container');
    }
    aggregate.set(LAYERS_DIRECTORY, layersIdentity);
    let projectedEntries = 2;
    for (const layer of marker.layers) {
        const packageRoot = join(installRoot, LAYERS_DIRECTORY, layer.directory);
        const manifestPath = safeJoin(packageRoot, GENERATED_MANIFEST_PATH);
        const manifestIdentity = identity(await operations.lstat(manifestPath, { bigint: true }));
        const manifestRead = await readFileVerified(
            operations,
            manifestPath,
            undefined,
            PACKAGE_CODEC_LIMITS.maxEntryBytes,
            manifestIdentity,
        );
        if (manifestRead.sha256 !== layer.manifestSha256) {
            throw new Error('install manifest digest');
        }
        const manifest = decodeCanonicalPackageManifest(manifestRead.bytes);
        const expectedNode = nodes.get(layer.canonicalIri);
        const node: LockPackageNode = expectedNode ?? {
            canonicalIri: layer.canonicalIri,
            version: layer.version,
            archiveSha256: layer.archiveSha256,
            dependencies: manifest.dependencies,
        };
        if (node.version !== layer.version || node.archiveSha256 !== layer.archiveSha256) {
            throw new Error('install layer identity');
        }
        assertManifestIdentity(manifest, node, marker.toolchain);
        const storeMarker: StoreObjectMarker = deepFreeze({
            format: 'erden.store-object/v1',
            archiveSha256: node.archiveSha256,
            archiveByteSize: 1,
            manifestSha256: layer.manifestSha256,
            canonicalIri: node.canonicalIri,
            version: node.version,
            dependencies: node.dependencies,
            toolchain: marker.toolchain,
            files: manifest.files.map((file) => ({
                path: file.path,
                byteSize: file.byteSize,
                sha256: file.sha256,
                logicalMode: file.executable ? 0o755 : 0o644,
            })),
        });
        projectedEntries += 1 + storeMarker.files.length + impliedDirectories(storeMarker.files).size + 1;
        if (projectedEntries > LOCAL_PACKAGE_STORE_LIMITS.maxInstallEntries) {
            throw new Error('install aggregate entry bound');
        }
        const tree = await verifyPackageTree(operations, packageRoot, storeMarker);
        const base = `${LAYERS_DIRECTORY}/${layer.directory}`;
        aggregate.set(base, tree.root);
        for (const [path, entry] of tree.closure) {
            aggregate.set(`${base}/${path}`, entry.identity);
        }
        objectMarkers.set(node.archiveSha256, storeMarker);
    }
    const expected = expectedInstalledClosure(marker, objectMarkers);
    const closure = await collectClosure(operations, installRoot, expected.size);
    if (
        closure.size !== expected.size ||
        [...expected].some((path) => !closure.has(path)) ||
        aggregate.size !== expected.size
    ) {
        throw new Error('install closure');
    }
    for (const [path, expectedIdentity] of aggregate) {
        const entry = closure.get(path);
        if (entry === undefined || !sameSnapshot(entry.identity, expectedIdentity)) {
            throw new Error('install aggregate identity');
        }
    }
    const layersEntry = closure.get(LAYERS_DIRECTORY);
    if (layersEntry?.identity.kind !== 'directory') {
        throw new Error('layers container');
    }
    const layersStats = await operations.lstat(layersEntry.path, { bigint: true });
    if (!sameIdentity(layersEntry.identity, layersStats) || !modeMatches(operations, layersStats, 0o555)) {
        throw new Error('layers container identity');
    }
    const rootAfter = await operations.lstat(installRoot, { bigint: true });
    if (!sameIdentity(identity(rootStats), rootAfter) || rootStats.mode !== rootAfter.mode) {
        throw new Error('install root changed');
    }
    return deepFreeze({ marker, root: identity(rootAfter), closure, objectMarkers });
}

async function restoreAuthenticatedBackup(
    operations: StoreNodeOperations,
    backupRoot: string,
    installRoot: string,
    previous: OwnedTree,
): Promise<void> {
    try {
        await operations.rename(backupRoot, installRoot);
    } catch (error) {
        try {
            const restored = await verifyInstallAt(operations, installRoot);
            if (!installMatchesOwned(restored, previous)) {
                throw new Error('restored identity');
            }
            await assertNoPortableSibling(operations, dirname(installRoot), '.erden', true, 'INSTALL_REPAIR_REQUIRED');
            return;
        } catch {
            throw new LocalPackageStoreError(
                'INSTALL_ROLLBACK_UNSAFE',
                'The authenticated previous install could not be restored',
                error,
            );
        }
    }
    try {
        const restored = await verifyInstallAt(operations, installRoot);
        if (!installMatchesOwned(restored, previous)) {
            throw new Error('restored identity');
        }
        await assertNoPortableSibling(operations, dirname(installRoot), '.erden', true, 'INSTALL_REPAIR_REQUIRED');
    } catch (error) {
        throw new LocalPackageStoreError(
            'INSTALL_ROLLBACK_UNSAFE',
            'The authenticated previous install could not be restored',
            error,
        );
    }
}

function ownedFromInstall(verified: VerifiedInstall): OwnedTree {
    return {
        root: verified.root,
        entries: new Map([...verified.closure].map(([path, entry]) => [path, entry.identity])),
    };
}

function installMatchesOwned(verified: VerifiedInstall, owned: OwnedTree): boolean {
    return (
        verified.root.dev === owned.root.dev &&
        verified.root.ino === owned.root.ino &&
        verified.closure.size === owned.entries.size &&
        [...verified.closure].every(([path, entry]) => {
            const expected = owned.entries.get(path);
            return (
                expected !== undefined &&
                expected.dev === entry.identity.dev &&
                expected.ino === entry.identity.ino &&
                expected.kind === entry.identity.kind &&
                expected.mode === entry.identity.mode
            );
        })
    );
}

async function pathTreeMatchesOwned(operations: StoreNodeOperations, root: string, owned: OwnedTree): Promise<boolean> {
    const rootStats = await operations.lstat(root, { bigint: true });
    if (!sameIdentity(owned.root, rootStats)) {
        return false;
    }
    const closure = await collectClosure(operations, root, owned.entries.size);
    return (
        closure.size === owned.entries.size &&
        [...closure].every(([path, entry]) => {
            const expected = owned.entries.get(path);
            return (
                expected !== undefined &&
                expected.dev === entry.identity.dev &&
                expected.ino === entry.identity.ino &&
                expected.kind === entry.identity.kind
            );
        })
    );
}

async function recoverInterruptedMaterialization(
    operations: StoreNodeOperations,
    projectRoot: string,
    projectSnapshot: DirectoryRootSnapshot,
    lock: LockfileV1,
): Promise<'clean' | 'cleanup-residue-retained'> {
    const names = await readDirectoryBounded(operations, projectRoot);
    const transaction = /^\.erden\.(stage|backup)-([0-9A-Za-z_-]{16,128})$/u;
    const stages: Array<{
        readonly name: string;
        readonly token: string;
    }> = [];
    const backups: Array<{
        readonly name: string;
        readonly token: string;
    }> = [];
    for (const name of names) {
        const folded = name.toLowerCase();
        if (!folded.startsWith('.erden.stage-') && !folded.startsWith('.erden.backup-')) {
            continue;
        }
        const match = transaction.exec(name);
        const kind = match?.[1];
        const matchedToken = match?.[2];
        if (
            (kind !== 'stage' && kind !== 'backup') ||
            matchedToken === undefined ||
            portableNameKey(name) !== portableNameKey(`.erden.${kind}-${matchedToken}`)
        ) {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'A noncanonical materialization transaction name requires explicit repair',
            );
        }
        const record = Object.freeze({ name, token: matchedToken });
        if (kind === 'stage') {
            stages.push(record);
        } else {
            backups.push(record);
        }
    }
    if (stages.length > 1 || backups.length > 1) {
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'Multiple interrupted materialization transactions require explicit repair',
        );
    }
    if (stages[0] !== undefined && backups[0] !== undefined && stages[0].token !== backups[0].token) {
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'Interrupted materialization stage and backup tokens do not match',
        );
    }
    const installRoot = join(projectRoot, '.erden');
    const installStats = await lstatOrNull(operations, installRoot);
    await assertNoPortableSibling(operations, projectRoot, '.erden', installStats !== null, 'INSTALL_REPAIR_REQUIRED');
    const stageRoot = stages[0] === undefined ? undefined : join(projectRoot, stages[0].name);
    const backupRoot = backups[0] === undefined ? undefined : join(projectRoot, backups[0].name);
    if (installStats !== null) {
        await verifyInstallAt(operations, installRoot);
        if (stageRoot !== undefined) {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'A current install and interrupted stage coexist and require explicit repair',
            );
        }
        if (backupRoot === undefined) {
            await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
            return 'clean';
        }
        const backup = await verifyInstallAt(operations, backupRoot);
        await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
        const cleanup = (await removeOwnedTree(operations, backupRoot, ownedFromInstall(backup)))
            ? 'clean'
            : 'cleanup-residue-retained';
        await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
        return cleanup;
    }
    let backup: VerifiedInstall | undefined;
    if (backupRoot !== undefined) {
        backup = await verifyInstallAt(operations, backupRoot);
    }
    if (stageRoot !== undefined) {
        let stage: VerifiedInstall;
        try {
            stage = await verifyInstallAt(operations, stageRoot, lock);
            const stageAtCommit = await verifyInstallAt(operations, stageRoot, lock);
            if (!installMatchesOwned(stageAtCommit, ownedFromInstall(stage))) {
                throw new Error('recovery stage changed');
            }
            await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
            try {
                await operations.rename(stageRoot, installRoot);
            } catch (error) {
                try {
                    await verifyInstallAt(operations, installRoot, lock);
                } catch {
                    if (backup !== undefined && backupRoot !== undefined) {
                        await restoreAuthenticatedBackup(operations, backupRoot, installRoot, ownedFromInstall(backup));
                    }
                    throw error;
                }
            }
            await verifyInstallAt(operations, installRoot, lock);
            await assertNoPortableSibling(operations, projectRoot, '.erden', true, 'INSTALL_REPAIR_REQUIRED');
            await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
            if (backup === undefined || backupRoot === undefined) {
                return 'clean';
            }
            await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
            const cleanup = (await removeOwnedTree(operations, backupRoot, ownedFromInstall(backup)))
                ? 'clean'
                : 'cleanup-residue-retained';
            await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
            return cleanup;
        } catch (error) {
            if (backup !== undefined && backupRoot !== undefined) {
                await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
                await restoreAuthenticatedBackup(operations, backupRoot, installRoot, ownedFromInstall(backup));
                throw new LocalPackageStoreError(
                    'INSTALL_BUSY',
                    'The previous install was restored but an interrupted stage requires explicit repair',
                    error,
                );
            }
            throw new LocalPackageStoreError(
                'INSTALL_BUSY',
                'An interrupted materialization stage could not be authenticated',
                error,
            );
        }
    }
    if (backup !== undefined && backupRoot !== undefined) {
        await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
        await restoreAuthenticatedBackup(operations, backupRoot, installRoot, ownedFromInstall(backup));
        await assertNoPortableSibling(operations, projectRoot, '.erden', true, 'INSTALL_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, projectRoot, projectSnapshot);
        return 'clean';
    }
    return 'clean';
}

async function inspectInstallPromise(
    input: InspectInstallInput,
    fileSystem: StoreFileSystemPort,
): Promise<InstallInspection> {
    const projectRoot = assertAbsoluteRoot(input.projectRoot, 'The project root');
    const projectSnapshot = await snapshotDirectoryRoot(fileSystem.operations, projectRoot, 'INSTALL_REPAIR_REQUIRED');
    const lock = decodeLockfileValue(input.lock);
    const installRoot = join(projectRoot, '.erden');
    const stats = await lstatOrNull(fileSystem.operations, installRoot);
    await assertNoPortableSibling(
        fileSystem.operations,
        projectRoot,
        '.erden',
        stats !== null,
        'INSTALL_REPAIR_REQUIRED',
    );
    async function finish(value: InstallInspection): Promise<InstallInspection> {
        await assertNoPortableSibling(
            fileSystem.operations,
            projectRoot,
            '.erden',
            stats !== null,
            'INSTALL_REPAIR_REQUIRED',
        );
        await recheckDirectoryRoot(fileSystem.operations, projectRoot, projectSnapshot);
        return value;
    }
    if (stats === null) {
        const names = await readDirectoryBounded(fileSystem.operations, projectRoot);
        let busy = false;
        for (const name of names) {
            if (!name.startsWith('.erden.stage-') || !TOKEN.test(name.slice('.erden.stage-'.length))) {
                continue;
            }
            const entry = await lstatOrNull(fileSystem.operations, join(projectRoot, name));
            if (entry?.isDirectory() === true && !entry.isSymbolicLink()) {
                busy = true;
            }
        }
        return await finish(
            deepFreeze({ status: busy ? 'busy' : 'missing', manifestDependencySha256: null, packages: null }),
        );
    }
    let result: InstallInspection;
    try {
        const { marker } = await verifyInstallAt(fileSystem.operations, installRoot, lock);
        result = deepFreeze({
            status: 'available',
            manifestDependencySha256: marker.manifestDependencySha256,
            packages: marker.layers.length,
        });
    } catch {
        try {
            const { marker } = await verifyInstallAt(fileSystem.operations, installRoot);
            result = deepFreeze({
                status: 'stale',
                manifestDependencySha256: marker.manifestDependencySha256,
                packages: marker.layers.length,
            });
        } catch {
            result = deepFreeze({ status: 'repair-required', manifestDependencySha256: null, packages: null });
        }
    }
    return await finish(result);
}

async function importPackageTree(
    fileSystem: StoreFileSystemPort,
    sourceRoot: string,
    destinationRoot: string,
    marker: StoreObjectMarker,
    stageRoot: string,
    owned: OwnedTree,
): Promise<Record<'clone' | 'hardlink' | 'copy', number>> {
    const operations = fileSystem.operations;
    const counts = { clone: 0, hardlink: 0, copy: 0 };
    await operations.mkdir(destinationRoot, { mode: 0o700 });
    await captureOwnedPath(operations, owned, stageRoot, relative(stageRoot, destinationRoot).replaceAll('\\', '/'));
    for (const directory of [...impliedDirectories(marker.files)].sort(compareCodePoints)) {
        await operations.mkdir(safeJoin(destinationRoot, directory), { recursive: true, mode: 0o700 });
        const destinationLogical = relative(stageRoot, safeJoin(destinationRoot, directory)).replaceAll('\\', '/');
        const parts = destinationLogical.split('/');
        for (let index = 1; index <= parts.length; index += 1) {
            const part = parts.slice(0, index).join('/');
            if (!owned.entries.has(part)) {
                await captureOwnedPath(operations, owned, stageRoot, part);
            }
        }
    }
    const files = [...marker.files.map(({ path }) => path), GENERATED_MANIFEST_PATH].sort(compareCodePoints);
    for (const path of files) {
        const source = safeJoin(sourceRoot, path);
        const destination = safeJoin(destinationRoot, path);
        const strategy = await fileSystem.importFile(source, destination);
        await captureOwnedPath(operations, owned, stageRoot, relative(stageRoot, destination).replaceAll('\\', '/'));
        counts[strategy] += 1;
        if (strategy !== 'hardlink') {
            const logical = marker.files.find((file) => file.path === path)?.logicalMode ?? 0o644;
            await operations.chmod(destination, logical === 0o755 ? 0o555 : 0o444);
        }
    }
    for (const directory of [...impliedDirectories(marker.files)].sort((left, right) => right.length - left.length)) {
        await operations.chmod(safeJoin(destinationRoot, directory), 0o555);
    }
    await operations.chmod(destinationRoot, 0o555);
    await verifyPackageTree(operations, sourceRoot, marker);
    await verifyPackageTree(operations, destinationRoot, marker);
    await verifyPackageTree(operations, sourceRoot, marker);
    return counts;
}

async function materializePromise(
    input: MaterializeLockInput,
    fileSystem: StoreFileSystemPort,
    signal: AbortSignal,
): Promise<MaterializeLockResult> {
    const lock = decodeLockfileValue(input.lock);
    const projectRoot = assertAbsoluteRoot(input.projectRoot, 'The project root');
    const storeRoot = assertAbsoluteRoot(input.storeRoot, 'The store root');
    const operations = fileSystem.operations;
    const projectRootIdentity = await snapshotDirectoryRoot(operations, projectRoot, 'INSTALL_REPAIR_REQUIRED');
    if ((await lstatOrNull(operations, storeRoot)) !== null) {
        await assertStoreAdministrationIdle(operations, storeRoot);
    }
    const availability = await availabilityPromise({ storeRoot, lock }, fileSystem);
    if (availability.availability.status !== 'available') {
        if (availability.availability.busy.length > 0) {
            throw new LocalPackageStoreError(
                'STORE_OBJECT_BUSY',
                'The locked package closure contains busy store objects',
            );
        }
        if (availability.availability.corrupt.length > 0) {
            throw new LocalPackageStoreError(
                'STORE_REPAIR_REQUIRED',
                'The locked package closure contains corrupt store objects that require repair',
            );
        }
        throw new LocalPackageStoreError(
            'STORE_OBJECT_MISSING',
            'The locked package closure contains missing store objects',
        );
    }
    const storeRootIdentity =
        lock.packages.length === 0
            ? undefined
            : await snapshotDirectoryRoot(operations, storeRoot, 'STORE_ROOT_UNAVAILABLE', 0o700);
    let installEntries = 2;
    for (const object of availability.objects.values()) {
        installEntries += 1 + object.files.length + impliedDirectories(object.files).size + 1;
        if (installEntries > LOCAL_PACKAGE_STORE_LIMITS.maxInstallEntries) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The locked install closure exceeds the local materialization entry bound',
            );
        }
    }
    const recoveryCleanup = await recoverInterruptedMaterialization(operations, projectRoot, projectRootIdentity, lock);
    const current = await inspectInstallPromise({ projectRoot, lock }, fileSystem);
    if (current.status === 'available') {
        await recheckDirectoryRoot(operations, projectRoot, projectRootIdentity);
        if (storeRootIdentity !== undefined) {
            await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        }
        return deepFreeze({
            status: 'hit',
            cleanup: recoveryCleanup,
            manifestDependencySha256: lock.manifestDependencySha256,
            packages: lock.packages.length,
            strategies: { clone: 0, hardlink: 0, copy: 0 },
        });
    }
    if (current.status === 'busy') {
        throw new LocalPackageStoreError('INSTALL_BUSY', 'A project materialization transaction is already active');
    }
    if (current.status === 'repair-required') {
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'The existing project install is corrupt and requires explicit repair',
        );
    }
    const token = operations.token();
    if (!TOKEN.test(token)) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The materialization transaction token is invalid');
    }
    const stageName = `.erden.stage-${token}`;
    const backupName = `.erden.backup-${token}`;
    const installRoot = join(projectRoot, '.erden');
    const backupRoot = join(projectRoot, backupName);
    await assertNoPortableSibling(operations, projectRoot, stageName, false);
    await assertNoPortableSibling(operations, projectRoot, backupName, false);
    await assertNoPortableSibling(operations, projectRoot, '.erden', current.status === 'stale');
    let previous: OwnedTree | undefined;
    if (current.status === 'stale') {
        const previousVerified = await verifyInstallAt(operations, installRoot);
        previous = {
            root: previousVerified.root,
            entries: new Map([...previousVerified.closure].map(([path, entry]) => [path, entry.identity])),
        };
    }
    const stageRoot = join(projectRoot, stageName);
    const stageIdentity = await reserveTransactionDirectory(
        operations,
        stageRoot,
        'INSTALL_ROLLBACK_UNSAFE',
        'The materialization transaction reservation could not be authenticated',
    );
    const owned: OwnedTree = { root: stageIdentity, entries: new Map() };
    const totals = { clone: 0, hardlink: 0, copy: 0 };
    let previousBackedUp = false;
    try {
        await operations.mkdir(join(stageRoot, LAYERS_DIRECTORY), { mode: 0o700 });
        await captureOwnedPath(operations, owned, stageRoot, LAYERS_DIRECTORY);
        const marker = buildInstallMarker(lock, availability.objects);
        for (const layer of marker.layers) {
            if (signal.aborted) {
                throw new Error('aborted');
            }
            const source = join(objectPath(storeRoot, layer.archiveSha256), PACKAGE_DIRECTORY);
            const destination = join(stageRoot, LAYERS_DIRECTORY, layer.directory);
            const object = availability.objects.get(layer.archiveSha256);
            if (object === undefined) {
                throw new Error('object vanished');
            }
            await verifyObjectAt(operations, objectPath(storeRoot, layer.archiveSha256), layer.archiveSha256);
            const counts = await importPackageTree(fileSystem, source, destination, object, stageRoot, owned);
            totals.clone += counts.clone;
            totals.hardlink += counts.hardlink;
            totals.copy += counts.copy;
            await verifyObjectAt(operations, objectPath(storeRoot, layer.archiveSha256), layer.archiveSha256);
        }
        await operations.chmod(join(stageRoot, LAYERS_DIRECTORY), 0o555);
        const markerHandle = await operations.open(join(stageRoot, INSTALL_MARKER), 'wx', 0o600);
        try {
            owned.entries.set(INSTALL_MARKER, identity(await operations.stat(markerHandle)));
            await writeAll(operations, markerHandle, encodeInstallMarker(marker));
            await operations.sync(markerHandle);
        } finally {
            await operations.close(markerHandle);
        }
        await operations.chmod(join(stageRoot, INSTALL_MARKER), 0o444);
        await operations.chmod(stageRoot, 0o555);
        await recheckDirectoryRoot(operations, projectRoot, projectRootIdentity);
        if (storeRootIdentity !== undefined) {
            await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        }
        if (signal.aborted) {
            throw new Error('aborted');
        }
        await assertNoPortableSibling(operations, projectRoot, '.erden', previous !== undefined);
        if (previous !== undefined) {
            const previousAtCommit = await verifyInstallAt(operations, installRoot);
            if (!installMatchesOwned(previousAtCommit, previous)) {
                throw new LocalPackageStoreError(
                    'INSTALL_ROLLBACK_UNSAFE',
                    'The authenticated previous install changed before the swap',
                );
            }
            try {
                await operations.rename(installRoot, backupRoot);
            } catch (error) {
                const oldNow = await lstatOrNull(operations, installRoot);
                const backupNow = await lstatOrNull(operations, backupRoot);
                if (oldNow !== null || backupNow === null || !sameIdentity(previous.root, backupNow)) {
                    throw error;
                }
            }
            try {
                await verifyInstallAt(operations, backupRoot);
                previousBackedUp = true;
            } catch (error) {
                const targetNow = await lstatOrNull(operations, installRoot);
                if (targetNow === null) {
                    await restoreAuthenticatedBackup(operations, backupRoot, installRoot, previous);
                    previousBackedUp = false;
                } else {
                    throw new LocalPackageStoreError(
                        'INSTALL_ROLLBACK_UNSAFE',
                        'The previous install move could not be authenticated',
                        error,
                    );
                }
                throw error;
            }
        }
        await verifyInstallAt(operations, stageRoot, lock);
        if (!(await pathTreeMatchesOwned(operations, stageRoot, owned))) {
            throw new LocalPackageStoreError(
                'INSTALL_ROLLBACK_UNSAFE',
                'The materialization stage ownership changed before publication',
            );
        }
        signal.throwIfAborted();
        let renameError: unknown;
        try {
            await operations.rename(stageRoot, installRoot);
        } catch (error) {
            renameError = error;
        }
        try {
            await verifyInstallAt(operations, installRoot, lock);
        } catch (error) {
            const published = await lstatOrNull(operations, installRoot);
            if (published !== null) {
                if (!sameIdentity(owned.root, published) || !(await removeOwnedTree(operations, installRoot, owned))) {
                    throw new LocalPackageStoreError(
                        'INSTALL_ROLLBACK_UNSAFE',
                        'The failed new install could not be removed with authenticated ownership',
                        error,
                    );
                }
            }
            if (previous !== undefined) {
                const backupNow = await lstatOrNull(operations, backupRoot);
                if (backupNow === null || !sameIdentity(previous.root, backupNow)) {
                    throw new LocalPackageStoreError(
                        'INSTALL_ROLLBACK_UNSAFE',
                        'The authenticated previous install backup changed during the failed swap',
                        error,
                    );
                }
                await restoreAuthenticatedBackup(operations, backupRoot, installRoot, previous);
                previousBackedUp = false;
            }
            throw renameError ?? error;
        }
        await assertNoPortableSibling(operations, projectRoot, '.erden', true, 'INSTALL_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, projectRoot, projectRootIdentity);
        if (storeRootIdentity !== undefined) {
            await recheckDirectoryRoot(operations, storeRoot, storeRootIdentity);
        }
        const cleanup =
            previous !== undefined && !(await removeOwnedTree(operations, backupRoot, previous))
                ? ('cleanup-residue-retained' as const)
                : ('clean' as const);
        return deepFreeze({
            status: 'materialized',
            cleanup,
            manifestDependencySha256: lock.manifestDependencySha256,
            packages: lock.packages.length,
            strategies: totals,
        });
    } catch (error) {
        if (previous !== undefined && previousBackedUp) {
            const currentInstall = await lstatOrNull(operations, installRoot).catch(() => null);
            if (currentInstall === null) {
                await restoreAuthenticatedBackup(operations, backupRoot, installRoot, previous);
                previousBackedUp = false;
            }
        }
        const currentStage = await lstatOrNull(operations, stageRoot).catch(() => null);
        if (currentStage !== null && sameIdentity(stageIdentity, currentStage)) {
            if (isLocalPackageStoreError(error) && error.code === 'INSTALL_ROLLBACK_UNSAFE') {
                throw error;
            }
            if (!(await removeOwnedTree(operations, stageRoot, owned))) {
                throw new LocalPackageStoreError(
                    'INSTALL_ROLLBACK_UNSAFE',
                    'Materialization failed and left inert transaction residue whose ownership could not be proven',
                    error,
                );
            }
        }
        throw error;
    }
}

async function pathForLayerPromise(
    input: PathForLayerInput,
    fileSystem: StoreFileSystemPort,
): Promise<ResolvedLayerPath> {
    const projectRoot = assertAbsoluteRoot(input.projectRoot, 'The project root');
    const projectRootIdentity = await snapshotDirectoryRoot(
        fileSystem.operations,
        projectRoot,
        'INSTALL_REPAIR_REQUIRED',
    );
    const lock = decodeLockfileValue(input.lock);
    const identifier = input.identifier;
    if (typeof identifier !== 'string' || identifier.length === 0 || !identifier.isWellFormed()) {
        throw new LocalPackageStoreError(
            'STORE_INVALID_INPUT',
            'A dependency layer identifier must be one well-formed nonempty string',
        );
    }
    const installRoot = join(projectRoot, '.erden');
    const installStats = await lstatOrNull(fileSystem.operations, installRoot);
    await assertNoPortableSibling(
        fileSystem.operations,
        projectRoot,
        '.erden',
        installStats !== null,
        'INSTALL_REPAIR_REQUIRED',
    );
    const verified = await verifyInstallAt(fileSystem.operations, installRoot, lock).catch((error: unknown) => {
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'The project install cannot be authenticated',
            error,
        );
    });
    await assertNoPortableSibling(fileSystem.operations, projectRoot, '.erden', true, 'INSTALL_REPAIR_REQUIRED');
    await recheckDirectoryRoot(fileSystem.operations, projectRoot, projectRootIdentity);
    const layer = verified.marker.layers.find(({ identifiers }) => identifiers.includes(identifier));
    if (layer === undefined) {
        throw new LocalPackageStoreError(
            'LAYER_NOT_FOUND',
            'The requested dependency layer is not present in the authenticated install',
        );
    }
    const path = join(installRoot, LAYERS_DIRECTORY, layer.directory);
    const contained = relative(installRoot, path);
    if (contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'The authenticated layer path escapes the project install',
        );
    }
    return deepFreeze({
        identifier,
        canonicalIri: layer.canonicalIri,
        version: layer.version,
        archiveSha256: layer.archiveSha256,
        path,
    });
}

async function resolveInstalledClosurePromise(
    input: InspectInstallInput,
    fileSystem: StoreFileSystemPort,
    capture?: (closure: ResolvedInstalledClosure, capability: InstalledClosureCapability) => void,
): Promise<ResolvedInstalledClosure> {
    const projectRoot = assertAbsoluteRoot(input.projectRoot, 'The project root');
    const lock = decodeLockfileValue(input.lock);
    const projectSnapshot = await snapshotDirectoryRoot(fileSystem.operations, projectRoot, 'INSTALL_REPAIR_REQUIRED');
    const installRoot = join(projectRoot, '.erden');
    const installStats = await lstatOrNull(fileSystem.operations, installRoot);
    await assertNoPortableSibling(
        fileSystem.operations,
        projectRoot,
        '.erden',
        installStats !== null,
        'INSTALL_REPAIR_REQUIRED',
    );
    if (installStats === null) {
        throw new LocalPackageStoreError('INSTALL_MISSING', 'The exact locked project installation is missing');
    }
    const verified = await verifyInstallAt(fileSystem.operations, installRoot, lock).catch((error: unknown) => {
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'The exact locked project installation cannot be authenticated',
            error,
        );
    });
    const layersByIri = new Map(verified.marker.layers.map((layer) => [layer.canonicalIri, layer]));
    const layers = lock.packages.map((node) => {
        const layer = layersByIri.get(node.canonicalIri);
        if (layer === undefined || layer.version !== node.version || layer.archiveSha256 !== node.archiveSha256) {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'The authenticated install marker does not match canonical lock order',
            );
        }
        const root = join(installRoot, LAYERS_DIRECTORY, layer.directory);
        const contained = relative(installRoot, root);
        if (contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'An authenticated dependency layer escapes the project installation',
            );
        }
        const marker = verified.objectMarkers.get(node.archiveSha256);
        const generatedIdentity = verified.closure.get(
            `${LAYERS_DIRECTORY}/${layer.directory}/${GENERATED_MANIFEST_PATH}`,
        )?.identity;
        if (
            marker === undefined ||
            generatedIdentity?.kind !== 'file' ||
            generatedIdentity.size < 0n ||
            generatedIdentity.size > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'The authenticated dependency layer file index is incomplete',
            );
        }
        return Object.freeze({
            canonicalIri: node.canonicalIri,
            version: node.version,
            archiveSha256: node.archiveSha256,
            identifiers: Object.freeze([...layer.identifiers]),
            root,
            files: Object.freeze(
                [
                    ...marker.files.map((file) =>
                        Object.freeze({
                            path: file.path,
                            byteSize: file.byteSize,
                            sha256: file.sha256,
                            logicalMode: file.logicalMode,
                        }),
                    ),
                    Object.freeze({
                        path: GENERATED_MANIFEST_PATH,
                        byteSize: Number(generatedIdentity.size),
                        sha256: layer.manifestSha256,
                        logicalMode: 0o644 as const,
                    }),
                ].sort((left, right) => compareCodePoints(left.path, right.path)),
            ),
        });
    });
    await assertNoPortableSibling(fileSystem.operations, projectRoot, '.erden', true, 'INSTALL_REPAIR_REQUIRED');
    await recheckDirectoryRoot(fileSystem.operations, projectRoot, projectSnapshot);
    const finalClosure = await collectClosure(fileSystem.operations, installRoot, verified.closure.size);
    const finalRoot = await fileSystem.operations.lstat(installRoot, { bigint: true });
    if (
        !sameClosure(verified.closure, finalClosure) ||
        !sameIdentity(verified.root, finalRoot) ||
        verified.root.mode !== finalRoot.mode
    ) {
        throw new LocalPackageStoreError(
            'INSTALL_REPAIR_REQUIRED',
            'The authenticated project installation changed before its closure was returned',
        );
    }
    const result = deepFreeze({
        lockSha256: verified.marker.lockSha256,
        manifestDependencySha256: verified.marker.manifestDependencySha256,
        toolchain: decodeLockToolchain(verified.marker.toolchain),
        layers,
    });
    capture?.(
        result,
        Object.freeze({
            projectRoot,
            projectSnapshot,
            installRoot,
            verified,
            layerDirectories: new Map(verified.marker.layers.map((layer) => [layer.canonicalIri, layer.directory])),
        }),
    );
    return result;
}

function authenticatedInstalledFile(
    input: ReadInstalledLayerFileInput,
    capability: InstalledClosureCapability,
    operations: StoreNodeOperations,
): Promise<AuthenticatedInstalledFile> {
    return (async () => {
        let path: string;
        try {
            path = normalizePackagePath(input.path);
        } catch (cause) {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The installed package file path is invalid',
                cause,
            );
        }
        if (path !== input.path || typeof input.canonicalIri !== 'string') {
            throw new LocalPackageStoreError(
                'STORE_INVALID_INPUT',
                'The installed package file request is not canonical',
            );
        }
        const layer = input.closure.layers.find((item) => item.canonicalIri === input.canonicalIri);
        const directory = capability.layerDirectories.get(input.canonicalIri);
        const expected = layer?.files.find((file) => file.path === path);
        if (layer === undefined || directory === undefined || expected === undefined) {
            throw new LocalPackageStoreError(
                'LAYER_NOT_FOUND',
                'The authenticated installed package file is not present',
            );
        }
        const closurePath = `${LAYERS_DIRECTORY}/${directory}/${path}`;
        const entry = capability.verified.closure.get(closurePath);
        if (entry?.identity.kind !== 'file') {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'The authenticated installed package file is unavailable',
            );
        }
        const read = await readFileVerified(
            operations,
            entry.path,
            expected.byteSize,
            expected.byteSize,
            entry.identity,
        );
        const expectedPhysical = expected.logicalMode === 0o755 ? 0o555 : 0o444;
        if (read.sha256 !== expected.sha256 || !modeMatches(operations, read.stats, expectedPhysical)) {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'The authenticated installed package file changed before it was consumed',
            );
        }
        await assertNoPortableSibling(operations, capability.projectRoot, '.erden', true, 'INSTALL_REPAIR_REQUIRED');
        await recheckDirectoryRoot(operations, capability.projectRoot, capability.projectSnapshot);
        const installAfter = await operations.lstat(capability.installRoot, { bigint: true });
        if (
            !sameIdentity(capability.verified.root, installAfter) ||
            capability.verified.root.mode !== installAfter.mode
        ) {
            throw new LocalPackageStoreError(
                'INSTALL_REPAIR_REQUIRED',
                'The authenticated project installation changed while a package file was consumed',
            );
        }
        const bytes = Uint8Array.from(read.bytes);
        return Object.freeze({
            path: expected.path,
            byteSize: expected.byteSize,
            sha256: expected.sha256,
            logicalMode: expected.logicalMode,
            get bytes(): Uint8Array {
                return Uint8Array.from(bytes);
            },
        });
    })();
}

export const InstalledClosureReader = Context.Service<InstalledClosureReaderShape>(
    '@erden/project/InstalledClosureReader',
);

export function makeInstalledClosureReader(
    fileSystem: StoreFileSystemPort = makeNodeStoreFileSystemPort(),
): InstalledClosureReaderShape {
    const capabilities = new WeakMap<ResolvedInstalledClosure, InstalledClosureCapability>();
    return Object.freeze({
        resolve: (input: InspectInstallInput) =>
            fromAbortableStorePromise(
                async () =>
                    await resolveInstalledClosurePromise(input, fileSystem, (closure, capability) =>
                        capabilities.set(closure, capability),
                    ),
            ),
        readFile: (input: ReadInstalledLayerFileInput) =>
            fromAbortableStorePromise(async () => {
                const capability = capabilities.get(input.closure);
                if (capability === undefined) {
                    throw new LocalPackageStoreError(
                        'STORE_INVALID_INPUT',
                        'The installed closure capability is not authenticated by this reader',
                    );
                }
                return await authenticatedInstalledFile(input, capability, fileSystem.operations);
            }),
    });
}

export const nodeInstalledClosureReader = makeInstalledClosureReader();

export interface LocalPackageStoreShape {
    readonly put: (input: PutPackageInput) => Effect.Effect<PutPackageResult, LocalPackageStoreError>;
    readonly repair: (input: PutPackageInput) => Effect.Effect<RepairPackageResult, LocalPackageStoreError>;
    readonly inspect: (input: InspectPackageInput) => Effect.Effect<PackageInspection, LocalPackageStoreError>;
    readonly verifyLockAvailability: (
        input: VerifyLockAvailabilityInput,
    ) => Effect.Effect<LockAvailability, LocalPackageStoreError>;
    readonly materialize: (input: MaterializeLockInput) => Effect.Effect<MaterializeLockResult, LocalPackageStoreError>;
    readonly inspectInstall: (input: InspectInstallInput) => Effect.Effect<InstallInspection, LocalPackageStoreError>;
    readonly pathForLayer: (input: PathForLayerInput) => Effect.Effect<ResolvedLayerPath, LocalPackageStoreError>;
    readonly resolveInstalledClosure: (
        input: InspectInstallInput,
    ) => Effect.Effect<ResolvedInstalledClosure, LocalPackageStoreError>;
    readonly refreshProjectReference: (
        input: RefreshProjectReferenceInput,
    ) => Effect.Effect<RefreshProjectReferenceResult, LocalPackageStoreError>;
    readonly inspectStoreIndex: (
        input: InspectStoreIndexInput,
    ) => Effect.Effect<StoreIndexInspection, LocalPackageStoreError>;
    readonly pruneStore: (input: PruneStoreInput) => Effect.Effect<PruneStoreResult, LocalPackageStoreError>;
}

export const LocalPackageStore = Context.Service<LocalPackageStoreShape>('@erden/project/LocalPackageStore');

export function makeLocalPackageStore(
    fileSystem: StoreFileSystemPort = makeNodeStoreFileSystemPort(),
): LocalPackageStoreShape {
    return Object.freeze({
        put: (input: PutPackageInput) =>
            fromAbortableStorePromise((signal) => putPackagePromise(input, fileSystem, signal)),
        repair: (input: PutPackageInput) =>
            fromAbortableStorePromise((signal) => repairPackagePromise(input, fileSystem, signal)),
        inspect: (input: InspectPackageInput) =>
            fromAbortableStorePromise(async () => await inspectPackagePromise(input, fileSystem)),
        verifyLockAvailability: (input: VerifyLockAvailabilityInput) =>
            fromAbortableStorePromise(async () => await verifyLockAvailabilityPromise(input, fileSystem)),
        materialize: (input: MaterializeLockInput) =>
            fromAbortableStorePromise((signal) => materializePromise(input, fileSystem, signal)),
        inspectInstall: (input: InspectInstallInput) =>
            fromAbortableStorePromise(async () => await inspectInstallPromise(input, fileSystem)),
        pathForLayer: (input: PathForLayerInput) =>
            fromAbortableStorePromise(async () => await pathForLayerPromise(input, fileSystem)),
        resolveInstalledClosure: (input: InspectInstallInput) =>
            fromAbortableStorePromise(async () => await resolveInstalledClosurePromise(input, fileSystem)),
        refreshProjectReference: (input: RefreshProjectReferenceInput) =>
            fromAbortableStorePromise((signal) => refreshProjectReferencePromise(input, fileSystem, signal)),
        inspectStoreIndex: (input: InspectStoreIndexInput) =>
            fromAbortableStorePromise(async () => await inspectStoreIndexPromise(input, fileSystem)),
        pruneStore: (input: PruneStoreInput) =>
            fromAbortableStorePromise((signal) => pruneStorePromise(input, fileSystem, signal)),
    });
}

export const nodeLocalPackageStore = makeLocalPackageStore();

export function putPackage(
    input: PutPackageInput,
): Effect.Effect<PutPackageResult, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).put(input);
    });
}

export function inspectPackage(
    input: InspectPackageInput,
): Effect.Effect<PackageInspection, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).inspect(input);
    });
}

export function repairPackage(
    input: PutPackageInput,
): Effect.Effect<RepairPackageResult, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).repair(input);
    });
}

export function verifyLockAvailability(
    input: VerifyLockAvailabilityInput,
): Effect.Effect<LockAvailability, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).verifyLockAvailability(input);
    });
}

export function materializeLock(
    input: MaterializeLockInput,
): Effect.Effect<MaterializeLockResult, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).materialize(input);
    });
}

export function inspectInstall(
    input: InspectInstallInput,
): Effect.Effect<InstallInspection, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).inspectInstall(input);
    });
}

export function pathForLayer(
    input: PathForLayerInput,
): Effect.Effect<ResolvedLayerPath, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).pathForLayer(input);
    });
}

export function resolveInstalledClosure(
    input: InspectInstallInput,
): Effect.Effect<
    ResolvedInstalledClosure,
    LocalPackageStoreError,
    Context.Service.Identifier<typeof LocalPackageStore>
> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).resolveInstalledClosure(input);
    });
}

export function refreshProjectReference(
    input: RefreshProjectReferenceInput,
): Effect.Effect<
    RefreshProjectReferenceResult,
    LocalPackageStoreError,
    Context.Service.Identifier<typeof LocalPackageStore>
> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).refreshProjectReference(input);
    });
}

export function inspectStoreIndex(
    input: InspectStoreIndexInput,
): Effect.Effect<StoreIndexInspection, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).inspectStoreIndex(input);
    });
}

export function pruneLocalStore(
    input: PruneStoreInput,
): Effect.Effect<PruneStoreResult, LocalPackageStoreError, Context.Service.Identifier<typeof LocalPackageStore>> {
    return Effect.gen(function* () {
        return yield* (yield* Effect.service(LocalPackageStore)).pruneStore(input);
    });
}

export function defineMaterializeLockOperation(
    input: MaterializeLockInput,
): ApplicationOperation<
    'MaterializeLock',
    MaterializeLockResult,
    LocalPackageStoreError,
    Context.Service.Identifier<typeof LocalPackageStore>
> {
    return Object.freeze({ name: 'MaterializeLock', effect: materializeLock(input) });
}
