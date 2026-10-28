import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { discoverWorkspaceMembers } from '../../scripts/lib/workspace-guard.mjs';

import { installedPackages } from './notices.mjs';
import { sha256 } from './platforms.mjs';

/**
 * Prepare the temporary export for pnpm's frozen, dedicated deploy lockfile. Its projection handles workspace
 * links, but requires the injection setting. No importer, dependency resolution or integrity value is changed.
 */
export function prepareLockedDeployment(source) {
    const path = join(source, 'pnpm-lock.yaml');
    const text = readFileSync(path, 'utf8');
    const yaml = createRequire(join(source, 'packages/contracts/package.json'))('yaml');
    const lockfile = yaml.parse(text);
    lockfile.settings = { ...lockfile.settings, injectWorkspacePackages: true };
    writeFileSync(path, yaml.stringify(lockfile));
    return { lockfile, digest: sha256(text) };
}

function portableDependencies(dependencies, members) {
    return Object.fromEntries(
        Object.entries(dependencies).map(([name, value]) => {
            if (typeof value !== 'string' || !value.startsWith('workspace:')) {
                return [name, value];
            }
            const target = members.get(name);
            if (target?.license !== 'Apache-2.0') {
                throw new Error(`The CLI archive must not depend on non-open workspace package ${name}`);
            }
            return [name, target.version];
        }),
    );
}

/**
 * pnpm's dedicated deploy manifest contains temporary file URLs. Restore portable exact dependency versions from
 * the source manifests, reject proprietary workspace packages, and discard deployment-only lock/config state.
 * Third-party manifests and their license declarations are left byte-identical.
 */
export function normalizeDeployedWorkspace(source, lib, lockfile) {
    const members = new Map(discoverWorkspaceMembers(source).map(({ manifest }) => [manifest.name, manifest]));
    const lockedPackages = new Set(Object.keys(lockfile.packages ?? {}));
    for (const directory of [lib, ...installedPackages(join(lib, 'node_modules'))]) {
        const path = join(directory, 'package.json');
        const deployed = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof deployed.name !== 'string' || !deployed.name.startsWith('@erden/')) {
            if (!lockedPackages.has(`${deployed.name}@${deployed.version}`)) {
                throw new Error(
                    `The CLI archive contains ${deployed.name}@${deployed.version} outside its source lockfile`,
                );
            }
            continue;
        }
        const original = members.get(deployed.name);
        if (original?.license !== 'Apache-2.0' || deployed.version !== original.version) {
            throw new Error(
                `The CLI archive contains an unknown, non-open or wrong-version workspace package ${deployed.name}`,
            );
        }
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
            if (original[field] === undefined) {
                delete deployed[field];
            } else {
                deployed[field] = portableDependencies(original[field], members);
            }
        }
        delete deployed.pnpm;
        writeFileSync(path, `${JSON.stringify(deployed, null, 4)}\n`);
    }
    rmSync(join(lib, 'pnpm-lock.yaml'), { force: true });
}
