// The cross-platform determinism check for the bundled reasoner. Dependency-free, so every build runner can use it
// with Node alone:
//
//   node reasoner/qualification/determinism.mjs run --binary <path> --record <target>.json --requests <dir> --out <dir>
//   node reasoner/qualification/determinism.mjs compare --requests <dir> --answers <dir> --out <dir>
//
// `run` answers every request of the set (written by `pnpm run determinism:requests`) twice with one freshly built
// binary, after checking the binary is the one its reproducibility record names. Both runs must exit 0 with nothing
// on stderr and the same stdout. `compare` normalizes every answer and requires all platforms to agree byte for byte,
// and every answer to have the outcome the set expects of it.
//
// Normalization excludes exactly one response field:
//
//   tool.executableDigest  The reasoner fills it in at run time with the SHA-256 of its own executable file
//                          (`actual_tool()` hashes `current_exe()`). Each platform runs a different executable, so
//                          this field differs by construction and says nothing about the answer. It is replaced only
//                          where the canonical response puts it (inside the trailing `tool` object) and only when it
//                          equals the digest the runner computed for the binary, so the exclusion cannot hide any
//                          other difference.
//
// Everything else is compared as bytes, including inputDigest, the certificate and justification digests, and the
// rest of `tool` (name, version, adapterDigest, calculusDigest). On the request side, `requiredTool.executableDigest`
// is set to each binary's own digest (otherwise the reasoner answers `incompatible executable-digest`); the input
// digest does not cover it, and `compare` checks every platform sent the set's bytes with only that field changed.
// Wall times are recorded but are not part of an answer.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const PLACEHOLDER_EXECUTABLE_DIGEST = `sha256:${'0'.repeat(64)}`;
export const EXCLUDED_MARKER = 'sha256:<excluded:own-executable-digest>';
export const DETERMINISM_TARGETS = Object.freeze([
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'aarch64-apple-darwin',
]);
const REFERENCE_TARGET = 'x86_64-unknown-linux-gnu';
const REQUESTS_SCHEMA = 'erden.reasoner-determinism-requests/v1';
const ANSWERS_SCHEMA = 'erden.reasoner-determinism-answers/v1';
const COMPARISON_SCHEMA = 'erden.reasoner-determinism-comparison/v1';

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The request as one platform sends it: the set's bytes with the placeholder executable digest replaced. */
export function bindRequest(wire, executableDigest) {
  const placeholder = `"executableDigest":"${PLACEHOLDER_EXECUTABLE_DIGEST}"`;
  const tool = wire.lastIndexOf('"requiredTool":{');
  const at = wire.indexOf(placeholder);
  if (tool < 0 || at < tool || wire.indexOf(placeholder, at + 1) >= 0) {
    throw new Error('A determinism request must carry the placeholder executable digest once, in requiredTool');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(executableDigest)) throw new Error(`Not a digest: ${executableDigest}`);
  return `${wire.slice(0, at)}"executableDigest":"${executableDigest}"${wire.slice(at + placeholder.length)}`;
}

// A canonical response ends with its `tool` object, whose keys are sorted.
const TOOL_SUFFIX =
  /,"tool":\{"adapterDigest":"sha256:[0-9a-f]{64}","calculusDigest":"sha256:[0-9a-f]{64}","executableDigest":"(sha256:[0-9a-f]{64})","name":"[^"\\]*","version":"[^"\\]*"\}\}\n$/u;

/** The answer with `tool.executableDigest` replaced by a marker; refuses one that does not name `executableDigest`. */
export function normalizeAnswer(answer, executableDigest) {
  const text = Buffer.isBuffer(answer) ? answer.toString('utf8') : answer;
  const match = TOOL_SUFFIX.exec(text);
  if (match === null) throw new Error('The answer does not end with a canonical tool object');
  if (match[1] !== executableDigest) {
    throw new Error(`The answer names executable ${match[1]}, not the binary that ran (${executableDigest})`);
  }
  const at = match.index + match[0].indexOf(match[1]);
  return Buffer.from(`${text.slice(0, at)}${EXCLUDED_MARKER}${text.slice(at + match[1].length)}`, 'utf8');
}

/** A short, comparable description of an answer's outcome. */
export function answerLabel(answer) {
  const { result } = JSON.parse(Buffer.isBuffer(answer) ? answer.toString('utf8') : answer);
  if (result.outcome === 'decided') {
    const unsatisfiable = result.unsatisfiableClasses.length;
    const suffix = unsatisfiable === 0 ? '' : `, ${unsatisfiable} unsatisfiable class${unsatisfiable === 1 ? '' : 'es'}`;
    return `decided ${result.consistency}${suffix}`;
  }
  if (result.outcome === 'refused') {
    const codes = [...new Set(result.diagnostics.map((item) => item.code))].sort();
    return `refused ${result.reason} (${codes.join(', ')})`;
  }
  return `${result.outcome} ${result.reason}`;
}

/** The first differing byte of two buffers, with some context from each, or undefined when they are equal. */
export function firstDifference(left, right, context = 160) {
  if (left.equals(right)) return undefined;
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset += 1;
  const window = (bytes) => bytes.subarray(Math.max(0, offset - context), offset + context).toString('utf8');
  return { offset, leftBytes: left.length, rightBytes: right.length, left: window(left), right: window(right) };
}

/** JSON paths whose values differ, up to `limit`. */
export function jsonDifferences(left, right, limit = 50) {
  const found = [];
  const visit = (a, b, path) => {
    if (found.length >= limit) return;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
      if (a !== b) found.push({ path, left: a, right: b });
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      found.push({ path, left: Array.isArray(a) ? 'array' : 'object', right: Array.isArray(b) ? 'array' : 'object' });
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      visit(a[key], b[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`);
    }
  };
  visit(JSON.parse(left.toString('utf8')), JSON.parse(right.toString('utf8')), '$');
  return found;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function responseFileName(requestFile) {
  return requestFile.replace(/\.request\.json$/u, '.response.json');
}

/** Reads the request set's manifest and checks every request file against it. */
function readRequestSet(directory) {
  const manifest = readJson(join(directory, 'manifest.json'));
  if (manifest.schema !== REQUESTS_SCHEMA || manifest.placeholderExecutableDigest !== PLACEHOLDER_EXECUTABLE_DIGEST) {
    throw new Error(`${directory}/manifest.json is not a determinism request set`);
  }
  const requests = manifest.cases.map((item) => {
    const bytes = readFileSync(join(directory, item.file));
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`${item.file} is not the recorded request`);
    return { ...item, wire: bytes.toString('utf8') };
  });
  return { manifest, manifestSha256: sha256(readFileSync(join(directory, 'manifest.json'))), requests };
}

function runOnce(binary, wire, timeoutMs) {
  const started = performance.now();
  const child = spawnSync(binary, [], {
    input: wire,
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    wallMs: Math.round(performance.now() - started),
    status: child.status,
    signal: child.signal,
    error: child.error?.message,
    stdout: child.stdout ?? Buffer.alloc(0),
    stderr: (child.stderr ?? Buffer.alloc(0)).toString('utf8'),
  };
}

/** `run`: answers the set twice with one binary and writes the raw answers and `answers.json`. */
function runCommand(values) {
  for (const option of ['binary', 'record', 'requests', 'out']) {
    if (values[option] === undefined) throw new Error(`run needs --${option}`);
  }
  const binary = resolve(values.binary);
  const record = readJson(values.record);
  const bytes = readFileSync(binary);
  const executableDigest = sha256(bytes);
  if (
    record.result !== 'byte-identical' ||
    record.runs?.length !== 2 ||
    record.runs.some((run) => run.sha256 !== executableDigest || run.bytes !== bytes.length)
  ) {
    throw new Error(`${binary} (${executableDigest}) is not the byte-identical build its record names`);
  }
  const { manifest, manifestSha256, requests } = readRequestSet(values.requests);
  const out = resolve(values.out);
  mkdirSync(join(out, 'responses'), { recursive: true });
  const cases = [];
  const problems = [];
  for (const request of requests) {
    const wire = bindRequest(request.wire, executableDigest);
    const timeoutMs = manifest.wallTimeMs + 60_000;
    const runs = [runOnce(binary, wire, timeoutMs), runOnce(binary, wire, timeoutMs)];
    const entry = {
      name: request.name,
      file: request.file,
      sentRequestSha256: sha256(wire),
      wallMs: runs.map((run) => run.wallMs),
    };
    const failed = runs.find((run) => run.status !== 0 || run.signal !== null || run.error !== undefined || run.stderr !== '');
    if (failed !== undefined) {
      entry.failure = { status: failed.status, signal: failed.signal, error: failed.error, stderr: failed.stderr.slice(0, 4000) };
      problems.push(`${request.name}: the binary failed (${failed.error ?? failed.signal ?? failed.status}) ${failed.stderr.slice(0, 200)}`);
    } else if (!runs[0].stdout.equals(runs[1].stdout)) {
      entry.runToRun = firstDifference(runs[0].stdout, runs[1].stdout);
      problems.push(`${request.name}: two runs on this platform answered differently`);
    }
    const answer = runs[0].stdout;
    writeFileSync(join(out, 'responses', responseFileName(request.file)), answer);
    entry.responseBytes = answer.length;
    entry.responseSha256 = sha256(answer);
    if (failed === undefined) {
      try {
        entry.label = answerLabel(answer);
      } catch (cause) {
        problems.push(`${request.name}: the answer is not JSON (${cause.message})`);
      }
    }
    cases.push(entry);
    process.stdout.write(`${request.name}: ${entry.label ?? 'FAILED'} (${entry.wallMs.join(' / ')} ms)\n`);
  }
  const answers = {
    schema: ANSWERS_SCHEMA,
    target: record.target,
    host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version },
    binary: { file: basename(binary), bytes: bytes.length, sha256: executableDigest },
    buildRecordSha256: sha256(readFileSync(values.record)),
    requestsManifestSha256: manifestSha256,
    problems,
    cases,
  };
  writeFileSync(join(out, 'answers.json'), `${JSON.stringify(answers, null, 2)}\n`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  }
}

/** Compares the platforms' answers; returns the comparison record (`result` is `identical` or `different`). */
export function compareAnswerSets(requestsDirectory, answersDirectory, targets = DETERMINISM_TARGETS) {
  const { manifest, manifestSha256, requests } = readRequestSet(requestsDirectory);
  const problems = [];
  const platforms = {};
  for (const target of targets) {
    let answers;
    try {
      answers = readJson(join(answersDirectory, target, 'answers.json'));
    } catch {
      problems.push(`${target}: no answers`);
      continue;
    }
    if (answers.schema !== ANSWERS_SCHEMA || answers.target !== target) problems.push(`${target}: answers.json is not for ${target}`);
    if (answers.requestsManifestSha256 !== manifestSha256) problems.push(`${target}: answered another request set`);
    for (const problem of answers.problems ?? []) problems.push(`${target}: ${problem}`);
    platforms[target] = answers;
  }
  const cases = [];
  for (const request of requests) {
    const row = { name: request.name, covers: request.covers, expected: request.expected, answers: {} };
    const normalized = {};
    for (const [target, answers] of Object.entries(platforms)) {
      const entry = answers.cases.find((item) => item.name === request.name);
      if (entry === undefined) {
        problems.push(`${target}: no answer to ${request.name}`);
        continue;
      }
      const digest = answers.binary.sha256;
      if (entry.sentRequestSha256 !== sha256(bindRequest(request.wire, digest))) {
        problems.push(`${target}: ${request.name} was not the set's request`);
      }
      const raw = readFileSync(join(answersDirectory, target, 'responses', responseFileName(request.file)));
      if (sha256(raw) !== entry.responseSha256) problems.push(`${target}: ${request.name} answer file is not the recorded one`);
      let label;
      try {
        normalized[target] = normalizeAnswer(raw, digest);
        label = answerLabel(raw);
      } catch (cause) {
        problems.push(`${target}: ${request.name}: ${cause.message}`);
      }
      if (label !== request.expected) problems.push(`${target}: ${request.name} answered "${label}", expected "${request.expected}"`);
      row.answers[target] = {
        label,
        responseBytes: raw.length,
        responseSha256: sha256(raw),
        normalizedSha256: normalized[target] === undefined ? undefined : sha256(normalized[target]),
        wallMs: entry.wallMs,
      };
    }
    const reference = normalized[REFERENCE_TARGET] ?? Object.values(normalized)[0];
    row.differences = [];
    for (const [target, bytes] of Object.entries(normalized)) {
      if (reference === undefined || bytes.equals(reference)) continue;
      row.differences.push({
        target,
        against: normalized[REFERENCE_TARGET] === undefined ? Object.keys(normalized)[0] : REFERENCE_TARGET,
        firstDifference: firstDifference(reference, bytes),
        jsonDifferences: jsonDifferences(reference, bytes),
      });
      problems.push(`${request.name}: ${target} differs from the reference beyond the excluded field`);
    }
    row.identical = row.differences.length === 0 && Object.keys(normalized).length === targets.length;
    cases.push(row);
  }
  return {
    schema: COMPARISON_SCHEMA,
    result: problems.length === 0 ? 'identical' : 'different',
    excludedFields: [
      {
        field: 'tool.executableDigest',
        where: 'response, inside the trailing tool object',
        why: 'SHA-256 of the running executable file, computed by the reasoner at run time; it differs by construction between platforms and is checked to equal the digest of the binary that ran',
      },
    ],
    perPlatformRequestField: {
      field: 'requiredTool.executableDigest',
      why: 'set to each binary own digest so the reasoner does not answer incompatible; not covered by the input digest; every other request byte is the set',
    },
    referenceTarget: REFERENCE_TARGET,
    requestsManifestSha256: manifestSha256,
    requestCount: requests.length,
    wallTimeMs: manifest.wallTimeMs,
    platforms: Object.fromEntries(
      Object.entries(platforms).map(([target, answers]) => [target, { host: answers.host, binary: answers.binary }]),
    ),
    problems,
    cases,
  };
}

function summary(comparison, targets) {
  const lines = [
    `Reasoner determinism: ${comparison.result} (${comparison.requestCount} requests, ${targets.length} platforms)`,
    `Excluded: ${comparison.excludedFields.map((item) => item.field).join(', ')} (reference ${comparison.referenceTarget})`,
    '',
    ...targets.map((target) => {
      const item = comparison.platforms[target];
      return item === undefined
        ? `${target}: no answers`
        : `${target}: ${item.binary.sha256} (${item.binary.bytes} bytes) on ${item.host.platform} ${item.host.arch} ${item.host.release}, ${item.host.cpu}`;
    }),
    '',
    `| Case | Expected | Identical | Normalized SHA-256 (${comparison.referenceTarget}) | Wall ms (${targets.map((target) => target.split('-')[0]).join(' / ')}) |`,
    '| --- | --- | --- | --- | --- |',
    ...comparison.cases.map((row) => {
      const reference = row.answers[comparison.referenceTarget];
      const walls = targets.map((target) => row.answers[target]?.wallMs?.[0] ?? '-').join(' / ');
      return `| ${row.name} | ${row.expected} | ${row.identical ? 'yes' : 'NO'} | ${reference?.normalizedSha256 ?? '-'} | ${walls} |`;
    }),
    '',
    ...(comparison.problems.length === 0 ? ['No differences.'] : ['Problems:', ...comparison.problems.map((item) => `- ${item}`)]),
  ];
  return `${lines.join('\n')}\n`;
}

/** `compare`: writes `comparison.json` and `comparison.md`, and fails on any difference. */
function compareCommand(values) {
  for (const option of ['requests', 'answers', 'out']) {
    if (values[option] === undefined) throw new Error(`compare needs --${option}`);
  }
  const comparison = compareAnswerSets(values.requests, values.answers);
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  const text = summary(comparison, DETERMINISM_TARGETS);
  writeFileSync(join(out, 'comparison.md'), text);
  process.stdout.write(text);
  if (comparison.result !== 'identical') process.exitCode = 1;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      binary: { type: 'string' },
      record: { type: 'string' },
      requests: { type: 'string' },
      answers: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (positionals[0] === 'run' && positionals.length === 1) return runCommand(values);
  if (positionals[0] === 'compare' && positionals.length === 1) return compareCommand(values);
  throw new Error('Usage: determinism.mjs run|compare [options]');
}

if (import.meta.main) main();
