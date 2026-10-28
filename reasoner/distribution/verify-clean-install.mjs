import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const expectedRuntime = process.argv[2];
const inactivePolicy = process.argv[3] ?? 'must-be-absent';
const platforms = {
    windows: {
        name: '@erden/reasoner-win32-x64-msvc',
        digest: 'sha256:9e6b2487706fc5406becce8e3fbb01c1456243fb66f4519e2e00147906e37051',
        executable: false,
    },
    linux: {
        name: '@erden/reasoner-linux-x64-gnu',
        digest: 'sha256:a5deaeecf3568101cfc981a2194f0af9edc1590c506f50b8b61cda4c4c1d571a',
        executable: true,
    },
    'linux-arm64': {
        name: '@erden/reasoner-linux-arm64-gnu',
        digest: 'sha256:657a3b5f6e526404d1c87e5adb3e05eb800f7936702af433c093fcc21b0d5ace',
        executable: true,
    },
    'darwin-arm64': {
        name: '@erden/reasoner-darwin-arm64',
        digest: 'sha256:5f4e5b2c6b123acadeccd606b20d8ed73a6a0c7da1dd285640e03d8b94cdfb9e',
        executable: true,
    },
};
if (!Object.hasOwn(platforms, expectedRuntime ?? '')) {
    throw new Error(`Expected one of ${Object.keys(platforms).join(', ')}`);
}
if (inactivePolicy !== 'must-be-absent' && inactivePolicy !== 'may-be-present') {
    throw new Error('Expected inactive package policy');
}

const expected = platforms[expectedRuntime];
const version = '0.2.0+purrdf.0.12.0.dfb1df7';
const nodeModules = resolve('node_modules');
const resolverRoot = resolve(nodeModules, '@erden/reasoner-distribution');
const platformRoot = resolve(nodeModules, expected.name);

assert.equal(process.version, 'v24.17.0');
assert.equal(existsSync(platformRoot), true, `missing compatible package ${expected.name}`);
const otherPlatformPackages = readdirSync(resolve(nodeModules, '@erden')).filter(
    (name) => name.startsWith('reasoner-') && name !== 'reasoner-distribution' && `@erden/${name}` !== expected.name,
);
const incompatiblePlatformPackagePresent = otherPlatformPackages.length > 0;
if (inactivePolicy === 'must-be-absent') {
    assert.deepEqual(otherPlatformPackages, [], 'an incompatible platform package was installed');
}
const resolverManifest = JSON.parse(readFileSync(resolve(resolverRoot, 'package.json'), 'utf8'));
assert.equal(resolverManifest.version, version);
assert.deepEqual(resolverManifest.optionalDependencies, {
    '@erden/reasoner-darwin-arm64': version,
    '@erden/reasoner-linux-arm64-gnu': version,
    '@erden/reasoner-linux-x64-gnu': version,
    '@erden/reasoner-win32-x64-msvc': version,
});
assert.equal(JSON.parse(readFileSync(resolve(platformRoot, 'package.json'), 'utf8')).version, version);

const distribution = await import(pathToFileURL(resolve(resolverRoot, 'src/index.js')).href);
const doctor = distribution.inspectBundledReasoner({ runSelfTest: true });
assert.equal(doctor.availability, 'available');
assert.equal(doctor.actualPlatformPackage, expected.name);
assert.equal(doctor.packageVersion, version);
assert.equal(doctor.toolVersion, version);
assert.equal(doctor.digest, expected.digest);
assert.equal(doctor.selfTest.status, 'passed');
const binaryStat = lstatSync(doctor.path);
assert.equal(binaryStat.isFile(), true);
if (expected.executable) {
    assert.notEqual(binaryStat.mode & 0o111, 0, 'The reasoner binary must be executable after install');
}

process.stdout.write(
    `${JSON.stringify({
        node: process.version,
        platform: process.platform,
        installedPlatformPackage: expected.name,
        inactivePolicy,
        incompatiblePlatformPackagePresent,
        version,
        digest: doctor.digest,
        selfTest: doctor.selfTest.status,
        executable: expected.executable ? true : undefined,
        offline: true,
    })}\n`,
);
