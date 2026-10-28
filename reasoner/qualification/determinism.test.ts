import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { assertCanonicalReasonerRequestJson, computeReasonerInputDigest } from '../protocol/src/index.js';
import {
  DETERMINISM_WALL_TIME_MS,
  capturedFixtureNames,
  capturedRecords,
  capturedRequest,
  determinismCases,
  writeDeterminismRequests,
} from './determinism-cases.js';
import {
  DETERMINISM_TARGETS,
  EXCLUDED_MARKER,
  PLACEHOLDER_EXECUTABLE_DIGEST,
  answerLabel,
  bindRequest,
  compareAnswerSets,
  normalizeAnswer,
  sha256,
} from './determinism.mjs';
import { TIMING_SHAPES } from './timing-shapes.js';

// The cross-platform determinism check's request set and comparison. `pnpm test` checks the set and the comparison
// logic; `pnpm run determinism:requests` (MODE=determinism, ERDEN_DETERMINISM_REQUESTS_OUT=<dir>) writes the set for
// the reasoner-build workflow.

const knownAnswers = resolve(import.meta.dirname, '../protocol/fixtures/known-answer');
const temporary = mkdtempSync(join(tmpdir(), 'erden-determinism-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const digestOf = (character: string) => `sha256:${character.repeat(64)}`;

describe('determinism request set', () => {
  const cases = determinismCases();

  test('covers the known answers, the timing and rich shapes, the captured requests and every decision outcome', () => {
    const names = cases.map((item) => item.name);
    const { scenarios } = JSON.parse(readFileSync(join(knownAnswers, 'manifest.json'), 'utf8')) as { scenarios: string[] };
    for (const scenario of scenarios) expect(names).toContain(`known-answer/${scenario}`);
    for (const shape of TIMING_SHAPES) expect(names).toContain(`timing-shape/${shape.name}`);
    expect(names.filter((name) => name.startsWith('differential-shape/rich-'))).toHaveLength(4);
    expect(capturedFixtureNames()).toEqual(Object.keys(capturedRecords()).sort());
    for (const name of capturedFixtureNames()) expect(names).toContain(`captured/${name}`);
    expect(
      Object.entries(capturedRecords())
        .filter(([, record]) => record.outsideProfile === 'report')
        .map(([name]) => name),
    ).toEqual(['prov-o-complete', 'skos-complete']);
    // Private captures (the private repository only) say what they cover; the open ones are the two public mirrors.
    for (const [name, record] of Object.entries(capturedRecords())) {
      if (record.outsideProfile === 'refuse') expect(record.covers, name).toMatch(/\S/u);
    }
    const expected = new Set(cases.map((item) => item.expected));
    for (const outcome of [
      'decided consistent',
      'decided inconsistent',
      'decided consistent, 1 unsatisfiable class',
      'refused budget-exhausted (max-input-axioms)',
      'refused budget-exhausted (max-inferences)',
      'refused known-divergence (thing-nothing-empty-domain-known-divergence)',
      'incompatible tool-version',
      'incompatible input-digest',
    ]) {
      expect(expected).toContain(outcome);
    }
    expect([...expected].some((label) => label.startsWith('refused unsupported-construct'))).toBe(true);
  });

  test('every captured request is the recorded, canonical request with its own input digest', () => {
    for (const name of capturedFixtureNames()) expect(capturedRequest(name).ontology.axioms.length).toBeGreaterThan(0);
  }, 120_000);

  test('every request is canonical, names the shipped tool with the placeholder digest once, and has the uniform budget', () => {
    for (const item of cases.filter((entry) => !entry.heavy)) {
      const wire = item.build();
      const request = assertCanonicalReasonerRequestJson(wire);
      expect(request.requiredTool.executableDigest, item.name).toBe(PLACEHOLDER_EXECUTABLE_DIGEST);
      expect(request.requiredTool.version, item.name).toBe(
        item.name === 'derived/tool-version' ? '0.1.0+purrdf.0.12.0.dfb1df7' : '0.3.0+purrdf.0.12.0.dfb1df7',
      );
      expect(request.limits.maxWallTimeMs, item.name).toBe(DETERMINISM_WALL_TIME_MS);
      expect(computeReasonerInputDigest(request) === request.ontology.digest, item.name).toBe(
        item.name !== 'derived/input-digest',
      );
      expect(bindRequest(wire, digestOf('e')), item.name).toBe(
        wire.replace(`"executableDigest":"${PLACEHOLDER_EXECUTABLE_DIGEST}"`, `"executableDigest":"${digestOf('e')}"`),
      );
    }
  }, 120_000);
});

describe('determinism normalization', () => {
  const fixture = (name: string) => readFileSync(join(knownAnswers, `${name}.response.json`), 'utf8');
  // The protocol fixtures name a fixture tool whose executable digest is all `b`.
  const own = digestOf('b');

  test('replaces only tool.executableDigest, and only when it is the digest of the binary that ran', () => {
    const answer = fixture('subclass-type');
    const normalized = normalizeAnswer(answer, own).toString('utf8');
    expect(normalized).toBe(answer.replace(`"executableDigest":"${own}"`, `"executableDigest":"${EXCLUDED_MARKER}"`));
    expect(JSON.parse(normalized).tool.executableDigest).toBe(EXCLUDED_MARKER);
    expect(() => normalizeAnswer(answer, digestOf('c'))).toThrow(/not the binary that ran/u);
    expect(() => normalizeAnswer(answer.trimEnd(), own)).toThrow(/canonical tool object/u);
    // Another platform's answer differs only there, so the two normalize to the same bytes.
    const other = answer.replace(own, digestOf('9'));
    expect(normalizeAnswer(other, digestOf('9')).equals(normalizeAnswer(answer, own))).toBe(true);
    // Any other difference survives normalization.
    const changed = answer.replace('"checked":true', '"checked":false');
    expect(normalizeAnswer(changed, own).equals(normalizeAnswer(answer, own))).toBe(false);
  });

  test('keeps the executable digest wherever else it appears', () => {
    const answer = fixture('subclass-type').replace('"diagnostics":[]', `"diagnostics":[],"echo":"${own}"`);
    expect(normalizeAnswer(answer, own).toString('utf8')).toContain(`"echo":"${own}"`);
  });

  test('labels decided, refused and incompatible answers', () => {
    expect(answerLabel(fixture('subclass-type'))).toBe('decided consistent');
    expect(answerLabel(fixture('inconsistency'))).toBe('decided inconsistent');
    expect(answerLabel(fixture('unsatisfiable-classes'))).toBe('decided consistent, 1 unsatisfiable class');
    expect(answerLabel(fixture('pur-rdf-cyclic-expression'))).toBe(
      'refused cyclic-expression (cyclic-expression-known-divergence)',
    );
  });

  test('refuses a request without the placeholder in requiredTool, or with it twice', () => {
    expect(() => bindRequest('{"requestId":"x"}', digestOf('e'))).toThrow(/placeholder/u);
    const field = `"executableDigest":"${PLACEHOLDER_EXECUTABLE_DIGEST}"`;
    expect(() => bindRequest(`{"a":{${field}},"requiredTool":{${field}}}`, digestOf('e'))).toThrow(/placeholder/u);
    expect(() => bindRequest(`{"requiredTool":{${field},"x":{${field}}}}`, digestOf('e'))).toThrow(/placeholder/u);
    expect(bindRequest(`{"requiredTool":{${field}}}`, digestOf('e'))).toBe(`{"requiredTool":{"executableDigest":"${digestOf('e')}"}}`);
  });
});

describe('determinism comparison', () => {
  // A two-request set answered by four fake platforms, from the protocol fixtures.
  function fakeRun(mutate?: { target: string; from: string; to: string }) {
    const root = mkdtempSync(join(temporary, 'compare-'));
    const requests = join(root, 'requests');
    mkdirSync(requests);
    const names = ['subclass-type', 'inconsistency'];
    const manifestCases = names.map((name, index) => {
      const wire = readFileSync(join(knownAnswers, `${name}.request.json`), 'utf8').replace(
        digestOf('b'),
        PLACEHOLDER_EXECUTABLE_DIGEST,
      );
      const file = `${String(index + 1).padStart(3, '0')}-known-answer--${name}.request.json`;
      writeFileSync(join(requests, file), wire);
      const expected = name === 'inconsistency' ? 'decided inconsistent' : 'decided consistent';
      return { name: `known-answer/${name}`, covers: name, expected, file, bytes: Buffer.byteLength(wire), sha256: sha256(wire) };
    });
    writeFileSync(
      join(requests, 'manifest.json'),
      JSON.stringify({
        schema: 'erden.reasoner-determinism-requests/v1',
        placeholderExecutableDigest: PLACEHOLDER_EXECUTABLE_DIGEST,
        wallTimeMs: 1000,
        cases: manifestCases,
      }),
    );
    const manifestSha256 = sha256(readFileSync(join(requests, 'manifest.json')));
    DETERMINISM_TARGETS.forEach((target, index) => {
      const own = digestOf(String(index + 1));
      const directory = join(root, 'answers', target);
      mkdirSync(join(directory, 'responses'), { recursive: true });
      const answerCases = manifestCases.map((item, position) => {
        let answer = readFileSync(join(knownAnswers, `${names[position]}.response.json`), 'utf8').replace(digestOf('b'), own);
        if (mutate?.target === target && position === 0) answer = answer.replace(mutate.from, mutate.to);
        writeFileSync(join(directory, 'responses', item.file.replace('.request.json', '.response.json')), answer);
        const wire = readFileSync(join(requests, item.file), 'utf8');
        return {
          name: item.name,
          file: item.file,
          sentRequestSha256: sha256(bindRequest(wire, own)),
          wallMs: [1, 1],
          responseBytes: Buffer.byteLength(answer),
          responseSha256: sha256(answer),
          label: answerLabel(answer),
        };
      });
      writeFileSync(
        join(directory, 'answers.json'),
        JSON.stringify({
          schema: 'erden.reasoner-determinism-answers/v1',
          target,
          host: { platform: 'test', arch: 'test', release: '0', cpu: 'test', node: process.version },
          binary: { file: 'erden-reasoner', bytes: 1, sha256: own },
          requestsManifestSha256: manifestSha256,
          problems: [],
          cases: answerCases,
        }),
      );
    });
    return compareAnswerSets(requests, join(root, 'answers'));
  }

  test('accepts answers that differ only in the executable digest', () => {
    const comparison = fakeRun();
    expect(comparison.problems).toEqual([]);
    expect(comparison.result).toBe('identical');
    expect(comparison.excludedFields.map((item) => item.field)).toEqual(['tool.executableDigest']);
    expect(comparison.cases.every((row) => row.identical)).toBe(true);
  });

  test('reports any other difference with its JSON path', () => {
    const comparison = fakeRun({ target: 'aarch64-apple-darwin', from: '"id":"inferred:1"', to: '"id":"inferred:2"' });
    expect(comparison.result).toBe('different');
    const row = comparison.cases.find((item) => item.name === 'known-answer/subclass-type');
    expect(row?.identical).toBe(false);
    expect(row?.differences.map((item) => item.target)).toEqual(['aarch64-apple-darwin']);
    expect(row?.differences[0]?.jsonDifferences.map((item) => item.path)).toEqual(['$.result.inferred[0].id']);
  });

  test('reports an answer whose outcome is not the expected one', () => {
    const comparison = fakeRun({ target: 'x86_64-pc-windows-msvc', from: '"consistency":"consistent"', to: '"consistency":"inconsistent"' });
    expect(comparison.result).toBe('different');
    expect(comparison.problems.some((item) => item.includes('expected "decided consistent"'))).toBe(true);
  });
});

describe.skipIf(process.env.MODE !== 'determinism' || process.env.ERDEN_DETERMINISM_REQUESTS_OUT === undefined)(
  'determinism request writer',
  () => {
    test('writes the request set', () => {
      const out = resolve(process.env.ERDEN_DETERMINISM_REQUESTS_OUT ?? '');
      const manifest = writeDeterminismRequests(out) as { cases: Array<{ name: string; bytes: number; sha256: string }> };
      for (const item of manifest.cases) process.stdout.write(`${item.name} ${String(item.bytes)} ${item.sha256}\n`);
      expect(manifest.cases.length).toBe(determinismCases().length);
    }, 600_000);
  },
);

describe('reasoner-build workflow determinism jobs', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/reasoner-build.yml'), 'utf8');

  test('answers the set with every built target on its own runner and compares the answers', () => {
    expect(workflow).toContain('ERDEN_DETERMINISM_REQUESTS_OUT: ${{ github.workspace }}/determinism-requests');
    const jobs = workflow.slice(workflow.indexOf('\n    determinism:\n'));
    for (const target of DETERMINISM_TARGETS) expect(jobs).toContain(`- target: ${target}`);
    expect(jobs).toContain('needs: [build, determinism-requests]');
    expect(jobs).toContain('node reasoner/qualification/determinism.mjs run --binary "$binary"');
    expect(jobs).toMatch(/determinism\.mjs compare --requests determinism-requests\s+--answers determinism-answers/u);
  });
});
