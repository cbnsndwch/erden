import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    makeEmptyLockfile,
    normalizeManifestV1,
    serializeLockfile,
    serializeManifestV1,
    type LockToolchain,
    type ManifestSerializationFormat,
    type ManifestV1,
} from '@erden/contracts';

import {
    makeNodeProjectDependencyStateFileSystemPort,
    makeProjectDependencyStateService,
    type ProjectDependencyStateError,
} from '../src/index.js';

const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: '1'.repeat(64) }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: '2'.repeat(64) }),
});

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map(async (root) => {
            await fs.rm(root, { recursive: true, force: true });
        }),
    );
});

function manifest(overrides: Partial<ManifestV1> = {}): ManifestV1 {
    return normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/project',
        alias: '@example/project',
        ownedIriPrefixes: ['https://example.test/project#'],
        sources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
        citationRoots: {},
        dependencies: {},
        ...overrides,
    });
}

async function fixture(
    format: ManifestSerializationFormat = 'json',
    initial = manifest(),
    text?: string,
): Promise<
    Readonly<{
        readonly root: string;
        readonly filePath: string;
        readonly filename: string;
    }>
> {
    const root = await fs.mkdtemp(join(tmpdir(), 'erden-dependency-state-'));
    roots.push(root);
    const filename = `erden.config.${format}`;
    const filePath = join(root, filename);
    await fs.writeFile(filePath, text ?? serializeManifestV1(initial, format), { mode: 0o644 });
    await fs.writeFile(join(root, 'ontology.ttl'), '<urn:s> <urn:p> <urn:o> .\n', { mode: 0o644 });
    return Object.freeze({ root, filePath, filename });
}

describe('ProjectDependencyState', () => {
    it('publishes a missing canonical lock without changing preserved manifest bytes or identity', async () => {
        const project = await fixture();
        const service = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const beforeBytes = await fs.readFile(project.filePath);
        const before = await fs.stat(project.filePath, { bigint: true });
        const inspected = await Effect.runPromise(
            service.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        expect(inspected.lockInspection.status).toBe('missing');
        const lock = makeEmptyLockfile(inspected.project.manifest, TOOLCHAIN);
        const result = await Effect.runPromise(
            service.write({
                revision: inspected.revision,
                manifest: { kind: 'preserve' },
                lock,
            }),
        );
        const after = await fs.stat(project.filePath, { bigint: true });
        expect(result).toMatchObject({
            status: 'written',
            cleanup: 'clean',
            manifest: { status: 'preserved' },
            lock: { status: 'written' },
            state: { lockInspection: { status: 'available' } },
        });
        expect(await fs.readFile(project.filePath)).toEqual(beforeBytes);
        expect([after.dev, after.ino, after.mode, after.size, after.mtimeNs]).toEqual([
            before.dev,
            before.ino,
            before.mode,
            before.size,
            before.mtimeNs,
        ]);
        expect(await fs.readFile(join(project.root, 'erden.lock'), 'utf8')).toBe(serializeLockfile(lock));
        expect((await fs.readdir(project.root)).some((name) => name.startsWith('.erden.dependencies.'))).toBe(false);
        await expect(Effect.runPromise(service.recheck({ revision: result.state.revision }))).resolves.toBeUndefined();
    });

    it.each([
        ['json', 'json'],
        ['jsonc', 'jsonc'],
        ['yml', 'yml'],
        ['yaml', 'yaml'],
        ['toml', 'toml'],
    ] as const)('canonically replaces a %s manifest and its matching lock', async (extension, format) => {
        const initial = manifest();
        const project = await fixture(
            extension,
            initial,
            extension === 'jsonc'
                ? `// comment intentionally lost\n${serializeManifestV1(initial, 'jsonc')}`
                : undefined,
        );
        const service = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const first = await Effect.runPromise(
            service.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        const firstLock = makeEmptyLockfile(first.project.manifest, TOOLCHAIN);
        const withLock = await Effect.runPromise(
            service.write({
                revision: first.revision,
                manifest: { kind: 'preserve' },
                lock: firstLock,
            }),
        );
        const replacement = manifest({ title: 'Canonical replacement' });
        const replacementLock = makeEmptyLockfile(replacement, TOOLCHAIN);
        const replaced = await Effect.runPromise(
            service.write({
                revision: withLock.state.revision,
                manifest: { kind: 'replace', manifest: replacement },
                lock: replacementLock,
            }),
        );
        expect(replaced).toMatchObject({ status: 'written', manifest: { status: 'written' } });
        expect(await fs.readFile(project.filePath, 'utf8')).toBe(serializeManifestV1(replacement, format));
        expect(await fs.readFile(project.filePath, 'utf8')).not.toContain('// comment intentionally lost');
    });

    it('returns an exact hit and preserves both canonical file identities', async () => {
        const project = await fixture();
        const service = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const missing = await Effect.runPromise(
            service.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        const lock = makeEmptyLockfile(missing.project.manifest, TOOLCHAIN);
        const written = await Effect.runPromise(
            service.write({ revision: missing.revision, manifest: { kind: 'preserve' }, lock }),
        );
        const beforeManifest = await fs.stat(project.filePath, { bigint: true });
        const beforeLock = await fs.stat(join(project.root, 'erden.lock'), { bigint: true });
        const hit = await Effect.runPromise(
            service.write({ revision: written.state.revision, manifest: { kind: 'preserve' }, lock }),
        );
        expect(hit).toMatchObject({ status: 'hit', manifest: { status: 'preserved' }, lock: { status: 'hit' } });
        const afterManifest = await fs.stat(project.filePath, { bigint: true });
        const afterLock = await fs.stat(join(project.root, 'erden.lock'), { bigint: true });
        expect([afterManifest.dev, afterManifest.ino, afterManifest.mtimeNs]).toEqual([
            beforeManifest.dev,
            beforeManifest.ino,
            beforeManifest.mtimeNs,
        ]);
        expect([afterLock.dev, afterLock.ino, afterLock.mtimeNs]).toEqual([
            beforeLock.dev,
            beforeLock.ino,
            beforeLock.mtimeNs,
        ]);
    });

    it('invalidates a pre-transaction revision after a complete dependency-state commit', async () => {
        const project = await fixture();
        const service = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        const old = await Effect.runPromise(service.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }));
        await Effect.runPromise(
            service.write({
                revision: old.revision,
                manifest: { kind: 'preserve' },
                lock: makeEmptyLockfile(old.project.manifest, TOOLCHAIN),
            }),
        );
        await expect(Effect.runPromise(service.recheck({ revision: old.revision }))).rejects.toMatchObject({
            code: 'PROJECT_DEPENDENCY_STATE_STALE_REVISION',
        });
    });

    it('rejects lifecycle residues, portable aliases, and hostile revision inputs path-free', async () => {
        const project = await fixture();
        const service = makeProjectDependencyStateService(makeNodeProjectDependencyStateFileSystemPort());
        await fs.writeFile(join(project.root, '.ERDEN.DEPENDENCIES.TRANSACTION.JSON'), '{}');
        await expect(
            Effect.runPromise(service.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT' });
        await fs.unlink(join(project.root, '.ERDEN.DEPENDENCIES.TRANSACTION.JSON'));
        const inspected = await Effect.runPromise(
            service.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        const hostile = new Proxy(
            {},
            {
                getPrototypeOf: () => {
                    throw new Error('C:/private/revision');
                },
            },
        );
        let failure: ProjectDependencyStateError | undefined;
        try {
            await Effect.runPromise(
                service.write({
                    revision: hostile as never,
                    manifest: { kind: 'preserve' },
                    lock: makeEmptyLockfile(inspected.project.manifest, TOOLCHAIN),
                }),
            );
        } catch (cause) {
            failure = cause as ProjectDependencyStateError;
        }
        expect(failure?.code).toBe('PROJECT_DEPENDENCY_STATE_INVALID_INPUT');
        expect(failure?.message).not.toContain('private');
        expect(Object.keys(failure ?? {})).not.toContain('cause');
    });

    it.each(['missing', 'available', 'stale'] as const)(
        'rejects a lifecycle marker at the final %s state-inspection linearization point',
        async (status) => {
            const project = await fixture();
            if (status !== 'missing') {
                const lockManifest =
                    status === 'available'
                        ? manifest()
                        : manifest({
                              canonicalIri: 'https://example.test/stale-project',
                              alias: '@example/stale-project',
                              ownedIriPrefixes: ['https://example.test/stale-project#'],
                          });
                await fs.writeFile(
                    join(project.root, 'erden.lock'),
                    serializeLockfile(makeEmptyLockfile(lockManifest, TOOLCHAIN)),
                    { mode: 0o644 },
                );
            }
            const base = makeNodeProjectDependencyStateFileSystemPort().operations;
            let rootScans = 0;
            const injectAt = status === 'missing' ? 8 : 7;
            const service = makeProjectDependencyStateService(
                makeNodeProjectDependencyStateFileSystemPort({
                    opendir: async (path, options) => {
                        if (String(path) === project.root && ++rootScans === injectAt) {
                            await fs.writeFile(join(project.root, '.erden.dependencies.transaction.json'), '{}');
                        }
                        return await base.opendir(path, options);
                    },
                }),
            );
            await expect(
                Effect.runPromise(service.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN })),
            ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT' });
            expect(
                await fs.access(join(project.root, '.erden.dependencies.transaction.json')).then(
                    () => true,
                    () => false,
                ),
            ).toBe(true);
        },
    );

    it('restores the exact old pair when manifest publication fails after lock publication', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const base = makeProjectDependencyStateService(basePort);
        const missing = await Effect.runPromise(base.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }));
        const oldLock = makeEmptyLockfile(missing.project.manifest, TOOLCHAIN);
        const initial = await Effect.runPromise(
            base.write({ revision: missing.revision, manifest: { kind: 'preserve' }, lock: oldLock }),
        );
        const oldManifestBytes = await fs.readFile(project.filePath);
        const oldLockBytes = await fs.readFile(join(project.root, 'erden.lock'));
        const replacement = manifest({ title: 'must roll back' });
        const replacementLock = makeEmptyLockfile(replacement, TOOLCHAIN);
        const failing = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                link: async (oldPath, newPath) => {
                    if (String(oldPath).includes('.manifest.stage-') && String(newPath) === project.filePath) {
                        const error = new Error('injected publication failure') as NodeJS.ErrnoException;
                        error.code = 'EIO';
                        throw error;
                    }
                    await basePort.operations.link(oldPath, newPath);
                },
            }),
        );
        await expect(
            Effect.runPromise(
                failing.write({
                    revision: initial.state.revision,
                    manifest: { kind: 'replace', manifest: replacement },
                    lock: replacementLock,
                }),
            ),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_IO_FAILURE' });
        expect(await fs.readFile(project.filePath)).toEqual(oldManifestBytes);
        expect(await fs.readFile(join(project.root, 'erden.lock'))).toEqual(oldLockBytes);
        expect((await fs.readdir(project.root)).some((name) => name.startsWith('.erden.dependencies.'))).toBe(false);
    });

    it('retains the marker when the restored lock mutates during rollback cleanup', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const clean = makeProjectDependencyStateService(basePort);
        const missing = await Effect.runPromise(
            clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        const initial = await Effect.runPromise(
            clean.write({
                revision: missing.revision,
                manifest: { kind: 'preserve' },
                lock: makeEmptyLockfile(missing.project.manifest, TOOLCHAIN),
            }),
        );
        const replacement = manifest({ title: 'rollback mutation' });
        let mutated = false;
        const failing = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                link: async (oldPath, newPath) => {
                    if (String(oldPath).includes('.manifest.stage-') && String(newPath) === project.filePath) {
                        const error = new Error('force rollback after lock publication') as NodeJS.ErrnoException;
                        error.code = 'EIO';
                        throw error;
                    }
                    await basePort.operations.link(oldPath, newPath);
                },
                unlink: async (path) => {
                    await basePort.operations.unlink(path);
                    if (!mutated && String(path).includes('.marker.stage-')) {
                        mutated = true;
                        const handle = await fs.open(join(project.root, 'erden.lock'), 'r+');
                        try {
                            await handle.write(new TextEncoder().encode('#'), 0, 1, 0);
                        } finally {
                            await handle.close();
                        }
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                failing.write({
                    revision: initial.state.revision,
                    manifest: { kind: 'replace', manifest: replacement },
                    lock: makeEmptyLockfile(replacement, TOOLCHAIN),
                }),
            ),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE' });
        expect(mutated).toBe(true);
        expect(
            await fs.access(join(project.root, '.erden.dependencies.transaction.json')).then(
                () => true,
                () => false,
            ),
        ).toBe(true);
    });

    it('retains unauthenticated create-then-throw stage evidence as rollback-unsafe', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const clean = makeProjectDependencyStateService(basePort);
        const inspected = await Effect.runPromise(
            clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        let injected = false;
        const failing = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                open: async (path, flags, mode) => {
                    if (!injected && String(path).includes('.manifest.stage-')) {
                        injected = true;
                        const handle = await basePort.operations.open(path, flags, mode);
                        await handle.close();
                        const error = new Error('C:/private/create-then-throw') as NodeJS.ErrnoException;
                        error.code = 'EIO';
                        throw error;
                    }
                    return await basePort.operations.open(path, flags, mode);
                },
            }),
        );
        await expect(
            Effect.runPromise(
                failing.write({
                    revision: inspected.revision,
                    manifest: { kind: 'preserve' },
                    lock: makeEmptyLockfile(inspected.project.manifest, TOOLCHAIN),
                }),
            ),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE' });
        expect((await fs.readdir(project.root)).filter((name) => name.includes('.manifest.stage-'))).toHaveLength(1);
        await expect(
            Effect.runPromise(clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_TRANSACTION_PRESENT' });
    });

    it('reconciles active-marker unlink-then-throw as one committed new state', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const clean = makeProjectDependencyStateService(basePort);
        const inspected = await Effect.runPromise(
            clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        let injected = false;
        const service = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                unlink: async (path) => {
                    await basePort.operations.unlink(path);
                    if (!injected && String(path).endsWith('.erden.dependencies.transaction.json')) {
                        injected = true;
                        const error = new Error('marker unlink reported failure') as NodeJS.ErrnoException;
                        error.code = 'EIO';
                        throw error;
                    }
                },
            }),
        );
        const result = await Effect.runPromise(
            service.write({
                revision: inspected.revision,
                manifest: { kind: 'preserve' },
                lock: makeEmptyLockfile(inspected.project.manifest, TOOLCHAIN),
            }),
        );
        expect(result).toMatchObject({ status: 'written', cleanup: 'clean' });
        expect(injected).toBe(true);
        expect((await fs.readdir(project.root)).some((name) => name.startsWith('.erden.dependencies.'))).toBe(false);
    });

    it('recovers an authenticated interrupted rollback before another writer proceeds', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const clean = makeProjectDependencyStateService(basePort);
        const missing = await Effect.runPromise(
            clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        const oldLock = makeEmptyLockfile(missing.project.manifest, TOOLCHAIN);
        const initial = await Effect.runPromise(
            clean.write({ revision: missing.revision, manifest: { kind: 'preserve' }, lock: oldLock }),
        );
        const oldManifest = await fs.readFile(project.filePath);
        let backupFailures = 0;
        const failing = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                unlink: async (path) => {
                    if (String(path).includes('.manifest.backup-')) {
                        backupFailures += 1;
                        const error = new Error('backup retirement unavailable') as NodeJS.ErrnoException;
                        error.code = 'EACCES';
                        throw error;
                    }
                    await basePort.operations.unlink(path);
                },
            }),
        );
        const replacement = manifest({ title: 'interrupted replacement' });
        await expect(
            Effect.runPromise(
                failing.write({
                    revision: initial.state.revision,
                    manifest: { kind: 'replace', manifest: replacement },
                    lock: makeEmptyLockfile(replacement, TOOLCHAIN),
                }),
            ),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE' });
        expect(backupFailures).toBeGreaterThan(0);
        expect(await fs.readdir(project.root)).toContain('.erden.dependencies.transaction.json');
        const recovered = await Effect.runPromise(clean.recover({ projectRoot: project.root, toolchain: TOOLCHAIN }));
        expect(recovered.lockInspection.status).toBe('available');
        expect(await fs.readFile(project.filePath)).toEqual(oldManifest);
        expect((await fs.readdir(project.root)).some((name) => name.startsWith('.erden.dependencies.'))).toBe(false);
    });

    it('retains recovery evidence when a lock arrives during lock-free rollback cleanup', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const clean = makeProjectDependencyStateService(basePort);
        const missing = await Effect.runPromise(
            clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        const interrupted = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                unlink: async (path) => {
                    if (String(path).includes('.manifest.backup-')) {
                        const error = new Error('leave authenticated recovery evidence') as NodeJS.ErrnoException;
                        error.code = 'EACCES';
                        throw error;
                    }
                    await basePort.operations.unlink(path);
                },
            }),
        );
        await expect(
            Effect.runPromise(
                interrupted.write({
                    revision: missing.revision,
                    manifest: { kind: 'preserve' },
                    lock: makeEmptyLockfile(missing.project.manifest, TOOLCHAIN),
                }),
            ),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE' });
        expect(
            await fs.access(join(project.root, '.erden.dependencies.transaction.json')).then(
                () => true,
                () => false,
            ),
        ).toBe(true);

        let arrived = false;
        const recovering = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                unlink: async (path) => {
                    await basePort.operations.unlink(path);
                    if (!arrived && String(path).includes('.marker.stage-')) {
                        arrived = true;
                        await fs.writeFile(join(project.root, 'erden.lock'), 'foreign-lock\n', {
                            flag: 'wx',
                            mode: 0o644,
                        });
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(recovering.recover({ projectRoot: project.root, toolchain: TOOLCHAIN })),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE' });
        expect(arrived).toBe(true);
        expect(await fs.readFile(join(project.root, 'erden.lock'), 'utf8')).toBe('foreign-lock\n');
        expect(
            await fs.access(join(project.root, '.erden.dependencies.transaction.json')).then(
                () => true,
                () => false,
            ),
        ).toBe(true);
    });

    it('interrupts after fixed-marker publication and restores the complete old state', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const clean = makeProjectDependencyStateService(basePort);
        const inspected = await Effect.runPromise(
            clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let markerPublished!: () => void;
        const published = new Promise<void>((resolve) => {
            markerPublished = resolve;
        });
        const service = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                link: async (oldPath, newPath) => {
                    await basePort.operations.link(oldPath, newPath);
                    if (String(newPath).endsWith('.erden.dependencies.transaction.json')) {
                        markerPublished();
                        await held;
                    }
                },
            }),
        );
        const fiber = Effect.runFork(
            service.write({
                revision: inspected.revision,
                manifest: { kind: 'preserve' },
                lock: makeEmptyLockfile(inspected.project.manifest, TOOLCHAIN),
            }),
        );
        await published;
        const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
        release();
        await interrupted;
        expect(
            await fs.access(join(project.root, 'erden.lock')).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
        expect((await fs.readdir(project.root)).some((name) => name.startsWith('.erden.dependencies.'))).toBe(false);
        await expect(Effect.runPromise(clean.recheck({ revision: inspected.revision }))).resolves.toBeUndefined();
    });

    it('fails rollback-unsafe and preserves evidence when the active marker changes portable spelling', async () => {
        const project = await fixture();
        const basePort = makeNodeProjectDependencyStateFileSystemPort();
        const clean = makeProjectDependencyStateService(basePort);
        const inspected = await Effect.runPromise(
            clean.inspect({ explicitPath: project.filePath, toolchain: TOOLCHAIN }),
        );
        let substituted = false;
        const service = makeProjectDependencyStateService(
            makeNodeProjectDependencyStateFileSystemPort({
                link: async (oldPath, newPath) => {
                    await basePort.operations.link(oldPath, newPath);
                    if (!substituted && String(newPath).includes('.manifest.backup-')) {
                        substituted = true;
                        await fs.rename(
                            join(project.root, '.erden.dependencies.transaction.json'),
                            join(project.root, '.ERDEN.DEPENDENCIES.TRANSACTION.JSON'),
                        );
                    }
                },
            }),
        );
        await expect(
            Effect.runPromise(
                service.write({
                    revision: inspected.revision,
                    manifest: { kind: 'preserve' },
                    lock: makeEmptyLockfile(inspected.project.manifest, TOOLCHAIN),
                }),
            ),
        ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_ROLLBACK_UNSAFE' });
        expect(substituted).toBe(true);
        expect(
            await fs.access(join(project.root, '.ERDEN.DEPENDENCIES.TRANSACTION.JSON')).then(
                () => true,
                () => false,
            ),
        ).toBe(true);
        expect(
            await fs.access(join(project.root, 'erden.lock')).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
    });

    it.each(['zero-write', 'mode-noop', 'invalid-token'] as const)(
        'cleans an authenticated pre-marker failure: %s',
        async (failure) => {
            const project = await fixture();
            const basePort = makeNodeProjectDependencyStateFileSystemPort();
            const inspected = await Effect.runPromise(
                makeProjectDependencyStateService(basePort).inspect({
                    explicitPath: project.filePath,
                    toolchain: TOOLCHAIN,
                }),
            );
            const service = makeProjectDependencyStateService(
                makeNodeProjectDependencyStateFileSystemPort({
                    ...(failure === 'zero-write' ? { write: () => Promise.resolve({ bytesWritten: 0 }) } : {}),
                    ...(failure === 'mode-noop' ? { enforcePosixModes: true, chmod: () => Promise.resolve() } : {}),
                    ...(failure === 'invalid-token' ? { token: () => '../unsafe' } : {}),
                }),
            );
            await expect(
                Effect.runPromise(
                    service.write({
                        revision: inspected.revision,
                        manifest: { kind: 'preserve' },
                        lock: makeEmptyLockfile(inspected.project.manifest, TOOLCHAIN),
                    }),
                ),
            ).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_STATE_IO_FAILURE' });
            expect((await fs.readdir(project.root)).some((name) => name.startsWith('.erden.dependencies.'))).toBe(
                false,
            );
            expect(
                await fs.access(join(project.root, 'erden.lock')).then(
                    () => true,
                    () => false,
                ),
            ).toBe(false);
        },
    );
});
