import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    deleteStoredCliCredentialRevision,
    readStoredCliCredential,
    resolveCredentialPath,
    writeStoredCliCredential,
} from '../src/index.js';

const roots: string[] = [];
function root(): string {
    const value = makeTestTempRoot('erden-client-credentials-');
    chmodSync(value, 0o700);
    roots.push(value);
    return value;
}
afterEach(() => {
    for (const value of roots.splice(0)) {
        cleanupTestTempRoot(value);
    }
});

// These drive the Linux path, whose 0600/0700 mode checks need a filesystem with POSIX modes, which Windows lacks.
const POSIX_MODES_UNAVAILABLE = process.platform === 'win32';

const origin = 'https://registry.example';
const token = 'erden_cli_v1_d1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const value = Object.freeze({
    schema: 'erden.cli-credential/v1' as const,
    origin,
    credential: token,
    expiresAt: 9_000_000,
});

describe('origin-scoped CLI credential file', () => {
    it.skipIf(POSIX_MODES_UNAVAILABLE)(
        'writes canonical 0600 bytes below 0700 one-level directories and reads the exact revision',
        () => {
            const base = root();
            const environment = { XDG_CONFIG_HOME: base };
            const revision = writeStoredCliCredential(value, environment, 'linux');
            expect(revision.path).toBe(resolveCredentialPath(origin, environment, 'linux'));
            expect(lstatSync(revision.path).mode & 0o777).toBe(0o600);
            expect(lstatSync(dirname(revision.path)).mode & 0o777).toBe(0o700);
            const bytes = readFileSync(revision.path, 'utf8');
            expect(bytes).toBe(
                `${JSON.stringify({
                    credential: token,
                    expiresAt: value.expiresAt,
                    origin,
                    schema: 'erden.cli-credential/v1',
                })}\n`,
            );
            expect(bytes).not.toMatch(/email|name|user/iu);
            expect(readStoredCliCredential(origin, environment, 'linux')).toEqual(revision);
        },
    );

    it.skipIf(POSIX_MODES_UNAVAILABLE)('refuses loose modes, links, and a symlinked credential directory', () => {
        const loose = root();
        const looseEnvironment = { XDG_CONFIG_HOME: loose };
        const revision = writeStoredCliCredential(value, looseEnvironment, 'linux');
        chmodSync(revision.path, 0o644);
        expect(() => readStoredCliCredential(origin, looseEnvironment, 'linux')).toThrow();

        const hard = root();
        const hardEnvironment = { XDG_CONFIG_HOME: hard };
        const hardRevision = writeStoredCliCredential(value, hardEnvironment, 'linux');
        linkSync(hardRevision.path, join(hard, 'hardlink'));
        expect(() => readStoredCliCredential(origin, hardEnvironment, 'linux')).toThrow();

        const linked = root();
        const target = root();
        mkdirSync(join(linked, 'erden'), { mode: 0o700 });
        symlinkSync(target, join(linked, 'erden', 'credentials'), 'dir');
        expect(() => writeStoredCliCredential(value, { XDG_CONFIG_HOME: linked }, 'linux')).toThrow();

        const ancestor = root();
        const ancestorTarget = root();
        mkdirSync(join(ancestorTarget, 'config'), { mode: 0o700 });
        symlinkSync(ancestorTarget, join(ancestor, 'linked'), 'dir');
        expect(() =>
            writeStoredCliCredential(
                value,
                {
                    XDG_CONFIG_HOME: join(ancestor, 'linked', 'config'),
                },
                'linux',
            ),
        ).toThrow();
    });

    it.skipIf(POSIX_MODES_UNAVAILABLE)('rejects noncanonical bytes and an origin-substituted record', () => {
        const base = root();
        const environment = { XDG_CONFIG_HOME: base };
        const revision = writeStoredCliCredential(value, environment, 'linux');
        writeFileSync(revision.path, JSON.stringify(value));
        expect(() => readStoredCliCredential(origin, environment, 'linux')).toThrow();
        writeFileSync(
            revision.path,
            `${JSON.stringify({
                credential: token,
                expiresAt: value.expiresAt,
                origin: 'https://foreign.example',
                schema: 'erden.cli-credential/v1',
            })}\n`,
        );
        expect(() => readStoredCliCredential(origin, environment, 'linux')).toThrow();
    });

    it('rejects an injected Windows reparse point without requiring junction privileges', () => {
        const base = root();
        const environment = { LOCALAPPDATA: base };
        const inspector = Object.freeze({
            isReparsePoint: (path: string) => path === join(base, 'Erden', 'credentials'),
        });
        expect(() => writeStoredCliCredential(value, environment, 'win32', inspector)).toThrow();
    });

    it.skipIf(POSIX_MODES_UNAVAILABLE)(
        'deletes only the exact authenticated revision so a newer login survives',
        () => {
            const base = root();
            const environment = { XDG_CONFIG_HOME: base };
            const first = writeStoredCliCredential(value, environment, 'linux');
            const newer = writeStoredCliCredential({ ...value, expiresAt: value.expiresAt + 1 }, environment, 'linux');
            expect(deleteStoredCliCredentialRevision(first, environment, 'linux')).toBe(false);
            expect(readStoredCliCredential(origin, environment, 'linux')).toEqual(newer);
            expect(deleteStoredCliCredentialRevision(newer, environment, 'linux')).toBe(true);
            expect(readStoredCliCredential(origin, environment, 'linux')).toBeNull();
        },
    );
});
