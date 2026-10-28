import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REASONER_RELEASED } from '../reasoner/distribution/src/index.js';

import { cleanupTestTempRoot, makeTestTempRoot } from './lib/test-temp-root.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const packagePaths = [
    'reasoner/protocol',
    'packages/package-format',
    'packages/ontology',
    'packages/contracts',
    'packages/project',
    'packages/client',
    'apps/cli',
    'reasoner/distribution',
    // An unreleased reasoner has no platform package: the packed CLI runs the source build named below.
    ...(REASONER_RELEASED ? [currentPlatformPackage('reasoner')] : []),
    'shacl/distribution',
    currentPlatformPackage('shacl'),
];
/** While the reasoner is unreleased (release.yml), the packed CLI runs the workspace's build. */
const reasonerEnvironment = REASONER_RELEASED
    ? {}
    : {
          ERDEN_REASONER_BIN:
              process.env.ERDEN_REASONER_BIN ||
              resolve(workspaceRoot, 'reasoner/target/release', isWindows ? 'erden-reasoner.exe' : 'erden-reasoner'),
      };

/** The one platform package of the reasoner or the SHACL engine this runtime installs. */
function currentPlatformPackage(tool) {
    const directory = {
        'win32:x64': `${tool}/win32-x64-msvc`,
        'linux:x64': `${tool}/linux-x64-gnu`,
        'linux:arm64': `${tool}/linux-arm64-gnu`,
        'darwin:arm64': `${tool}/darwin-arm64`,
    }[`${process.platform}:${process.arch}`];
    if (directory === undefined) {
        throw new Error(`No bundled ${tool} package for ${process.platform} ${process.arch}`);
    }
    return directory;
}

function command(program, arguments_, options = {}) {
    const executable = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : program;
    function quoteWindows(part) {
        return /\s/u.test(part) ? `"${part.replaceAll('"', '""')}"` : part;
    }
    const commandArguments = isWindows
        ? ['/d', '/s', '/c', [program, ...arguments_].map(quoteWindows).join(' ')]
        : arguments_;
    return spawnSync(executable, commandArguments, {
        encoding: 'utf8',
        timeout: 120000,
        ...options,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ...reasonerEnvironment, ...options.env },
    });
}

function requireSuccess(result, label) {
    if (result.status !== 0) {
        throw new Error(
            `${label} failed (${String(result.status)}): ${result.stderr || result.stdout || result.error?.message || 'no output'}`,
        );
    }
    return result;
}

function requireCliSuccess(result, label, installRoot) {
    requireSuccess(result, label);
    if (result.stderr !== '') {
        throw new Error(`${label} wrote unexpected stderr`);
    }
    if (
        `${result.stdout}${result.stderr}`.includes(workspaceRoot) ||
        `${result.stdout}${result.stderr}`.includes(installRoot)
    ) {
        throw new Error(`${label} leaked a physical path`);
    }
    return result.stdout;
}

function parsePackResult(stdout) {
    for (const marker of ['\n{\n  "name":', '\n[\n  {']) {
        const index = stdout.lastIndexOf(marker);
        if (index >= 0) {
            return JSON.parse(stdout.slice(index + 1));
        }
    }
    return JSON.parse(stdout);
}

function isContained(root, candidate) {
    const fragment = relative(root, candidate);
    return (
        fragment.length > 0 &&
        fragment !== '..' &&
        !fragment.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    );
}

const packRoot = makeTestTempRoot('erden-cli-packs-');
const installRoots = [];
try {
    const packs = [];
    for (const packagePath of packagePaths) {
        const output = requireSuccess(
            command('pnpm', ['pack', '--json', '--pack-destination', packRoot], {
                cwd: resolve(workspaceRoot, packagePath),
            }),
            `pack ${packagePath}`,
        ).stdout;
        const record = parsePackResult(output);
        const tarball = resolve(packRoot, record.filename);
        if (!isContained(packRoot, tarball) || !existsSync(tarball)) {
            throw new Error(`pack ${packagePath} returned a tarball outside the pack root`);
        }
        packs.push({ name: record.name, tarball });
    }

    for (const manager of ['npm', 'pnpm']) {
        const installRoot = makeTestTempRoot(`erden-cli-${manager}-install-`);
        installRoots.push(installRoot);
        const localPackages = Object.fromEntries(
            packs.map(({ name, tarball }) => [name, `file:${tarball.replaceAll('\\', '/')}`]),
        );
        writeFileSync(
            resolve(installRoot, 'package.json'),
            `${JSON.stringify(
                {
                    name: `erden-cli-${manager}-install-test`,
                    version: '0.0.0',
                    private: true,
                    packageManager: 'pnpm@10.15.0',
                    dependencies: localPackages,
                    ...(manager === 'pnpm' ? { pnpm: { overrides: localPackages } } : {}),
                },
                null,
                2,
            )}\n`,
        );
        const installArguments =
            manager === 'npm'
                ? ['install', '--ignore-scripts', '--no-audit', '--no-fund']
                : ['install', '--ignore-scripts'];
        requireSuccess(command(manager, installArguments, { cwd: installRoot }), `${manager} packed install`);

        for (const name of [
            '@erden/reasoner-protocol',
            '@erden/package-format',
            '@erden/ontology',
            '@erden/contracts',
            '@erden/project',
            '@erden/client',
            '@erden/cli',
        ]) {
            const packageRoot = realpathSync(resolve(installRoot, 'node_modules', ...name.split('/')));
            if (!isContained(installRoot, packageRoot)) {
                throw new Error(`${manager} installed ${name} outside the fresh install root`);
            }
            const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
            if (manifest.exports?.['.']?.default !== './dist/index.js') {
                throw new Error(`${manager} installed ${name} without a compiled default export`);
            }
            for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
                if (
                    Object.values(manifest[field] ?? {}).some(
                        (version) => typeof version !== 'string' || version.startsWith('workspace:'),
                    )
                ) {
                    throw new Error(`${manager} installed ${name} with a workspace dependency specifier`);
                }
            }
        }

        const comparisonProbe = resolve(installRoot, 'comparison-probe.mjs');
        writeFileSync(
            comparisonProbe,
            String.raw`
import assert from 'node:assert/strict';
import { normalizeRdfComparison } from '@erden/ontology';
const result = await normalizeRdfComparison('_:a <urn:p> "packed" .\n_:b <urn:p> "packed" .\n');
assert.equal(result.kind, 'complete');
assert.equal(result.quadCount, 2);
assert.equal(result.components.length, 1);
assert.equal(result.components[0].multiplicity, 2);
`,
        );
        requireCliSuccess(
            command('node', [comparisonProbe], { cwd: installRoot }),
            `${manager} packed RDF comparison worker`,
            installRoot,
        );

        const bin = resolve(installRoot, 'node_modules', '.bin', isWindows ? 'erden.cmd' : 'erden');
        const binStat = existsSync(bin) ? lstatSync(bin) : null;
        if (
            binStat === null ||
            (!binStat.isFile() && !binStat.isSymbolicLink()) ||
            !isContained(installRoot, realpathSync(bin))
        ) {
            throw new Error(`${manager} did not install a contained erden executable shim`);
        }
        const authenticationHelp = requireCliSuccess(
            command(bin, ['help'], { cwd: installRoot }),
            `${manager} packed help`,
            installRoot,
        );
        if (
            !authenticationHelp.includes('erden login [--registry <origin>]') ||
            !authenticationHelp.includes('erden logout [--registry <origin>]') ||
            !authenticationHelp.includes('erden publish <version> [project-dir]') ||
            !authenticationHelp.includes('erden publication <attempt-id> [--registry <origin>]') ||
            !authenticationHelp.includes(
                'erden query <identifier>@<version> (--file <path> | --stdin) [--registry <origin>]',
            ) ||
            !authenticationHelp.includes(
                'Add, install, login, logout, publish, publication status, and query use one origin-scoped credential when present.',
            ) ||
            authenticationHelp.includes('Add/install registry composition remains unavailable.')
        ) {
            throw new Error(`${manager} packed CLI omitted the origin-scoped authentication or publication commands`);
        }
        const alias = resolve(installRoot, 'node_modules', '.bin', isWindows ? 'den.cmd' : 'den');
        if (!existsSync(alias) || !isContained(installRoot, realpathSync(alias))) {
            throw new Error(`${manager} did not install a contained den executable shim`);
        }
        const aliasHelp = requireCliSuccess(
            command(alias, ['help'], { cwd: installRoot }),
            `${manager} packed den help`,
            installRoot,
        );
        if (aliasHelp !== authenticationHelp || !aliasHelp.includes('also available as den')) {
            throw new Error(`${manager} packed den alias did not run the same CLI`);
        }
        const doctor = requireCliSuccess(
            command(bin, ['doctor', '--json'], { cwd: installRoot }),
            `${manager} packed doctor`,
            installRoot,
        );
        const doctorReport = JSON.parse(doctor);
        if (
            doctorReport.outcome !== 'passed' ||
            doctorReport.reasoner?.selfTest?.status !== 'passed' ||
            doctorReport.shaclEngine?.selfTest?.status !== 'passed'
        ) {
            throw new Error(`${manager} packed doctor did not pass the real known-answer test`);
        }
        if (
            doctor.includes(workspaceRoot) ||
            doctor.includes('node_modules\\@erden\\reasoner') ||
            doctor.includes('node_modules/@erden/reasoner') ||
            doctor.includes('node_modules\\@erden\\shacl') ||
            doctor.includes('node_modules/@erden/shacl')
        ) {
            throw new Error(`${manager} packed doctor leaked a physical package path`);
        }
        requireCliSuccess(
            command(bin, ['init', 'project', '--json'], { cwd: installRoot }),
            `${manager} packed init`,
            installRoot,
        );
        const packedProject = requireSuccess(
            command(bin, ['pack', '1.2.3', 'project', '--json'], { cwd: installRoot }),
            `${manager} packed project`,
        );
        if (packedProject.stderr !== '') {
            throw new Error(`${manager} packed project wrote unexpected stderr`);
        }
        const packedProjectReport = JSON.parse(packedProject.stdout);
        const expectedArchivePath = resolve(installRoot, 'example-project-1.2.3.erdenpkg');
        if (
            packedProjectReport.outcome !== 'packed' ||
            packedProjectReport.output?.status !== 'written' ||
            packedProjectReport.output?.path !== expectedArchivePath ||
            !isContained(installRoot, packedProjectReport.output.path) ||
            !existsSync(expectedArchivePath)
        ) {
            throw new Error(`${manager} packed project did not publish the deterministic sibling archive`);
        }
        const packedArchive = readFileSync(expectedArchivePath);
        if (createHash('sha256').update(packedArchive).digest('hex') !== packedProjectReport.archive?.sha256) {
            throw new Error(`${manager} packed project report did not authenticate its archive bytes`);
        }
        const packedHit = requireSuccess(
            command(bin, ['pack', '1.2.3', 'project', '--json'], { cwd: installRoot }),
            `${manager} packed project hit`,
        );
        if (packedHit.stderr !== '' || JSON.parse(packedHit.stdout).output?.status !== 'hit') {
            throw new Error(`${manager} packed project did not report an exact idempotent hit`);
        }
        const unavailablePublish = command(bin, ['publish', '1.2.3', 'project', '--json'], { cwd: installRoot });
        if (
            unavailablePublish.status !== 3 ||
            unavailablePublish.stdout !== '' ||
            unavailablePublish.stderr !== 'Erden publish could not complete [CLI_PUBLISH_FAILED]\n' ||
            `${unavailablePublish.stdout}${unavailablePublish.stderr}`.includes(workspaceRoot) ||
            `${unavailablePublish.stdout}${unavailablePublish.stderr}`.includes(installRoot)
        ) {
            throw new Error(
                `${manager} packed publish did not fail closed without a manifest registry or leak-free output`,
            );
        }
        const invalidPublication = command(bin, ['publication', '../attempt'], { cwd: installRoot });
        if (
            invalidPublication.status !== 2 ||
            invalidPublication.stdout !== '' ||
            !invalidPublication.stderr.includes('publication requires one canonical attempt id') ||
            `${invalidPublication.stdout}${invalidPublication.stderr}`.includes(workspaceRoot) ||
            `${invalidPublication.stdout}${invalidPublication.stderr}`.includes(installRoot)
        ) {
            throw new Error(
                `${manager} packed publication did not preserve its strict parser and path-safe usage contract`,
            );
        }
        const normal = requireCliSuccess(
            command(bin, ['check', 'project', '--json'], { cwd: installRoot }),
            `${manager} packed check`,
            installRoot,
        );
        const offline = requireCliSuccess(
            command(bin, ['check', 'project', '--offline', '--json'], { cwd: installRoot }),
            `${manager} packed offline check`,
            installRoot,
        );
        if (normal !== offline || JSON.parse(offline).outcome !== 'passed') {
            throw new Error(`${manager} packed check was not deterministic and green offline`);
        }
        const dataRoot = resolve(installRoot, 'user-data');
        const localEnvironment = isWindows ? { LOCALAPPDATA: dataRoot } : { XDG_DATA_HOME: dataRoot };
        const storePath = requireSuccess(
            command(bin, ['store', 'path', '--json'], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed store path`,
        );
        if (storePath.stderr !== '') {
            throw new Error(`${manager} packed store path wrote unexpected stderr`);
        }
        const storePathReport = JSON.parse(storePath.stdout);
        if (
            storePathReport.outcome !== 'resolved' ||
            typeof storePathReport.storeRoot !== 'string' ||
            !isAbsolute(storePathReport.storeRoot) ||
            !isContained(dataRoot, storePathReport.storeRoot)
        ) {
            throw new Error(`${manager} packed store path did not return the injected user-data store root`);
        }
        const initialStatus = requireCliSuccess(
            command(bin, ['store', 'status', '--json'], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed initial store status`,
            installRoot,
        );
        if (JSON.parse(initialStatus).outcome !== 'healthy' || existsSync(storePathReport.storeRoot)) {
            throw new Error(
                `${manager} packed store status did not preserve a missing store as read-only healthy state`,
            );
        }
        const initialDryRun = requireCliSuccess(
            command(bin, ['store', 'prune', '--dry-run', '--json'], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed initial store prune dry run`,
            installRoot,
        );
        if (JSON.parse(initialDryRun).outcome !== 'nothing-to-prune' || existsSync(storePathReport.storeRoot)) {
            throw new Error(`${manager} packed store prune dry run mutated a missing store`);
        }
        const emptyUpdate = requireCliSuccess(
            command(bin, ['update', '--json'], {
                cwd: resolve(installRoot, 'project'),
                env: localEnvironment,
            }),
            `${manager} packed empty update`,
            installRoot,
        );
        const emptyUpdateReport = JSON.parse(emptyUpdate);
        if (
            emptyUpdateReport.strategy !== 'full-graph' ||
            emptyUpdateReport.state?.status !== 'unchanged' ||
            !['unchanged', 'healed'].includes(emptyUpdateReport.outcome)
        ) {
            throw new Error(`${manager} packed empty update did not heal without a dependency-state write`);
        }

        const dependencyProject = resolve(installRoot, 'dependency-project');
        const helper = resolve(installRoot, 'prepare-dependency-fixture.mjs');
        writeFileSync(
            helper,
            readFileSync(resolve(workspaceRoot, 'scripts', 'fixtures', 'prepare-installed-dependency.mjs')),
        );
        requireSuccess(
            command('node', [helper, dependencyProject], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed dependency fixture`,
        );
        const cachedInstall = requireCliSuccess(
            command(bin, ['install', dependencyProject, '--frozen-lockfile', '--json'], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed cached install`,
            installRoot,
        );
        const cachedReport = JSON.parse(cachedInstall);
        if (
            cachedReport.outcome !== 'installed' ||
            cachedReport.lock?.status !== 'existing' ||
            cachedReport.packages?.reused?.length !== 1 ||
            cachedReport.packages?.fetched?.length !== 0
        ) {
            throw new Error(`${manager} packed cached install did not reuse the exact local closure`);
        }
        const credentialDirectory = resolve(installRoot, 'invalid-credentials', 'erden', 'credentials', 'v1');
        mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
        const credentialPath = resolve(
            credentialDirectory,
            `${createHash('sha256').update('https://registry.example').digest('hex')}.json`,
        );
        writeFileSync(credentialPath, '{invalid credential}\n', { mode: 0o600 });
        const offlineInstall = requireCliSuccess(
            command(bin, ['install', dependencyProject, '--offline', '--frozen-lockfile', '--json'], {
                cwd: installRoot,
                env: { ...localEnvironment, XDG_CONFIG_HOME: resolve(installRoot, 'invalid-credentials') },
            }),
            `${manager} packed offline install`,
            installRoot,
        );
        if (JSON.parse(offlineInstall).outcome !== 'installed') {
            throw new Error(`${manager} packed offline install did not complete from the exact local closure`);
        }
        unlinkSync(credentialPath);
        const layerPath = requireSuccess(
            command(
                bin,
                ['path', '@example/packed-package', '--config', join(dependencyProject, 'erden.config.json'), '--json'],
                { cwd: installRoot, env: localEnvironment },
            ),
            `${manager} packed dependency path`,
        );
        if (layerPath.stderr !== '') {
            throw new Error(`${manager} packed dependency path wrote unexpected stderr`);
        }
        const layerReport = JSON.parse(layerPath.stdout);
        if (
            layerReport.outcome !== 'resolved' ||
            layerReport.layer?.identifier !== '@example/packed-package' ||
            typeof layerReport.layer?.path !== 'string' ||
            !isContained(resolve(dependencyProject, '.erden'), layerReport.layer.path)
        ) {
            throw new Error(`${manager} packed dependency path did not authenticate the installed layer`);
        }
        const exactAdd = requireCliSuccess(
            command(
                bin,
                [
                    'add',
                    isWindows ? '@example/packed-package@^^^^1.0.0' : '@example/packed-package@^1.0.0',
                    '--config',
                    join(dependencyProject, 'erden.config.json'),
                    '--json',
                ],
                { cwd: installRoot, env: localEnvironment },
            ),
            `${manager} packed exact-existing add`,
            installRoot,
        );
        const exactAddReport = JSON.parse(exactAdd);
        if (
            exactAddReport.outcome !== 'installed' ||
            exactAddReport.state?.status !== 'unchanged' ||
            exactAddReport.resolution !== 'existing-lock' ||
            exactAddReport.packageChanges?.length !== 0
        ) {
            throw new Error(`${manager} packed exact-existing add did not heal without resolution or a state write`);
        }
        const manifestBeforeUpdate = readFileSync(resolve(dependencyProject, 'erden.config.json'));
        const lockBeforeUpdate = readFileSync(resolve(dependencyProject, 'erden.lock'));
        const unavailableUpdate = command(
            bin,
            ['update', '@example/packed-package', '--config', join(dependencyProject, 'erden.config.json'), '--json'],
            { cwd: installRoot, env: localEnvironment },
        );
        if (
            unavailableUpdate.status !== 3 ||
            unavailableUpdate.stdout !== '' ||
            !unavailableUpdate.stderr.includes('PROJECT_DEPENDENCIES_REGISTRY_UNAVAILABLE') ||
            !readFileSync(resolve(dependencyProject, 'erden.config.json')).equals(manifestBeforeUpdate) ||
            !readFileSync(resolve(dependencyProject, 'erden.lock')).equals(lockBeforeUpdate)
        ) {
            throw new Error(`${manager} packed update did not fail zero-transport without mutating dependency state`);
        }
        const remove = requireCliSuccess(
            command(
                bin,
                [
                    'remove',
                    '@example/packed-package',
                    '--config',
                    join(dependencyProject, 'erden.config.json'),
                    '--json',
                ],
                { cwd: installRoot, env: localEnvironment },
            ),
            `${manager} packed dependency remove`,
            installRoot,
        );
        const removeReport = JSON.parse(remove);
        if (
            removeReport.outcome !== 'installed' ||
            removeReport.state?.status !== 'written' ||
            removeReport.resolution !== 'pruned-exact' ||
            removeReport.installation?.packages?.total !== 0 ||
            removeReport.packageChanges?.length !== 1
        ) {
            throw new Error(`${manager} packed dependency remove did not commit and install the pruned empty closure`);
        }
        const cleanupStatus = requireCliSuccess(
            command(bin, ['store', 'status', '--json'], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed cleanup status`,
            installRoot,
        );
        const cleanupStatusReport = JSON.parse(cleanupStatus);
        if (
            cleanupStatusReport.outcome !== 'healthy' ||
            cleanupStatusReport.objects?.unreferenced?.length !== 1 ||
            cleanupStatusReport.registrations?.superseded?.length < 1
        ) {
            throw new Error(`${manager} packed store status did not identify deterministic prunable cleanup`);
        }
        const cleanupPlan = requireCliSuccess(
            command(bin, ['store', 'prune', '--dry-run', '--json'], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed cleanup dry run`,
            installRoot,
        );
        const cleanupPlanReport = JSON.parse(cleanupPlan);
        if (
            cleanupPlanReport.outcome !== 'planned' ||
            cleanupPlanReport.objects?.total !== 1 ||
            cleanupPlanReport.registrations?.total < 1
        ) {
            throw new Error(`${manager} packed store prune dry run did not report exact cleanup`);
        }
        const cleanup = requireSuccess(
            command(bin, ['store', 'prune', '--json'], {
                cwd: installRoot,
                env: localEnvironment,
            }),
            `${manager} packed cleanup prune`,
            installRoot,
        );
        if (
            `${cleanup.stdout}${cleanup.stderr}`.includes(workspaceRoot) ||
            `${cleanup.stdout}${cleanup.stderr}`.includes(installRoot)
        ) {
            throw new Error(`${manager} packed store prune leaked a physical path`);
        }
        const cleanupReport = JSON.parse(cleanup.stdout);
        if (
            cleanup.stderr !== `${cleanupReport.warning}\n` ||
            cleanupReport.outcome !== 'pruned' ||
            cleanupReport.objects?.total !== 1 ||
            cleanupReport.registrations?.total !== cleanupPlanReport.registrations.total
        ) {
            throw new Error(`${manager} packed store prune did not remove the authenticated cleanup plan`);
        }
        const usage = command(bin, ['unknown-command'], { cwd: installRoot });
        if (usage.status !== 2 || usage.stdout !== '' || !usage.stderr.includes('unknown-command')) {
            throw new Error(`${manager} packed shim did not preserve the usage exit/stream/escaping contract`);
        }
        if (
            `${usage.stdout}${usage.stderr}`.includes(workspaceRoot) ||
            `${usage.stdout}${usage.stderr}`.includes(installRoot)
        ) {
            throw new Error(`${manager} packed usage leaked a physical path`);
        }
    }
    process.stdout.write(
        'Fresh npm and pnpm tarball installs execute the compiled erden CLI, real doctor KAT, init/pack/publish/publication/check, cached/offline install, authenticated path, exact add healing, local remove, and store path/status/prune.\n',
    );
} finally {
    for (const root of installRoots) {
        cleanupTestTempRoot(root);
    }
    cleanupTestTempRoot(packRoot);
}
