import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    makeCurrentToolchainService,
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    serializeLockfile,
    type LoadedManifestV1,
    type LockToolchain,
} from '@erden/contracts';
import {
    makeNodeOntologyPorts,
    makeOntologyService,
    makeReasonerService,
    type ReasonerArtifact,
} from '@erden/ontology';
import type { RequiredTool } from '@erden/reasoner-protocol';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { makeCheckProjectService, makeManifestService, nodeProjectDependencyStateService } from '../src/index.js';

import { answeringReasonerPort } from './support/answering-reasoner.js';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

const BUNDLED = Effect.runSync(nodeCurrentToolchainService.inspect());

/** A reasoner build other than the bundled one, answering with its own identity (as a measured build does). */
const OTHER_TOOL: RequiredTool = Object.freeze({
    name: 'erden-reasoner',
    version: '0.2.0+purrdf.0.12.0.dfb1df7',
    executableDigest: `sha256:${'a'.repeat(64)}`,
    adapterDigest: `sha256:${'b'.repeat(64)}`,
    calculusDigest: `sha256:${'c'.repeat(64)}`,
});

function toolchainOf(tool: RequiredTool): LockToolchain {
    return { ...BUNDLED, reasoner: { version: tool.version, sha256: tool.calculusDigest.slice('sha256:'.length) } };
}

/** A project with no dependencies whose erden.lock names `toolchain`. */
function project(toolchain: LockToolchain): string {
    const root = makeTestTempRoot('erden-check-reasoner-lock-');
    roots.push(root);
    const manifest: LoadedManifestV1['manifest'] = {
        schemaVersion: 1,
        canonicalIri: 'https://example.test/root',
        alias: '@example/root',
        ownedIriPrefixes: ['https://example.test/root#'],
        title: 'Root ontology',
        sources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
        citationRoots: {},
        dependencies: {},
    };
    writeFileSync(join(root, 'erden.config.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
        join(root, 'ontology.ttl'),
        '@prefix ex: <https://example.test/root#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . ex:A a owl:Class .\n',
    );
    writeFileSync(join(root, 'erden.lock'), serializeLockfile(makeEmptyLockfile(manifest, toolchain)));
    return root;
}

function check(root: string, artifact: ReasonerArtifact, current: LockToolchain, calls: { count: number }) {
    return makeCheckProjectService(
        makeManifestService(),
        makeOntologyService(makeNodeOntologyPorts()),
        makeReasonerService(answeringReasonerPort(calls), () => artifact),
        nodeProjectDependencyStateService,
        makeCurrentToolchainService(() => current),
    ).check({ from: root, offline: true });
}

describe('the reasoner a check runs is the one its lock was checked against', () => {
    const artifact: ReasonerArtifact = Object.freeze({
        path: '/nonexistent/erden-reasoner',
        // A build the distribution did not qualify: its version is not the bundled one.
        requiredTool: OTHER_TOOL as unknown as ReasonerArtifact['requiredTool'],
    });

    it('refuses before reasoning when the reasoner is not the toolchain the lock was checked against', async () => {
        const calls = { count: 0 };
        const failure = await Effect.runPromise(Effect.flip(check(project(BUNDLED), artifact, BUNDLED, calls)));
        expect(failure).toMatchObject({ stage: 'reasoning', code: 'CHECK_REASONER_NOT_LOCKED' });
        expect(failure.diagnostics[0]?.message).toContain(OTHER_TOOL.version);
        expect(calls.count).toBe(0);
    });

    it('checks on another build when the current toolchain and the lock both name it', async () => {
        const calls = { count: 0 };
        const other = toolchainOf(OTHER_TOOL);
        const report = await Effect.runPromise(check(project(other), artifact, other, calls));
        expect(report.outcome).toBe('passed');
        expect(report.reasoning.tool).toMatchObject({ version: OTHER_TOOL.version });
        expect(calls.count).toBe(1);
    });

    it('still names a lock written for another reasoner stale', async () => {
        const calls = { count: 0 };
        const failure = await Effect.runPromise(
            Effect.flip(check(project(BUNDLED), artifact, toolchainOf(OTHER_TOOL), calls)),
        );
        expect(failure).toMatchObject({ code: 'CHECK_LOCK_STALE' });
        expect(calls.count).toBe(0);
    });
});
