import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  assertCanonicalReasonerResponseJson,
  computeReasonerInputDigest,
  encodeReasonerRequestJson,
  ERDEN_PROOF_CHECKER_ID,
  ERDEN_PROOF_CHECKER_SHA256,
  normalizeReasonerRequest,
  REASONER_PROFILE_ID,
  REASONER_PROFILE_SHA256,
  stringifyCanonicalJson,
} from '../protocol/src/index.js';
import type { JsonValue, ReasonerRequest, ReasonerResponse, RequiredTool } from '../protocol/src/index.js';

// Generated reasoner requests and a direct process runner, shared by the timing gate
// (timing.test.ts) and the differential qualification (adapter.test.ts).

type Axiom = ReasonerRequest['ontology']['axioms'][number];

/** One generated ontology, following the 2026-10-05 bug report's `gen.mjs`. */
export interface TimingShape {
  readonly name: string;
  /** Number of classes; `gen.mjs` always uses 5. */
  readonly classes: number;
  /** Properties, each with a domain `C(p mod classes)` and a range `C(p+1 mod classes)` or `xsd:string`. */
  readonly properties: number;
  /** Individuals, each typed `C0`. */
  readonly individuals: number;
  readonly axes?: 'domain' | 'range' | 'both';
  readonly kind?: 'object' | 'datatype';
  /** When set, individual `i` also asserts `p(i mod P)` to individual `i+1`, or to a literal. Not in `gen.mjs`. */
  readonly assertions?: boolean;
  /**
   * When set, the shape also exercises every other V1 rule: a class tree, an equivalence, a
   * disjointness, inverse and transitive properties, a union domain, and a ranged data property
   * with assertions. Not in `gen.mjs`; used by the differential qualification.
   */
  readonly rich?: boolean;
  /** When set, the classes form one `SubClassOf` chain `C0 ⊑ C1 ⊑ …`, so each individual infers every later class. */
  readonly chain?: boolean;
  /** The A-S7 target for this case; asserted only with ERDEN_REASONER_TIMING_ASSERT=1. */
  readonly ceilingMs: number;
}

const GRID_CEILING_MS = 1_000;

/** The bug report's grid, its three wall shapes and two shapes with property assertions. */
export const TIMING_SHAPES: ReadonlyArray<TimingShape> = [
  { name: 'p20i0', classes: 5, properties: 20, individuals: 0, ceilingMs: GRID_CEILING_MS },
  { name: 'p40i0', classes: 5, properties: 40, individuals: 0, ceilingMs: GRID_CEILING_MS },
  { name: 'p80i0', classes: 5, properties: 80, individuals: 0, ceilingMs: GRID_CEILING_MS },
  { name: 'p0i1000', classes: 5, properties: 0, individuals: 1_000, ceilingMs: GRID_CEILING_MS },
  { name: 'p0i3000', classes: 5, properties: 0, individuals: 3_000, ceilingMs: GRID_CEILING_MS },
  { name: 'p10i10', classes: 5, properties: 10, individuals: 10, ceilingMs: GRID_CEILING_MS },
  { name: 'p15i15', classes: 5, properties: 15, individuals: 15, ceilingMs: GRID_CEILING_MS },
  { name: 'p10i20', classes: 5, properties: 10, individuals: 20, ceilingMs: GRID_CEILING_MS },
  { name: 'p20i20', classes: 5, properties: 20, individuals: 20, ceilingMs: GRID_CEILING_MS },
  { name: 'p10i40', classes: 5, properties: 10, individuals: 40, ceilingMs: GRID_CEILING_MS },
  { name: 'p20i20-domain', classes: 5, properties: 20, individuals: 20, axes: 'domain', ceilingMs: GRID_CEILING_MS },
  { name: 'p20i20-range', classes: 5, properties: 20, individuals: 20, axes: 'range', ceilingMs: GRID_CEILING_MS },
  { name: 'p20i20-datatype', classes: 5, properties: 20, individuals: 20, kind: 'datatype', ceilingMs: GRID_CEILING_MS },
  { name: 'iptc-28x157x0', classes: 28, properties: 157, individuals: 0, ceilingMs: 1_000 },
  { name: 'league-174x528x374', classes: 174, properties: 528, individuals: 374, ceilingMs: 5_000 },
  { name: 'target-100x300x1000', classes: 100, properties: 300, individuals: 1_000, ceilingMs: 5_000 },
  { name: 'asserted-p20i40', classes: 5, properties: 20, individuals: 40, assertions: true, ceilingMs: GRID_CEILING_MS },
  { name: 'asserted-datatype-p20i40', classes: 5, properties: 20, individuals: 40, kind: 'datatype', assertions: true, ceilingMs: GRID_CEILING_MS },
  // The bug report's issue 2: a data package of about 100,000 axioms, over the default 16 MiB request ceiling.
  { name: 'data-100k', classes: 5, properties: 10, individuals: 33_334, assertions: true, ceilingMs: 30_000 },
  // Inference-heavy: a 10-class chain and 11,000 individuals give 99,036 inferred statements, an answer about 8.7 times
  // the request (the A-S8 review).
  { name: 'chain-c10i11000', classes: 10, properties: 0, individuals: 11_000, chain: true, ceilingMs: 30_000 },
];

/**
 * The timing shapes the 0.1 engine decides within 120 s on the reference host (A-S6 before
 * numbers), plus rich shapes that exercise every V1 rule. The differential qualification runs them
 * through both engines and requires the same answers.
 */
export const DIFFERENTIAL_SHAPES: ReadonlyArray<TimingShape> = [
  ...TIMING_SHAPES.filter((shape) =>
    ['p20i0', 'p40i0', 'p80i0', 'p0i1000', 'p0i3000', 'p10i10', 'p15i15', 'p10i20', 'p20i20-domain', 'p20i20-range', 'iptc-28x157x0'].includes(shape.name),
  ),
  // The 0.1 engine needs over 300 s for a rich shape with 8 classes, 6 properties and 8 individuals.
  { name: 'rich-c4p1i2', classes: 4, properties: 1, individuals: 2, assertions: true, rich: true, ceilingMs: GRID_CEILING_MS },
  { name: 'rich-c4p2i3', classes: 4, properties: 2, individuals: 3, assertions: true, rich: true, ceilingMs: GRID_CEILING_MS },
  { name: 'rich-c5p2i4', classes: 5, properties: 2, individuals: 4, assertions: true, rich: true, ceilingMs: GRID_CEILING_MS },
  { name: 'rich-c6p3i6', classes: 6, properties: 3, individuals: 6, assertions: true, rich: true, ceilingMs: GRID_CEILING_MS },
];

const ONTO = 'https://repro.example/onto';
const X = `${ONTO}#`;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const SOURCE_DIGEST = `sha256:${'5'.repeat(64)}` as const;
const SOURCE_ID = 'root:ontology:0000';

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function stringLiteral(lexicalForm: string) {
  return { datatype: XSD_STRING, kind: 'Literal' as const, language: null, lexicalForm };
}

function named(index: number) {
  return { iri: `${X}C${String(index)}`, kind: 'NamedClass' };
}

/** The extra axioms of a rich shape (see `TimingShape.rich`); classes 1 and up form a binary tree under `C0`. */
function richBodies(shape: TimingShape): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  for (let c = 1; c < shape.classes; c += 1) {
    bodies.push({ kind: 'SubClassOf', subClass: named(c), superClass: named(Math.floor((c - 1) / 2)) });
  }
  bodies.push({ entityKind: 'Class', iri: `${X}Same`, kind: 'Declaration' });
  bodies.push({ classes: [named(1), { iri: `${X}Same`, kind: 'NamedClass' }], kind: 'EquivalentClasses' });
  bodies.push({ entityKind: 'Class', iri: `${X}Apart`, kind: 'Declaration' });
  bodies.push({ classes: [{ iri: `${X}Apart`, kind: 'NamedClass' }, named(shape.classes - 1)], kind: 'DisjointClasses' });
  const inverse = `${X}inverse`;
  const transitive = `${X}partOf`;
  const unionDomain = `${X}either`;
  const amount = `${X}amount`;
  for (const property of [inverse, transitive, unionDomain]) {
    bodies.push({ entityKind: 'ObjectProperty', iri: property, kind: 'Declaration' });
  }
  bodies.push({ entityKind: 'DataProperty', iri: amount, kind: 'Declaration' });
  bodies.push({ kind: 'InverseObjectProperties', left: `${X}p0`, right: inverse });
  bodies.push({ kind: 'TransitiveObjectProperty', property: transitive });
  const operands = [`${X}C${String(shape.classes - 2)}`, `${X}C${String(shape.classes - 1)}`].sort();
  bodies.push({ domain: { kind: 'ObjectUnionOf', operands }, kind: 'PropertyDomain', property: unionDomain, propertyKind: 'ObjectProperty' });
  bodies.push({ kind: 'PropertyRange', property: amount, propertyKind: 'DataProperty', range: XSD_INTEGER });
  bodies.push({ domain: named(1), kind: 'PropertyDomain', property: amount, propertyKind: 'DataProperty' });
  for (let i = 0; i < shape.individuals; i += 1) {
    const individual = `${X}i${String(i)}`;
    const next = `${X}i${String((i + 1) % shape.individuals)}`;
    bodies.push({ kind: 'ObjectPropertyAssertion', object: next, property: transitive, subject: individual });
    bodies.push({ kind: 'ObjectPropertyAssertion', object: next, property: unionDomain, subject: individual });
    bodies.push({ kind: 'DataPropertyAssertion', property: amount, subject: individual, value: { datatype: XSD_INTEGER, kind: 'Literal', language: null, lexicalForm: String(i % 3) } });
  }
  return bodies;
}

/** The protocol axioms the normalizer emits for one `gen.mjs` ontology, with content-derived identifiers. */
export function timingAxioms(shape: TimingShape): ReadonlyArray<Axiom> {
  const axes = shape.axes ?? 'both';
  const kind = shape.kind ?? 'object';
  const bodies: Array<Record<string, unknown>> = [];
  const label = (subject: string, text: string) =>
    bodies.push({ kind: 'AnnotationAssertion', property: RDFS_LABEL, subject, value: stringLiteral(text) });
  bodies.push({ entityKind: 'Ontology', iri: ONTO, kind: 'Declaration' });
  label(ONTO, 'repro');
  for (let c = 0; c < shape.classes; c += 1) {
    bodies.push({ entityKind: 'Class', iri: `${X}C${String(c)}`, kind: 'Declaration' });
    label(`${X}C${String(c)}`, `C${String(c)}`);
    if (shape.chain === true && c > 0) bodies.push({ kind: 'SubClassOf', subClass: named(c - 1), superClass: named(c) });
  }
  const propertyKind = kind === 'datatype' ? 'DataProperty' : 'ObjectProperty';
  for (let p = 0; p < shape.properties; p += 1) {
    const property = `${X}p${String(p)}`;
    bodies.push({ entityKind: propertyKind, iri: property, kind: 'Declaration' });
    label(property, `p${String(p)}`);
    if (axes !== 'range') {
      bodies.push({ domain: { iri: `${X}C${String(p % shape.classes)}`, kind: 'NamedClass' }, kind: 'PropertyDomain', property, propertyKind });
    }
    if (axes !== 'domain') {
      bodies.push({ kind: 'PropertyRange', property, propertyKind, range: kind === 'datatype' ? XSD_STRING : `${X}C${String((p + 1) % shape.classes)}` });
    }
  }
  for (let i = 0; i < shape.individuals; i += 1) {
    const individual = `${X}i${String(i)}`;
    bodies.push({ classExpression: { iri: `${X}C0`, kind: 'NamedClass' }, individual, kind: 'ClassAssertion' });
    label(individual, `i${String(i)}`);
    if (shape.assertions === true && shape.properties > 0) {
      const property = `${X}p${String(i % shape.properties)}`;
      bodies.push(kind === 'datatype'
        ? { kind: 'DataPropertyAssertion', property, subject: individual, value: stringLiteral(`v${String(i)}`) }
        : { kind: 'ObjectPropertyAssertion', object: `${X}i${String((i + 1) % shape.individuals)}`, property, subject: individual });
    }
  }
  if (shape.rich === true) bodies.push(...richBodies(shape));
  return bodies.map((body) => {
    const id = `axiom:${sha256(JSON.stringify(body))}`;
    return {
      ...body,
      graph: { kind: 'DefaultGraph' },
      id,
      provenance: { locator: `erden-source:${SOURCE_ID}#${id}`, sourceDigest: SOURCE_DIGEST, sourceId: SOURCE_ID, status: 'available' },
    } as unknown as Axiom;
  });
}

export function timingRequest(shape: TimingShape, tool: RequiredTool, maxWallTimeMs: number): ReasonerRequest {
  const draft: ReasonerRequest = normalizeReasonerRequest({
    kind: 'ReasonerRequest',
    limits: { maxInferences: 1_000_000, maxInputAxioms: 1_000_000, maxWallTimeMs },
    ontology: {
      axioms: [...timingAxioms(shape)],
      digest: `sha256:${'0'.repeat(64)}`,
      sources: [{ contentDigest: SOURCE_DIGEST, id: SOURCE_ID, kind: 'root', ontologyIri: ONTO }],
    },
    operation: 'classify-and-materialize',
    profile: { digest: REASONER_PROFILE_SHA256, id: REASONER_PROFILE_ID },
    protocolVersion: 1,
    requestId: `timing:${shape.name}`,
    requiredTool: tool,
  });
  return { ...draft, ontology: { ...draft.ontology, digest: computeReasonerInputDigest(draft) as `sha256:${string}` } };
}

export interface ReasonerRun {
  readonly response: ReasonerResponse;
  readonly wallMs: number;
  readonly phases: Readonly<Record<string, number>>;
  readonly requestBytes: number;
  readonly responseBytes: number;
}

const PHASE_LINE = /^erden-reasoner phase (\S+) ([0-9.]+) ms$/u;

function parsePhases(stderr: string): Readonly<Record<string, number>> {
  const phases: Record<string, number> = {};
  for (const line of stderr.split('\n')) {
    const match = PHASE_LINE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      phases[match[1]] = (phases[match[1]] ?? 0) + Number(match[2]);
    }
  }
  return phases;
}

export function runReasoner(binary: string, request: ReasonerRequest): ReasonerRun {
  const wire = encodeReasonerRequestJson(request);
  const started = performance.now();
  const child = spawnSync(binary, [], {
    encoding: 'utf8',
    input: wire,
    maxBuffer: 256 * 1024 * 1024,
    timeout: request.limits.maxWallTimeMs + 10_000,
    windowsHide: true,
  });
  const wallMs = performance.now() - started;
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(`reasoner failed (${String(child.status)}): ${child.error?.message ?? child.stderr}`);
  }
  return {
    response: decodeReleaseResponse(child.stdout),
    wallMs,
    phases: parsePhases(child.stderr),
    requestBytes: Buffer.byteLength(wire),
    responseBytes: Buffer.byteLength(child.stdout),
  };
}

/**
 * A canonical answer from any release. One whose certificate names another proof checker (0.1.0 answers name
 * `erden-proof-checker-v1`) is checked against the schema with the current checker's identity in its place, and
 * returned as it was.
 */
export function decodeReleaseResponse(output: string): ReasonerResponse {
  const parsed: unknown = JSON.parse(output);
  const certificate = (parsed as { result?: { certificate?: { proofCheckerId?: unknown } } }).result?.certificate;
  if (certificate === undefined || certificate.proofCheckerId === ERDEN_PROOF_CHECKER_ID) {
    return assertCanonicalReasonerResponseJson(output);
  }
  const response = parsed as ReasonerResponse & { result: { certificate: Record<string, unknown> } };
  assertCanonicalReasonerResponseJson(
    stringifyCanonicalJson({
      ...response,
      result: {
        ...response.result,
        certificate: { ...certificate, proofCheckerDigest: ERDEN_PROOF_CHECKER_SHA256, proofCheckerId: ERDEN_PROOF_CHECKER_ID },
      },
    } as unknown as JsonValue),
  );
  if (stringifyCanonicalJson(parsed as JsonValue) !== output) {
    throw new TypeError('Reasoner response is valid JSON but is not in canonical wire order');
  }
  return response;
}

/** The binary's own identity, read from the incompatibility response to a placeholder tool. */
export function probeTool(binary: string): RequiredTool {
  const placeholder: RequiredTool = {
    adapterDigest: `sha256:${'0'.repeat(64)}`,
    calculusDigest: `sha256:${'0'.repeat(64)}`,
    executableDigest: `sha256:${'0'.repeat(64)}`,
    name: 'erden-reasoner',
    version: '0',
  };
  const request = timingRequest({ name: 'probe', classes: 1, properties: 0, individuals: 0, ceilingMs: 0 }, placeholder, 10_000);
  return runReasoner(binary, request).response.tool;
}

export function outcomeOf(response: ReasonerResponse): string {
  const result = response.result;
  if (result.outcome === 'decided') return `decided ${result.consistency}`;
  if (result.outcome === 'refused') return `refused ${result.reason} (${result.diagnostics.map((item) => item.code).join(', ')})`;
  return `incompatible ${result.reason}`;
}

/** The same as `runReasoner`, without blocking, so independent cases can run at the same time. */
export function runReasonerAsync(binary: string, request: ReasonerRequest): Promise<ReasonerRun> {
  const wire = encodeReasonerRequestJson(request);
  const started = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        reject(new Error(`reasoner failed (${String(code)}): ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      try {
        resolvePromise({
          response: decodeReleaseResponse(output),
          wallMs: performance.now() - started,
          phases: parsePhases(Buffer.concat(stderr).toString('utf8')),
          requestBytes: Buffer.byteLength(wire),
          responseBytes: Buffer.byteLength(output),
        });
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    child.stdin.end(wire);
  });
}

