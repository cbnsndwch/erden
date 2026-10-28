import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

import { Context, Effect } from 'effect';

import {
    checkLockConsistency,
    decodeLockfileValue,
    decodeLockToolchain,
    LOCKFILE_LIMITS,
    parseLockfile,
    serializeLockfile,
    type LockfileV1,
} from '@erden/contracts';

import type { ApplicationOperation } from '../index.js';

import { ProjectLockError } from './errors.js';
import {
    makeNodeProjectLockFileSystemPort,
    type ProjectLockFileSystemPort,
    type ProjectLockNodeOperations,
} from './filesystem.js';
import type {
    InspectProjectLockInput,
    ProjectLockInspection,
    ProjectLockWriteResult,
    WriteProjectLockInput,
} from './model.js';

const LOCK_NAME = 'erden.lock';
const TOKEN = /^[0-9A-Za-z_-]{16,128}$/u;
const MAX_ROOT_ENTRIES = 100_000;
const MAX_ROOT_NAME_BYTES = 16 * 1024 * 1024;

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
    readonly chain: ReadonlyArray<{ readonly path: string; readonly identity: Identity }>;
    readonly realPathKey: string;
}

interface AuthenticatedFile {
    readonly identity: Identity;
    readonly bytes: Uint8Array;
}

function errorCode(cause: unknown): string | undefined {
    return cause !== null && typeof cause === 'object' && 'code' in cause
        ? String(
              (
                  cause as {
                      readonly code?: unknown;
                  }
              ).code,
          )
        : undefined;
}

function projectLockError(cause: unknown): ProjectLockError {
    return cause instanceof ProjectLockError
        ? cause
        : new ProjectLockError('PROJECT_LOCK_IO_FAILURE', 'The project lock operation could not complete', cause);
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
    throw new ProjectLockError(
        'PROJECT_LOCK_ROOT_UNAVAILABLE',
        'The project lock path is not a regular filesystem entry',
    );
}

function sameIdentity(expected: Identity, actual: BigIntStats): boolean {
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

async function lstatOrNull(operations: ProjectLockNodeOperations, path: string): Promise<BigIntStats | null> {
    try {
        return await operations.lstat(path, { bigint: true });
    } catch (cause) {
        if (errorCode(cause) === 'ENOENT') {
            return null;
        }
        throw cause;
    }
}

function portableKey(value: string): string {
    return value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

async function readDirectory(operations: ProjectLockNodeOperations, path: string): Promise<ReadonlyArray<string>> {
    const directory = await operations.opendir(path);
    const names: string[] = [];
    let nameBytes = 0;
    try {
        for await (const entry of directory) {
            if (names.length >= MAX_ROOT_ENTRIES) {
                throw new ProjectLockError(
                    'PROJECT_LOCK_ROOT_UNAVAILABLE',
                    'The project root exceeds the closed directory-entry bound',
                );
            }
            nameBytes += Buffer.byteLength(entry.name, 'utf8');
            if (nameBytes > MAX_ROOT_NAME_BYTES) {
                throw new ProjectLockError(
                    'PROJECT_LOCK_ROOT_UNAVAILABLE',
                    'The project root exceeds the closed directory-name bound',
                );
            }
            names.push(entry.name);
        }
    } finally {
        await directory.close().catch(() => undefined);
    }
    return Object.freeze(names);
}

async function assertCanonicalEntry(
    operations: ProjectLockNodeOperations,
    root: string,
    expected: string,
    required: boolean,
): Promise<boolean> {
    const key = portableKey(expected);
    let found = false;
    for (const entry of await readDirectory(operations, root)) {
        if (portableKey(entry) !== key) {
            continue;
        }
        if (entry !== expected || found) {
            throw new ProjectLockError(
                'PROJECT_LOCK_INVALID',
                'A portable filesystem-name collision makes erden.lock ambiguous',
            );
        }
        found = true;
    }
    if (required && !found) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID',
            'The canonical erden.lock entry changed during the operation',
        );
    }
    return found;
}

interface LockTransactionResidues {
    readonly stages: ReadonlyArray<{ readonly name: string; readonly token: string }>;
    readonly backups: ReadonlyArray<{ readonly name: string; readonly token: string }>;
}

async function scanTransactionResidues(
    operations: ProjectLockNodeOperations,
    root: string,
): Promise<LockTransactionResidues> {
    const prefix = '.erden.lock.';
    const foldedPrefix = portableKey(prefix);
    const expression = /^\.erden\.lock\.(stage|backup)-([0-9A-Za-z_-]{16,128})$/u;
    const stages: Array<{
        readonly name: string;
        readonly token: string;
    }> = [];
    const backups: Array<{
        readonly name: string;
        readonly token: string;
    }> = [];
    for (const name of await readDirectory(operations, root)) {
        if (portableKey(name).startsWith(portableKey('.erden.dependencies.'))) {
            throw new ProjectLockError(
                'PROJECT_LOCK_INVALID',
                'A project dependency transaction blocks direct lock access',
            );
        }
        if (!portableKey(name).startsWith(foldedPrefix)) {
            continue;
        }
        const match = expression.exec(name);
        if (match === null) {
            throw new ProjectLockError(
                'PROJECT_LOCK_INVALID',
                'A noncanonical project-lock transaction residue requires explicit repair',
            );
        }
        const kind = match[1];
        const token = match[2];
        if (token === undefined) {
            throw new ProjectLockError('PROJECT_LOCK_INVALID', 'A project-lock transaction token is invalid');
        }
        const item = Object.freeze({ name, token });
        if (kind === 'stage') {
            stages.push(item);
        } else {
            backups.push(item);
        }
    }
    return Object.freeze({ stages: Object.freeze(stages), backups: Object.freeze(backups) });
}

async function snapshotRoot(
    operations: ProjectLockNodeOperations,
    value: string,
): Promise<{
    readonly path: string;
    readonly snapshot: RootSnapshot;
}> {
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || value.includes('\0')) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID_INPUT',
            'The project root must be one absolute filesystem path',
        );
    }
    const path = resolve(value);
    const pathRoot = parse(path).root;
    const parts = path
        .slice(pathRoot.length)
        .split(sep)
        .filter((part) => part.length > 0);
    const chain: Array<{
        readonly path: string;
        readonly identity: Identity;
    }> = [];
    let current = pathRoot;
    const rootStats = await operations.lstat(pathRoot, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new ProjectLockError('PROJECT_LOCK_ROOT_UNAVAILABLE', 'The filesystem root is not one regular directory');
    }
    chain.push(Object.freeze({ path: pathRoot, identity: identity(rootStats) }));
    for (const part of parts) {
        current = join(current, part);
        const stats = await operations.lstat(current, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROOT_UNAVAILABLE',
                'A symbolic, reparse, or non-directory project ancestor is not allowed',
            );
        }
        chain.push(Object.freeze({ path: current, identity: identity(stats) }));
    }
    const root = chain.at(-1)?.identity;
    if (root === undefined) {
        throw new ProjectLockError('PROJECT_LOCK_ROOT_UNAVAILABLE', 'The project root could not be authenticated');
    }
    const realPath = await operations.realpath(path);
    if (portableKey(resolve(realPath)) !== portableKey(path)) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROOT_UNAVAILABLE',
            'A symbolic or reparse project-root spelling is not allowed',
        );
    }
    return Object.freeze({
        path,
        snapshot: Object.freeze({ root, chain: Object.freeze(chain), realPathKey: portableKey(resolve(realPath)) }),
    });
}

async function recheckRoot(operations: ProjectLockNodeOperations, snapshot: RootSnapshot): Promise<void> {
    for (const entry of snapshot.chain) {
        const stats = await operations.lstat(entry.path, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(entry.identity, stats)) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROOT_UNAVAILABLE',
                'The authenticated project root changed during the lock operation',
            );
        }
    }
    const realPath = await operations.realpath(snapshot.chain.at(-1)?.path ?? '');
    if (portableKey(resolve(realPath)) !== snapshot.realPathKey) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROOT_UNAVAILABLE',
            'The authenticated project root target changed during the lock operation',
        );
    }
}

async function readHandle(
    operations: ProjectLockNodeOperations,
    path: string,
    maximum: number,
    signal?: AbortSignal,
): Promise<AuthenticatedFile> {
    signal?.throwIfAborted();
    const before = await operations.lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock is not a regular file');
    }
    const expected = identity(before);
    if (expected.size < 0n || expected.size > BigInt(maximum)) {
        throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock exceeds the closed byte bound');
    }
    const handle = await operations.open(path, 'r');
    try {
        const opened = await operations.stat(handle);
        if (!sameIdentity(expected, opened) || opened.size < 0n || opened.size > BigInt(maximum)) {
            throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock changed before it could be read');
        }
        const bytes = new Uint8Array(Number(opened.size));
        let offset = 0;
        while (offset < bytes.byteLength) {
            signal?.throwIfAborted();
            const { bytesRead } = await operations.read(handle, bytes, offset, bytes.byteLength - offset, offset);
            if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.byteLength - offset) {
                throw new ProjectLockError('PROJECT_LOCK_IO_FAILURE', 'erden.lock could not be read completely');
            }
            offset += bytesRead;
        }
        const afterHandle = await operations.stat(handle);
        const afterPath = await operations.lstat(path, { bigint: true });
        signal?.throwIfAborted();
        if (!sameSnapshot(expected, identity(afterHandle)) || !sameSnapshot(expected, identity(afterPath))) {
            throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock changed while it was being read');
        }
        return Object.freeze({ identity: expected, bytes });
    } finally {
        await operations.close(handle).catch(() => undefined);
    }
}

async function matchesFile(
    operations: ProjectLockNodeOperations,
    path: string,
    expected: AuthenticatedFile,
): Promise<boolean> {
    try {
        const actual = await readHandle(operations, path, Math.max(expected.bytes.byteLength, 1));
        return (
            sameSnapshot(expected.identity, actual.identity) &&
            Buffer.from(actual.bytes).equals(Buffer.from(expected.bytes))
        );
    } catch {
        return false;
    }
}

async function matchesOwnedFile(
    operations: ProjectLockNodeOperations,
    path: string,
    expected: AuthenticatedFile,
): Promise<boolean> {
    try {
        const actual = await readHandle(operations, path, Math.max(expected.bytes.byteLength, 1));
        return (
            expected.identity.dev === actual.identity.dev &&
            expected.identity.ino === actual.identity.ino &&
            expected.identity.kind === actual.identity.kind &&
            expected.identity.mode === actual.identity.mode &&
            expected.identity.size === actual.identity.size &&
            expected.identity.mtimeNs === actual.identity.mtimeNs &&
            Buffer.from(actual.bytes).equals(Buffer.from(expected.bytes))
        );
    } catch {
        return false;
    }
}

async function removeCreatedFile(
    operations: ProjectLockNodeOperations,
    path: string,
    created: Identity,
    expectedPrefix: Uint8Array,
): Promise<boolean> {
    try {
        const current = await operations.lstat(path, { bigint: true });
        if (!sameIdentity(created, current) || current.size !== BigInt(expectedPrefix.byteLength)) {
            return false;
        }
        const captured = await readHandle(operations, path, expectedPrefix.byteLength);
        if (
            captured.identity.dev !== created.dev ||
            captured.identity.ino !== created.ino ||
            !Buffer.from(captured.bytes).equals(Buffer.from(expectedPrefix))
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

async function writeHandle(
    operations: ProjectLockNodeOperations,
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<AuthenticatedFile> {
    let handle: FileHandle | undefined;
    try {
        handle = await operations.open(path, 'wx', 0o600);
    } catch (cause) {
        if ((await lstatOrNull(operations, path)) !== null) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'A lock transaction file appeared without authenticated ownership',
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
            throw new ProjectLockError('PROJECT_LOCK_IO_FAILURE', 'The staged erden.lock is not a regular file');
        }
        created = identity(opened);
        let offset = 0;
        while (offset < bytes.byteLength) {
            signal.throwIfAborted();
            const { bytesWritten } = await operations.write(handle, bytes, offset, bytes.byteLength - offset);
            if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
                throw new ProjectLockError(
                    'PROJECT_LOCK_IO_FAILURE',
                    'The canonical erden.lock bytes could not be written completely',
                );
            }
            offset += bytesWritten;
            writtenBytes = offset;
        }
        await operations.sync(handle);
        await operations.close(handle);
        handle = undefined;
        await operations.chmod(path, 0o644);
        const written = await readHandle(operations, path, bytes.byteLength, signal);
        if (
            created.dev !== written.identity.dev ||
            created.ino !== written.identity.ino ||
            !Buffer.from(written.bytes).equals(Buffer.from(bytes))
        ) {
            throw new ProjectLockError('PROJECT_LOCK_IO_FAILURE', 'The staged erden.lock bytes did not verify');
        }
        if (operations.enforcePosixModes && Number(written.identity.mode & 4095n) !== 0o644) {
            throw new ProjectLockError('PROJECT_LOCK_IO_FAILURE', 'The staged erden.lock mode did not verify');
        }
        return written;
    } catch (cause) {
        if (handle !== undefined) {
            await operations.close(handle).catch(() => undefined);
        }
        if (created === undefined) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'A staged lock file was created without authenticated ownership',
                cause,
            );
        }
        if (!(await removeCreatedFile(operations, path, created, bytes.slice(0, writtenBytes)))) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The staged lock file changed before authenticated cleanup',
                cause,
            );
        }
        throw cause;
    }
}

async function removeOwnedFile(
    operations: ProjectLockNodeOperations,
    path: string,
    expected: AuthenticatedFile,
): Promise<boolean> {
    try {
        const captured = await readHandle(operations, path, Math.max(expected.bytes.byteLength, 1));
        if (
            captured.identity.dev !== expected.identity.dev ||
            captured.identity.ino !== expected.identity.ino ||
            captured.identity.kind !== expected.identity.kind ||
            captured.identity.mode !== expected.identity.mode ||
            captured.identity.size !== expected.identity.size ||
            captured.identity.mtimeNs !== expected.identity.mtimeNs ||
            !Buffer.from(captured.bytes).equals(Buffer.from(expected.bytes))
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

async function inspectPromise(
    input: InspectProjectLockInput,
    fileSystem: ProjectLockFileSystemPort,
    signal: AbortSignal,
): Promise<ProjectLockInspection> {
    signal.throwIfAborted();
    const toolchain = decodeLockToolchain(input.toolchain);
    const { path: root, snapshot } = await snapshotRoot(fileSystem.operations, input.project.projectRoot);
    const residues = await scanTransactionResidues(fileSystem.operations, root);
    if (residues.stages.length !== 0 || residues.backups.length !== 0) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID',
            'An interrupted project-lock transaction requires install recovery',
        );
    }
    const exists = await assertCanonicalEntry(fileSystem.operations, root, LOCK_NAME, false);
    if (!exists) {
        await recheckRoot(fileSystem.operations, snapshot);
        if (await assertCanonicalEntry(fileSystem.operations, root, LOCK_NAME, false)) {
            throw new ProjectLockError(
                'PROJECT_LOCK_INVALID',
                'erden.lock appeared during the final missing-lock validation',
            );
        }
        await recheckRoot(fileSystem.operations, snapshot);
        const terminalResidues = await scanTransactionResidues(fileSystem.operations, root);
        if (terminalResidues.stages.length !== 0 || terminalResidues.backups.length !== 0) {
            throw new ProjectLockError(
                'PROJECT_LOCK_INVALID',
                'An interrupted project-lock transaction requires install recovery',
            );
        }
        signal.throwIfAborted();
        return Object.freeze({ status: 'missing', lock: null, canonicalBytes: null, reasons: Object.freeze([]) });
    }
    const lockPath = join(root, LOCK_NAME);
    const source = await readHandle(fileSystem.operations, lockPath, LOCKFILE_LIMITS.maxBytes, signal);
    if (fileSystem.operations.enforcePosixModes && Number(source.identity.mode & 4095n) !== 0o644) {
        throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock does not have the exact canonical file mode');
    }
    let lock: LockfileV1;
    let canonical: Uint8Array;
    try {
        lock = parseLockfile(source.bytes);
        canonical = new TextEncoder().encode(serializeLockfile(lock));
    } catch (cause) {
        throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock is not a valid canonical v1 lockfile', cause);
    }
    if (!Buffer.from(source.bytes).equals(Buffer.from(canonical))) {
        throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock is not the exact canonical v1 serialization');
    }
    const consistency = checkLockConsistency(input.project.manifest, toolchain, lock);
    const finalResidues = await scanTransactionResidues(fileSystem.operations, root);
    if (finalResidues.stages.length !== 0 || finalResidues.backups.length !== 0) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID',
            'An interrupted project-lock transaction requires install recovery',
        );
    }
    await assertCanonicalEntry(fileSystem.operations, root, LOCK_NAME, true);
    await recheckRoot(fileSystem.operations, snapshot);
    if (!(await matchesFile(fileSystem.operations, lockPath, source))) {
        throw new ProjectLockError('PROJECT_LOCK_INVALID', 'erden.lock changed during final consistency validation');
    }
    const terminalResidues = await scanTransactionResidues(fileSystem.operations, root);
    if (terminalResidues.stages.length !== 0 || terminalResidues.backups.length !== 0) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID',
            'An interrupted project-lock transaction requires install recovery',
        );
    }
    signal.throwIfAborted();
    if (consistency.status === 'stale') {
        return Object.freeze({ status: 'stale', lock, canonicalBytes: canonical, reasons: consistency.reasons });
    }
    return Object.freeze({ status: 'available', lock, canonicalBytes: canonical, reasons: Object.freeze([]) });
}

async function restoreBackup(
    operations: ProjectLockNodeOperations,
    root: string,
    backupPath: string,
    backup: AuthenticatedFile,
): Promise<void> {
    const lockPath = join(root, LOCK_NAME);
    if (await assertCanonicalEntry(operations, root, LOCK_NAME, false)) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'A foreign erden.lock blocks authenticated restoration',
        );
    }
    try {
        await operations.link(backupPath, lockPath);
    } catch (cause) {
        if (!(await matchesOwnedFile(operations, lockPath, backup))) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The previous erden.lock could not be restored without overwrite',
                cause,
            );
        }
    }
    if (!(await matchesOwnedFile(operations, lockPath, backup))) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'The restored erden.lock identity is not the authenticated backup',
        );
    }
    if (!(await removeOwnedFile(operations, backupPath, backup))) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'The authenticated backup could not be retired after restoration',
        );
    }
}

async function recoverTransactionResidues(
    operations: ProjectLockNodeOperations,
    root: string,
    snapshot: RootSnapshot,
    desiredBytes: Uint8Array,
    signal: AbortSignal,
): Promise<'clean' | 'cleanup-residue-retained'> {
    const residues = await scanTransactionResidues(operations, root);
    if (residues.stages.length === 0 && residues.backups.length === 0) {
        return 'clean';
    }
    if (residues.stages.length > 1 || residues.backups.length > 1) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID',
            'Multiple interrupted project-lock transactions require explicit repair',
        );
    }
    const stageEntry = residues.stages[0];
    const backupEntry = residues.backups[0];
    if (stageEntry !== undefined && backupEntry !== undefined && stageEntry.token !== backupEntry.token) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID',
            'Interrupted project-lock stage and backup tokens do not match',
        );
    }
    const lockExists = await assertCanonicalEntry(operations, root, LOCK_NAME, false);
    const current = lockExists
        ? await readHandle(operations, join(root, LOCK_NAME), desiredBytes.byteLength, signal)
        : undefined;
    if (
        current !== undefined &&
        (!Buffer.from(current.bytes).equals(Buffer.from(desiredBytes)) ||
            (operations.enforcePosixModes && Number(current.identity.mode & 4095n) !== 0o644))
    ) {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID',
            'An interrupted transaction coexists with an unrecognized erden.lock',
        );
    }
    let stage: AuthenticatedFile | undefined;
    if (stageEntry !== undefined) {
        stage = await readHandle(operations, join(root, stageEntry.name), desiredBytes.byteLength, signal);
        if (
            !Buffer.from(stage.bytes).equals(Buffer.from(desiredBytes)) ||
            (operations.enforcePosixModes && Number(stage.identity.mode & 4095n) !== 0o644)
        ) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'An interrupted lock stage cannot be authenticated as the requested canonical lock',
            );
        }
    }
    const backup =
        backupEntry === undefined
            ? undefined
            : await readHandle(operations, join(root, backupEntry.name), LOCKFILE_LIMITS.maxBytes, signal);
    if (backup !== undefined) {
        try {
            const decoded = parseLockfile(backup.bytes);
            if (
                !Buffer.from(new TextEncoder().encode(serializeLockfile(decoded))).equals(Buffer.from(backup.bytes)) ||
                (operations.enforcePosixModes && Number(backup.identity.mode & 4095n) !== 0o644)
            ) {
                throw new Error('backup canonical bytes');
            }
        } catch (cause) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The interrupted lock backup is not one authenticated canonical lock',
                cause,
            );
        }
    }
    await recheckRoot(operations, snapshot);
    signal.throwIfAborted();
    let cleanupResidue = false;
    if (
        stage !== undefined &&
        stageEntry !== undefined &&
        !(await removeOwnedFile(operations, join(root, stageEntry.name), stage))
    ) {
        if (current !== undefined && (await matchesOwnedFile(operations, join(root, stageEntry.name), stage))) {
            cleanupResidue = true;
        } else {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The interrupted lock stage changed before recovery',
            );
        }
    }
    if (backup !== undefined && backupEntry !== undefined) {
        if (current === undefined) {
            await restoreBackup(operations, root, join(root, backupEntry.name), backup);
        } else if (!(await removeOwnedFile(operations, join(root, backupEntry.name), backup))) {
            if (await matchesOwnedFile(operations, join(root, backupEntry.name), backup)) {
                cleanupResidue = true;
            } else {
                throw new ProjectLockError(
                    'PROJECT_LOCK_ROLLBACK_UNSAFE',
                    'The authenticated completed-publication backup changed during retirement',
                );
            }
        }
    }
    const finalResidues = await scanTransactionResidues(operations, root);
    if (!cleanupResidue && (finalResidues.stages.length !== 0 || finalResidues.backups.length !== 0)) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'Interrupted project-lock residue remained after authenticated recovery',
        );
    }
    if (current !== undefined) {
        const currentAfterCleanup = await readHandle(
            operations,
            join(root, LOCK_NAME),
            desiredBytes.byteLength,
            signal,
        );
        if (
            currentAfterCleanup.identity.dev !== current.identity.dev ||
            currentAfterCleanup.identity.ino !== current.identity.ino ||
            currentAfterCleanup.identity.mode !== current.identity.mode ||
            currentAfterCleanup.identity.mtimeNs !== current.identity.mtimeNs ||
            !Buffer.from(currentAfterCleanup.bytes).equals(Buffer.from(current.bytes))
        ) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The completed erden.lock changed during transaction recovery',
            );
        }
    }
    await recheckRoot(operations, snapshot);
    return cleanupResidue ? 'cleanup-residue-retained' : 'clean';
}

async function movePreviousToBackup(
    operations: ProjectLockNodeOperations,
    root: string,
    backupPath: string,
    previous: AuthenticatedFile,
): Promise<AuthenticatedFile> {
    const lockPath = join(root, LOCK_NAME);
    if (!(await matchesFile(operations, lockPath, previous))) {
        throw new ProjectLockError('PROJECT_LOCK_ROLLBACK_UNSAFE', 'The previous erden.lock changed before backup');
    }
    if ((await lstatOrNull(operations, backupPath)) !== null) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'A backup target appeared before the lock transaction',
        );
    }
    try {
        await operations.link(lockPath, backupPath);
    } catch (cause) {
        if (!(await matchesOwnedFile(operations, backupPath, previous))) {
            if ((await lstatOrNull(operations, backupPath)) !== null) {
                throw new ProjectLockError(
                    'PROJECT_LOCK_ROLLBACK_UNSAFE',
                    'A foreign backup entry blocked the lock transaction',
                    cause,
                );
            }
            throw cause;
        }
    }
    const linked = await readHandle(operations, backupPath, LOCKFILE_LIMITS.maxBytes);
    if (
        linked.identity.dev !== previous.identity.dev ||
        linked.identity.ino !== previous.identity.ino ||
        linked.identity.mode !== previous.identity.mode ||
        linked.identity.mtimeNs !== previous.identity.mtimeNs ||
        !Buffer.from(linked.bytes).equals(Buffer.from(previous.bytes))
    ) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'The previous lock backup is not identity-bound to erden.lock',
        );
    }
    try {
        await operations.unlink(lockPath);
    } catch (cause) {
        const current = await lstatOrNull(operations, lockPath);
        if (current === null) {
            return await readHandle(operations, backupPath, LOCKFILE_LIMITS.maxBytes);
        }
        if (
            sameIdentity(previous.identity, current) &&
            (await matchesOwnedFile(operations, backupPath, linked)) &&
            (await removeOwnedFile(operations, backupPath, linked))
        ) {
            throw cause;
        }
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'The previous erden.lock backup move has an ambiguous result',
            cause,
        );
    }
    return await readHandle(operations, backupPath, LOCKFILE_LIMITS.maxBytes);
}

async function publishStage(
    operations: ProjectLockNodeOperations,
    root: string,
    stagePath: string,
    stage: AuthenticatedFile,
): Promise<{
    readonly final: AuthenticatedFile;
    readonly cleanupResidue: boolean;
}> {
    const lockPath = join(root, LOCK_NAME);
    if (!(await matchesFile(operations, stagePath, stage))) {
        throw new ProjectLockError('PROJECT_LOCK_ROLLBACK_UNSAFE', 'The staged erden.lock changed before publication');
    }
    if (await assertCanonicalEntry(operations, root, LOCK_NAME, false)) {
        throw new ProjectLockError('PROJECT_LOCK_ROLLBACK_UNSAFE', 'A foreign erden.lock appeared before publication');
    }
    try {
        await operations.link(stagePath, lockPath);
    } catch (cause) {
        if (!(await matchesOwnedFile(operations, lockPath, stage))) {
            if ((await lstatOrNull(operations, lockPath)) !== null) {
                throw new ProjectLockError(
                    'PROJECT_LOCK_ROLLBACK_UNSAFE',
                    'A foreign erden.lock blocked atomic publication',
                    cause,
                );
            }
            throw cause;
        }
    }
    if (!(await matchesOwnedFile(operations, lockPath, stage))) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'The published erden.lock is not the authenticated stage inode',
        );
    }
    const cleanupResidue = !(await removeOwnedFile(operations, stagePath, stage));
    const final = await readHandle(operations, lockPath, stage.bytes.byteLength);
    if (
        final.identity.dev !== stage.identity.dev ||
        final.identity.ino !== stage.identity.ino ||
        final.identity.mode !== stage.identity.mode ||
        final.identity.mtimeNs !== stage.identity.mtimeNs ||
        !Buffer.from(final.bytes).equals(Buffer.from(stage.bytes))
    ) {
        throw new ProjectLockError(
            'PROJECT_LOCK_ROLLBACK_UNSAFE',
            'The final erden.lock identity or bytes changed during publication',
        );
    }
    return Object.freeze({ final, cleanupResidue });
}

async function writePromise(
    input: WriteProjectLockInput,
    fileSystem: ProjectLockFileSystemPort,
    signal: AbortSignal,
): Promise<ProjectLockWriteResult> {
    signal.throwIfAborted();
    const operations = fileSystem.operations;
    const lock = decodeLockfileValue(input.lock);
    const toolchain = decodeLockToolchain(input.toolchain);
    const consistency = checkLockConsistency(input.project.manifest, toolchain, lock);
    if (consistency.status !== 'consistent') {
        throw new ProjectLockError(
            'PROJECT_LOCK_INVALID_INPUT',
            'The supplied lock does not match the project manifest and current toolchain',
        );
    }
    const bytes = new TextEncoder().encode(serializeLockfile(lock));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { path: root, snapshot } = await snapshotRoot(operations, input.project.projectRoot);
    const lockPath = join(root, LOCK_NAME);
    const recoveryCleanup = await recoverTransactionResidues(operations, root, snapshot, bytes, signal);
    const exactExists = await assertCanonicalEntry(operations, root, LOCK_NAME, false);
    const initialPrevious = exactExists
        ? await readHandle(operations, lockPath, LOCKFILE_LIMITS.maxBytes, signal)
        : undefined;
    if (exactExists) {
        try {
            const current = await inspectPromise(input, fileSystem, signal);
            if (
                current.status === 'available' &&
                Buffer.from(current.canonicalBytes).equals(Buffer.from(bytes)) &&
                initialPrevious !== undefined &&
                (await matchesFile(operations, lockPath, initialPrevious))
            ) {
                return Object.freeze({ status: 'hit', cleanup: recoveryCleanup, bytes: bytes.byteLength, sha256 });
            }
        } catch (cause) {
            if (!(cause instanceof ProjectLockError) || cause.code === 'PROJECT_LOCK_ROOT_UNAVAILABLE') {
                throw cause;
            }
        }
    }
    const token = operations.token();
    if (!TOKEN.test(token)) {
        throw new ProjectLockError(
            'PROJECT_LOCK_IO_FAILURE',
            'The filesystem did not provide a safe lock transaction token',
        );
    }
    const stageName = `.erden.lock.stage-${token}`;
    const backupName = `.erden.lock.backup-${token}`;
    const stagePath = join(root, stageName);
    const backupPath = join(root, backupName);
    for (const name of [stageName, backupName]) {
        if (await assertCanonicalEntry(operations, root, name, false)) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'A lock transaction residue blocks safe publication',
            );
        }
    }
    let stage: AuthenticatedFile | undefined;
    let previous: AuthenticatedFile | undefined;
    let previousMoved = false;
    let committed = false;
    let published: AuthenticatedFile | undefined;
    let cleanupResidue = false;
    try {
        await scanTransactionResidues(operations, root);
        stage = await writeHandle(operations, stagePath, bytes, signal);
        await scanTransactionResidues(operations, root);
        const currentExists = await assertCanonicalEntry(operations, root, LOCK_NAME, false);
        if (currentExists !== exactExists) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The initial erden.lock presence changed during staging',
            );
        }
        if (initialPrevious !== undefined) {
            if (!(await matchesFile(operations, lockPath, initialPrevious))) {
                throw new ProjectLockError(
                    'PROJECT_LOCK_ROLLBACK_UNSAFE',
                    'The initial erden.lock identity changed during staging',
                );
            }
            previous = initialPrevious;
        }
        await recheckRoot(operations, snapshot);
        await assertCanonicalEntry(operations, root, stageName, true);
        if (exactExists) {
            await assertCanonicalEntry(operations, root, LOCK_NAME, true);
        }
        signal.throwIfAborted();
        if (previous !== undefined) {
            previous = await movePreviousToBackup(operations, root, backupPath, previous);
            previousMoved = true;
        }
        await scanTransactionResidues(operations, root);
        await recheckRoot(operations, snapshot);
        if (previousMoved && previous !== undefined && !(await matchesFile(operations, backupPath, previous))) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The authenticated lock backup changed before publication',
            );
        }
        if (await assertCanonicalEntry(operations, root, LOCK_NAME, false)) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'An unrecognized erden.lock appeared before publication',
            );
        }
        if (!(await matchesFile(operations, stagePath, stage))) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The staged lock changed at the publication boundary',
            );
        }
        await scanTransactionResidues(operations, root);
        signal.throwIfAborted();
        const publication = await publishStage(operations, root, stagePath, stage);
        committed = true;
        published = publication.final;
        cleanupResidue = publication.cleanupResidue;
        await scanTransactionResidues(operations, root);
        await assertCanonicalEntry(operations, root, LOCK_NAME, true);
        await recheckRoot(operations, snapshot);
        if (!(await matchesFile(operations, lockPath, published))) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The final erden.lock changed during final root validation',
            );
        }
        if (previousMoved && previous !== undefined && !(await removeOwnedFile(operations, backupPath, previous))) {
            cleanupResidue = true;
        }
        await scanTransactionResidues(operations, root);
        await assertCanonicalEntry(operations, root, LOCK_NAME, true);
        await recheckRoot(operations, snapshot);
        if (!(await matchesFile(operations, lockPath, published))) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The final erden.lock changed during transaction cleanup',
            );
        }
        return Object.freeze({
            status: 'written',
            cleanup:
                cleanupResidue || recoveryCleanup === 'cleanup-residue-retained' ? 'cleanup-residue-retained' : 'clean',
            bytes: bytes.byteLength,
            sha256,
        });
    } catch (cause) {
        let unsafe = cause instanceof ProjectLockError && cause.code === 'PROJECT_LOCK_ROLLBACK_UNSAFE';
        if (committed && published !== undefined) {
            if (!(await removeOwnedFile(operations, lockPath, published))) {
                unsafe = true;
            } else {
                committed = false;
            }
        } else if (stage !== undefined && (await lstatOrNull(operations, stagePath)) !== null) {
            if (!(await removeOwnedFile(operations, stagePath, stage))) {
                unsafe = true;
            }
        }
        if (previousMoved && previous !== undefined) {
            const current = await lstatOrNull(operations, lockPath).catch(() => null);
            if (current !== null) {
                unsafe = true;
            } else {
                try {
                    await restoreBackup(operations, root, backupPath, previous);
                } catch {
                    unsafe = true;
                }
            }
        }
        if (unsafe) {
            throw new ProjectLockError(
                'PROJECT_LOCK_ROLLBACK_UNSAFE',
                'The lock transaction retained inert evidence because rollback could not be authenticated',
                cause,
            );
        }
        throw projectLockError(cause);
    }
}

export interface ProjectLockServiceShape {
    readonly inspect: (input: InspectProjectLockInput) => Effect.Effect<ProjectLockInspection, ProjectLockError>;
    readonly write: (input: WriteProjectLockInput) => Effect.Effect<ProjectLockWriteResult, ProjectLockError>;
}

export const ProjectLockService = Context.Service<ProjectLockServiceShape>('@erden/project/ProjectLockService');

function fromAbortableProjectLockPromise<A>(
    operation: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ProjectLockError> {
    return Effect.acquireUseRelease(
        Effect.sync(() => {
            const controller = new AbortController();
            const promise = operation(controller.signal);
            return Object.freeze({ controller, promise });
        }),
        ({ promise }) => Effect.tryPromise({ try: () => promise, catch: projectLockError }),
        ({ controller, promise }) =>
            Effect.promise(async () => {
                controller.abort();
                await promise.catch(() => undefined);
            }),
    );
}

export function makeProjectLockService(fileSystem: ProjectLockFileSystemPort): ProjectLockServiceShape {
    return Object.freeze({
        inspect: (input: InspectProjectLockInput) =>
            fromAbortableProjectLockPromise(async (signal) => await inspectPromise(input, fileSystem, signal)),
        write: (input: WriteProjectLockInput) =>
            fromAbortableProjectLockPromise(async (signal) => await writePromise(input, fileSystem, signal)),
    });
}

export const nodeProjectLockService = makeProjectLockService(makeNodeProjectLockFileSystemPort());

export function inspectProjectLock(
    input: InspectProjectLockInput,
): Effect.Effect<ProjectLockInspection, ProjectLockError, Context.Service.Identifier<typeof ProjectLockService>> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(ProjectLockService);
        return yield* service.inspect(input);
    });
}

export function writeProjectLock(
    input: WriteProjectLockInput,
): Effect.Effect<ProjectLockWriteResult, ProjectLockError, Context.Service.Identifier<typeof ProjectLockService>> {
    return Effect.gen(function* () {
        const service = yield* Effect.service(ProjectLockService);
        return yield* service.write(input);
    });
}

export function defineWriteProjectLockOperation(
    input: WriteProjectLockInput,
): ApplicationOperation<
    'WriteProjectLock',
    ProjectLockWriteResult,
    ProjectLockError,
    Context.Service.Identifier<typeof ProjectLockService>
> {
    return Object.freeze({ name: 'WriteProjectLock', effect: writeProjectLock(input) });
}
