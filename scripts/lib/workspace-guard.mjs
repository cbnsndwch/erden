import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { QUALIFIED_REASONER_ARTIFACTS, REASONER_RELEASED } from '../../reasoner/distribution/src/index.js';

export const EXPECTED_NODE_ENGINE_RANGE = '^24';
export const EXPECTED_NODE_TOOLCHAIN_VERSION = '24.17.0';
export const EXPECTED_PACKAGE_MANAGER = 'pnpm@10.15.0';
export const REASONER_DISTRIBUTION_VERSION = '0.3.0+purrdf.0.12.0.dfb1df7';
export const SHACL_DISTRIBUTION_VERSION = '0.1.0+purrdf.3.0.1';

export const REQUIRED_PINS = new Map([
    ['@types/node', '24.13.3'],
    ['effect', '4.0.0-rc.111'],
    ['oxfmt', '0.67.0'],
    ['oxlint', '1.82.0'],
    ['oxlint-tsgolint', '7.0.2001'],
    ['turbo', '2.10.12'],
    ['typescript', '7.0.2'],
    ['vitest', '4.1.11'],
]);

/**
 * Which workspace packages exist and what each must look like. `OPEN_WORKSPACE_PROFILE` describes the open tree; a
 * repository with more packages passes a profile extended with `extendWorkspaceProfile`.
 */
const currentPackages = new Map([
    ['apps/cli', '@erden/cli'],
    ['packages/client', '@erden/client'],
    ['packages/contracts', '@erden/contracts'],
    ['packages/ontology', '@erden/ontology'],
    ['packages/package-format', '@erden/package-format'],
    ['packages/project', '@erden/project'],
    ['reasoner/distribution', '@erden/reasoner-distribution'],
    ['reasoner/protocol', '@erden/reasoner-protocol'],
    ['shacl/darwin-arm64', '@erden/shacl-darwin-arm64'],
    ['shacl/distribution', '@erden/shacl-distribution'],
    ['shacl/linux-arm64-gnu', '@erden/shacl-linux-arm64-gnu'],
    ['shacl/linux-x64-gnu', '@erden/shacl-linux-x64-gnu'],
    ['shacl/win32-x64-msvc', '@erden/shacl-win32-x64-msvc'],
]);

const runtimeTypeScriptPackages = new Set([
    'apps/cli',
    'packages/client',
    'packages/contracts',
    'packages/ontology',
    'packages/package-format',
    'packages/project',
    'reasoner/protocol',
]);

/** Open (Apache-2.0) runtime packages: they also pack NOTICE, as Apache-2.0 section 4(d) requires. */
const openRuntimePackages = new Set([
    'apps/cli',
    'packages/client',
    'packages/contracts',
    'packages/ontology',
    'packages/package-format',
    'packages/project',
    'reasoner/protocol',
]);

export const RUNTIME_EXPORTS = {
    '.': {
        types: './src/index.ts',
        development: './src/index.ts',
        default: './dist/index.js',
    },
};

/** The narrow entry the capability-closed authorization core uses: the registry origin rule and nothing else. */
const contractsRuntimeExports = {
    ...RUNTIME_EXPORTS,
    './registry-origin': {
        types: './src/manifest/registry-origin.ts',
        development: './src/manifest/registry-origin.ts',
        default: './dist/manifest/registry-origin.js',
    },
};

const allowedProductionDependencies = new Map([
    ['@erden/cli', new Set(['@erden/client', '@erden/contracts', '@erden/project'])],
    ['@erden/client', new Set(['@erden/contracts'])],
    ['@erden/contracts', new Set(['@erden/ontology', '@erden/package-format', '@erden/reasoner-protocol'])],
    [
        '@erden/ontology',
        new Set(['@erden/reasoner-distribution', '@erden/reasoner-protocol', '@erden/shacl-distribution']),
    ],
    ['@erden/package-format', new Set()],
    ['@erden/project', new Set(['@erden/contracts', '@erden/ontology', '@erden/package-format'])],
    ['@erden/reasoner-protocol', new Set()],
    ['@erden/reasoner-distribution', new Set()],
    [
        '@erden/shacl-distribution',
        new Set([
            '@erden/shacl-darwin-arm64',
            '@erden/shacl-linux-arm64-gnu',
            '@erden/shacl-linux-x64-gnu',
            '@erden/shacl-win32-x64-msvc',
        ]),
    ],
    ['@erden/shacl-darwin-arm64', new Set()],
    ['@erden/shacl-linux-arm64-gnu', new Set()],
    ['@erden/shacl-linux-x64-gnu', new Set()],
    ['@erden/shacl-win32-x64-msvc', new Set()],
]);

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const directionDependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const platformPackages = new Map([
    [
        'shacl/darwin-arm64',
        {
            name: '@erden/shacl-darwin-arm64',
            tool: 'erden-shacl',
            version: SHACL_DISTRIBUTION_VERSION,
            description: 'Qualified Erden SHACL engine for macOS arm64 (Apple silicon)',
            os: ['darwin'],
            cpu: ['arm64'],
            binary: 'bin/erden-shacl',
        },
    ],
    [
        'shacl/linux-arm64-gnu',
        {
            name: '@erden/shacl-linux-arm64-gnu',
            tool: 'erden-shacl',
            version: SHACL_DISTRIBUTION_VERSION,
            description: 'Qualified Erden SHACL engine for Linux arm64 (glibc)',
            os: ['linux'],
            cpu: ['arm64'],
            libc: ['glibc'],
            binary: 'bin/erden-shacl',
        },
    ],
    [
        'shacl/linux-x64-gnu',
        {
            name: '@erden/shacl-linux-x64-gnu',
            tool: 'erden-shacl',
            version: SHACL_DISTRIBUTION_VERSION,
            description: 'Qualified Erden SHACL engine for Linux x64 (glibc)',
            os: ['linux'],
            cpu: ['x64'],
            libc: ['glibc'],
            binary: 'bin/erden-shacl',
        },
    ],
    [
        'shacl/win32-x64-msvc',
        {
            name: '@erden/shacl-win32-x64-msvc',
            tool: 'erden-shacl',
            version: SHACL_DISTRIBUTION_VERSION,
            description: 'Qualified Erden SHACL engine for Windows x64 (MSVC)',
            os: ['win32'],
            cpu: ['x64'],
            binary: 'bin/erden-shacl.exe',
        },
    ],
]);

export function optionalPlatformDependencies(prefix, version) {
    return Object.fromEntries(
        ['darwin-arm64', 'linux-arm64-gnu', 'linux-x64-gnu', 'win32-x64-msvc'].map((platform) => [
            `@erden/${prefix}-${platform}`,
            `workspace:${version}`,
        ]),
    );
}

export function platformManifest(platform) {
    return {
        name: platform.name,
        version: platform.version,
        description: platform.description,
        license: 'Apache-2.0',
        type: 'module',
        files: ['bin', 'metadata.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'],
        bin: { [platform.tool]: platform.binary },
        os: platform.os,
        cpu: platform.cpu,
        ...(platform.libc === undefined ? {} : { libc: platform.libc }),
        engines: { node: EXPECTED_NODE_ENGINE_RANGE },
    };
}

/** The two resolver packages (reasoner and SHACL engine), each with its exact manifest and required files. */
const distributionPackages = new Map([
    [
        'reasoner/distribution',
        {
            manifest: {
                name: '@erden/reasoner-distribution',
                version: REASONER_DISTRIBUTION_VERSION,
                description: 'Offline resolver and integrity doctor for the Erden reasoner',
                license: 'Apache-2.0',
                type: 'module',
                files: ['src', 'fixtures', 'README.md', 'LICENSE', 'NOTICE'],
                exports: { '.': { types: './src/index.d.ts', default: './src/index.js' } },
                engines: { node: EXPECTED_NODE_ENGINE_RANGE },
                // Unreleased (release.yml): it runs the reasoner built from source instead.
            },
            required: [
                'src/index.js',
                'src/index.d.ts',
                'src/artifacts.js',
                'fixtures/known-answer.request.json',
                'README.md',
                'LICENSE',
                'NOTICE',
                'server-image-handoff.json',
                'test/index.test.ts',
            ],
        },
    ],
    [
        'shacl/distribution',
        {
            manifest: {
                name: '@erden/shacl-distribution',
                version: SHACL_DISTRIBUTION_VERSION,
                description: 'Offline resolver and integrity doctor for the qualified Erden SHACL engine',
                license: 'Apache-2.0',
                type: 'module',
                files: ['src', 'fixtures', 'README.md', 'LICENSE', 'NOTICE'],
                exports: { '.': { types: './src/index.d.ts', default: './src/index.js' } },
                engines: { node: EXPECTED_NODE_ENGINE_RANGE },
                optionalDependencies: optionalPlatformDependencies('shacl', SHACL_DISTRIBUTION_VERSION),
            },
            required: [
                'src/index.js',
                'src/index.d.ts',
                'src/artifacts.js',
                'fixtures/known-answer.request.json',
                'README.md',
                'LICENSE',
                'NOTICE',
                'test/index.test.ts',
            ],
        },
    ],
]);

const unmintedWorkspaceProfile = Object.freeze({
    /** Every member, by path, and the package name it must have. */
    packages: currentPackages,
    /** Members built from TypeScript into `dist/` with the runtime `exports`. */
    runtimeTypeScriptPackages,
    /** Runtime members that also pack NOTICE. */
    openRuntimePackages,
    /** Members whose `exports` differ from the runtime default. */
    runtimeExports: new Map([['packages/contracts', contractsRuntimeExports]]),
    /** Members whose packed `files` differ from the runtime default. */
    packedFiles: new Map(),
    /** Members whose build script differs from `node ../../scripts/build-typescript-package.mjs`. */
    buildScripts: new Map(),
    /** The exact `bin` of members that have one. */
    bins: new Map([['apps/cli', { erden: './dist/bin.js', den: './dist/bin.js' }]]),
    /** The workspace packages each package may depend on at runtime. */
    allowedProductionDependencies,
    /** Platform packages: their exact manifest inputs; `binaryCommitted` when the binary is in git. */
    platformPackages,
    /** The resolver packages, with their exact manifests and required files. */
    distributionPackages,
    /** Root devDependencies and their exact versions. */
    rootDevDependencyPins: REQUIRED_PINS,
    /** Exact versions any manifest must use for these packages. */
    packagePins: new Map(),
    /** External packages no workspace member may be named after. */
    architectureExternalPackages: new Set(REQUIRED_PINS.keys()),
});

/** The first mint adds four source-only platform packages and the resolver's exact optional dependencies. */
export function withMintedReasoner(profile) {
    const entries = Object.values(QUALIFIED_REASONER_ARTIFACTS).map((anchor) => {
        const directory = anchor.packageName.slice('@erden/'.length).replace(/^reasoner-/u, '');
        return [
            `reasoner/${directory}`,
            {
                name: anchor.packageName,
                tool: 'erden-reasoner',
                version: REASONER_DISTRIBUTION_VERSION,
                description: anchor.description,
                os: [anchor.runtime.os],
                cpu: [anchor.runtime.cpu],
                ...(anchor.runtime.libc === undefined ? {} : { libc: [anchor.runtime.libc] }),
                binary: anchor.binaryPath,
            },
        ];
    });
    const distribution = profile.distributionPackages.get('reasoner/distribution');
    return extendWorkspaceProfile(profile, {
        packages: new Map(entries.map(([path, platform]) => [path, platform.name])),
        platformPackages: new Map(entries),
        allowedProductionDependencies: new Map([
            ['@erden/reasoner-distribution', new Set(entries.map(([, platform]) => platform.name))],
            ...entries.map(([, platform]) => [platform.name, new Set()]),
        ]),
        distributionPackages: new Map([
            [
                'reasoner/distribution',
                {
                    ...distribution,
                    manifest: {
                        ...distribution.manifest,
                        optionalDependencies: optionalPlatformDependencies('reasoner', REASONER_DISTRIBUTION_VERSION),
                    },
                },
            ],
        ]),
    });
}

export const OPEN_WORKSPACE_PROFILE = REASONER_RELEASED
    ? withMintedReasoner(unmintedWorkspaceProfile)
    : unmintedWorkspaceProfile;

function mergeMaps(left, right) {
    return new Map([...left, ...(right ?? [])]);
}

/** `base` with `extension`'s entries added (an extension's entry replaces a base entry with the same key). */
export function extendWorkspaceProfile(base, extension) {
    return Object.freeze({
        packages: mergeMaps(base.packages, extension.packages),
        runtimeTypeScriptPackages: new Set([
            ...base.runtimeTypeScriptPackages,
            ...(extension.runtimeTypeScriptPackages ?? []),
        ]),
        openRuntimePackages: new Set([...base.openRuntimePackages, ...(extension.openRuntimePackages ?? [])]),
        runtimeExports: mergeMaps(base.runtimeExports, extension.runtimeExports),
        packedFiles: mergeMaps(base.packedFiles, extension.packedFiles),
        buildScripts: mergeMaps(base.buildScripts, extension.buildScripts),
        bins: mergeMaps(base.bins, extension.bins),
        allowedProductionDependencies: mergeMaps(
            base.allowedProductionDependencies,
            extension.allowedProductionDependencies,
        ),
        platformPackages: mergeMaps(base.platformPackages, extension.platformPackages),
        distributionPackages: mergeMaps(base.distributionPackages, extension.distributionPackages),
        rootDevDependencyPins: mergeMaps(base.rootDevDependencyPins, extension.rootDevDependencyPins),
        packagePins: mergeMaps(base.packagePins, extension.packagePins),
        architectureExternalPackages: new Set([
            ...base.architectureExternalPackages,
            ...(extension.architectureExternalPackages ?? []),
        ]),
    });
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
function portablePath(root, path) {
    return relative(root, path).replaceAll('\\', '/');
}

export function readDeclaredWorkspacePatterns(root) {
    const workspacePath = resolve(root, 'pnpm-workspace.yaml');
    const lines = readFileSync(workspacePath, 'utf8').split(/\r?\n/);
    const patterns = [];
    let inPackages = false;
    for (const line of lines) {
        if (/^packages:\s*(?:#.*)?$/.test(line)) {
            inPackages = true;
            continue;
        }
        if (!inPackages) {
            continue;
        }
        if (/^[^\s#]/.test(line)) {
            break;
        }
        const match = line.match(/^\s+-\s+(["']?)([^"'#]+)\1\s*(?:#.*)?$/);
        if (match) {
            patterns.push(match[2].trim());
        }
    }
    return patterns;
}

export function discoverWorkspaceMembers(root) {
    const members = [];
    const patterns = readDeclaredWorkspacePatterns(root);
    for (const pattern of patterns) {
        if (pattern.startsWith('!')) {
            continue;
        }
        const match = pattern.match(/^([^*!?[\]{}]+)\/\*$/);
        if (!match) {
            throw new Error(`Only declared one-level workspace patterns are supported: ${pattern}`);
        }
        const parent = resolve(root, match[1]);
        if (!existsSync(parent)) {
            continue;
        }
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const directory = resolve(parent, entry.name);
            const manifestPath = resolve(directory, 'package.json');
            if (!existsSync(manifestPath)) {
                continue;
            }
            members.push({
                directory,
                manifest: readJson(manifestPath),
                manifestPath,
                path: portablePath(root, directory),
            });
        }
    }
    return members.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function inspectWorkspace(root, profile = OPEN_WORKSPACE_PROFILE) {
    const failures = [];
    let members;
    try {
        members = discoverWorkspaceMembers(root);
    } catch (error) {
        return [`pnpm-workspace.yaml is invalid: ${error.message}`];
    }
    let rootManifest;
    try {
        rootManifest = readJson(resolve(root, 'package.json'));
    } catch (error) {
        return [`package.json is invalid JSON: ${error.message}`];
    }
    const byName = new Map();
    for (const member of members) {
        const { manifest, path } = member;
        const expectedName = profile.packages.get(path);
        if (!expectedName) {
            failures.push(`${path} is not in the exact current Erden workspace roster`);
        }
        if (expectedName && manifest.name !== expectedName) {
            failures.push(`${path}/package.json must use workspace identity ${expectedName}`);
        }
        if (typeof manifest.name !== 'string') {
            failures.push(`${path}/package.json must define a package name`);
        } else {
            if (profile.architectureExternalPackages.has(manifest.name)) {
                failures.push(`${path}/package.json collides with architecture dependency ${manifest.name}`);
            }
            const prior = byName.get(manifest.name);
            if (prior) {
                failures.push(`${path}/package.json duplicates workspace identity ${manifest.name} from ${prior}`);
            } else {
                byName.set(manifest.name, path);
            }
        }
        const platform = profile.platformPackages.get(path);
        const distribution = profile.distributionPackages.get(path);
        if (platform) {
            if (!isDeepStrictEqual(manifest, platformManifest(platform))) {
                failures.push(`${path}/package.json must equal the exact publishable platform manifest contract`);
            }
            // Binaries are built, not committed; a platform package whose binary is in git says so.
            for (const requiredPath of [
                ...(platform.binaryCommitted === true ? [platform.binary] : []),
                'metadata.json',
                'README.md',
                'LICENSE',
                'NOTICE',
                'THIRD-PARTY-NOTICES.md',
                'test/index.test.ts',
            ]) {
                if (!existsSync(resolve(member.directory, requiredPath))) {
                    failures.push(`${path}/${requiredPath} is missing`);
                }
            }
        } else if (distribution) {
            if (!isDeepStrictEqual(manifest, distribution.manifest)) {
                failures.push(`${path}/package.json must equal the exact publishable resolver manifest contract`);
            }
            for (const requiredPath of distribution.required) {
                if (!existsSync(resolve(member.directory, requiredPath))) {
                    failures.push(`${path}/${requiredPath} is missing`);
                }
            }
        } else {
            // The CLI's archive and tag share its release version; internal library versions remain workspace-only.
            if (path === 'apps/cli' && (typeof manifest.version !== 'string' || !exactVersion.test(manifest.version))) {
                failures.push(`${path}/package.json must use a literal release version`);
            } else if (path !== 'apps/cli' && manifest.version !== '0.0.0') {
                failures.push(`${path}/package.json must use workspace version 0.0.0`);
            }
            if (manifest.private !== true) {
                failures.push(`${path}/package.json must remain private`);
            }
            if (manifest.type !== 'module') {
                failures.push(`${path}/package.json must use ESM`);
            }
            if (profile.runtimeTypeScriptPackages.has(path)) {
                const expectedExports = profile.runtimeExports.get(path) ?? RUNTIME_EXPORTS;
                if (!isDeepStrictEqual(manifest.exports, expectedExports)) {
                    failures.push(
                        `${path}/package.json must expose source types/development and compiled runtime exports`,
                    );
                }
                const expectedFiles =
                    profile.packedFiles.get(path) ??
                    (profile.openRuntimePackages.has(path) ? ['src', 'dist', 'NOTICE'] : ['src', 'dist']);
                if (!isDeepStrictEqual(manifest.files, expectedFiles)) {
                    failures.push(
                        `${path}/package.json must pack only its source, generated runtime, and owned migrations`,
                    );
                }
                const expectedBuild =
                    profile.buildScripts.get(path) ?? 'node ../../scripts/build-typescript-package.mjs';
                if (manifest.scripts?.build !== expectedBuild || manifest.scripts?.prepack !== 'pnpm run build') {
                    failures.push(`${path}/package.json must use the exact deterministic runtime build scripts`);
                }
                if (!existsSync(resolve(member.directory, 'tsconfig.runtime.json'))) {
                    failures.push(`${path}/tsconfig.runtime.json is missing`);
                }
            } else {
                if (manifest.exports !== './src/index.ts') {
                    failures.push(`${path}/package.json must export ./src/index.ts`);
                }
                if (JSON.stringify(manifest.files) !== JSON.stringify(['src'])) {
                    failures.push(`${path}/package.json must pack only the src allowlist`);
                }
            }
            for (const requiredPath of ['src/index.ts', 'test/index.test.ts']) {
                if (!existsSync(resolve(member.directory, requiredPath))) {
                    failures.push(`${path}/${requiredPath} is missing`);
                }
            }
            const expectedBin = profile.bins.get(path);
            if (
                expectedBin === undefined ? manifest.bin !== undefined : !isDeepStrictEqual(manifest.bin, expectedBin)
            ) {
                failures.push(`${path}/package.json must expose exactly its compiled executables`);
            }
        }
        if (manifest.engines?.node !== EXPECTED_NODE_ENGINE_RANGE) {
            failures.push(`${path}/package.json must declare engines.node as ${EXPECTED_NODE_ENGINE_RANGE}`);
        }
    }
    for (const [path, name] of profile.packages) {
        const member = members.find((candidate) => candidate.path === path);
        if (!member) {
            failures.push(`Required workspace package is missing: ${path}`);
        } else if (member.manifest.name !== name) {
            failures.push(`${path} must provide ${name}`);
        }
    }
    const manifests = [
        { manifest: rootManifest, path: 'package.json' },
        ...members.map((member) => ({
            manifest: member.manifest,
            path: `${member.path}/package.json`,
        })),
    ];
    const workspaceByName = new Map(members.map((member) => [member.manifest.name, member]));
    const workspaceNames = new Set(workspaceByName.keys());
    for (const { manifest, path } of manifests) {
        if (manifest.engines?.node !== EXPECTED_NODE_ENGINE_RANGE) {
            failures.push(`${path} must declare engines.node as ${EXPECTED_NODE_ENGINE_RANGE}`);
        }
        for (const field of dependencyFields) {
            for (const [name, version] of Object.entries(manifest[field] ?? {})) {
                if (typeof version !== 'string') {
                    failures.push(`${path} ${field}.${name} must be a string version`);
                    continue;
                }
                if (version.startsWith('workspace:')) {
                    const workspaceVersion = version.slice('workspace:'.length);
                    const target = workspaceByName.get(name);
                    if (!target) {
                        failures.push(
                            `${path} ${field}.${name} uses the workspace protocol for a non-workspace package`,
                        );
                    }
                    if (!exactVersion.test(workspaceVersion)) {
                        failures.push(
                            `${path} ${field}.${name} must use an exact workspace version (found ${version})`,
                        );
                    } else if (target && workspaceVersion !== target.manifest.version) {
                        failures.push(
                            `${path} ${field}.${name} must match workspace version ${target.manifest.version}`,
                        );
                    }
                    continue;
                }
                if (workspaceNames.has(name)) {
                    failures.push(`${path} ${field}.${name} must use the workspace protocol with an exact version`);
                }
                if (!exactVersion.test(version)) {
                    failures.push(`${path} ${field}.${name} must use a literal exact version (found ${version})`);
                }
                const requiredVersion = profile.rootDevDependencyPins.get(name) ?? profile.packagePins.get(name);
                if (requiredVersion && version !== requiredVersion) {
                    failures.push(`${path} ${field}.${name} must be pinned to ${requiredVersion}`);
                }
            }
        }
    }
    for (const member of members) {
        for (const field of directionDependencyFields) {
            for (const dependency of Object.keys(member.manifest[field] ?? {})) {
                if (!workspaceNames.has(dependency)) {
                    continue;
                }
                const allowed = profile.allowedProductionDependencies.get(member.manifest.name);
                if (allowed !== '*' && !allowed?.has(dependency)) {
                    failures.push(
                        `${member.path}/package.json may not depend on ${dependency}; that violates Erden package direction`,
                    );
                }
            }
        }
    }
    if (rootManifest.packageManager !== EXPECTED_PACKAGE_MANAGER) {
        failures.push(`package.json must pin packageManager to ${EXPECTED_PACKAGE_MANAGER}`);
    }
    if (rootManifest.engines?.pnpm !== '10.15.0') {
        failures.push('package.json must pin engines.pnpm to 10.15.0');
    }
    for (const [name, version] of profile.rootDevDependencyPins) {
        if (name === 'effect') {
            continue;
        }
        if (rootManifest.devDependencies?.[name] !== version) {
            failures.push(`package.json devDependencies.${name} must be pinned to ${version}`);
        }
    }
    const nodeVersionPath = resolve(root, '.node-version');
    if (!existsSync(nodeVersionPath)) {
        failures.push('.node-version is missing');
    } else if (readFileSync(nodeVersionPath, 'utf8').trim() !== EXPECTED_NODE_TOOLCHAIN_VERSION) {
        failures.push(`.node-version must contain ${EXPECTED_NODE_TOOLCHAIN_VERSION}`);
    }
    return failures;
}
