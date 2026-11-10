import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RELEASES = 'https://github.com/cbnsndwch/erden/releases/download';

export function exactVersion(input) {
    const version = input.trim().replace(/^v/u, '');
    if (
        !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
            version,
        )
    ) {
        throw new Error(
            'version must be an exact Erden release version, for example 0.1.0; latest and ranges are not supported',
        );
    }
    return version;
}

export function releaseArchive(version, platform) {
    if (!['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'].includes(platform)) {
        throw new Error(`Erden does not release an archive for ${platform}`);
    }
    return `erden-${exactVersion(version)}-${platform}.${platform === 'win32-x64' ? 'zip' : 'tar.gz'}`;
}

function runtimeAt(directory) {
    const node = join(directory, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    const cli = join(directory, 'lib', 'dist', 'bin.js');
    if (!existsSync(node) || !existsSync(cli)) {
        throw new Error('erden-root must contain node/node[.exe] and lib/dist/bin.js from a prepared Erden release');
    }
    return { node, cli };
}

async function download(url, fetchImpl, maximum) {
    const response = await fetchImpl(url, {
        headers: { 'user-agent': 'erden-check-action/1' },
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        throw new Error(
            `Release download returned HTTP ${String(response.status)}; ensure this exact version is published, or supply erden-root`,
        );
    }
    if (!response.body) {
        throw new Error('The release download has no response body');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maximum) {
            throw new Error('The release download exceeds the action size limit');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export function verifyArchive(sums, name, archive) {
    const matches = sums
        .split(/\r?\n/u)
        .filter((line) => line.slice(66) === name && /^[a-fA-F0-9]{64} [ *]/u.test(line));
    if (matches.length !== 1) {
        throw new Error(`SHA256SUMS must list ${name} exactly once`);
    }
    if (createHash('sha256').update(archive).digest('hex') !== matches[0].slice(0, 64).toLowerCase()) {
        throw new Error(`SHA-256 mismatch for ${name}; the archive was not extracted`);
    }
}

export async function prepareRuntime({ root, version, workspace, temporary, fetchImpl = fetch }) {
    if (root) {
        return runtimeAt(realpathSync(resolve(workspace, root)));
    }
    const platform = `${process.platform}-${process.arch}`;
    const name = releaseArchive(version, platform);
    if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) {
        throw new Error('Erden release engines require glibc; musl runners are unsupported');
    }
    const base = `${RELEASES}/v${exactVersion(version)}`;
    const sums = (await download(`${base}/SHA256SUMS`, fetchImpl, 1024 * 1024)).toString('utf8');
    const archive = await download(`${base}/${name}`, fetchImpl, 512 * 1024 * 1024);
    verifyArchive(sums, name, archive);
    const work = mkdtempSync(join(realpathSync(temporary), 'erden-runtime-'));
    try {
        const archivePath = join(work, name);
        const extract = join(work, 'runtime');
        writeFileSync(archivePath, archive);
        mkdirSync(extract);
        // Release archives are trusted executable code from the fixed upstream origin. They are verified before tar runs.
        const child = spawnSync('tar', ['-xf', archivePath, '-C', extract], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
        });
        if (child.error || child.status !== 0) {
            throw new Error(`Could not extract the verified Erden archive: ${child.error?.message ?? child.stderr}`);
        }
        const runtime = runtimeAt(join(extract, `erden-${exactVersion(version)}-${platform}`));
        rmSync(archivePath);
        return { ...runtime, ownedDirectory: work };
    } catch (error) {
        rmSync(work, { recursive: true, force: true });
        throw error;
    }
}
