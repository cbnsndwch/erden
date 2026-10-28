#!/usr/bin/env node
// The W3C SHACL 1.0 suite through erden-shacl, graded by the suite's own rules (data-shapes-test-suite/index.html),
// exactly as the W3 measurement graded it:
//   partial: the verdict (sh:conforms) is the expected one; for an sht:Failure test the engine must refuse;
//   full:    the projected report graph is isomorphic (RDFC-1.0) to the expected one.
// Each test runs in a fresh erden-shacl process through @erden/ontology's protocol client, with the shapes and data
// files parsed by N3 (as Erden parses sources) under their file:// IRIs and the shapes graph exposed under the test's
// shapes graph IRI. Two report graphs are graded: the engine's results alone ("engine"), and the report Erden writes,
// which adds sh:sourceConstraint where the result determines it ("erden").
//
//   node shacl/qualification/harness/suite.mjs --binary <erden-shacl> --out <dir>
//        [--root <tests dir>] [--parallel 8] [--expect shacl/qualification/w3c-expected.json]
//
// With --expect, exits 1 unless every outcome is the committed one (the gate).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Graph, MF, N3, RDF, REPOSITORY, SH, SHT, canonical, fileIri, findReportNodes, ontology, parseFile, pool, projectReport, tuples } from './lib.mjs';

const { values: options } = parseArgs({
    options: {
        binary: { type: 'string' },
        out: { type: 'string' },
        root: { type: 'string', default: fileURLToPath(new URL('shacl/qualification/w3c/data-shapes-test-suite/tests', REPOSITORY)) },
        parallel: { type: 'string', default: '8' },
        expect: { type: 'string' },
    },
});
if (options.binary === undefined || options.out === undefined) {
    throw new Error('Usage: suite.mjs --binary <erden-shacl> --out <dir> [--root <dir>] [--parallel N] [--expect <file>]');
}
const root = resolve(options.root);
const out = resolve(options.out);
mkdirSync(join(out, 'reports'), { recursive: true });
const binary = resolve(options.binary);
const binaryBytes = readFileSync(binary);
const executableDigest = `sha256:${createHash('sha256').update(binaryBytes).digest('hex')}`;
const tool = ontology.shaclEngineTool(executableDigest);

function collect(manifestPath, tests, visited) {
    if (visited.has(manifestPath)) {
        return;
    }
    visited.add(manifestPath);
    const graph = new Graph(parseFile(manifestPath));
    for (const include of graph.quads.filter((q) => q.predicate.value === `${MF}include`).map((q) => fileURLToPath(q.object.value)).sort()) {
        collect(include, tests, visited);
    }
    for (const head of graph.quads.filter((q) => q.predicate.value === `${MF}entries`).map((q) => q.object)) {
        for (const entry of graph.list(head)) {
            const types = graph.objects(entry, `${RDF}type`).map((t) => t.value);
            if (!types.includes(`${SHT}Validate`)) {
                continue;
            }
            const [file, fragment] = entry.value.split('#');
            const id = relative(root, fileURLToPath(file)).replace(/\.ttl$/u, '') + (fragment === undefined ? '' : `#${fragment}`);
            const action = graph.object(entry, `${MF}action`);
            const shapesIri = graph.object(action, `${SHT}shapesGraph`).value;
            const dataIri = graph.object(action, `${SHT}dataGraph`).value;
            const result = graph.object(entry, `${MF}result`);
            const test = {
                id,
                section: dirname(relative(root, manifestPath)),
                shapesIri,
                shapesPath: fileURLToPath(shapesIri.split('#')[0]),
                dataPath: fileURLToPath(dataIri.split('#')[0]),
            };
            if (result.termType === 'NamedNode' && result.value === `${SHT}Failure`) {
                test.expected = { failure: true };
            } else {
                test.expected = {
                    failure: false,
                    conforms: graph.object(result, `${SH}conforms`)?.value === 'true',
                    keepMessages: graph.quads.some((q) => q.predicate.value === `${SH}resultMessage`),
                    graph,
                    node: result,
                };
            }
            tests.push(test);
        }
    }
}

const tests = [];
collect(join(root, 'manifest.ttl'), tests, new Set());
for (const test of tests) {
    if (!test.expected.failure) {
        test.expected.canonical = await canonical(projectReport(test.expected.graph, test.expected.node, test.expected.keepMessages).quads);
        test.expected.tuples = tuples(test.expected.graph, test.expected.node);
    }
}

let parses = 0;
function parse(path, base) {
    parses += 1;
    return new N3.Parser({ baseIRI: base, format: 'text/turtle', blankNodePrefix: `t${String(parses)}_` }).parse(readFileSync(path, 'utf8'));
}

async function grade(test, quads, keepMessages) {
    const graph = new Graph(quads);
    const nodes = findReportNodes(graph);
    if (nodes.length !== 1) {
        return { full: false, detail: `${String(nodes.length)} report nodes` };
    }
    const actual = await canonical(projectReport(graph, nodes[0], keepMessages).quads);
    return actual === test.expected.canonical
        ? { full: true }
        : { full: false, actualTuples: tuples(graph, nodes[0]), expectedTuples: test.expected.tuples };
}

async function runOne(test) {
    const started = process.hrtime.bigint();
    const shapesQuads = parse(test.shapesPath, fileIri(test.shapesPath));
    const dataQuads = parse(test.dataPath, fileIri(test.dataPath));
    const shapes = ontology.prepareShaclShapes(shapesQuads);
    const record = { test: test.id, section: test.section };
    let answer;
    try {
        answer = await ontology.runShaclRequest(
            binary,
            ontology.encodeShaclRequest({
                requestId: `w3c:${String(tests.indexOf(test))}`,
                tool,
                shapes,
                graphs: [{ id: 'data', quads: dataQuads }],
                maxResults: 100_000,
                shapesGraphIri: test.shapesIri,
            }),
            { maxWallTimeMs: 120_000 },
        );
    } catch (error) {
        return { ...record, outcome: error?.failure === 'timeout' ? 'timeout' : 'crash', detail: String(error?.message ?? error) };
    } finally {
        record.ms = Number(process.hrtime.bigint() - started) / 1e6;
    }
    if (answer.outcome === 'refused') {
        record.refusal = { code: answer.code, message: answer.message.slice(0, 2000) };
        if (test.expected.failure) {
            return { ...record, outcome: 'pass-full', fullEngine: true, fullErden: true };
        }
        return { ...record, outcome: /^unsupported/u.test(answer.code) ? 'unsupported' : 'error' };
    }
    if (test.expected.failure) {
        return { ...record, outcome: 'fail', detail: 'the suite expects sht:Failure but erden-shacl validated' };
    }
    const report = answer.reports[0];
    record.conforms = report.conforms;
    record.results = report.results.length;
    const engine = await grade(test, ontology.shaclReportQuads(report, ontology.indexShaclShapes([]), 'erden-report-'), test.expected.keepMessages);
    const erdenQuads = ontology.shaclReportQuads(report, ontology.indexShaclShapes(shapesQuads), 'erden-report-');
    const erden = await grade(test, erdenQuads, test.expected.keepMessages);
    writeFileSync(
        join(out, 'reports', `${test.id.replace(/[^A-Za-z0-9.-]/gu, '_')}.nt`),
        new N3.Writer({ format: 'application/n-triples' }).quadsToString(erdenQuads),
    );
    record.fullEngine = engine.full;
    record.fullErden = erden.full;
    if (!engine.full) {
        record.engineTuples = { actual: engine.actualTuples, expected: engine.expectedTuples, detail: engine.detail };
    }
    record.outcome = report.conforms !== test.expected.conforms ? 'fail' : engine.full ? 'pass-full' : 'pass-partial';
    return record;
}

const load = { before: loadavg() };
const started = Date.now();
const records = await pool(tests, Number(options.parallel), runOne);
load.after = loadavg();
writeFileSync(join(out, 'results.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

function tally(list) {
    const counts = { total: list.length };
    for (const outcome of ['pass-full', 'pass-partial', 'fail', 'unsupported', 'error', 'timeout', 'crash']) {
        counts[outcome] = list.filter((r) => r.outcome === outcome).length;
    }
    counts.verdictRight = counts['pass-full'] + counts['pass-partial'];
    counts.fullEngine = list.filter((r) => r.fullEngine === true).length;
    counts.fullErden = list.filter((r) => r.fullErden === true).length;
    return counts;
}
function git(args) {
    const child = spawnSync('git', args, { cwd: fileURLToPath(REPOSITORY), encoding: 'utf8' });
    return child.status === 0 ? child.stdout.trim() : null;
}
const summary = {
    suite: relative(fileURLToPath(REPOSITORY), root),
    suiteTree: git(['rev-parse', 'HEAD:shacl/qualification/w3c/data-shapes-test-suite/tests']),
    suiteUnchanged: spawnSync('git', ['diff', '--quiet', 'HEAD', '--', root], { cwd: fileURLToPath(REPOSITORY) }).status === 0,
    commit: git(['rev-parse', 'HEAD']),
    binary,
    binaryBytes: binaryBytes.length,
    executableDigest,
    engineDigest: ontology.SHACL_ENGINE_DIGEST,
    toolVersion: ontology.SHACL_ENGINE_VERSION,
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length, node: process.version },
    load,
    seconds: (Date.now() - started) / 1000,
    all: tally(records),
    core: tally(records.filter((r) => r.section.startsWith('core'))),
    sparql: tally(records.filter((r) => r.section.startsWith('sparql'))),
    notFullEngine: records.filter((r) => r.fullEngine !== true).map((r) => r.test).sort(),
    notFullErden: records.filter((r) => r.fullErden !== true).map((r) => r.test).sort(),
    wrong: records.filter((r) => !['pass-full', 'pass-partial'].includes(r.outcome)).map((r) => `${r.test}: ${r.outcome}`).sort(),
};
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const line = (c) => `${String(c.verdictRight)}/${String(c.total)} verdicts, full ${String(c.fullEngine)} (engine) ${String(c.fullErden)} (Erden report)`;
console.log(`core: ${line(summary.core)} | sparql: ${line(summary.sparql)} | all: ${line(summary.all)} | ${String(summary.seconds)} s`);

if (options.expect !== undefined) {
    const expected = JSON.parse(readFileSync(options.expect, 'utf8'));
    const failures = [];
    if (summary.suiteTree !== expected.suiteTree || !summary.suiteUnchanged) {
        failures.push(`the vendored suite is not tree ${expected.suiteTree} as committed`);
    }
    if (summary.all.total !== expected.tests || summary.all.verdictRight !== expected.tests) {
        failures.push(`verdicts right ${String(summary.all.verdictRight)} of ${String(summary.all.total)}, expected all ${String(expected.tests)}`);
    }
    for (const [field, name] of [
        ['notFullEngine', 'engine report'],
        ['notFullErden', 'Erden report'],
    ]) {
        if (JSON.stringify(summary[field]) !== JSON.stringify(expected[field])) {
            failures.push(`${name} isomorphism differs from the committed list: got ${summary[field].join(', ')}`);
        }
    }
    if (failures.length > 0) {
        console.error(failures.join('\n'));
        process.exit(1);
    }
    console.log('W3C suite gate: every outcome is the committed one');
}
