import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Effect } from 'effect';

import { ResourceAccessError } from './errors.js';
import type { GitInspection } from './model.js';
import { nodeShaclEnginePort, type ShaclEnginePort } from './shacl-engine/port.js';

export interface TextResourcePort {
    readonly readBytes: (locator: string) => Effect.Effect<Uint8Array, ResourceAccessError>;
    readonly readText: (locator: string) => Effect.Effect<string, ResourceAccessError>;
    readonly listFiles: (locator: string) => Effect.Effect<ReadonlyArray<string>, ResourceAccessError>;
}

export interface CitationFilePort {
    readonly exists: (absolutePath: string) => Effect.Effect<boolean, ResourceAccessError>;
}

export interface GitInspectInput {
    readonly absolutePath: string;
    readonly commit: string | null;
}

export interface GitPort {
    readonly inspect: (input: GitInspectInput) => Effect.Effect<GitInspection>;
}

export interface OntologyPorts {
    readonly resources: TextResourcePort;
    readonly citationFiles: CitationFilePort;
    readonly git?: GitPort;
    /** The SHACL engine; the bundled erden-shacl when absent. */
    readonly shaclEngine?: ShaclEnginePort;
}

export function makeNodeTextResourcePort(): TextResourcePort {
    return Object.freeze({
        readBytes: (locator: string) =>
            Effect.tryPromise({
                try: () => fs.readFile(locator),
                catch: (cause) => new ResourceAccessError(locator, cause),
            }),
        readText: (locator: string) =>
            Effect.tryPromise({
                try: () => fs.readFile(locator, 'utf8'),
                catch: (cause) => new ResourceAccessError(locator, cause),
            }),
        listFiles: (locator: string) =>
            Effect.tryPromise({
                try: async () =>
                    (await fs.readdir(locator, { withFileTypes: true }))
                        .filter((entry) => entry.isFile())
                        .map((entry) => resolve(locator, entry.name)),
                catch: (cause) => new ResourceAccessError(locator, cause),
            }),
    });
}

export function makeNodeCitationFilePort(): CitationFilePort {
    return Object.freeze({
        exists: (absolutePath: string) => Effect.sync(() => existsSync(absolutePath)),
    });
}

const execFilePromise = promisify(execFile);

async function runGit(cwd: string, args: ReadonlyArray<string>): Promise<string> {
    const result = await execFilePromise('git', [...args], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
    });
    return result.stdout.trim();
}

export function makeNodeGitPort(): GitPort {
    return Object.freeze({
        inspect: ({ absolutePath, commit }: GitInspectInput) =>
            Effect.promise(async () => {
                let repositoryRoot: string;
                try {
                    repositoryRoot = await runGit(dirname(absolutePath), ['rev-parse', '--show-toplevel']);
                } catch (cause) {
                    const message = cause instanceof Error ? cause.message : String(cause);
                    return /ENOENT|not recognized|not found/iu.test(message)
                        ? { state: 'git-unavailable' as const }
                        : { state: 'not-in-git' as const };
                }
                if (commit === null) {
                    return { state: 'no-commit-cited' as const, repositoryRoot };
                }
                try {
                    await runGit(repositoryRoot, ['cat-file', '-e', `${commit}^{commit}`]);
                } catch {
                    return { state: 'commit-not-in-repo' as const, repositoryRoot };
                }
                const repositoryPath = relative(repositoryRoot, absolutePath);
                try {
                    const changed = await runGit(repositoryRoot, [
                        'diff',
                        '--name-only',
                        `${commit}..HEAD`,
                        '--',
                        repositoryPath,
                    ]);
                    if (changed.length > 0) {
                        return { state: 'changed-since' as const, repositoryRoot };
                    }
                    const dirty = await runGit(repositoryRoot, ['status', '--porcelain', '--', repositoryPath]);
                    return dirty.length > 0
                        ? { state: 'uncommitted-edit' as const, repositoryRoot }
                        : { state: 'unchanged' as const, repositoryRoot };
                } catch {
                    return { state: 'git-unavailable' as const, repositoryRoot };
                }
            }),
    });
}

export function makeNodeOntologyPorts(): OntologyPorts {
    return Object.freeze({
        resources: makeNodeTextResourcePort(),
        citationFiles: makeNodeCitationFilePort(),
        git: makeNodeGitPort(),
        shaclEngine: nodeShaclEnginePort,
    });
}
