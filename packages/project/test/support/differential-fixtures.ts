// The differential comparator's fixture set: small layered projects, each installed against a fixture registry,
// covering the ways a dependent can interact with what its dependencies already settled.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import { validatePackageArchiveStream } from '@erden/package-format';

import {
    makeFixtureDependencyRegistry,
    makeNodeInstallProjectService,
    nodePackProjectService,
    type CheckProjectOptions,
} from '../../src/index.js';

const HEADER = [
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
].join('\n');

interface FixtureLayer {
    /** Short name: alias `@fx/<name>`, IRI `https://fx.test/<name>`, prefix `<name>:`. */
    readonly name: string;
    readonly turtle: string;
    readonly dependencies?: ReadonlyArray<string>;
    readonly outsideProfile?: 'report';
    /** Owns another namespace instead of `https://fx.test/<name>#` (the SKOS fixture). */
    readonly canonicalIri?: string;
}

export interface DifferentialFixture {
    readonly name: string;
    /** The project directory to check. */
    readonly from: string;
    readonly options?: Omit<CheckProjectOptions, 'from'>;
}

function iriOf(layer: FixtureLayer): string {
    return layer.canonicalIri ?? `https://fx.test/${layer.name}`;
}

function turtleOf(layer: FixtureLayer, layers: ReadonlyArray<FixtureLayer>): string {
    const prefixes = layers
        .filter((other) => other.canonicalIri === undefined)
        .map((other) => `@prefix ${other.name}: <https://fx.test/${other.name}#> .`);
    return `${HEADER}\n${prefixes.join('\n')}\n<${iriOf(layer)}> a owl:Ontology .\n${layer.turtle.trim()}\n`;
}

/** Writes, installs and packs `layers` in order under `root`; returns the last layer's directory. */
async function installLayers(root: string, layers: ReadonlyArray<FixtureLayer>): Promise<string> {
    const storeRoot = join(root, 'store');
    const aliases: Array<{ alias: string; canonicalIri: string }> = [];
    const packages: Array<Parameters<typeof makeFixtureDependencyRegistry>[0]['packages'][number]> = [];
    let last = root;
    for (const layer of layers) {
        const dir = join(root, layer.name);
        mkdirSync(dir, { recursive: true });
        const canonicalIri = iriOf(layer);
        const manifest = {
            schemaVersion: 1,
            canonicalIri,
            alias: `@fx/${layer.name}`,
            ownedIriPrefixes: [`${canonicalIri}#`],
            registry: 'https://registry.example',
            dependencies: Object.fromEntries((layer.dependencies ?? []).map((name) => [`@fx/${name}`, '^1.0.0'])),
            sources: { ontology: ['ontology.ttl'] },
            ...(layer.outsideProfile === undefined ? {} : { outsideProfile: layer.outsideProfile }),
        };
        writeFileSync(join(dir, 'erden.config.json'), `${JSON.stringify(manifest, null, 4)}\n`);
        writeFileSync(join(dir, 'ontology.ttl'), turtleOf(layer, layers));
        const registry = makeFixtureDependencyRegistry({
            registryOrigin: 'https://registry.example',
            aliases: [...aliases],
            packages: [...packages],
        });
        await Effect.runPromise(makeNodeInstallProjectService(registry).install({ from: dir, storeRoot }));
        const archive = join(root, `${layer.name}.erdenpkg`);
        await Effect.runPromise(nodePackProjectService.pack({ version: '1.0.0', from: dir, outputPath: archive }));
        const bytes = new Uint8Array(readFileSync(archive));
        const validated = await validatePackageArchiveStream(bytes);
        aliases.push({ alias: manifest.alias, canonicalIri });
        packages.push({
            canonicalIri,
            version: validated.manifest.version,
            archiveSha256: validated.archiveSha256,
            manifest: validated.manifest,
            archive: bytes,
        });
        last = dir;
    }
    return last;
}

function chainLayer(k: number): FixtureLayer {
    const lines: string[] = [];
    for (let c = 0; c < 3; c += 1) {
        const parents = [
            ...(c > 0 ? [`l${String(k)}:C${String(Math.floor((c - 1) / 2))}`] : []),
            ...(k > 1 ? [`l${String(k - 1)}:C${String(c)}`] : []),
        ];
        lines.push(
            `l${String(k)}:C${String(c)} a owl:Class${parents.map((parent) => ` ; rdfs:subClassOf ${parent}`).join('')} .`,
        );
    }
    for (let p = 0; p < 2; p += 1) {
        lines.push(
            `l${String(k)}:p${String(p)} a owl:ObjectProperty ; rdfs:domain l${String(k)}:C${String(p % 3)} ; rdfs:range l${String(k)}:C${String((p + 1) % 3)} .`,
        );
    }
    for (let i = 0; i < 3; i += 1) {
        lines.push(
            `l${String(k)}:i${String(i)} a l${String(k)}:C${String(i % 3)}${i === 0 ? ` ; l${String(k)}:p0 l${String(k)}:i1` : ''} .`,
        );
    }
    return {
        name: `l${String(k)}`,
        turtle: lines.join('\n'),
        ...(k > 1 ? { dependencies: [`l${String(k - 1)}`] } : {}),
    };
}

const BASE: FixtureLayer = {
    name: 'base',
    turtle: `
base:Thing a owl:Class . base:Agent a owl:Class ; rdfs:subClassOf base:Thing .
base:Mentee a owl:Class .
base:knows a owl:ObjectProperty ; rdfs:domain base:Agent ; rdfs:range base:Agent .
base:mentors a owl:ObjectProperty ; rdfs:domain base:Agent ; rdfs:range base:Mentee .
base:ann a base:Agent . base:bob a owl:NamedIndividual . base:ann base:knows base:bob .
`,
};

function dependent(turtle: string): ReadonlyArray<FixtureLayer> {
    return [BASE, { name: 'dep', turtle, dependencies: ['base'] }];
}

const SKOS: FixtureLayer = {
    name: 'skos',
    canonicalIri: 'http://www.w3.org/2004/02/skos/core',
    turtle: `
skos:Concept a owl:Class . skos:ConceptScheme a owl:Class .
skos:broader a owl:ObjectProperty ; rdfs:domain skos:Concept ; rdfs:range skos:Concept .
skos:inScheme a owl:ObjectProperty ; rdfs:domain skos:Concept ; rdfs:range skos:ConceptScheme .
`,
};

const FIXTURES: ReadonlyArray<{
    readonly name: string;
    readonly layers: ReadonlyArray<FixtureLayer>;
    readonly options?: DifferentialFixture['options'];
}> = [
    { name: 'synthetic-chain', layers: [chainLayer(1), chainLayer(2), chainLayer(3)] },
    {
        name: 'local-additions',
        layers: dependent(
            'dep:Coach a owl:Class ; rdfs:subClassOf base:Agent .\ndep:cara a dep:Coach ; base:knows dep:dan .\ndep:dan a dep:Coach .',
        ),
    },
    {
        name: 'dependency-class-under-new-class',
        layers: dependent('dep:Named a owl:Class .\nbase:Agent rdfs:subClassOf dep:Named .'),
    },
    { name: 'equivalence-between-borrowed-terms', layers: dependent('base:Agent owl:equivalentClass base:Thing .') },
    {
        name: 'domain-on-borrowed-property',
        layers: dependent('dep:Social a owl:Class .\nbase:knows rdfs:domain dep:Social .'),
    },
    {
        name: 'assertion-about-dependency-individual',
        layers: dependent('dep:Coach a owl:Class .\nbase:ann a dep:Coach .'),
    },
    {
        name: 'new-individual-to-dependency-individual',
        layers: dependent('dep:eve a owl:NamedIndividual ; base:mentors base:bob .'),
    },
    {
        name: 'siblings-through-skos',
        layers: [
            SKOS,
            {
                name: 'left',
                dependencies: ['skos'],
                turtle: 'left:Play a owl:Class ; rdfs:subClassOf skos:Concept .\nleft:run a left:Play .\nleft:scheme a skos:ConceptScheme .',
            },
            {
                name: 'right',
                dependencies: ['skos'],
                turtle: 'right:Formation a owl:Class ; rdfs:subClassOf skos:Concept .\nright:shotgun a right:Formation .',
            },
            {
                name: 'both',
                dependencies: ['left', 'right'],
                turtle: 'both:link a owl:NamedIndividual ; skos:broader left:run , right:shotgun ; skos:inScheme left:scheme .',
            },
        ],
    },
    {
        name: 'report-mode-undeclared-term-declared-by-dependent',
        layers: [
            {
                name: 'loose',
                outsideProfile: 'report',
                turtle: 'loose:Thing a owl:Class .\nloose:a a loose:Thing ; loose:rel loose:b .',
            },
            { name: 'dep', dependencies: ['loose'], turtle: 'loose:rel a owl:ObjectProperty .' },
        ],
    },
    {
        name: 'report-mode-properties-typed-by-dependent',
        layers: [
            {
                name: 'props',
                outsideProfile: 'report',
                turtle: 'props:note a owl:AnnotationProperty .\nprops:link a rdf:Property .\nprops:a a owl:NamedIndividual ; props:note props:b ; props:link props:b .',
            },
            {
                name: 'dep',
                dependencies: ['props'],
                turtle: 'props:note a owl:ObjectProperty .\nprops:link a owl:ObjectProperty .',
            },
        ],
    },
    {
        name: 'ambiguous-property-kind',
        layers: [
            {
                name: 'amb',
                turtle: 'amb:C a owl:Class .\namb:p a owl:ObjectProperty ; rdfs:domain amb:C ; rdfs:range amb:C .',
            },
            { name: 'dep', dependencies: ['amb'], turtle: 'amb:p a owl:DatatypeProperty .' },
        ],
    },
    {
        name: 'data-range-across-layers',
        layers: [
            {
                name: 'data',
                turtle: 'data:Player a owl:Class .\ndata:age a owl:DatatypeProperty ; rdfs:domain data:Player ; rdfs:range xsd:integer .',
            },
            {
                name: 'dep',
                dependencies: ['data'],
                turtle: 'dep:p1 a owl:NamedIndividual ; data:age "27"^^xsd:integer .',
            },
        ],
    },
    {
        name: 'inconsistent',
        layers: [
            {
                name: 'inc',
                turtle: 'inc:A a owl:Class .\ninc:B a owl:Class ; owl:disjointWith inc:A .\ninc:x a inc:A , inc:B .',
            },
        ],
    },
    {
        name: 'inconsistent-across-layers',
        layers: dependent('dep:Robot a owl:Class ; owl:disjointWith base:Agent .\nbase:ann a dep:Robot .'),
    },
    {
        name: 'unsatisfiable-class',
        layers: [
            {
                name: 'uns',
                turtle: 'uns:A a owl:Class .\nuns:B a owl:Class ; owl:disjointWith uns:A .\nuns:C a owl:Class ; rdfs:subClassOf uns:A , uns:B .',
            },
        ],
    },
    {
        name: 'union-over-input-limit',
        layers: [
            chainLayer(1),
            { name: 'dep', dependencies: ['l1'], turtle: 'dep:N a owl:Class ; rdfs:subClassOf l1:C0 .' },
        ],
        options: {
            reasonerLimits: {
                maxWallTimeMs: 30_000,
                maxInputAxioms: 10,
                maxInferences: 400_000,
                maxRequestBytes: 16_777_216,
            },
        },
    },
    {
        name: 'union-over-inference-limit',
        layers: [
            chainLayer(1),
            { name: 'dep', dependencies: ['l1'], turtle: 'dep:N a owl:Class ; rdfs:subClassOf l1:C0 .' },
        ],
        options: {
            reasonerLimits: {
                maxWallTimeMs: 30_000,
                maxInputAxioms: 500_000,
                maxInferences: 1,
                maxRequestBytes: 16_777_216,
            },
        },
    },
];

/** Builds every fixture under `root` (installing their dependencies) and adds `examples/erden-demo`. */
export async function buildDifferentialFixtures(root: string): Promise<ReadonlyArray<DifferentialFixture>> {
    const fixtures: DifferentialFixture[] = [
        { name: 'erden-demo', from: fileURLToPath(new URL('../../../../examples/erden-demo', import.meta.url)) },
    ];
    for (const fixture of FIXTURES) {
        const from = await installLayers(join(root, fixture.name), fixture.layers);
        fixtures.push({
            name: fixture.name,
            from,
            ...(fixture.options === undefined ? {} : { options: fixture.options }),
        });
    }
    return fixtures;
}
