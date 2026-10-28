import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

import { Effect, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    assertValidatorProfileIntegrity,
    checkLockConsistency,
    ERDEN_VALIDATOR_PROFILE_DOCUMENT,
    ERDEN_VALIDATOR_PROFILE_SHA256,
    ERDEN_VALIDATOR_PROFILE_VERSION,
    makeCurrentToolchainService,
    makeEmptyLockfile,
    normalizeManifestV1,
    projectCurrentToolchain,
    serializeLockfile,
    type LoadedManifestV1,
    type LockToolchain,
} from '@erden/contracts';
import { inspectNodeBundledReasoner, type BundledReasonerDoctorInspection } from '@erden/ontology';

import { makeNodeProjectLockFileSystemPort, makeProjectLockService, ProjectLockError } from '../src/index.js';

function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: digest('a') }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: digest('b') }),
});

function loadedProject(root: string): LoadedManifestV1 {
    const manifest = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/project',
        alias: '@example/project',
        ownedIriPrefixes: ['https://example.test/project#'],
        sources: { ontology: ['ontology.ttl'] },
    });
    return Object.freeze({
        format: 'json',
        filePath: join(root, 'erden.config.json'),
        projectRoot: root,
        manifest,
        resolvedSources: Object.freeze({
            ontology: Object.freeze([join(root, 'ontology.ttl')]),
            shapes: Object.freeze([]),
            competencyQuestions: Object.freeze([]),
        }),
        resolvedCitationRoots: Object.freeze({}),
    });
}

describe('current dependency toolchain', () => {
    it('binds the validator semantic version into the guarded canonical profile', async () => {
        expect(() => {
            assertValidatorProfileIntegrity();
        }).not.toThrow();
        expect(JSON.parse(ERDEN_VALIDATOR_PROFILE_DOCUMENT)).toMatchObject({
            format: 'erden.validator-profile/v1',
            version: ERDEN_VALIDATOR_PROFILE_VERSION,
        });
        expect(createHash('sha256').update(ERDEN_VALIDATOR_PROFILE_DOCUMENT).digest('hex')).toBe(
            ERDEN_VALIDATOR_PROFILE_SHA256,
        );
        const changed = ERDEN_VALIDATOR_PROFILE_DOCUMENT.replace('"version":"1.0.0"', '"version":"1.0.1"');
        expect(createHash('sha256').update(changed).digest('hex')).not.toBe(ERDEN_VALIDATOR_PROFILE_SHA256);

        let calls = 0;
        const service = makeCurrentToolchainService(() => {
            calls += 1;
            return TOOLCHAIN;
        });
        const first = await Effect.runPromise(service.inspect());
        const second = await Effect.runPromise(service.inspect());
        expect(calls).toBe(1);
        expect(second).toBe(first);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.validator)).toBe(true);
    });

    it('projects platform artifacts with different executables onto one calculus requirement', () => {
        const inspected = inspectNodeBundledReasoner();
        if (inspected.requiredTool === null) {
            throw new Error('qualified reasoner fixture unavailable');
        }
        const tool = inspected.requiredTool;
        const calculusDigest = tool.calculusDigest;
        function platformInspection(character: string): BundledReasonerDoctorInspection {
            const executableDigest = `sha256:${digest(character)}`;
            return Object.freeze({
                ...inspected,
                digest: executableDigest,
                requiredTool: Object.freeze({ ...tool, executableDigest }),
            });
        }
        const windows = projectCurrentToolchain(platformInspection('c'));
        const linux = projectCurrentToolchain(platformInspection('d'));
        expect(windows).toEqual(linux);
        expect(windows.reasoner).toEqual({
            version: tool.version,
            sha256: calculusDigest.slice('sha256:'.length),
        });
    });
});

describe('ProjectLockService', () => {
    it('writes and reads one canonical root lock idempotently', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const service = makeProjectLockService(makeNodeProjectLockFileSystemPort());
            expect(await Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }))).toMatchObject({
                status: 'missing',
            });
            expect(await Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock }))).toMatchObject({
                status: 'written',
                cleanup: 'clean',
            });
            const inspected = await Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }));
            expect(inspected).toMatchObject({ status: 'available', lock });
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(serializeLockfile(lock));
            expect(await Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock }))).toMatchObject({
                status: 'hit',
            });
            expect(checkLockConsistency(project.manifest, TOOLCHAIN, lock)).toEqual({
                status: 'consistent',
                reasons: [],
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('rejects noncanonical bytes and portable case aliases', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-hostile-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const service = makeProjectLockService(makeNodeProjectLockFileSystemPort());
            await fs.writeFile(join(root, 'erden.lock'), serializeLockfile(lock).replace(/\n$/u, '\r\n'));
            await expect(Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }))).rejects.toMatchObject({
                code: 'PROJECT_LOCK_INVALID',
            });
            await fs.rm(join(root, 'erden.lock'));
            await fs.writeFile(join(root, 'ERDEN.LOCK'), serializeLockfile(lock));
            await expect(Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }))).rejects.toMatchObject({
                code: 'PROJECT_LOCK_INVALID',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('cleans an authenticated stage after a short-write failure', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-short-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            let writes = 0;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    write: () => {
                        writes += 1;
                        return Promise.resolve({ bytesWritten: 0 });
                    },
                }),
            );
            await expect(
                Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock })),
            ).rejects.toBeInstanceOf(ProjectLockError);
            expect(writes).toBe(1);
            expect((await fs.readdir(root)).filter((name) => name.includes('erden.lock'))).toEqual([]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('rejects folded transaction aliases and accepts a filesystem-root project', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-fold-'));
        try {
            const project = loadedProject(root);
            const service = makeProjectLockService(makeNodeProjectLockFileSystemPort());
            await fs.writeFile(join(root, '.erden.lock.ſtage-0123456789abcdef'), 'foreign');
            await expect(Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }))).rejects.toMatchObject({
                code: 'PROJECT_LOCK_INVALID',
            });
            const filesystemRoot = parse(root).root;
            await expect(
                Effect.runPromise(
                    service.inspect({
                        project: loadedProject(filesystemRoot),
                        toolchain: TOOLCHAIN,
                    }),
                ),
            ).resolves.toMatchObject({ status: 'missing' });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('reauthenticates source bytes after the final inspect directory scan', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-inspect-race-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const bytes = serializeLockfile(lock);
            await fs.writeFile(join(root, 'erden.lock'), bytes, { mode: 0o644 });
            const base = makeNodeProjectLockFileSystemPort().operations;
            let scans = 0;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    opendir: async (path, options) => {
                        const directory = await base.opendir(path, options);
                        scans += 1;
                        if (scans === 3) {
                            await fs.unlink(join(root, 'erden.lock'));
                            await fs.writeFile(join(root, 'erden.lock'), bytes, { mode: 0o644 });
                        }
                        return directory;
                    },
                }),
            );
            await expect(Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }))).rejects.toMatchObject({
                code: 'PROJECT_LOCK_INVALID',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it.each(['sync', 'close', 'chmod'] as const)(
        'cleans a byte-authenticated stage when %s finalization fails',
        async (failure) => {
            const root = await fs.mkdtemp(join(tmpdir(), `erden-project-lock-${failure}-`));
            try {
                const project = loadedProject(root);
                const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
                const base = makeNodeProjectLockFileSystemPort().operations;
                let injected = false;
                const service = makeProjectLockService(
                    makeNodeProjectLockFileSystemPort({
                        sync: async (handle) => {
                            await base.sync(handle);
                            if (failure === 'sync' && !injected) {
                                injected = true;
                                throw new Error('D:/private-sync');
                            }
                        },
                        close: async (handle) => {
                            await base.close(handle);
                            if (failure === 'close' && !injected) {
                                injected = true;
                                throw new Error('D:/private-close');
                            }
                        },
                        chmod: async (path, mode) => {
                            if (failure === 'chmod' && !injected) {
                                injected = true;
                                throw new Error('D:/private-chmod');
                            }
                            await base.chmod(path, mode);
                        },
                    }),
                );
                await expect(
                    Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock })),
                ).rejects.toMatchObject({ code: 'PROJECT_LOCK_IO_FAILURE' });
                expect((await fs.readdir(root)).filter((name) => name.includes('erden.lock'))).toEqual([]);
            } finally {
                await fs.rm(root, { recursive: true, force: true });
            }
        },
    );

    it('recovers authenticated canonical stage and backup residues before writing', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-recover-'));
        try {
            const project = loadedProject(root);
            const desired = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const otherManifest = normalizeManifestV1({
                ...project.manifest,
                canonicalIri: 'https://example.test/old',
                alias: '@example/old',
                ownedIriPrefixes: ['https://example.test/old#'],
            });
            const previous = makeEmptyLockfile(otherManifest, TOOLCHAIN);
            const token = '0123456789abcdef';
            await fs.writeFile(join(root, `.erden.lock.stage-${token}`), serializeLockfile(desired), { mode: 0o644 });
            await fs.writeFile(join(root, `.erden.lock.backup-${token}`), serializeLockfile(previous), { mode: 0o644 });
            const service = makeProjectLockService(makeNodeProjectLockFileSystemPort());
            await expect(
                Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock: desired })),
            ).resolves.toMatchObject({ status: 'written' });
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(serializeLockfile(desired));
            expect((await fs.readdir(root)).filter((name) => name.startsWith('.erden.lock.'))).toEqual([]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('reconciles backup and publication link-then-throw results', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-link-'));
        try {
            const project = loadedProject(root);
            const desired = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const changedToolchain: LockToolchain = {
                validator: TOOLCHAIN.validator,
                reasoner: { version: '1.0.1', sha256: digest('c') },
            };
            await fs.writeFile(
                join(root, 'erden.lock'),
                serializeLockfile(makeEmptyLockfile(project.manifest, changedToolchain)),
                { mode: 0o644 },
            );
            const base = makeNodeProjectLockFileSystemPort().operations;
            const injected = new Set<string>();
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    link: async (source, destination) => {
                        await base.link(source, destination);
                        const kind = String(destination).includes('.backup-') ? 'backup' : 'publication';
                        if (!injected.has(kind)) {
                            injected.add(kind);
                            throw new Error(`D:/private-${kind}`);
                        }
                    },
                }),
            );
            await expect(
                Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock: desired })),
            ).resolves.toMatchObject({ status: 'written' });
            expect(injected).toEqual(new Set(['backup', 'publication']));
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(serializeLockfile(desired));
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('restores the previous lock when interrupted after its authenticated backup', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-abort-'));
        try {
            const project = loadedProject(root);
            const desired = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const changedToolchain: LockToolchain = {
                validator: TOOLCHAIN.validator,
                reasoner: { version: '1.0.1', sha256: digest('c') },
            };
            const previousText = serializeLockfile(makeEmptyLockfile(project.manifest, changedToolchain));
            await fs.writeFile(join(root, 'erden.lock'), previousText, { mode: 0o644 });
            const base = makeNodeProjectLockFileSystemPort().operations;
            let release: (() => void) | undefined;
            let reached: (() => void) | undefined;
            const paused = new Promise<void>((resolve) => {
                reached = resolve;
            });
            const resume = new Promise<void>((resolve) => {
                release = resolve;
            });
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    unlink: async (path) => {
                        await base.unlink(path);
                        if (String(path).endsWith('erden.lock')) {
                            reached?.();
                            await resume;
                        }
                    },
                }),
            );
            const fiber = Effect.runFork(service.write({ project, toolchain: TOOLCHAIN, lock: desired }));
            await paused;
            const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
            release?.();
            await interrupted;
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(previousText);
            expect((await fs.readdir(root)).filter((name) => name.startsWith('.erden.lock.'))).toEqual([]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('preserves raced foreign targets and rejects final same-byte inode substitution', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-foreign-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const base = makeNodeProjectLockFileSystemPort().operations;
            let raced = false;
            const foreign = 'foreign-lock\n';
            const blocked = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    link: async (source, destination) => {
                        if (!raced && String(destination).endsWith('erden.lock')) {
                            raced = true;
                            await fs.writeFile(destination, foreign, { flag: 'wx', mode: 0o644 });
                        }
                        await base.link(source, destination);
                    },
                }),
            );
            await expect(
                Effect.runPromise(blocked.write({ project, toolchain: TOOLCHAIN, lock })),
            ).rejects.toMatchObject({ code: 'PROJECT_LOCK_ROLLBACK_UNSAFE' });
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(foreign);
            await fs.unlink(join(root, 'erden.lock'));

            let substituted = false;
            const canonical = serializeLockfile(lock);
            const drifting = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    opendir: async (path, options) => {
                        const directory = await base.opendir(path, options);
                        const names = await fs.readdir(root);
                        if (
                            !substituted &&
                            names.includes('erden.lock') &&
                            !names.some((name) => name.includes('.stage-'))
                        ) {
                            substituted = true;
                            await fs.unlink(join(root, 'erden.lock'));
                            await fs.writeFile(join(root, 'erden.lock'), canonical, { mode: 0o644 });
                        }
                        return directory;
                    },
                }),
            );
            await expect(
                Effect.runPromise(drifting.write({ project, toolchain: TOOLCHAIN, lock })),
            ).rejects.toMatchObject({ code: 'PROJECT_LOCK_ROLLBACK_UNSAFE' });
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(canonical);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('does not return missing when erden.lock appears during the final root recheck', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-missing-race-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            let realpaths = 0;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    realpath: (async (path) => {
                        const result = await fs.realpath(path);
                        realpaths += 1;
                        if (realpaths === 2) {
                            await fs.writeFile(join(root, 'erden.lock'), serializeLockfile(lock), { mode: 0o644 });
                        }
                        return result;
                    }) as typeof fs.realpath,
                }),
            );
            await expect(Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }))).rejects.toMatchObject({
                code: 'PROJECT_LOCK_INVALID',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('never adopts a foreign lock which appears after an initially missing snapshot', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-adopt-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const base = makeNodeProjectLockFileSystemPort().operations;
            const foreign = 'foreign-lock\n';
            let injected = false;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    chmod: async (path, mode) => {
                        await base.chmod(path, mode);
                        if (!injected && String(path).includes('.stage-')) {
                            injected = true;
                            await fs.writeFile(join(root, 'erden.lock'), foreign, { flag: 'wx', mode: 0o644 });
                        }
                    },
                }),
            );
            await expect(
                Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock })),
            ).rejects.toMatchObject({ code: 'PROJECT_LOCK_ROLLBACK_UNSAFE' });
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(foreign);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('recognizes a completed publication and retires its authenticated backup residue', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-completed-'));
        try {
            const project = loadedProject(root);
            const desired = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const oldToolchain: LockToolchain = {
                validator: TOOLCHAIN.validator,
                reasoner: { version: '1.0.1', sha256: digest('c') },
            };
            await fs.writeFile(join(root, 'erden.lock'), serializeLockfile(desired), { mode: 0o644 });
            await fs.writeFile(
                join(root, '.erden.lock.backup-0123456789abcdef'),
                serializeLockfile(makeEmptyLockfile(project.manifest, oldToolchain)),
                { mode: 0o644 },
            );
            const service = makeProjectLockService(makeNodeProjectLockFileSystemPort());
            await expect(
                Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock: desired })),
            ).resolves.toMatchObject({ status: 'hit', cleanup: 'clean' });
            expect(await fs.readdir(root)).toEqual(['erden.lock']);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('rejects a same-byte foreign final inode substituted during backup retirement', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-cleanup-race-'));
        try {
            const project = loadedProject(root);
            const desired = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const oldToolchain: LockToolchain = {
                validator: TOOLCHAIN.validator,
                reasoner: { version: '1.0.1', sha256: digest('c') },
            };
            await fs.writeFile(
                join(root, 'erden.lock'),
                serializeLockfile(makeEmptyLockfile(project.manifest, oldToolchain)),
                { mode: 0o644 },
            );
            const base = makeNodeProjectLockFileSystemPort().operations;
            let substituted = false;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    unlink: async (path) => {
                        await base.unlink(path);
                        if (!substituted && String(path).includes('.backup-')) {
                            substituted = true;
                            await fs.unlink(join(root, 'erden.lock'));
                            await fs.writeFile(join(root, 'erden.lock'), serializeLockfile(desired), { mode: 0o644 });
                        }
                    },
                }),
            );
            await expect(
                Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock: desired })),
            ).rejects.toMatchObject({ code: 'PROJECT_LOCK_ROLLBACK_UNSAFE' });
            expect(await fs.readFile(join(root, 'erden.lock'), 'utf8')).toBe(serializeLockfile(desired));
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('preserves an owned-name file which mutates between authenticated read and unlink', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-unlink-race-'));
        try {
            const project = loadedProject(root);
            const desired = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const oldToolchain: LockToolchain = {
                validator: TOOLCHAIN.validator,
                reasoner: { version: '1.0.1', sha256: digest('c') },
            };
            await fs.writeFile(
                join(root, 'erden.lock'),
                serializeLockfile(makeEmptyLockfile(project.manifest, oldToolchain)),
                { mode: 0o644 },
            );
            let backupLstats = 0;
            let mutated = false;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    lstat: (async (path) => {
                        if (
                            String(path).includes('.backup-') &&
                            (await fs.access(join(root, 'erden.lock')).then(
                                () => true,
                                () => false,
                            ))
                        ) {
                            backupLstats += 1;
                            if (!mutated && backupLstats >= 6) {
                                mutated = true;
                                const handle = await fs.open(path, 'r+');
                                try {
                                    await handle.write(new TextEncoder().encode('#'), 0, 1, 0);
                                } finally {
                                    await handle.close();
                                }
                            }
                        }
                        return await fs.lstat(path, { bigint: true });
                    }) as typeof fs.lstat,
                }),
            );
            const result = await Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock: desired }));
            expect(result).toMatchObject({ status: 'written', cleanup: 'cleanup-residue-retained' });
            expect(mutated).toBe(true);
            expect((await fs.readdir(root)).some((name) => name.includes('.backup-'))).toBe(true);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('rejects fixed and staged project dependency transaction residues', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-dependency-residue-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            await fs.writeFile(join(root, 'erden.lock'), serializeLockfile(lock), { mode: 0o644 });
            const service = makeProjectLockService(makeNodeProjectLockFileSystemPort());
            for (const name of [
                '.erden.dependencies.transaction.json',
                '.erden.dependencies.manifest.stage-0123456789abcdef',
                '.ERDEN.DEPENDENCIES.LOCK.BACKUP-0123456789ABCDEF',
            ]) {
                await fs.writeFile(join(root, name), '{}');
                await expect(
                    Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN })),
                ).rejects.toMatchObject({ code: 'PROJECT_LOCK_INVALID' });
                await fs.unlink(join(root, name));
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it.each(['missing', 'available', 'stale'] as const)(
        'rejects a dependency marker at the final %s inspect linearization point',
        async (status) => {
            const root = await fs.mkdtemp(join(tmpdir(), `erden-project-lock-final-${status}-`));
            try {
                const original = loadedProject(root);
                const lock = makeEmptyLockfile(original.manifest, TOOLCHAIN);
                if (status !== 'missing') {
                    await fs.writeFile(join(root, 'erden.lock'), serializeLockfile(lock), { mode: 0o644 });
                }
                const project =
                    status === 'stale'
                        ? Object.freeze({
                              ...original,
                              manifest: normalizeManifestV1({
                                  schemaVersion: 1,
                                  canonicalIri: 'https://example.test/changed-project',
                                  alias: '@example/changed-project',
                                  ownedIriPrefixes: ['https://example.test/changed-project#'],
                                  sources: { ontology: ['ontology.ttl'] },
                              }),
                          })
                        : original;
                const base = makeNodeProjectLockFileSystemPort().operations;
                let rootScans = 0;
                const injectAt = status === 'missing' ? 3 : 4;
                const service = makeProjectLockService(
                    makeNodeProjectLockFileSystemPort({
                        opendir: async (path, options) => {
                            if (String(path) === root && ++rootScans === injectAt) {
                                await fs.writeFile(join(root, '.erden.dependencies.transaction.json'), '{}');
                            }
                            return await base.opendir(path, options);
                        },
                    }),
                );
                await expect(
                    Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN })),
                ).rejects.toMatchObject({ code: 'PROJECT_LOCK_INVALID' });
                expect(
                    await fs.access(join(root, '.erden.dependencies.transaction.json')).then(
                        () => true,
                        () => false,
                    ),
                ).toBe(true);
            } finally {
                await fs.rm(root, { recursive: true, force: true });
            }
        },
    );

    it('rejects a dependency marker which appears during the final lock scan', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-dependency-race-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            await fs.writeFile(join(root, 'erden.lock'), serializeLockfile(lock), { mode: 0o644 });
            const base = makeNodeProjectLockFileSystemPort().operations;
            let scans = 0;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    opendir: async (path, options) => {
                        if (String(path) === root && ++scans === 3) {
                            await fs.writeFile(join(root, '.erden.dependencies.transaction.json'), '{}');
                        }
                        return await base.opendir(path, options);
                    },
                }),
            );
            await expect(Effect.runPromise(service.inspect({ project, toolchain: TOOLCHAIN }))).rejects.toMatchObject({
                code: 'PROJECT_LOCK_INVALID',
            });
            expect(scans).toBeGreaterThanOrEqual(3);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('stops a direct lock write when a dependency transaction begins during staging', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'erden-project-lock-dependency-write-race-'));
        try {
            const project = loadedProject(root);
            const lock = makeEmptyLockfile(project.manifest, TOOLCHAIN);
            const base = makeNodeProjectLockFileSystemPort().operations;
            let injected = false;
            const service = makeProjectLockService(
                makeNodeProjectLockFileSystemPort({
                    chmod: async (path, mode) => {
                        await base.chmod(path, mode);
                        if (!injected && String(path).includes('.erden.lock.stage-')) {
                            injected = true;
                            await fs.writeFile(join(root, '.erden.dependencies.transaction.json'), '{}');
                        }
                    },
                }),
            );
            await expect(
                Effect.runPromise(service.write({ project, toolchain: TOOLCHAIN, lock })),
            ).rejects.toMatchObject({ code: 'PROJECT_LOCK_INVALID' });
            expect(injected).toBe(true);
            expect(
                await fs.access(join(root, 'erden.lock')).then(
                    () => true,
                    () => false,
                ),
            ).toBe(false);
            expect((await fs.readdir(root)).filter((name) => name.startsWith('.erden.lock.'))).toEqual([]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
