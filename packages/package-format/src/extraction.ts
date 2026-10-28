import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, type BigIntStats, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import { Effect } from 'effect';

import {
    validatePackageArchiveStream,
    type PackageArchiveSink,
    type PackageArchiveSource,
    type PackageCodecLimits,
    type ValidatedPackageArchive,
} from './codec.js';
import { GENERATED_MANIFEST_PATH, portablePathCollisionKey } from './contract.js';
import { fromAbortablePackagePromise } from './effect.js';
import { PackageCodecError } from './errors.js';

export interface ExtractPackageOptions {
    readonly destination: string;
    readonly limits?: Partial<PackageCodecLimits>;
}

export interface PackageExtractionOperations {
    readonly lstat: typeof fs.lstat;
    readonly mkdir: typeof fs.mkdir;
    readonly open: typeof fs.open;
    readonly read: (
        handle: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
    ) => Promise<{ bytesRead: number }>;
    readonly write: (
        handle: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
    ) => Promise<{ bytesWritten: number }>;
    readonly stat: (handle: FileHandle) => Promise<BigIntStats>;
    readonly sync: (handle: FileHandle) => Promise<void>;
    readonly close: (handle: FileHandle) => Promise<void>;
    readonly readFile: typeof fs.readFile;
    readonly readdir: typeof fs.readdir;
    readonly realpath: typeof fs.realpath;
    readonly rename: typeof fs.rename;
    readonly rm: typeof fs.rm;
    readonly rmdir: typeof fs.rmdir;
    readonly chmod: typeof fs.chmod;
    readonly enforcePosixModes: boolean;
    readonly token: () => string;
}

const nodeExtractionOperations: PackageExtractionOperations = Object.freeze({
    lstat: fs.lstat,
    mkdir: fs.mkdir,
    open: fs.open,
    read: async (handle: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) =>
        await handle.read(buffer, offset, length, position),
    write: async (handle: FileHandle, buffer: Uint8Array, offset: number, length: number) =>
        await handle.write(buffer, offset, length, null),
    stat: async (handle: FileHandle) => await handle.stat({ bigint: true }),
    sync: async (handle: FileHandle) => {
        await handle.sync();
    },
    close: async (handle: FileHandle) => {
        await handle.close();
    },
    readFile: fs.readFile,
    readdir: fs.readdir,
    realpath: fs.realpath,
    rename: fs.rename,
    rm: fs.rm,
    rmdir: fs.rmdir,
    chmod: fs.chmod,
    enforcePosixModes: process.platform !== 'win32',
    token: randomUUID,
});

interface FileIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly type: 'directory' | 'file';
}

interface OwnedFile {
    readonly logicalPath: string;
    path: string;
    readonly identity: FileIdentity;
    readonly byteSize: number;
    readonly sha256: string;
    readonly mode: number;
}

interface OwnedDirectory {
    readonly logicalPath: string;
    readonly path: string;
    readonly identity: FileIdentity;
    mode: number;
    phase: 'created' | 'mode-finalized';
}

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9-]{15,127}$/u;
const BUFFER_SIZE = 64 * 1024;

function isMissing(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (
            error as {
                readonly code?: unknown;
            }
        ).code === 'ENOENT'
    );
}

function childOf(parent: string, child: string): boolean {
    const fragment = relative(parent, child);
    return fragment.length > 0 && !isAbsolute(fragment) && fragment !== '..' && !fragment.startsWith(`..${sep}`);
}

function portableName(name: string): string {
    return portablePathCollisionKey(name.normalize('NFC'));
}

function extractionError(error: unknown, message: string): PackageCodecError {
    return error instanceof PackageCodecError ? error : new PackageCodecError('extraction-io', message, error);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new PackageCodecError('extraction-io', 'Package extraction was interrupted before publication');
    }
}

async function classifyRejectedCreation(
    operations: PackageExtractionOperations,
    path: string,
    operationError: unknown,
): Promise<never> {
    try {
        await operations.lstat(path, { bigint: true });
    } catch (probeError) {
        if (isMissing(probeError)) {
            throw operationError;
        }
        throw new PackageCodecError(
            'extraction-rollback-unsafe',
            'An extraction path could not be proven absent after a failed exclusive creation',
            operationError,
        );
    }
    throw new PackageCodecError(
        'extraction-rollback-unsafe',
        'An extraction path appeared without a captured invocation ownership identity',
        operationError,
    );
}

async function createExclusiveDirectory(
    operations: PackageExtractionOperations,
    path: string,
    mode: 0o700 | 0o755,
): Promise<void> {
    try {
        await operations.mkdir(path, { recursive: false, mode });
    } catch (error) {
        await classifyRejectedCreation(operations, path, error);
    }
}

function identityFromStats(stats: BigIntStats, type: FileIdentity['type']): FileIdentity {
    const correctType = type === 'file' ? stats.isFile() : stats.isDirectory();
    if (!correctType || stats.isSymbolicLink() || stats.dev <= 0n || stats.ino <= 0n) {
        throw new PackageCodecError(
            'destination-unsafe',
            'The filesystem cannot provide safe extraction ownership identity',
        );
    }
    return Object.freeze({ dev: stats.dev, ino: stats.ino, type });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.type === right.type;
}

function permissionBits(stats: BigIntStats): number {
    return Number(stats.mode & 4095n);
}

async function pathHasModeIdentity(
    operations: PackageExtractionOperations,
    path: string,
    expected: FileIdentity,
    mode: number,
): Promise<boolean> {
    try {
        const stats = await operations.lstat(path, { bigint: true });
        return (
            sameIdentity(identityFromStats(stats, expected.type), expected) &&
            (!operations.enforcePosixModes || permissionBits(stats) === mode)
        );
    } catch {
        return false;
    }
}

async function captureIdentity(
    operations: PackageExtractionOperations,
    path: string,
    type: FileIdentity['type'],
): Promise<FileIdentity> {
    return identityFromStats(await operations.lstat(path, { bigint: true }), type);
}

async function captureCreatedDirectory(
    operations: PackageExtractionOperations,
    path: string,
    logicalPath: string,
): Promise<OwnedDirectory> {
    try {
        const stats = await operations.lstat(path, { bigint: true });
        return {
            logicalPath,
            path,
            identity: identityFromStats(stats, 'directory'),
            mode: permissionBits(stats),
            phase: 'created',
        };
    } catch (error) {
        throw new PackageCodecError(
            'extraction-rollback-unsafe',
            'A created extraction directory could not be bound to this invocation',
            error,
        );
    }
}

async function finalizeOwnedDirectoryMode(
    operations: PackageExtractionOperations,
    directory: OwnedDirectory,
    mode: 0o700 | 0o755,
): Promise<void> {
    let chmodError: unknown;
    try {
        await operations.chmod(directory.path, mode);
    } catch (error) {
        chmodError = error;
    }
    let stats: BigIntStats;
    try {
        stats = await operations.lstat(directory.path, { bigint: true });
        if (!sameIdentity(identityFromStats(stats, 'directory'), directory.identity)) {
            throw new Error('identity changed');
        }
    } catch (error) {
        throw new PackageCodecError(
            'extraction-rollback-unsafe',
            'A created extraction directory changed before its mode was finalized',
            error,
        );
    }
    directory.mode = permissionBits(stats);
    if (chmodError !== undefined) {
        throw new PackageCodecError(
            'extraction-io',
            'A created extraction directory mode could not be finalized',
            chmodError,
        );
    }
    if (operations.enforcePosixModes && directory.mode !== mode) {
        throw new PackageCodecError('extraction-io', 'A created extraction directory did not retain its exact mode');
    }
    directory.mode = mode;
    directory.phase = 'mode-finalized';
}

async function pathHasFinalizedDirectory(
    operations: PackageExtractionOperations,
    directory: OwnedDirectory,
): Promise<boolean> {
    return (
        directory.phase === 'mode-finalized' &&
        (await pathHasModeIdentity(operations, directory.path, directory.identity, directory.mode))
    );
}

async function pathHasIdentity(
    operations: PackageExtractionOperations,
    path: string,
    expected: FileIdentity,
): Promise<boolean> {
    try {
        return sameIdentity(await captureIdentity(operations, path, expected.type), expected);
    } catch {
        return false;
    }
}

async function hashOpenFile(
    operations: PackageExtractionOperations,
    handle: FileHandle,
): Promise<
    Readonly<{
        byteSize: number;
        sha256: string;
    }>
> {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let position = 0;
    let reading = true;
    while (reading) {
        const { bytesRead } = await operations.read(handle, buffer, 0, buffer.length, position);
        reading = bytesRead !== 0;
        if (reading) {
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
    }
    return Object.freeze({ byteSize: position, sha256: hash.digest('hex') });
}

async function matchesOwnedFile(operations: PackageExtractionOperations, file: OwnedFile): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
        if (!(await pathHasModeIdentity(operations, file.path, file.identity, file.mode))) {
            return false;
        }
        handle = await operations.open(file.path, 'r');
        const beforeStats = await operations.stat(handle);
        const before = identityFromStats(beforeStats, 'file');
        if (!sameIdentity(before, file.identity)) {
            return false;
        }
        if (operations.enforcePosixModes && permissionBits(beforeStats) !== file.mode) {
            return false;
        }
        const content = await hashOpenFile(operations, handle);
        const afterStats = await operations.stat(handle);
        const after = identityFromStats(afterStats, 'file');
        return (
            sameIdentity(after, file.identity) &&
            (!operations.enforcePosixModes || permissionBits(afterStats) === file.mode) &&
            content.byteSize === file.byteSize &&
            content.sha256 === file.sha256 &&
            (await pathHasModeIdentity(operations, file.path, file.identity, file.mode))
        );
    } catch {
        return false;
    } finally {
        if (handle !== undefined) {
            await operations.close(handle).catch(() => undefined);
        }
    }
}

async function writeAll(operations: PackageExtractionOperations, handle: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesWritten } = await operations.write(handle, bytes, offset, bytes.length - offset);
        if (bytesWritten <= 0) {
            throw new PackageCodecError('extraction-io', 'The package extraction file write made no progress');
        }
        offset += bytesWritten;
    }
}

async function verifySafeParent(
    operations: PackageExtractionOperations,
    destination: string,
): Promise<
    Readonly<{
        parent: string;
        target: string;
        parentIdentity: FileIdentity;
        parentMode: number;
    }>
> {
    const requested = resolve(destination);
    const requestedParent = dirname(requested);
    const root = parse(requestedParent).root;
    if (root.length === 0) {
        throw new PackageCodecError('destination-unsafe', 'The extraction parent has no filesystem root');
    }
    let ancestor = root;
    for (const segment of relative(root, requestedParent).split(sep).filter(Boolean)) {
        ancestor = resolve(ancestor, segment);
        let stats: Stats;
        try {
            stats = await operations.lstat(ancestor);
        } catch (error) {
            throw new PackageCodecError('destination-unsafe', 'The extraction parent is unavailable', error);
        }
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new PackageCodecError(
                'destination-unsafe',
                'The extraction parent may not traverse a symbolic or reparse path',
            );
        }
    }
    let realParent: string;
    try {
        realParent = await operations.realpath(requestedParent);
    } catch (error) {
        throw new PackageCodecError('destination-unsafe', 'The extraction parent is unavailable', error);
    }
    // No ancestor is a link here, so a different real path comes from an alias the walk cannot see,
    // such as a Windows 8.3 short name (C:\Users\RUNNER~1\...) or a substituted drive.
    if (portableName(resolve(realParent)) !== portableName(resolve(requestedParent))) {
        throw new PackageCodecError(
            'destination-unsafe',
            'The extraction parent is not its own real path (for example a Windows 8.3 short name or a substituted drive); use the path it resolves to',
        );
    }
    const target = resolve(realParent, basename(requested));
    if (!childOf(realParent, target) || dirname(target) !== realParent) {
        throw new PackageCodecError('destination-unsafe', 'The extraction destination is not safely contained');
    }
    const parentStats = await operations.lstat(realParent, { bigint: true });
    const parentIdentity = identityFromStats(parentStats, 'directory');
    return Object.freeze({ parent: realParent, target, parentIdentity, parentMode: permissionBits(parentStats) });
}

async function assertDestinationAbsent(
    operations: PackageExtractionOperations,
    parent: string,
    target: string,
): Promise<void> {
    const targetIdentity = portableName(basename(target));
    let entries: string[];
    try {
        entries = await operations.readdir(parent);
    } catch (error) {
        throw new PackageCodecError('destination-unsafe', 'The extraction parent cannot be inspected', error);
    }
    if (entries.some((entry) => portableName(entry) === targetIdentity)) {
        throw new PackageCodecError(
            'destination-conflict',
            'The extraction destination already exists or has a portable name collision',
        );
    }
}

async function assertPortableSiblingState(
    operations: PackageExtractionOperations,
    parent: string,
    state: ReadonlyArray<
        Readonly<{
            name: string;
            present: boolean;
        }>
    >,
): Promise<void> {
    let entries: string[];
    try {
        entries = await operations.readdir(parent);
    } catch (error) {
        throw new PackageCodecError('destination-unsafe', 'The extraction parent cannot be inspected', error);
    }
    for (const expected of state) {
        const matches = entries.filter((entry) => portableName(entry) === portableName(expected.name));
        if (expected.present ? matches.length !== 1 || matches[0] !== expected.name : matches.length !== 0) {
            throw new PackageCodecError(
                'destination-conflict',
                'A package extraction transaction name already exists or has a portable collision',
            );
        }
    }
}

async function exactDirectoryEntries(
    operations: PackageExtractionOperations,
    directory: string,
    expected: ReadonlySet<string>,
): Promise<boolean> {
    try {
        const entries = await operations.readdir(directory);
        return entries.length === expected.size && entries.every((entry) => expected.has(entry));
    } catch {
        return false;
    }
}

function expectedChildren(
    directories: ReadonlyArray<OwnedDirectory>,
    files: ReadonlyArray<OwnedFile>,
    includeManifest: boolean,
): ReadonlyMap<string, ReadonlySet<string>> {
    const children = new Map<string, Set<string>>([['.', new Set()]]);
    for (const directory of directories) {
        if (directory.logicalPath === '.') {
            continue;
        }
        const parts = directory.logicalPath.split('/');
        const parent = parts.length === 1 ? '.' : parts.slice(0, -1).join('/');
        const child = parts.at(-1);
        if (child !== undefined) {
            (children.get(parent) ?? new Set()).add(child);
        }
        if (!children.has(parent)) {
            children.set(parent, new Set([child ?? '']));
        }
        if (!children.has(directory.logicalPath)) {
            children.set(directory.logicalPath, new Set());
        }
    }
    for (const file of files) {
        if (!includeManifest && file.logicalPath === GENERATED_MANIFEST_PATH) {
            continue;
        }
        const parts = file.logicalPath.split('/');
        const parent = parts.length === 1 ? '.' : parts.slice(0, -1).join('/');
        const child = parts.at(-1);
        if (child !== undefined) {
            const set = children.get(parent) ?? new Set<string>();
            set.add(child);
            children.set(parent, set);
        }
    }
    return new Map([...children].map(([path, names]) => [path, new Set([...names].filter(Boolean))]));
}

async function exactOwnedTreeClosure(
    operations: PackageExtractionOperations,
    directories: ReadonlyArray<OwnedDirectory>,
    files: ReadonlyArray<OwnedFile>,
): Promise<boolean> {
    const tree = expectedChildren(directories, files, false);
    const directoryByPath = new Map(directories.map((directory) => [directory.logicalPath, directory]));
    const fileByPath = new Map(files.map((file) => [file.logicalPath, file]));
    for (const directory of directories) {
        const names = tree.get(directory.logicalPath) ?? new Set<string>();
        if (
            !(await pathHasFinalizedDirectory(operations, directory)) ||
            !(await exactDirectoryEntries(operations, directory.path, names))
        ) {
            return false;
        }
        for (const name of names) {
            const logicalPath = directory.logicalPath === '.' ? name : `${directory.logicalPath}/${name}`;
            const childDirectory = directoryByPath.get(logicalPath);
            const childFile = fileByPath.get(logicalPath);
            if (childDirectory !== undefined) {
                if (!(await pathHasFinalizedDirectory(operations, childDirectory))) {
                    return false;
                }
            } else if (childFile !== undefined) {
                if (!(await pathHasModeIdentity(operations, childFile.path, childFile.identity, childFile.mode))) {
                    return false;
                }
            } else {
                return false;
            }
        }
    }
    return true;
}

class StagingSink implements PackageArchiveSink {
    readonly directories: OwnedDirectory[] = [];
    readonly files: OwnedFile[] = [];
    cleanupUnsafe = false;
    readonly #operations: PackageExtractionOperations;
    readonly #staging: string;
    readonly #manifestTemp: string;
    readonly #stagingRoot: OwnedDirectory;
    readonly #parent: string;
    readonly #parentIdentity: FileIdentity;
    readonly #parentMode: number;
    readonly #targetName: string;
    #handle: FileHandle | undefined;
    #activePath: string | undefined;
    #activePhysical: string | undefined;
    #activeIdentity: FileIdentity | undefined;
    #activeMode: 0o644 | 0o755 | undefined;

    async #assertDirectoryOwned(path: string): Promise<void> {
        const owner =
            path === '.' ? this.#stagingRoot : this.directories.find((directory) => directory.logicalPath === path);
        if (owner === undefined || !(await pathHasFinalizedDirectory(this.#operations, owner))) {
            throw new PackageCodecError(
                'extraction-rollback-unsafe',
                'Extraction staging ancestry changed during the transaction',
            );
        }
    }

    async #ensureDirectory(path: string): Promise<void> {
        if (path === '.' || this.directories.some((directory) => directory.logicalPath === path)) {
            return;
        }
        const physical = resolve(this.#staging, ...path.split('/'));
        const segments = path.split('/');
        await this.#assertDirectoryOwned(segments.length === 1 ? '.' : segments.slice(0, -1).join('/'));
        await createExclusiveDirectory(this.#operations, physical, 0o700);
        const directory = await captureCreatedDirectory(this.#operations, physical, path);
        this.directories.push(directory);
        await finalizeOwnedDirectoryMode(this.#operations, directory, 0o700);
    }

    constructor(
        operations: PackageExtractionOperations,
        staging: string,
        stagingRoot: OwnedDirectory,
        manifestTemp: string,
        parent: string,
        parentIdentity: FileIdentity,
        parentMode: number,
        targetName: string,
    ) {
        this.#operations = operations;
        this.#staging = staging;
        this.#stagingRoot = stagingRoot;
        this.#manifestTemp = manifestTemp;
        this.#parent = parent;
        this.#parentIdentity = parentIdentity;
        this.#parentMode = parentMode;
        this.#targetName = targetName;
    }

    readonly directory = async (path: string): Promise<void> => {
        try {
            if (path === '.') {
                return;
            }
            const physical = resolve(this.#staging, ...path.split('/'));
            if (!childOf(this.#staging, physical)) {
                throw new PackageCodecError('destination-unsafe', 'Archive directory escaped extraction staging');
            }
            await this.#ensureDirectory(path);
        } catch (error) {
            throw extractionError(error, 'Package extraction could not create a staged directory');
        }
    };

    readonly startFile = async (path: string, mode: 0o644 | 0o755): Promise<void> => {
        try {
            if (this.#handle !== undefined) {
                throw new PackageCodecError('extraction-io', 'Package extraction file state is invalid');
            }
            const physical =
                path === GENERATED_MANIFEST_PATH ? this.#manifestTemp : resolve(this.#staging, ...path.split('/'));
            if (path !== GENERATED_MANIFEST_PATH && !childOf(this.#staging, physical)) {
                throw new PackageCodecError('destination-unsafe', 'Archive file escaped extraction staging');
            }
            if (path !== GENERATED_MANIFEST_PATH) {
                const segments = path.split('/');
                for (let length = 1; length < segments.length; length += 1) {
                    await this.#ensureDirectory(segments.slice(0, length).join('/'));
                }
                await this.#assertDirectoryOwned(segments.length === 1 ? '.' : segments.slice(0, -1).join('/'));
            } else if (
                !(await pathHasModeIdentity(this.#operations, this.#parent, this.#parentIdentity, this.#parentMode))
            ) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'Extraction parent changed during the transaction',
                );
            }
            if (path === GENERATED_MANIFEST_PATH) {
                await assertPortableSiblingState(this.#operations, this.#parent, [
                    { name: this.#targetName, present: false },
                    { name: basename(this.#staging), present: true },
                    { name: basename(this.#manifestTemp), present: false },
                ]);
            }
            const opened = await this.#operations
                .open(physical, 'wx', 0o600)
                .catch(async (error: unknown) => await classifyRejectedCreation(this.#operations, physical, error));
            this.#handle = opened;
            this.#activeIdentity = identityFromStats(await this.#operations.stat(opened), 'file');
            this.#activePath = path;
            this.#activePhysical = physical;
            this.#activeMode = mode;
            if (path === GENERATED_MANIFEST_PATH) {
                await assertPortableSiblingState(this.#operations, this.#parent, [
                    { name: this.#targetName, present: false },
                    { name: basename(this.#staging), present: true },
                    { name: basename(this.#manifestTemp), present: true },
                ]);
            }
        } catch (error) {
            throw extractionError(error, 'Package extraction could not open a staged file');
        }
    };

    readonly writeFile = async (path: string, bytes: Uint8Array): Promise<void> => {
        try {
            if (this.#handle === undefined || this.#activePath !== path) {
                throw new PackageCodecError('extraction-io', 'Package extraction file state is invalid');
            }
            await writeAll(this.#operations, this.#handle, bytes);
        } catch (error) {
            throw extractionError(error, 'Package extraction could not write a staged file');
        }
    };

    readonly endFile = async (path: string, byteSize: number, sha256: string): Promise<void> => {
        const handle = this.#handle;
        const physical = this.#activePhysical;
        if (handle === undefined || physical === undefined || this.#activePath !== path) {
            throw new PackageCodecError('extraction-io', 'Package extraction file state is invalid');
        }
        try {
            await this.#operations.sync(handle);
            const identity = identityFromStats(await this.#operations.stat(handle), 'file');
            await this.#operations.close(handle);
            this.#handle = undefined;
            await this.#operations.chmod(physical, this.#activeMode ?? 0o600);
            const mode = this.#activeMode ?? 0o600;
            const file: OwnedFile = { logicalPath: path, path: physical, identity, byteSize, sha256, mode };
            if (!(await matchesOwnedFile(this.#operations, file))) {
                throw new PackageCodecError('extraction-io', 'A staged package file changed while it was written');
            }
            this.files.push(file);
            this.#activePath = undefined;
            this.#activePhysical = undefined;
            this.#activeIdentity = undefined;
            this.#activeMode = undefined;
        } catch (error) {
            await this.#operations.close(handle).catch(() => undefined);
            this.#handle = undefined;
            throw extractionError(error, 'Package extraction could not finalize a staged file');
        }
    };

    async close(): Promise<void> {
        const handle = this.#handle;
        const path = this.#activePath;
        const physical = this.#activePhysical;
        const identity = this.#activeIdentity;
        if (handle !== undefined) {
            await this.#operations.close(handle).catch(() => undefined);
        }
        this.#handle = undefined;
        if (path !== undefined && physical !== undefined && identity !== undefined) {
            let reader: FileHandle | undefined;
            try {
                if (!(await pathHasIdentity(this.#operations, physical, identity))) {
                    throw new Error('identity changed');
                }
                reader = await this.#operations.open(physical, 'r');
                if (!sameIdentity(identityFromStats(await this.#operations.stat(reader), 'file'), identity)) {
                    throw new Error('identity changed');
                }
                const content = await hashOpenFile(this.#operations, reader);
                const stats = await this.#operations.stat(reader);
                if (
                    !sameIdentity(identityFromStats(await this.#operations.stat(reader), 'file'), identity) ||
                    !(await pathHasIdentity(this.#operations, physical, identity))
                ) {
                    throw new Error('identity changed');
                }
                this.files.push({
                    logicalPath: path,
                    path: physical,
                    identity,
                    mode: permissionBits(stats),
                    ...content,
                });
            } catch {
                this.cleanupUnsafe = true;
            } finally {
                if (reader !== undefined) {
                    await this.#operations.close(reader).catch(() => undefined);
                }
            }
        } else if (handle !== undefined || path !== undefined || physical !== undefined || identity !== undefined) {
            this.cleanupUnsafe = true;
        }
        this.#activePath = undefined;
        this.#activePhysical = undefined;
        this.#activeIdentity = undefined;
        this.#activeMode = undefined;
    }
}

async function removeOwnedFile(operations: PackageExtractionOperations, file: OwnedFile): Promise<boolean> {
    if (
        !(await matchesOwnedFile(operations, file)) ||
        !(await pathHasModeIdentity(operations, file.path, file.identity, file.mode))
    ) {
        return false;
    }
    try {
        await operations.rm(file.path, { force: false, recursive: false });
        return true;
    } catch {
        return false;
    }
}

async function removeOwnedDirectory(
    operations: PackageExtractionOperations,
    directory: OwnedDirectory,
): Promise<boolean> {
    const stillOwned =
        directory.phase === 'mode-finalized'
            ? await pathHasFinalizedDirectory(operations, directory)
            : await pathHasIdentity(operations, directory.path, directory.identity);
    if (!stillOwned) {
        return false;
    }
    if (!(await exactDirectoryEntries(operations, directory.path, new Set()))) {
        return false;
    }
    try {
        await operations.rmdir(directory.path);
        return true;
    } catch {
        return false;
    }
}

async function removeTreeOwned(
    operations: PackageExtractionOperations,
    files: ReadonlyArray<OwnedFile>,
    directories: ReadonlyArray<OwnedDirectory>,
): Promise<boolean> {
    let safe = true;
    for (const file of [...files].reverse()) {
        if (!(await removeOwnedFile(operations, file))) {
            safe = false;
        }
    }
    for (const directory of [...directories].sort(
        (a, b) => b.logicalPath.split('/').length - a.logicalPath.split('/').length,
    )) {
        if (!(await removeOwnedDirectory(operations, directory))) {
            safe = false;
        }
    }
    return safe;
}

async function extractPackageArchiveWithOperations(
    source: PackageArchiveSource,
    options: ExtractPackageOptions,
    operations: PackageExtractionOperations,
    signal?: AbortSignal,
): Promise<ValidatedPackageArchive> {
    const location = await verifySafeParent(operations, options.destination);
    await assertDestinationAbsent(operations, location.parent, location.target);
    const token = operations.token();
    if (!SAFE_TOKEN.test(token)) {
        throw new PackageCodecError(
            'destination-unsafe',
            'The filesystem did not provide a safe extraction transaction token',
        );
    }
    const staging = resolve(location.parent, `.${basename(location.target)}.erden-extract-${token}`);
    const manifestTemp = resolve(location.parent, `.${basename(location.target)}.erden-manifest-${token}`);
    if (
        !childOf(location.parent, staging) ||
        !childOf(location.parent, manifestTemp) ||
        staging === location.target ||
        manifestTemp === location.target
    ) {
        throw new PackageCodecError('destination-unsafe', 'The extraction transaction area is not safely contained');
    }
    const siblingNames = Object.freeze({
        target: basename(location.target),
        staging: basename(staging),
        manifest: basename(manifestTemp),
    });
    await assertPortableSiblingState(operations, location.parent, [
        { name: siblingNames.target, present: false },
        { name: siblingNames.staging, present: false },
        { name: siblingNames.manifest, present: false },
    ]);
    let stagingRoot: OwnedDirectory | undefined;
    let targetRoot: OwnedDirectory | undefined;
    const targetDirectories: OwnedDirectory[] = [];
    const movedFiles: OwnedFile[] = [];
    let sink: StagingSink | undefined;
    let validated: ValidatedPackageArchive | undefined;
    let rollbackUnsafe = false;
    try {
        if (!(await pathHasModeIdentity(operations, location.parent, location.parentIdentity, location.parentMode))) {
            throw new PackageCodecError('destination-unsafe', 'The extraction parent changed before staging');
        }
        await assertPortableSiblingState(operations, location.parent, [
            { name: siblingNames.target, present: false },
            { name: siblingNames.staging, present: false },
            { name: siblingNames.manifest, present: false },
        ]);
        await createExclusiveDirectory(operations, staging, 0o700);
        stagingRoot = await captureCreatedDirectory(operations, staging, '.');
        await finalizeOwnedDirectoryMode(operations, stagingRoot, 0o700);
        await assertPortableSiblingState(operations, location.parent, [
            { name: siblingNames.target, present: false },
            { name: siblingNames.staging, present: true },
            { name: siblingNames.manifest, present: false },
        ]);
        sink = new StagingSink(
            operations,
            staging,
            stagingRoot,
            manifestTemp,
            location.parent,
            location.parentIdentity,
            location.parentMode,
            siblingNames.target,
        );
        validated = await validatePackageArchiveStream(source, options.limits, sink, signal);
        await sink.close();
        assertNotAborted(signal);
        const manifestFile = sink.files.find(({ logicalPath }) => logicalPath === GENERATED_MANIFEST_PATH);
        const supportFiles = sink.files.filter(({ logicalPath }) => logicalPath !== GENERATED_MANIFEST_PATH);
        if (manifestFile === undefined || supportFiles.length !== validated.files.length) {
            throw new PackageCodecError(
                'manifest-integrity',
                'Extraction staging does not match the validated manifest',
            );
        }
        for (const file of sink.files) {
            if (!(await matchesOwnedFile(operations, file))) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'A staged package file changed before publication',
                );
            }
        }
        await assertDestinationAbsent(operations, location.parent, location.target);
        await assertPortableSiblingState(operations, location.parent, [
            { name: siblingNames.target, present: false },
            { name: siblingNames.staging, present: true },
            { name: siblingNames.manifest, present: true },
        ]);
        if (!(await pathHasModeIdentity(operations, location.parent, location.parentIdentity, location.parentMode))) {
            throw new PackageCodecError('destination-unsafe', 'The extraction parent changed before publication');
        }
        assertNotAborted(signal);
        await createExclusiveDirectory(operations, location.target, 0o755);
        assertNotAborted(signal);
        targetRoot = await captureCreatedDirectory(operations, location.target, '.');
        await finalizeOwnedDirectoryMode(operations, targetRoot, 0o755);
        assertNotAborted(signal);
        await assertPortableSiblingState(operations, location.parent, [
            { name: siblingNames.target, present: true },
            { name: siblingNames.staging, present: true },
            { name: siblingNames.manifest, present: true },
        ]);
        for (const directory of sink.directories) {
            const output = resolve(location.target, ...directory.logicalPath.split('/'));
            const parts = directory.logicalPath.split('/');
            const parentLogical = parts.length === 1 ? '.' : parts.slice(0, -1).join('/');
            const parentDirectory =
                parentLogical === '.'
                    ? targetRoot
                    : targetDirectories.find((candidate) => candidate.logicalPath === parentLogical);
            if (parentDirectory === undefined || !(await pathHasFinalizedDirectory(operations, parentDirectory))) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'The reserved extraction ancestry changed before directory creation',
                );
            }
            assertNotAborted(signal);
            await createExclusiveDirectory(operations, output, 0o755);
            const targetDirectory = await captureCreatedDirectory(operations, output, directory.logicalPath);
            targetDirectories.push(targetDirectory);
            await finalizeOwnedDirectoryMode(operations, targetDirectory, 0o755);
            assertNotAborted(signal);
        }
        for (const file of supportFiles) {
            const output = resolve(location.target, ...file.logicalPath.split('/'));
            const parts = file.logicalPath.split('/');
            const parentLogical = parts.length === 1 ? '.' : parts.slice(0, -1).join('/');
            const parentDirectory =
                parentLogical === '.'
                    ? targetRoot
                    : targetDirectories.find((candidate) => candidate.logicalPath === parentLogical);
            if (parentDirectory === undefined || !(await pathHasFinalizedDirectory(operations, parentDirectory))) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'The reserved extraction ancestry changed before file installation',
                );
            }
            assertNotAborted(signal);
            await operations.rename(file.path, output);
            file.path = output;
            movedFiles.push(file);
            assertNotAborted(signal);
        }
        for (const file of movedFiles) {
            if (!(await matchesOwnedFile(operations, file))) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'An installed package file changed before publication',
                );
            }
        }
        const stagingDirectories = [...sink.directories].sort(
            (a, b) => b.logicalPath.split('/').length - a.logicalPath.split('/').length,
        );
        for (const directory of stagingDirectories) {
            if (!(await removeOwnedDirectory(operations, directory))) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'Extraction could not retire its owned staging directories',
                );
            }
        }
        assertNotAborted(signal);
        sink.directories.length = 0;
        if (!(await removeOwnedDirectory(operations, stagingRoot))) {
            throw new PackageCodecError(
                'extraction-rollback-unsafe',
                'Extraction could not retire its owned staging root',
            );
        }
        stagingRoot = undefined;
        assertNotAborted(signal);
        await assertPortableSiblingState(operations, location.parent, [
            { name: siblingNames.target, present: true },
            { name: siblingNames.staging, present: false },
            { name: siblingNames.manifest, present: true },
        ]);
        const parentAliases = (await operations.readdir(location.parent)).filter(
            (entry) => portableName(entry) === portableName(basename(location.target)),
        );
        if (
            parentAliases.length !== 1 ||
            parentAliases[0] !== basename(location.target) ||
            !(await pathHasFinalizedDirectory(operations, targetRoot))
        ) {
            throw new PackageCodecError(
                'extraction-rollback-unsafe',
                'The reserved extraction destination changed before publication',
            );
        }
        const allTargetDirectories = [targetRoot, ...targetDirectories];
        const tree = expectedChildren(allTargetDirectories, [...movedFiles, manifestFile], false);
        for (const directory of allTargetDirectories) {
            const expected = tree.get(directory.logicalPath) ?? new Set<string>();
            if (
                !(await pathHasFinalizedDirectory(operations, directory)) ||
                !(await exactDirectoryEntries(operations, directory.path, expected))
            ) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'The reserved extraction destination changed before publication',
                );
            }
        }
        for (const file of movedFiles) {
            if (!(await matchesOwnedFile(operations, file))) {
                throw new PackageCodecError(
                    'extraction-rollback-unsafe',
                    'An installed package file changed before publication',
                );
            }
        }
        if (!(await matchesOwnedFile(operations, manifestFile))) {
            throw new PackageCodecError(
                'extraction-rollback-unsafe',
                'The generated manifest changed before publication',
            );
        }
        const manifestOutput = resolve(location.target, ...GENERATED_MANIFEST_PATH.split('/'));
        const manifestDirectory = targetDirectories.find(
            ({ logicalPath }) => logicalPath === dirname(GENERATED_MANIFEST_PATH).replaceAll('\\', '/'),
        );
        if (
            manifestDirectory === undefined ||
            !(await pathHasFinalizedDirectory(operations, manifestDirectory)) ||
            !(await pathHasModeIdentity(operations, location.parent, location.parentIdentity, location.parentMode))
        ) {
            throw new PackageCodecError(
                'extraction-rollback-unsafe',
                'The publication ancestry changed before manifest installation',
            );
        }
        await assertPortableSiblingState(operations, location.parent, [
            { name: siblingNames.target, present: true },
            { name: siblingNames.staging, present: false },
            { name: siblingNames.manifest, present: true },
        ]);
        if (
            !(await exactOwnedTreeClosure(operations, allTargetDirectories, movedFiles)) ||
            !(await pathHasModeIdentity(operations, location.parent, location.parentIdentity, location.parentMode))
        ) {
            throw new PackageCodecError(
                'extraction-rollback-unsafe',
                'The installed package tree changed at the publication boundary',
            );
        }
        await assertPortableSiblingState(operations, location.parent, [
            { name: siblingNames.target, present: true },
            { name: siblingNames.staging, present: false },
            { name: siblingNames.manifest, present: true },
        ]);
        assertNotAborted(signal);
        await operations.rename(manifestFile.path, manifestOutput);
        manifestFile.path = manifestOutput;
        return validated;
    } catch (error) {
        await sink?.close();
        rollbackUnsafe = sink?.cleanupUnsafe === true || rollbackUnsafe;
        const manifestFile = sink?.files.find(({ logicalPath }) => logicalPath === GENERATED_MANIFEST_PATH);
        if (validated !== undefined && manifestFile !== undefined && targetRoot !== undefined) {
            const manifestOutput = resolve(location.target, ...GENERATED_MANIFEST_PATH.split('/'));
            const published = { ...manifestFile, path: manifestOutput };
            const allFiles = [...movedFiles, published];
            const allDirectories = [targetRoot, ...targetDirectories];
            const tree = expectedChildren(allDirectories, allFiles, true);
            let complete = await matchesOwnedFile(operations, published);
            for (const file of movedFiles) {
                complete = complete && (await matchesOwnedFile(operations, file));
            }
            for (const directory of allDirectories) {
                complete =
                    complete &&
                    (await pathHasFinalizedDirectory(operations, directory)) &&
                    (await exactDirectoryEntries(
                        operations,
                        directory.path,
                        tree.get(directory.logicalPath) ?? new Set(),
                    ));
            }
            if (complete) {
                return validated;
            }
        }
        if (targetRoot !== undefined) {
            const targetFiles = [...movedFiles];
            if (manifestFile !== undefined) {
                const publishedPath = resolve(location.target, ...GENERATED_MANIFEST_PATH.split('/'));
                if (await pathHasIdentity(operations, publishedPath, manifestFile.identity)) {
                    targetFiles.push({ ...manifestFile, path: publishedPath });
                }
            }
            rollbackUnsafe =
                !(await removeTreeOwned(operations, targetFiles, [...targetDirectories, targetRoot])) || rollbackUnsafe;
        }
        if (sink !== undefined) {
            const stagedFiles = sink.files.filter((file) => !movedFiles.includes(file) && awaitablePath(file.path));
            rollbackUnsafe = !(await removeTreeOwned(operations, stagedFiles, sink.directories)) || rollbackUnsafe;
        }
        if (stagingRoot !== undefined) {
            rollbackUnsafe = !(await removeOwnedDirectory(operations, stagingRoot)) || rollbackUnsafe;
        }
        if (rollbackUnsafe) {
            throw new PackageCodecError(
                'extraction-rollback-unsafe',
                'Package extraction stopped because invocation-owned cleanup could not be proven safe',
                error,
            );
        }
        if (error instanceof PackageCodecError) {
            throw error;
        }
        throw new PackageCodecError('extraction-io', 'Package extraction could not complete', error);
    }
}

// Retains array filtering as a synchronous operation while path existence is checked by identity-bound removal.
function awaitablePath(path: string): boolean {
    return path.length > 0;
}

export function extractPackageArchive(
    source: PackageArchiveSource,
    options: ExtractPackageOptions,
    operations: PackageExtractionOperations = nodeExtractionOperations,
): Effect.Effect<ValidatedPackageArchive, PackageCodecError> {
    return fromAbortablePackagePromise(
        (signal) => extractPackageArchiveWithOperations(source, options, operations, signal),
        (error) =>
            error instanceof PackageCodecError
                ? error
                : new PackageCodecError('extraction-io', 'Package extraction could not complete', error),
    );
}

export function makeNodePackageExtractionOperations(
    overrides: Partial<PackageExtractionOperations> = {},
): PackageExtractionOperations {
    return Object.freeze({ ...nodeExtractionOperations, ...overrides });
}
