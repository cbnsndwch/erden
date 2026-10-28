#!/usr/bin/env node
// The Core cross-check: erden-shacl against shacl-engine 1.1.3 on the same parsed graphs, Core only (shacl-engine's
// SPARQL plugin is not loaded; measured against the W3C suite, shacl-engine is right on all 98 Core tests, and wrong on
// 5 of 15 SPARQL report tests). For every case the verdict and the set of (focus, path, value, component, severity, source shape)
// tuples must be equal. Cases: every Core test of the vendored W3C suite, the synthetic Core series, and any jobs
// file given with --jobs.
//
//   node shacl/qualification/harness/cross-check.mjs --binary <erden-shacl> --reference <shacl-engine install dir>
//        --out <file.json> [--sizes 100,1000] [--jobs <jobs.json>]...
//
// The reference is installed outside the workspace from the committed lock:
//   cp shacl/qualification/reference/shacl-engine/package*.json <dir>/ && (cd <dir> && npm ci --ignore-scripts)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { Graph, MF, N3, RDF, REPOSITORY, SHT, fileIri, ontology, parseFile } from './lib.mjs';
import { syntheticCase } from './synthetic.mjs';

const { values: options } = parseArgs({
    options: {
        binary: { type: 'string' },
        reference: { type: 'string' },
        out: { type: 'string' },
        sizes: { type: 'string', default: '100,1000' },
        jobs: { type: 'string', multiple: true, default: [] },
    },
});
if (options.binary === undefined || options.reference === undefined || options.out === undefined) {
    throw new Error('Usage: cross-check.mjs --binary <erden-shacl> --reference <dir> --out <file> [--sizes ...] [--jobs <file>]...');
}
const binary = resolve(options.binary);
const tool = ontology.shaclEngineTool(`sha256:${createHash('sha256').update(readFileSync(binary)).digest('hex')}`);

const referenceRequire = createRequire(join(resolve(options.reference), 'package.json'));
async function loadReference(specifier) {
    return import(pathToFileURL(referenceRequire.resolve(specifier)).href);
}
const [{ default: Validator }, { default: DataFactory }, { default: DatasetFactory }] = await Promise.all([
    loadReference('shacl-engine/Validator.js'),
    loadReference('@rdfjs/data-model/Factory.js'),
    loadReference('@rdfjs/dataset/Factory.js'),
]);
const referenceVersion = JSON.parse(readFileSync(join(resolve(options.reference), 'node_modules/shacl-engine/package.json'), 'utf8')).version;
const datasets = new DatasetFactory();
class Factory extends DataFactory {
    dataset(quads) {
        return datasets.dataset(quads);
    }
}
const factory = new Factory();

function termKey(term) {
    if (term === undefined || term === null) {
        return null;
    }
    if (term.termType === 'Literal') {
        const datatype = typeof term.datatype === 'string' ? term.datatype : (term.datatype?.value ?? '');
        return `"${term.value}"@${term.language ?? ''}^^${datatype}`;
    }
    return `${term.termType === 'BlankNode' ? '_:' : ''}${term.value}`;
}

/** A path as a SPARQL property path, from shacl-engine's steps. */
function referencePath(steps) {
    if (steps === undefined || steps === null || steps.length === 0) {
        return null;
    }
    return steps
        .map((step) => {
            const alternatives = step.predicates.map((predicate) => `<${predicate.value}>`);
            let text = alternatives.length === 1 ? alternatives[0] : `(${alternatives.join('|')})`;
            if (step.start === 'object') {
                text = `^${text}`;
            }
            return `${text}${{ one: '', zeroOrMore: '*', oneOrMore: '+', zeroOrOne: '?' }[step.quantifier] ?? '?!'}`;
        })
        .join('/');
}

/** A path as a SPARQL property path, from an erden-shacl answer. */
function erdenPath(path) {
    switch (path.kind) {
        case 'predicate':
            return `<${path.iri}>`;
        case 'inverse':
            return `^${erdenPath(path.path)}`;
        case 'sequence':
            return path.paths.map(erdenPath).join('/');
        case 'alternative':
            return `(${path.paths.map(erdenPath).join('|')})`;
        case 'zeroOrMore':
            return `${erdenPath(path.path)}*`;
        case 'oneOrMore':
            return `${erdenPath(path.path)}+`;
        case 'zeroOrOne':
            return `${erdenPath(path.path)}?`;
        default:
            return `node:${termKey(path.term)}`;
    }
}
function tupleKey(tuple) {
    return JSON.stringify(tuple);
}

async function reference(shapesQuads, dataQuads) {
    const validator = new Validator(factory.dataset(shapesQuads), { factory });
    const report = await validator.validate({ dataset: factory.dataset(dataQuads) });
    return {
        conforms: report.conforms,
        tuples: report.results
            .map((result) => {
                return tupleKey({
                    focus: termKey(result.focusNode?.term),
                    path: referencePath(result.path),
                    value: termKey(result.value?.term),
                    component: result.constraintComponent?.value ?? null,
                    severity: result.severity?.value ?? null,
                    shape: termKey(result.shape?.ptr?.term),
                });
            })
            .sort(),
    };
}

async function erden(id, shapesQuads, dataQuads) {
    const answer = await ontology.runShaclRequest(
        binary,
        ontology.encodeShaclRequest({ requestId: `cross:${id.replace(/[^!-~]/gu, '_').slice(0, 900)}`, tool, shapes: ontology.prepareShaclShapes(shapesQuads), graphs: [{ id: 'data', quads: dataQuads }], maxResults: 1_000_000 }),
        { maxWallTimeMs: 600_000 },
    );
    if (answer.outcome !== 'validated') {
        return { refused: `${answer.code}: ${answer.message}` };
    }
    const [report] = answer.reports;
    return {
        conforms: report.conforms,
        tuples: report.results
            .map((result) =>
                tupleKey({
                    focus: termKey(result.focusNode),
                    path: result.resultPath === null ? null : erdenPath(result.resultPath),
                    value: termKey(result.value),
                    component: result.sourceConstraintComponent,
                    severity: result.resultSeverity,
                    shape: termKey(result.sourceShape),
                }),
            )
            .sort(),
    };
}

let parses = 0;
function parse(text, base, format = 'text/turtle') {
    parses += 1;
    return new N3.Parser({ baseIRI: base, format, blankNodePrefix: `x${String(parses)}_` }).parse(text);
}

const cases = [];
const suiteRoot = fileURLToPath(new URL('shacl/qualification/w3c/data-shapes-test-suite/tests', REPOSITORY));
function collect(path, visited = new Set()) {
    if (visited.has(path)) {
        return;
    }
    visited.add(path);
    const graph = new Graph(parseFile(path));
    for (const include of graph.quads.filter((q) => q.predicate.value === `${MF}include`)) {
        collect(fileURLToPath(include.object.value), visited);
    }
    for (const head of graph.quads.filter((q) => q.predicate.value === `${MF}entries`).map((q) => q.object)) {
        for (const entry of graph.list(head)) {
            if (!graph.objects(entry, `${RDF}type`).some((t) => t.value === `${SHT}Validate`)) {
                continue;
            }
            const id = entry.value.replace(pathToFileURL(suiteRoot).href, '').replace(/^\//u, '');
            if (!id.startsWith('core/')) {
                continue;
            }
            const action = graph.object(entry, `${MF}action`);
            const shapesPath = fileURLToPath(graph.object(action, `${SHT}shapesGraph`).value.split('#')[0]);
            const dataPath = fileURLToPath(graph.object(action, `${SHT}dataGraph`).value.split('#')[0]);
            cases.push({
                id: `w3c:${id}`,
                shapes: () => parse(readFileSync(shapesPath, 'utf8'), fileIri(shapesPath)),
                data: () => parse(readFileSync(dataPath, 'utf8'), fileIri(dataPath)),
            });
        }
    }
}
collect(join(suiteRoot, 'manifest.ttl'));
for (const n of options.sizes.split(',').filter((value) => value !== '').map(Number)) {
    const synthetic = syntheticCase(n);
    cases.push({
        id: `synthetic:core:${String(n)}`,
        shapes: () => parse(synthetic.shapesCore, 'http://example.org/syn'),
        data: () => parse(synthetic.data, 'http://example.org/syn', 'application/n-triples'),
    });
}
for (const jobsPath of options.jobs) {
    const { jobs } = JSON.parse(readFileSync(jobsPath, 'utf8'));
    for (const job of jobs) {
        for (const item of job.data) {
            cases.push({
                id: `${job.id}:${item.id}`,
                shapes: () => parse(readFileSync(job.shapes, 'utf8'), job.shapesBase ?? fileIri(job.shapes), job.shapes.endsWith('.nt') ? 'application/n-triples' : 'text/turtle'),
                data: () => parse(readFileSync(item.path, 'utf8'), item.base ?? fileIri(item.path), item.path.endsWith('.nt') ? 'application/n-triples' : 'text/turtle'),
            });
        }
    }
}

const load = { before: loadavg() };
const records = [];
for (const item of cases) {
    const shapesQuads = item.shapes();
    const dataQuads = item.data();
    const [left, right] = [await erden(item.id, shapesQuads, dataQuads), await reference(shapesQuads, dataQuads)];
    const agree = left.refused === undefined && left.conforms === right.conforms && JSON.stringify(left.tuples) === JSON.stringify(right.tuples);
    const record = { case: item.id, agree, conforms: left.conforms ?? null, results: left.tuples?.length ?? null };
    if (!agree) {
        const only = (a, b) => (a ?? []).filter((value) => !(b ?? []).includes(value)).map((value) => JSON.parse(value));
        Object.assign(record, {
            erdenRefused: left.refused ?? null,
            referenceConforms: right.conforms,
            onlyErden: only(left.tuples, right.tuples),
            onlyReference: only(right.tuples, left.tuples),
        });
    }
    records.push(record);
}
load.after = loadavg();
const summary = {
    binary,
    executableDigest: tool.executableDigest,
    engineDigest: tool.engineDigest,
    reference: `shacl-engine@${referenceVersion}`,
    load,
    cases: records.length,
    agree: records.filter((record) => record.agree).length,
    disagreements: records.filter((record) => !record.agree),
    records,
};
writeFileSync(resolve(options.out), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Core cross-check against shacl-engine ${referenceVersion}: ${String(summary.agree)} of ${String(summary.cases)} cases agree`);
if (summary.agree !== summary.cases) {
    for (const record of summary.disagreements) {
        console.error(`disagrees: ${record.case}`);
    }
    process.exit(1);
}
