import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

import {
  assertCanonicalReasonerRequestJson,
  computeReasonerInputDigest,
  encodeReasonerRequestJson,
  REASONER_PROFILE_ID,
  REASONER_PROFILE_SHA256,
} from '../protocol/src/index.js';
import { REASONER_TOOL } from '../distribution/src/index.js';
import type { ReasonerRequest, RequiredTool } from '../protocol/src/index.js';
import { PLACEHOLDER_EXECUTABLE_DIGEST } from './determinism.mjs';
import { DIFFERENTIAL_SHAPES, TIMING_SHAPES, timingRequest } from './timing-shapes.js';
import type { TimingShape } from './timing-shapes.js';

// The request set of the cross-platform determinism check (`.github/workflows/reasoner-build.yml`). Every platform
// answers the same requests; `determinism.mjs compare` requires the answers to be byte-identical apart from the
// executable digest. The set covers the engine's paths:
//
// - every protocol known answer (consistent, inconsistent, unsatisfiable classes, unsupported constructs and the
//   PurRDF known-divergence refusals);
// - the timing gate's generated shapes, up to the 100,000-axiom data shape and the inference-heavy chain;
// - the differential qualification's rich shapes, which exercise every other V1 rule;
// - requests captured from the real check service: the complete SKOS and PROV-O mirrors checked in report mode
//   (out-of-profile statements left out of the request), plus, where `determinism/private/captured.json` exists, the
//   further captures it lists;
// - deterministic refusals derived from those: the input-axiom and inference limits, a tool-version and an
//   input-digest incompatibility.
//
// Every request names the shipped tool identity with a placeholder executable digest, which the runner replaces with
// the digest of the binary it runs; that field is not part of the input digest. The wall-time budget is 300 s
// everywhere, so only a deterministic limit can refuse.

export type DeterminismGroup = 'known-answer' | 'timing-shape' | 'differential-shape' | 'captured' | 'derived';

export interface DeterminismCase {
  /** Unique, path-like: `<group>/<name>`. */
  readonly name: string;
  readonly group: DeterminismGroup;
  /** What the case exercises, in a few words. */
  readonly covers: string;
  /** The answer label `answerLabel` must produce on every platform. */
  readonly expected: string;
  /** Whether the request is large enough (tens of MB) to leave out of the always-on unit test. */
  readonly heavy: boolean;
  /** The canonical request wire (LF-terminated), with the placeholder executable digest. */
  readonly build: () => string;
}

export const DETERMINISM_WALL_TIME_MS = 300_000;

const qualification = import.meta.dirname;
const reasoner = join(qualification, '..');
const knownAnswerDirectory = join(reasoner, 'protocol/fixtures/known-answer');
const capturedDirectory = join(qualification, 'determinism/captured');
const privateDirectory = join(qualification, 'determinism/private');

/** The tool the resolver ships (`REASONER_TOOL`), with the placeholder executable digest. */
export function placeholderTool(): RequiredTool {
  return {
    adapterDigest: REASONER_TOOL.adapterDigest as RequiredTool['adapterDigest'],
    calculusDigest: REASONER_TOOL.calculusDigest as RequiredTool['calculusDigest'],
    executableDigest: PLACEHOLDER_EXECUTABLE_DIGEST as RequiredTool['executableDigest'],
    name: REASONER_TOOL.name,
    version: REASONER_TOOL.version,
  };
}

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A request with the given tool and the uniform wall-time budget; other limits as given. */
function retarget(
  request: ReasonerRequest,
  tool: RequiredTool,
  limits: Partial<ReasonerRequest['limits']> = {},
): ReasonerRequest {
  return {
    ...request,
    limits: { ...request.limits, maxWallTimeMs: DETERMINISM_WALL_TIME_MS, ...limits },
    requiredTool: tool,
  };
}

function knownAnswerRequest(scenario: string): ReasonerRequest {
  return assertCanonicalReasonerRequestJson(readFileSync(join(knownAnswerDirectory, `${scenario}.request.json`), 'utf8'));
}

interface CapturedRecord {
  readonly bytes: number;
  readonly sha256: string;
  readonly outsideProfile: 'refuse' | 'report';
  /** Set by private captures, which say what they cover themselves. */
  readonly covers?: string;
}

function readCaptured(directory: string, manifest: string): Record<string, CapturedRecord & { directory: string }> {
  const { requests } = JSON.parse(readFileSync(manifest, 'utf8')) as { requests: Record<string, CapturedRecord> };
  return Object.fromEntries(Object.entries(requests).map(([name, record]) => [name, { ...record, directory }]));
}

/** The open captures, then the private ones where the private manifest exists (never in the open tree). */
export function capturedRecords(): Readonly<Record<string, CapturedRecord & { directory: string }>> {
  const privateManifest = join(privateDirectory, 'captured.json');
  return {
    ...readCaptured(capturedDirectory, join(qualification, 'determinism/captured.json')),
    ...(existsSync(privateManifest) ? readCaptured(privateDirectory, privateManifest) : {}),
  };
}

/** The V1 profile reference the captured requests were recorded under (2026-10-10, before profile V2). */
const CAPTURED_PROFILE = { id: 'erden-required-constructs-v1', digest: 'sha256:0bc7dec03b01761e9762f4bc8d44b23c2f8288228cd8913d791771536bf179e5' };

/**
 * A captured request, refused unless its bytes are the recorded ones and it is a canonical request. Its V1 profile
 * reference moves to the current profile: V1 axioms are V2 axioms, and the input digest does not cover the profile.
 */
export function capturedRequest(name: string): ReasonerRequest {
  const record = capturedRecords()[name];
  if (record === undefined) throw new Error(`No captured request ${name}`);
  const bytes = brotliDecompressSync(readFileSync(join(record.directory, `${name}.request.json.br`)));
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`Captured request ${name} is not the recorded ${record.sha256}`);
  }
  const recorded = JSON.parse(bytes.toString('utf8')) as { profile: { id: string; digest: string } };
  if (recorded.profile.id !== CAPTURED_PROFILE.id || recorded.profile.digest !== CAPTURED_PROFILE.digest) {
    throw new Error(`Captured request ${name} does not name the recorded V1 profile`);
  }
  const request = assertCanonicalReasonerRequestJson(
    `${JSON.stringify({ ...recorded, profile: { digest: REASONER_PROFILE_SHA256, id: REASONER_PROFILE_ID } })}\n`,
  );
  if (computeReasonerInputDigest(request) !== request.ontology.digest) {
    throw new Error(`Captured request ${name} does not carry its own input digest`);
  }
  return request;
}

function knownAnswerCases(tool: RequiredTool): DeterminismCase[] {
  const { scenarios } = JSON.parse(readFileSync(join(knownAnswerDirectory, 'manifest.json'), 'utf8')) as {
    scenarios: string[];
  };
  const expected: Record<string, string> = {
    inconsistency: 'decided inconsistent',
    'unsatisfiable-classes': 'decided consistent, 1 unsatisfiable class',
    'unsupported-constructs':
      'refused unsupported-construct (missing-provenance, named-graph, unknown-reserved-term, unsupported-import, unsupported-opaque-axiom)',
    'pur-rdf-bottom-data-property': 'refused bottom-property (bottom-data-property-known-divergence)',
    'pur-rdf-bottom-object-property': 'refused bottom-property (bottom-object-property-known-divergence)',
    'pur-rdf-cyclic-expression': 'refused cyclic-expression (cyclic-expression-known-divergence)',
    'pur-rdf-thing-nothing-empty-domain': 'refused known-divergence (thing-nothing-empty-domain-known-divergence)',
  };
  return scenarios.map((scenario) => ({
    name: `known-answer/${scenario}`,
    group: 'known-answer',
    covers: `protocol known answer ${scenario}`,
    expected: expected[scenario] ?? 'decided consistent',
    heavy: false,
    build: () => encodeReasonerRequestJson(retarget(knownAnswerRequest(scenario), tool)),
  }));
}

function shapeCase(group: 'timing-shape' | 'differential-shape', shape: TimingShape, tool: RequiredTool): DeterminismCase {
  return {
    name: `${group}/${shape.name}`,
    group,
    covers:
      group === 'timing-shape'
        ? `generated timing shape: ${String(shape.classes)} classes, ${String(shape.properties)} properties, ${String(shape.individuals)} individuals`
        : 'generated shape exercising every V1 rule',
    expected: 'decided consistent',
    heavy: shape.individuals >= 10_000,
    build: () => encodeReasonerRequestJson(timingRequest(shape, tool, DETERMINISM_WALL_TIME_MS)),
  };
}

function capturedCases(tool: RequiredTool): DeterminismCase[] {
  return Object.entries(capturedRecords()).map(([name, record]) => ({
    name: `captured/${name}`,
    group: 'captured',
    covers: record.covers ?? `complete ${name.replace('-complete', '').toUpperCase()} mirror, checked in report mode`,
    expected: 'decided consistent',
    heavy: false,
    build: () => encodeReasonerRequestJson(retarget(capturedRequest(name), tool)),
  }));
}

function shape(name: string): TimingShape {
  const found = TIMING_SHAPES.find((item) => item.name === name);
  if (found === undefined) throw new Error(`No timing shape ${name}`);
  return found;
}

function derivedCases(tool: RequiredTool): DeterminismCase[] {
  const withId = (request: ReasonerRequest, requestId: string): ReasonerRequest => ({ ...request, requestId });
  return [
    {
      name: 'derived/max-input-axioms',
      group: 'derived',
      covers: 'input axiom limit below the request size',
      expected: 'refused budget-exhausted (max-input-axioms)',
      heavy: false,
      build: () =>
        encodeReasonerRequestJson(
          withId(
            retarget(timingRequest(shape('p20i20'), tool, DETERMINISM_WALL_TIME_MS), tool, { maxInputAxioms: 10 }),
            'determinism:max-input-axioms',
          ),
        ),
    },
    {
      name: 'derived/max-inferences',
      group: 'derived',
      covers: 'inference limit reached during the closure',
      expected: 'refused budget-exhausted (max-inferences)',
      heavy: false,
      build: () => {
        const chain: TimingShape = { name: 'chain-c10i100', classes: 10, properties: 0, individuals: 100, chain: true, ceilingMs: 0 };
        return encodeReasonerRequestJson(
          withId(
            retarget(timingRequest(chain, tool, DETERMINISM_WALL_TIME_MS), tool, { maxInferences: 100 }),
            'determinism:max-inferences',
          ),
        );
      },
    },
    {
      name: 'derived/tool-version',
      group: 'derived',
      covers: 'request for another tool version',
      expected: 'incompatible tool-version',
      heavy: false,
      build: () =>
        encodeReasonerRequestJson(
          withId(
            retarget(knownAnswerRequest('subclass-type'), { ...tool, version: '0.1.0+purrdf.0.12.0.dfb1df7' }),
            'determinism:tool-version',
          ),
        ),
    },
    {
      name: 'derived/input-digest',
      group: 'derived',
      covers: 'request whose input digest does not match its axioms',
      expected: 'incompatible input-digest',
      heavy: false,
      build: () => {
        const request = retarget(knownAnswerRequest('subclass-type'), tool);
        return encodeReasonerRequestJson(
          withId(
            { ...request, ontology: { ...request.ontology, digest: `sha256:${'1'.repeat(64)}` } },
            'determinism:input-digest',
          ),
        );
      },
    },
  ];
}

/** The whole set, in a fixed order. */
export function determinismCases(tool: RequiredTool = placeholderTool()): ReadonlyArray<DeterminismCase> {
  const cases = [
    ...knownAnswerCases(tool),
    ...TIMING_SHAPES.map((item) => shapeCase('timing-shape', item, tool)),
    ...DIFFERENTIAL_SHAPES.filter((item) => item.rich === true).map((item) =>
      shapeCase('differential-shape', item, tool),
    ),
    ...capturedCases(tool),
    ...derivedCases(tool),
  ];
  if (new Set(cases.map((item) => item.name)).size !== cases.length) throw new Error('Duplicate determinism case');
  return cases;
}

/** The file name a case is written to: its position and name, filesystem-safe on every runner. */
export function caseFileName(index: number, name: string): string {
  return `${String(index + 1).padStart(3, '0')}-${name.replace('/', '--')}.request.json`;
}

/** Captured fixtures on disk (open and, where present, private), so a test can require that every one is in the set. */
export function capturedFixtureNames(): string[] {
  return [capturedDirectory, ...(existsSync(privateDirectory) ? [privateDirectory] : [])]
    .flatMap((directory) => readdirSync(directory))
    .filter((item) => item.endsWith('.request.json.br'))
    .map((item) => item.replace('.request.json.br', ''))
    .sort();
}

/** Writes every request and `manifest.json` (what `determinism.mjs run` reads) to `out`; returns the manifest. */
export function writeDeterminismRequests(out: string): unknown {
  mkdirSync(out, { recursive: true });
  const tool = placeholderTool();
  const cases = determinismCases(tool).map((item, index) => {
    const wire = item.build();
    const file = caseFileName(index, item.name);
    writeFileSync(join(out, file), wire);
    return {
      name: item.name,
      group: item.group,
      covers: item.covers,
      expected: item.expected,
      file,
      bytes: Buffer.byteLength(wire),
      sha256: sha256(wire),
    };
  });
  const manifest = {
    schema: 'erden.reasoner-determinism-requests/v1',
    placeholderExecutableDigest: PLACEHOLDER_EXECUTABLE_DIGEST,
    wallTimeMs: DETERMINISM_WALL_TIME_MS,
    tool,
    cases,
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
