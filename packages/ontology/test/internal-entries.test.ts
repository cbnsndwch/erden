import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as protocol from '@erden/reasoner-protocol';

import * as ontology from '../src/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The functions under `dir` whose doc comment starts `Internal:`: entry points that skip a check for their caller. */
function internalEntries(dir: string): ReadonlyArray<string> {
    const names: string[] = [];
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) {
            continue;
        }
        const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
        for (const match of text.matchAll(/\/\*\*\s*\n\s*\*\s*Internal:[\s\S]*?\*\/\s*export function (\w+)/gu)) {
            names.push(match[1] ?? '');
        }
    }
    return names;
}

describe('internal entry points', () => {
    it('keeps every entry documented Internal: out of the public barrels', () => {
        const names = [
            ...internalEntries(join(here, '../src')),
            ...internalEntries(join(here, '../../../reasoner/protocol/src')),
        ];
        expect(names).toEqual(
            expect.arrayContaining([
                'assertExplicitReasonerInput',
                'buildReasonedOntology',
                'normalizeValidatedAssembledOntology',
                'snapshotParsedAssembledOntology',
                'validateExplicitAssembledOntology',
            ]),
        );
        const exported = new Set([...Object.keys(ontology), ...Object.keys(protocol)]);
        expect(names.filter((name) => exported.has(name))).toEqual([]);
    });

    it('keeps what the protocol computed and the assembly handed over out of the public barrels', async () => {
        const sealed = await import('../../../reasoner/protocol/src/sealed.js');
        const ownership = await import('../src/reasoner/ownership.js');
        const exported = new Set([...Object.keys(ontology), ...Object.keys(protocol)]);
        const hidden = [...Object.keys(sealed), ...Object.keys(ownership)];
        expect(hidden.length).toBeGreaterThan(0);
        expect(hidden.filter((name) => exported.has(name))).toEqual([]);
    });

    it('offers no trust check that takes a digest from its caller', () => {
        expect(Object.keys(protocol).filter((name) => /ForInputDigest|ForOutputDigest/u.test(name))).toEqual([]);
    });
});
