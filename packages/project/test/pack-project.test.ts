import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    makeCurrentToolchainService,
    makeEmptyLockfile,
    normalizeManifestV1,
    serializeLockfileBytes,
    serializeManifestV1,
    type LockToolchain,
} from '@erden/contracts';
import { encodePackage, packageCodec, validatePackageArchive } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    PackProjectError,
    PACK_PROJECT_TRAVERSAL_LIMITS,
    decodePackProjectReport,
    encodePackProjectReport,
    makeDependencyResolver,
    makeNodePackFileSystemPort,
    nodeProjectDependencyStateService,
    makePackProjectService,
    renderPackProjectReport,
} from '../src/index.js';

const roots: string[] = [];
function digest(character: string): string {
    return character.repeat(64);
}
const TOOLCHAIN: LockToolchain = Object.freeze({
    validator: Object.freeze({ version: '1.0.0', sha256: digest('a') }),
    reasoner: Object.freeze({ version: '1.0.0', sha256: digest('b') }),
});

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

async function fixture() {
    const parent = makeTestTempRoot('erden-pack-');
    roots.push(parent);
    const root = join(parent, 'project');
    const manifest = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/project',
        alias: '@example/project',
        ownedIriPrefixes: ['https://example.test/project#'],
        sources: { ontology: ['ontology.ttl'] },
    });
    const lock = makeEmptyLockfile(manifest, TOOLCHAIN);
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'), { mode: 0o644 });
    await fs.writeFile(join(root, 'erden.lock'), serializeLockfileBytes(lock), { mode: 0o644 });
    await fs.writeFile(join(root, 'ontology.ttl'), '<urn:s> <urn:p> <urn:o> .\n', { mode: 0o644 });
    await fs.writeFile(join(root, 'README.bin'), Uint8Array.of(0, 1, 2, 255), { mode: 0o644 });
    const service = makePackProjectService(
        nodeProjectDependencyStateService,
        makeCurrentToolchainService(() => TOOLCHAIN),
        packageCodec,
        makeNodePackFileSystemPort(),
    );
    return { parent, root, service };
}

function serviceWithFileSystem(overrides: Parameters<typeof makeNodePackFileSystemPort>[0]) {
    return makePackProjectService(
        nodeProjectDependencyStateService,
        makeCurrentToolchainService(() => TOOLCHAIN),
        packageCodec,
        makeNodePackFileSystemPort(overrides),
    );
}

function fakeDirectory(names: ReadonlyArray<string>): Awaited<ReturnType<typeof fs.opendir>> {
    return {
        async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            for (const name of names) {
                yield Object.freeze({ name });
            }
        },
    } as unknown as Awaited<ReturnType<typeof fs.opendir>>;
}

describe('PackProject', () => {
    it.each([
        ['parent', '../outside'],
        ['absolute-posix', '/private/evidence'],
        ['absolute-drive', 'C:/private/evidence'],
        ['absolute-unc', '\\\\server\\share\\evidence'],
        ['backslash', 'docs\\evidence'],
        ['dot-segment', './evidence'],
    ] as const)(
        'rejects nonportable citation root %s before codec or output mutation',
        async (_label, citationRoot) => {
            const { parent, root } = await fixture();
            const manifest = normalizeManifestV1({
                schemaVersion: 1,
                canonicalIri: 'https://example.test/project',
                alias: '@example/project',
                ownedIriPrefixes: ['https://example.test/project#'],
                sources: { ontology: ['ontology.ttl'] },
                citationRoots: { evidence: citationRoot },
            });
            await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
            const encode = vi.fn(packageCodec.encode);
            const service = makePackProjectService(
                nodeProjectDependencyStateService,
                makeCurrentToolchainService(() => TOOLCHAIN),
                { encode },
                makeNodePackFileSystemPort(),
            );
            await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
                code: 'PACK_PROJECT_MANIFEST_NOT_PORTABLE',
            });
            expect(encode).not.toHaveBeenCalled();
            await expect(fs.stat(join(parent, 'example-project-1.2.3.erdenpkg'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        },
    );

    it.each([
        ['empty-root', 'PACK_PROJECT_MANIFEST_UNAVAILABLE'],
        ['ambiguous-manifest', 'PACK_PROJECT_MANIFEST_UNAVAILABLE'],
        ['malformed-manifest', 'PACK_PROJECT_MANIFEST_UNAVAILABLE'],
        ['malformed-lock', 'PACK_PROJECT_LOCK_INVALID'],
        ['active-transaction', 'PACK_PROJECT_LOCK_INVALID'],
    ] as const)('classifies project dependency state %s precisely', async (scenario, expectedCode) => {
        const current = await fixture();
        let selectedRoot = current.root;
        if (scenario === 'empty-root') {
            selectedRoot = join(current.parent, 'empty');
            await fs.mkdir(selectedRoot);
        } else if (scenario === 'ambiguous-manifest') {
            await fs.writeFile(
                join(current.root, 'erden.config.jsonc'),
                await fs.readFile(join(current.root, 'erden.config.json')),
            );
        } else if (scenario === 'malformed-manifest') {
            await fs.writeFile(join(current.root, 'erden.config.json'), '{ invalid json');
        } else if (scenario === 'malformed-lock') {
            await fs.writeFile(join(current.root, 'erden.lock'), 'not: canonical\n');
        } else {
            await fs.writeFile(join(current.root, '.erden.dependencies.transaction.json'), '{}\n');
        }
        await expect(
            Effect.runPromise(current.service.pack({ version: '1.2.3', from: selectedRoot })),
        ).rejects.toMatchObject({
            code: expectedCode,
        });
    });

    it('packs the whole regular-file project deterministically with the canonical report', async () => {
        const { parent, root, service } = await fixture();
        const report = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
        const expectedPath = join(parent, 'example-project-1.2.3.erdenpkg');
        expect(report.output.path).toBe(expectedPath);
        expect(report.output.status).toBe('written');
        expect(Object.isFrozen(report)).toBe(true);
        expect(decodePackProjectReport(report)).toStrictEqual(report);
        expect(encodePackProjectReport(report)).toMatch(/^\{"archive":/u);
        expect(renderPackProjectReport(report)).toContain(expectedPath.replaceAll('\\', '\\\\'));

        const archive = await fs.readFile(expectedPath);
        if (process.platform !== 'win32') {
            expect((await fs.stat(expectedPath)).mode & 0o7777).toBe(0o644);
        }
        const validated = await Effect.runPromise(validatePackageArchive(archive));
        expect(validated.archiveSha256).toBe(report.archive.sha256);
        expect(validated.manifest.files.map(({ path }) => path)).toEqual([
            'README.bin',
            'erden.config.json',
            'erden.lock',
            'ontology.ttl',
        ]);
        expect(validated.manifest.files.every(({ executable }) => !executable)).toBe(true);

        const hit = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
        expect(hit.output.status).toBe('hit');
        expect(hit.archive.sha256).toBe(report.archive.sha256);

        expect(() =>
            decodePackProjectReport({
                ...report,
                archive: { ...report.archive, fileCount: -0 },
            }),
        ).toThrow(TypeError);
        expect(() =>
            decodePackProjectReport({
                ...report,
                output: { ...report.output, status: 'hit', cleanup: 'cleanup-residue-retained' },
            }),
        ).toThrow(TypeError);
        expect(() =>
            decodePackProjectReport(
                new Proxy(report, {
                    getPrototypeOf: () => {
                        throw new Error('C:/private-report');
                    },
                }),
            ),
        ).toThrow(TypeError);
    });

    it('honors authoritative ignore rules but fails if a required selector or lock is ignored', async () => {
        const { root, service } = await fixture();
        await fs.writeFile(join(root, '.erdenignore'), 'README.bin\nontology.ttl\n');
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_REQUIRED_FILE_IGNORED',
        });
        await fs.writeFile(join(root, '.erdenignore'), 'erden.lock\n');
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toBeInstanceOf(
            PackProjectError,
        );
    });

    it.each([
        ['erden.config.jsonc', 'jsonc'],
        ['erden.config.yml', 'yml'],
        ['erden.config.yaml', 'yaml'],
        ['erden.config.toml', 'toml'],
    ] as const)('ships the authenticated original %s root manifest', async (filename, format) => {
        const { root, service } = await fixture();
        const manifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/project',
            alias: '@example/project',
            ownedIriPrefixes: ['https://example.test/project#'],
            sources: { ontology: ['ontology.ttl'] },
        });
        await fs.rm(join(root, 'erden.config.json'));
        await fs.writeFile(join(root, filename), serializeManifestV1(manifest, format), { mode: 0o644 });
        const report = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
        const validated = await Effect.runPromise(validatePackageArchive(await fs.readFile(report.output.path)));
        expect(validated.manifest.files.map(({ path }) => path)).toContain(filename);
    });

    it('rejects noncanonical versions and output paths inside the project before mutation', async () => {
        const { root, service } = await fixture();
        await expect(Effect.runPromise(service.pack({ version: 'v1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_INVALID_INPUT',
        });
        await expect(
            Effect.runPromise(
                service.pack({
                    version: '1.2.3',
                    from: root,
                    outputPath: join(root, 'artifact.erdenpkg'),
                }),
            ),
        ).rejects.toMatchObject({ code: 'PACK_PROJECT_INVALID_INPUT' });
        expect(await fs.readdir(dirname(root))).not.toContain('artifact.erdenpkg');
    });

    it('binds both ignore control files even when the selected rules and closure stay unchanged', async () => {
        const { root } = await fixture();
        await fs.writeFile(join(root, '.gitignore'), '# first\n');
        const base = makeNodePackFileSystemPort().operations;
        let rootScans = 0;
        const service = serviceWithFileSystem({
            opendir: async (path, options) => {
                if (path === root && ++rootScans === 3) {
                    await fs.writeFile(join(root, '.gitignore'), '# second\n');
                }
                return await base.opendir(path, options);
            },
        });
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_SOURCE_INVALID',
        });
    });

    it('rejects selected hardlinks but safely skips ignored linked entries', async () => {
        const { root, service } = await fixture();
        await fs.writeFile(join(root, 'linked.bin'), 'same');
        await fs.link(join(root, 'linked.bin'), join(root, 'linked-copy.bin'));
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_SOURCE_INVALID',
        });
        await fs.writeFile(join(root, '.erdenignore'), 'linked.bin\nlinked-copy.bin\n');
        const report = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
        const validated = await Effect.runPromise(validatePackageArchive(await fs.readFile(report.output.path)));
        expect(validated.manifest.files.map(({ path }) => path)).not.toContain('linked.bin');
    });

    it('rejects every selected non-regular entry before codec or output mutation', async () => {
        const { parent, root } = await fixture();
        try {
            await fs.symlink(join(root, 'README.bin'), join(root, 'special.bin'), 'file');
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'EPERM') {
                return;
            }
            throw cause;
        }
        const service = serviceWithFileSystem({});
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_SOURCE_INVALID',
        });
        expect(await fs.readdir(parent)).toEqual(['project']);
    });

    it.each(['ontology.nt', 'ontology.rdf', 'ontology.owl', 'ontology.jsonld'])(
        'ships a %s file selector byte for byte',
        async (name) => {
            const { root, service } = await fixture();
            const manifest = normalizeManifestV1({
                schemaVersion: 1,
                canonicalIri: 'https://example.test/project',
                alias: '@example/project',
                ownedIriPrefixes: ['https://example.test/project#'],
                sources: { ontology: [name] },
            });
            const original = Uint8Array.from(Buffer.from('upstream bytes \u00e9, unconverted\r\n', 'utf8'));
            await fs.rm(join(root, 'ontology.ttl'));
            await fs.writeFile(join(root, name), original, { mode: 0o644 });
            await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
            await fs.writeFile(
                join(root, 'erden.lock'),
                serializeLockfileBytes(makeEmptyLockfile(manifest, TOOLCHAIN)),
            );
            const report = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
            const validated = await Effect.runPromise(validatePackageArchive(await fs.readFile(report.output.path)));
            expect(validated.manifest.files.find((file) => file.path === name)).toMatchObject({
                byteSize: original.byteLength,
                sha256: createHash('sha256').update(original).digest('hex'),
            });
        },
    );

    it('keeps a directory selector to Turtle files, so other formats there do not satisfy it', async () => {
        const { root, service } = await fixture();
        const manifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/project',
            alias: '@example/project',
            ownedIriPrefixes: ['https://example.test/project#'],
            sources: { ontology: ['upstream'] },
        });
        await fs.mkdir(join(root, 'upstream'));
        await fs.writeFile(join(root, 'upstream', 'core.rdf'), '<rdf:RDF/>\n');
        await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
        await fs.writeFile(join(root, 'erden.lock'), serializeLockfileBytes(makeEmptyLockfile(manifest, TOOLCHAIN)));
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_REQUIRED_FILE_IGNORED',
        });
        await fs.writeFile(join(root, 'upstream', 'core.ttl'), '<urn:s> <urn:p> <urn:o> .\n');
        const report = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
        expect(report.outcome).toBe('packed');
    });

    it('requires every ontology, SHACL, and competency-question selector independently', async () => {
        const { root, service } = await fixture();
        const manifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/project',
            alias: '@example/project',
            ownedIriPrefixes: ['https://example.test/project#'],
            sources: {
                ontology: ['ontology.ttl'],
                shapes: ['shapes', 'missing-shapes'],
                competencyQuestions: ['questions', 'missing-questions'],
            },
        });
        await fs.mkdir(join(root, 'shapes'));
        await fs.mkdir(join(root, 'questions'));
        await fs.writeFile(join(root, 'shapes', 'one.ttl'), '<urn:s> <urn:p> <urn:o> .\n');
        await fs.writeFile(join(root, 'questions', 'one.rq'), 'ASK {}\n');
        await fs.mkdir(join(root, 'missing-shapes'));
        await fs.mkdir(join(root, 'missing-questions'));
        await fs.writeFile(join(root, 'missing-shapes', 'README'), 'not turtle');
        await fs.writeFile(join(root, 'missing-questions', 'README'), 'not sparql');
        await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
        await fs.writeFile(join(root, 'erden.lock'), serializeLockfileBytes(makeEmptyLockfile(manifest, TOOLCHAIN)));
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_REQUIRED_FILE_IGNORED',
        });
    });

    it('fails closed on multiple shipped root manifests and portable output aliases', async () => {
        const { parent, root, service } = await fixture();
        await fs.writeFile(join(root, 'erden.config.yaml'), 'schemaVersion: 1\n');
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_MANIFEST_UNAVAILABLE',
        });
        await fs.rm(join(root, 'erden.config.yaml'));
        await fs.writeFile(join(parent, 'EXAMPLE-PROJECT-1.2.3.ERDENPKG'), 'foreign');
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_OUTPUT_EXISTS',
        });
    });

    it('reconciles publication primitives that commit and then throw', async () => {
        const { parent, root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        const service = serviceWithFileSystem({
            link: async (existingPath, newPath) => {
                await base.link(existingPath, newPath);
                throw Object.assign(new Error('after link'), { code: 'EIO' });
            },
        });
        const report = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
        expect(report.output.status).toBe('written');
        expect(await fs.readdir(parent)).toEqual(expect.arrayContaining(['example-project-1.2.3.erdenpkg', 'project']));
        expect((await fs.readdir(parent)).some((name) => name.includes('.erden-pack-'))).toBe(false);
    });

    it('reconciles stage removal that succeeds and then throws', async () => {
        const { parent, root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        const service = serviceWithFileSystem({
            unlink: async (path) => {
                await base.unlink(path);
                if (basename(String(path)).startsWith('.erden-pack-')) {
                    throw Object.assign(new Error('after unlink'), { code: 'EIO' });
                }
            },
        });
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).resolves.toMatchObject({
            output: { status: 'written', cleanup: 'clean' },
        });
        expect((await fs.readdir(parent)).filter((name) => name.startsWith('.erden-pack-'))).toEqual([]);
    });

    it('reports only authenticated two-link residue when postcommit stage cleanup is denied', async () => {
        const { parent, root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        const service = serviceWithFileSystem({
            unlink: async (path) => {
                if (basename(String(path)).startsWith('.erden-pack-')) {
                    throw Object.assign(new Error('denied'), { code: 'EACCES' });
                }
                await base.unlink(path);
            },
        });
        const report = await Effect.runPromise(service.pack({ version: '1.2.3', from: root }));
        expect(report.output).toMatchObject({ status: 'written', cleanup: 'cleanup-residue-retained' });
        const entries = await fs.readdir(parent);
        const stageName = entries.find((name) => name.startsWith('.erden-pack-'));
        expect(stageName).toBeDefined();
        const output = join(parent, 'example-project-1.2.3.erdenpkg');
        const [outputStats, stageStats] = await Promise.all([
            fs.stat(output, { bigint: true }),
            fs.stat(join(parent, stageName as string), { bigint: true }),
        ]);
        expect([outputStats.dev, outputStats.ino, outputStats.nlink]).toEqual([stageStats.dev, stageStats.ino, 2n]);
    });

    it('rejects a substituted postcommit stage instead of reporting cleanup residue', async () => {
        const { parent, root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        const output = join(parent, 'example-project-1.2.3.erdenpkg');
        const service = serviceWithFileSystem({
            unlink: async (path) => {
                if (!basename(String(path)).startsWith('.erden-pack-')) {
                    await base.unlink(path);
                    return;
                }
                await base.unlink(path);
                await fs.copyFile(output, path);
                if (process.platform !== 'win32') {
                    await fs.chmod(path, 0o644);
                }
                throw Object.assign(new Error('foreign replacement'), { code: 'EACCES' });
            },
        });
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_ROLLBACK_UNSAFE',
        });
        expect(await fs.readFile(output)).not.toHaveLength(0);
        expect((await fs.readdir(parent)).some((name) => name.startsWith('.erden-pack-'))).toBe(true);
    });

    it.each(['open', 'link', 'unlink', 'hit', 'reconcile'] as const)(
        'fails closed when the authenticated output parent changes at the %s seam',
        async (seam) => {
            const { parent, root } = await fixture();
            const outputParent = join(parent, 'output');
            const movedParent = join(parent, `output-${seam}-original`);
            const replacementIdentity = join(parent, `output-${seam}-replacement-identity`);
            const output = join(outputParent, 'artifact.erdenpkg');
            await fs.mkdir(outputParent);
            await fs.mkdir(replacementIdentity);
            if (seam === 'hit') {
                const initial = serviceWithFileSystem({});
                await Effect.runPromise(initial.pack({ version: '1.2.3', from: root, outputPath: output }));
            }
            const base = makeNodePackFileSystemPort().operations;
            let swapped = false;
            let simulateIdentityReplacement = false;
            async function swap() {
                if (swapped) {
                    return;
                }
                swapped = true;
                if (seam === 'open' || seam === 'hit') {
                    simulateIdentityReplacement = true;
                    return;
                }
                await fs.rename(outputParent, movedParent);
                await fs.mkdir(outputParent);
            }
            const replacementLstat = (async (
                path: Parameters<typeof base.lstat>[0],
                options: Parameters<typeof base.lstat>[1],
            ) =>
                await base.lstat(
                    simulateIdentityReplacement && String(path) === outputParent ? replacementIdentity : path,
                    options,
                )) as typeof base.lstat;
            const service = serviceWithFileSystem({
                lstat: replacementLstat,
                open: async (path, flags, mode) => {
                    const handle = await base.open(path, flags, mode);
                    if (
                        (seam === 'open' && flags === 'wx') ||
                        (seam === 'hit' && String(path) === output && flags === 'r')
                    ) {
                        await swap();
                    }
                    return handle;
                },
                link: async (existingPath, newPath) => {
                    await base.link(existingPath, newPath);
                    if (seam === 'link' || seam === 'reconcile') {
                        await swap();
                    }
                    if (seam === 'reconcile') {
                        throw Object.assign(new Error('link moved then failed'), { code: 'EIO' });
                    }
                },
                unlink: async (path) => {
                    await base.unlink(path);
                    if (seam === 'unlink' && basename(String(path)).startsWith('.erden-pack-')) {
                        await swap();
                    }
                },
            });
            await expect(
                Effect.runPromise(service.pack({ version: '1.2.3', from: root, outputPath: output })),
            ).rejects.toBeInstanceOf(PackProjectError);
            expect(swapped).toBe(true);
            if (seam !== 'hit') {
                expect(await fs.readdir(outputParent)).not.toContain('artifact.erdenpkg');
            }
        },
    );

    it('accepts case-only realpath spelling but still rejects a portable root control alias', async () => {
        const { root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        const caseOnlyRealpath = (async (path: Parameters<typeof base.realpath>[0]) => {
            const actual = await base.realpath(path);
            return String(path) === root ? actual.toUpperCase() : actual;
        }) as typeof base.realpath;
        const service = serviceWithFileSystem({
            realpath: caseOnlyRealpath,
        });
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).resolves.toMatchObject({
            outcome: 'packed',
        });

        if (process.platform !== 'win32') {
            await fs.writeFile(join(root, 'ERDEN.LOCK'), 'foreign');
            await expect(Effect.runPromise(service.pack({ version: '1.2.4', from: root }))).rejects.toMatchObject({
                code: 'PACK_PROJECT_LOCK_INVALID',
            });
        }
    });

    it('bounds every observed entry before ignore evaluation while allowing the exact boundary', async () => {
        const passing = await fixture();
        const passingBulk = join(passing.root, 'bulk');
        await fs.mkdir(passingBulk);
        await fs.writeFile(join(passing.root, '.erdenignore'), 'bulk/*\n');
        const passingRootCount = (await fs.readdir(passing.root)).length;
        const exactNames = Array.from(
            { length: PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedEntries - passingRootCount },
            (_, index) => `${index.toString().padStart(8, '0')}.ignored`,
        );
        const base = makeNodePackFileSystemPort().operations;
        const guardedLstat = (async (
            path: Parameters<typeof base.lstat>[0],
            options: Parameters<typeof base.lstat>[1],
        ) => {
            if (String(path).startsWith(`${passingBulk}\\`) || String(path).startsWith(`${passingBulk}/`)) {
                throw new Error('ignored entry was inspected');
            }
            return await base.lstat(path, options);
        }) as typeof base.lstat;
        const exact = serviceWithFileSystem({
            opendir: async (path, options) =>
                String(path) === passingBulk ? fakeDirectory(exactNames) : await base.opendir(path, options),
            lstat: guardedLstat,
        });
        await expect(Effect.runPromise(exact.pack({ version: '1.2.3', from: passing.root }))).resolves.toMatchObject({
            outcome: 'packed',
        });

        const failing = await fixture();
        const failingBulk = join(failing.root, 'bulk');
        await fs.mkdir(failingBulk);
        await fs.writeFile(join(failing.root, '.erdenignore'), 'bulk/*\n');
        const tooMany = Array.from(
            { length: PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedEntries + 1 },
            (_, index) => `${index.toString().padStart(8, '0')}.ignored`,
        );
        const over = serviceWithFileSystem({
            opendir: async (path, options) =>
                String(path) === failingBulk ? fakeDirectory(tooMany) : await base.opendir(path, options),
        });
        await expect(Effect.runPromise(over.pack({ version: '1.2.3', from: failing.root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_SOURCE_INVALID',
        });
    });

    it('enforces the cumulative observed UTF-8 name-byte bound before ignored entry inspection', async () => {
        const exactFixture = await fixture();
        const bulk = join(exactFixture.root, 'bulk');
        await fs.mkdir(bulk);
        await fs.writeFile(join(exactFixture.root, '.erdenignore'), 'bulk/*\n');
        const rootNameBytes = (await fs.readdir(exactFixture.root)).reduce(
            (sum, name) => sum + Buffer.byteLength(name, 'utf8'),
            0,
        );
        const exactName = 'x'.repeat(PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedNameBytes - rootNameBytes);
        const base = makeNodePackFileSystemPort().operations;
        const exact = serviceWithFileSystem({
            opendir: async (path, options) =>
                String(path) === bulk ? fakeDirectory([exactName]) : await base.opendir(path, options),
        });
        await expect(
            Effect.runPromise(exact.pack({ version: '1.2.3', from: exactFixture.root })),
        ).resolves.toMatchObject({ outcome: 'packed' });

        const overFixture = await fixture();
        const overBulk = join(overFixture.root, 'bulk');
        await fs.mkdir(overBulk);
        await fs.writeFile(join(overFixture.root, '.erdenignore'), 'bulk/*\n');
        const overRootBytes = (await fs.readdir(overFixture.root)).reduce(
            (sum, name) => sum + Buffer.byteLength(name, 'utf8'),
            0,
        );
        const overName = 'x'.repeat(PACK_PROJECT_TRAVERSAL_LIMITS.maxObservedNameBytes - overRootBytes + 1);
        const over = serviceWithFileSystem({
            opendir: async (path, options) =>
                String(path) === overBulk ? fakeDirectory([overName]) : await base.opendir(path, options),
        });
        await expect(Effect.runPromise(over.pack({ version: '1.2.3', from: overFixture.root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_SOURCE_INVALID',
        });
    });

    it('preserves a raced foreign output and reports the no-overwrite conflict', async () => {
        const { parent, root } = await fixture();
        const output = join(parent, 'example-project-1.2.3.erdenpkg');
        const base = makeNodePackFileSystemPort().operations;
        const service = serviceWithFileSystem({
            link: async (existingPath, newPath) => {
                await fs.writeFile(newPath, 'foreign');
                await base.link(existingPath, newPath);
            },
        });
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_OUTPUT_EXISTS',
        });
        expect(await fs.readFile(output, 'utf8')).toBe('foreign');
        expect((await fs.readdir(parent)).filter((name) => name.startsWith('.erden-pack-'))).toEqual([]);
    });

    it('retains unauthenticated create-then-throw evidence and cleans authenticated short-write failures', async () => {
        const { parent, root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        const unsafe = serviceWithFileSystem({
            open: async (path, flags, mode) => {
                if (flags === 'wx') {
                    const handle = await base.open(path, flags, mode);
                    await handle.close();
                    throw Object.assign(new Error('after create'), { code: 'EIO' });
                }
                return await base.open(path, flags, mode);
            },
            token: () => '0123456789abcdef',
        });
        await expect(Effect.runPromise(unsafe.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_ROLLBACK_UNSAFE',
        });
        const retained = (await fs.readdir(parent)).find(
            (name) => name.startsWith('.erden-pack-') && name.endsWith('-0123456789abcdef'),
        );
        expect(retained).toBeDefined();
        await fs.rm(join(parent, retained as string));

        const clean = serviceWithFileSystem({ write: () => Promise.resolve({ bytesWritten: 0 }) });
        await expect(Effect.runPromise(clean.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_TRANSACTION_FAILED',
        });
        expect((await fs.readdir(parent)).some((name) => name.includes('.erden-pack-'))).toBe(false);
    });

    it.each(['EACCES', 'ENOSPC'] as const)(
        'preserves an ordinary %s failure when exclusive stage creation proves clean absence',
        async (code) => {
            const { parent, root } = await fixture();
            const base = makeNodePackFileSystemPort().operations;
            const service = serviceWithFileSystem({
                open: async (path, flags, mode) => {
                    if (flags === 'wx') {
                        throw Object.assign(new Error('before create'), { code });
                    }
                    return await base.open(path, flags, mode);
                },
            });
            await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
                code: 'PACK_PROJECT_TRANSACTION_FAILED',
            });
            expect(await fs.readdir(parent)).toEqual(['project']);
        },
    );

    it('retains a noncanonical stage alias reported by a failing exclusive create', async () => {
        const { parent, root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        const service = serviceWithFileSystem({
            open: async (path, flags, mode) => {
                if (flags !== 'wx') {
                    return await base.open(path, flags, mode);
                }
                await fs.writeFile(join(dirname(String(path)), basename(String(path)).toUpperCase()), 'foreign');
                throw Object.assign(new Error('ambiguous create'), { code: 'EACCES' });
            },
            token: () => '0123456789abcdef',
        });
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_ROLLBACK_UNSAFE',
        });
        expect((await fs.readdir(parent)).some((name) => name.startsWith('.ERDEN-PACK-'))).toBe(true);
    });

    it('does not treat an absent stage as clean when the output parent drifts during exclusive create', async () => {
        const { parent, root } = await fixture();
        const outputParent = join(parent, 'output');
        const originalParent = join(parent, 'output-original');
        const output = join(outputParent, 'artifact.erdenpkg');
        await fs.mkdir(outputParent);
        const base = makeNodePackFileSystemPort().operations;
        const service = serviceWithFileSystem({
            open: async (path, flags, mode) => {
                if (flags !== 'wx') {
                    return await base.open(path, flags, mode);
                }
                await fs.rename(outputParent, originalParent);
                await fs.mkdir(outputParent);
                throw Object.assign(new Error('parent changed before create'), { code: 'EACCES' });
            },
        });
        await expect(
            Effect.runPromise(service.pack({ version: '1.2.3', from: root, outputPath: output })),
        ).rejects.toMatchObject({
            code: 'PACK_PROJECT_ROLLBACK_UNSAFE',
        });
        expect(await fs.readdir(outputParent)).toEqual([]);
        expect(await fs.readdir(originalParent)).toEqual([]);
    });

    it('produces byte-identical archives independent of source permission bits', async () => {
        const first = await fixture();
        const second = await fixture();
        if (process.platform !== 'win32') {
            await fs.chmod(join(first.root, 'README.bin'), 0o755);
            await fs.chmod(join(second.root, 'README.bin'), 0o600);
        }
        const [left, right] = await Promise.all([
            Effect.runPromise(first.service.pack({ version: '1.2.3', from: first.root })),
            Effect.runPromise(second.service.pack({ version: '1.2.3', from: second.root })),
        ]);
        expect(left.archive.sha256).toBe(right.archive.sha256);
    });

    it('rejects duplicate authored constraints that cannot be represented in package format v1', async () => {
        const { root, service } = await fixture();
        const canonicalIri = 'https://dependency.example/a';
        const manifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/project',
            alias: '@example/project',
            ownedIriPrefixes: ['https://example.test/project#'],
            registry: 'https://registry.example',
            dependencies: { '@dependency/a': '*', [canonicalIri]: '*' },
            sources: { ontology: ['ontology.ttl'] },
        });
        const encoded = encodePackage({
            canonicalIri,
            version: '1.0.0',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [],
        });
        const resolved = await Effect.runPromise(
            makeDependencyResolver({
                resolveAlias: () => Promise.resolve({ alias: '@dependency/a', canonicalIri }),
                listPublished: () =>
                    Promise.resolve([
                        {
                            canonicalIri,
                            version: '1.0.0',
                            archiveSha256: encoded.archiveSha256,
                            manifest: encoded.manifest,
                        },
                    ]),
            }).resolve({ manifest, toolchain: TOOLCHAIN }),
        );
        await fs.writeFile(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
        await fs.writeFile(join(root, 'erden.lock'), serializeLockfileBytes(resolved.lock));
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_DEPENDENCY_UNREPRESENTABLE',
        });
    });

    it('rejects a valid archive from a codec that does not bind the requested project snapshot', async () => {
        const { root } = await fixture();
        const wrong = encodePackage({
            canonicalIri: 'https://wrong.example/project',
            version: '1.2.3',
            dependencies: [],
            validator: TOOLCHAIN.validator,
            reasoner: TOOLCHAIN.reasoner,
            files: [],
        });
        const service = makePackProjectService(
            nodeProjectDependencyStateService,
            makeCurrentToolchainService(() => TOOLCHAIN),
            { encode: () => Effect.succeed(wrong) },
            makeNodePackFileSystemPort(),
        );
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_CODEC_FAILURE',
        });
    });

    it('rejects source identity replacement during codec work before output mutation', async () => {
        const { parent, root } = await fixture();
        const service = makePackProjectService(
            nodeProjectDependencyStateService,
            makeCurrentToolchainService(() => TOOLCHAIN),
            {
                encode: (input) =>
                    Effect.tryPromise({
                        try: async () => {
                            const ontology = join(root, 'ontology.ttl');
                            const bytes = await fs.readFile(ontology);
                            await fs.rm(ontology);
                            await fs.writeFile(ontology, bytes);
                            return await Effect.runPromise(packageCodec.encode(input));
                        },
                        catch: (cause) => cause,
                    }),
            },
            makeNodePackFileSystemPort(),
        );
        await expect(Effect.runPromise(service.pack({ version: '1.2.3', from: root }))).rejects.toMatchObject({
            code: 'PACK_PROJECT_SOURCE_INVALID',
        });
        expect(await fs.readdir(parent)).toEqual(['project']);
    });

    it('interrupts before publication and removes the authenticated stage', async () => {
        const { parent, root } = await fixture();
        const base = makeNodePackFileSystemPort().operations;
        let reached: (() => void) | undefined;
        let release: (() => void) | undefined;
        const paused = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const resume = new Promise<void>((resolve) => {
            release = resolve;
        });
        let didPause = false;
        const service = serviceWithFileSystem({
            open: async (path, flags, mode) => {
                const handle = await base.open(path, flags, mode);
                if (!didPause && flags === 'r' && basename(String(path)).startsWith('.erden-pack-')) {
                    didPause = true;
                    reached?.();
                    await resume;
                }
                return handle;
            },
        });
        const fiber = Effect.runFork(service.pack({ version: '1.2.3', from: root }));
        await paused;
        const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
        release?.();
        await interrupted;
        expect(await fs.readdir(parent)).toEqual(['project']);
    });
});
