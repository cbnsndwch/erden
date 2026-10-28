import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { validatePackFiles } from '../lib/pack-guard.mjs';
import { RUNTIME_DIST_FILES } from '../lib/runtime-package-files.mjs';
import {
    OPEN_WORKSPACE_PROFILE,
    RUNTIME_EXPORTS,
    discoverWorkspaceMembers,
    extendWorkspaceProfile,
    inspectWorkspace,
    platformManifest,
    withMintedReasoner,
} from '../lib/workspace-guard.mjs';

function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path, text = '{}\n') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}

/** A workspace that satisfies `profile` exactly: each member's manifest and required files, made from the profile. */
function createWorkspace(context, profile = OPEN_WORKSPACE_PROFILE) {
    const root = mkdtempSync(join(tmpdir(), 'erden-open-workspace-guard-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    writeFile(
        resolve(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "apps/*"\n  - "packages/*"\n  - "reasoner/*"\n  - "shacl/*"\n',
    );
    writeFile(resolve(root, '.node-version'), '24.17.0\n');
    writeJson(resolve(root, 'package.json'), {
        name: 'erden',
        version: '0.0.0',
        private: true,
        packageManager: 'pnpm@10.15.0',
        engines: { node: '^24', pnpm: '10.15.0' },
        devDependencies: Object.fromEntries([...profile.rootDevDependencyPins].filter(([name]) => name !== 'effect')),
    });
    const versions = new Map();
    for (const [path, name] of profile.packages) {
        const distribution = profile.distributionPackages.get(path);
        const platform = profile.platformPackages.get(path);
        versions.set(name, distribution?.manifest.version ?? platform?.version ?? '0.0.0');
    }
    for (const [path, name] of profile.packages) {
        const directory = resolve(root, path);
        writeFile(resolve(directory, 'test/index.test.ts'), 'export {};\n');
        const distribution = profile.distributionPackages.get(path);
        const platform = profile.platformPackages.get(path);
        if (distribution !== undefined) {
            for (const file of distribution.required) {
                writeFile(resolve(directory, file));
            }
            writeJson(resolve(directory, 'package.json'), distribution.manifest);
            continue;
        }
        if (platform !== undefined) {
            for (const file of ['metadata.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
                writeFile(resolve(directory, file));
            }
            if (platform.binaryCommitted === true) {
                writeFile(resolve(directory, platform.binary));
            }
            writeJson(resolve(directory, 'package.json'), platformManifest(platform));
            continue;
        }
        writeFile(resolve(directory, 'src/index.ts'), 'export {};\n');
        const runtime = profile.runtimeTypeScriptPackages.has(path);
        if (runtime) {
            writeFile(resolve(directory, 'tsconfig.runtime.json'));
        }
        const allowed = [...(profile.allowedProductionDependencies.get(name) ?? [])].filter((dependency) =>
            versions.has(dependency),
        );
        writeJson(resolve(directory, 'package.json'), {
            name,
            version: '0.0.0',
            private: true,
            license: 'Apache-2.0',
            type: 'module',
            exports: runtime ? (profile.runtimeExports.get(path) ?? RUNTIME_EXPORTS) : './src/index.ts',
            files: runtime
                ? (profile.packedFiles.get(path) ??
                  (profile.openRuntimePackages.has(path) ? ['src', 'dist', 'NOTICE'] : ['src', 'dist']))
                : ['src'],
            ...(profile.bins.has(path) ? { bin: profile.bins.get(path) } : {}),
            ...(runtime
                ? {
                      scripts: {
                          build: profile.buildScripts.get(path) ?? 'node ../../scripts/build-typescript-package.mjs',
                          prepack: 'pnpm run build',
                      },
                  }
                : {}),
            dependencies: {
                ...Object.fromEntries(
                    allowed.map((dependency) => [dependency, `workspace:${versions.get(dependency)}`]),
                ),
                effect: '4.0.0-rc.111',
            },
            engines: { node: '^24' },
        });
    }
    return root;
}

function update(root, path, change) {
    const manifestPath = resolve(root, path, 'package.json');
    const members = discoverWorkspaceMembers(root);
    const member = members.find((candidate) => candidate.path === path);
    writeJson(manifestPath, change(member.manifest));
}

describe('open workspace guard', () => {
    it('accepts a workspace made exactly of the open packages', (context) => {
        const root = createWorkspace(context);
        assert.equal(discoverWorkspaceMembers(root).length, OPEN_WORKSPACE_PROFILE.packages.size);
        assert.deepEqual(inspectWorkspace(root), []);
    });

    it('allows an exact CLI release version while keeping internal libraries at 0.0.0', (context) => {
        const root = createWorkspace(context);
        update(root, 'apps/cli', (manifest) => ({ ...manifest, version: '0.1.0' }));
        assert.deepEqual(inspectWorkspace(root), []);
        update(root, 'packages/project', (manifest) => ({ ...manifest, version: '0.1.0' }));
        assert.match(
            inspectWorkspace(root).join('\n'),
            /packages\/project\/package.json must use workspace version 0.0.0/u,
        );
    });

    it('refuses a range or a tag as the CLI release version', (context) => {
        const root = createWorkspace(context);
        for (const version of ['^0.1.0', 'latest', '../0.1.0', null, ['0.1.0']]) {
            update(root, 'apps/cli', (manifest) => ({ ...manifest, version }));
            assert.match(
                inspectWorkspace(root).join('\n'),
                /apps\/cli\/package.json must use a literal release version/u,
            );
        }
    });

    it('refuses a member the open profile does not name, and a missing one', (context) => {
        const root = createWorkspace(context);
        writeJson(resolve(root, 'packages/extra/package.json'), { name: '@erden/extra', version: '0.0.0' });
        rmSync(resolve(root, 'packages/client'), { recursive: true });
        const failures = inspectWorkspace(root).join('\n');
        assert.match(failures, /packages\/extra is not in the exact current Erden workspace roster/);
        assert.match(failures, /Required workspace package is missing: packages\/client/);
    });

    it('refuses a dependency against the package direction and an inexact version', (context) => {
        const root = createWorkspace(context);
        update(root, 'packages/contracts', (manifest) => ({
            ...manifest,
            dependencies: { ...manifest.dependencies, '@erden/project': 'workspace:0.0.0', semver: '^7.0.0' },
        }));
        const failures = inspectWorkspace(root).join('\n');
        assert.match(failures, /packages\/contracts\/package.json may not depend on @erden\/project/);
        assert.match(failures, /dependencies.semver must use a literal exact version/);
    });

    it('refuses a changed runtime export, packed file set or build script', (context) => {
        const root = createWorkspace(context);
        update(root, 'packages/contracts', (manifest) => ({ ...manifest, exports: RUNTIME_EXPORTS }));
        update(root, 'packages/client', (manifest) => ({ ...manifest, files: ['src', 'dist'] }));
        update(root, 'packages/project', (manifest) => ({
            ...manifest,
            scripts: { ...manifest.scripts, build: 'tsc' },
        }));
        const failures = inspectWorkspace(root).join('\n');
        assert.match(failures, /packages\/contracts\/package.json must expose source types/);
        assert.match(failures, /packages\/client\/package.json must pack only/);
        assert.match(
            failures,
            /packages\/project\/package.json must use the exact deterministic runtime build scripts/,
        );
    });

    it('takes a repository extension that adds members and their rules', (context) => {
        const extension = {
            packages: new Map([['packages/extra', '@erden/extra']]),
            runtimeTypeScriptPackages: ['packages/extra'],
            buildScripts: new Map([['packages/extra', 'node ../../scripts/build-extra.mjs']]),
            allowedProductionDependencies: new Map([['@erden/extra', new Set(['@erden/contracts'])]]),
        };
        const profile = extendWorkspaceProfile(OPEN_WORKSPACE_PROFILE, extension);
        const root = createWorkspace(context, profile);
        assert.deepEqual(inspectWorkspace(root, profile), []);
        assert.match(
            inspectWorkspace(root).join('\n'),
            /packages\/extra is not in the exact current Erden workspace roster/,
        );
    });

    it('accepts the first mint roster while keeping the resolver capability closed', (context) => {
        const profile = withMintedReasoner(OPEN_WORKSPACE_PROFILE);
        const root = createWorkspace(context, profile);
        assert.deepEqual(inspectWorkspace(root, profile), []);
        for (const path of [
            'reasoner/linux-x64-gnu',
            'reasoner/linux-arm64-gnu',
            'reasoner/darwin-arm64',
            'reasoner/win32-x64-msvc',
        ]) {
            assert.equal(profile.platformPackages.get(path).version, '0.3.0+purrdf.0.12.0.dfb1df7');
        }
        update(root, 'reasoner/distribution', (manifest) => ({
            ...manifest,
            dependencies: { '@erden/application': 'workspace:0.0.0' },
        }));
        assert.match(
            inspectWorkspace(root, profile).join('\n'),
            /reasoner\/distribution\/package.json must equal the exact publishable resolver manifest contract/u,
        );
    });
});

describe('open pack guard', () => {
    it('enforces the exact generated runtime set and rejects stale dist files', () => {
        const exact = [
            { path: 'package.json' },
            { path: 'src/index.ts' },
            { path: 'NOTICE' },
            ...RUNTIME_DIST_FILES.get('apps/cli').map((path) => ({ path })),
        ];
        assert.deepEqual(validatePackFiles('apps/cli', exact), []);
        assert.equal(validatePackFiles('apps/cli', [...exact, { path: 'dist/stale.js' }]).length, 2);
        assert.equal(validatePackFiles('packages/client', [...exact, { path: 'test/index.test.ts' }]).length > 0, true);
    });

    it('enforces exact resolver and platform contents', () => {
        assert.deepEqual(
            validatePackFiles(
                'shacl/linux-x64-gnu',
                [
                    { path: 'LICENSE' },
                    { path: 'NOTICE' },
                    { path: 'README.md' },
                    { path: 'THIRD-PARTY-NOTICES.md' },
                    { path: 'metadata.json' },
                    { path: 'package.json' },
                ],
                { binaryInstalled: false },
            ),
            [],
        );
        assert.equal(
            validatePackFiles('reasoner/distribution', [{ path: 'package.json' }, { path: 'bin/erden-reasoner' }])
                .length,
            1,
        );
        for (const platform of ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-arm64', 'win32-x64-msvc']) {
            const files = ['LICENSE', 'NOTICE', 'README.md', 'THIRD-PARTY-NOTICES.md', 'metadata.json', 'package.json'];
            const path = `reasoner/${platform}`;
            assert.deepEqual(
                validatePackFiles(
                    path,
                    files.map((path) => ({ path })),
                    { binaryInstalled: false },
                ),
                [],
            );
            assert.equal(
                validatePackFiles(
                    path,
                    files.map((path) => ({ path })),
                ).length,
                1,
            );
            files.push(`bin/erden-reasoner${platform === 'win32-x64-msvc' ? '.exe' : ''}`);
            assert.deepEqual(
                validatePackFiles(
                    path,
                    files.map((path) => ({ path })),
                ),
                [],
            );
        }
    });
});
