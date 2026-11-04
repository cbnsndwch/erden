import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isExcepted, readExceptions, retiredEntityFindings } from '../check-legal-entity.mjs';

function repository(files) {
    const root = mkdtempSync(join(tmpdir(), 'erden-legal-entity-'));
    execFileSync('git', ['-C', root, 'init', '-q']);
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    execFileSync('git', ['-C', root, 'add', '-A']);
    return root;
}

const OWNER = 'cbnsndwch';

test('finds every form of the retired name in tracked files only', () => {
    const root = repository({
        'plain.txt': `Copyright 2026 ${OWNER} LLC\n`,
        'comma.txt': `${OWNER}, LLC\n`,
        'dotted.txt': `${OWNER} L.L.C.\n`,
        'case.txt': `${OWNER.toUpperCase()} llc\n`,
        'wrapped.txt': `${OWNER}\nLLC\n`,
        'domain.ttl': `@prefix ev: <https://erden.${OWNER}.dev/onto/evidence#> .\n`,
        'prefix.ttl': `@prefix ev: <https://erden.sh/${'onto'}/evidence#> .\n`,
        'hosted.ttl': '@prefix ev: <https://erden.sh/o/erden/evidence#> .\n',
        'account.txt': `github.com/${OWNER}/erden and @${OWNER}/skos\n`,
        'current.txt': 'Ingenio Ventures Inc\n',
    });
    try {
        writeFileSync(join(root, 'untracked.txt'), `${OWNER} LLC\n`);
        assert.deepEqual(retiredEntityFindings(root).sort(), [
            'case.txt',
            'comma.txt',
            'domain.ttl',
            'dotted.txt',
            'plain.txt',
            'prefix.ttl',
            'wrapped.txt',
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an exception covers only its own file or directory', () => {
    const exceptions = [
        { path: 'history/', reason: 'dated' },
        { path: 'one.md', reason: 'dated' },
    ];
    assert.equal(isExcepted('history/a.md', exceptions), true);
    assert.equal(isExcepted('one.md', exceptions), true);
    assert.equal(isExcepted('history-b/a.md', exceptions), false);
    assert.equal(isExcepted('dir/one.md', exceptions), false);
    const root = repository({ 'history/a.md': `${OWNER} LLC\n`, 'other.md': `${OWNER} LLC\n` });
    try {
        assert.deepEqual(retiredEntityFindings(root, exceptions), ['other.md']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an exception without a reason is refused', () => {
    const root = repository({
        'scripts/legal-entity-exceptions.json': JSON.stringify({ exceptions: [{ path: 'a.md', reason: '' }] }),
    });
    try {
        assert.throws(() => readExceptions(root), /needs a path and a reason/u);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
