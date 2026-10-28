export function emittedPair(modulePath) {
    return [`dist/${modulePath}.d.ts`, `dist/${modulePath}.js`];
}

/** The exact compiled file set of each open runtime package, which the build refuses to differ from. */
export const RUNTIME_DIST_FILES = new Map([
    [
        'apps/cli',
        [
            ...emittedPair('bin'),
            ...emittedPair('index'),
            ...emittedPair('main'),
            ...emittedPair('query'),
            ...emittedPair('registry'),
        ],
    ],
    [
        'packages/contracts',
        [
            ...emittedPair('index'),
            ...['errors', 'index', 'model'].flatMap((name) => emittedPair(`artifact-files/${name}`)),
            ...['errors', 'index', 'report'].flatMap((name) => emittedPair(`check/${name}`)),
            ...['errors', 'index', 'model'].flatMap((name) => emittedPair(`device-login/${name}`)),
            ...[
                'codec',
                'consistency',
                'empty',
                'errors',
                'index',
                'projection',
                'schema',
                'toolchain',
                'truth',
                'validator-profile',
            ].flatMap((name) => emittedPair(`lock/${name}`)),
            ...[
                'constants',
                'diagnostics',
                'index',
                'parsers',
                'publication',
                'registry-origin',
                'schema',
                'serializers',
            ].flatMap((name) => emittedPair(`manifest/${name}`)),
            ...['errors', 'index', 'model'].flatMap((name) => emittedPair(`publication/${name}`)),
            ...['errors', 'index', 'model', 'wire'].flatMap((name) => emittedPair(`registry-release-index/${name}`)),
            ...['errors', 'identity', 'index', 'model', 'shape'].flatMap((name) =>
                emittedPair(`release-comparison/${name}`),
            ),
            ...['errors', 'index', 'model', 'result', 'wire'].flatMap((name) => emittedPair(`release-query/${name}`)),
        ],
    ],
    [
        'packages/project',
        [
            ...emittedPair('index'),
            ...emittedPair('operation'),
            ...['index', 'operation', 'phase-timing', 'render'].flatMap((name) => emittedPair(`check/${name}`)),
            ...['catalog', 'errors', 'index', 'registry', 'resolver'].flatMap((name) =>
                emittedPair(`dependencies/${name}`),
            ),
            ...['errors', 'index', 'operation', 'render', 'report'].flatMap((name) => emittedPair(`doctor/${name}`)),
            ...['errors', 'index', 'operation', 'render', 'report'].flatMap((name) => emittedPair(`init/${name}`)),
            ...['errors', 'index', 'operation', 'render', 'report'].flatMap((name) => emittedPair(`install/${name}`)),
            ...['discovery', 'index', 'service'].flatMap((name) => emittedPair(`manifest/${name}`)),
            ...['errors', 'filesystem', 'index', 'operation', 'render', 'report'].flatMap((name) =>
                emittedPair(`pack/${name}`),
            ),
            ...['errors', 'index', 'operation', 'render', 'report', 'update-render', 'update-report'].flatMap((name) =>
                emittedPair(`project-dependencies/${name}`),
            ),
            ...['errors', 'filesystem', 'index', 'model', 'operation'].flatMap((name) =>
                emittedPair(`project-dependency-state/${name}`),
            ),
            ...['errors', 'filesystem', 'index', 'model', 'operation'].flatMap((name) =>
                emittedPair(`project-lock/${name}`),
            ),
            ...['errors', 'index', 'operation', 'render', 'report'].flatMap((name) =>
                emittedPair(`project-path/${name}`),
            ),
            ...['errors', 'filesystem', 'index', 'marker', 'model', 'operation'].flatMap((name) =>
                emittedPair(`store/${name}`),
            ),
            ...['errors', 'index', 'operation', 'render', 'report'].flatMap((name) =>
                emittedPair(`store-maintenance/${name}`),
            ),
            ...['errors', 'index', 'operation', 'render', 'report'].flatMap((name) =>
                emittedPair(`store-path/${name}`),
            ),
            ...emittedPair('toolchain-guidance'),
        ],
    ],
    [
        'packages/ontology',
        [
            ...[
                'index',
                'model',
                'capture',
                'project',
                'project-model',
                'project-encoding',
                'project-terms',
                'project-shape',
                'outcomes',
                'outcome-context',
            ].flatMap((name) => emittedPair(`shacl-evidence/${name}`)),
            ...['doctor', 'identity', 'index', 'messages', 'port', 'process', 'protocol', 'report'].flatMap((name) =>
                emittedPair(`shacl-engine/${name}`),
            ),
            ...emittedPair('validation-policy'),
            ...['captured', 'index', 'model', 'normalize', 'result', 'worker'].flatMap((name) =>
                emittedPair(`comparison-rdf/${name}`),
            ),
            ...['engine', 'index', 'model', 'worker'].flatMap((name) => emittedPair(`release-query/${name}`)),
            ...['formats', 'graph-hash', 'index', 'jsonld-guard', 'parse', 'positions', 'rdfxml-guard'].flatMap(
                (name) => emittedPair(`source-formats/${name}`),
            ),
            ...[
                'assembly',
                'citations',
                'core-validation',
                'discovery',
                'errors',
                'index',
                'model',
                'order',
                'oxigraph-runtime',
                'ports',
                'questions',
                'service',
                'shacl',
                'shacl-support',
            ].flatMap(emittedPair),
            ...[
                'datatypes',
                'doctor',
                'errors',
                'explain',
                'expressions',
                'index',
                'limits',
                'locate',
                'materialize',
                'normalize',
                'ownership',
                'partition',
                'process',
                'service',
                'snapshot',
                'validate',
            ].flatMap((name) => emittedPair(`reasoner/${name}`)),
        ],
    ],
    [
        'packages/client',
        [
            ...[
                'artifact-files',
                'credentials',
                'device-login',
                'http',
                'index',
                'publication',
                'registry',
                'release-query',
                'wire',
            ].flatMap(emittedPair),
        ],
    ],
    [
        'packages/package-format',
        [
            ...[
                'codec',
                'contract',
                'effect',
                'errors',
                'extraction',
                'ignore',
                'index',
                'reference-fixture',
                'service',
            ].flatMap(emittedPair),
        ],
    ],
    [
        'reasoner/protocol',
        [
            ...[
                'canonical',
                'compatibility',
                'evidence',
                'expressions',
                'index',
                'known-answers',
                'literal-values',
                'native',
                'order',
                'profile',
                'proof',
                'proof-horn',
                'proof-horn-rules',
                'proof-walk',
                'schema',
                'sealed',
                'wire',
            ].flatMap(emittedPair),
        ],
    ],
]);

for (const [packagePath, files] of RUNTIME_DIST_FILES) {
    RUNTIME_DIST_FILES.set(packagePath, Object.freeze([...files].sort()));
}
