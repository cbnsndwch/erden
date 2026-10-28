// Closes the erden-shacl distribution: the packages, resolver anchors and reproducibility record agree and no binary is
// committed (finalize-artifacts.mjs --check), and this platform's binary, when one is installed, is executable and
// answers the known-answer request with the pinned bytes. The binaries are never committed: build-from-source.mjs
// installs a byte-identical build, and the tools release (release.yml) will ship the minted ones.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { QUALIFIED_SHACL_ARTIFACTS, runBundledShaclEngineKnownAnswer } from '../distribution/src/index.js';
import { PLATFORMS } from './finalize-artifacts.mjs';

const qualification = import.meta.dirname;
const shacl = resolve(qualification, '..');

execFileSync(process.execPath, [resolve(qualification, 'finalize-artifacts.mjs'), '--check'], { stdio: 'inherit', windowsHide: true });

assert.deepEqual(Object.keys(QUALIFIED_SHACL_ARTIFACTS).sort(), PLATFORMS.map((platform) => platform.key).sort());

const current = PLATFORMS.find(
    (platform) => platform.runtime.os === process.platform && platform.runtime.cpu === process.arch,
);
let platformKnownAnswer = current === undefined ? 'not-applicable' : current.key;
if (current !== undefined) {
    const binary = resolve(shacl, current.directory, QUALIFIED_SHACL_ARTIFACTS[current.key].binaryPath);
    if (!existsSync(binary)) {
        platformKnownAnswer = 'not-installed (run shacl/qualification/build-from-source.mjs; the TS-6 release ships it)';
    } else {
        if (process.platform !== 'win32') assert.notEqual(statSync(binary).mode & 0o111, 0, `${binary} is not executable`);
        const runtime = { platform: current.runtime.os, arch: current.runtime.cpu, ...(current.runtime.libc === undefined ? {} : { libc: current.runtime.libc }) };
        const result = runBundledShaclEngineKnownAnswer({ runtime, locatePackage: () => resolve(shacl, current.directory) });
        assert.deepEqual(result, {
            fixture: 'core-and-sparql',
            responseBytes: QUALIFIED_SHACL_ARTIFACTS[current.key].responseBytes,
            responseDigest: QUALIFIED_SHACL_ARTIFACTS[current.key].responseSha256,
            status: 'passed',
        });
    }
}

process.stdout.write(
    `${JSON.stringify({
        ...Object.fromEntries(PLATFORMS.map((platform) => [platform.target, QUALIFIED_SHACL_ARTIFACTS[platform.key].sha256])),
        platformKnownAnswer,
        status: 'closed',
    })}\n`,
);
