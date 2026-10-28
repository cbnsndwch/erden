// The four release platforms, how each names itself to the engines' resolvers and runners, and the pin check every
// input to an archive passes first.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const RELEASE_PLATFORMS = Object.freeze({
    'darwin-arm64': Object.freeze({
        os: 'darwin',
        cpu: 'arm64',
        engineKey: 'darwin:arm64',
        target: 'aarch64-apple-darwin',
        runner: 'macos-15',
        archive: 'tar.gz',
    }),
    'linux-arm64': Object.freeze({
        os: 'linux',
        cpu: 'arm64',
        engineKey: 'linux:arm64:glibc',
        target: 'aarch64-unknown-linux-gnu',
        runner: 'ubuntu-24.04-arm',
        archive: 'tar.gz',
    }),
    'linux-x64': Object.freeze({
        os: 'linux',
        cpu: 'x64',
        engineKey: 'linux:x64:glibc',
        target: 'x86_64-unknown-linux-gnu',
        runner: 'ubuntu-24.04',
        archive: 'tar.gz',
    }),
    'win32-x64': Object.freeze({
        os: 'win32',
        cpu: 'x64',
        engineKey: 'win32:x64',
        target: 'x86_64-pc-windows-msvc',
        runner: 'windows-2025',
        archive: 'zip',
    }),
});

/** The release platform of this host, or undefined. */
export function hostPlatform(host = { platform: process.platform, arch: process.arch }) {
    return Object.keys(RELEASE_PLATFORMS).find(
        (name) => RELEASE_PLATFORMS[name].os === host.platform && RELEASE_PLATFORMS[name].cpu === host.arch,
    );
}

/** The archive file name of a version on a platform. */
export function archiveName(version, platform) {
    return `erden-${version}-${platform}.${RELEASE_PLATFORMS[platform].archive}`;
}

export function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Refuses `path` unless its size and SHA-256 are the pin's; `label` names it in the refusal. */
export function assertPinned(path, pin, label) {
    if (pin === undefined || pin === null || pin.sha256 === null || pin.sha256 === undefined) {
        throw new Error(`${label} has no pin`);
    }
    const bytes = readFileSync(path);
    const size = statSync(path).size;
    const expectedBytes = pin.bytes;
    if ((expectedBytes !== undefined && size !== expectedBytes) || sha256(bytes) !== pin.sha256) {
        throw new Error(
            `${label} is not the pinned file: ${String(size)} bytes, ${sha256(bytes)}; expected ${String(expectedBytes)} bytes, ${pin.sha256}`,
        );
    }
}
