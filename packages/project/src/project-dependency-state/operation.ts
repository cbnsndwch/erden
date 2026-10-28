import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import { Context, Effect } from 'effect';

import {
    checkLockConsistency,
    decodeLockfileValue,
    decodeLockToolchain,
    LOCKFILE_LIMITS,
    parseLockfile,
    serializeLockfile,
    type LockfileV1,
    type LockToolchain,
    compareCodePoints,
    MANIFEST_FILENAMES,
    manifestFormatForExplicitFilename,
    normalizeManifestV1,
    parseManifestText,
    serializeManifestV1,
    type LoadedManifestV1,
    type ManifestSerializationFormat,
    type ManifestV1,
} from '@erden/contracts';

import type { ProjectLockInspection } from '../project-lock/index.js';

import { ProjectDependencyStateError, isProjectDependencyStateError } from './errors.js';
import {
    makeNodeProjectDependencyStateFileSystemPort,
    type ProjectDependencyStateFileSystemPort,
    type ProjectDependencyStateNodeOperations,
} from './filesystem.js';
import type {
    InspectProjectDependencyStateInput,
    ProjectDependencyStateInspection,
    ProjectDependencyStateRevision,
    ProjectDependencyStateWriteResult,
    RecoverProjectDependencyStateInput,
    RecheckProjectDependencyStateInput,
    WriteProjectDependencyStateInput,
} from './model.js';

const LOCK_NAME = 'erden.lock';
const ACTIVE_MARKER_NAME = '.erden.dependencies.transaction.json';
const TRANSACTION_PREFIX = '.erden.dependencies.';
const TOKEN_PATTERN = /^[0-9A-Za-z_-]{16,128}$/u;
const TRANSACTION_NAME_PATTERN =
    /^\.erden\.dependencies\.(marker|manifest|lock)\.(stage|backup)-([0-9A-Za-z_-]{16,128})$/u;
const REVISION_SCHEMA = 'erden.project-dependency-state-revision/v1' as const;
const MARKER_SCHEMA = 'erden.project-dependency-transaction/v1' as const;
const MAX_ROOT_ENTRIES = 100_000;
const MAX_ROOT_NAME_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;

type DocumentKind = 'manifest' | 'lock' | 'marker';

interface Identity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly kind: 'file' | 'directory';
}

interface RootSnapshot {
    readonly root: Identity;
    readonly chain: ReadonlyArray<Readonly<{ readonly path: string; readonly identity: Identity }>>;
    readonly realPathKey: string;
}

interface AuthenticatedFile {
    readonly identity: Identity;
    readonly bytes: Uint8Array;
}

interface InternalRevision {
    readonly root: string;
    readonly rootSnapshot: RootSnapshot;
    readonly manifestName: string;
    readonly serializationFormat: ManifestSerializationFormat;
    readonly manifest: AuthenticatedFile;
    readonly project: LoadedManifestV1;
    readonly lock: AuthenticatedFile | null;
    readonly lockInspection: ProjectLockInspection;
    readonly toolchain: LockToolchain;
}

interface Binding {
    readonly dev: string;
    readonly ino: string;
    readonly mode: string;
    readonly size: number;
    readonly mtimeNs: string;
    readonly sha256: string;
}

interface TransactionMarker {
    readonly schema: typeof MARKER_SCHEMA;
    readonly token: string;
    readonly manifestName: string;
    readonly manifestFormat: ManifestSerializationFormat;
    readonly old: Readonly<{ readonly manifest: Binding; readonly lock: Binding | null }>;
    readonly stages: Readonly<{ readonly manifest: Binding; readonly lock: Binding }>;
    readonly next: Readonly<{
        readonly manifest: Binding;
        readonly lock: Binding;
        readonly manifestDependencySha256: string;
        readonly toolchain: LockToolchain;
    }>;
}

interface TransactionNames {
    readonly token: string;
    readonly markerStage: string;
    readonly manifestStage: string;
    readonly lockStage: string;
    readonly manifestBackup: string;
    readonly lockBackup: string;
}

interface ResidueScan {
    readonly activeMarker: string | null;
    readonly entries: ReadonlyArray<
        Readonly<{
            readonly name: string;
            readonly role: 'marker' | 'manifest' | 'lock';
            readonly phase: 'stage' | 'backup';
            readonly token: string;
        }>
    >;
}

const revisionEvidence = new WeakMap<ProjectDependencyStateRevision, InternalRevision>();

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function portableKey(value: string): string {
    return value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

function safeErrorCode(cause: unknown): string | undefined {
    try {
        if (cause === null || typeof cause !== 'object') {
            return undefined;
        }
        const descriptor = Object.getOwnPropertyDescriptor(cause, 'code');
        return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
            ? descriptor.value
            : undefined;
    } catch {
        return undefined;
    }
}

function stateError(cause: unknown): ProjectDependencyStateError {
    return isProjectDependencyStateError(cause)
        ? cause
        : new ProjectDependencyStateError(
              'PROJECT_DEPENDENCY_STATE_IO_FAILURE',
              'The project dependency state operation could not complete',
              cause,
          );
}

function identity(stats: BigIntStats): Identity {
    const common = {
        dev: stats.dev,
        ino: stats.ino,
        mode: stats.mode,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
    };
    if (stats.isFile()) {
        return Object.freeze({ ...common, kind: 'file' });
    }
    if (stats.isDirectory()) {
        return Object.freeze({ ...common, kind: 'directory' });
    }
    throw new ProjectDependencyStateError(
        'PROJECT_DEPENDENCY_STATE_IO_FAILURE',
        'A project dependency state path is not a regular filesystem entry',
    );
}

function sameNode(expected: Identity, actual: BigIntStats): boolean {
    return (
        expected.dev === actual.dev &&
        expected.ino === actual.ino &&
        expected.kind === (actual.isFile() ? 'file' : actual.isDirectory() ? 'directory' : 'other')
    );
}

function sameSnapshot(expected: Identity, actual: Identity): boolean {
    return (
        expected.dev === actual.dev &&
        expected.ino === actual.ino &&
        expected.mode === actual.mode &&
        expected.size === actual.size &&
        expected.mtimeNs === actual.mtimeNs &&
        expected.ctimeNs === actual.ctimeNs &&
        expected.kind === actual.kind
    );
}

function sameOwnedSnapshot(expected: Identity, actual: Identity): boolean {
    return (
        expected.dev === actual.dev &&
        expected.ino === actual.ino &&
        expected.mode === actual.mode &&
        expected.size === actual.size &&
        expected.mtimeNs === actual.mtimeNs &&
        expected.kind === actual.kind
    );
}

async function lstatOrNull(
    operations: ProjectDependencyStateNodeOperations,
    path: string,
): Promise<BigIntStats | null> {
    try {
        return await operations.lstat(path, { bigint: true });
    } catch (cause) {
        if (safeErrorCode(cause) === 'ENOENT') {
            return null;
        }
        throw cause;
    }
}

async function readDirectory(
    operations: ProjectDependencyStateNodeOperations,
    path: string,
): Promise<ReadonlyArray<string>> {
    const directory = await operations.opendir(path);
    const names: string[] = [];
    let nameBytes = 0;
    try {
        for await (const entry of directory) {
            if (names.length >= MAX_ROOT_ENTRIES) {
                throw new ProjectDependencyStateError(
                    'PROJECT_DEPENDENCY_STATE_IO_FAILURE',
                    'The project root exceeds the closed directory-entry bound',
                );
            }
            nameBytes += Buffer.byteLength(entry.name, 'utf8');
            if (nameBytes > MAX_ROOT_NAME_BYTES) {
                throw new ProjectDependencyStateError(
                    'PROJECT_DEPENDENCY_STATE_IO_FAILURE',
                    'The project root exceeds the closed directory-name bound',
                );
            }
            names.push(entry.name);
        }
    } finally {
        await directory.close().catch(() => undefined);
    }
    return Object.freeze(names.sort(compareCodePoints));
}

async function snapshotRoot(
    operations: ProjectDependencyStateNodeOperations,
    value: string,
): Promise<
    Readonly<{
        readonly path: string;
        readonly snapshot: RootSnapshot;
    }>
> {
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || value.includes('\0')) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project root must be one absolute filesystem path',
        );
    }
    const path = resolve(value);
    const pathRoot = parse(path).root;
    const parts = path
        .slice(pathRoot.length)
        .split(sep)
        .filter((part) => part.length > 0);
    const chain: Array<
        Readonly<{
            readonly path: string;
            readonly identity: Identity;
        }>
    > = [];
    let current = pathRoot;
    const rootStats = await operations.lstat(pathRoot, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
            'The filesystem root is not one regular directory',
        );
    }
    chain.push(Object.freeze({ path: pathRoot, identity: identity(rootStats) }));
    for (const part of parts) {
        current = join(current, part);
        const stats = await operations.lstat(current, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
                'A symbolic, reparse, or non-directory project ancestor is not allowed',
            );
        }
        chain.push(Object.freeze({ path: current, identity: identity(stats) }));
    }
    const root = chain.at(-1)?.identity;
    if (root === undefined) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
            'The project root could not be authenticated',
        );
    }
    const realPath = await operations.realpath(path);
    if (portableKey(resolve(realPath)) !== portableKey(path)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
            'A symbolic or reparse project-root spelling is not allowed',
        );
    }
    return Object.freeze({
        path,
        snapshot: Object.freeze({
            root,
            chain: Object.freeze(chain),
            realPathKey: portableKey(resolve(realPath)),
        }),
    });
}

async function recheckRoot(operations: ProjectDependencyStateNodeOperations, snapshot: RootSnapshot): Promise<void> {
    for (const entry of snapshot.chain) {
        const stats = await operations.lstat(entry.path, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink() || !sameNode(entry.identity, stats)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
                'The authenticated project root changed during the dependency state operation',
            );
        }
    }
    const rootPath = snapshot.chain.at(-1)?.path;
    if (rootPath === undefined) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
            'The authenticated project root is unavailable',
        );
    }
    const realPath = await operations.realpath(rootPath);
    if (portableKey(resolve(realPath)) !== snapshot.realPathKey) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
            'The authenticated project root target changed during the dependency state operation',
        );
    }
}

async function assertCanonicalEntry(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    expected: string,
    required: boolean,
): Promise<boolean> {
    const expectedKey = portableKey(expected);
    let found = false;
    for (const name of await readDirectory(operations, root)) {
        if (portableKey(name) !== expectedKey) {
            continue;
        }
        if (name !== expected || found) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT',
                'A portable filesystem-name collision makes project dependency state ambiguous',
            );
        }
        found = true;
    }
    if (required && !found) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
            'A canonical project dependency state entry changed during the operation',
        );
    }
    return found;
}

async function readFile(
    operations: ProjectDependencyStateNodeOperations,
    path: string,
    maximum: number,
    kind: DocumentKind,
    signal?: AbortSignal,
): Promise<AuthenticatedFile> {
    signal?.throwIfAborted();
    const before = await operations.lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new ProjectDependencyStateError(
            kind === 'manifest'
                ? 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE'
                : 'PROJECT_DEPENDENCY_STATE_LOCK_INVALID',
            `The project ${kind} is not a regular file`,
        );
    }
    const expected = identity(before);
    if (expected.size < 0n || expected.size > BigInt(maximum)) {
        throw new ProjectDependencyStateError(
            kind === 'manifest'
                ? 'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE'
                : 'PROJECT_DEPENDENCY_STATE_LOCK_INVALID',
            `The project ${kind} exceeds its closed byte bound`,
        );
    }
    const handle = await operations.open(path, 'r');
    try {
        const opened = await operations.stat(handle);
        if (!sameNode(expected, opened) || opened.size < 0n || opened.size > BigInt(maximum)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
                `The project ${kind} changed before it could be read`,
            );
        }
        const bytes = new Uint8Array(Number(opened.size));
        let offset = 0;
        while (offset < bytes.byteLength) {
            signal?.throwIfAborted();
            const { bytesRead } = await operations.read(handle, bytes, offset, bytes.byteLength - offset, offset);
            if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.byteLength - offset) {
                throw new ProjectDependencyStateError(
                    'PROJECT_DEPENDENCY_STATE_IO_FAILURE',
                    `The project ${kind} could not be read completely`,
                );
            }
            offset += bytesRead;
        }
        const afterHandle = await operations.stat(handle);
        const afterPath = await operations.lstat(path, { bigint: true });
        signal?.throwIfAborted();
        if (!sameSnapshot(expected, identity(afterHandle)) || !sameSnapshot(expected, identity(afterPath))) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
                `The project ${kind} changed while it was being read`,
            );
        }
        return Object.freeze({ identity: expected, bytes });
    } finally {
        await operations.close(handle).catch(() => undefined);
    }
}

async function matchesFile(
    operations: ProjectDependencyStateNodeOperations,
    path: string,
    expected: AuthenticatedFile,
    maximum: number,
    kind: DocumentKind,
): Promise<boolean> {
    try {
        const actual = await readFile(operations, path, maximum, kind);
        return (
            sameSnapshot(expected.identity, actual.identity) &&
            Buffer.from(expected.bytes).equals(Buffer.from(actual.bytes))
        );
    } catch {
        return false;
    }
}

function bindingFor(file: AuthenticatedFile): Binding {
    return Object.freeze({
        dev: file.identity.dev.toString(10),
        ino: file.identity.ino.toString(10),
        mode: file.identity.mode.toString(10),
        size: file.bytes.byteLength,
        mtimeNs: file.identity.mtimeNs.toString(10),
        sha256: sha256(file.bytes),
    });
}

function matchesBinding(file: AuthenticatedFile, binding: Binding): boolean {
    return (
        file.identity.dev.toString(10) === binding.dev &&
        file.identity.ino.toString(10) === binding.ino &&
        file.identity.mode.toString(10) === binding.mode &&
        file.identity.mtimeNs.toString(10) === binding.mtimeNs &&
        file.bytes.byteLength === binding.size &&
        sha256(file.bytes) === binding.sha256
    );
}

async function removeOwnedFile(
    operations: ProjectDependencyStateNodeOperations,
    path: string,
    expected: AuthenticatedFile,
    maximum: number,
    kind: DocumentKind,
): Promise<boolean> {
    try {
        const captured = await readFile(operations, path, maximum, kind);
        if (
            !sameOwnedSnapshot(expected.identity, captured.identity) ||
            !Buffer.from(expected.bytes).equals(Buffer.from(captured.bytes))
        ) {
            return false;
        }
        const final = await operations.lstat(path, { bigint: true });
        if (!sameSnapshot(captured.identity, identity(final))) {
            return false;
        }
        await operations.unlink(path);
        return true;
    } catch {
        return false;
    }
}

function serializationFormat(filename: string): ManifestSerializationFormat {
    if (filename.endsWith('.jsonc')) {
        return 'jsonc';
    }
    if (filename.endsWith('.json')) {
        return 'json';
    }
    if (filename.endsWith('.yml')) {
        return 'yml';
    }
    if (filename.endsWith('.yaml')) {
        return 'yaml';
    }
    if (filename.endsWith('.toml')) {
        return 'toml';
    }
    throw new ProjectDependencyStateError(
        'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
        'The selected manifest format is unsupported',
    );
}

async function scanResidues(operations: ProjectDependencyStateNodeOperations, root: string): Promise<ResidueScan> {
    const foldedPrefix = portableKey(TRANSACTION_PREFIX);
    const activeKey = portableKey(ACTIVE_MARKER_NAME);
    let activeMarker: string | null = null;
    const entries: Array<ResidueScan['entries'][number]> = [];
    for (const name of await readDirectory(operations, root)) {
        const folded = portableKey(name);
        if (folded === activeKey) {
            if (name !== ACTIVE_MARKER_NAME || activeMarker !== null) {
                throw new ProjectDependencyStateError(
                    'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT',
                    'A noncanonical dependency transaction marker requires explicit repair',
                );
            }
            activeMarker = name;
            continue;
        }
        if (!folded.startsWith(foldedPrefix)) {
            continue;
        }
        const match = TRANSACTION_NAME_PATTERN.exec(name);
        if (match === null) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT',
                'A noncanonical dependency transaction residue requires explicit repair',
            );
        }
        const role = match[1];
        const phase = match[2];
        const token = match[3];
        if (
            (role !== 'marker' && role !== 'manifest' && role !== 'lock') ||
            (phase !== 'stage' && phase !== 'backup') ||
            token === undefined ||
            (role === 'marker' && phase !== 'stage')
        ) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT',
                'A dependency transaction residue has an invalid role',
            );
        }
        entries.push(Object.freeze({ name, role, phase, token }));
    }
    return Object.freeze({ activeMarker, entries: Object.freeze(entries) });
}

async function assertNoResidues(operations: ProjectDependencyStateNodeOperations, root: string): Promise<void> {
    const scan = await scanResidues(operations, root);
    if (scan.activeMarker !== null || scan.entries.length !== 0) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT',
            'An interrupted project dependency transaction requires writer recovery',
        );
    }
}

function namesFor(token: string): TransactionNames {
    return Object.freeze({
        token,
        markerStage: `.erden.dependencies.marker.stage-${token}`,
        manifestStage: `.erden.dependencies.manifest.stage-${token}`,
        lockStage: `.erden.dependencies.lock.stage-${token}`,
        manifestBackup: `.erden.dependencies.manifest.backup-${token}`,
        lockBackup: `.erden.dependencies.lock.backup-${token}`,
    });
}

interface InspectOptionsSnapshot {
    readonly from: string;
    readonly explicitPath?: string;
    readonly toolchain: LockToolchain;
}

function dataProperties(
    value: unknown,
    allowed: ReadonlyArray<string>,
    required: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
    ) {
        throw new TypeError('input is not one closed plain object');
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.some((name) => !allowed.includes(name)) || required.some((name) => !names.includes(name))) {
        throw new TypeError('input fields are invalid');
    }
    const result: Record<string, unknown> = {};
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
            throw new TypeError('input fields must be enumerable data properties');
        }
        result[name] = descriptor.value;
    }
    return Object.freeze(result);
}

function inspectOptions(input: unknown): InspectOptionsSnapshot {
    const record = dataProperties(input, ['from', 'explicitPath', 'toolchain'], ['toolchain']);
    const from = record['from'] === undefined ? process.cwd() : record['from'];
    const explicitPath = record['explicitPath'];
    if (
        typeof from !== 'string' ||
        from.length === 0 ||
        from.includes('\0') ||
        (explicitPath !== undefined &&
            (typeof explicitPath !== 'string' || explicitPath.length === 0 || explicitPath.includes('\0')))
    ) {
        throw new TypeError('manifest discovery options are invalid');
    }
    return Object.freeze({
        from: resolve(from),
        ...(explicitPath === undefined ? {} : { explicitPath }),
        toolchain: decodeLockToolchain(record['toolchain']),
    });
}

async function initialDirectory(operations: ProjectDependencyStateNodeOperations, from: string): Promise<string> {
    let current = resolve(from);
    for (;;) {
        const stats = await lstatOrNull(operations, current);
        if (stats !== null) {
            return stats.isDirectory() ? current : dirname(current);
        }
        const parent = dirname(current);
        if (parent === current) {
            return current;
        }
        current = parent;
    }
}

interface DiscoveredLocation {
    readonly filePath: string;
    readonly projectRoot: string;
    readonly manifestName: string;
    readonly serializationFormat: ManifestSerializationFormat;
}

function recognizedCandidates(names: ReadonlyArray<string>): ReadonlyArray<string> {
    const byPortable = new Map(MANIFEST_FILENAMES.map((name) => [portableKey(name), name] as const));
    const candidates: string[] = [];
    for (const name of names) {
        const recognized = byPortable.get(portableKey(name));
        if (recognized === undefined) {
            continue;
        }
        if (name !== recognized) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
                'A portable manifest-name collision makes project selection ambiguous',
            );
        }
        candidates.push(name);
    }
    if (candidates.length > 1) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
            'More than one recognized root manifest makes project selection ambiguous',
        );
    }
    return Object.freeze(candidates);
}

async function discoverLocation(
    operations: ProjectDependencyStateNodeOperations,
    options: InspectOptionsSnapshot,
): Promise<DiscoveredLocation> {
    if (options.explicitPath !== undefined) {
        const filePath = resolve(options.from, options.explicitPath);
        const manifestName = basename(filePath);
        if (manifestFormatForExplicitFilename(manifestName) === undefined) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
                'The explicit manifest does not use one supported extension',
            );
        }
        const projectRoot = dirname(filePath);
        const { path } = await snapshotRoot(operations, projectRoot);
        await assertCanonicalEntry(operations, path, manifestName, true);
        return Object.freeze({
            filePath: join(path, manifestName),
            projectRoot: path,
            manifestName,
            serializationFormat: serializationFormat(manifestName),
        });
    }
    let directory = await initialDirectory(operations, options.from);
    for (;;) {
        const names = await readDirectory(operations, directory);
        const candidate = recognizedCandidates(names)[0];
        if (candidate !== undefined) {
            const { path } = await snapshotRoot(operations, directory);
            await assertCanonicalEntry(operations, path, candidate, true);
            return Object.freeze({
                filePath: join(path, candidate),
                projectRoot: path,
                manifestName: candidate,
                serializationFormat: serializationFormat(candidate),
            });
        }
        const parent = dirname(directory);
        if (parent === directory) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
                'No recognized project manifest was found',
            );
        }
        directory = parent;
    }
}

function decodeManifestBytes(filePath: string, bytes: Uint8Array): LoadedManifestV1 {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
            'The project manifest is not valid UTF-8',
            cause,
        );
    }
    try {
        return parseManifestText({ filePath, text });
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
            'The project manifest is invalid',
            cause,
        );
    }
}

function lockInspection(
    project: LoadedManifestV1,
    toolchain: LockToolchain,
    source: AuthenticatedFile | null,
): ProjectLockInspection {
    if (source === null) {
        return Object.freeze({ status: 'missing', lock: null, canonicalBytes: null, reasons: Object.freeze([]) });
    }
    let lock: LockfileV1;
    let canonicalBytes: Uint8Array;
    try {
        lock = parseLockfile(source.bytes);
        canonicalBytes = new TextEncoder().encode(serializeLockfile(lock));
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_LOCK_INVALID',
            'erden.lock is not one valid canonical v1 lock',
            cause,
        );
    }
    if (!Buffer.from(source.bytes).equals(Buffer.from(canonicalBytes))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_LOCK_INVALID',
            'erden.lock is not the exact canonical v1 serialization',
        );
    }
    const consistency = checkLockConsistency(project.manifest, toolchain, lock);
    return consistency.status === 'consistent'
        ? Object.freeze({ status: 'available', lock, canonicalBytes, reasons: Object.freeze([]) })
        : Object.freeze({ status: 'stale', lock, canonicalBytes, reasons: consistency.reasons });
}

function makeRevision(internal: InternalRevision): ProjectDependencyStateRevision {
    const revision = Object.freeze({ schema: REVISION_SCHEMA });
    revisionEvidence.set(revision, internal);
    return revision;
}

function publicInspection(internal: InternalRevision): ProjectDependencyStateInspection {
    return Object.freeze({
        project: internal.project,
        manifestBytes: Uint8Array.from(internal.manifest.bytes),
        lockInspection: internal.lockInspection,
        revision: makeRevision(internal),
    });
}

async function inspectAtLocation(
    operations: ProjectDependencyStateNodeOperations,
    location: DiscoveredLocation,
    toolchain: LockToolchain,
    signal: AbortSignal,
): Promise<ProjectDependencyStateInspection> {
    signal.throwIfAborted();
    const { path: root, snapshot: rootSnapshot } = await snapshotRoot(operations, location.projectRoot);
    await assertNoResidues(operations, root);
    await assertCanonicalEntry(operations, root, location.manifestName, true);
    const manifest = await readFile(
        operations,
        join(root, location.manifestName),
        MAX_MANIFEST_BYTES,
        'manifest',
        signal,
    );
    if (operations.enforcePosixModes && Number(manifest.identity.mode & 4095n) !== 0o644) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
            'The project manifest does not have exact canonical file mode 0644',
        );
    }
    const project = decodeManifestBytes(join(root, location.manifestName), manifest.bytes);
    const lockExists = await assertCanonicalEntry(operations, root, LOCK_NAME, false);
    const lock = lockExists
        ? await readFile(operations, join(root, LOCK_NAME), LOCKFILE_LIMITS.maxBytes, 'lock', signal)
        : null;
    if (lock !== null && operations.enforcePosixModes && Number(lock.identity.mode & 4095n) !== 0o644) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_LOCK_INVALID',
            'erden.lock does not have exact canonical file mode 0644',
        );
    }
    const inspection = lockInspection(project, toolchain, lock);
    await assertNoResidues(operations, root);
    await assertCanonicalEntry(operations, root, location.manifestName, true);
    await assertCanonicalEntry(operations, root, LOCK_NAME, lock !== null);
    await recheckRoot(operations, rootSnapshot);
    if (
        !(await matchesFile(operations, join(root, location.manifestName), manifest, MAX_MANIFEST_BYTES, 'manifest')) ||
        (lock !== null &&
            !(await matchesFile(operations, join(root, LOCK_NAME), lock, LOCKFILE_LIMITS.maxBytes, 'lock')))
    ) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
            'The project dependency state changed during final inspection',
        );
    }
    if (lock === null && (await assertCanonicalEntry(operations, root, LOCK_NAME, false))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
            'erden.lock appeared during final missing-lock validation',
        );
    }
    await recheckRoot(operations, rootSnapshot);
    await assertNoResidues(operations, root);
    signal.throwIfAborted();
    return publicInspection(
        Object.freeze({
            root,
            rootSnapshot,
            manifestName: location.manifestName,
            serializationFormat: location.serializationFormat,
            manifest,
            project,
            lock,
            lockInspection: inspection,
            toolchain,
        }),
    );
}

async function inspectPromise(
    input: InspectProjectDependencyStateInput,
    fileSystem: ProjectDependencyStateFileSystemPort,
    signal: AbortSignal,
): Promise<ProjectDependencyStateInspection> {
    let options: InspectOptionsSnapshot;
    try {
        options = inspectOptions(input);
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project dependency state options are invalid',
            cause,
        );
    }
    const location = await discoverLocation(fileSystem.operations, options);
    return await inspectAtLocation(fileSystem.operations, location, options.toolchain, signal);
}

function internalRevision(value: unknown): InternalRevision {
    if (value === null || typeof value !== 'object') {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project dependency state revision is invalid',
        );
    }
    const internal = revisionEvidence.get(value as ProjectDependencyStateRevision);
    if (internal === undefined) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project dependency state revision is invalid',
        );
    }
    return internal;
}

async function recheckInternal(
    operations: ProjectDependencyStateNodeOperations,
    revision: InternalRevision,
    allowToken?: string,
): Promise<void> {
    await recheckRoot(operations, revision.rootSnapshot);
    const scan = await scanResidues(operations, revision.root);
    if (allowToken === undefined) {
        if (scan.activeMarker !== null || scan.entries.length !== 0) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
                'A dependency transaction began after the state was inspected',
            );
        }
    } else {
        const unexpected = scan.entries.some((entry) => entry.token !== allowToken);
        if (unexpected) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'A concurrent dependency transaction residue is ambiguous',
            );
        }
    }
    await assertCanonicalEntry(operations, revision.root, revision.manifestName, true);
    await assertCanonicalEntry(operations, revision.root, LOCK_NAME, revision.lock !== null);
    const matchesRevisionFile = allowToken === undefined ? matchesFile : matchesOwnedFile;
    if (
        !(await matchesRevisionFile(
            operations,
            join(revision.root, revision.manifestName),
            revision.manifest,
            MAX_MANIFEST_BYTES,
            'manifest',
        )) ||
        (revision.lock !== null &&
            !(await matchesRevisionFile(
                operations,
                join(revision.root, LOCK_NAME),
                revision.lock,
                LOCKFILE_LIMITS.maxBytes,
                'lock',
            )))
    ) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
            'The project dependency state no longer matches the inspected revision',
        );
    }
    if (revision.lock === null && (await assertCanonicalEntry(operations, revision.root, LOCK_NAME, false))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
            'erden.lock appeared after the state was inspected',
        );
    }
    await recheckRoot(operations, revision.rootSnapshot);
}

async function verifyRestoredRevision(
    operations: ProjectDependencyStateNodeOperations,
    revision: InternalRevision,
): Promise<void> {
    await recheckRoot(operations, revision.rootSnapshot);
    await assertNoResidues(operations, revision.root);
    await assertCanonicalEntry(operations, revision.root, revision.manifestName, true);
    await assertCanonicalEntry(operations, revision.root, LOCK_NAME, revision.lock !== null);
    if (
        !(await matchesOwnedFile(
            operations,
            join(revision.root, revision.manifestName),
            revision.manifest,
            MAX_MANIFEST_BYTES,
            'manifest',
        )) ||
        (revision.lock !== null &&
            !(await matchesOwnedFile(
                operations,
                join(revision.root, LOCK_NAME),
                revision.lock,
                LOCKFILE_LIMITS.maxBytes,
                'lock',
            )))
    ) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The previous project dependency state was not restored exactly',
        );
    }
    if (revision.lock === null && (await assertCanonicalEntry(operations, revision.root, LOCK_NAME, false))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'A lock remained after restoring a lock-free dependency state',
        );
    }
    await recheckRoot(operations, revision.rootSnapshot);
}

async function recheckPromise(
    input: RecheckProjectDependencyStateInput,
    fileSystem: ProjectDependencyStateFileSystemPort,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    let record: Readonly<Record<string, unknown>>;
    try {
        record = dataProperties(input, ['revision'], ['revision']);
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project dependency state recheck input is invalid',
            cause,
        );
    }
    await recheckInternal(fileSystem.operations, internalRevision(record['revision']));
    signal.throwIfAborted();
}

function bindingObject(binding: Binding): object {
    return {
        dev: binding.dev,
        ino: binding.ino,
        mode: binding.mode,
        size: binding.size,
        mtimeNs: binding.mtimeNs,
        sha256: binding.sha256,
    };
}

function toolchainObject(toolchain: LockToolchain): object {
    return {
        validator: { version: toolchain.validator.version, sha256: toolchain.validator.sha256 },
        reasoner: { version: toolchain.reasoner.version, sha256: toolchain.reasoner.sha256 },
    };
}

function markerObject(marker: TransactionMarker): object {
    return {
        schema: marker.schema,
        token: marker.token,
        manifestName: marker.manifestName,
        manifestFormat: marker.manifestFormat,
        old: {
            manifest: bindingObject(marker.old.manifest),
            lock: marker.old.lock === null ? null : bindingObject(marker.old.lock),
        },
        stages: {
            manifest: bindingObject(marker.stages.manifest),
            lock: bindingObject(marker.stages.lock),
        },
        next: {
            manifest: bindingObject(marker.next.manifest),
            lock: bindingObject(marker.next.lock),
            manifestDependencySha256: marker.next.manifestDependencySha256,
            toolchain: toolchainObject(marker.next.toolchain),
        },
    };
}

function encodeMarker(marker: TransactionMarker): Uint8Array {
    const bytes = new TextEncoder().encode(`${JSON.stringify(markerObject(marker))}\n`);
    if (bytes.byteLength > MAX_MARKER_BYTES) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The dependency transaction marker exceeds its closed byte bound',
        );
    }
    return bytes;
}

function exactObject(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
    ) {
        return false;
    }
    const names = Object.getOwnPropertyNames(value).sort(compareCodePoints);
    const expected = [...keys].sort(compareCodePoints);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        return false;
    }
    return names.every((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
    });
}

const decimalPattern = /^(?:0|[1-9][0-9]*)$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

function decodeBinding(value: unknown): Binding {
    if (
        !exactObject(value, ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'sha256']) ||
        typeof value.dev !== 'string' ||
        !decimalPattern.test(value.dev) ||
        typeof value.ino !== 'string' ||
        !decimalPattern.test(value.ino) ||
        typeof value.mode !== 'string' ||
        !decimalPattern.test(value.mode) ||
        typeof value.mtimeNs !== 'string' ||
        !decimalPattern.test(value.mtimeNs) ||
        typeof value.sha256 !== 'string' ||
        !digestPattern.test(value.sha256) ||
        typeof value.size !== 'number' ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        Object.is(value.size, -0)
    ) {
        throw new TypeError('invalid transaction file binding');
    }
    return Object.freeze({
        dev: value.dev,
        ino: value.ino,
        mode: value.mode,
        size: value.size,
        mtimeNs: value.mtimeNs,
        sha256: value.sha256,
    });
}

function decodeMarker(bytes: Uint8Array): TransactionMarker {
    let value: unknown;
    try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        value = JSON.parse(text) as unknown;
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The dependency transaction marker is invalid',
            cause,
        );
    }
    try {
        if (
            !exactObject(value, ['schema', 'token', 'manifestName', 'manifestFormat', 'old', 'stages', 'next']) ||
            value.schema !== MARKER_SCHEMA ||
            typeof value.token !== 'string' ||
            !TOKEN_PATTERN.test(value.token) ||
            typeof value.manifestName !== 'string' ||
            value.manifestName.length === 0 ||
            basename(value.manifestName) !== value.manifestName ||
            value.manifestName.includes('\0') ||
            manifestFormatForExplicitFilename(value.manifestName) === undefined ||
            serializationFormat(value.manifestName) !== value.manifestFormat ||
            !exactObject(value.old, ['manifest', 'lock']) ||
            !exactObject(value.stages, ['manifest', 'lock']) ||
            !exactObject(value.next, ['manifest', 'lock', 'manifestDependencySha256', 'toolchain']) ||
            typeof value.next.manifestDependencySha256 !== 'string' ||
            !digestPattern.test(value.next.manifestDependencySha256)
        ) {
            throw new TypeError('invalid marker shape');
        }
        const marker: TransactionMarker = Object.freeze({
            schema: MARKER_SCHEMA,
            token: value.token,
            manifestName: value.manifestName,
            manifestFormat: value.manifestFormat as ManifestSerializationFormat,
            old: Object.freeze({
                manifest: decodeBinding(value.old.manifest),
                lock: value.old.lock === null ? null : decodeBinding(value.old.lock),
            }),
            stages: Object.freeze({
                manifest: decodeBinding(value.stages.manifest),
                lock: decodeBinding(value.stages.lock),
            }),
            next: Object.freeze({
                manifest: decodeBinding(value.next.manifest),
                lock: decodeBinding(value.next.lock),
                manifestDependencySha256: value.next.manifestDependencySha256,
                toolchain: decodeLockToolchain(value.next.toolchain),
            }),
        });
        if (!Buffer.from(encodeMarker(marker)).equals(Buffer.from(bytes))) {
            throw new TypeError('marker bytes are noncanonical');
        }
        return marker;
    } catch (cause) {
        if (isProjectDependencyStateError(cause)) {
            throw cause;
        }
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The dependency transaction marker is invalid',
            cause,
        );
    }
}

async function matchesOwnedFile(
    operations: ProjectDependencyStateNodeOperations,
    path: string,
    expected: AuthenticatedFile,
    maximum: number,
    kind: DocumentKind,
): Promise<boolean> {
    try {
        const actual = await readFile(operations, path, maximum, kind);
        return (
            sameOwnedSnapshot(expected.identity, actual.identity) &&
            Buffer.from(expected.bytes).equals(Buffer.from(actual.bytes))
        );
    } catch {
        return false;
    }
}

async function proveAbsent(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    snapshot: RootSnapshot,
    name: string,
): Promise<boolean> {
    try {
        await recheckRoot(operations, snapshot);
        const absent = !(await assertCanonicalEntry(operations, root, name, false));
        await recheckRoot(operations, snapshot);
        return absent;
    } catch {
        return false;
    }
}

async function removeCreatedPrefix(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    path: string,
    name: string,
    created: Identity,
    prefix: Uint8Array,
    maximum: number,
    kind: DocumentKind,
): Promise<boolean> {
    try {
        await recheckRoot(operations, rootSnapshot);
        await assertCanonicalEntry(operations, root, name, true);
        const current = await operations.lstat(path, { bigint: true });
        if (!sameNode(created, current) || current.size !== BigInt(prefix.byteLength)) {
            return false;
        }
        const captured = await readFile(operations, path, maximum, kind);
        if (
            captured.identity.dev !== created.dev ||
            captured.identity.ino !== created.ino ||
            !Buffer.from(captured.bytes).equals(Buffer.from(prefix))
        ) {
            return false;
        }
        const final = await operations.lstat(path, { bigint: true });
        if (!sameSnapshot(captured.identity, identity(final))) {
            return false;
        }
        await recheckRoot(operations, rootSnapshot);
        await operations.unlink(path);
        await recheckRoot(operations, rootSnapshot);
        return !(await assertCanonicalEntry(operations, root, name, false));
    } catch {
        return false;
    }
}

async function writeStage(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    name: string,
    bytes: Uint8Array,
    finalMode: number,
    maximum: number,
    kind: DocumentKind,
    signal: AbortSignal,
): Promise<AuthenticatedFile> {
    const path = join(root, name);
    await recheckRoot(operations, rootSnapshot);
    if (await assertCanonicalEntry(operations, root, name, false)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT',
            'A dependency transaction reservation already exists',
        );
    }
    let handle: FileHandle | undefined;
    try {
        handle = await operations.open(path, 'wx', 0o600);
    } catch (cause) {
        if (!(await proveAbsent(operations, root, rootSnapshot, name))) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'A dependency transaction stage may have been created without authenticated ownership',
                cause,
            );
        }
        throw cause;
    }
    let created: Identity | undefined;
    let writtenBytes = 0;
    try {
        const opened = await operations.stat(handle);
        if (!opened.isFile()) {
            throw new Error('created stage is not a regular file');
        }
        created = identity(opened);
        let offset = 0;
        while (offset < bytes.byteLength) {
            signal.throwIfAborted();
            const { bytesWritten } = await operations.write(handle, bytes, offset, bytes.byteLength - offset);
            if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
                throw new Error('stage write made invalid progress');
            }
            offset += bytesWritten;
            writtenBytes = offset;
        }
        await operations.sync(handle);
        await operations.close(handle);
        handle = undefined;
        await recheckRoot(operations, rootSnapshot);
        await operations.chmod(path, finalMode);
        await recheckRoot(operations, rootSnapshot);
        const written = await readFile(operations, path, maximum, kind, signal);
        if (
            written.identity.dev !== created.dev ||
            written.identity.ino !== created.ino ||
            !Buffer.from(written.bytes).equals(Buffer.from(bytes)) ||
            (operations.enforcePosixModes && Number(written.identity.mode & 4095n) !== finalMode)
        ) {
            throw new Error('stage bytes or mode did not authenticate');
        }
        await assertCanonicalEntry(operations, root, name, true);
        await recheckRoot(operations, rootSnapshot);
        return written;
    } catch (cause) {
        if (handle !== undefined) {
            await operations.close(handle).catch(() => undefined);
        }
        if (
            created === undefined ||
            !(await removeCreatedPrefix(
                operations,
                root,
                rootSnapshot,
                path,
                name,
                created,
                bytes.slice(0, writtenBytes),
                maximum,
                kind,
            ))
        ) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'A dependency transaction stage could not be cleaned with authenticated ownership',
                cause,
            );
        }
        throw cause;
    }
}

async function linkOwned(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    sourceName: string,
    destinationName: string,
    expected: AuthenticatedFile,
    maximum: number,
    kind: DocumentKind,
): Promise<AuthenticatedFile> {
    const source = join(root, sourceName);
    const destination = join(root, destinationName);
    await recheckRoot(operations, rootSnapshot);
    await assertCanonicalEntry(operations, root, sourceName, true);
    if (await assertCanonicalEntry(operations, root, destinationName, false)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'A dependency transaction destination appeared before exclusive publication',
        );
    }
    if (!(await matchesOwnedFile(operations, source, expected, maximum, kind))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'A dependency transaction source changed before publication',
        );
    }
    try {
        await operations.link(source, destination);
    } catch (cause) {
        if (await matchesOwnedFile(operations, destination, expected, maximum, kind)) {
            // The no-overwrite link completed and only its return path failed.
        } else if (await proveAbsent(operations, root, rootSnapshot, destinationName)) {
            throw cause;
        } else {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'A dependency transaction publication could not be reconciled safely',
                cause,
            );
        }
    }
    await assertCanonicalEntry(operations, root, destinationName, true);
    await recheckRoot(operations, rootSnapshot);
    const published = await readFile(operations, destination, maximum, kind);
    if (
        !sameOwnedSnapshot(expected.identity, published.identity) ||
        !Buffer.from(expected.bytes).equals(Buffer.from(published.bytes))
    ) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'A dependency transaction publication has the wrong identity or bytes',
        );
    }
    return published;
}

async function unlinkOwned(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    name: string,
    expected: AuthenticatedFile,
    maximum: number,
    kind: DocumentKind,
): Promise<void> {
    await recheckRoot(operations, rootSnapshot);
    await assertCanonicalEntry(operations, root, name, true);
    if (!(await removeOwnedFile(operations, join(root, name), expected, maximum, kind))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'An authenticated dependency transaction file could not be removed safely',
        );
    }
    await recheckRoot(operations, rootSnapshot);
    if (await assertCanonicalEntry(operations, root, name, false)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'A dependency transaction file reappeared after authenticated removal',
        );
    }
}

interface NextState {
    readonly revision: InternalRevision;
    readonly manifestKind: 'preserve' | 'replace';
    readonly manifestBytes: Uint8Array;
    readonly project: LoadedManifestV1;
    readonly lock: LockfileV1;
    readonly lockBytes: Uint8Array;
}

function nextState(input: unknown): NextState {
    let record: Readonly<Record<string, unknown>>;
    try {
        record = dataProperties(input, ['revision', 'manifest', 'lock'], ['revision', 'manifest', 'lock']);
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project dependency state write input is invalid',
            cause,
        );
    }
    const revision = internalRevision(record['revision']);
    let manifestMode: Readonly<Record<string, unknown>>;
    try {
        const rawManifestMode = record['manifest'];
        if (rawManifestMode === null || typeof rawManifestMode !== 'object') {
            throw new TypeError('manifest mode');
        }
        const kindDescriptor = Object.getOwnPropertyDescriptor(rawManifestMode, 'kind');
        if (kindDescriptor === undefined || !('value' in kindDescriptor)) {
            throw new TypeError('manifest mode kind');
        }
        manifestMode =
            kindDescriptor.value === 'preserve'
                ? dataProperties(rawManifestMode, ['kind'], ['kind'])
                : dataProperties(rawManifestMode, ['kind', 'manifest'], ['kind', 'manifest']);
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project dependency state manifest write mode is invalid',
            cause,
        );
    }
    const kind = manifestMode['kind'];
    if (kind !== 'preserve' && kind !== 'replace') {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The project dependency state manifest write mode is invalid',
        );
    }
    let normalized: ManifestV1;
    let manifestBytes: Uint8Array;
    try {
        normalized = kind === 'preserve' ? revision.project.manifest : normalizeManifestV1(manifestMode['manifest']);
        const text = kind === 'preserve' ? undefined : serializeManifestV1(normalized, revision.serializationFormat);
        manifestBytes = text === undefined ? Uint8Array.from(revision.manifest.bytes) : new TextEncoder().encode(text);
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The replacement project manifest is invalid',
            cause,
        );
    }
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The replacement project manifest exceeds its closed byte bound',
        );
    }
    const project = decodeManifestBytes(join(revision.root, revision.manifestName), manifestBytes);
    if (
        project.manifest.canonicalIri !== revision.project.manifest.canonicalIri ||
        project.manifest.alias !== revision.project.manifest.alias
    ) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'A dependency state write cannot retarget the root project identity',
        );
    }
    let lock: LockfileV1;
    let lockBytes: Uint8Array;
    try {
        lock = decodeLockfileValue(record['lock']);
        lockBytes = new TextEncoder().encode(serializeLockfile(lock));
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The replacement project lock is invalid',
            cause,
        );
    }
    const consistency = checkLockConsistency(project.manifest, revision.toolchain, lock);
    if (consistency.status !== 'consistent') {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The replacement manifest and lock are not one consistent dependency state',
        );
    }
    return Object.freeze({
        revision,
        manifestKind: kind,
        manifestBytes,
        project,
        lock,
        lockBytes,
    });
}

function resultFor(
    next: NextState,
    state: ProjectDependencyStateInspection,
    status: 'written' | 'hit',
): ProjectDependencyStateWriteResult {
    const manifestChanged = !Buffer.from(next.revision.manifest.bytes).equals(Buffer.from(next.manifestBytes));
    const lockChanged =
        next.revision.lock === null || !Buffer.from(next.revision.lock.bytes).equals(Buffer.from(next.lockBytes));
    return Object.freeze({
        status,
        cleanup: 'clean',
        manifest: Object.freeze({
            status: next.manifestKind === 'preserve' ? 'preserved' : manifestChanged ? 'written' : 'hit',
            byteSize: next.manifestBytes.byteLength,
            sha256: sha256(next.manifestBytes),
        }),
        lock: Object.freeze({
            status: lockChanged ? 'written' : 'hit',
            byteSize: next.lockBytes.byteLength,
            sha256: sha256(next.lockBytes),
        }),
        state,
    });
}

async function activeMarker(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    signal?: AbortSignal,
): Promise<Readonly<{
    readonly file: AuthenticatedFile;
    readonly marker: TransactionMarker;
}> | null> {
    const scan = await scanResidues(operations, root);
    if (scan.activeMarker === null) {
        return null;
    }
    const file = await readFile(operations, join(root, ACTIVE_MARKER_NAME), MAX_MARKER_BYTES, 'marker', signal);
    if (operations.enforcePosixModes && Number(file.identity.mode & 4095n) !== 0o600) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The active dependency transaction marker has the wrong physical mode',
        );
    }
    return Object.freeze({ file, marker: decodeMarker(file.bytes) });
}

async function assertActiveMarker(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    expected: AuthenticatedFile,
    token: string,
): Promise<void> {
    await recheckRoot(operations, rootSnapshot);
    await assertCanonicalEntry(operations, root, ACTIVE_MARKER_NAME, true);
    const active = await activeMarker(operations, root);
    if (
        active === null ||
        active.marker.token !== token ||
        !sameOwnedSnapshot(expected.identity, active.file.identity) ||
        !Buffer.from(expected.bytes).equals(Buffer.from(active.file.bytes))
    ) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The active dependency transaction marker changed during the operation',
        );
    }
    await recheckRoot(operations, rootSnapshot);
}

async function readIfPresent(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    name: string,
    maximum: number,
    kind: DocumentKind,
    signal?: AbortSignal,
): Promise<AuthenticatedFile | null> {
    const exists = await assertCanonicalEntry(operations, root, name, false);
    return exists ? await readFile(operations, join(root, name), maximum, kind, signal) : null;
}

async function restoreOldPair(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    marker: TransactionMarker,
    markerFile: AuthenticatedFile,
    names: TransactionNames,
    signal: AbortSignal,
): Promise<void> {
    async function guard(): Promise<void> {
        await assertActiveMarker(operations, root, rootSnapshot, markerFile, marker.token);
    }
    await guard();
    const nextManifest = await readIfPresent(
        operations,
        root,
        marker.manifestName,
        MAX_MANIFEST_BYTES,
        'manifest',
        signal,
    );
    if (nextManifest !== null && matchesBinding(nextManifest, marker.old.manifest)) {
        // The previous manifest remains in place.
    } else if (nextManifest !== null && matchesBinding(nextManifest, marker.next.manifest)) {
        await guard();
        await unlinkOwned(
            operations,
            root,
            rootSnapshot,
            marker.manifestName,
            nextManifest,
            MAX_MANIFEST_BYTES,
            'manifest',
        );
        await guard();
    } else if (nextManifest !== null) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The canonical manifest cannot be identified as old or new transaction content',
        );
    }
    const currentLock = await readIfPresent(operations, root, LOCK_NAME, LOCKFILE_LIMITS.maxBytes, 'lock', signal);
    if (currentLock !== null && marker.old.lock !== null && matchesBinding(currentLock, marker.old.lock)) {
        // The previous lock remains in place.
    } else if (currentLock !== null && matchesBinding(currentLock, marker.next.lock)) {
        await guard();
        await unlinkOwned(operations, root, rootSnapshot, LOCK_NAME, currentLock, LOCKFILE_LIMITS.maxBytes, 'lock');
        await guard();
    } else if (currentLock !== null) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The canonical lock cannot be identified as old or new transaction content',
        );
    }
    if (!(await assertCanonicalEntry(operations, root, marker.manifestName, false))) {
        const backup = await readIfPresent(
            operations,
            root,
            names.manifestBackup,
            MAX_MANIFEST_BYTES,
            'manifest',
            signal,
        );
        if (backup === null || !matchesBinding(backup, marker.old.manifest)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The previous manifest backup is unavailable for authenticated restoration',
            );
        }
        await guard();
        await linkOwned(
            operations,
            root,
            rootSnapshot,
            names.manifestBackup,
            marker.manifestName,
            backup,
            MAX_MANIFEST_BYTES,
            'manifest',
        );
        await guard();
    }
    if (marker.old.lock !== null && !(await assertCanonicalEntry(operations, root, LOCK_NAME, false))) {
        const backup = await readIfPresent(
            operations,
            root,
            names.lockBackup,
            LOCKFILE_LIMITS.maxBytes,
            'lock',
            signal,
        );
        if (backup === null || !matchesBinding(backup, marker.old.lock)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The previous lock backup is unavailable for authenticated restoration',
            );
        }
        await guard();
        await linkOwned(
            operations,
            root,
            rootSnapshot,
            names.lockBackup,
            LOCK_NAME,
            backup,
            LOCKFILE_LIMITS.maxBytes,
            'lock',
        );
        await guard();
    }
    if (marker.old.lock === null && (await assertCanonicalEntry(operations, root, LOCK_NAME, false))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'A lock remains even though the previous dependency state had no lock',
        );
    }
    await guard();
    const restoredManifest = await readFile(
        operations,
        join(root, marker.manifestName),
        MAX_MANIFEST_BYTES,
        'manifest',
        signal,
    );
    if (!matchesBinding(restoredManifest, marker.old.manifest)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The previous manifest was not restored exactly',
        );
    }
    if (marker.old.lock !== null) {
        const restoredLock = await readFile(
            operations,
            join(root, LOCK_NAME),
            LOCKFILE_LIMITS.maxBytes,
            'lock',
            signal,
        );
        if (!matchesBinding(restoredLock, marker.old.lock)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The previous lock was not restored exactly',
            );
        }
    }
}

async function verifyOldPairBeforeMarkerRemoval(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    marker: TransactionMarker,
    markerFile: AuthenticatedFile,
    signal: AbortSignal,
): Promise<void> {
    await assertActiveMarker(operations, root, rootSnapshot, markerFile, marker.token);
    const manifest = await readFile(
        operations,
        join(root, marker.manifestName),
        MAX_MANIFEST_BYTES,
        'manifest',
        signal,
    );
    if (!matchesBinding(manifest, marker.old.manifest)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The restored manifest changed before the transaction marker could be removed',
        );
    }
    if (marker.old.lock === null) {
        if (await assertCanonicalEntry(operations, root, LOCK_NAME, false)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'A lock appeared before the lock-free transaction state could be exposed',
            );
        }
    } else {
        const lock = await readFile(operations, join(root, LOCK_NAME), LOCKFILE_LIMITS.maxBytes, 'lock', signal);
        if (!matchesBinding(lock, marker.old.lock)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The restored lock changed before the transaction marker could be removed',
            );
        }
    }
    await recheckRoot(operations, rootSnapshot);
}

async function cleanupTransactionFiles(
    operations: ProjectDependencyStateNodeOperations,
    root: string,
    rootSnapshot: RootSnapshot,
    markerFile: AuthenticatedFile,
    marker: TransactionMarker,
    names: TransactionNames,
    signal: AbortSignal,
): Promise<void> {
    async function guard(): Promise<void> {
        await assertActiveMarker(operations, root, rootSnapshot, markerFile, marker.token);
    }
    await guard();
    const candidates: ReadonlyArray<readonly [string, Binding, number, DocumentKind]> = [
        [names.manifestStage, marker.stages.manifest, MAX_MANIFEST_BYTES, 'manifest'],
        [names.lockStage, marker.stages.lock, LOCKFILE_LIMITS.maxBytes, 'lock'],
        [names.manifestBackup, marker.old.manifest, MAX_MANIFEST_BYTES, 'manifest'],
        ...(marker.old.lock === null
            ? []
            : [[names.lockBackup, marker.old.lock, LOCKFILE_LIMITS.maxBytes, 'lock'] as const]),
    ] as const;
    for (const [name, binding, maximum, kind] of candidates) {
        signal.throwIfAborted();
        const file = await readIfPresent(operations, root, name, maximum, kind);
        if (file === null) {
            continue;
        }
        if (!matchesBinding(file, binding)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'A dependency transaction residue changed before authenticated cleanup',
            );
        }
        await guard();
        await unlinkOwned(operations, root, rootSnapshot, name, file, maximum, kind);
        await guard();
    }
    const markerStage = await readIfPresent(operations, root, names.markerStage, MAX_MARKER_BYTES, 'marker');
    if (markerStage !== null) {
        if (
            !sameOwnedSnapshot(markerFile.identity, markerStage.identity) ||
            !Buffer.from(markerFile.bytes).equals(Buffer.from(markerStage.bytes))
        ) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The dependency marker stage changed before authenticated cleanup',
            );
        }
        await guard();
        await unlinkOwned(operations, root, rootSnapshot, names.markerStage, markerStage, MAX_MARKER_BYTES, 'marker');
        await guard();
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

async function finalStateFor(
    operations: ProjectDependencyStateNodeOperations,
    next: NextState,
    signal: AbortSignal,
): Promise<ProjectDependencyStateInspection> {
    return await inspectAtLocation(
        operations,
        Object.freeze({
            filePath: join(next.revision.root, next.revision.manifestName),
            projectRoot: next.revision.root,
            manifestName: next.revision.manifestName,
            serializationFormat: next.revision.serializationFormat,
        }),
        next.revision.toolchain,
        signal,
    );
}

async function writePromise(
    input: WriteProjectDependencyStateInput,
    fileSystem: ProjectDependencyStateFileSystemPort,
    signal: AbortSignal,
): Promise<ProjectDependencyStateWriteResult> {
    signal.throwIfAborted();
    const next = nextState(input);
    const operations = fileSystem.operations;
    const revision = next.revision;
    await recheckInternal(operations, revision);
    const manifestChanged = !Buffer.from(revision.manifest.bytes).equals(Buffer.from(next.manifestBytes));
    const lockChanged = revision.lock === null || !Buffer.from(revision.lock.bytes).equals(Buffer.from(next.lockBytes));
    if (!manifestChanged && !lockChanged) {
        const state = await finalStateFor(operations, next, signal);
        return resultFor(next, state, 'hit');
    }
    const token = operations.token();
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_IO_FAILURE',
            'The filesystem did not provide a safe dependency transaction token',
        );
    }
    const names = namesFor(token);
    let manifestStage: AuthenticatedFile | undefined;
    let lockStage: AuthenticatedFile | undefined;
    let markerStage: AuthenticatedFile | undefined;
    let markerFile: AuthenticatedFile | undefined;
    let marker: TransactionMarker | undefined;
    let activePublished = false;
    let committed = false;
    try {
        await assertNoResidues(operations, revision.root);
        manifestStage = await writeStage(
            operations,
            revision.root,
            revision.rootSnapshot,
            names.manifestStage,
            next.manifestBytes,
            0o644,
            MAX_MANIFEST_BYTES,
            'manifest',
            signal,
        );
        lockStage = await writeStage(
            operations,
            revision.root,
            revision.rootSnapshot,
            names.lockStage,
            next.lockBytes,
            0o644,
            LOCKFILE_LIMITS.maxBytes,
            'lock',
            signal,
        );
        await recheckInternal(operations, revision, token);
        marker = Object.freeze({
            schema: MARKER_SCHEMA,
            token,
            manifestName: revision.manifestName,
            manifestFormat: revision.serializationFormat,
            old: Object.freeze({
                manifest: bindingFor(revision.manifest),
                lock: revision.lock === null ? null : bindingFor(revision.lock),
            }),
            stages: Object.freeze({
                manifest: bindingFor(manifestStage),
                lock: bindingFor(lockStage),
            }),
            next: Object.freeze({
                manifest: manifestChanged ? bindingFor(manifestStage) : bindingFor(revision.manifest),
                lock: bindingFor(lockStage),
                manifestDependencySha256: next.lock.manifestDependencySha256,
                toolchain: revision.toolchain,
            }),
        });
        const markerBytes = encodeMarker(marker);
        markerStage = await writeStage(
            operations,
            revision.root,
            revision.rootSnapshot,
            names.markerStage,
            markerBytes,
            0o600,
            MAX_MARKER_BYTES,
            'marker',
            signal,
        );
        await recheckInternal(operations, revision, token);
        signal.throwIfAborted();
        markerFile = await linkOwned(
            operations,
            revision.root,
            revision.rootSnapshot,
            names.markerStage,
            ACTIVE_MARKER_NAME,
            markerStage,
            MAX_MARKER_BYTES,
            'marker',
        );
        activePublished = true;
        const active = await activeMarker(operations, revision.root, signal);
        if (
            active === null ||
            active.marker.token !== token ||
            !sameOwnedSnapshot(markerFile.identity, active.file.identity) ||
            !Buffer.from(markerFile.bytes).equals(Buffer.from(active.file.bytes))
        ) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The active dependency transaction marker could not be authenticated',
            );
        }
        const authenticatedMarker = markerFile;
        async function guardActive(): Promise<void> {
            await assertActiveMarker(operations, revision.root, revision.rootSnapshot, authenticatedMarker, token);
        }
        await recheckInternal(operations, revision, token);
        await guardActive();
        signal.throwIfAborted();
        await guardActive();
        await linkOwned(
            operations,
            revision.root,
            revision.rootSnapshot,
            revision.manifestName,
            names.manifestBackup,
            revision.manifest,
            MAX_MANIFEST_BYTES,
            'manifest',
        );
        await guardActive();
        if (revision.lock !== null) {
            await guardActive();
            await linkOwned(
                operations,
                revision.root,
                revision.rootSnapshot,
                LOCK_NAME,
                names.lockBackup,
                revision.lock,
                LOCKFILE_LIMITS.maxBytes,
                'lock',
            );
            await guardActive();
        }
        await recheckInternal(operations, revision, token);
        await guardActive();
        signal.throwIfAborted();
        if (revision.lock !== null) {
            await guardActive();
            await unlinkOwned(
                operations,
                revision.root,
                revision.rootSnapshot,
                LOCK_NAME,
                revision.lock,
                LOCKFILE_LIMITS.maxBytes,
                'lock',
            );
            await guardActive();
        }
        await guardActive();
        await linkOwned(
            operations,
            revision.root,
            revision.rootSnapshot,
            names.lockStage,
            LOCK_NAME,
            lockStage,
            LOCKFILE_LIMITS.maxBytes,
            'lock',
        );
        await guardActive();
        signal.throwIfAborted();
        if (manifestChanged) {
            await guardActive();
            await unlinkOwned(
                operations,
                revision.root,
                revision.rootSnapshot,
                revision.manifestName,
                revision.manifest,
                MAX_MANIFEST_BYTES,
                'manifest',
            );
            await guardActive();
            await linkOwned(
                operations,
                revision.root,
                revision.rootSnapshot,
                names.manifestStage,
                revision.manifestName,
                manifestStage,
                MAX_MANIFEST_BYTES,
                'manifest',
            );
            await guardActive();
        }
        const finalManifest = await readFile(
            operations,
            join(revision.root, revision.manifestName),
            MAX_MANIFEST_BYTES,
            'manifest',
            signal,
        );
        const finalLock = await readFile(
            operations,
            join(revision.root, LOCK_NAME),
            LOCKFILE_LIMITS.maxBytes,
            'lock',
            signal,
        );
        if (!matchesBinding(finalManifest, marker.next.manifest) || !matchesBinding(finalLock, marker.next.lock)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The published dependency state does not match its authenticated stages',
            );
        }
        await recheckRoot(operations, revision.rootSnapshot);
        await guardActive();
        signal.throwIfAborted();
        await cleanupTransactionFiles(
            operations,
            revision.root,
            revision.rootSnapshot,
            markerFile,
            marker,
            names,
            signal,
        );
        const beforeCommitManifest = await readFile(
            operations,
            join(revision.root, revision.manifestName),
            MAX_MANIFEST_BYTES,
            'manifest',
            signal,
        );
        const beforeCommitLock = await readFile(
            operations,
            join(revision.root, LOCK_NAME),
            LOCKFILE_LIMITS.maxBytes,
            'lock',
            signal,
        );
        if (
            !matchesBinding(beforeCommitManifest, marker.next.manifest) ||
            !matchesBinding(beforeCommitLock, marker.next.lock)
        ) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The dependency state changed at the marker commit boundary',
            );
        }
        await recheckRoot(operations, revision.rootSnapshot);
        signal.throwIfAborted();
        try {
            await unlinkOwned(
                operations,
                revision.root,
                revision.rootSnapshot,
                ACTIVE_MARKER_NAME,
                markerFile,
                MAX_MARKER_BYTES,
                'marker',
            );
            committed = true;
        } catch (commitCause) {
            const scan = await scanResidues(operations, revision.root).catch(() => null);
            const reconciledManifest = await readIfPresent(
                operations,
                revision.root,
                revision.manifestName,
                MAX_MANIFEST_BYTES,
                'manifest',
            ).catch(() => null);
            const reconciledLock = await readIfPresent(
                operations,
                revision.root,
                LOCK_NAME,
                LOCKFILE_LIMITS.maxBytes,
                'lock',
            ).catch(() => null);
            if (
                scan === null ||
                scan.activeMarker !== null ||
                scan.entries.length !== 0 ||
                reconciledManifest === null ||
                !matchesBinding(reconciledManifest, marker.next.manifest) ||
                reconciledLock === null ||
                !matchesBinding(reconciledLock, marker.next.lock)
            ) {
                throw commitCause;
            }
            await recheckRoot(operations, revision.rootSnapshot);
            committed = true;
        }
        const state = await finalStateFor(operations, next, signal);
        return resultFor(next, state, 'written');
    } catch (cause) {
        const rollbackSignal = new AbortController().signal;
        if (committed) {
            try {
                const state = await finalStateFor(operations, next, rollbackSignal);
                return resultFor(next, state, 'written');
            } catch (reconcileCause) {
                throw new ProjectDependencyStateError(
                    'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                    'The committed dependency state could not be reconciled safely',
                    reconcileCause,
                );
            }
        }
        let unsafe = isProjectDependencyStateError(cause) && cause.code === 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE';
        try {
            if (activePublished && marker !== undefined && markerFile !== undefined) {
                const active = await activeMarker(operations, revision.root, rollbackSignal);
                if (
                    active === null ||
                    active.marker.token !== token ||
                    !sameOwnedSnapshot(markerFile.identity, active.file.identity) ||
                    !Buffer.from(markerFile.bytes).equals(Buffer.from(active.file.bytes))
                ) {
                    unsafe = true;
                } else {
                    await restoreOldPair(
                        operations,
                        revision.root,
                        revision.rootSnapshot,
                        marker,
                        active.file,
                        names,
                        rollbackSignal,
                    );
                    await cleanupTransactionFiles(
                        operations,
                        revision.root,
                        revision.rootSnapshot,
                        active.file,
                        marker,
                        names,
                        rollbackSignal,
                    );
                    await verifyOldPairBeforeMarkerRemoval(
                        operations,
                        revision.root,
                        revision.rootSnapshot,
                        marker,
                        active.file,
                        rollbackSignal,
                    );
                    await unlinkOwned(
                        operations,
                        revision.root,
                        revision.rootSnapshot,
                        ACTIVE_MARKER_NAME,
                        active.file,
                        MAX_MARKER_BYTES,
                        'marker',
                    );
                    await verifyRestoredRevision(operations, revision);
                }
            } else {
                async function clean(
                    name: string,
                    file: AuthenticatedFile | undefined,
                    maximum: number,
                    kind: DocumentKind,
                ): Promise<void> {
                    if (file === undefined) {
                        return;
                    }
                    if (await assertCanonicalEntry(operations, revision.root, name, false)) {
                        await unlinkOwned(operations, revision.root, revision.rootSnapshot, name, file, maximum, kind);
                    }
                }
                await clean(names.markerStage, markerStage, MAX_MARKER_BYTES, 'marker');
                await clean(names.lockStage, lockStage, LOCKFILE_LIMITS.maxBytes, 'lock');
                await clean(names.manifestStage, manifestStage, MAX_MANIFEST_BYTES, 'manifest');
                await recheckInternal(operations, revision);
            }
        } catch {
            unsafe = true;
        }
        if (unsafe) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The dependency transaction retained inert evidence because rollback could not be authenticated',
                cause,
            );
        }
        throw stateError(cause);
    }
}

interface RecoveryOptionsSnapshot {
    readonly from: string;
    readonly explicitPath?: string;
    readonly projectRoot?: string;
    readonly toolchain: LockToolchain;
}

function recoveryOptions(input: unknown): RecoveryOptionsSnapshot {
    const record = dataProperties(input, ['from', 'explicitPath', 'projectRoot', 'toolchain'], ['toolchain']);
    const from = record['from'] === undefined ? process.cwd() : record['from'];
    const explicitPath = record['explicitPath'];
    const projectRoot = record['projectRoot'];
    if (
        typeof from !== 'string' ||
        from.length === 0 ||
        from.includes('\0') ||
        (explicitPath !== undefined &&
            (typeof explicitPath !== 'string' || explicitPath.length === 0 || explicitPath.includes('\0'))) ||
        (projectRoot !== undefined &&
            (typeof projectRoot !== 'string' || projectRoot.length === 0 || projectRoot.includes('\0')))
    ) {
        throw new TypeError('recovery options are invalid');
    }
    return Object.freeze({
        from: resolve(from),
        ...(explicitPath === undefined ? {} : { explicitPath }),
        ...(projectRoot === undefined ? {} : { projectRoot: resolve(projectRoot) }),
        toolchain: decodeLockToolchain(record['toolchain']),
    });
}

async function locateRecoveryRoot(
    operations: ProjectDependencyStateNodeOperations,
    options: RecoveryOptionsSnapshot,
): Promise<string> {
    if (options.projectRoot !== undefined) {
        return options.projectRoot;
    }
    if (options.explicitPath !== undefined) {
        return dirname(resolve(options.from, options.explicitPath));
    }
    let directory = await initialDirectory(operations, options.from);
    for (;;) {
        const scan = await scanResidues(operations, directory);
        if (
            scan.activeMarker !== null ||
            scan.entries.length !== 0 ||
            recognizedCandidates(await readDirectory(operations, directory)).length !== 0
        ) {
            return directory;
        }
        const parent = dirname(directory);
        if (parent === directory) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_MANIFEST_UNAVAILABLE',
                'No project dependency state or recoverable transaction was found',
            );
        }
        directory = parent;
    }
}

function expectedResidueNames(names: TransactionNames): ReadonlySet<string> {
    return new Set([names.markerStage, names.manifestStage, names.lockStage, names.manifestBackup, names.lockBackup]);
}

async function recoverPromise(
    input: RecoverProjectDependencyStateInput,
    fileSystem: ProjectDependencyStateFileSystemPort,
    signal: AbortSignal,
): Promise<ProjectDependencyStateInspection> {
    let options: RecoveryOptionsSnapshot;
    try {
        options = recoveryOptions(input);
    } catch (cause) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_INVALID_INPUT',
            'The dependency transaction recovery options are invalid',
            cause,
        );
    }
    const operations = fileSystem.operations;
    const rootValue = await locateRecoveryRoot(operations, options);
    const { path: root, snapshot: rootSnapshot } = await snapshotRoot(operations, rootValue);
    const scan = await scanResidues(operations, root);
    if (scan.activeMarker === null && scan.entries.length === 0) {
        const location = await discoverLocation(
            operations,
            Object.freeze({
                from: options.from,
                ...(options.explicitPath === undefined ? {} : { explicitPath: options.explicitPath }),
                toolchain: options.toolchain,
            }),
        );
        return await inspectAtLocation(operations, location, options.toolchain, signal);
    }
    if (scan.activeMarker === null) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'Unmarked dependency transaction evidence cannot be attributed safely',
        );
    }
    const active = await activeMarker(operations, root, signal);
    if (active === null) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The active dependency transaction marker disappeared during recovery',
        );
    }
    const marker = active.marker;
    if (!sameToolchain(marker.next.toolchain, options.toolchain)) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The dependency transaction marker belongs to a different toolchain',
        );
    }
    if (
        options.explicitPath !== undefined &&
        basename(resolve(options.from, options.explicitPath)) !== marker.manifestName
    ) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'The dependency transaction marker belongs to a different manifest selection',
        );
    }
    const names = namesFor(marker.token);
    const allowedNames = expectedResidueNames(names);
    if (scan.entries.some((entry) => entry.token !== marker.token || !allowedNames.has(entry.name))) {
        throw new ProjectDependencyStateError(
            'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
            'Dependency transaction residues do not match the active marker token',
        );
    }
    const currentManifest = await readIfPresent(
        operations,
        root,
        marker.manifestName,
        MAX_MANIFEST_BYTES,
        'manifest',
        signal,
    );
    const currentLock = await readIfPresent(operations, root, LOCK_NAME, LOCKFILE_LIMITS.maxBytes, 'lock', signal);
    const completeNew =
        currentManifest !== null &&
        matchesBinding(currentManifest, marker.next.manifest) &&
        currentLock !== null &&
        matchesBinding(currentLock, marker.next.lock);
    const recoverySignal = new AbortController().signal;
    if (!completeNew) {
        await restoreOldPair(operations, root, rootSnapshot, marker, active.file, names, recoverySignal);
    }
    await cleanupTransactionFiles(operations, root, rootSnapshot, active.file, marker, names, recoverySignal);
    if (completeNew) {
        const finalManifest = await readFile(
            operations,
            join(root, marker.manifestName),
            MAX_MANIFEST_BYTES,
            'manifest',
        );
        const finalLock = await readFile(operations, join(root, LOCK_NAME), LOCKFILE_LIMITS.maxBytes, 'lock');
        if (!matchesBinding(finalManifest, marker.next.manifest) || !matchesBinding(finalLock, marker.next.lock)) {
            throw new ProjectDependencyStateError(
                'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE',
                'The completed dependency transaction changed during recovery cleanup',
            );
        }
        await recheckRoot(operations, rootSnapshot);
        await assertActiveMarker(operations, root, rootSnapshot, active.file, marker.token);
    } else {
        await verifyOldPairBeforeMarkerRemoval(operations, root, rootSnapshot, marker, active.file, recoverySignal);
    }
    signal.throwIfAborted();
    try {
        await unlinkOwned(operations, root, rootSnapshot, ACTIVE_MARKER_NAME, active.file, MAX_MARKER_BYTES, 'marker');
    } catch (cause) {
        const after = await scanResidues(operations, root).catch(() => null);
        const manifestAfter = await readIfPresent(
            operations,
            root,
            marker.manifestName,
            MAX_MANIFEST_BYTES,
            'manifest',
        ).catch(() => null);
        const lockAfter = await readIfPresent(operations, root, LOCK_NAME, LOCKFILE_LIMITS.maxBytes, 'lock').catch(
            () => null,
        );
        const expectedManifest = completeNew ? marker.next.manifest : marker.old.manifest;
        const lockMatches = completeNew
            ? lockAfter !== null && matchesBinding(lockAfter, marker.next.lock)
            : marker.old.lock === null
              ? lockAfter === null
              : lockAfter !== null && matchesBinding(lockAfter, marker.old.lock);
        if (
            after === null ||
            after.activeMarker !== null ||
            after.entries.length !== 0 ||
            manifestAfter === null ||
            !matchesBinding(manifestAfter, expectedManifest) ||
            !lockMatches
        ) {
            throw cause;
        }
        await recheckRoot(operations, rootSnapshot);
    }
    const location: DiscoveredLocation = Object.freeze({
        filePath: join(root, marker.manifestName),
        projectRoot: root,
        manifestName: marker.manifestName,
        serializationFormat: marker.manifestFormat,
    });
    return await inspectAtLocation(operations, location, options.toolchain, signal);
}

function fromAbortablePromise<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
): Effect.Effect<Value, ProjectDependencyStateError> {
    return Effect.acquireUseRelease(
        Effect.sync(() => {
            const controller = new AbortController();
            const promise = operation(controller.signal);
            return Object.freeze({ controller, promise });
        }),
        ({ promise }) => Effect.tryPromise({ try: () => promise, catch: stateError }),
        ({ controller, promise }) =>
            Effect.promise(async () => {
                controller.abort();
                await promise.catch(() => undefined);
            }),
    );
}

export interface ProjectDependencyStateServiceShape {
    readonly inspect: (
        input: InspectProjectDependencyStateInput,
    ) => Effect.Effect<ProjectDependencyStateInspection, ProjectDependencyStateError>;
    readonly recheck: (input: RecheckProjectDependencyStateInput) => Effect.Effect<void, ProjectDependencyStateError>;
    readonly write: (
        input: WriteProjectDependencyStateInput,
    ) => Effect.Effect<ProjectDependencyStateWriteResult, ProjectDependencyStateError>;
    /** Writer-only restart recovery. Read-only consumers must use inspect and fail on residue. */
    readonly recover: (
        input: RecoverProjectDependencyStateInput,
    ) => Effect.Effect<ProjectDependencyStateInspection, ProjectDependencyStateError>;
}

export const ProjectDependencyStateService = Context.Service<ProjectDependencyStateServiceShape>(
    '@erden/project/ProjectDependencyStateService',
);

export function makeProjectDependencyStateService(
    fileSystem: ProjectDependencyStateFileSystemPort,
): ProjectDependencyStateServiceShape {
    return Object.freeze({
        inspect: (input: InspectProjectDependencyStateInput) =>
            fromAbortablePromise(async (signal) => await inspectPromise(input, fileSystem, signal)),
        recheck: (input: RecheckProjectDependencyStateInput) =>
            fromAbortablePromise(async (signal) => {
                await recheckPromise(input, fileSystem, signal);
            }),
        write: (input: WriteProjectDependencyStateInput) =>
            fromAbortablePromise(async (signal) => await writePromise(input, fileSystem, signal)),
        recover: (input: RecoverProjectDependencyStateInput) =>
            fromAbortablePromise(async (signal) => await recoverPromise(input, fileSystem, signal)),
    });
}

export const nodeProjectDependencyStateService = makeProjectDependencyStateService(
    makeNodeProjectDependencyStateFileSystemPort(),
);

export function inspectProjectDependencyState(
    input: InspectProjectDependencyStateInput,
): Effect.Effect<
    ProjectDependencyStateInspection,
    ProjectDependencyStateError,
    Context.Service.Identifier<typeof ProjectDependencyStateService>
> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(ProjectDependencyStateService);
        return yield* service.inspect(input);
    });
}

export function recheckProjectDependencyState(
    input: RecheckProjectDependencyStateInput,
): Effect.Effect<void, ProjectDependencyStateError, Context.Service.Identifier<typeof ProjectDependencyStateService>> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(ProjectDependencyStateService);
        return yield* service.recheck(input);
    });
}

export function writeProjectDependencyState(
    input: WriteProjectDependencyStateInput,
): Effect.Effect<
    ProjectDependencyStateWriteResult,
    ProjectDependencyStateError,
    Context.Service.Identifier<typeof ProjectDependencyStateService>
> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(ProjectDependencyStateService);
        return yield* service.write(input);
    });
}

export function recoverProjectDependencyState(
    input: RecoverProjectDependencyStateInput,
): Effect.Effect<
    ProjectDependencyStateInspection,
    ProjectDependencyStateError,
    Context.Service.Identifier<typeof ProjectDependencyStateService>
> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(ProjectDependencyStateService);
        return yield* service.recover(input);
    });
}
