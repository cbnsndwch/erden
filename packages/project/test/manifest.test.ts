import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { Effect } from 'effect';
import { validRange } from 'semver';
import { afterEach, describe, expect, it } from 'vitest';

import {
    generateManifestJsonSchema,
    InvalidManifestPathError,
    ManifestAmbiguityError,
    ManifestNotFoundError,
    ManifestParseError,
    normalizePublicationManifestV1,
    parseManifestText,
    PublicationManifestPathError,
    serializeManifestV1,
    type LoadedManifestV1,
    type ManifestSerializationFormat,
} from '@erden/contracts';

import { discoverManifest, loadManifest, makeManifestService } from '../src/index.js';

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(TEST_ROOT, 'fixtures', 'manifest');
const PARITY_ROOT = join(FIXTURE_ROOT, 'parity');
const GENERATED_SCHEMA = join(
    TEST_ROOT,
    '..',
    '..',
    'contracts',
    'src',
    'manifest',
    'generated',
    'erden-manifest-v1.schema.json',
);

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'erden-manifest-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        const resolved = resolve(directory);
        if (!resolved.startsWith(resolve(tmpdir()))) {
            throw new Error(`Refusing to remove non-temporary test directory: ${resolved}`);
        }
        rmSync(resolved, { force: true, recursive: true });
    }
});

function captureParseError(operation: () => unknown): ManifestParseError {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(ManifestParseError);
        return error as ManifestParseError;
    }
    throw new Error('Expected the manifest to fail parsing');
}

function parseJson(value: unknown, filename = 'erden.config.json'): LoadedManifestV1 {
    return parseManifestText({
        filePath: join(FIXTURE_ROOT, 'inline', filename),
        text: JSON.stringify(value, null, 2),
    });
}

function minimalManifest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        schemaVersion: 1,
        canonicalIri: 'https://example.test/ontology/minimal',
        alias: '@acme/minimal',
        ownedIriPrefixes: ['https://example.test/ontology/minimal#'],
        sources: { ontology: ['ontology'] },
        ...overrides,
    };
}

const HOSTILE_CITATION_ROOT_ENTRIES = [
    ['__proto__', 'roots/proto'],
    ['constructor', 'roots/constructor'],
    ['prototype', 'roots/prototype'],
    ['toString', 'roots/to-string'],
    ['valueOf', 'roots/value-of'],
] as const;

function hostileCitationRoots(): Record<string, string> {
    return Object.fromEntries(HOSTILE_CITATION_ROOT_ENTRIES);
}

function malformedUnicodeManifestCases(): ReadonlyArray<
    readonly [Readonly<Record<string, unknown>>, ReadonlyArray<string | number>]
> {
    return [
        [minimalManifest({ title: 'lone-high-\uD800' }), ['title']],
        [minimalManifest({ description: 'lone-low-\uDFFF' }), ['description']],
        [minimalManifest({ sources: { ontology: ['ontology-\uD800'] } }), ['sources', 'ontology', 0]],
        [minimalManifest({ sources: { ontology: ['ontology'], shapes: ['shape-\uDFFF'] } }), ['sources', 'shapes', 0]],
        [
            minimalManifest({
                sources: { ontology: ['ontology'], competencyQuestions: ['question-\uD800'] },
            }),
            ['sources', 'competencyQuestions', 0],
        ],
        [
            minimalManifest({
                citationRoots: Object.fromEntries([['root-\uDFFF', 'docs']]),
            }),
            ['citationRoots', 'root-\uDFFF'],
        ],
        [minimalManifest({ citationRoots: { docs: 'path-\uD800' } }), ['citationRoots', 'docs']],
        [minimalManifest({ dependencies: { '@acme/core': '^1.2.0\uDFFF' } }), ['dependencies', '@acme/core']],
        [minimalManifest({ title: 'before-newline\n\uD800after' }), ['title']],
        [
            minimalManifest({
                citationRoots: Object.fromEntries([['before-newline\n\uDFFFafter', 'docs']]),
            }),
            ['citationRoots', 'before-newline\n\uDFFFafter'],
        ],
    ];
}

function expectSafeFrozenRecord(
    record: Readonly<Record<string, string>>,
    expectedEntries: ReadonlyArray<readonly [string, string]>,
): void {
    const sorted = [...expectedEntries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    expect(Object.keys(record)).toEqual(sorted.map(([key]) => key));
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.isFrozen(record)).toBe(true);
    for (const [key, value] of sorted) {
        expect(Object.hasOwn(record, key)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(record, key)).toEqual({
            value,
            writable: false,
            enumerable: true,
            configurable: false,
        });
    }
}

const MANIFEST_SERIALIZATION_TARGETS: ReadonlyArray<readonly [ManifestSerializationFormat, string]> = [
    ['json', 'erden.config.json'],
    ['jsonc', 'erden.config.jsonc'],
    ['yml', 'erden.config.yml'],
    ['yaml', 'erden.config.yaml'],
    ['toml', 'erden.config.toml'],
];

const NON_CANONICAL_IRI_SPELLINGS = [
    'HTTPS://example.test/ontology',
    'https://EXAMPLE.TEST/ontology',
    'https://example.test:443/ontology',
    'https://example.test/ontology/../core',
    'https://example.test/café',
    'https://example.test/cafe\u0301',
] as const;

const INVALID_REGISTRY_ORIGINS = [
    'ftp://registry.example.test',
    'https://user:secret@registry.example.test',
    'https://registry.example.test/erden',
    'https://registry.example.test/?query=yes',
    'https://registry.example.test/#fragment',
    'https://',
    'data:text/plain,registry',
    'registry.example.test',
] as const;

describe('publication manifest path refinement', () => {
    it('preserves local external citation roots while publication requires package-contained paths', () => {
        const local = parseJson(
            minimalManifest({
                sources: {
                    ontology: ['ontology.ttl'],
                    shapes: ['shapes'],
                    competencyQuestions: ['questions/check.rq'],
                },
                citationRoots: {
                    package: '.',
                    documentation: 'docs/evidence',
                    parent: '../outside',
                    absolute: resolve(FIXTURE_ROOT, 'outside'),
                },
            }),
        );
        expect(local.resolvedCitationRoots.parent).toBe(resolve(local.projectRoot, '../outside'));
        expect(local.resolvedCitationRoots.absolute).toBe(resolve(FIXTURE_ROOT, 'outside'));
        expect(() => normalizePublicationManifestV1(local.manifest)).toThrow(PublicationManifestPathError);

        const portable = normalizePublicationManifestV1(
            minimalManifest({
                sources: {
                    ontology: ['ontology.ttl'],
                    shapes: ['shapes'],
                    competencyQuestions: ['questions/check.rq'],
                },
                citationRoots: { package: '.', documentation: 'docs/evidence' },
            }),
        );
        expect(portable.citationRoots).toEqual({ documentation: 'docs/evidence', package: '.' });
        expect(Object.isFrozen(portable)).toBe(true);
        expect(Object.isFrozen(portable.sources)).toBe(true);
        expect(Object.isFrozen(portable.citationRoots)).toBe(true);
    });

    it.each([
        ['absolute-posix', '/private/evidence'],
        ['absolute-drive', 'C:/private/evidence'],
        ['absolute-unc', '\\\\server\\share\\evidence'],
        ['backslash', 'docs\\evidence'],
        ['parent', '../evidence'],
        ['nested-parent', 'docs/../evidence'],
        ['dot-segment', './evidence'],
        ['empty-segment', 'docs//evidence'],
        ['control', 'docs/\u0001evidence'],
        ['non-nfc', 'docs/cafe\u0301'],
    ] as const)('rejects nonportable publication citation root %s without exposing its value', (_label, path) => {
        let failure: unknown;
        try {
            normalizePublicationManifestV1(minimalManifest({ citationRoots: { evidence: path } }));
        } catch (cause) {
            failure = cause;
        }
        expect(failure).toBeInstanceOf(PublicationManifestPathError);
        expect(failure).toMatchObject({
            code: 'PUBLICATION_MANIFEST_PATH_UNSAFE',
            kind: 'citation-root',
            entry: 'evidence',
        });
        expect(JSON.stringify(failure)).not.toContain(path);
    });

    it.each(MANIFEST_SERIALIZATION_TARGETS)(
        'applies one publication path policy after decoding %s',
        (format, filename) => {
            const value = minimalManifest({
                sources: { ontology: ['../outside.ttl'] },
                citationRoots: { evidence: '.' },
            });
            const loaded = parseManifestText({
                filePath: join(FIXTURE_ROOT, 'inline', filename),
                text: serializeManifestV1(value, format),
            });
            expect(() => normalizePublicationManifestV1(loaded.manifest)).toThrow(PublicationManifestPathError);
        },
    );
});

describe('manifest serialization parity', () => {
    it('decodes all five recognized serializations to the same normalized model', () => {
        const filenames = [
            'erden.config.json',
            'erden.config.jsonc',
            'erden.config.yml',
            'erden.config.yaml',
            'erden.config.toml',
        ] as const;
        const loaded = filenames.map((filename) =>
            parseManifestText({
                filePath: join(PARITY_ROOT, filename),
                text: readFileSync(join(PARITY_ROOT, filename), 'utf8'),
            }),
        );
        for (const document of loaded.slice(1)) {
            expect(document.manifest).toEqual(loaded[0]?.manifest);
            expect(document.resolvedSources).toEqual(loaded[0]?.resolvedSources);
            expect(document.resolvedCitationRoots).toEqual(loaded[0]?.resolvedCitationRoots);
        }
        expect(loaded[0]?.manifest).toEqual({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/ontology/notes#',
            alias: '@acme/notes',
            ownedIriPrefixes: ['https://example.test/ontology/notes#', 'urn:acme:notes:'],
            title: 'Notes ontology',
            description: 'A portable manifest fixture.',
            registry: 'https://registry.example.test',
            sources: {
                ontology: ['ontology', 'imports/shared.ttl'],
                shapes: ['shapes'],
                competencyQuestions: ['questions'],
            },
            citationRoots: {
                repository: '.',
                shared: '../shared-citations',
            },
            dependencies: {
                '@erden/core': '^1.2.0',
                'https://example.test/ontology/vocab': '~3.4.0',
            },
        });
    });

    it('allows comments only in JSONC and allows $schema only in JSON/JSONC', () => {
        const commented = `{
      // editor comment
      "schemaVersion": 1,
      "canonicalIri": "urn:example:comments",
      "alias": "@acme/comments",
      "ownedIriPrefixes": ["urn:example:comments:"],
      "sources": { "ontology": ["ontology"] }
    }`;
        expect(
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'inline', 'erden.config.jsonc'),
                text: commented,
            }).manifest.canonicalIri,
        ).toBe('urn:example:comments');
        expect(
            captureParseError(() =>
                parseManifestText({
                    filePath: join(FIXTURE_ROOT, 'inline', 'erden.config.json'),
                    text: commented,
                }),
            ).diagnostics[0]?.code,
        ).toBe('syntax');

        expect(
            parseJson(
                minimalManifest({
                    $schema: 'https://erden.dev/schemas/manifest/v1.json',
                }),
            ).manifest.canonicalIri,
        ).toBe('https://example.test/ontology/minimal');
        expect(
            captureParseError(() =>
                parseJson(
                    minimalManifest({
                        $schema: 'https://example.test/not-the-erden-schema.json',
                    }),
                ),
            ).diagnostics[0]?.path,
        ).toEqual(['$schema']);

        const yamlWithSchema = `$schema: https://erden.dev/schemas/manifest/v1.json
schemaVersion: 1
canonicalIri: urn:example:yaml
alias: "@acme/yaml"
ownedIriPrefixes: ["urn:example:yaml:"]
sources: { ontology: [ontology] }
`;
        const error = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'inline', 'erden.config.yaml'),
                text: yamlWithSchema,
            }),
        );
        expect(error.diagnostics.map(({ code }) => code)).toEqual(['unsupported-field']);
    });

    it('emits one canonical, round-trippable textual contract for all five formats', () => {
        const input = minimalManifest({
            title: 'A "quoted" title',
            description: 'Line one\nline two\u0001\u{1f642}',
            registry: 'HTTPS://REGISTRY.EXAMPLE.TEST:443/',
            ownedIriPrefixes: ['urn:example:z:', 'https://example.test/ontology/minimal#'],
            sources: {
                ontology: ['ontology', 'imports/shared.ttl'],
                shapes: ['shapes'],
                competencyQuestions: ['questions/check.rq'],
            },
            citationRoots: {
                zebra: '../zebra',
                'documentation root': 'docs/citations',
            },
            dependencies: {
                'https://example.test/z': '~3.4.0',
                '@acme/core': '^1.2.0',
            },
        });
        const expected = parseJson(input).manifest;
        const output = new Map<ManifestSerializationFormat, string>();
        for (const [format, filename] of MANIFEST_SERIALIZATION_TARGETS) {
            const first = serializeManifestV1(input, format);
            const second = serializeManifestV1(input, format);
            expect(second).toBe(first);
            expect(first.endsWith('\n')).toBe(true);
            expect(first).not.toContain('\r');
            expect(first).not.toMatch(/(?:^|\s)[&*][A-Za-z0-9_-]+/u);
            expect(
                parseManifestText({
                    filePath: join(FIXTURE_ROOT, 'serialized', filename),
                    text: first,
                }).manifest,
            ).toEqual(expected);
            output.set(format, first);
        }
        expect(output.get('yml')).toBe(output.get('yaml'));
        expect(output.get('jsonc')).toBe(output.get('json'));
        expect(output.get('yaml')).toBe(`schemaVersion: 1
canonicalIri: "https://example.test/ontology/minimal"
alias: "@acme/minimal"
ownedIriPrefixes:
  - "https://example.test/ontology/minimal#"
  - "urn:example:z:"
title: "A \\"quoted\\" title"
description: "Line one\\nline two\\u0001🙂"
registry: "https://registry.example.test"
sources:
  ontology:
    - "ontology"
    - "imports/shared.ttl"
  shapes:
    - "shapes"
  competencyQuestions:
    - "questions/check.rq"
citationRoots:
  "documentation root": "docs/citations"
  "zebra": "../zebra"
dependencies:
  "@acme/core": "^1.2.0"
  "https://example.test/z": "~3.4.0"
`);
        expect(output.get('json')).toContain(`"$schema": "https://erden.dev/schemas/manifest/v1.json"`);
        expect(output.get('yaml')).not.toContain('$schema');
        expect(output.get('toml')).not.toContain('$schema');
    });

    it('sorts unordered fields and preserves the canonical optional-field policy', () => {
        const one = minimalManifest({
            ownedIriPrefixes: ['urn:example:z:', 'urn:example:a:'],
            citationRoots: { zebra: 'z', alpha: 'a' },
            dependencies: { 'urn:example:z': '^2.0.0', '@acme/a': '^1.0.0' },
        });
        const two = minimalManifest({
            ownedIriPrefixes: ['urn:example:a:', 'urn:example:z:'],
            citationRoots: { alpha: 'a', zebra: 'z' },
            dependencies: { '@acme/a': '^1.0.0', 'urn:example:z': '^2.0.0' },
        });
        expect(serializeManifestV1(one, 'yaml')).toBe(serializeManifestV1(two, 'yaml'));

        const minimal = serializeManifestV1(minimalManifest(), 'toml');
        expect(minimal).not.toMatch(
            /title|description|registry|citationRoots|dependencies|shapes|competencyQuestions/u,
        );
        expect(
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'serialized', 'erden.config.toml'),
                text: minimal,
            }).manifest,
        ).toEqual(parseJson(minimalManifest()).manifest);
    });

    it('validates serializer inputs without dropping invalid or excess data', () => {
        for (const invalid of [
            minimalManifest({ title: undefined }),
            minimalManifest({ unexpected: true }),
            minimalManifest({ ownedIriPrefixes: [] }),
            minimalManifest({ ownedIriPrefixes: ['relative-prefix'] }),
            minimalManifest({ sources: { ontology: ['ontology'], unexpected: true } }),
            minimalManifest({ citationRoots: { docs: { path: 'docs', unexpected: true } } }),
            minimalManifest({ $schema: 'https://example.test/not-the-erden-schema.json' }),
        ]) {
            expect(() => serializeManifestV1(invalid, 'json')).toThrow(ManifestParseError);
        }
        expect(() => serializeManifestV1(minimalManifest(), 'ini' as ManifestSerializationFormat)).toThrow(TypeError);
    });

    it('escapes every accepted scalar into valid TOML, including DEL', () => {
        const input = minimalManifest({
            title: 'before\u007fafter',
            description: 'tab\tnewline\nquote"backslash\\astral \u{1f642}',
            citationRoots: { 'root\u007fname': 'path\u007fsegment' },
        });
        const serialized = serializeManifestV1(input, 'toml');
        expect(serialized).toContain('before\\u007fafter');
        expect(serialized).toContain('"root\\u007fname" = "path\\u007fsegment"');
        expect(
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'serialized', 'erden.config.toml'),
                text: serialized,
            }).manifest,
        ).toEqual(parseJson(input).manifest);
    });

    it('escapes YAML-forbidden code points while every format preserves valid Unicode', () => {
        const forbidden = '\u007f\u0080\u0085\u009f\ufffe\uffff';
        const input = minimalManifest({
            title: `title-${forbidden}-end`,
            description: 'C0-\u0001-tab-\t-newline-\n-return-\r-astral-\u{1f642}',
            sources: { ontology: [`ontology-${forbidden}-\u{1f642}`] },
            citationRoots: Object.fromEntries([[`root-${forbidden}-name`, `path-${forbidden}-\u{1f642}`]]),
        });
        const expected = parseJson(input).manifest;

        for (const [format, filename] of MANIFEST_SERIALIZATION_TARGETS) {
            const serialized = serializeManifestV1(input, format);
            expect(
                parseManifestText({
                    filePath: join(FIXTURE_ROOT, 'unicode', filename),
                    text: serialized,
                }).manifest,
            ).toEqual(expected);
            if (format === 'yaml' || format === 'yml') {
                expect(serialized).not.toMatch(/[\u007f-\u009f\ufffe\uffff]/u);
                for (const escape of ['\\u007f', '\\u0080', '\\u0085', '\\u009f', '\\ufffe', '\\uffff']) {
                    expect(serialized).toContain(escape);
                }
            }
        }
    });

    it('preserves hostile citation-root keys safely and deterministically in all five formats', () => {
        const beforePrototypeKeys = Reflect.ownKeys(Object.prototype);
        const one = minimalManifest({ citationRoots: hostileCitationRoots() });
        const two = minimalManifest({
            citationRoots: Object.fromEntries([...HOSTILE_CITATION_ROOT_ENTRIES].reverse()),
        });

        for (const [format, filename] of MANIFEST_SERIALIZATION_TARGETS) {
            const first = serializeManifestV1(one, format);
            expect(serializeManifestV1(two, format)).toBe(first);
            const text = format === 'jsonc' ? `// hostile keys\n${first}` : first;
            const loaded = parseManifestText({
                filePath: join(FIXTURE_ROOT, 'hostile', filename),
                text,
            });
            expectSafeFrozenRecord(loaded.manifest.citationRoots, HOSTILE_CITATION_ROOT_ENTRIES);
        }

        expect(Reflect.ownKeys(Object.prototype)).toEqual(beforePrototypeKeys);
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });

    it('rejects malformed Unicode before emitting any supported format', () => {
        for (const [invalid] of malformedUnicodeManifestCases()) {
            for (const [format] of MANIFEST_SERIALIZATION_TARGETS) {
                expect(() => serializeManifestV1(invalid, format)).toThrow(ManifestParseError);
            }
        }
    });
});

describe('strict parsing and deterministic diagnostics', () => {
    it.each([
        ['erden.config.json', '{"schemaVersion":1,"schemaVersion":1}', 1, 20],
        ['erden.config.jsonc', '{"schemaVersion":1,"schemaVersion":1}', 1, 20],
        ['erden.config.yml', 'schemaVersion: 1\nschemaVersion: 1\n', 2, 1],
        ['erden.config.yaml', 'schemaVersion: 1\nschemaVersion: 1\n', 2, 1],
        ['erden.config.toml', 'schemaVersion = 1\nschemaVersion = 1\n', 2, 1],
    ])('rejects duplicate keys in %s', (filename, text, line, column) => {
        const error = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'invalid', filename),
                text,
            }),
        );
        expect(error.diagnostics.some(({ code }) => code === 'duplicate-key')).toBe(true);
        expect(error.diagnostics[0]?.location).toMatchObject({ line, column });
    });

    it('locates a nested TOML duplicate at the duplicate key start', () => {
        const text = `schemaVersion = 1
canonicalIri = "urn:example:nested-duplicate"
alias = "@acme/nested-duplicate"

[sources]
ontology = ["ontology"]
ontology = ["other"]
`;
        const error = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'invalid', 'erden.config.toml'),
                text,
            }),
        );
        expect(error.diagnostics).toHaveLength(1);
        expect(error.diagnostics[0]).toMatchObject({
            code: 'duplicate-key',
            location: { line: 7, column: 1 },
        });
    });

    it.each([
        [
            'numeric/string collision',
            'schemaVersion: 1\ncanonicalIri: urn:example:typed-key\nalias: "@acme/typed-key"\nownedIriPrefixes: ["urn:example:typed-key:"]\nsources: { ontology: [ontology] }\n1: numeric\n"1": string\n',
            6,
        ],
        [
            'boolean/string collision',
            'schemaVersion: 1\ncanonicalIri: urn:example:typed-key\nalias: "@acme/typed-key"\nownedIriPrefixes: ["urn:example:typed-key:"]\nsources: { ontology: [ontology] }\ncitationRoots:\n  true: boolean\n  "true": string\n',
            7,
        ],
        [
            'lone nested numeric key',
            'schemaVersion: 1\ncanonicalIri: urn:example:typed-key\nalias: "@acme/typed-key"\nownedIriPrefixes: ["urn:example:typed-key:"]\nsources:\n  ontology: [ontology]\n  1: coerced\n',
            7,
        ],
        [
            'lone top-level boolean key',
            'schemaVersion: 1\ncanonicalIri: urn:example:typed-key\nalias: "@acme/typed-key"\nownedIriPrefixes: ["urn:example:typed-key:"]\nsources: { ontology: [ontology] }\nfalse: coerced\n',
            6,
        ],
        [
            'complex collection key',
            'schemaVersion: 1\ncanonicalIri: urn:example:typed-key\nalias: "@acme/typed-key"\nownedIriPrefixes: ["urn:example:typed-key:"]\nsources: { ontology: [ontology] }\ncitationRoots:\n  ? [complex, key]\n  : coerced\n',
            7,
        ],
    ])('rejects YAML %s before string-key coercion', (_label, text, line) => {
        const filePath = join(FIXTURE_ROOT, 'invalid', 'erden.config.yaml');
        const first = captureParseError(() => parseManifestText({ filePath, text }));
        const second = captureParseError(() => parseManifestText({ filePath, text }));
        expect(first.diagnostics).toEqual(second.diagnostics);
        expect(first.diagnostics).toHaveLength(1);
        expect(first.diagnostics[0]).toMatchObject({
            code: 'syntax',
            location: { line },
        });
        expect(first.diagnostics[0]?.message).toContain('mapping keys must be strings');
    });

    it.each([
        ['erden.config.json', JSON.stringify({ ...minimalManifest(), descrption: 'typo' }, null, 2)],
        ['erden.config.jsonc', JSON.stringify({ ...minimalManifest(), descrption: 'typo' }, null, 2)],
        [
            'erden.config.yml',
            'schemaVersion: 1\ncanonicalIri: urn:example:x\nalias: "@acme/x"\nownedIriPrefixes: ["urn:example:x:"]\nsources: { ontology: [ontology] }\ndescrption: typo\n',
        ],
        [
            'erden.config.yaml',
            'schemaVersion: 1\ncanonicalIri: urn:example:x\nalias: "@acme/x"\nownedIriPrefixes: ["urn:example:x:"]\nsources: { ontology: [ontology] }\ndescrption: typo\n',
        ],
        [
            'erden.config.toml',
            'schemaVersion = 1\ncanonicalIri = "urn:example:x"\nalias = "@acme/x"\nownedIriPrefixes = ["urn:example:x:"]\ndescrption = "typo"\n[sources]\nontology = ["ontology"]\n',
        ],
    ])('rejects unknown fields with locations and typo suggestions in %s', (filename, text) => {
        const error = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'invalid', filename),
                text,
            }),
        );
        expect(error.diagnostics).toHaveLength(1);
        expect(error.diagnostics[0]).toMatchObject({
            code: 'unknown-field',
            path: ['descrption'],
            suggestion: 'description',
        });
        expect(error.diagnostics[0]?.location.line).toBeGreaterThan(1);
    });

    it.each([
        [
            {
                canonicalIri: 'urn:example:x',
                alias: '@acme/x',
                ownedIriPrefixes: ['urn:example:x:'],
                sources: { ontology: ['ontology'] },
            },
            'missing-schema-version',
        ],
        [minimalManifest({ schemaVersion: '1' }), 'invalid-schema-version'],
        [minimalManifest({ schemaVersion: 1.5 }), 'invalid-schema-version'],
        [minimalManifest({ schemaVersion: 2 }), 'unsupported-schema-version'],
    ])('rejects missing, noninteger, and unsupported schema versions', (value, expectedCode) => {
        const error = captureParseError(() => parseJson(value));
        expect(error.diagnostics.map(({ code }) => code)).toEqual([expectedCode]);
        expect(error.message).toContain('schemaVersion');
    });

    it('sorts multi-error diagnostics deterministically', () => {
        const text = JSON.stringify(
            {
                ...minimalManifest(),
                zzzUnknown: true,
                aaaUnknown: true,
                dependencies: { relative: '^1.0.0' },
            },
            null,
            2,
        );
        const first = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'invalid', 'erden.config.json'),
                text,
            }),
        );
        const second = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'invalid', 'erden.config.json'),
                text,
            }),
        );
        expect(second.message).toBe(first.message);
        expect(second.diagnostics).toEqual(first.diagnostics);
        expect(first.diagnostics.map(({ path }) => path)).toEqual([
            ['zzzUnknown'],
            ['aaaUnknown'],
            ['dependencies', 'relative'],
        ]);
    });

    it('reports malformed syntax at a stable source location', () => {
        const error = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'invalid', 'erden.config.json'),
                text: '{\n  "schemaVersion": 1,\n  "alias": ',
            }),
        );
        expect(error.diagnostics[0]).toMatchObject({ code: 'syntax' });
        expect(error.diagnostics[0]?.location).toMatchObject({ line: 3 });
    });
});

describe('identity, registry, dependencies, and paths', () => {
    it.each([
        'https://example.test/ontology/core',
        'http://example.test/ontology#',
        'https://xn--r8jz45g.xn--zckzah/ontology',
        'https://example.test/%E3%82%AA%E3%83%B3%E3%83%88%E3%83%AD%E3%82%B8%E3%83%BC',
        'urn:example:ontology',
    ])('accepts href-equal canonical ontology IRI %s', (canonicalIri) => {
        expect(new URL(canonicalIri).href).toBe(canonicalIri);
        expect(parseJson(minimalManifest({ canonicalIri })).manifest.canonicalIri).toBe(canonicalIri);
    });

    it.each([
        'HTTPS://example.test/ontology',
        'https://EXAMPLE.TEST/ontology',
        'https://example.test:443/ontology',
        'http://example.test:80/ontology',
        'https://example.test:443',
        'https://example.test',
        'https://example.test/ontology/../core',
        'https://例え.テスト/ontology',
        'https://example.test/オントロジー',
        'https://example.test/with space',
        'relative/ontology',
        'not an iri',
        '',
    ])('rejects noncanonical or invalid ontology IRI %s', (canonicalIri) => {
        try {
            expect(new URL(canonicalIri).href).not.toBe(canonicalIri);
        } catch {
            // Invalid absolute URLs are also invalid canonical IRIs.
        }
        const error = captureParseError(() => parseJson(minimalManifest({ canonicalIri })));
        expect(error.diagnostics[0]?.path).toEqual(['canonicalIri']);
    });

    it.each([
        ['https://registry.example.test', 'https://registry.example.test'],
        ['https://registry.example.test:443/', 'https://registry.example.test'],
        ['HTTPS://REGISTRY.EXAMPLE.TEST:443/', 'https://registry.example.test'],
        ['http://ERDEN-LAN:80/', 'http://erden-lan'],
        ['http://erden-lan:8080', 'http://erden-lan:8080'],
        ['http://192.168.1.20', 'http://192.168.1.20'],
        ['http://[2001:db8::1]:8080/', 'http://[2001:db8::1]:8080'],
    ])('accepts and normalizes registry origin %s', (registry, normalized) => {
        expect(parseJson(minimalManifest({ registry })).manifest.registry).toBe(normalized);
    });

    it('emits normalized registry origins deterministically in every format', () => {
        for (const [format, filename] of MANIFEST_SERIALIZATION_TARGETS) {
            const serialized = serializeManifestV1(
                minimalManifest({
                    registry: 'HTTPS://REGISTRY.EXAMPLE.TEST:443/',
                }),
                format,
            );
            expect(serialized).not.toContain('REGISTRY.EXAMPLE.TEST');
            expect(
                parseManifestText({
                    filePath: join(FIXTURE_ROOT, 'registry', filename),
                    text: serialized,
                }).manifest.registry,
            ).toBe('https://registry.example.test');
        }
    });

    it.each(['refuse', 'report'] as const)(
        'keeps an explicit outsideProfile of %s through every format',
        (outsideProfile) => {
            for (const [format, filename] of MANIFEST_SERIALIZATION_TARGETS) {
                const serialized = serializeManifestV1(minimalManifest({ outsideProfile }), format);
                const parsed = parseManifestText({
                    filePath: join(FIXTURE_ROOT, 'outside-profile', filename),
                    text: serialized,
                }).manifest;
                expect(parsed.outsideProfile).toBe(outsideProfile);
                expect(serializeManifestV1(parsed, format)).toBe(serialized);
            }
        },
    );

    it('leaves outsideProfile absent by default and rejects any other value', () => {
        expect(parseJson(minimalManifest({})).manifest.outsideProfile).toBeUndefined();
        for (const outsideProfile of ['Report', 'warn', true]) {
            const error = captureParseError(() => parseJson(minimalManifest({ outsideProfile })));
            expect(error.diagnostics[0]?.path).toEqual(['outsideProfile']);
        }
    });

    it.each(INVALID_REGISTRY_ORIGINS)('rejects non-origin registry value %s', (registry) => {
        const error = captureParseError(() => parseJson(minimalManifest({ registry })));
        expect(error.diagnostics[0]?.path).toEqual(['registry']);
    });

    it.each(['acme/package', '@Acme/package', '@acme', '@/package'])('rejects invalid scoped alias %s', (alias) => {
        const error = captureParseError(() => parseJson(minimalManifest({ alias })));
        expect(error.diagnostics[0]?.path).toEqual(['alias']);
    });

    it.each([
        [minimalManifest({ ownedIriPrefixes: undefined }), ['ownedIriPrefixes']],
        [minimalManifest({ ownedIriPrefixes: [] }), ['ownedIriPrefixes']],
        [minimalManifest({ ownedIriPrefixes: ['urn:example:owned:', 'urn:example:owned:'] }), ['ownedIriPrefixes']],
        [minimalManifest({ ownedIriPrefixes: ['relative/prefix'] }), ['ownedIriPrefixes', 0]],
        [minimalManifest({ ownedIriPrefixes: ['HTTPS://EXAMPLE.TEST/owned#'] }), ['ownedIriPrefixes', 0]],
    ])('requires explicit, nonempty, unique, canonical owned IRI prefixes', (value, path) => {
        const error = captureParseError(() => parseJson(value));
        expect(error.diagnostics.some((diagnostic) => JSON.stringify(diagnostic.path) === JSON.stringify(path))).toBe(
            true,
        );
    });

    it.each(NON_CANONICAL_IRI_SPELLINGS)('applies exact URL canonicality to owned IRI prefix %s', (ownedIriPrefix) => {
        const error = captureParseError(() =>
            parseJson(
                minimalManifest({
                    ownedIriPrefixes: [ownedIriPrefix],
                }),
            ),
        );
        expect(error.diagnostics[0]?.path).toEqual(['ownedIriPrefixes', 0]);
    });

    it('does not infer IRI ownership from the canonical ontology IRI', () => {
        const withoutOwnership = minimalManifest();
        delete withoutOwnership.ownedIriPrefixes;
        const error = captureParseError(() => parseJson(withoutOwnership));
        expect(error.diagnostics[0]?.path).toEqual(['ownedIriPrefixes']);
    });

    it.each(malformedUnicodeManifestCases())(
        'rejects lone UTF-16 surrogates in every free-string field class %#',
        (value, path) => {
            const error = captureParseError(() => parseJson(value));
            expect(
                error.diagnostics.some((diagnostic) => JSON.stringify(diagnostic.path) === JSON.stringify(path)),
            ).toBe(true);
        },
    );

    it('accepts alias and IRI dependency keys, validates ranges, and sorts keys', () => {
        const loaded = parseJson(
            minimalManifest({
                dependencies: {
                    'https://example.test/z': '~3.4.0',
                    '@acme/core': '^1.2.0',
                },
            }),
        );
        expect(Object.keys(loaded.manifest.dependencies)).toEqual(['@acme/core', 'https://example.test/z']);
        const invalidRange = captureParseError(() =>
            parseJson(
                minimalManifest({
                    dependencies: { '@acme/core': 'definitely-not-semver' },
                }),
            ),
        );
        expect(invalidRange.diagnostics[0]?.path).toEqual(['dependencies', '@acme/core']);
    });

    it('rejects dependency identifiers that are neither aliases nor absolute IRIs', () => {
        const error = captureParseError(() =>
            parseJson(
                minimalManifest({
                    dependencies: { core: '^1.0.0' },
                }),
            ),
        );
        expect(error.diagnostics[0]).toMatchObject({
            code: 'invalid-dependency-identifier',
            path: ['dependencies', 'core'],
        });
    });

    it.each(NON_CANONICAL_IRI_SPELLINGS)('rejects noncanonical IRI dependency identifier %s', (identifier) => {
        const error = captureParseError(() =>
            parseJson(
                minimalManifest({
                    dependencies: Object.fromEntries([[identifier, '^1.0.0']]),
                }),
            ),
        );
        expect(error.diagnostics[0]).toMatchObject({
            code: 'invalid-dependency-identifier',
            path: ['dependencies', identifier],
        });
    });

    it.each([
        [{ '': 'docs' }, ['citationRoots', '']],
        [{ ' docs': 'docs' }, ['citationRoots', ' docs']],
        [{ 'docs ': 'docs' }, ['citationRoots', 'docs ']],
        [{ docs: '' }, ['citationRoots', 'docs']],
        [{ docs: ' docs' }, ['citationRoots', 'docs']],
        [{ docs: 'docs\u0000bad' }, ['citationRoots', 'docs']],
        [{ docs: { path: 'docs', unexpected: true } }, ['citationRoots', 'docs']],
    ])('rejects invalid citation-root maps %#', (citationRoots, path) => {
        const error = captureParseError(() => parseJson(minimalManifest({ citationRoots })));
        expect(error.diagnostics.some((diagnostic) => JSON.stringify(diagnostic.path) === JSON.stringify(path))).toBe(
            true,
        );
    });

    it.each([
        [
            'erden.config.json',
            JSON.stringify(
                { ...minimalManifest(), citationRoots: { docs: 'docs', nested: { path: 'nested', unexpected: true } } },
                null,
                2,
            ),
        ],
        [
            'erden.config.jsonc',
            JSON.stringify(
                { ...minimalManifest(), citationRoots: { docs: 'docs', nested: { path: 'nested', unexpected: true } } },
                null,
                2,
            ),
        ],
        [
            'erden.config.yml',
            'schemaVersion: 1\ncanonicalIri: urn:example:x\nalias: "@acme/x"\nownedIriPrefixes: ["urn:example:x:"]\nsources: { ontology: [ontology] }\ncitationRoots:\n  docs: docs\n  nested: { path: nested, unexpected: true }\n',
        ],
        [
            'erden.config.yaml',
            'schemaVersion: 1\ncanonicalIri: urn:example:x\nalias: "@acme/x"\nownedIriPrefixes: ["urn:example:x:"]\nsources: { ontology: [ontology] }\ncitationRoots:\n  docs: docs\n  nested: { path: nested, unexpected: true }\n',
        ],
        [
            'erden.config.toml',
            'schemaVersion = 1\ncanonicalIri = "urn:example:x"\nalias = "@acme/x"\nownedIriPrefixes = ["urn:example:x:"]\n[sources]\nontology = ["ontology"]\n[citationRoots]\ndocs = "docs"\nnested = { path = "nested", unexpected = true }\n',
        ],
    ])('rejects invalid citation-root structure with a source location in %s', (filename, text) => {
        const error = captureParseError(() =>
            parseManifestText({
                filePath: join(FIXTURE_ROOT, 'invalid', filename),
                text,
            }),
        );
        const diagnostic = error.diagnostics.find(
            ({ path }) => JSON.stringify(path) === JSON.stringify(['citationRoots', 'nested']),
        );
        expect(diagnostic?.location.line).toBeGreaterThan(1);
    });

    it('resolves every relative source and citation-root path from the selected config directory', () => {
        const root = makeTemporaryDirectory();
        const project = join(root, 'project');
        mkdirSync(project, { recursive: true });
        const loaded = parseManifestText({
            filePath: join(project, 'erden.config.json'),
            text: JSON.stringify(
                minimalManifest({
                    sources: {
                        ontology: ['src/ontology', '../shared/base.ttl'],
                        shapes: ['validation/shapes'],
                        competencyQuestions: ['questions/check.rq'],
                    },
                    citationRoots: {
                        local: 'citations',
                        shared: '../shared/citations',
                        absolute: resolve(root, 'absolute-citations'),
                    },
                }),
            ),
        });
        expect(loaded.projectRoot).toBe(resolve(project));
        expect(loaded.resolvedSources).toEqual({
            ontology: [resolve(project, 'src/ontology'), resolve(project, '../shared/base.ttl')],
            shapes: [resolve(project, 'validation/shapes')],
            competencyQuestions: [resolve(project, 'questions/check.rq')],
        });
        expect(loaded.resolvedCitationRoots).toEqual({
            absolute: resolve(root, 'absolute-citations'),
            local: resolve(project, 'citations'),
            shared: resolve(project, '../shared/citations'),
        });
    });

    it('resolves magic citation-root names as frozen own data properties without prototype effects', () => {
        const root = makeTemporaryDirectory();
        const project = join(root, 'project');
        const beforePrototypeKeys = Reflect.ownKeys(Object.prototype);
        const loaded = parseManifestText({
            filePath: join(project, 'erden.config.json'),
            text: JSON.stringify(minimalManifest({ citationRoots: hostileCitationRoots() })),
        });
        expectSafeFrozenRecord(loaded.manifest.citationRoots, HOSTILE_CITATION_ROOT_ENTRIES);
        expectSafeFrozenRecord(
            loaded.resolvedCitationRoots,
            HOSTILE_CITATION_ROOT_ENTRIES.map(([key, value]) => [key, resolve(project, value)]),
        );
        expect(Reflect.ownKeys(Object.prototype)).toEqual(beforePrototypeKeys);
        expect(Object.getPrototypeOf(loaded.manifest.citationRoots)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(loaded.resolvedCitationRoots)).toBe(Object.prototype);
    });
});

describe('manifest discovery', () => {
    function writeManifest(filePath: string, canonicalIri: string): void {
        mkdirSync(dirname(filePath), { recursive: true });
        const extension = filePath.endsWith('.toml') ? 'toml' : 'json';
        const text =
            extension === 'toml'
                ? `schemaVersion = 1\ncanonicalIri = "${canonicalIri}"\nalias = "@acme/project"\nownedIriPrefixes = ["urn:example:project:"]\n[sources]\nontology = ["ontology"]\n`
                : JSON.stringify(minimalManifest({ canonicalIri }));
        writeFileSync(filePath, text, 'utf8');
    }

    it('selects the nearest ancestor manifest from nested directories', () => {
        const root = makeTemporaryDirectory();
        const nested = join(root, 'packages', 'nested');
        const deep = join(nested, 'src', 'feature');
        mkdirSync(deep, { recursive: true });
        writeManifest(join(root, 'erden.config.json'), 'urn:example:root');
        writeManifest(join(nested, 'erden.config.toml'), 'urn:example:nested');
        expect(discoverManifest({ from: deep }).filePath).toBe(join(nested, 'erden.config.toml'));
    });

    it('uses an explicit recognized config path relative to the supplied start directory', () => {
        const root = makeTemporaryDirectory();
        const nested = join(root, 'nested');
        mkdirSync(nested, { recursive: true });
        const filePath = join(root, 'erden.config.json');
        writeManifest(filePath, 'urn:example:explicit');
        expect(discoverManifest({ from: nested, explicitPath: '../erden.config.json' }).filePath).toBe(filePath);
    });

    it('accepts an arbitrary explicit basename when its extension is supported', () => {
        const root = makeTemporaryDirectory();
        const nested = join(root, 'nested');
        mkdirSync(nested, { recursive: true });
        const filePath = join(root, 'project.settings.yaml');
        writeFileSync(
            filePath,
            'schemaVersion: 1\ncanonicalIri: urn:example:explicit-yaml\nalias: "@acme/explicit"\nownedIriPrefixes: ["urn:example:explicit-yaml:"]\nsources: { ontology: [ontology] }\n',
            'utf8',
        );
        expect(discoverManifest({ from: nested, explicitPath: '../project.settings.yaml' })).toMatchObject({
            filePath,
            format: 'yaml',
        });
        expect(loadManifest({ from: nested, explicitPath: '../project.settings.yaml' }).manifest.canonicalIri).toBe(
            'urn:example:explicit-yaml',
        );
    });

    it('rejects an explicit path whose extension is unsupported', () => {
        const root = makeTemporaryDirectory();
        const filePath = join(root, 'project.settings.ini');
        writeFileSync(filePath, 'schemaVersion = 1\n', 'utf8');
        expect(() => discoverManifest({ from: root, explicitPath: filePath })).toThrow(InvalidManifestPathError);
    });

    it('fails same-directory ambiguity and lists every candidate deterministically', () => {
        const root = makeTemporaryDirectory();
        writeManifest(join(root, 'erden.config.yaml'), 'urn:example:yaml');
        writeManifest(join(root, 'erden.config.json'), 'urn:example:json');
        writeManifest(join(root, 'erden.config.toml'), 'urn:example:toml');
        expect(() => discoverManifest({ from: root })).toThrow(ManifestAmbiguityError);
        try {
            discoverManifest({ from: root });
        } catch (error) {
            expect(error).toBeInstanceOf(ManifestAmbiguityError);
            expect((error as ManifestAmbiguityError).candidates).toEqual([
                join(root, 'erden.config.json'),
                join(root, 'erden.config.toml'),
                join(root, 'erden.config.yaml'),
            ]);
        }
    });

    it('fails clearly when no manifest exists in the ancestor chain', () => {
        const root = makeTemporaryDirectory();
        expect(() => discoverManifest({ from: root })).toThrow(ManifestNotFoundError);
    });
});

describe('duplicate manifest source selectors remain parse-compatible', () => {
    it.each([
        [
            'erden.config.json',
            `{"schemaVersion":1,"canonicalIri":"https://example.test/duplicate","alias":"@example/duplicate","ownedIriPrefixes":["https://example.test/duplicate#"],"sources":{"ontology":["same.ttl","same.ttl"]}}`,
        ],
        [
            'erden.config.jsonc',
            `{// source identity is checked after discovery
"schemaVersion":1,"canonicalIri":"https://example.test/duplicate","alias":"@example/duplicate","ownedIriPrefixes":["https://example.test/duplicate#"],"sources":{"ontology":["same.ttl","same.ttl"]}}`,
        ],
        [
            'erden.config.yml',
            `schemaVersion: 1
canonicalIri: https://example.test/duplicate
alias: "@example/duplicate"
ownedIriPrefixes: ["https://example.test/duplicate#"]
sources:
  ontology: [same.ttl, same.ttl]
`,
        ],
        [
            'erden.config.yaml',
            `schemaVersion: 1
canonicalIri: https://example.test/duplicate
alias: "@example/duplicate"
ownedIriPrefixes: ["https://example.test/duplicate#"]
sources:
  ontology: [same.ttl, same.ttl]
`,
        ],
        [
            'erden.config.toml',
            `schemaVersion = 1
canonicalIri = "https://example.test/duplicate"
alias = "@example/duplicate"
ownedIriPrefixes = ["https://example.test/duplicate#"]
[sources]
ontology = ["same.ttl", "same.ttl"]
`,
        ],
    ] as const)('accepts duplicate selectors in %s for discovery-boundary validation', (filename, text) => {
        expect(parseManifestText({ filePath: join(FIXTURE_ROOT, filename), text }).manifest.sources.ontology).toEqual([
            'same.ttl',
            'same.ttl',
        ]);
    });
});

describe('schema synchronization and Effect service', () => {
    it('keeps the checked-in JSON Schema bytes synchronized with the runtime generator', () => {
        const checkedIn = readFileSync(GENERATED_SCHEMA, 'utf8');
        expect(checkedIn).toBe(`${JSON.stringify(generateManifestJsonSchema(), null, 2)}\n`);
    });

    it('makes the schema URI and ownership prefixes exact and constrains citation-root names and values', () => {
        const schema = generateManifestJsonSchema() as {
            readonly required?: ReadonlyArray<string>;
            readonly properties?: Readonly<
                Record<
                    string,
                    {
                        readonly allOf?: ReadonlyArray<Readonly<Record<string, unknown>>>;
                        readonly enum?: ReadonlyArray<string>;
                        readonly items?: Readonly<Record<string, unknown>>;
                        readonly minItems?: number;
                        readonly uniqueItems?: boolean;
                        readonly additionalProperties?: boolean;
                        readonly patternProperties?: Readonly<Record<string, unknown>>;
                        readonly propertyNames?: Readonly<Record<string, unknown>>;
                    }
                >
            >;
        };
        expect(schema.required).toEqual(['schemaVersion', 'canonicalIri', 'alias', 'ownedIriPrefixes', 'sources']);
        expect(schema.properties?.$schema?.enum).toEqual(['https://erden.dev/schemas/manifest/v1.json']);
        expect(schema.properties?.canonicalIri?.allOf).toContainEqual(
            expect.objectContaining({
                format: 'uri',
                'x-erden-canonical-iri': true,
            }),
        );
        expect(schema.properties?.ownedIriPrefixes).toMatchObject({
            minItems: 1,
            uniqueItems: true,
            items: {
                type: 'string',
                allOf: [
                    expect.objectContaining({
                        format: 'uri',
                        'x-erden-canonical-iri': true,
                    }),
                ],
            },
        });
        expect(schema.properties?.title?.allOf).toContainEqual(
            expect.objectContaining({
                pattern: '^(?![\\s\\S]*[\\uD800-\\uDFFF])[\\s\\S]*$',
            }),
        );
        expect(schema.properties?.registry?.allOf).toContainEqual(
            expect.objectContaining({
                format: 'uri',
                'x-erden-registry-origin': true,
            }),
        );
        expect(schema.properties?.citationRoots?.additionalProperties).toBe(false);
        expect(schema.properties?.citationRoots?.patternProperties).toMatchObject({
            '^(?![\\s\\S]*[\\uD800-\\uDFFF])\\S(?:[\\s\\S]*\\S)?$': {
                type: 'string',
                minLength: 1,
            },
        });
        expect(schema.properties?.dependencies?.propertyNames).toMatchObject({
            anyOf: [
                { pattern: '^@[a-z0-9][a-z0-9-]*\\/[a-z0-9][a-z0-9-]*$' },
                {
                    format: 'uri',
                    'x-erden-canonical-iri': true,
                },
            ],
        });
    });

    it('validates the checked-in Draft 2020-12 schema with an independent compiler', () => {
        const schema = JSON.parse(readFileSync(GENERATED_SCHEMA, 'utf8')) as object;
        const ajv = new Ajv2020({ allErrors: true, strict: true });
        ajv.addKeyword({
            keyword: 'x-erden-canonical-iri',
            type: 'string',
            schemaType: 'boolean',
            errors: false,
            validate: (enabled: boolean, value: string): boolean => {
                if (!enabled) {
                    return true;
                }
                try {
                    return new URL(value).href === value;
                } catch {
                    return false;
                }
            },
        });
        ajv.addKeyword({
            keyword: 'x-erden-registry-origin',
            type: 'string',
            schemaType: 'boolean',
            errors: false,
            validate: (enabled: boolean, value: string): boolean => {
                if (!enabled) {
                    return true;
                }
                try {
                    const parsed = new URL(value);
                    return (
                        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
                        parsed.hostname.length > 0 &&
                        parsed.username.length === 0 &&
                        parsed.password.length === 0 &&
                        parsed.pathname === '/' &&
                        parsed.search.length === 0 &&
                        parsed.hash.length === 0 &&
                        parsed.origin !== 'null'
                    );
                } catch {
                    return false;
                }
            },
        });
        ajv.addFormat('uri', {
            type: 'string',
            validate: (value: string): boolean => {
                try {
                    return new URL(value).protocol.length > 1;
                } catch {
                    return false;
                }
            },
        });
        ajv.addFormat('semver-range', {
            type: 'string',
            validate: (value: string): boolean => validRange(value, { loose: false }) !== null,
        });
        const validate = ajv.compile(schema);
        expect(
            validate(
                minimalManifest({
                    $schema: 'https://erden.dev/schemas/manifest/v1.json',
                    title: 'well-formed \u{1f642}\u0001',
                    registry: 'HTTPS://REGISTRY.EXAMPLE.TEST:443/',
                    citationRoots: Object.fromEntries([
                        ...HOSTILE_CITATION_ROOT_ENTRIES,
                        ['docs-\u{1f642}', 'docs-\u{1f642}-\u0001'],
                    ]),
                    dependencies: {
                        '@acme/core': '^1.2.0',
                        'https://example.test/ontology/core': '~2.0.0',
                    },
                }),
            ),
            JSON.stringify(validate.errors),
        ).toBe(true);

        const omitted = minimalManifest();
        delete omitted.ownedIriPrefixes;
        for (const invalid of [
            omitted,
            minimalManifest({ ownedIriPrefixes: [] }),
            minimalManifest({ ownedIriPrefixes: ['urn:example:owned:', 'urn:example:owned:'] }),
            minimalManifest({ ownedIriPrefixes: ['relative-prefix'] }),
            minimalManifest({ citationRoots: { '': 'docs' } }),
            minimalManifest({ citationRoots: { docs: '' } }),
            minimalManifest({ citationRoots: { docs: { path: 'docs' } } }),
            minimalManifest({ $schema: 'https://example.test/not-the-erden-schema.json' }),
            minimalManifest({ unexpected: true }),
            ...NON_CANONICAL_IRI_SPELLINGS.flatMap((value) => [
                minimalManifest({ canonicalIri: value }),
                minimalManifest({ ownedIriPrefixes: [value] }),
                minimalManifest({ dependencies: Object.fromEntries([[value, '^1.0.0']]) }),
            ]),
            ...INVALID_REGISTRY_ORIGINS.map((registry) => minimalManifest({ registry })),
            ...malformedUnicodeManifestCases().map(([value]) => value),
        ]) {
            expect(validate(invalid), JSON.stringify(invalid)).toBe(false);
        }
    });

    it('exposes parsing through a typed Effect service implementation', () => {
        const service = makeManifestService();
        const success = Effect.runSync(
            service.parse({
                filePath: join(FIXTURE_ROOT, 'inline', 'erden.config.json'),
                text: JSON.stringify(minimalManifest()),
            }),
        );
        expect(success.manifest.alias).toBe('@acme/minimal');

        const failure = Effect.runSync(
            Effect.flip(
                service.parse({
                    filePath: join(FIXTURE_ROOT, 'inline', 'erden.config.json'),
                    text: '{}',
                }),
            ),
        );
        expect(failure).toBeInstanceOf(ManifestParseError);

        const serialized = Effect.runSync(service.serialize(minimalManifest(), 'yaml'));
        expect(serialized).toBe(serializeManifestV1(minimalManifest(), 'yaml'));
    });
});
