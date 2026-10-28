import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

import { makeNodePackageExtractionOperations, type PackageExtractionOperations } from '@erden/package-format';

import { LocalPackageStoreError } from './errors.js';
import type { ImportStrategy } from './model.js';

export interface StoreEnvironment {
    readonly platform: string;
    readonly localAppData?: string;
    readonly xdgDataHome?: string;
    readonly userHome: string;
}

export function resolveDefaultStoreRoot(environment: StoreEnvironment): string {
    if (environment.platform === 'win32') {
        if (!win32.isAbsolute(environment.userHome)) {
            throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The user data home must be an absolute path');
        }
        const base =
            environment.localAppData !== undefined &&
            environment.localAppData.length > 0 &&
            win32.isAbsolute(environment.localAppData)
                ? environment.localAppData
                : win32.join(environment.userHome, 'AppData', 'Local');
        return win32.join(base, 'Erden', 'store', 'v1');
    }
    if (!posix.isAbsolute(environment.userHome)) {
        throw new LocalPackageStoreError('STORE_INVALID_INPUT', 'The user data home must be an absolute path');
    }
    const base =
        environment.xdgDataHome !== undefined &&
        environment.xdgDataHome.length > 0 &&
        posix.isAbsolute(environment.xdgDataHome)
            ? environment.xdgDataHome
            : posix.join(environment.userHome, '.local', 'share');
    return posix.join(base, 'erden', 'store', 'v1');
}

export function nodeStoreEnvironment(): StoreEnvironment {
    return Object.freeze({
        platform: process.platform,
        ...(process.env.LOCALAPPDATA === undefined ? {} : { localAppData: process.env.LOCALAPPDATA }),
        ...(process.env.XDG_DATA_HOME === undefined ? {} : { xdgDataHome: process.env.XDG_DATA_HOME }),
        userHome: homedir(),
    });
}

export interface StoreNodeOperations {
    readonly lstat: typeof fs.lstat;
    readonly mkdir: typeof fs.mkdir;
    readonly open: typeof fs.open;
    readonly readFile: typeof fs.readFile;
    readonly writeFile: typeof fs.writeFile;
    readonly readdir: typeof fs.readdir;
    readonly opendir: typeof fs.opendir;
    readonly rename: typeof fs.rename;
    readonly realpath: typeof fs.realpath;
    readonly chmod: typeof fs.chmod;
    readonly rm: typeof fs.rm;
    readonly rmdir: typeof fs.rmdir;
    readonly link: typeof fs.link;
    readonly copyFile: typeof fs.copyFile;
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
    readonly token: () => string;
    readonly enforcePosixModes: boolean;
}

const nodeStoreOperations: StoreNodeOperations = Object.freeze({
    lstat: fs.lstat,
    mkdir: fs.mkdir,
    open: fs.open,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    readdir: fs.readdir,
    opendir: fs.opendir,
    rename: fs.rename,
    realpath: fs.realpath,
    chmod: fs.chmod,
    rm: fs.rm,
    rmdir: fs.rmdir,
    link: fs.link,
    copyFile: fs.copyFile,
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
    token: randomUUID,
    enforcePosixModes: process.platform !== 'win32',
});

export interface StoreFileSystemPort {
    readonly operations: StoreNodeOperations;
    readonly extractionOperations: PackageExtractionOperations;
    readonly importFile: (source: string, destination: string) => Promise<ImportStrategy>;
}

function errorCode(error: unknown): string | undefined {
    return error !== null && typeof error === 'object' && 'code' in error
        ? String(
              (
                  error as {
                      code?: unknown;
                  }
              ).code,
          )
        : undefined;
}

function cloneUnsupported(error: unknown): boolean {
    const code = errorCode(error);
    return (
        code !== undefined && ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'ENOTTY', 'EXDEV', 'EPERM'].includes(code)
    );
}

function hardlinkUnsupported(error: unknown): boolean {
    const code = errorCode(error);
    return code !== undefined && ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM', 'EACCES'].includes(code);
}

export function makeNodeStoreFileSystemPort(
    overrides: Partial<StoreNodeOperations> = {},
    extractionOverrides: Partial<PackageExtractionOperations> = {},
): StoreFileSystemPort {
    const operations = Object.freeze({ ...nodeStoreOperations, ...overrides });
    return Object.freeze({
        operations,
        extractionOperations: makeNodePackageExtractionOperations(extractionOverrides),
        importFile: async (source: string, destination: string): Promise<ImportStrategy> => {
            try {
                await operations.copyFile(
                    source,
                    destination,
                    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
                );
                return 'clone';
            } catch (error) {
                if (!cloneUnsupported(error)) {
                    throw error;
                }
                try {
                    await operations.lstat(destination, { bigint: true });
                    throw new LocalPackageStoreError(
                        'INSTALL_ROLLBACK_UNSAFE',
                        'An import primitive left an unauthenticated destination',
                    );
                } catch (inspectionError) {
                    if (errorCode(inspectionError) !== 'ENOENT') {
                        throw inspectionError;
                    }
                }
            }
            try {
                await operations.link(source, destination);
                return 'hardlink';
            } catch (error) {
                if (!hardlinkUnsupported(error)) {
                    throw error;
                }
                try {
                    await operations.lstat(destination, { bigint: true });
                    throw new LocalPackageStoreError(
                        'INSTALL_ROLLBACK_UNSAFE',
                        'An import primitive left an unauthenticated destination',
                    );
                } catch (inspectionError) {
                    if (errorCode(inspectionError) !== 'ENOENT') {
                        throw inspectionError;
                    }
                }
            }
            await operations.copyFile(source, destination, constants.COPYFILE_EXCL);
            return 'copy';
        },
    });
}
