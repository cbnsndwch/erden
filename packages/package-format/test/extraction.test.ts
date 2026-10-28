import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    encodePackage,
    extractPackageArchive,
    GENERATED_MANIFEST_PATH,
    makeNodePackageExtractionOperations,
    PackageCodecError,
    type PackageCodecErrorCode,
    type PackageEncodeInput,
} from '../src/index.js';

import { MALICIOUS_ARCHIVES } from './fixtures.js';

const roots: string[] = [];
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const INPUT: PackageEncodeInput = {
    canonicalIri: 'https://example.test/layers/extraction',
    version: '1.0.0',
    dependencies: [],
    validator: { version: '1.0.0', sha256: HASH_A },
    reasoner: { version: '1.0.0', sha256: HASH_B },
    files: [
        { path: 'ontology/data.ttl', bytes: '<urn:s> <urn:p> <urn:o> .\n', executable: false },
        { path: 'scripts/check.sh', bytes: '#!/bin/sh\nexit 0\n', executable: true },
    ],
};

const SPECIAL_MODE_CASES: ReadonlyArray<readonly [string, (path: string, destination: string) => boolean, number]> = [
    ['target directory', (path, destination) => path === destination, 0o1000],
    ['plain file', (path) => path.endsWith('data.ttl'), 0o2000],
    ['executable file', (path) => path.endsWith('check.sh'), 0o4000],
    ['generated manifest', (path) => path.includes('.erden-manifest-'), 0o1000],
];

async function root(): Promise<string> {
    const path = await fs.mkdtemp(join(tmpdir(), 'erden-package-extraction-'));
    roots.push(path);
    return path;
}

afterEach(async () => {
    for (const path of roots.splice(0)) {
        await fs.rm(path, { recursive: true, force: true });
    }
});

async function expectExtractionError(
    effect: Effect.Effect<unknown, PackageCodecError>,
    code: PackageCodecErrorCode,
): Promise<PackageCodecError> {
    try {
        await Effect.runPromise(effect);
        throw new Error(`Expected ${code}`);
    } catch (error) {
        if (!(error instanceof PackageCodecError)) {
            throw error;
        }
        expect(error.code).toBe(code);
        expect(Object.keys(error)).not.toContain('cause');
        return error;
    }
}

describe('transactional package extraction', () => {
    it('streams a validated package into an exact published tree', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const encoded = encodePackage(INPUT);
        const result = await Effect.runPromise(extractPackageArchive(encoded.archiveBytes, { destination }));
        expect(result.archiveSha256).toBe(encoded.archiveSha256);
        expect(await fs.readFile(join(destination, 'ontology', 'data.ttl'), 'utf8')).toBe(
            '<urn:s> <urn:p> <urn:o> .\n',
        );
        expect(await fs.readFile(join(destination, 'scripts', 'check.sh'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
        expect(await fs.readFile(join(destination, ...GENERATED_MANIFEST_PATH.split('/')))).toEqual(
            Buffer.from(encoded.manifestBytes),
        );
        expect((await fs.readdir(parent)).sort()).toEqual(['installed']);
        expect(JSON.stringify(result)).not.toContain(parent);
        if (process.platform !== 'win32') {
            expect((await fs.lstat(destination)).mode & 0o777).toBe(0o755);
            expect((await fs.lstat(join(destination, 'ontology', 'data.ttl'))).mode & 0o777).toBe(0o644);
            expect((await fs.lstat(join(destination, 'scripts', 'check.sh'))).mode & 0o777).toBe(0o755);
        }
    });

    it('leaves no destination or staging residue for every malicious oracle fixture', async () => {
        const codes: Readonly<Record<keyof typeof MALICIOUS_ARCHIVES, PackageCodecErrorCode>> = {
            traversal: 'traversal-path',
            absolute: 'archive-root',
            drive: 'drive-path',
            symlink: 'link-entry',
            hardlink: 'link-entry',
            duplicate: 'duplicate-path',
            caseConflict: 'case-conflict',
            fileDescendantConflict: 'conflicting-path',
            device: 'device-entry',
            fifo: 'device-entry',
            pax: 'unsupported-entry',
            oversizedEntry: 'missing-manifest',
            tooManyEntries: 'missing-manifest',
            tooDeep: 'missing-manifest',
            missingManifest: 'missing-manifest',
            unsupportedVersion: 'unsupported-version',
            decompressionBomb: 'limit-compression-ratio',
        };
        for (const [name, archive] of Object.entries(MALICIOUS_ARCHIVES)) {
            const parent = await root();
            const destination = join(parent, 'installed');
            await expectExtractionError(
                extractPackageArchive(archive, { destination }),
                codes[name as keyof typeof MALICIOUS_ARCHIVES],
            );
            expect(await fs.readdir(parent), name).toEqual([]);
        }
    });

    it('refuses exact and portable-equivalent existing destinations before reading', async () => {
        const encoded = encodePackage(INPUT);
        for (const existingName of ['installed', 'INSTALLED']) {
            const parent = await root();
            await fs.mkdir(join(parent, existingName));
            let reads = 0;
            const source = (async function* (): AsyncIterable<Uint8Array> {
                reads += 1;
                yield await Promise.resolve(encoded.archiveBytes);
            })();
            await expectExtractionError(
                extractPackageArchive(source, { destination: join(parent, 'installed') }),
                'destination-conflict',
            );
            expect(reads).toBe(0);
            expect(await fs.readdir(parent)).toEqual([existingName]);
        }
    });

    it.each([
        ['case staging', 'installed', (token: string) => `.INSTALLED.ERDEN-EXTRACT-${token.toUpperCase()}`],
        ['case manifest', 'installed', (token: string) => `.INSTALLED.ERDEN-MANIFEST-${token.toUpperCase()}`],
        ['NFC staging', 'caf\u00e9', (token: string) => `.cafe\u0301.erden-extract-${token}`],
        ['NFC manifest', 'caf\u00e9', (token: string) => `.cafe\u0301.erden-manifest-${token}`],
    ] as const)('refuses a preexisting %s transaction-name alias before reading', async (_name, targetName, alias) => {
        const parent = await root();
        const token = '11111111-1111-4111-8111-111111111111';
        await fs.writeFile(join(parent, alias(token)), 'foreign');
        let reads = 0;
        const source = (async function* (): AsyncIterable<Uint8Array> {
            reads += 1;
            yield await Promise.resolve(encodePackage(INPUT).archiveBytes);
        })();
        const operations = makeNodePackageExtractionOperations({ token: () => token });
        await expectExtractionError(
            extractPackageArchive(source, { destination: join(parent, targetName) }, operations),
            'destination-conflict',
        );
        expect(reads).toBe(0);
        expect(await fs.readFile(join(parent, alias(token)), 'utf8')).toBe('foreign');
    });

    it('rolls back a support-file rename failure without recursive deletion', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let renames = 0;
        const operations = makeNodePackageExtractionOperations({
            rename: async (from, to) => {
                renames += 1;
                if (renames === 1) {
                    throw new Error('D:/physical-secret/rename');
                }
                await base.rename(from, to);
            },
        });
        const error = await expectExtractionError(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            'extraction-io',
        );
        expect(error.message).not.toContain('physical-secret');
        expect(await fs.readdir(parent)).toEqual([]);
    });

    it('rolls back an actual partial write and closes the source iterator', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let failed = false;
        let returned = false;
        const operations = makeNodePackageExtractionOperations({
            write: async (handle, buffer, offset, length) => {
                if (!failed && length > 1) {
                    failed = true;
                    await base.write(handle, buffer, offset, Math.floor(length / 2));
                    throw new Error('D:/physical-secret/partial-write');
                }
                return await base.write(handle, buffer, offset, length);
            },
        });
        const archive = encodePackage(INPUT).archiveBytes;
        const source: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]() {
                const iterator = (async function* (): AsyncIterable<Uint8Array> {
                    yield await Promise.resolve(archive);
                })()[Symbol.asyncIterator]();
                return {
                    next: () => iterator.next(),
                    return: async () => {
                        returned = true;
                        return (await iterator.return?.()) ?? { done: true, value: undefined };
                    },
                };
            },
        };
        const error = await expectExtractionError(
            extractPackageArchive(source, { destination }, operations),
            'extraction-io',
        );
        expect(error.message).not.toContain('physical-secret');
        expect(returned).toBe(true);
        expect(await fs.readdir(parent)).toEqual([]);
    });

    it.each(['sync', 'close', 'chmod'] as const)('cleans the manifest temp when final %s fails', async (failure) => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let syncs = 0;
        let closes = 0;
        let chmods = 0;
        const operations = makeNodePackageExtractionOperations({
            sync: async (handle) => {
                syncs += 1;
                if (failure === 'sync' && syncs === 1) {
                    throw new Error('sync failure');
                }
                await base.sync(handle);
            },
            close: async (handle) => {
                closes += 1;
                await base.close(handle);
                if (failure === 'close' && closes === 1) {
                    throw new Error('close failure');
                }
            },
            chmod: async (path, mode) => {
                chmods += 1;
                if (failure === 'chmod' && chmods === 3) {
                    throw new Error('chmod failure');
                }
                await base.chmod(path, mode);
            },
        });
        await expectExtractionError(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            'extraction-io',
        );
        expect(await fs.readdir(parent)).toEqual([]);
    });

    it.each([
        ['staging root', 'staging-root'],
        ['staging nested directory', 'staging-nested'],
        ['target root', 'target-root'],
        ['target nested directory', 'target-nested'],
    ] as const)('tracks a %s before a pre-change or move-then-throw chmod failure', async (_label, phase) => {
        for (const moveThenThrow of [false, true]) {
            const parent = await root();
            const destination = join(parent, 'installed');
            const base = makeNodePackageExtractionOperations();
            let selectedPath: string | undefined;
            let failed = false;
            const operations = makeNodePackageExtractionOperations({
                mkdir: async (path, options) => {
                    await base.mkdir(path, options);
                    const created = String(path);
                    if (
                        (phase === 'staging-root' && created.includes('.erden-extract-')) ||
                        (phase === 'staging-nested' &&
                            created.includes('.erden-extract-') &&
                            created.endsWith('ontology')) ||
                        (phase === 'target-root' && created === destination) ||
                        (phase === 'target-nested' && created === join(destination, 'ontology'))
                    ) {
                        selectedPath = created;
                    }
                },
                chmod: async (path, mode) => {
                    if (!failed && String(path) === selectedPath) {
                        failed = true;
                        if (moveThenThrow) {
                            await base.chmod(path, mode);
                        }
                        throw new Error('directory chmod failure');
                    }
                    await base.chmod(path, mode);
                },
            });
            await expectExtractionError(
                extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
                'extraction-io',
            );
            expect(failed).toBe(true);
            expect(await fs.readdir(parent)).toEqual([]);
        }
    });

    it.each([
        ['staging root', 'staging-root'],
        ['staging nested directory', 'staging-nested'],
        ['target root', 'target-root'],
        ['target nested directory', 'target-nested'],
    ] as const)(
        'leaves an inert result and reports rollback unsafe when %s identity capture fails',
        async (_label, phase) => {
            const parent = await root();
            const destination = join(parent, 'installed');
            const base = makeNodePackageExtractionOperations();
            let selectedPath: string | undefined;
            let failed = false;
            const lstat = new Proxy(base.lstat, {
                apply(target, thisArgument, argumentsList) {
                    if (!failed && String(argumentsList[0]) === selectedPath) {
                        failed = true;
                        return Promise.reject(new Error('identity capture failure'));
                    }
                    const result: unknown = Reflect.apply(target, thisArgument, argumentsList);
                    return result;
                },
            });
            const operations = makeNodePackageExtractionOperations({
                mkdir: async (path, options) => {
                    await base.mkdir(path, options);
                    const created = String(path);
                    if (
                        (phase === 'staging-root' && created.includes('.erden-extract-')) ||
                        (phase === 'staging-nested' &&
                            created.includes('.erden-extract-') &&
                            created.endsWith('ontology')) ||
                        (phase === 'target-root' && created === destination) ||
                        (phase === 'target-nested' && created === join(destination, 'ontology'))
                    ) {
                        selectedPath = created;
                    }
                },
                lstat,
            });
            await expectExtractionError(
                extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
                'extraction-rollback-unsafe',
            );
            expect(failed).toBe(true);
            expect(await fs.readdir(parent)).not.toEqual([]);
            await expect(fs.lstat(join(destination, ...GENERATED_MANIFEST_PATH.split('/')))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        },
    );

    it.each([
        ['staging directory creation', 'staging'],
        ['target directory creation', 'target'],
        ['manifest temporary-file creation', 'manifest'],
    ] as const)('reports rollback unsafe when %s creates and then rejects', async (_label, phase) => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let injected = false;
        const operations = makeNodePackageExtractionOperations({
            mkdir: async (path, options) => {
                await base.mkdir(path, options);
                const created = String(path);
                if (
                    !injected &&
                    ((phase === 'staging' && created.includes('.erden-extract-')) ||
                        (phase === 'target' && created === destination))
                ) {
                    injected = true;
                    throw new Error('mkdir created and rejected');
                }
            },
            open: async (path, flags, mode) => {
                const handle = await base.open(path, flags, mode);
                if (!injected && phase === 'manifest' && String(path).includes('.erden-manifest-')) {
                    injected = true;
                    await base.close(handle);
                    throw new Error('open created and rejected');
                }
                return handle;
            },
        });
        await expectExtractionError(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            'extraction-rollback-unsafe',
        );
        expect(injected).toBe(true);
        expect(await fs.readdir(parent)).not.toEqual([]);
        await expect(fs.lstat(join(destination, ...GENERATED_MANIFEST_PATH.split('/')))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it.each(SPECIAL_MODE_CASES)('rejects POSIX special bits on a %s', async (_label, selected, specialBit) => {
        if (process.platform === 'win32') {
            return;
        }
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let injected = false;
        const operations = makeNodePackageExtractionOperations({
            chmod: async (path, mode) => {
                if (!injected && selected(String(path), destination)) {
                    injected = true;
                    if (typeof mode !== 'number') {
                        throw new Error('Expected a numeric package mode');
                    }
                    await base.chmod(path, mode | specialBit);
                    return;
                }
                await base.chmod(path, mode);
            },
        });
        await expectExtractionError(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            'extraction-io',
        );
        expect(injected).toBe(true);
        expect(await fs.readdir(parent)).toEqual([]);
    });

    it('fails closed when chmod does not establish the required POSIX mode', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const operations = makeNodePackageExtractionOperations({
            chmod: async () => {
                await Promise.resolve();
            },
            enforcePosixModes: true,
        });
        await expectExtractionError(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            'extraction-io',
        );
        expect(await fs.readdir(parent)).toEqual([]);
    });

    it('overrides a restrictive POSIX umask with exact published modes', async () => {
        if (process.platform === 'win32') {
            return;
        }
        const parent = await root();
        const destination = join(parent, 'installed');
        const previous = process.umask(0o077);
        try {
            await Effect.runPromise(extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }));
        } finally {
            process.umask(previous);
        }
        expect((await fs.lstat(destination)).mode & 0o777).toBe(0o755);
        expect((await fs.lstat(join(destination, '.erden'))).mode & 0o777).toBe(0o755);
        expect((await fs.lstat(join(destination, 'ontology', 'data.ttl'))).mode & 0o777).toBe(0o644);
        expect((await fs.lstat(join(destination, 'scripts', 'check.sh'))).mode & 0o777).toBe(0o755);
    });

    it('recognizes manifest move-then-throw as a complete publication', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        const operations = makeNodePackageExtractionOperations({
            rename: async (from, to) => {
                await base.rename(from, to);
                if (String(to).endsWith('package-manifest.json')) {
                    throw new Error('post-move');
                }
            },
        });
        const result = await Effect.runPromise(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
        );
        expect(result.manifest.canonicalIri).toBe(INPUT.canonicalIri);
        expect(await fs.readFile(join(destination, ...GENERATED_MANIFEST_PATH.split('/')), 'utf8')).toContain(
            INPUT.canonicalIri,
        );
        expect(await fs.readdir(parent)).toEqual(['installed']);
    });

    it('leaves an inert no-manifest destination when a foreign entry races publication', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let injected = false;
        const operations = makeNodePackageExtractionOperations({
            rename: async (from, to) => {
                await base.rename(from, to);
                if (!injected && String(to).endsWith('check.sh')) {
                    injected = true;
                    await fs.writeFile(join(destination, 'foreign.txt'), 'foreign');
                }
            },
        });
        await expectExtractionError(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            'extraction-rollback-unsafe',
        );
        expect(await fs.readFile(join(destination, 'foreign.txt'), 'utf8')).toBe('foreign');
        await expect(fs.lstat(join(destination, ...GENERATED_MANIFEST_PATH.split('/')))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it.each([
        ['root', (destination: string) => join(destination, 'foreign.txt')],
        ['nested', (destination: string) => join(destination, 'ontology', 'foreign.txt')],
    ] as const)('rechecks exact %s closure after final support hashing', async (_label, foreignPath) => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let targetReads = 0;
        const operations = makeNodePackageExtractionOperations({
            open: async (path, flags, mode) => {
                const handle = await base.open(path, flags, mode);
                if (String(path) === join(destination, 'ontology', 'data.ttl') && flags === 'r') {
                    targetReads += 1;
                    if (targetReads === 2) {
                        await fs.writeFile(foreignPath(destination), 'foreign');
                    }
                }
                return handle;
            },
        });
        await expectExtractionError(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            'extraction-rollback-unsafe',
        );
        expect(targetReads).toBeGreaterThanOrEqual(2);
        expect(await fs.readFile(foreignPath(destination), 'utf8')).toBe('foreign');
        await expect(fs.lstat(join(destination, ...GENERATED_MANIFEST_PATH.split('/')))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('does not delete a same-byte foreign inode substituted during rollback verification', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let reads = 0;
        let foreignPath: string | undefined;
        const operations = makeNodePackageExtractionOperations({
            read: async (handle, buffer, offset, length, position) => {
                const result = await base.read(handle, buffer, offset, length, position);
                reads += 1;
                if (reads === 3) {
                    const staging = (await fs.readdir(parent)).find((entry) => entry.includes('.erden-extract-'));
                    if (staging !== undefined) {
                        foreignPath = join(parent, staging, 'data.ttl');
                        const bytes = await fs.readFile(foreignPath);
                        await fs.rm(foreignPath);
                        await fs.writeFile(foreignPath, bytes);
                    }
                }
                return result;
            },
        });
        await expectExtractionError(
            extractPackageArchive(MALICIOUS_ARCHIVES.missingManifest, { destination }, operations),
            'extraction-rollback-unsafe',
        );
        expect(foreignPath).toBeDefined();
        expect(await fs.readFile(foreignPath as string, 'utf8')).toBe('data');
        expect(await fs.readdir(parent)).not.toContain('installed');
    });

    it('refuses a symbolic or reparse ancestor before reading archive bytes', async () => {
        const parent = await root();
        const actual = join(parent, 'actual');
        const linked = join(parent, 'linked');
        await fs.mkdir(actual);
        try {
            await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            return;
        }
        let reads = 0;
        const source = (async function* (): AsyncIterable<Uint8Array> {
            reads += 1;
            yield await Promise.resolve(encodePackage(INPUT).archiveBytes);
        })();
        await expectExtractionError(
            extractPackageArchive(source, { destination: join(linked, 'installed') }),
            'destination-unsafe',
        );
        expect(reads).toBe(0);
        expect(await fs.readdir(actual)).toEqual([]);
    });

    it('closes the producer and rolls back staging when the Effect is interrupted', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const archive = encodePackage(INPUT).archiveBytes;
        let call = 0;
        let returned = false;
        let notifyBlocked: (() => void) | undefined;
        const blocked = new Promise<void>((resolvePromise) => {
            notifyBlocked = resolvePromise;
        });
        const source: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
                return {
                    next: async () => {
                        call += 1;
                        if (call === 1) {
                            return { done: false, value: archive.subarray(0, 10) };
                        }
                        notifyBlocked?.();
                        return await new Promise<IteratorResult<Uint8Array>>(() => undefined);
                    },
                    return: async () => {
                        returned = true;
                        return await Promise.resolve({ done: true, value: undefined });
                    },
                };
            },
        };
        const fiber = Effect.runFork(extractPackageArchive(source, { destination }));
        await blocked;
        await Effect.runPromise(Fiber.interrupt(fiber));
        expect(returned).toBe(true);
        expect(await fs.readdir(parent)).toEqual([]);
    });

    it('rolls back when interruption is observed across a paused support-file move', async () => {
        const parent = await root();
        const destination = join(parent, 'installed');
        const base = makeNodePackageExtractionOperations();
        let releaseMove: (() => void) | undefined;
        let notifyPaused: (() => void) | undefined;
        const paused = new Promise<void>((resolvePromise) => {
            notifyPaused = resolvePromise;
        });
        const released = new Promise<void>((resolvePromise) => {
            releaseMove = resolvePromise;
        });
        let held = false;
        const operations = makeNodePackageExtractionOperations({
            rename: async (from, to) => {
                if (!held && String(to).endsWith('data.ttl')) {
                    held = true;
                    notifyPaused?.();
                    await released;
                }
                await base.rename(from, to);
            },
        });
        const fiber = Effect.runFork(
            extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
        );
        await paused;
        const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
        await new Promise<void>((resolvePromise) => {
            setTimeout(resolvePromise, 0);
        });
        releaseMove?.();
        await interrupted;
        expect(await fs.readdir(parent)).toEqual([]);
    });

    it.each([false, true])(
        'leaves only an absent or complete package when interruption races the final manifest rename (%s)',
        async (commit) => {
            const parent = await root();
            const destination = join(parent, 'installed');
            const base = makeNodePackageExtractionOperations();
            let releaseMove: (() => void) | undefined;
            let notifyPaused: (() => void) | undefined;
            const paused = new Promise<void>((resolvePromise) => {
                notifyPaused = resolvePromise;
            });
            const released = new Promise<void>((resolvePromise) => {
                releaseMove = resolvePromise;
            });
            const operations = makeNodePackageExtractionOperations({
                rename: async (from, to) => {
                    if (String(to).endsWith('package-manifest.json')) {
                        notifyPaused?.();
                        await released;
                        if (!commit) {
                            throw new Error('manifest move interrupted before commit');
                        }
                    }
                    await base.rename(from, to);
                },
            });
            const fiber = Effect.runFork(
                extractPackageArchive(encodePackage(INPUT).archiveBytes, { destination }, operations),
            );
            await paused;
            const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
            await new Promise<void>((resolvePromise) => {
                setTimeout(resolvePromise, 0);
            });
            releaseMove?.();
            await interrupted;
            if (commit) {
                expect(await fs.readFile(join(destination, ...GENERATED_MANIFEST_PATH.split('/')), 'utf8')).toContain(
                    INPUT.canonicalIri,
                );
                expect((await fs.readdir(parent)).sort()).toEqual(['installed']);
            } else {
                expect(await fs.readdir(parent)).toEqual([]);
            }
        },
    );
});
