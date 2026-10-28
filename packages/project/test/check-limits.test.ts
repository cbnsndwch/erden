import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    decodeCheckProjectReport,
    encodeCheckProjectReport,
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    serializeLockfile,
    type CheckProjectReport,
    type LoadedManifestV1,
} from '@erden/contracts';
import {
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerService,
    type ReasonerServiceShape,
} from '@erden/ontology';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    DEFAULT_REASONER_LIMITS,
    makeCheckProjectService,
    makeManifestService,
    type ReasonerLimits,
} from '../src/index.js';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

const ONTOLOGY = `
@prefix ex: <https://example.test/limits#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://example.test/limits> a owl:Ontology ; rdfs:label "limits" .
ex:A a owl:Class ; rdfs:label "A" .
ex:B a owl:Class ; rdfs:label "B" ; rdfs:subClassOf ex:A .
ex:i a ex:B ; rdfs:label "i" .
`;

const RAISED: ReasonerLimits = Object.freeze({
    maxWallTimeMs: 120_000,
    maxInputAxioms: 500_000,
    maxInferences: 400_000,
    maxRequestBytes: 67_108_864,
});

const TOOLCHAIN = Effect.runSync(nodeCurrentToolchainService.inspect());
/** The reasoner the lock names, which the check requires the reasoner to be. */
const LOCKED = { version: TOOLCHAIN.reasoner.version, calculusDigest: `sha256:${TOOLCHAIN.reasoner.sha256}` };

function writeProject(): string {
    const root = makeTestTempRoot('erden-check-limits-');
    tempRoots.push(root);
    writeFileSync(join(root, 'ontology.ttl'), ONTOLOGY, 'utf8');
    const manifest: LoadedManifestV1['manifest'] = {
        schemaVersion: 1,
        canonicalIri: 'https://example.test/limits',
        alias: '@example/limits',
        ownedIriPrefixes: ['https://example.test/limits#'],
        sources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
        citationRoots: {},
        dependencies: {},
    };
    writeFileSync(join(root, 'erden.config.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'erden.lock'), serializeLockfile(makeEmptyLockfile(manifest, TOOLCHAIN)), 'utf8');
    return root;
}

function spyService() {
    const decide = vi.fn(nodeReasonerService.decideAndMaterialize);
    const reasoner: ReasonerServiceShape = { ...nodeReasonerService, decideAndMaterialize: decide };
    const service = makeCheckProjectService(
        makeManifestService(),
        makeOntologyService(makeNodeOntologyPorts()),
        reasoner,
    );
    return { decide, service };
}

function withoutLimits(report: CheckProjectReport): unknown {
    const json = JSON.parse(encodeCheckProjectReport(report)) as { reasoning: Record<string, unknown> };
    delete json.reasoning.limits;
    return json;
}

describe('reasoner limits through CheckProject', () => {
    it('sends the documented defaults when no limits are given and records them in the report', async () => {
        const root = writeProject();
        const { decide, service } = spyService();
        const report = await Effect.runPromise(service.check({ from: root, offline: true }));
        expect(report.outcome).toBe('passed');
        expect(decide).toHaveBeenCalledTimes(1);
        expect(decide.mock.calls[0]?.[1]).toEqual({ limits: DEFAULT_REASONER_LIMITS, lockedReasoner: LOCKED });
        expect(report.reasoning.limits).toEqual(DEFAULT_REASONER_LIMITS);
    });

    it('passes one limits value to the reasoner and the report, leaving every identity unchanged', async () => {
        const root = writeProject();
        const lockBefore = readFileSync(join(root, 'erden.lock'));
        const { decide, service } = spyService();
        const base = await Effect.runPromise(service.check({ from: root, offline: true }));
        const raised = await Effect.runPromise(service.check({ from: root, offline: true, reasonerLimits: RAISED }));
        expect(decide.mock.calls[1]?.[1]).toEqual({ limits: RAISED, lockedReasoner: LOCKED });
        expect(raised.reasoning.limits).toEqual(RAISED);
        expect(raised.reasoning.inputDigest).toBe(base.reasoning.inputDigest);
        expect(raised.reasoning.requestId).toBe(base.reasoning.requestId);
        expect(raised.reasoning.tool).toEqual(base.reasoning.tool);
        expect(raised.reasoning.profile).toEqual(base.reasoning.profile);
        expect(withoutLimits(raised)).toEqual(withoutLimits(base));
        expect(readFileSync(join(root, 'erden.lock')).equals(lockBefore)).toBe(true);
    });

    it('still decodes a report stored before limits were recorded, to the same bytes', async () => {
        const root = writeProject();
        const { service } = spyService();
        const report = await Effect.runPromise(service.check({ from: root, offline: true }));
        const stored = withoutLimits(report);
        const storedBytes = `${JSON.stringify(stored)}\n`;
        const decoded = decodeCheckProjectReport(JSON.parse(storedBytes));
        expect('limits' in decoded.reasoning).toBe(false);
        expect(encodeCheckProjectReport(decoded)).toBe(storedBytes);
    });

    it('still decodes a report whose limits predate the request ceiling, to the same bytes', async () => {
        const root = writeProject();
        const { service } = spyService();
        const report = await Effect.runPromise(service.check({ from: root, offline: true }));
        const json = JSON.parse(encodeCheckProjectReport(report)) as { reasoning: { limits: Record<string, unknown> } };
        expect(json.reasoning.limits.maxRequestBytes).toBe(16_777_216);
        delete json.reasoning.limits.maxRequestBytes;
        const storedBytes = `${JSON.stringify(json)}\n`;
        const decoded = decodeCheckProjectReport(JSON.parse(storedBytes));
        expect(decoded.reasoning.limits).toEqual({
            maxWallTimeMs: 30_000,
            maxInputAxioms: 100_000,
            maxInferences: 100_000,
        });
        expect(encodeCheckProjectReport(decoded)).toBe(storedBytes);
    });

    it('refuses a report whose recorded limits are not positive integers', async () => {
        const root = writeProject();
        const { service } = spyService();
        const report = await Effect.runPromise(service.check({ from: root, offline: true }));
        const json = JSON.parse(encodeCheckProjectReport(report)) as {
            reasoning: { limits: Record<string, unknown> };
        };
        json.reasoning.limits.maxWallTimeMs = 0;
        expect(() => decodeCheckProjectReport(json)).toThrow(TypeError);
    });
});
