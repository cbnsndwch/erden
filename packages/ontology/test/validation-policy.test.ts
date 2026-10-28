import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Effect } from 'effect';
import { Parser, Store } from 'n3';
import { describe, expect, it, vi } from 'vitest';

import {
    captureOntologyValidationPolicy,
    DEFAULT_CITATION_VOCABULARY,
    makeOntologyService,
    ONTOLOGY_VALIDATION_POLICY_DOCUMENT,
    ONTOLOGY_VALIDATION_POLICY_ID,
    ONTOLOGY_VALIDATION_POLICY_SHA256,
    ONTOLOGY_VALIDATION_POLICY_V1_DOCUMENT,
    resolveOntologyValidationSettings,
    SHACL_ENGINE_DIGEST,
    SHACL_ENGINE_VERSION,
    VALIDATION_POLICY_LIMITS,
    ValidationPolicyCaptureError,
    type AssembledOntology,
    type OntologyValidationInput,
    type OntologyValidationSettings,
    type OntologyPorts,
    type GitPort,
} from '../src/index.js';

function input(): OntologyValidationInput {
    return { shapeSources: [], competencyQuestions: [], shacl: { required: false }, cq: { required: false } };
}
function graph(text = ''): AssembledOntology {
    return { dataset: new Store(new Parser().parse(text)), sources: [], provenance: [] };
}
function service(text = '') {
    const readBytes = vi.fn(() => Effect.succeed(new TextEncoder().encode(text)));
    const exists = vi.fn(() => Effect.succeed(true));
    const ontology = makeOntologyService({
        resources: { readBytes, readText: () => Effect.succeed(text), listFiles: () => Effect.succeed([]) },
        citationFiles: { exists },
    });
    return { ontology, readBytes, exists };
}
function digest(settings: OntologyValidationSettings): string {
    return captureOntologyValidationPolicy(settings).sha256;
}

describe('ontology validation policy capture', () => {
    it('pins the behavioral document and the installed validation engines', () => {
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
            dependencies: Record<string, string>;
        };
        const document = JSON.parse(ONTOLOGY_VALIDATION_POLICY_DOCUMENT) as {
            engines: Record<string, { name: string; version: string; engineDigest?: string }>;
        };
        const { shacl, ...libraries } = document.engines;
        for (const engine of Object.values(libraries)) {
            expect(manifest.dependencies[engine.name]).toBe(engine.version);
        }
        // SHACL runs on the bundled erden-shacl, installed through its resolver package at the same version.
        expect(shacl).toEqual({
            name: 'erden-shacl',
            version: SHACL_ENGINE_VERSION,
            engineDigest: SHACL_ENGINE_DIGEST,
        });
        expect(manifest.dependencies['@erden/shacl-distribution']).toBe(`workspace:${SHACL_ENGINE_VERSION}`);
        expect(ONTOLOGY_VALIDATION_POLICY_ID).toBe('erden.ontology-validation-policy/v2');
        expect(ONTOLOGY_VALIDATION_POLICY_DOCUMENT.endsWith('\n')).toBe(true);
        expect(ONTOLOGY_VALIDATION_POLICY_SHA256).toBe(
            createHash('sha256').update(ONTOLOGY_VALIDATION_POLICY_DOCUMENT).digest('hex'),
        );
        expect(ONTOLOGY_VALIDATION_POLICY_SHA256).toBe(
            '1f523355b4da9dd38a13016ef2be6057849d847e4511ee8a9af15c6c4d34ddad',
        );
        // The v1 document is kept byte for byte, so captures recorded under it still verify.
        expect(createHash('sha256').update(ONTOLOGY_VALIDATION_POLICY_V1_DOCUMENT).digest('hex')).toBe(
            'c8bbdb0c42dc638930a86b908c875d017f825f4b1ac47dbf7d2ccddaa78bf667',
        );
    });

    it('recaptures settings under the v1 policy a stored capture names, and refuses an unknown policy', () => {
        const settings = resolveOntologyValidationSettings(input(), false).settings;
        const v1Digest = createHash('sha256').update(ONTOLOGY_VALIDATION_POLICY_V1_DOCUMENT).digest('hex');
        const v1 = captureOntologyValidationPolicy(settings, {
            id: 'erden.ontology-validation-policy/v1',
            sha256: v1Digest,
        });
        expect(v1.policy).toEqual({
            id: 'erden.ontology-validation-policy/v1',
            sha256: v1Digest,
            document: ONTOLOGY_VALIDATION_POLICY_V1_DOCUMENT,
        });
        expect(v1.sha256).not.toBe(captureOntologyValidationPolicy(settings).sha256);
        expect(() =>
            captureOntologyValidationPolicy(settings, {
                id: 'erden.ontology-validation-policy/v1',
                sha256: '0'.repeat(64),
            }),
        ).toThrow(ValidationPolicyCaptureError);
        expect(() =>
            captureOntologyValidationPolicy(settings, { id: 'erden.ontology-validation-policy/v9', sha256: v1Digest }),
        ).toThrow(ValidationPolicyCaptureError);
    });

    it('resolves defaults and retains the exact policy document', async () => {
        const { ontology } = service();
        const result = await Effect.runPromise(
            ontology.validateAssembled(graph(), { ...input(), captureValidationPolicy: true }),
        );
        expect(result.validationPolicy?.policy).toEqual({
            id: ONTOLOGY_VALIDATION_POLICY_ID,
            sha256: ONTOLOGY_VALIDATION_POLICY_SHA256,
            document: ONTOLOGY_VALIDATION_POLICY_DOCUMENT,
        });
        expect(result.validationPolicy?.settings).toEqual({
            shaclRequired: false,
            competencyQuestionsRequired: false,
            citationObservationOwners: 'all',
            citationVocabulary: DEFAULT_CITATION_VOCABULARY,
            citationRootNames: [],
            gitAvailable: false,
        });
        expect(result.conforms).toBe(true);
        expect(result.shacl).toBeNull();
    });

    it('leaves ordinary reports unchanged and performs no extra resource reads', async () => {
        const { ontology, readBytes, exists } = service();
        const data = graph();
        const ordinary = await Effect.runPromise(ontology.validateAssembled(data, input()));
        const captured = await Effect.runPromise(
            ontology.validateAssembled(data, { ...input(), captureValidationPolicy: true }),
        );
        const { validationPolicy, ...rest } = captured;
        expect(validationPolicy).toBeDefined();
        expect(ordinary).not.toHaveProperty('validationPolicy');
        expect(rest).toEqual(ordinary);
        expect(readBytes).not.toHaveBeenCalled();
        expect(exists).not.toHaveBeenCalled();
    });

    it('authenticates canonical global settings without machine-local roots', () => {
        const first = resolveOntologyValidationSettings(
            { ...input(), citationRoots: { z: '/private/z', a: '/private/a' } },
            true,
        );
        const relocated = resolveOntologyValidationSettings(
            { ...input(), citationRoots: { a: '/elsewhere/a', z: '/elsewhere/z' } },
            true,
        );
        const capture = captureOntologyValidationPolicy(first.settings);
        expect(capture).toEqual(captureOntologyValidationPolicy(relocated.settings));
        expect(capture.settings.citationRootNames).toEqual(['a', 'z']);
        expect(JSON.stringify(capture)).not.toContain('/private/');
        const document = `${JSON.stringify({ schema: capture.schema, policy: { id: capture.policy.id, sha256: capture.policy.sha256 }, settings: capture.settings })}\n`;
        expect(capture.sha256).toBe(createHash('sha256').update(document).digest('hex'));
    });

    it('distinguishes every global setting that affects validation', () => {
        const { settings } = resolveOntologyValidationSettings(input(), false);
        const baseline = digest(settings);
        const changed: OntologyValidationSettings[] = [
            { ...settings, shaclRequired: true },
            { ...settings, competencyQuestionsRequired: true },
            { ...settings, citationObservationOwners: 'root' },
            { ...settings, gitAvailable: true },
            { ...settings, citationRootNames: ['default'] },
            ...Object.keys(DEFAULT_CITATION_VOCABULARY).map((key) => ({
                ...settings,
                citationVocabulary: { ...settings.citationVocabulary, [key]: 'urn:different' },
            })),
        ];
        expect(new Set([baseline, ...changed.map(digest)]).size).toBe(changed.length + 1);
    });

    it('copies and deeply freezes settings', () => {
        const vocabulary = { ...DEFAULT_CITATION_VOCABULARY };
        const roots = { default: '/original' };
        const resolved = resolveOntologyValidationSettings(
            { ...input(), citationVocabulary: vocabulary, citationRoots: roots },
            false,
        );
        const capture = captureOntologyValidationPolicy(resolved.settings);
        vocabulary.sourcePath = 'urn:changed';
        roots.default = '/changed';
        expect(capture.settings.citationVocabulary.sourcePath).toBe(DEFAULT_CITATION_VOCABULARY.sourcePath);
        expect(resolved.citationRoots.default).toBe('/original');
        for (const value of [
            capture,
            capture.policy,
            capture.settings,
            capture.settings.citationVocabulary,
            capture.settings.citationRootNames,
            resolved.citationRoots,
        ]) {
            expect(Object.isFrozen(value)).toBe(true);
        }
    });

    it('executes the captured settings when a source read mutates caller settings', async () => {
        const vocabulary = { ...DEFAULT_CITATION_VOCABULARY };
        const roots = { default: '/original' };
        const cq = { required: false };
        const options = {
            ...input(),
            cq,
            citationVocabulary: vocabulary,
            citationRoots: roots,
            captureValidationPolicy: true,
            shapeSources: [
                {
                    id: 'shapes',
                    owner: { role: 'root' as const, canonicalIri: 'urn:root', ownedIriPrefixes: ['urn:root:'] },
                    locator: '/shapes.ttl',
                    baseIri: 'urn:root',
                    mediaType: 'text/turtle' as const,
                },
            ],
        };
        const exists = vi.fn(() => Effect.succeed(true));
        const inspect = vi.fn(() => Effect.succeed({ state: 'unchanged' as const }));
        const ports: OntologyPorts & { git?: GitPort } = {
            resources: {
                readBytes: () =>
                    Effect.sync(() => {
                        cq.required = true;
                        roots.default = '/changed';
                        vocabulary.sourcePath = 'urn:changed';
                        ports.git = { inspect };
                        return new Uint8Array();
                    }),
                readText: () => Effect.succeed(''),
                listFiles: () => Effect.succeed([]),
            },
            citationFiles: { exists },
        };
        const ontology = makeOntologyService(ports);
        const result = await Effect.runPromise(
            ontology.validateAssembled(
                graph(`<urn:observation> <${DEFAULT_CITATION_VOCABULARY.sourcePath}> "file.txt" .`),
                options,
            ),
        );
        expect(result.validationPolicy?.settings.competencyQuestionsRequired).toBe(false);
        expect(result.validationPolicy?.settings.citationVocabulary.sourcePath).toBe(
            DEFAULT_CITATION_VOCABULARY.sourcePath,
        );
        // The root resolves with the host's path rules (D:\original\file.txt on a Windows D: drive).
        expect(exists).toHaveBeenCalledWith(resolve('/original', 'file.txt'));
        expect(result.citations.citations).toHaveLength(1);
        expect(result.validationPolicy?.settings.gitAvailable).toBe(false);
        expect(inspect).not.toHaveBeenCalled();
    });

    it('preserves required-stage failure instead of returning a misleading successful record', async () => {
        const { ontology } = service();
        for (const options of [
            { ...input(), shacl: { required: true } },
            { ...input(), cq: { required: true } },
        ]) {
            const exit = await Effect.runPromiseExit(
                ontology.validateAssembled(graph(), { ...options, captureValidationPolicy: true }),
            );
            expect(exit._tag).toBe('Failure');
        }
    });

    it('records the policy used for SHACL warnings and declared-shape self-tests', async () => {
        const prefixes = '@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <urn:root:> . ';
        const shape =
            'ex:S a sh:NodeShape; sh:targetClass ex:Target; sh:property [ sh:path ex:p; sh:minCount 1; sh:severity sh:Warning ] .';
        const { ontology } = service(prefixes + shape);
        const options: OntologyValidationInput = {
            ...input(),
            captureValidationPolicy: true,
            captureShaclEvidence: true,
            shapeSources: [
                {
                    id: 'shapes',
                    locator: '/shapes.ttl',
                    baseIri: 'urn:root',
                    mediaType: 'text/turtle',
                    owner: { role: 'root', canonicalIri: 'urn:root', ownedIriPrefixes: ['urn:root:'] },
                },
            ],
        };
        const result = await Effect.runPromise(
            ontology.validateAssembled(graph(prefixes + 'ex:item a ex:Target .'), options),
        );
        expect(result.shacl?.counts).toEqual({ violation: 0, warning: 1, info: 0 });
        expect(result.shacl?.selfTest.every((item) => item.fired)).toBe(true);
        expect(result.shacl?.conforms).toBe(true);
        expect(result.validationPolicy?.policy.document).toContain(
            'Violation-findings-or-unfired-declared-shape-self-test',
        );
        expect(result.shaclEvidence?.kind).toBe('complete');
    });

    it('enforces exact root-name and IRI byte limits without truncation', () => {
        const { settings } = resolveOntologyValidationSettings(input(), false);
        const names = Array.from({ length: VALIDATION_POLICY_LIMITS.maxRootNames }, (_, index) => String(index));
        expect(
            captureOntologyValidationPolicy({ ...settings, citationRootNames: names }).settings.citationRootNames,
        ).toHaveLength(names.length);
        expect(() => digest({ ...settings, citationRootNames: [...names, 'extra'] })).toThrow(
            ValidationPolicyCaptureError,
        );
        const name = 'é'.repeat(VALIDATION_POLICY_LIMITS.maxRootNameBytes / 2);
        expect(() => digest({ ...settings, citationRootNames: [name] })).not.toThrow();
        expect(() => digest({ ...settings, citationRootNames: [name + 'a'] })).toThrow(ValidationPolicyCaptureError);
        const value = 'urn:' + 'x'.repeat(VALIDATION_POLICY_LIMITS.maxIriBytes - 4);
        expect(() =>
            digest({ ...settings, citationVocabulary: { ...settings.citationVocabulary, label: value } }),
        ).not.toThrow();
        expect(() =>
            digest({ ...settings, citationVocabulary: { ...settings.citationVocabulary, label: value + 'x' } }),
        ).toThrow(ValidationPolicyCaptureError);
    });

    it('refuses malformed settings with fixed errors and no partial evidence', () => {
        const { settings } = resolveOntologyValidationSettings(input(), false);
        const invalid: unknown[] = [
            { ...settings, shaclRequired: 'yes' },
            { ...settings, citationObservationOwners: 'dependency' },
            { ...settings, gitAvailable: null },
            { ...settings, citationRootNames: ['same', 'same'] },
            { ...settings, citationRootNames: [''] },
            { ...settings, citationRootNames: ['\ud800'] },
            { ...settings, citationVocabulary: { ...settings.citationVocabulary, label: 'relative' } },
            { ...settings, citationVocabulary: { ...settings.citationVocabulary, label: 'urn:bad value' } },
            { ...settings, citationVocabulary: { ...settings.citationVocabulary, label: 'urn:\ud800' } },
        ];
        for (const value of invalid) {
            expect(() => captureOntologyValidationPolicy(value as OntologyValidationSettings)).toThrow(
                ValidationPolicyCaptureError,
            );
        }
        const hostile = {
            ...settings,
            get citationVocabulary(): never {
                throw new Error('private-secret');
            },
        };
        try {
            captureOntologyValidationPolicy(hostile);
            throw new Error('expected rejection');
        } catch (cause) {
            expect(cause).toBeInstanceOf(ValidationPolicyCaptureError);
            expect(String(cause)).not.toContain('private-secret');
            expect(cause).not.toHaveProperty('cause');
        }
    });
});
