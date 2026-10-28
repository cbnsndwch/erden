import { randomUUID } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface ProjectLockNodeOperations {
    readonly lstat: typeof fs.lstat;
    readonly open: typeof fs.open;
    readonly opendir: typeof fs.opendir;
    readonly realpath: typeof fs.realpath;
    readonly link: typeof fs.link;
    readonly unlink: typeof fs.unlink;
    readonly chmod: typeof fs.chmod;
    readonly read: (
        handle: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
    ) => Promise<{ readonly bytesRead: number }>;
    readonly write: (
        handle: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
    ) => Promise<{ readonly bytesWritten: number }>;
    readonly stat: (handle: FileHandle) => Promise<BigIntStats>;
    readonly sync: (handle: FileHandle) => Promise<void>;
    readonly close: (handle: FileHandle) => Promise<void>;
    readonly token: () => string;
    readonly enforcePosixModes: boolean;
}

export interface ProjectLockFileSystemPort {
    readonly operations: ProjectLockNodeOperations;
}

const nodeOperations: ProjectLockNodeOperations = Object.freeze({
    lstat: fs.lstat,
    open: fs.open,
    opendir: fs.opendir,
    realpath: fs.realpath,
    link: fs.link,
    unlink: fs.unlink,
    chmod: fs.chmod,
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

export function makeNodeProjectLockFileSystemPort(
    overrides: Partial<ProjectLockNodeOperations> = {},
): ProjectLockFileSystemPort {
    return Object.freeze({
        operations: Object.freeze({ ...nodeOperations, ...overrides }),
    });
}
