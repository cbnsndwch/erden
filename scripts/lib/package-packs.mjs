import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { OPEN_PACK_RULES, validatePackFiles } from './pack-guard.mjs';
import { OPEN_WORKSPACE_PROFILE, discoverWorkspaceMembers } from './workspace-guard.mjs';

const isWindows = process.platform === 'win32';
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function packedManifest(tarball) {
    const archive = gunzipSync(readFileSync(tarball));
    for (let offset = 0; offset + 512 <= archive.length;) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            break;
        }
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
        const rawSize = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
        const size = Number.parseInt(rawSize || '0', 8);
        const body = archive.subarray(offset + 512, offset + 512 + size);
        if (name === 'package/package.json') {
            return JSON.parse(body.toString('utf8'));
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error('package/package.json is missing from tarball');
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

/**
 * Packs every workspace member (`pnpm pack` for runtime, resolver and platform packages, `npm pack --dry-run` for the
 * rest) and returns one message per file or manifest that breaks its pack rules.
 */
export function packFailures(root, profile = OPEN_WORKSPACE_PROFILE, packRules = OPEN_PACK_RULES) {
    const failures = [];
    const members = discoverWorkspaceMembers(root);
    const membersByName = new Map(members.map((member) => [member.manifest.name, member]));

    for (const member of members) {
        const realPack =
            profile.runtimeTypeScriptPackages.has(member.path) ||
            profile.distributionPackages.has(member.path) ||
            profile.platformPackages.has(member.path);
        const temporary = realPack ? mkdtempSync(join(tmpdir(), 'erden-pack-guard-')) : undefined;
        const command = realPack ? 'pnpm' : 'npm';
        const arguments_ = realPack
            ? ['pack', '--json', '--pack-destination', temporary]
            : ['pack', '--dry-run', '--json', '--ignore-scripts'];
        const pack = spawnSync(
            isWindows ? (process.env.ComSpec ?? 'cmd.exe') : command,
            isWindows ? ['/d', '/s', '/c', `${command} ${arguments_.join(' ')}`] : arguments_,
            { cwd: member.directory, encoding: 'utf8' },
        );
        if (pack.status !== 0) {
            failures.push(
                `${member.path} npm pack failed: ${(pack.stderr ?? '').trim() || (pack.stdout ?? '').trim()}`,
            );
            if (temporary !== undefined) {
                rmSync(temporary, { recursive: true, force: true });
            }
            continue;
        }
        try {
            const result = parsePackResult(pack.stdout);
            const record = Array.isArray(result) ? result[0] : result;
            // Engine source packages carry their pins; a binary is packed only when installed, never committed.
            const engineBinary = /^(?:shacl|reasoner)\/(?:linux|darwin|win32)-/u.test(member.path)
                ? join(member.directory, Object.values(member.manifest.bin ?? {})[0] ?? 'bin/missing')
                : undefined;
            failures.push(
                ...validatePackFiles(
                    member.path,
                    record?.files ?? [],
                    { binaryInstalled: engineBinary === undefined || existsSync(engineBinary) },
                    packRules,
                ),
            );
            if (realPack) {
                const manifest = packedManifest(record?.filename);
                for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
                    const expectedEntries = Object.entries(member.manifest[field] ?? {})
                        .map(([name, declared]) => {
                            const workspaceTarget = membersByName.get(name);
                            return [
                                name,
                                typeof declared === 'string' &&
                                declared.startsWith('workspace:') &&
                                workspaceTarget !== undefined
                                    ? workspaceTarget.manifest.version
                                    : declared,
                            ];
                        })
                        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
                    const actualEntries = Object.entries(manifest[field] ?? {}).sort(([left], [right]) =>
                        left < right ? -1 : left > right ? 1 : 0,
                    );
                    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
                        failures.push(
                            `${member.path} packed ${field} does not exactly match its transformed declared dependency map`,
                        );
                    }
                    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
                        if (typeof version !== 'string' || !exactVersion.test(version)) {
                            failures.push(`${member.path} packed ${field}.${name} is not an installable exact version`);
                        }
                        const declared = member.manifest[field]?.[name];
                        const workspaceTarget = membersByName.get(name);
                        if (
                            typeof declared === 'string' &&
                            declared.startsWith('workspace:') &&
                            workspaceTarget !== undefined &&
                            version !== workspaceTarget.manifest.version
                        ) {
                            failures.push(
                                `${member.path} packed ${field}.${name} does not equal workspace version ${workspaceTarget.manifest.version}`,
                            );
                        }
                    }
                }
                if (
                    profile.runtimeTypeScriptPackages.has(member.path) &&
                    manifest.exports?.['.']?.default !== './dist/index.js'
                ) {
                    failures.push(`${member.path} packed runtime must default to compiled dist/index.js`);
                }
                const expectedBin = profile.bins.get(member.path);
                if (expectedBin !== undefined && !isDeepStrictEqual(manifest.bin, expectedBin)) {
                    failures.push(`${member.path} packed bin must execute its compiled executables`);
                }
            }
        } catch (error) {
            failures.push(`${member.path} npm pack did not return JSON: ${error.message}`);
        } finally {
            if (temporary !== undefined) {
                rmSync(temporary, { recursive: true, force: true });
            }
        }
    }
    return failures;
}
