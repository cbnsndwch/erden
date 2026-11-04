// Checks a published release as a user meets it, on the platform it runs on: downloads the install script, SHA256SUMS
// and this platform's archive from the release itself, checks the digests, installs with the script over the network,
// runs `erden --version`, `erden doctor` and an offline `erden check` of the demo in a fresh directory, and reads the
// live registry through the installed CLI. Then it requires the install script to refuse a changed and a truncated
// archive, leaving nothing installed. It changes nothing on the registry.
//
// Usage: node release/verify-published.mjs --tag v<version>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const REPOSITORY = 'https://github.com/cbnsndwch/erden/releases/download';
const USER_AGENT = 'erden-release-verify/1';
const REGISTRY = 'https://registry.erden.sh';

const repository = resolve(import.meta.dirname, '..');

function platformName() {
    const name = `${process.platform}-${process.arch}`;
    if (!['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'].includes(name)) {
        throw new Error(`Erden releases no archive for ${name}`);
    }
    return name;
}

async function download(url) {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) {
        throw new Error(`${url} answered ${String(response.status)}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/** The asset's digest in SHA256SUMS, refusing an asset the file does not list or lists with other bytes. */
function assertListed(sums, name, bytes) {
    const line = sums
        .trim()
        .split('\n')
        .find((entry) => entry.endsWith(`  ${name}`));
    if (line === undefined) {
        throw new Error(`SHA256SUMS does not list ${name}`);
    }
    if (line.slice(0, 64) !== sha256(bytes)) {
        throw new Error(`${name} is not the file SHA256SUMS lists`);
    }
}

function installArguments(script, archive) {
    if (process.platform === 'win32') {
        return [
            'powershell',
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                script,
                ...(archive === undefined ? [] : ['-Archive', archive]),
            ],
        ];
    }
    return ['sh', [script, ...(archive === undefined ? [] : ['--archive', archive])]];
}

/** A home directory for one install, with the variables each platform's script and CLI read. */
function homeEnvironment(home) {
    return { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local') };
}

function installedTarget(home, version) {
    return process.platform === 'win32'
        ? join(home, 'AppData', 'Local', 'Programs', 'Erden', version)
        : join(home, '.local', 'share', 'erden', version);
}

function erdenCommand(home, version, args) {
    if (process.platform === 'win32') {
        return [
            process.env.ComSpec ?? 'cmd.exe',
            // `/s /c` takes off the outer quotes; each part keeps its own, for paths with spaces.
            [
                '/d',
                '/s',
                '/c',
                `""${join(installedTarget(home, version), 'bin', 'erden.cmd')}" ${args.map((arg) => `"${arg}"`).join(' ')}"`,
            ],
        ];
    }
    return [join(home, '.local', 'bin', 'erden'), args];
}

function main(values) {
    return (async () => {
        const version = values.tag.replace(/^v/u, '');
        const platform = platformName();
        const base = `${REPOSITORY}/${values.tag}`;
        const work = mkdtempSync(join(realpathSync(tmpdir()), 'erden-verify-published-'));
        const scriptName = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
        const archiveName = `erden-${version}-${platform}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
        const sums = (await download(`${base}/SHA256SUMS`)).toString('utf8');
        const script = await download(`${base}/${scriptName}`);
        const archive = await download(`${base}/${archiveName}`);
        assertListed(sums, scriptName, script);
        assertListed(sums, archiveName, archive);
        const scriptPath = join(work, scriptName);
        writeFileSync(scriptPath, script);
        console.log(`${archiveName}: ${String(archive.byteLength)} bytes, sha256:${sha256(archive)}, listed`);

        const home = join(work, 'home');
        mkdirSync(home);
        const environment = homeEnvironment(home);
        function must(command, args, options = {}) {
            const child = spawnSync(command, args, {
                encoding: 'utf8',
                env: environment,
                maxBuffer: 1 << 26,
                windowsHide: true,
                windowsVerbatimArguments: command.toLowerCase().endsWith('cmd.exe'),
                ...options,
            });
            if (child.status !== 0) {
                throw new Error(
                    `${command} ${args.join(' ')} failed (${String(child.status)}):\n${child.stderr}${child.stdout}`,
                );
            }
            return child.stdout;
        }
        function erden(args, options) {
            return must(...erdenCommand(home, version, args), options);
        }

        must(...installArguments(scriptPath));
        const reported = erden(['--version']).trim();
        if (reported !== version) {
            throw new Error(`erden --version says ${reported}, not ${version}`);
        }
        console.log(`erden --version: ${reported}`);

        const doctor = JSON.parse(erden(['doctor', '--json']));
        for (const engine of [doctor.reasoner, doctor.shaclEngine]) {
            if (
                engine.availability !== 'available' ||
                engine.selfTest.status !== 'passed' ||
                engine.actualPlatformPackage === 'source-build'
            ) {
                throw new Error(`erden doctor did not verify an engine: ${JSON.stringify(engine)}`);
            }
        }
        console.log(
            `erden doctor: ${doctor.outcome}; ${doctor.reasoner.actualPlatformPackage}, ${doctor.shaclEngine.actualPlatformPackage}`,
        );

        const fresh = join(work, 'fresh');
        mkdirSync(fresh);
        cpSync(join(repository, 'examples/erden-demo'), join(fresh, 'demo'), { recursive: true });
        const check = JSON.parse(erden(['check', 'demo', '--offline', '--json'], { cwd: fresh }));
        if (check.outcome !== 'passed') {
            throw new Error(`erden check on the demo: ${JSON.stringify(check).slice(0, 2000)}`);
        }
        console.log('erden check demo --offline: passed');

        // The hosted registry's public search, then the installed CLI's own read of an alias nothing has published.
        const searchResponse = await fetch(`${REGISTRY}/api/v1/registry/search?q=erden`, {
            headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (searchResponse.status !== 200) {
            throw new Error(`The registry search answered ${String(searchResponse.status)}`);
        }
        console.log(`registry search: ${JSON.stringify(await searchResponse.json()).slice(0, 200)}`);
        const project = join(work, 'project');
        erden(['init', project, '--json'], { cwd: work });
        const manifest = JSON.parse(readFileSync(join(project, 'erden.config.json'), 'utf8'));
        if (manifest.registry !== REGISTRY) {
            throw new Error(`erden init wrote the registry ${String(manifest.registry)}`);
        }
        // The CLI reports any failed resolution alike, so the registry itself says this alias is absent.
        const alias = '@erden-release-check/absent';
        const absent = await fetch(`${REGISTRY}/api/v1/registry/layers?alias=${encodeURIComponent(alias)}`, {
            headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (absent.status !== 404) {
            throw new Error(`The registry answered ${String(absent.status)} for an absent alias`);
        }
        const add = spawnSync(...erdenCommand(home, version, ['add', `${alias}@1.0.0`, '--json']), {
            cwd: project,
            encoding: 'utf8',
            env: environment,
            windowsHide: true,
            windowsVerbatimArguments: process.platform === 'win32',
        });
        if (add.status !== 3 || !`${add.stdout}${add.stderr}`.includes('PROJECT_DEPENDENCIES_RESOLUTION_FAILED')) {
            throw new Error(`erden add of an absent alias: ${String(add.status)}\n${add.stderr}${add.stdout}`);
        }
        console.log('erden add of an absent alias: the live registry answered not found');

        // The script carries the digests: a changed or short archive must be refused and leave nothing installed.
        const middle = Math.floor(archive.byteLength / 2);
        const changed = Buffer.from(archive);
        changed[middle] ^= 1;
        for (const [name, bytes] of [
            ['changed', changed],
            ['truncated', archive.subarray(0, middle)],
        ]) {
            const refusedHome = join(work, `refused-${name}`);
            mkdirSync(refusedHome);
            const bad = join(work, `${name}-${archiveName}`);
            writeFileSync(bad, bytes);
            const [command, args] = installArguments(scriptPath, bad);
            const refused = spawnSync(command, args, {
                encoding: 'utf8',
                env: homeEnvironment(refusedHome),
                windowsHide: true,
            });
            if (refused.status === 0) {
                throw new Error(`The install script accepted a ${name} archive`);
            }
            if (existsSync(installedTarget(refusedHome, version))) {
                throw new Error(`The install script left an install behind after refusing a ${name} archive`);
            }
            console.log(`${name} archive refused: ${(refused.stderr || refused.stdout).trim().split('\n')[0]}`);
        }
        console.log(`${platform}: the published release verified`);
    })();
}

const { values } = parseArgs({ options: { tag: { type: 'string' } } });
if (values.tag === undefined || !/^v\d+\.\d+\.\d+$/u.test(values.tag)) {
    throw new Error('Usage: verify-published.mjs --tag v<version>');
}
await main(values);
