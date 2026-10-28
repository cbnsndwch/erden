import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  assertCanonicalReasonerResponseJson,
  assertTrustedDecidedResponse,
  computeReasonerInputDigest,
  encodeReasonerRequestJson,
  encodeReasonerResponseJson,
  makeReasonerTrustExpectation,
  REASONER_PROFILE_ID,
  REASONER_PROFILE_SHA256,
  REASONER_PROFILE_V1_SHA256,
  MAX_REASONER_REQUEST_ID_BYTES,
  MAX_REASONER_WIRE_BYTES,
  stringifyCanonicalJson,
} from '../protocol/src/index.js';
import type { ReasonerRequest, ReasonerResponse, RequiredTool } from '../protocol/src/index.js';

import { HORN_ADAPTER_CONTRACT, HORN_CALCULUS_CONTRACT, HORN_TOOL_VERSION } from './horn-identity.js';
import { DIFFERENTIAL_SHAPES, outcomeOf, probeTool, runReasonerAsync, timingRequest } from './timing-shapes.js';

const root = resolve(import.meta.dirname, '..', '..');
const fixtureDirectory = resolve(root, 'reasoner', 'protocol', 'fixtures', 'known-answer');
const configuredBinary = process.env.ERDEN_REASONER_BIN;
const binary = configuredBinary === undefined ? undefined : resolve(configuredBinary);
const enabled = binary !== undefined && existsSync(binary);
// The differential qualification also needs the engine being replaced, for example the checked-in
// reasoner/linux-x64-gnu/bin/erden-reasoner (0.1.0).
const configuredBaseline = process.env.ERDEN_REASONER_BASELINE_BIN;
const baselineBinary = configuredBaseline === undefined ? undefined : resolve(configuredBaseline);
const differential = enabled && baselineBinary !== undefined && existsSync(baselineBinary);

const adapterContract = HORN_ADAPTER_CONTRACT;
const calculusContract = HORN_CALCULUS_CONTRACT;
function digest(input: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function tool(): RequiredTool {
  if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
  return {
    adapterDigest: digest(adapterContract),
    calculusDigest: digest(calculusContract),
    executableDigest: digest(readFileSync(binary)),
    name: 'erden-reasoner',
    version: HORN_TOOL_VERSION,
  };
}

function fixture(scenario: string): ReasonerRequest {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, `${scenario}.request.json`), 'utf8')) as ReasonerRequest;
}
function expected(scenario: string): ReasonerResponse {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, `${scenario}.response.json`), 'utf8')) as ReasonerResponse;
}

function invoke(
  request: ReasonerRequest,
  environment: Readonly<Record<string, string>> = {},
): { readonly bytes: string; readonly response: ReasonerResponse } {
  if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
  const child = spawnSync(binary, [], {
    encoding: 'utf8',
    input: encodeReasonerRequestJson(request),
    maxBuffer: 32 * 1024 * 1024,
    timeout: request.limits.maxWallTimeMs + 5_000,
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(Buffer.byteLength(child.stdout)).toBeLessThanOrEqual(MAX_REASONER_WIRE_BYTES);
  const response = assertCanonicalReasonerResponseJson(child.stdout);
  expect(child.stdout.endsWith('\n')).toBe(true);
  expect(child.stdout.includes('\r')).toBe(false);
  return { bytes: child.stdout, response };
}

function withTool(request: ReasonerRequest): ReasonerRequest {
  return { ...request, requiredTool: tool() };
}
function statementKey(statement: { readonly subject: string; readonly predicate: string; readonly object: unknown }): string {
  return JSON.stringify([statement.subject, statement.predicate, statement.object]);
}

function unicodeOrderingCounterexample(): ReasonerRequest {
  const source = {
    contentDigest: `sha256:${'a'.repeat(64)}` as const,
    id: 'source:root',
    kind: 'root' as const,
    ontologyIri: 'https://x.test/ontology',
  };
  const operands: [string, string] = ['https://x.test/\uE000', 'https://x.test/😀'];
  operands.sort();
  const request: ReasonerRequest = {
    kind: 'ReasonerRequest',
    limits: { maxInferences: 10, maxInputAxioms: 10, maxWallTimeMs: 5_000 },
    ontology: {
      axioms: [{
        domain: { kind: 'ObjectUnionOf', operands },
        graph: { kind: 'DefaultGraph' },
        id: 'a1',
        kind: 'PropertyDomain',
        property: 'https://x.test/p',
        propertyKind: 'DataProperty',
        provenance: {
          locator: 'unicode.ttl#domain',
          sourceDigest: source.contentDigest,
          sourceId: source.id,
          status: 'available',
        },
      }],
      digest: `sha256:${'0'.repeat(64)}`,
      sources: [source],
    },
    operation: 'classify-and-materialize',
    profile: { digest: REASONER_PROFILE_SHA256, id: REASONER_PROFILE_ID },
    protocolVersion: 1,
    requestId: 'counterexample:utf16-order',
    requiredTool: tool(),
  };
  return { ...request, ontology: { ...request.ontology, digest: computeReasonerInputDigest(request) } };
}

function unicodeResponseOrderingRequest(): ReasonerRequest {
  const base = fixture('subclass-type');
  const provenance = base.ontology.axioms[0]?.provenance;
  if (provenance === undefined) throw new TypeError('subclass fixture has no provenance');
  const child = 'https://x.test/Child';
  const parent = 'https://x.test/Parent';
  const request: ReasonerRequest = {
    ...base,
    requestId: 'qualification:utf16-response-order',
    requiredTool: tool(),
    ontology: {
      ...base.ontology,
      axioms: [
        { graph: { kind: 'DefaultGraph' }, id: 'a1', kind: 'SubClassOf', provenance, subClass: { iri: child, kind: 'NamedClass' }, superClass: { iri: parent, kind: 'NamedClass' } },
        { classExpression: { iri: child, kind: 'NamedClass' }, graph: { kind: 'DefaultGraph' }, id: 'a2', individual: 'https://x.test/😀', kind: 'ClassAssertion', provenance },
        { classExpression: { iri: child, kind: 'NamedClass' }, graph: { kind: 'DefaultGraph' }, id: 'a3', individual: 'https://x.test/\uE000', kind: 'ClassAssertion', provenance },
      ],
    },
  };
  return { ...request, ontology: { ...request.ontology, digest: computeReasonerInputDigest(request) } };
}

type DatatypeOutcome = 'decided' | 'boundary' | 'inconsistent';
type DatatypeUsage = 'range' | 'dataAssertion' | 'annotation' | 'annotationRange' | 'rangedAssertion' | 'rangedStringAssertion';

interface DatatypeCase {
  readonly iri: string;
  readonly lexical: string;
  readonly language?: string;
  /** What 0.1.0 does with the datatype as a range and as a literal (the normalizer's refusal list). */
  readonly range: DatatypeOutcome;
  readonly literal: DatatypeOutcome;
  /** What the 0.2.0 decision procedure does with each usage. */
  readonly 'v0.2': Readonly<Record<DatatypeUsage, DatatypeOutcome>>;
}

const datatypeCases = (JSON.parse(readFileSync(resolve(import.meta.dirname, 'datatypes.json'), 'utf8')) as {
  readonly datatypes: ReadonlyArray<DatatypeCase>;
}).datatypes;

/** One request per datatype usage, built at the protocol level so it bypasses the normalizer's refusals. */
function datatypeRequest(item: DatatypeCase, usage: DatatypeUsage): ReasonerRequest {
  const base = fixture('subclass-type');
  const provenance = base.ontology.axioms[0]?.provenance;
  if (provenance === undefined) throw new TypeError('subclass fixture has no provenance');
  const graph = { kind: 'DefaultGraph' } as const;
  const value = { datatype: item.iri, kind: 'Literal' as const, language: item.language ?? null, lexicalForm: item.lexical };
  const property = 'https://x.test/p';
  const subject = 'https://x.test/i';
  const dataProperty = { entityKind: 'DataProperty', graph, id: 'a1', iri: property, kind: 'Declaration', provenance } as const;
  const range = { graph, id: 'a2', kind: 'PropertyRange', property, propertyKind: 'DataProperty', provenance, range: item.iri } as const;
  const byUsage: Readonly<Record<DatatypeUsage, ReasonerRequest['ontology']['axioms']>> = {
    range: [dataProperty, range],
    dataAssertion: [dataProperty, { graph, id: 'a2', kind: 'DataPropertyAssertion', property, provenance, subject, value }],
    annotation: [
      { entityKind: 'AnnotationProperty', graph, id: 'a1', iri: property, kind: 'Declaration', provenance },
      { graph, id: 'a2', kind: 'AnnotationAssertion', property, provenance, subject, value },
    ],
    annotationRange: [
      { entityKind: 'AnnotationProperty', graph, id: 'a1', iri: property, kind: 'Declaration', provenance },
      { graph, id: 'a2', kind: 'PropertyRange', property, propertyKind: 'AnnotationProperty', provenance, range: item.iri },
    ],
    rangedAssertion: [dataProperty, range, { graph, id: 'a3', kind: 'DataPropertyAssertion', property, provenance, subject, value }],
    rangedStringAssertion: [
      dataProperty,
      range,
      { graph, id: 'a3', kind: 'DataPropertyAssertion', property, provenance, subject, value: { datatype: 'http://www.w3.org/2001/XMLSchema#string', kind: 'Literal', language: null, lexicalForm: 'x' } },
    ],
  };
  const axioms = byUsage[usage];
  const request: ReasonerRequest = {
    ...base,
    requestId: `qualification:datatype:${usage}:${item.iri.replace(/^.*[#/]/u, '')}`,
    requiredTool: tool(),
    ontology: { ...base.ontology, axioms },
  };
  return { ...request, ontology: { ...request.ontology, digest: computeReasonerInputDigest(request) } };
}

describe.skipIf(!enabled)('PurRDF 0.12.0 adapter qualification', () => {
  test('accepts the canonical UTF-16/scalar-order counterexample', () => {
    const request = unicodeOrderingCounterexample();
    expect(request.ontology.axioms[0]?.kind).toBe('PropertyDomain');
    if (request.ontology.axioms[0]?.kind !== 'PropertyDomain' || request.ontology.axioms[0].domain.kind !== 'ObjectUnionOf') return;
    expect(request.ontology.axioms[0].domain.operands).toEqual(['https://x.test/😀', 'https://x.test/\uE000']);
    expect(request.ontology.digest).toBe('sha256:e157d161803ec629eded477fa06034aaa658110cad44c7b2520f12879426feac');

    const { response } = invoke(request);
    expect(response.result.outcome).toBe('decided');
    if (response.result.outcome !== 'decided') return;
    assertTrustedDecidedResponse(request, response, makeReasonerTrustExpectation(tool()));
    expect(response.result).toMatchObject({
      asserted: [],
      completeness: 'complete',
      consistency: 'consistent',
      diagnostics: [],
      inferred: [],
      outcome: 'decided',
      unsatisfiableClasses: [],
    });
    expect(response.result.certificate.outputDigest).toBe('sha256:13bea6cd8cd892c342d71719397c33a8ff0a5abf0189e37d9cddc2b8db5e6d16');
    expect(response.result.certificate.justificationDigest).toBe('sha256:d12b0f4e28403ab418c38cd2040c23c933cfbfd58095329bebade0e66e78fb3e');
    expect(response.result.certificate.certificateDigest).toBe('sha256:459cefadf88e80b1d0fa874c48d42d3f04d190e912f0afa53901d4d3d9d4bc33');
  });

  test('orders real asserted and inferred Unicode output with JavaScript semantics', () => {
    const request = unicodeResponseOrderingRequest();
    const { bytes, response } = invoke(request);
    expect(response.result.outcome).toBe('decided');
    if (response.result.outcome !== 'decided') return;
    assertTrustedDecidedResponse(request, response, makeReasonerTrustExpectation(tool()));
    expect(bytes).toBe(encodeReasonerResponseJson(response));
    expect(bytes.endsWith('\n')).toBe(true);
    expect(response.result.asserted.map((statement) => ({ id: statement.id, subject: statement.subject }))).toEqual([
      { id: 'stmt:a2', subject: 'https://x.test/😀' },
      { id: 'stmt:a3', subject: 'https://x.test/\uE000' },
    ]);
    expect(response.result.inferred.map((statement) => ({ id: statement.id, subject: statement.subject }))).toEqual([
      { id: 'inferred:1', subject: 'https://x.test/😀' },
      { id: 'inferred:2', subject: 'https://x.test/\uE000' },
    ]);
    const emojiSubject = '"subject":"https://x.test/😀"';
    const privateSubject = '"subject":"https://x.test/\uE000"';
    expect(bytes.indexOf(emojiSubject)).toBeGreaterThanOrEqual(0);
    expect(bytes.indexOf(emojiSubject)).toBeLessThan(bytes.indexOf(privateSubject));
    expect(invoke(request).bytes).toBe(bytes);
  });

  test('rejects the non-canonical scalar-value union order', () => {
    if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
    const canonical = unicodeOrderingCounterexample();
    const axiom = canonical.ontology.axioms[0];
    if (axiom?.kind !== 'PropertyDomain' || axiom.domain.kind !== 'ObjectUnionOf') throw new TypeError('counterexample shape changed');
    const reversed: ReasonerRequest = {
      ...canonical,
      ontology: {
        ...canonical.ontology,
        axioms: [{ ...axiom, domain: { ...axiom.domain, operands: [...axiom.domain.operands].reverse() } }],
      },
    };
    const child = spawnSync(binary, [], {
      encoding: 'utf8',
      input: stringifyCanonicalJson(reversed),
      maxBuffer: 32 * 1024 * 1024,
      timeout: reversed.limits.maxWallTimeMs + 5_000,
      windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('erden-reasoner: ObjectUnionOf.operands must be strictly sorted and unique\n');
  });

  test('all committed known answers are canonical, trusted, and semantically cover their oracle', () => {
    const manifest = JSON.parse(readFileSync(resolve(fixtureDirectory, 'manifest.json'), 'utf8')) as { readonly scenarios: ReadonlyArray<string> };
    for (const scenario of manifest.scenarios) {
      const request = withTool(fixture(scenario));
      const oracle = expected(scenario);
      const { response } = invoke(request);
      expect(response.requestId).toBe(request.requestId);
      expect(response.inputDigest).toBe(request.ontology.digest);
      expect(response.result.outcome, scenario).toBe(oracle.result.outcome);
      if (oracle.result.outcome === 'refused') {
        expect(response.result.outcome).toBe('refused');
        if (response.result.outcome === 'refused') {
          expect(response.result.reason, scenario).toBe(oracle.result.reason);
          const actualCodes = new Set(response.result.diagnostics.map((item) => item.code));
          for (const item of oracle.result.diagnostics) expect(actualCodes.has(item.code), `${scenario}:${item.code}`).toBe(true);
        }
        continue;
      }
      expect(response.result.outcome).toBe('decided');
      if (response.result.outcome !== 'decided' || oracle.result.outcome !== 'decided') continue;
      assertTrustedDecidedResponse(request, response, makeReasonerTrustExpectation(tool()));
      expect(response.result.consistency).toBe(oracle.result.consistency);
      const actualStatements = new Set([...response.result.asserted, ...response.result.inferred].map(statementKey));
      for (const statement of [...oracle.result.asserted, ...oracle.result.inferred]) {
        expect(actualStatements.has(statementKey(statement)), `${scenario}:${statementKey(statement)}`).toBe(true);
      }
      expect(response.result.unsatisfiableClasses.map((item) => item.classIri)).toEqual(oracle.result.unsatisfiableClasses.map((item) => item.classIri));
    }
  });

  test('one request is byte-identical across 100 independent processes', () => {
    const request = withTool(fixture('inverse-transitive-properties'));
    const baseline = invoke(request).bytes;
    for (let run = 1; run < 100; run += 1) expect(invoke(request).bytes).toBe(baseline);
  }, 30_000);

  test('mutated identifiers and IRIs prove generalized multi-hop reasoning', () => {
    const base = fixture('subclass-type');
    const baseAxiom = base.ontology.axioms.at(0);
    if (baseAxiom === undefined) throw new TypeError('subclass fixture has no axiom');
    const { provenance } = baseAxiom;
    const mutated: ReasonerRequest = {
      ...base,
      requestId: 'qualification:mutated-multihop',
      requiredTool: tool(),
      ontology: {
        ...base.ontology,
        axioms: [
          { graph: { kind: 'DefaultGraph' }, id: 'm1', kind: 'SubClassOf', provenance, subClass: { iri: 'https://mutated.test/C1', kind: 'NamedClass' }, superClass: { iri: 'https://mutated.test/C2', kind: 'NamedClass' } },
          { graph: { kind: 'DefaultGraph' }, id: 'm2', kind: 'SubClassOf', provenance, subClass: { iri: 'https://mutated.test/C2', kind: 'NamedClass' }, superClass: { iri: 'https://mutated.test/C3', kind: 'NamedClass' } },
          { classExpression: { iri: 'https://mutated.test/C1', kind: 'NamedClass' }, graph: { kind: 'DefaultGraph' }, id: 'm3', individual: 'https://mutated.test/i', kind: 'ClassAssertion', provenance },
        ],
      },
    };
    const request = { ...mutated, ontology: { ...mutated.ontology, digest: computeReasonerInputDigest(mutated) } };
    const response = invoke(request).response;
    expect(response.result.outcome).toBe('decided');
    if (response.result.outcome !== 'decided') return;
    assertTrustedDecidedResponse(request, response, makeReasonerTrustExpectation(tool()));
    expect(response.result.inferred.some((item) => item.subject === 'https://mutated.test/C1' && item.predicate.endsWith('#subClassOf') && item.object === 'https://mutated.test/C3')).toBe(true);
    expect(response.result.inferred.some((item) => item.subject === 'https://mutated.test/i' && item.predicate.endsWith('#type') && item.object === 'https://mutated.test/C3')).toBe(true);
  });

  test('canonical normalization removes caller array ordering as a source of output drift', () => {
    const canonical = withTool(fixture('domain-range'));
    const reordered: ReasonerRequest = { ...canonical, ontology: { ...canonical.ontology, axioms: [...canonical.ontology.axioms].reverse() } };
    expect(invoke(reordered).bytes).toBe(invoke(canonical).bytes);
  });

  test('the demo union-domain case never invents a type for a union member', () => {
    const response = invoke(withTool(fixture('current-demo-constructs'))).response;
    expect(response.result.outcome).toBe('decided');
    if (response.result.outcome !== 'decided') return;
    expect(response.result.inferred.filter((item) => item.predicate.endsWith('#type'))).toEqual([]);
  });

  test('the closure gaps list exactly their entailed types, each with an accepted case-analysis proof', () => {
    const x = 'https://x.test/';
    const expectedTypes: Readonly<Record<string, ReadonlyArray<readonly [string, string, string]>>> = {
      'union-common-superclass': [[`${x}i`, `${x}Agent`, 'union-domain-type']],
      'union-operand-excluded-by-disjointness': [[`${x}i`, `${x}B`, 'union-domain-type']],
      'superclass-of-owl-thing': [[`${x}j`, `${x}T`, 'thing-subclass-type']],
    };
    for (const [name, request] of closureGapRequests()) {
      const { response } = invoke(request);
      expect(response.result.outcome, name).toBe('decided');
      if (response.result.outcome !== 'decided') continue;
      assertTrustedDecidedResponse(request, response, makeReasonerTrustExpectation(tool()));
      const typed = response.result.inferred
        .filter((item) => item.provenance.rule === 'union-domain-type' || item.provenance.rule === 'thing-subclass-type')
        .map((item) => [item.subject, item.object, item.provenance.rule] as const);
      expect(typed, name).toEqual(expectedTypes[name]);
    }
  });

  test('profile identity is the committed V2 identity, and V1 keeps its digest', () => {
    expect(REASONER_PROFILE_ID).toBe('erden-required-constructs-v2');
    expect(REASONER_PROFILE_SHA256).toBe('sha256:ff36438e2500497ed8dc8b955cf7033c9bed781495c214793c0ba6859bbede5f');
    expect(REASONER_PROFILE_V1_SHA256).toBe('sha256:0bc7dec03b01761e9762f4bc8d44b23c2f8288228cd8913d791771536bf179e5');
  });

  test('the process supervisor enforces deadlines and captured-output limits fail closed', () => {
    for (const scenario of ['subclass-type', 'inconsistency']) {
      const base = withTool(fixture(scenario));
      const request = { ...base, limits: { ...base.limits, maxWallTimeMs: 1 } };
      const { response } = invoke(request);
      expect(response.result).toMatchObject({ outcome: 'refused', reason: 'budget-exhausted' });
      if (response.result.outcome === 'refused') {
        expect(response.result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('wall-time-budget');
      }
    }

    const base = withTool(fixture('subclass-type'));
    const bounded = { ...base, limits: { ...base.limits, maxWallTimeMs: 50 } };
    for (const mode of ['slow', 'hang']) {
      const { response } = invoke(bounded, { ERDEN_REASONER_TEST_WORKER_MODE: mode });
      expect(response.result).toMatchObject({ outcome: 'refused', reason: 'budget-exhausted' });
    }

    const oversized = { ...base, limits: { ...base.limits, maxWallTimeMs: 5_000 } };
    const { response: oversizedResponse } = invoke(oversized, { ERDEN_REASONER_TEST_WORKER_MODE: 'oversized' });
    expect(oversizedResponse.result).toMatchObject({ outcome: 'refused', reason: 'budget-exhausted' });
    if (oversizedResponse.result.outcome === 'refused') {
      expect(oversizedResponse.result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('worker-output-invalid');
    }

    const { response: workerFailure } = invoke(oversized, { ERDEN_REASONER_TEST_WORKER_MODE: 'worker-failure' });
    expect(workerFailure.result).toMatchObject({ outcome: 'refused', reason: 'budget-exhausted' });

    const inherited = { ...base, limits: { ...base.limits, maxWallTimeMs: 1 } };
    const { response: inheritedResponse } = invoke(inherited, { ERDEN_REASONER_INTERNAL_WORKER: '1' });
    expect(inheritedResponse.result).toMatchObject({ outcome: 'refused', reason: 'budget-exhausted' });
  }, 20_000);

  test('the untrusted worker entry is independently equivalent and bounded', () => {
    if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
    const executable = binary;
    function direct(arguments_: ReadonlyArray<string>, mode?: string, input = '') {
      return spawnSync(executable, arguments_, {
        env: { ...process.env, ...(mode === undefined ? {} : { ERDEN_REASONER_TEST_WORKER_MODE: mode }) },
        input,
        maxBuffer: 17 * 1024 * 1024,
        timeout: 3_000,
        windowsHide: true,
      });
    }
    function assertClosed(child: ReturnType<typeof direct>): void {
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stdout.length).toBeLessThanOrEqual(MAX_REASONER_WIRE_BYTES);
    }

    for (const mode of [undefined, 'hang', 'slow', 'oversized']) {
      assertClosed(direct(['--erden-private-internal-worker-v1'], mode));
    }
    assertClosed(direct(['--erden-private-internal-worker-v1', 'extra'], 'hang'));
    assertClosed(direct(['--erden-private-internal-worker-v2', '1', 'not-a-digest'], 'hang'));
    assertClosed(direct(['--erden-private-internal-worker-v3', 'random-or-stale-pipe'], 'hang'));
    assertClosed(direct(['--erden-private-untrusted-worker-v3', 'extra'], 'hang'));

    const normalRequest = withTool(fixture('subclass-type'));
    const normal = direct(['--erden-private-untrusted-worker-v3'], undefined, encodeReasonerRequestJson(normalRequest));
    expect(normal.error).toBeUndefined();
    expect(normal.status).toBe(0);
    expect(normal.stderr.length).toBe(0);
    const directResponse = assertCanonicalReasonerResponseJson(normal.stdout.toString());
    expect(directResponse.result.outcome).toBe('decided');
    assertTrustedDecidedResponse(normalRequest, directResponse, makeReasonerTrustExpectation(tool()));

    const base = withTool(fixture('subclass-type'));
    const short = { ...base, limits: { ...base.limits, maxWallTimeMs: 50 } };
    for (const mode of ['slow', 'hang']) {
      const child = direct(['--erden-private-untrusted-worker-v3'], mode, encodeReasonerRequestJson(short));
      assertClosed(child);
      expect(child.stdout.length).toBe(0);
    }

    const oneMillisecond = { ...base, limits: { ...base.limits, maxWallTimeMs: 1 } };
    const normalTimedOut = direct(['--erden-private-untrusted-worker-v3'], undefined, encodeReasonerRequestJson(oneMillisecond));
    assertClosed(normalTimedOut);
    expect(normalTimedOut.stdout.length).toBe(0);
    const timedOut = direct(['--erden-private-untrusted-worker-v3'], 'hang', encodeReasonerRequestJson(oneMillisecond));
    assertClosed(timedOut);
    expect(timedOut.stdout.length).toBe(0);

    const oversized = { ...base, limits: { ...base.limits, maxWallTimeMs: 5_000 } };
    const tooLarge = direct(['--erden-private-untrusted-worker-v3'], 'oversized', encodeReasonerRequestJson(oversized));
    assertClosed(tooLarge);
    expect(tooLarge.stdout.length).toBe(0);
  });

  test('public and V3 entries enforce request ID and exact wire boundaries', () => {
    if (binary === undefined) throw new Error('ERDEN_REASONER_BIN is required');
    const executable = binary;
    function run(arguments_: ReadonlyArray<string>, input: string) {
      return spawnSync(executable, arguments_, {
        input,
        maxBuffer: 17 * 1024 * 1024,
        timeout: 40_000,
        windowsHide: true,
      });
    }
    const base = withTool(fixture('subclass-type'));
    const oversizedId = stringifyCanonicalJson({
      ...base,
      requestId: `r${'a'.repeat(MAX_REASONER_REQUEST_ID_BYTES)}`,
    });
    for (const arguments_ of [[], ['--erden-private-untrusted-worker-v3']]) {
      const child = run(arguments_, oversizedId);
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stdout.length).toBe(0);
    }

    const hugeIdBase = stringifyCanonicalJson({ ...base, requestId: 'r' });
    const hugeIdAtMax = stringifyCanonicalJson({
      ...base,
      requestId: `r${'a'.repeat(MAX_REASONER_WIRE_BYTES - Buffer.byteLength(hugeIdBase))}`,
    });
    expect(Buffer.byteLength(hugeIdAtMax)).toBe(MAX_REASONER_WIRE_BYTES);
    for (const arguments_ of [[], ['--erden-private-untrusted-worker-v3']]) {
      const child = run(arguments_, hugeIdAtMax);
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stdout.length).toBe(0);
    }

    function atWireSize(target: number): string {
      const source = base.ontology.sources[0];
      const draft: ReasonerRequest = {
        ...base,
        requestId: `r${'a'.repeat(MAX_REASONER_REQUEST_ID_BYTES - 1)}`,
        limits: { ...base.limits, maxWallTimeMs: 30_000 },
        ontology: {
          ...base.ontology,
          sources: [{ ...source, ontologyIri: 'https://padding.test/' }],
        },
      };
      const withDigest: ReasonerRequest = {
        ...draft,
        ontology: { ...draft.ontology, digest: computeReasonerInputDigest(draft) },
      };
      const baseline = encodeReasonerRequestJson(withDigest);
      const padding = target - Buffer.byteLength(baseline);
      if (padding < 0) throw new Error('Wire target is smaller than the valid base request');
      const padded: ReasonerRequest = {
        ...draft,
        ontology: {
          ...draft.ontology,
          sources: [{ ...source, ontologyIri: `https://padding.test/${'p'.repeat(padding)}` }],
        },
      };
      const finalRequest: ReasonerRequest = {
        ...padded,
        ontology: { ...padded.ontology, digest: computeReasonerInputDigest(padded) },
      };
      const encoded = encodeReasonerRequestJson(finalRequest);
      expect(Buffer.byteLength(encoded)).toBe(target);
      return encoded;
    }

    const exact = atWireSize(MAX_REASONER_WIRE_BYTES);
    const publicExact = run([], exact);
    const directExact = run(['--erden-private-untrusted-worker-v3'], exact);
    for (const child of [publicExact, directExact]) {
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stderr.length).toBe(0);
      expect(child.stdout.length).toBeLessThanOrEqual(MAX_REASONER_WIRE_BYTES);
      assertCanonicalReasonerResponseJson(child.stdout.toString());
    }
    expect(publicExact.stdout.equals(directExact.stdout)).toBe(true);

    const over = atWireSize(MAX_REASONER_WIRE_BYTES + 1);
    for (const arguments_ of [[], ['--erden-private-untrusted-worker-v3']]) {
      const child = run(arguments_, over);
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stdout.length).toBe(0);
    }
  }, 120_000);
  test('every built-in datatype usage matches the recorded decision or PurRDF boundary', () => {
    expect(datatypeCases).toHaveLength(44);
    for (const item of datatypeCases) {
      for (const [usage, expectedOutcome] of Object.entries(item['v0.2']) as ReadonlyArray<[DatatypeUsage, DatatypeOutcome]>) {
        const request = datatypeRequest(item, usage);
        const { response } = invoke(request);
        const label = `${usage} ${item.iri}`;
        if (expectedOutcome === 'decided') {
          expect(response.result.outcome, label).toBe('decided');
          if (response.result.outcome === 'decided') {
            assertTrustedDecidedResponse(request, response, makeReasonerTrustExpectation(tool()));
            expect(response.result.consistency, label).toBe('consistent');
          }
        } else {
          expect(response.result.outcome, label).toBe('refused');
          if (response.result.outcome === 'refused') {
            expect(response.result.reason, label).toBe(expectedOutcome === 'boundary' ? 'boundary-exhausted' : 'incomplete-certificate');
          }
        }
      }
    }
  }, 120_000);
});

/**
 * A response without the parts that name the tool: the tool itself, and the certificate fields bound to it, including
 * the proof checker (0.2.0 answers name `erden-proof-checker-v2`, 0.1.0 answers v1).
 */
function comparableAnswer(response: ReasonerResponse): unknown {
  const { tool: _tool, ...rest } = response;
  if (rest.result.outcome !== 'decided') return rest;
  const { certificate, ...evidence } = rest.result;
  const {
    calculusDigest: _calculus,
    certificateDigest: _certificate,
    proofCheckerDigest: _checkerDigest,
    proofCheckerId: _checkerId,
    ...stable
  } = certificate;
  return { ...rest, result: { ...evidence, certificate: stable } };
}

/** The proof rules proof checker v2 adds: the types the closure's rules cannot reach, listed by case analysis. */
const TYPING_RULES: ReadonlySet<string> = new Set(['union-domain-type', 'thing-subclass-type']);

/**
 * The answer without its case-analysis types and the digests over the statement lists, for the patterns where 0.2.0
 * lists types 0.1.0 left out; the closure's own statements keep their ids and premises.
 */
function comparableWithoutTyping(response: ReasonerResponse): unknown {
  const answer = comparableAnswer(response) as { result: Record<string, unknown> & { outcome: string } };
  if (response.result.outcome !== 'decided') return answer;
  const { certificate, inferred, ...evidence } = answer.result as unknown as {
    certificate: Record<string, unknown>;
    inferred: ReadonlyArray<{ readonly provenance: { readonly rule: string } }>;
  };
  const { justificationDigest: _justification, outputDigest: _output, ...stable } = certificate;
  return {
    ...answer,
    result: { ...evidence, certificate: stable, inferred: inferred.filter((item) => !TYPING_RULES.has(item.provenance.rule)) },
  };
}

/** The bug report's issue 3 shape at the protocol level: a union domain, an assertion, and a range. */
function unionDomainRequest(): ReasonerRequest {
  const base = fixture('subclass-type');
  const provenance = base.ontology.axioms[0]?.provenance;
  if (provenance === undefined) throw new TypeError('subclass fixture has no provenance');
  const graph = { kind: 'DefaultGraph' } as const;
  const x = 'https://x.test/';
  const request: ReasonerRequest = {
    ...base,
    requestId: 'qualification:differential:union-domain',
    requiredTool: tool(),
    ontology: {
      ...base.ontology,
      axioms: [
        { entityKind: 'Class', graph, id: 'u1', iri: `${x}A`, kind: 'Declaration', provenance },
        { entityKind: 'Class', graph, id: 'u2', iri: `${x}B`, kind: 'Declaration', provenance },
        { entityKind: 'Class', graph, id: 'u3', iri: `${x}C`, kind: 'Declaration', provenance },
        { domain: { kind: 'ObjectUnionOf', operands: [`${x}A`, `${x}B`] }, graph, id: 'u4', kind: 'PropertyDomain', property: `${x}p`, propertyKind: 'ObjectProperty', provenance },
        { graph, id: 'u5', kind: 'PropertyRange', property: `${x}p`, propertyKind: 'ObjectProperty', provenance, range: `${x}C` },
        { classExpression: { iri: `${x}A`, kind: 'NamedClass' }, graph, id: 'u6', individual: `${x}i`, kind: 'ClassAssertion', provenance },
        { graph, id: 'u7', kind: 'ObjectPropertyAssertion', object: `${x}j`, property: `${x}p`, provenance, subject: `${x}i` },
      ],
    },
  };
  return { ...request, ontology: { ...request.ontology, digest: computeReasonerInputDigest(request) } };
}

/**
 * The three V1 patterns whose entailed types the closure's rules cannot derive. The 0.1 engine decides each without
 * that type; 0.2.0 lists it with a `union-domain-type` or `thing-subclass-type` proof (engine.rs `type_individuals`).
 */
function closureGapRequests(): ReadonlyArray<readonly [string, ReasonerRequest]> {
  const base = fixture('subclass-type');
  const provenance = base.ontology.axioms[0]?.provenance;
  if (provenance === undefined) throw new TypeError('subclass fixture has no provenance');
  const graph = { kind: 'DefaultGraph' } as const;
  const x = 'https://x.test/';
  const named = (name: string) => ({ iri: `${x}${name}`, kind: 'NamedClass' }) as const;
  const declare = (name: string) => ({ entityKind: 'Class', graph, id: `d-${name}`, iri: `${x}${name}`, kind: 'Declaration', provenance }) as const;
  const unionDomain = { domain: { kind: 'ObjectUnionOf', operands: [`${x}A`, `${x}B`] }, graph, id: 'g2', kind: 'PropertyDomain', property: `${x}p`, propertyKind: 'ObjectProperty', provenance } as const;
  const assertion = { graph, id: 'g9', kind: 'ObjectPropertyAssertion', object: `${x}j`, property: `${x}p`, provenance, subject: `${x}i` } as const;
  const shapes: ReadonlyArray<readonly [string, ReasonerRequest['ontology']['axioms']]> = [
    ['union-common-superclass', [
      declare('A'), declare('Agent'), declare('B'),
      { graph, id: 'g0', kind: 'SubClassOf', provenance, subClass: named('A'), superClass: named('Agent') },
      { graph, id: 'g1', kind: 'SubClassOf', provenance, subClass: named('B'), superClass: named('Agent') },
      unionDomain, assertion,
    ]],
    ['union-operand-excluded-by-disjointness', [
      declare('A'), declare('B'), declare('X'),
      { classes: [named('A'), named('X')], graph, id: 'g0', kind: 'DisjointClasses', provenance },
      { classExpression: named('X'), graph, id: 'g1', individual: `${x}i`, kind: 'ClassAssertion', provenance },
      unionDomain, assertion,
    ]],
    ['superclass-of-owl-thing', [
      declare('T'), declare('U'),
      { graph, id: 'g0', kind: 'SubClassOf', provenance, subClass: { iri: 'http://www.w3.org/2002/07/owl#Thing', kind: 'NamedClass' }, superClass: named('T') },
      { classExpression: named('U'), graph, id: 'g1', individual: `${x}j`, kind: 'ClassAssertion', provenance },
    ]],
  ];
  return shapes.map(([name, axioms]) => {
    const request: ReasonerRequest = {
      ...base,
      requestId: `qualification:differential:${name}`,
      requiredTool: tool(),
      ontology: { ...base.ontology, axioms: [...axioms].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) },
    };
    return [name, { ...request, ontology: { ...request.ontology, digest: computeReasonerInputDigest(request) } }] as const;
  });
}

describe.skipIf(!differential)('differential qualification against the engine being replaced', () => {
  const baselineTool = (): RequiredTool => {
    if (baselineBinary === undefined) throw new Error('ERDEN_REASONER_BASELINE_BIN is required');
    return probeTool(baselineBinary);
  };

  /**
   * Identical answers, except where `typed` says 0.2.0 lists case-analysis types 0.1.0 left out: then the answers
   * agree on everything else, at least one such type is listed, and the TypeScript proof checker accepts each one.
   */
  async function compare(label: string, request: ReasonerRequest, typed = false): Promise<'compared' | 'baseline-undecided'> {
    if (binary === undefined || baselineBinary === undefined) throw new Error('both binaries are required');
    const currentRequest = { ...request, requiredTool: tool() };
    const [current, baseline] = await Promise.all([
      runReasonerAsync(binary, currentRequest),
      runReasonerAsync(baselineBinary, { ...request, requiredTool: baselineTool() }),
    ]);
    if (baseline.response.result.outcome !== 'decided') return 'baseline-undecided';
    expect(outcomeOf(current.response), label).toBe(outcomeOf(baseline.response));
    if (!typed) {
      expect(comparableAnswer(current.response), label).toEqual(comparableAnswer(baseline.response));
      return 'compared';
    }
    expect(comparableWithoutTyping(current.response), label).toEqual(comparableWithoutTyping(baseline.response));
    if (current.response.result.outcome !== 'decided' || baseline.response.result.outcome !== 'decided') return 'compared';
    const added = current.response.result.inferred.filter((item) => TYPING_RULES.has(item.provenance.rule));
    expect(added.length, label).toBeGreaterThan(0);
    expect(baseline.response.result.inferred.some((item) => TYPING_RULES.has(item.provenance.rule))).toBe(false);
    assertTrustedDecidedResponse(currentRequest, current.response, makeReasonerTrustExpectation(tool()));
    return 'compared';
  }

  test('the known answers, the Unicode order cases and the union domain give identical answers; the closure gaps differ only by proved types', async () => {
    const manifest = JSON.parse(readFileSync(resolve(fixtureDirectory, 'manifest.json'), 'utf8')) as { readonly scenarios: ReadonlyArray<string> };
    const cases: Array<readonly [string, ReasonerRequest]> = [
      ...manifest.scenarios.map((scenario) => [scenario, withTool(fixture(scenario))] as const),
      ['utf16-counterexample', unicodeOrderingCounterexample()],
      ['utf16-response-order', unicodeResponseOrderingRequest()],
      ['union-domain', unionDomainRequest()],
    ];
    const outcomes = await Promise.all([
      ...cases.map(([label, request]) => compare(label, request)),
      ...closureGapRequests().map(([label, request]) => compare(label, request, true)),
    ]);
    const decided = manifest.scenarios.filter((scenario) => expected(scenario).result.outcome === 'decided').length;
    expect(outcomes.filter((outcome) => outcome === 'compared')).toHaveLength(decided + 6);
  }, 120_000);

  test('every generated shape the engine being replaced decides gives identical answers', async () => {
    const budgetMs = Number(process.env.ERDEN_REASONER_DIFFERENTIAL_BUDGET_MS ?? '300000');
    const outcomes = await Promise.all(
      DIFFERENTIAL_SHAPES.map(async (shape) => [shape.name, await compare(shape.name, timingRequest(shape, tool(), budgetMs))] as const),
    );
    process.stdout.write(`${outcomes.map(([name, outcome]) => `${name}: ${outcome}`).join('\n')}\n`);
    expect(outcomes.filter(([, outcome]) => outcome === 'compared').length).toBeGreaterThan(0);
  }, 900_000);
});
