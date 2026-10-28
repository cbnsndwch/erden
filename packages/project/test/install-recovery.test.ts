import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { nodeCurrentToolchainService, normalizeManifestV1, serializeManifestV1 } from '@erden/contracts';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    InstallProjectTransactionPendingError,
    makeInstallProjectService,
    makeNodeProjectDependencyStateFileSystemPort,
    makeProjectDependencyStateService,
    nodeCheckProjectService,
    nodeLocalPackageStore,
    nodePackProjectService,
    nodeTransactionResidue,
    renderCheckProjectError,
    renderInstallProjectError,
    unavailableDependencyRegistry,
    type InstallProjectError,
} from '../src/index.js';

// The 2026-10-05 bug report addendum: a killed `erden install` left a transaction that blocked the next install.

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

type Operations = Parameters<typeof makeNodeProjectDependencyStateFileSystemPort>[0];

async function project(): Promise<Readonly<{ root: string; projectRoot: string }>> {
    const root = makeTestTempRoot('erden-install-recovery-');
    roots.push(root);
    const projectRoot = join(root, 'project');
    await fs.mkdir(projectRoot);
    await fs.writeFile(
        join(projectRoot, 'erden.config.json'),
        serializeManifestV1(
            normalizeManifestV1({
                schemaVersion: 1,
                canonicalIri: 'https://example.test/recovery',
                alias: '@example/recovery',
                ownedIriPrefixes: ['https://example.test/recovery#'],
                sources: { ontology: ['ontology.ttl'] },
                citationRoots: {},
                dependencies: {},
            }),
            'json',
        ),
        { mode: 0o644 },
    );
    await fs.writeFile(
        join(projectRoot, 'ontology.ttl'),
        '@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://example.test/recovery#A> a owl:Class .\n',
        { mode: 0o644 },
    );
    return { root, projectRoot };
}

function installService(root: string, overrides: Operations = {}) {
    return makeInstallProjectService(
        makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort(overrides)),
        nodeCurrentToolchainService,
        unavailableDependencyRegistry,
        nodeLocalPackageStore,
        Object.freeze({ defaultStoreRoot: () => join(root, 'store'), transactionResidue: nodeTransactionResidue }),
    );
}

const base = makeNodeProjectDependencyStateFileSystemPort().operations;

let reachedKill: (() => void) | undefined;

/** An operation that never returns stands in for the process being killed at that point. */
function killed(): Promise<never> {
    reachedKill?.();
    return new Promise<never>(() => undefined);
}

async function residue(projectRoot: string): Promise<ReadonlyArray<string>> {
    return (await fs.readdir(projectRoot)).filter((name) => name.startsWith('.erden.dependencies.')).sort();
}

async function interruptedInstall(projectRoot: string, root: string, overrides: Operations): Promise<void> {
    let settled = false;
    const reached = new Promise<void>((resolvePromise, reject) => {
        reachedKill = resolvePromise;
        setTimeout(() => {
            reject(new Error('The interrupted install never reached its kill point'));
        }, 10_000);
    });
    void Effect.runPromise(installService(root, overrides).install({ from: projectRoot, offline: true })).finally(
        () => {
            settled = true;
        },
    );
    await reached;
    reachedKill = undefined;
    expect(settled).toBe(false);
}

const interruptions: ReadonlyArray<readonly [string, Operations, ReadonlyArray<string>]> = [
    [
        'after the marker is active, before the manifest backup',
        {
            link: async (from, to) => {
                if (String(to).includes('.manifest.backup-')) {
                    await killed();
                }
                await base.link(from, to);
            },
        },
        ['lock.stage', 'manifest.stage', 'marker.stage', 'transaction.json'],
    ],
    [
        'after the manifest backup, before the lock is published',
        {
            link: async (from, to) => {
                if (String(from).includes('.lock.stage-') && String(to).endsWith('erden.lock')) {
                    await killed();
                }
                await base.link(from, to);
            },
        },
        ['lock.stage', 'manifest.backup', 'manifest.stage', 'marker.stage', 'transaction.json'],
    ],
    [
        'during cleanup after the lock is published (the reported residue)',
        {
            unlink: async (path) => {
                if (String(path).includes('.lock.stage-')) {
                    await killed();
                }
                await base.unlink(path);
            },
        },
        ['lock.stage', 'manifest.backup', 'marker.stage', 'transaction.json'],
    ],
    [
        'before the active marker is removed',
        {
            unlink: async (path) => {
                if (String(path).endsWith('.erden.dependencies.transaction.json')) {
                    await killed();
                }
                await base.unlink(path);
            },
        },
        ['transaction.json'],
    ],
];

describe('recovering an interrupted erden install', () => {
    it.each(interruptions)(
        'recovers when install was killed %s',
        async (_point, overrides, expected) => {
            const { root, projectRoot } = await project();
            await interruptedInstall(projectRoot, root, overrides);
            const left = await residue(projectRoot);
            expect(
                left.map((name) => name.replace(/^\.erden\.dependencies\./u, '').replace(/-[0-9a-f]{8}-.*$/u, '')),
            ).toEqual(expected);
            const backup = left.find((name) => name.includes('.manifest.backup-'));
            if (backup !== undefined) {
                expect((await fs.stat(join(projectRoot, backup))).nlink).toBe(2);
            }

            const check = await Effect.runPromise(
                Effect.flip(nodeCheckProjectService.check({ from: projectRoot, offline: true })),
            );
            expect(renderCheckProjectError(check)).toContain('Run erden install to recover the interrupted install');
            const pack = await Effect.runPromise(
                Effect.flip(nodePackProjectService.pack({ version: '1.0.0', from: projectRoot })),
            );
            expect(pack.message).toContain('run erden install to recover them');
            expect(await residue(projectRoot)).toEqual(left);

            const report = await Effect.runPromise(installService(root).install({ from: projectRoot, offline: true }));
            expect(report.outcome).toBe('installed');
            expect(await residue(projectRoot)).toEqual([]);
            await expect(fs.access(join(projectRoot, 'erden.lock'))).resolves.toBeUndefined();
            const checked = await Effect.runPromise(
                nodeCheckProjectService.check({ from: projectRoot, offline: true }),
            );
            expect(checked.outcome).toBe('passed');
        },
        60_000,
    );

    it('names the leftover files and the manual remedy when recovery cannot authenticate them', async () => {
        const { root, projectRoot } = await project();
        await interruptedInstall(projectRoot, root, {
            open: async (path, flags, mode) =>
                String(path).includes('.marker.stage-') ? await killed() : await base.open(path, flags, mode),
        });
        const left = await residue(projectRoot);
        expect(left).toHaveLength(2);
        let failure: InstallProjectError | undefined;
        try {
            await Effect.runPromise(installService(root).install({ from: projectRoot, offline: true }));
        } catch (cause) {
            failure = cause as InstallProjectError;
        }
        expect(failure).toBeInstanceOf(InstallProjectTransactionPendingError);
        expect(failure?.code).toBe('INSTALL_PROJECT_TRANSACTION_PENDING');
        expect((failure as InstallProjectTransactionPendingError).residue).toEqual(left);
        const rendered = renderInstallProjectError(failure as InstallProjectError);
        for (const name of left) {
            expect(rendered).toContain(`- leftover ${name}`);
        }
        expect(rendered).toContain('delete the leftover .erden.dependencies.* files');
        expect(rendered).not.toContain(projectRoot);
        expect(await residue(projectRoot)).toEqual(left);
    }, 60_000);
});
