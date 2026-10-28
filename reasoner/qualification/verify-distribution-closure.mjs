// Closes the reasoner distribution: the packages, resolver anchors, optional dependencies and mint record agree and no
// binary is committed (finalize-artifacts.mjs --check), and this platform's binary, when one is installed, is
// executable and answers the known-answer request with the pinned bytes. The binaries are never committed: the tools
// release (release.yml) mints them, and build-from-source.mjs installs a byte-identical build.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { QUALIFIED_REASONER_ARTIFACTS, runBundledReasonerKnownAnswer } from '../distribution/src/index.js';
import { skipUntilReasonerRelease } from '../../scripts/lib/reasoner-release.mjs';
import { PLATFORMS } from './finalize-artifacts.mjs';

const qualification = import.meta.dirname;
const reasoner = resolve(qualification, '..');

execFileSync(process.execPath, [resolve(qualification, 'finalize-artifacts.mjs'), '--check'], { stdio: 'inherit', windowsHide: true });
skipUntilReasonerRelease('check:distribution:closure (reasoner)');

assert.deepEqual(Object.keys(QUALIFIED_REASONER_ARTIFACTS).sort(), PLATFORMS.map((platform) => platform.key).sort());

const current = PLATFORMS.find(
    (platform) => platform.runtime.os === process.platform && platform.runtime.cpu === process.arch,
);
let platformKnownAnswer = current === undefined ? 'not-applicable' : current.key;
if (current !== undefined) {
    const anchor = QUALIFIED_REASONER_ARTIFACTS[current.key];
    const binary = resolve(reasoner, current.directory, anchor.binaryPath);
    if (!existsSync(binary)) {
        platformKnownAnswer = 'not-installed (run reasoner/qualification/build-from-source.mjs; a tools release ships it)';
    } else {
        if (process.platform !== 'win32') assert.notEqual(statSync(binary).mode & 0o111, 0, `${binary} is not executable`);
        const runtime = { platform: current.runtime.os, arch: current.runtime.cpu, ...(current.runtime.libc === undefined ? {} : { libc: current.runtime.libc }) };
        const result = runBundledReasonerKnownAnswer({ runtime, locatePackage: () => resolve(reasoner, current.directory) });
        assert.equal(result.status, 'passed');
        assert.equal(result.responseBytes, anchor.responseBytes);
        assert.equal(result.responseDigest, anchor.responseSha256);
    }
}

process.stdout.write(
    `${JSON.stringify({
        ...Object.fromEntries(PLATFORMS.map((platform) => [platform.target, QUALIFIED_REASONER_ARTIFACTS[platform.key].sha256])),
        platformKnownAnswer,
        status: 'closed',
    })}\n`,
);
