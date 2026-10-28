import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readdirSync,
    realpathSync,
    rmdirSync,
    unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import {
    enclosingLinuxMount,
    isContainedPath,
    parseLinuxMountInfo,
    readLinuxDescriptorMountId,
    readLinuxMountInfo,
} from './mount-boundary.mjs';

const ownedRoots = new Map();
const validatedMountRecords = new WeakMap();
const ownerUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
const temporaryDirectory = realpathSync(tmpdir());
const directoryOpenFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
let mountInfoCache;

function readMountRecords(hooks) {
    if (process.platform !== 'linux') {
        return [];
    }
    try {
        // Read the current table every time. Only reuse parsing when its entire contents are identical.
        const text = (hooks.readMountInfo ?? readLinuxMountInfo)();
        if (mountInfoCache === undefined || mountInfoCache.text !== text) {
            mountInfoCache = { text, records: parseLinuxMountInfo(text) };
        }
        return mountInfoCache.records;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Test filesystem safety')) {
            throw error;
        }
        throw new Error('Test temporary-root cleanup could not inspect Linux mount boundaries');
    }
}

function assertMountBoundary(rootIdentity, hooks) {
    if (process.platform !== 'linux') {
        return;
    }
    const records = readMountRecords(hooks);
    if (validatedMountRecords.get(rootIdentity) === records) {
        return;
    }
    if (enclosingLinuxMount(rootIdentity.realPath, records).key !== rootIdentity.mountKey) {
        throw new Error('Test temporary-root cleanup found a changed root mount identity');
    }
    if (
        records.some(
            ({ mountPoint }) =>
                mountPoint === rootIdentity.realPath || isContainedPath(rootIdentity.realPath, mountPoint),
        )
    ) {
        throw new Error('Test temporary-root cleanup refused to cross a mount boundary');
    }
    validatedMountRecords.set(rootIdentity, records);
}

function assertOwnedStats(stats, rootIdentity, requireDirectory, expected) {
    if (requireDirectory && (!stats.isDirectory() || stats.isSymbolicLink())) {
        throw new Error('Test temporary-root cleanup found a replaced directory');
    }
    if (stats.dev !== rootIdentity.dev) {
        throw new Error('Test temporary-root cleanup refused to cross a filesystem boundary');
    }
    if (ownerUid !== undefined && stats.uid !== BigInt(ownerUid)) {
        throw new Error('Test temporary-root cleanup found an entry owned by another user');
    }
    if (expected !== undefined && (stats.dev !== expected.dev || stats.ino !== expected.ino)) {
        throw new Error('Test temporary-root cleanup found a replaced entry');
    }
    return stats;
}

function lstatOwned(path, rootIdentity, requireDirectory, expected) {
    return assertOwnedStats(lstatSync(path, { bigint: true }), rootIdentity, requireDirectory, expected);
}

function assertDescriptorIdentity(fd, rootIdentity, expected, hooks) {
    const stats = assertOwnedStats(fstatSync(fd, { bigint: true }), rootIdentity, true, expected);
    if (process.platform === 'linux') {
        let mountId;
        try {
            mountId = (hooks.readDescriptorMountId ?? readLinuxDescriptorMountId)(fd);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Test filesystem safety')) {
                throw error;
            }
            throw new Error('Test temporary-root cleanup could not inspect a descriptor mount identity');
        }
        if (mountId !== rootIdentity.mountId) {
            throw new Error('Test temporary-root cleanup refused a changed descriptor mount identity');
        }
    }
    return stats;
}

function assertSameIdentity(left, right) {
    if (left.dev !== right.dev || left.ino !== right.ino || left.uid !== right.uid) {
        throw new Error('Test temporary-root cleanup found a changed descriptor identity');
    }
}

function removeLinuxDirectory(accessPath, logicalPath, rootIdentity, hooks, expected) {
    assertMountBoundary(rootIdentity, hooks);
    const fd = openSync(accessPath, directoryOpenFlags);
    try {
        const opened = assertDescriptorIdentity(fd, rootIdentity, expected, hooks);
        const named = lstatOwned(accessPath, rootIdentity, true, opened);
        assertSameIdentity(opened, named);
        assertMountBoundary(rootIdentity, hooks);
        const atMutation = assertDescriptorIdentity(fd, rootIdentity, opened, hooks);
        hooks.beforeDirectoryDescriptorMutation?.(logicalPath);
        const stillOpened = assertDescriptorIdentity(fd, rootIdentity, atMutation, hooks);
        assertSameIdentity(atMutation, stillOpened);
        fchmodSync(fd, Number(stillOpened.mode & 4095n) | 0o700);
        const restored = assertDescriptorIdentity(fd, rootIdentity, stillOpened, hooks);
        assertSameIdentity(stillOpened, restored);
        if ((restored.mode & 448n) !== 448n) {
            throw new Error('Test temporary-root cleanup could not restore owner directory permissions');
        }
        const descriptorPath = `/proc/self/fd/${fd}`;
        for (const name of readdirSync(descriptorPath)) {
            const childAccessPath = join(descriptorPath, name);
            const childLogicalPath = join(logicalPath, name);
            assertMountBoundary(rootIdentity, hooks);
            const initial = lstatOwned(childAccessPath, rootIdentity, false);
            if (initial.isDirectory() && !initial.isSymbolicLink()) {
                removeLinuxDirectory(childAccessPath, childLogicalPath, rootIdentity, hooks, initial);
                assertMountBoundary(rootIdentity, hooks);
                lstatOwned(childAccessPath, rootIdentity, true, initial);
                hooks.beforeEntryRemoval?.(childLogicalPath, 'directory');
                assertMountBoundary(rootIdentity, hooks);
                lstatOwned(childAccessPath, rootIdentity, true, initial);
                rmdirSync(childAccessPath);
            } else {
                hooks.beforeEntryRemoval?.(childLogicalPath, 'entry');
                assertMountBoundary(rootIdentity, hooks);
                const current = lstatOwned(childAccessPath, rootIdentity, false, initial);
                if (current.isDirectory() && !current.isSymbolicLink()) {
                    throw new Error('Test temporary-root cleanup found a replaced entry');
                }
                unlinkSync(childAccessPath);
            }
        }
    } finally {
        closeSync(fd);
    }
}

function restorePortableDirectory(path, rootIdentity, hooks, expected) {
    const initial = lstatOwned(path, rootIdentity, true, expected);
    if (process.platform !== 'win32') {
        const fd = openSync(path, directoryOpenFlags);
        try {
            const opened = assertDescriptorIdentity(fd, rootIdentity, initial, hooks);
            hooks.beforeDirectoryDescriptorMutation?.(path);
            const atMutation = assertDescriptorIdentity(fd, rootIdentity, opened, hooks);
            fchmodSync(fd, Number(atMutation.mode & 4095n) | 0o700);
            assertDescriptorIdentity(fd, rootIdentity, atMutation, hooks);
        } finally {
            closeSync(fd);
        }
    }
    for (const name of readdirSync(path)) {
        const child = join(path, name);
        const childIdentity = lstatOwned(child, rootIdentity, false);
        if (childIdentity.isDirectory() && !childIdentity.isSymbolicLink()) {
            restorePortableDirectory(child, rootIdentity, hooks, childIdentity);
            lstatOwned(child, rootIdentity, true, childIdentity);
            hooks.beforeEntryRemoval?.(child, 'directory');
            lstatOwned(child, rootIdentity, true, childIdentity);
            rmdirSync(child);
        } else {
            hooks.beforeEntryRemoval?.(child, 'entry');
            const current = lstatOwned(child, rootIdentity, false, childIdentity);
            if (current.isDirectory() && !current.isSymbolicLink()) {
                throw new Error('Test temporary-root cleanup found a replaced entry');
            }
            unlinkSync(child);
        }
    }
}

function registerTestTempRoot(path, hooks) {
    if (typeof path !== 'string' || !isAbsolute(path) || ownedRoots.has(path)) {
        throw new TypeError('Test temporary-root registration requires one new absolute path');
    }
    const realPath = realpathSync(path);
    if (dirname(realPath) !== temporaryDirectory) {
        throw new Error('Test temporary-root registration escaped the operating-system temporary directory');
    }
    const stats = lstatSync(realPath, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Test temporary-root registration requires a plain directory');
    }
    if (ownerUid !== undefined && stats.uid !== BigInt(ownerUid)) {
        throw new Error('Test temporary-root registration found a directory owned by another user');
    }
    const records = readMountRecords(hooks);
    if (
        process.platform === 'linux' &&
        records.some(({ mountPoint }) => mountPoint === realPath || isContainedPath(realPath, mountPoint))
    ) {
        throw new Error('Test temporary-root registration found a mount boundary');
    }
    const enclosingMount = process.platform === 'linux' ? enclosingLinuxMount(realPath, records) : undefined;
    ownedRoots.set(
        path,
        Object.freeze({
            dev: stats.dev,
            ino: stats.ino,
            mountId: enclosingMount?.mountId,
            mountKey: enclosingMount?.key,
            realPath,
        }),
    );
    return path;
}

export function makeTestTempRoot(prefix, hooks = {}) {
    if (typeof prefix !== 'string' || prefix.length < 2 || basename(prefix) !== prefix || !prefix.endsWith('-')) {
        throw new TypeError('Test temporary-root prefixes must be one nonempty path component ending in a hyphen');
    }
    return registerTestTempRoot(mkdtempSync(join(tmpdir(), prefix)), hooks);
}

export function cleanupTestTempRoot(path, hooks = {}) {
    const rootIdentity = ownedRoots.get(path);
    if (rootIdentity === undefined) {
        throw new Error('Test temporary-root cleanup accepts only roots created by this invocation');
    }
    let current;
    try {
        current = lstatSync(path, { bigint: true });
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
        ownedRoots.delete(path);
        return;
    }
    assertOwnedStats(current, rootIdentity, true, rootIdentity);
    if (realpathSync(path) !== rootIdentity.realPath) {
        throw new Error('Test temporary-root cleanup found a replaced root');
    }
    if (process.platform === 'linux') {
        removeLinuxDirectory(path, path, rootIdentity, hooks, rootIdentity);
        assertMountBoundary(rootIdentity, hooks);
    } else {
        restorePortableDirectory(path, rootIdentity, hooks, rootIdentity);
    }
    lstatOwned(path, rootIdentity, true, rootIdentity);
    hooks.beforeRootRemoval?.(path);
    if (process.platform === 'linux') {
        assertMountBoundary(rootIdentity, hooks);
    }
    lstatOwned(path, rootIdentity, true, rootIdentity);
    rmdirSync(path);
    ownedRoots.delete(path);
}
