import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    promises as fs,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_INIT_ALIAS,
    DEFAULT_INIT_CANONICAL_IRI,
    InitProjectError,
    decodeInitProjectReport,
    encodeInitProjectReport,
    makeInitProjectService,
    makeManifestService,
    makeNodeInitProjectFileSystemPort,
    nodeCheckProjectService,
    nodeInitProjectService,
    renderInitProjectReport,
    type InitNodeFileOperations,
    type InitProjectReport,
} from '../src/index.js';

const roots: string[] = [];
function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'erden-init-project-'));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function runInit(
    parent: string,
    target: string,
    options: Partial<Parameters<typeof nodeInitProjectService.init>[0]> = {},
) {
    return Effect.runPromise(nodeInitProjectService.init({ targetDirectory: target, from: parent, ...options }));
}

const TEMP_TOKEN = '00000000-0000-4000-8000-000000000001';
const OWNER_TOKEN = '00000000-0000-4000-8000-000000000002';

function nodeOperations(overrides: Partial<InitNodeFileOperations> = {}): InitNodeFileOperations {
    return {
        lstat: fs.lstat,
        mkdir: fs.mkdir,
        writeFile: fs.writeFile,
        chmod: fs.chmod,
        readFile: fs.readFile,
        rename: fs.rename,
        readdir: fs.readdir,
        rm: fs.rm,
        rmdir: fs.rmdir,
        realpath: fs.realpath,
        tempToken: () => TEMP_TOKEN,
        ownershipToken: () => OWNER_TOKEN,
        ...overrides,
    };
}

function runInjectedInit(parent: string, operations: InitNodeFileOperations) {
    return makeInitProjectService(makeManifestService(), makeNodeInitProjectFileSystemPort(operations)).init({
        targetDirectory: 'project',
        from: parent,
    });
}

function expectNoManifest(target: string): void {
    if (!existsSync(target)) {
        return;
    }
    expect(readdirSync(target).some((entry) => entry.startsWith('erden.config.'))).toBe(false);
}

describe('InitProject application operation', () => {
    it.each(['json', 'jsonc', 'yml', 'yaml', 'toml'] as const)(
        'emits one deterministic %s manifest, canonical empty lock, and green Turtle fixture',
        async (format) => {
            const left = tempRoot();
            const right = tempRoot();
            const first = await runInit(left, 'project', { format });
            const second = await runInit(right, 'project', { format });
            expect(first.manifest).toMatchObject({
                format,
                canonicalIri: DEFAULT_INIT_CANONICAL_IRI,
                alias: DEFAULT_INIT_ALIAS,
            });
            expect(first.files).toHaveLength(3);
            expect(readdirSync(join(left, 'project')).sort()).toEqual(first.files.map((file) => file.path));
            for (const file of first.files) {
                expect(readFileSync(join(left, 'project', file.path))).toEqual(
                    readFileSync(join(right, 'project', file.path)),
                );
            }
            expect(first.files.map(({ path }) => path)).toContain('erden.lock');
            if (process.platform !== 'win32') {
                expect(statSync(join(left, 'project', first.manifest.file)).mode & 0o7777).toBe(0o644);
                expect(statSync(join(left, 'project', 'erden.lock')).mode & 0o7777).toBe(0o644);
            }
            expect(encodeInitProjectReport(first)).toBe(encodeInitProjectReport(second));
            expect(renderInitProjectReport(first)).toBe(renderInitProjectReport(second));
            expect(renderInitProjectReport(first).endsWith('\n')).toBe(true);
        },
    );

    it('keeps the manifest private until publication and cleans a chmod failure before mutation', async () => {
        const parent = tempRoot();
        let observedPrivateMode = false;
        const operations = nodeOperations({
            chmod: async (path, mode) => {
                if (basename(String(path)).startsWith('.erden-init-owner-')) {
                    const before = await fs.lstat(path, { bigint: true });
                    if (process.platform !== 'win32') {
                        observedPrivateMode = Number(before.mode & 0o7777n) === 0o600;
                    }
                    throw Object.assign(new Error('injected manifest chmod denial'), { code: 'EACCES' });
                }
                await fs.chmod(path, mode);
            },
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toMatchObject({ code: 'INIT_TRANSACTION_FAILED' });
        if (process.platform !== 'win32') {
            expect(observedPrivateMode).toBe(true);
        }
        expect(readdirSync(parent)).toEqual([]);
    });

    it('retains evidence when manifest chmod changes truth and then throws', async () => {
        const parent = tempRoot();
        let changed = false;
        const operations = nodeOperations({
            chmod: async (path, mode) => {
                await fs.chmod(path, mode);
                if (basename(String(path)).startsWith('.erden-init-owner-')) {
                    changed = true;
                    throw Object.assign(new Error('injected manifest chmod moved then failed'), { code: 'EIO' });
                }
            },
            lstat: (async (...args: Parameters<typeof fs.lstat>) => {
                const stat = await fs.lstat(...args);
                if (changed && basename(String(args[0])).startsWith('.erden-init-owner-')) {
                    Object.defineProperty(stat, 'mode', {
                        value: typeof stat.mode === 'bigint' ? stat.mode ^ 0o100n : stat.mode ^ 0o100,
                    });
                }
                return stat;
            }) as typeof fs.lstat,
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toMatchObject({ code: 'INIT_ROLLBACK_UNSAFE' });
        expectNoManifest(join(parent, 'project'));
        expect(readdirSync(join(parent, 'project')).some((entry) => entry.startsWith('.erden-init-owner-'))).toBe(true);
    });

    it('normalizes one identity model and immediately passes the real offline CheckProject', async () => {
        const parent = tempRoot();
        const report = await runInit(parent, 'project', {
            canonicalIri: 'https://example.test/project',
            alias: '@example/project',
            ownedIriPrefixes: ['https://example.test/project/z#', 'https://example.test/project/a#'],
        });
        expect(report.manifest.ownedIriPrefixes).toEqual([
            'https://example.test/project/a#',
            'https://example.test/project/z#',
        ]);
        expect(readFileSync(join(parent, 'project', 'ontology.ttl'), 'utf8')).toContain(
            '@prefix ex: <https://example.test/project/a#>',
        );
        const checked = await Effect.runPromise(
            nodeCheckProjectService.check({
                from: join(parent, 'project'),
                offline: true,
            }),
        );
        expect(checked.outcome).toBe('passed');
    });

    it.each(
        ['>', '<', '"', '{', '}', '|', '^', '`', '\\'].flatMap((character) => [
            [`canonical ${character}`, `urn:example:ontology:${character}`, 'urn:example:safe#'],
            [`owned prefix ${character}`, 'urn:example:safe', `urn:example:ontology:${character}#`],
        ]),
    )('rejects Turtle-unrepresentable %s before filesystem commit', async (_label, canonicalIri, ownedPrefix) => {
        let commits = 0;
        const service = makeInitProjectService(makeManifestService(), {
            commit: () => {
                commits += 1;
                return Effect.void;
            },
        });
        const failure = await Effect.runPromise(
            Effect.flip(
                service.init({
                    targetDirectory: 'project',
                    canonicalIri,
                    alias: '@example/hostile',
                    ownedIriPrefixes: [ownedPrefix],
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'INIT_INVALID_OPTIONS' });
        expect(commits).toBe(0);
    });

    it('generates and checks a scaffold with safe non-ASCII IRIs', async () => {
        const parent = tempRoot();
        await runInit(parent, 'project', {
            canonicalIri: 'urn:example:ontology:%F0%9F%98%80',
            alias: '@example/unicode',
            ownedIriPrefixes: ['urn:example:ontology:%F0%9F%98%80#'],
        });
        const checked = await Effect.runPromise(
            nodeCheckProjectService.check({
                from: join(parent, 'project'),
                offline: true,
            }),
        );
        expect(checked.outcome).toBe('passed');
        expect(checked.manifest.canonicalIri).toBe('urn:example:ontology:%F0%9F%98%80');
        expect(checked.stages.core.borrowedTerms?.declared).toContain('urn:example:ontology:%F0%9F%98%80#Concept');
    });

    it('preserves an unused Turtle-forbidden owned prefix when the selected prefix is safe', async () => {
        const parent = tempRoot();
        const report = await runInit(parent, 'project', {
            canonicalIri: 'urn:example:ontology:safe',
            alias: '@example/secondary',
            ownedIriPrefixes: ['urn:example:ontology:safe#', 'urn:example:ontology:unused:>#'],
        });
        expect(report.manifest.ownedIriPrefixes).toEqual([
            'urn:example:ontology:safe#',
            'urn:example:ontology:unused:>#',
        ]);
        const ontology = readFileSync(join(parent, 'project', 'ontology.ttl'), 'utf8');
        expect(ontology).toContain('@prefix ex: <urn:example:ontology:safe#>');
        expect(ontology).not.toContain('unused');
        const checked = await Effect.runPromise(
            nodeCheckProjectService.check({
                from: join(parent, 'project'),
                offline: true,
            }),
        );
        expect(checked.outcome).toBe('passed');
    });

    it.each([
        ['exact target', 'project', 'project'],
        ['portable case alias', 'Project', 'project'],
        ['portable Unicode alias', 'caf\u00e9', 'cafe\u0301'],
    ])('refuses a pre-existing %s without mutation', async (_label, existing, requested) => {
        const parent = tempRoot();
        mkdirSync(join(parent, existing));
        writeFileSync(join(parent, existing, 'keep.txt'), 'keep', 'utf8');
        const failure = await Effect.runPromise(
            Effect.flip(
                nodeInitProjectService.init({
                    targetDirectory: requested,
                    from: parent,
                }),
            ),
        );
        expect(failure).toBeInstanceOf(InitProjectError);
        expect(failure).toMatchObject({ code: 'INIT_TARGET_EXISTS' });
        expect(readFileSync(join(parent, existing, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it.each([2, 3, 4])('rolls back an injected write failure at boundary %i without publication', async (failAt) => {
        const parent = tempRoot();
        let writes = 0;
        const operations = nodeOperations({
            writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
                writes += 1;
                if (writes === failAt) {
                    throw new Error(`injected write ${String(failAt)}`);
                }
                return fs.writeFile(...args);
            }) as typeof fs.writeFile,
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toBeInstanceOf(InitProjectError);
        expectNoManifest(join(parent, 'project'));
        expect(readdirSync(parent)).toEqual([]);
    });

    it.each(['before', 'after'] as const)('rolls back a support move failure injected %s rename', async (when) => {
        const parent = tempRoot();
        let renames = 0;
        const operations = nodeOperations({
            rename: (async (from: string, to: string) => {
                renames += 1;
                if (renames === 1 && when === 'before') {
                    throw new Error('injected support move');
                }
                await fs.rename(from, to);
                if (renames === 1 && when === 'after') {
                    throw new Error('injected support move after rename');
                }
            }) as typeof fs.rename,
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toBeInstanceOf(InitProjectError);
        expectNoManifest(join(parent, 'project'));
        expect(readdirSync(parent)).toEqual([]);
    });

    it('classifies a final move-then-throw as a completed atomic publication', async () => {
        const parent = tempRoot();
        let renames = 0;
        const operations = nodeOperations({
            rename: (async (from: string, to: string) => {
                renames += 1;
                await fs.rename(from, to);
                if (renames === 3) {
                    throw new Error('injected post-publication rename error');
                }
            }) as typeof fs.rename,
        });
        const report = await Effect.runPromise(runInjectedInit(parent, operations));
        expect(report.outcome).toBe('initialized');
        expect(readdirSync(join(parent, 'project')).sort()).toEqual([
            'erden.config.json',
            'erden.lock',
            'ontology.ttl',
        ]);
    });

    it('leaves an inert target and fails closed when a foreign entry races publication', async () => {
        const parent = tempRoot();
        let renames = 0;
        const operations = nodeOperations({
            rename: (async (from: string, to: string) => {
                renames += 1;
                await fs.rename(from, to);
                if (renames === 1) {
                    await fs.writeFile(join(dirname(to), 'foreign.txt'), 'foreign', { flag: 'wx' });
                }
            }) as typeof fs.rename,
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toMatchObject({ code: 'INIT_ROLLBACK_UNSAFE' });
        const target = join(parent, 'project');
        expectNoManifest(target);
        expect(readFileSync(join(target, 'foreign.txt'), 'utf8')).toBe('foreign');
        const retry = await Effect.runPromise(
            Effect.flip(
                nodeInitProjectService.init({
                    targetDirectory: 'project',
                    from: parent,
                }),
            ),
        );
        expect(retry).toMatchObject({ code: 'INIT_TARGET_EXISTS' });
    });

    it('does not delete a same-byte foreign substitution', async () => {
        const parent = tempRoot();
        let renames = 0;
        const operations = nodeOperations({
            rename: (async (from: string, to: string) => {
                renames += 1;
                await fs.rename(from, to);
                if (renames === 1) {
                    const bytes = await fs.readFile(to);
                    await fs.rm(to);
                    await fs.writeFile(to, bytes, { flag: 'wx' });
                }
            }) as typeof fs.rename,
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toMatchObject({ code: 'INIT_ROLLBACK_UNSAFE' });
        const target = join(parent, 'project');
        expectNoManifest(target);
        expect(readFileSync(join(target, 'ontology.ttl'), 'utf8')).toContain('owl:Ontology');
    });

    it('does not delete a same-byte substitution raced between rollback identity and content reads', async () => {
        const parent = tempRoot();
        const targetOntology = join(parent, 'project', 'ontology.ttl');
        let parentReads = 0;
        let ontologyReads = 0;
        const operations = nodeOperations({
            readdir: (async (...args: Parameters<typeof fs.readdir>) => {
                if (typeof args[0] === 'string' && args[0] === parent) {
                    parentReads += 1;
                    if (parentReads === 2) {
                        throw new Error('injected prepublication parent scan failure');
                    }
                }
                return fs.readdir(...args);
            }) as typeof fs.readdir,
            readFile: (async (...args: Parameters<typeof fs.readFile>) => {
                const bytes = await fs.readFile(...args);
                if (typeof args[0] === 'string' && args[0] === targetOntology) {
                    ontologyReads += 1;
                    if (ontologyReads === 2) {
                        await fs.rm(targetOntology);
                        await fs.writeFile(targetOntology, bytes, { flag: 'wx' });
                    }
                }
                return bytes;
            }) as typeof fs.readFile,
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toMatchObject({ code: 'INIT_ROLLBACK_UNSAFE' });
        expectNoManifest(join(parent, 'project'));
        expect(readFileSync(targetOntology, 'utf8')).toContain('owl:Ontology');
    });

    it('does not delete a sentinel whose ownership token was changed', async () => {
        const parent = tempRoot();
        let writes = 0;
        const operations = nodeOperations({
            writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
                writes += 1;
                await fs.writeFile(...args);
                if (writes === 4) {
                    await fs.writeFile(args[0], 'foreign-token', { flag: 'w' });
                }
            }) as typeof fs.writeFile,
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toMatchObject({ code: 'INIT_ROLLBACK_UNSAFE' });
        const target = join(parent, 'project');
        expectNoManifest(target);
        expect(readdirSync(target).some((entry) => entry.startsWith('.erden-init-owner-'))).toBe(true);
    });

    it('does not remove a foreign empty staging-directory replacement', async () => {
        const parent = tempRoot();
        const stagingName = `.project.erden-init-${TEMP_TOKEN}`;
        const displaced = join(parent, '.displaced-staging');
        let stagedRemovals = 0;
        const operations = nodeOperations({
            rm: async (...args: Parameters<typeof fs.rm>) => {
                await fs.rm(...args);
                if (basename(dirname(String(args[0]))) === stagingName) {
                    stagedRemovals += 1;
                    if (stagedRemovals === 1) {
                        const staging = dirname(String(args[0]));
                        await fs.rename(staging, displaced);
                        await fs.mkdir(staging);
                    }
                }
            },
        });
        const failure = await Effect.runPromise(Effect.flip(runInjectedInit(parent, operations)));
        expect(failure).toMatchObject({ code: 'INIT_ROLLBACK_UNSAFE' });
        expect(existsSync(join(parent, stagingName))).toBe(true);
        expectNoManifest(join(parent, 'project'));
    });

    it('refuses unsafe injected transaction tokens before creating staging or target paths', async () => {
        const parent = tempRoot();
        const failure = await Effect.runPromise(
            Effect.flip(
                runInjectedInit(
                    parent,
                    nodeOperations({
                        tempToken: () => '../escape',
                    }),
                ),
            ),
        );
        expect(failure).toMatchObject({ code: 'INIT_TRANSACTION_FAILED' });
        expect(readdirSync(parent)).toEqual([]);
    });

    it('rejects a symbolic-link ancestor without modifying its destination', async () => {
        const parent = tempRoot();
        const destination = join(parent, 'destination');
        const linked = join(parent, 'linked');
        mkdirSync(destination);
        try {
            symlinkSync(destination, linked, 'junction');
        } catch {
            return;
        }
        const failure = await Effect.runPromise(
            Effect.flip(
                nodeInitProjectService.init({
                    targetDirectory: 'project',
                    from: linked,
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'INIT_PARENT_UNAVAILABLE' });
        expect(readdirSync(destination)).toEqual([]);
    });

    it('accepts Windows realpath casing differences and uses UNC share roots', async () => {
        expect(win32.parse('\\\\server\\share\\folder').root).toBe('\\\\server\\share\\');
        if (process.platform !== 'win32') {
            return;
        }
        const parent = tempRoot();
        const operations = nodeOperations({
            realpath: (async (path: string) => {
                const actual = await fs.realpath(path);
                return actual.replace(/^([A-Za-z]):/u, (drive) => drive.toLowerCase());
            }) as typeof fs.realpath,
        });
        const report = await Effect.runPromise(runInjectedInit(parent, operations));
        expect(report.outcome).toBe('initialized');
    });

    it('rejects invalid identity and hostile report encodings before filesystem publication', async () => {
        const parent = tempRoot();
        const failure = await Effect.runPromise(
            Effect.flip(
                nodeInitProjectService.init({
                    targetDirectory: 'project',
                    from: parent,
                    canonicalIri: 'not-an-iri',
                }),
            ),
        );
        expect(failure).toMatchObject({ code: 'INIT_INVALID_OPTIONS' });
        expect(readdirSync(parent)).toEqual([]);

        const valid = await runInit(parent, 'valid');
        const extra = structuredClone(valid) as unknown as {
            files: Array<InitProjectReport['files'][number]>;
        } & Omit<InitProjectReport, 'files'>;
        extra.files.push({ path: 'extra.txt', bytes: 1, contentDigest: `sha256:${'0'.repeat(64)}` });
        expect(() => decodeInitProjectReport(extra)).toThrow();
        const wrongFormat = structuredClone(valid);
        Reflect.set(wrongFormat.manifest, 'format', 'toml');
        expect(() => decodeInitProjectReport(wrongFormat)).toThrow();
    });
});
