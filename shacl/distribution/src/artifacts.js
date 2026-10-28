// Written by shacl/qualification/finalize-artifacts.mjs from the shacl-build run recorded in
// shacl/qualification/binary-reproducibility.json. Do not edit by hand.
export const PACKAGE_VERSION = '0.1.0+purrdf.3.0.1';
export const ENGINE_DIGEST = 'sha256:026b0ef70f4bd68cbe0fff535b8287eb804825c057f46cc116ae1f2087b427cc';
export const KNOWN_ANSWER_FIXTURE_DIGEST = 'sha256:998bf25c3ec295a5dc8e8863846ca335ac636f2b1edf8abfb95b57ec88c883d8';
export const QUALIFIED_ARTIFACTS = Object.freeze({
    'linux:x64:glibc': Object.freeze({
        packageName: '@erden/shacl-linux-x64-gnu',
        description: 'Qualified Erden SHACL engine for Linux x64 (glibc)',
        runtime: Object.freeze({ 'os': 'linux', 'cpu': 'x64', 'libc': 'glibc' }),
        target: 'x86_64-unknown-linux-gnu',
        binaryPath: 'bin/erden-shacl',
        bytes: 11750792,
        sha256: 'sha256:6ec761d9ead6f40dd747da972f1be7cd45e212321ea7c8dd134eb38bc42f06a9',
        responseBytes: 2202,
        responseSha256: 'sha256:db8343f26115bcb9b4d6ed4718b8b5cb34f14ae8cc004c04a09ee8e1bf43eea8',
    }),
    'linux:arm64:glibc': Object.freeze({
        packageName: '@erden/shacl-linux-arm64-gnu',
        description: 'Qualified Erden SHACL engine for Linux arm64 (glibc)',
        runtime: Object.freeze({ 'os': 'linux', 'cpu': 'arm64', 'libc': 'glibc' }),
        target: 'aarch64-unknown-linux-gnu',
        binaryPath: 'bin/erden-shacl',
        bytes: 9639384,
        sha256: 'sha256:798293023e6f89d1de07f8e3fff198a8e484ead2675ad29b4d040e4af7ed8332',
        responseBytes: 2202,
        responseSha256: 'sha256:fa5e6ef14dd9bd37ed080147d7f8525e4af1f05951ca0cae9eafcad02da04698',
    }),
    'darwin:arm64': Object.freeze({
        packageName: '@erden/shacl-darwin-arm64',
        description: 'Qualified Erden SHACL engine for macOS arm64 (Apple silicon)',
        runtime: Object.freeze({ 'os': 'darwin', 'cpu': 'arm64' }),
        target: 'aarch64-apple-darwin',
        binaryPath: 'bin/erden-shacl',
        bytes: 9616368,
        sha256: 'sha256:f96a8ddac5e32c2e9be0c5261626b7439bf5bd4de5a36d4dbfd627b2dfb4ad4f',
        responseBytes: 2202,
        responseSha256: 'sha256:347086910723900213fbd6dc6608c332cfca375eef2149df761c232166d983cf',
    }),
    'win32:x64': Object.freeze({
        packageName: '@erden/shacl-win32-x64-msvc',
        description: 'Qualified Erden SHACL engine for Windows x64 (MSVC)',
        runtime: Object.freeze({ 'os': 'win32', 'cpu': 'x64' }),
        target: 'x86_64-pc-windows-msvc',
        binaryPath: 'bin/erden-shacl.exe',
        bytes: 13892608,
        sha256: 'sha256:c7ee9a4bff6d0e2cba6d089aa25a81af79c4fe4aee992643db7ef5f8148901a5',
        responseBytes: 2202,
        responseSha256: 'sha256:4d0dbccc6d44917f870550c71a75291447f479140623ce23064ae93597de8cb8',
    }),
});
