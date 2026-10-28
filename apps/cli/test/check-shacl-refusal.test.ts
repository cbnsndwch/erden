import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
    makeNodeInstallProjectService,
    nodeCheckProjectService,
    nodeDoctorService,
    nodeInitProjectService,
    nodePackProjectService,
    nodeProjectDependenciesService,
    nodeProjectPathService,
    nodeStoreMaintenanceService,
    nodeStorePathService,
    unavailableDependencyRegistry,
} from '@erden/project';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { CLI_EXIT, runCli, type CliRuntime } from '../src/index.js';

const DEMO = fileURLToPath(new URL('../../../examples/erden-demo', import.meta.url));
const FIXTURES = '../../../packages/project/test/fixtures/shacl-unsupported/';
const MIXED = fileURLToPath(new URL(`${FIXTURES}sparql-component-mixed.ttl`, import.meta.url));
const JS_COMPONENT = fileURLToPath(new URL(`${FIXTURES}js-component.ttl`, import.meta.url));

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

/** A copy of the demo with `shapes` as its shapes file. */
function projectWith(shapes: string | Uint8Array): string {
    const root = makeTestTempRoot('erden-cli-shacl-refusal-');
    roots.push(root);
    const project = join(root, 'project');
    cpSync(DEMO, project, { recursive: true });
    writeFileSync(join(project, 'shapes.ttl'), shapes);
    return root;
}

function capture(cwd: string) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime: CliRuntime = {
        cwd: () => cwd,
        stdout: { write: (text) => void stdout.push(text) },
        stderr: { write: (text) => void stderr.push(text) },
        services: {
            check: nodeCheckProjectService,
            init: nodeInitProjectService,
            doctor: nodeDoctorService,
            install: makeNodeInstallProjectService(unavailableDependencyRegistry),
            dependencies: nodeProjectDependenciesService,
            path: nodeProjectPathService,
            pack: nodePackProjectService,
            storePath: nodeStorePathService,
            storeMaintenance: nodeStoreMaintenanceService,
        },
    };
    return { runtime, stdout, stderr };
}

describe('erden check with SHACL the bundled engine cannot run', () => {
    it('prints the refused report on stdout with --json and exits 1', async () => {
        const root = projectWith(readFileSync(JS_COMPONENT));
        const captured = capture(root);
        expect(await runCli(['check', 'project', '--offline', '--json'], captured.runtime)).toBe(
            CLI_EXIT.semanticFailure,
        );
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout).toHaveLength(1);
        const report = JSON.parse(captured.stdout[0] as string) as {
            readonly outcome: string;
            readonly stages: {
                readonly shacl: {
                    readonly status: string;
                    readonly failureCodes: ReadonlyArray<string>;
                    readonly details: { readonly unsupported: ReadonlyArray<{ readonly kind: string }> };
                };
            };
        };
        expect(report.outcome).toBe('failed');
        expect(report.stages.shacl.status).toBe('failed');
        expect(report.stages.shacl.failureCodes).toEqual(['shacl-unsupported-construct']);
        expect(report.stages.shacl.details.unsupported.map((item) => item.kind)).toEqual(['constraint-component']);
    });

    it('names the refusal, the shape and its position in the text report', async () => {
        const root = projectWith(readFileSync(JS_COMPONENT));
        const captured = capture(root);
        expect(await runCli(['check', 'project', '--offline'], captured.runtime)).toBe(CLI_EXIT.semanticFailure);
        const text = captured.stdout.join('');
        expect(text).toContain('Erden check @example/erden-demo: FAILED');
        expect(text).toContain('SHACL: refused (shacl-unsupported-construct)');
        expect(text).toContain(
            '- shapes.ttl:23:3 [shacl/constraint-component] https://example.invalid/erden/demo#JsComponentShape uses ',
        );
    });
});

describe('erden check with SHACL-SPARQL, which erden-shacl runs', () => {
    it('fails the data that breaks a SPARQL-based component, with the finding and exit 1', async () => {
        const root = projectWith(readFileSync(MIXED));
        const captured = capture(root);
        expect(await runCli(['check', 'project', '--offline', '--json'], captured.runtime)).toBe(
            CLI_EXIT.semanticFailure,
        );
        const report = JSON.parse(captured.stdout[0] as string) as {
            readonly stages: {
                readonly shacl: {
                    readonly failureCodes: ReadonlyArray<string>;
                    readonly details: {
                        readonly engine: { readonly name: string };
                        readonly findings: ReadonlyArray<{ readonly component: string; readonly message: string }>;
                    };
                };
            };
        };
        expect(report.stages.shacl.failureCodes).toEqual(['shacl-conformance']);
        expect(report.stages.shacl.details.engine.name).toBe('erden-shacl');
        expect(report.stages.shacl.details.findings.map((finding) => [finding.component, finding.message])).toEqual([
            ['https://example.invalid/erden/demo#MustNotHaveGenerator', 'the value is linked by a forbidden property'],
        ]);
    });

    it('stops with exit 3 and the engine diagnostic, naming the shape and file, when the engine refuses the shapes', async () => {
        const shapes = `@prefix demo: <https://example.invalid/erden/demo#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
demo:BrokenShape a sh:NodeShape ;
  sh:targetClass demo:PublishedArtifact ;
  sh:sparql [ sh:select "SELECT $this WHERE { $this ?p }" ] .
`;
        const root = projectWith(shapes);
        const captured = capture(root);
        expect(await runCli(['check', 'project', '--offline'], captured.runtime)).toBe(CLI_EXIT.operational);
        const text = [...captured.stdout, ...captured.stderr].join('');
        expect(text).toContain('CHECK_SHACL_REFUSED');
        expect(text).toContain('https://example.invalid/erden/demo#BrokenShape');
        expect(text).toContain('shapes.ttl');
    });
});
