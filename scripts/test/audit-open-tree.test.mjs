import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { auditOpenTree, binaryKind, parseDenylist, pathFindings, scanText } from '../audit-open-tree.mjs';

const root = resolve(import.meta.dirname, '../..');
const CONFIG = JSON.parse(readFileSync(join(root, 'scripts/open-tree-audit.json'), 'utf8'));
const IDENTITY = CONFIG.identity;

function tree(files) {
    const directory = mkdtempSync(join(tmpdir(), 'erden-audit-'));
    for (const [path, contents] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), contents);
    }
    return directory;
}

function audit(files, options = {}) {
    const directory = tree(files);
    try {
        return auditOpenTree(directory, { containers: false, ...options });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function checks(report) {
    return report.findings.map((finding) => `${finding.check} ${finding.path} ${finding.hit}`);
}

test('the generic checks find private addresses, home paths and personal emails, and pass anonymous ones', () => {
    const report = audit({
        'a.md': [
            'host 10.1.2.3 and 192.168.0.1 and 172.20.0.5 and 100.100.1.1',
            'not private: 172.32.0.1, 100.128.0.1, 8.8.8.8, version 1.10.0.1.2',
            'paths /home/someone/x, /Users/someone/y and C:\\Users\\someone\\z',
            'mail someone@company.io, 1+someone@users.noreply.github.com, noreply@anthropic.com, a@b.example.com, x@y.invalid',
        ].join('\n'),
    });
    assert.deepEqual(checks(report), [
        'private-ip a.md 10.1.2.3',
        'private-ip a.md 192.168.0.1',
        'private-ip a.md 172.20.0.5',
        'private-ip a.md 100.100.1.1',
        'home-path a.md /home/someone',
        'home-path a.md /Users/someone',
        'home-path a.md C:\\Users\\someone',
        'email a.md someone@company.io',
    ]);
    assert.equal(report.findings[0].line, 1);
});

test('an allow rule covers only its check, its path and a hit its expression matches whole', () => {
    const allow = [{ check: 'private-ip', path: 'test/', pattern: '192\\.168\\.1\\.20', reason: 'test data' }];
    const text = 'http://192.168.1.20 http://192.168.1.200';
    const patterns = [{ check: 'private-ip', pattern: /192\.168\.\d{1,3}\.\d{1,3}/gu }];
    assert.deepEqual(
        scanText('test/a.ts', text, [{ ...patterns[0], check: 'email' }], allow).map((finding) => finding.hit),
        ['192.168.1.20', '192.168.1.200'],
    );
    assert.deepEqual(
        scanText('test/a.ts', text, patterns, allow).map((finding) => finding.hit),
        ['192.168.1.200'],
    );
    assert.deepEqual(
        scanText('src/a.ts', text, patterns, allow).map((finding) => finding.hit),
        ['192.168.1.20', '192.168.1.200'],
    );
});

test('the denylist finds its terms case-insensitively, minus the hits its allow section gives a reason for', () => {
    const denylist = [
        '# private terms',
        '[deny]',
        'acme',
        '\\bbob\\b',
        '[allow]',
        'docs/acme.md acme -- the vendor this file documents',
    ].join('\n');
    const report = audit(
        { 'docs/acme.md': 'ACME and Acme\n', 'src/a.ts': '// Bob wrote this for acme, not bobby\n' },
        { denylist, config: { ...CONFIG, allow: [] } },
    );
    assert.deepEqual(checks(report), ['denylist src/a.ts acme', 'denylist src/a.ts Bob']);
    assert.equal(report.findings[1].term, '\\bbob\\b');
    assert.throws(() => parseDenylist('[allow]\ndocs/a.md acme\n'), /an allow line is/u);
    assert.throws(() => parseDenylist('acme\n'), /outside a \[deny\] or \[allow\] section/u);
});

test('an executable or compressed file fails unless allowed, and an allowed one has its text audited', () => {
    assert.equal(binaryKind('a.txt', Buffer.from('text')), undefined);
    assert.equal(binaryKind('a', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2])), 'ELF');
    assert.equal(binaryKind('a', gzipSync('x')), 'gzip');
    assert.equal(binaryKind('a.br', Buffer.from('anything')), 'compressed or executable (by extension)');
    assert.equal(binaryKind('a.dat', Buffer.from([1, 0, 2])), 'binary (NUL byte)');
    const config = {
        ...CONFIG,
        allow: [],
        binaryAllowlist: [{ path: 'captured/a.json.br', encoding: 'brotli', reason: 'a fixture' }],
    };
    const report = audit(
        {
            'captured/a.json.br': brotliCompressSync('{"origin": "http://10.0.0.7"}'),
            'captured/b.json.gz': gzipSync('{}'),
            tool: Buffer.from([0x4d, 0x5a, 0x90, 0]),
        },
        { config },
    );
    assert.deepEqual(checks(report), [
        'private-ip captured/a.json.br 10.0.0.7',
        'binary captured/b.json.gz gzip',
        'binary tool PE',
    ]);
});

test('a long line is scanned in linear time', () => {
    const started = performance.now();
    const report = audit({ 'one-line.json': `${'a'.repeat(2_000_000)}@${'b.'.repeat(100_000)}` });
    assert.deepEqual(report.findings, []);
    assert.ok(performance.now() - started < 5000, `${String(performance.now() - started)} ms`);
});

test('a file over the size limit fails', () => {
    const report = audit({ 'big.txt': 'x'.repeat(101) }, { config: { ...CONFIG, maxFileBytes: 100 } });
    assert.deepEqual(checks(report), ['size big.txt 101 bytes, over 100']);
    assert.equal(report.files, 1);
    assert.equal(report.bytes, 101);
});

test('the paths check fails a file the export allowlist does not include, or excludes', () => {
    const paths = {
        include: ['packages/a/', 'NOTICE', 'README.md'],
        exclude: ['packages/a/private/'],
        openVersions: { 'README.md': 'scripts/open-tree/root/README.md', 'LICENSES/MIT.txt': 'x' },
    };
    assert.deepEqual(
        pathFindings(
            [
                'NOTICE',
                'README.md',
                'LICENSES/MIT.txt',
                'packages/a/x.ts',
                'packages/a/private/y.ts',
                'packages/a/bin/z',
                'other.txt',
            ],
            paths,
        ).map((finding) => `${finding.path} ${finding.hit}`),
        [
            'packages/a/private/y.ts excluded by the allowlist',
            'packages/a/bin/z excluded by the allowlist',
            'other.txt not on the allowlist',
        ],
    );
});

function gitRepository(files, message, identity = IDENTITY) {
    const directory = tree(files);
    const env = {
        ...process.env,
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    function run(args) {
        const result = spawnSync('git', ['-C', directory, '-c', 'commit.gpgsign=false', ...args], {
            encoding: 'utf8',
            env,
        });
        assert.equal(result.status, 0, result.stderr);
    }
    run(['init', '-q', '-b', 'main']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', message]);
    return { directory, run };
}

test('the commit check passes one clean commit by the identity, and names what else is wrong', () => {
    const good = gitRepository({ 'a.txt': 'a\n' }, 'Initial public release\n\nThe open tools of Erden.');
    try {
        assert.deepEqual(checks(auditOpenTree(good.directory, { containers: false, commit: true })), []);
        writeFileSync(join(good.directory, 'stray.txt'), 'x\n');
        assert.deepEqual(checks(auditOpenTree(good.directory, { containers: false, commit: true })), [
            'commit .git the working tree differs from the commit, or holds untracked or ignored files',
        ]);
    } finally {
        rmSync(good.directory, { recursive: true, force: true });
    }
    const bad = gitRepository(
        { 'a.txt': 'a\n' },
        'Initial release\n\nWritten by someone@company.io.\n\nCo-Authored-By: Someone <someone@company.io>',
        { name: 'Someone', email: 'someone@company.io' },
    );
    try {
        bad.run(['commit', '-q', '--allow-empty', '-m', 'second']);
        assert.deepEqual(
            auditOpenTree(bad.directory, { containers: false, commit: true })
                .findings.filter((finding) => finding.check === 'commit')
                .map((finding) => finding.hit),
            [
                'the history has 2 commits, not one',
                `the author is "Someone <someone@company.io>", not "${IDENTITY.name} <${IDENTITY.email}>"`,
                `the committer is "Someone <someone@company.io>", not "${IDENTITY.name} <${IDENTITY.email}>"`,
                'the commit has a parent',
            ],
        );
        bad.run(['reset', '-q', '--soft', 'HEAD~1']);
        const hits = auditOpenTree(bad.directory, { containers: false, commit: true })
            .findings.filter((finding) => finding.check === 'commit')
            .map((finding) => finding.hit);
        assert.ok(hits.includes('the commit message ends in a trailer'), hits.join('\n'));
        assert.ok(hits.includes('the commit message holds "someone@company.io" (email)'), hits.join('\n'));
    } finally {
        rmSync(bad.directory, { recursive: true, force: true });
    }
});

test('the config pins both tool images by version and digest, and every allowed hit has a reason', () => {
    for (const image of Object.values(CONFIG.images)) {
        assert.match(image, /^[a-z0-9.-]+\/[a-z0-9/_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/u);
    }
    for (const entry of [...CONFIG.allow, ...CONFIG.binaryAllowlist]) {
        assert.ok(typeof entry.reason === 'string' && entry.reason.length > 10, JSON.stringify(entry));
    }
    assert.equal(CONFIG.maxFileBytes, 5_000_000);
});
