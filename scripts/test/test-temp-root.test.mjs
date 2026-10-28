import assert from 'node:assert/strict';
import {
    chmodSync,
    existsSync,
    linkSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { cleanupTestTempRoot, makeTestTempRoot } from '../lib/test-temp-root.mjs';

describe('owned test temporary roots', () => {
    it('cleans a packed-install-shaped read-only project and store without weakening fixture modes', () => {
        const root = makeTestTempRoot('erden-cli-npm-install-cleanup-');
        const installed = join(root, 'project', '.erden', 'layers', 'package');
        const stored = join(root, 'user-data', 'erden', 'store', 'objects', 'digest', 'package');
        mkdirSync(installed, { recursive: true });
        mkdirSync(stored, { recursive: true });
        const files = [join(installed, 'ontology.ttl'), join(stored, 'ontology.ttl')];
        for (const file of files) {
            writeFileSync(file, '<urn:s> <urn:p> <urn:o> .\n', { mode: 0o644 });
            chmodSync(file, 0o444);
        }
        const readOnlyDirectories = [
            installed,
            join(root, 'project', '.erden', 'layers'),
            join(root, 'project', '.erden'),
            stored,
            dirname(stored),
            dirname(dirname(stored)),
        ];
        for (const directory of readOnlyDirectories) {
            chmodSync(directory, 0o555);
        }
        if (process.platform !== 'win32') {
            assert.equal(statSync(files[0]).mode & 0o7777, 0o444);
            assert.equal(statSync(installed).mode & 0o7777, 0o555);
        }

        cleanupTestTempRoot(root);
        assert.equal(existsSync(root), false);
    });

    it(
        'unlinks a contained symlink without reading or changing its target',
        {
            skip: process.platform === 'win32',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-symlink-');
            const external = makeTestTempRoot('erden-cleanup-target-');
            const sentinel = join(external, 'sentinel.txt');
            writeFileSync(sentinel, 'keep\n', { mode: 0o644 });
            symlinkSync(external, join(root, 'linked-target'), 'dir');

            cleanupTestTempRoot(root);
            assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n');
            assert.equal(statSync(sentinel).mode & 0o7777, 0o644);
            cleanupTestTempRoot(external);
        },
    );

    it(
        'does not chmod a file reached through a contained hard link',
        {
            skip: process.platform === 'win32',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-hardlink-');
            const external = makeTestTempRoot('erden-cleanup-hardlink-target-');
            const sentinel = join(external, 'sentinel.txt');
            writeFileSync(sentinel, 'keep\n', { mode: 0o444 });
            linkSync(sentinel, join(root, 'linked-file'));

            cleanupTestTempRoot(root);
            assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n');
            assert.equal(statSync(sentinel).mode & 0o7777, 0o444);
            cleanupTestTempRoot(external);
        },
    );

    it(
        'rejects an unknown path and a replaced registered root',
        {
            skip: process.platform === 'win32',
        },
        () => {
            assert.throws(() => cleanupTestTempRoot('/tmp/erden-not-owned-by-this-test'));
            const root = makeTestTempRoot('erden-cleanup-replaced-');
            const original = `${root}-original`;
            const external = makeTestTempRoot('erden-cleanup-replaced-target-');
            renameSync(root, original);
            symlinkSync(external, root, 'dir');
            try {
                assert.throws(() => cleanupTestTempRoot(root), /replaced directory|replaced root/u);
                assert.equal(existsSync(external), true);
            } finally {
                unlinkSync(root);
                renameSync(original, root);
                cleanupTestTempRoot(root);
                cleanupTestTempRoot(external);
            }
        },
    );

    it(
        'rejects a registered root replaced by a dangling symlink',
        {
            skip: process.platform === 'win32',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-dangling-root-');
            const original = `${root}-original`;
            renameSync(root, original);
            symlinkSync(`${root}-missing-target`, root, 'dir');
            try {
                assert.throws(() => cleanupTestTempRoot(root), /replaced directory|replaced root/u);
                assert.equal(statSync(original).isDirectory(), true);
            } finally {
                unlinkSync(root);
                renameSync(original, root);
                cleanupTestTempRoot(root);
            }
        },
    );

    it(
        'binds directory chmod to the authenticated descriptor across a root symlink swap',
        {
            skip: process.platform !== 'linux',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-descriptor-swap-');
            const original = `${root}-original`;
            const external = makeTestTempRoot('erden-cleanup-descriptor-target-');
            const sentinel = join(external, 'sentinel.txt');
            writeFileSync(sentinel, 'keep\n', { mode: 0o644 });
            chmodSync(root, 0o555);
            chmodSync(external, 0o555);
            let swapped = false;
            try {
                assert.throws(
                    () =>
                        cleanupTestTempRoot(root, {
                            beforeDirectoryDescriptorMutation: (path) => {
                                if (path !== root || swapped) {
                                    return;
                                }
                                swapped = true;
                                renameSync(root, original);
                                symlinkSync(external, root, 'dir');
                            },
                        }),
                    /replaced directory|replaced entry/u,
                );
                assert.equal(statSync(external).mode & 0o7777, 0o555);
                assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n');
            } finally {
                if (swapped) {
                    unlinkSync(root);
                    renameSync(original, root);
                }
                cleanupTestTempRoot(root);
                cleanupTestTempRoot(external);
            }
        },
    );

    it(
        'revalidates a child identity immediately before non-recursive removal',
        {
            skip: process.platform !== 'linux',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-entry-swap-');
            const child = join(root, 'child');
            const original = join(root, 'child-original');
            const external = makeTestTempRoot('erden-cleanup-entry-target-');
            const sentinel = join(external, 'sentinel.txt');
            mkdirSync(child);
            writeFileSync(sentinel, 'keep\n', { mode: 0o644 });
            chmodSync(external, 0o555);
            let swapped = false;
            try {
                assert.throws(
                    () =>
                        cleanupTestTempRoot(root, {
                            beforeEntryRemoval: (path, kind) => {
                                if (path !== child || kind !== 'directory' || swapped) {
                                    return;
                                }
                                swapped = true;
                                renameSync(child, original);
                                symlinkSync(external, child, 'dir');
                            },
                        }),
                    /replaced directory|replaced entry/u,
                );
                assert.equal(statSync(external).mode & 0o7777, 0o555);
                assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n');
            } finally {
                if (swapped) {
                    unlinkSync(child);
                    renameSync(original, child);
                }
                cleanupTestTempRoot(root);
                cleanupTestTempRoot(external);
            }
        },
    );

    it(
        'rejects a newly observed bind-mount boundary before descriptor mutation',
        {
            skip: process.platform !== 'linux',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-bind-boundary-');
            chmodSync(root, 0o555);
            const mountInfo = readFileSync('/proc/self/mountinfo', 'utf8');
            const escapedRoot = root.replaceAll('\\', '\\134').replaceAll(' ', '\\040');
            const injectedMount = `999999 1 0:0 / ${escapedRoot} rw - none none rw\n`;
            try {
                assert.throws(
                    () =>
                        cleanupTestTempRoot(root, {
                            readMountInfo: () => `${mountInfo}${injectedMount}`,
                        }),
                    /mount/u,
                );
                assert.equal(statSync(root).mode & 0o7777, 0o555);
            } finally {
                cleanupTestTempRoot(root);
            }
        },
    );

    it(
        'observes a mount added after earlier boundary checks before removing an entry',
        {
            skip: process.platform !== 'linux',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-late-mount-');
            const sentinel = join(root, 'sentinel.txt');
            writeFileSync(sentinel, 'keep\n');
            const mountInfo = readFileSync('/proc/self/mountinfo', 'utf8');
            const escaped = sentinel.replaceAll('\\', '\\134').replaceAll(' ', '\\040');
            let mounted = false;
            let reads = 0;
            try {
                assert.throws(
                    () =>
                        cleanupTestTempRoot(root, {
                            readMountInfo: () => {
                                reads += 1;
                                return mounted
                                    ? `${mountInfo}999999 1 0:0 / ${escaped} rw - none none rw\n`
                                    : mountInfo;
                            },
                            beforeEntryRemoval: () => {
                                assert.ok(reads > 1, 'the earlier boundary checks must have read the table');
                                mounted = true;
                            },
                        }),
                    /mount boundary/u,
                );
                assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n');
            } finally {
                cleanupTestTempRoot(root);
            }
        },
    );

    it(
        'checks each owned root against an unchanged mount table independently',
        {
            skip: process.platform !== 'linux',
        },
        () => {
            const first = makeTestTempRoot('erden-cleanup-first-mount-');
            const second = makeTestTempRoot('erden-cleanup-second-mount-');
            const escaped = second.replaceAll('\\', '\\134').replaceAll(' ', '\\040');
            const mountInfo = `${readFileSync('/proc/self/mountinfo', 'utf8')}999999 1 0:0 / ${escaped} rw - none none rw\n`;
            try {
                cleanupTestTempRoot(first, { readMountInfo: () => mountInfo });
                assert.throws(() => cleanupTestTempRoot(second, { readMountInfo: () => mountInfo }), /mount/u);
                assert.equal(existsSync(second), true);
            } finally {
                if (existsSync(first)) {
                    cleanupTestTempRoot(first);
                }
                cleanupTestTempRoot(second);
            }
        },
    );

    it(
        'fails closed when a mount-table read fails after earlier checks passed',
        {
            skip: process.platform !== 'linux',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-mount-read-failure-');
            const sentinel = join(root, 'sentinel.txt');
            writeFileSync(sentinel, 'keep\n');
            const mountInfo = readFileSync('/proc/self/mountinfo', 'utf8');
            let failed = false;
            try {
                assert.throws(
                    () =>
                        cleanupTestTempRoot(root, {
                            readMountInfo: () => {
                                if (failed) {
                                    throw new Error('unavailable');
                                }
                                return mountInfo;
                            },
                            beforeEntryRemoval: () => {
                                failed = true;
                            },
                        }),
                    /could not inspect Linux mount boundaries/u,
                );
                assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n');
            } finally {
                cleanupTestTempRoot(root);
            }
        },
    );

    it(
        'rejects a descriptor bound to a different mount identity',
        {
            skip: process.platform !== 'linux',
        },
        () => {
            const root = makeTestTempRoot('erden-cleanup-descriptor-mount-');
            chmodSync(root, 0o555);
            try {
                assert.throws(
                    () =>
                        cleanupTestTempRoot(root, {
                            readDescriptorMountId: () => '999997',
                        }),
                    /mount/u,
                );
                assert.equal(statSync(root).mode & 0o7777, 0o555);
            } finally {
                cleanupTestTempRoot(root);
            }
        },
    );
});
