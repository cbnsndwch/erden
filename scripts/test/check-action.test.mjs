import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const entry = join(repository, 'actions/check/index.mjs');

function fixture(context, scenario = 'passed', inputs = {}) {
    const work = mkdtempSync(join(realpathSync(tmpdir()), 'erden-action-test-'));
    context.after(() => rmSync(work, { recursive: true, force: true }));
    const workspace = join(work, 'workspace');
    const project = join(workspace, 'project with spaces');
    const runtime = join(work, 'prepared runtime');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(runtime, 'node'), { recursive: true });
    mkdirSync(join(runtime, 'lib/dist'), { recursive: true });
    const executable = join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    if (process.platform === 'win32') {
        copyFileSync(process.execPath, executable);
    } else {
        symlinkSync(process.execPath, executable);
    }
    copyFileSync(join(repository, 'scripts/test/fixtures/check-action-cli.mjs'), join(runtime, 'lib/dist/bin.js'));
    writeFileSync(join(runtime, 'lib/package.json'), '{"type":"module"}\n');
    writeFileSync(join(project, 'erden.lock'), 'unchanged-lock\n');
    writeFileSync(join(project, 'erden.config.json'), '{}\n');
    const output = join(work, 'output');
    const summary = join(work, 'summary');
    const log = join(work, 'commands.jsonl');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const result = spawnSync(process.execPath, [entry], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: work,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INPUT_VERSION: '0.1.0',
            INPUT_PROJECT: 'project with spaces',
            INPUT_OFFLINE: 'true',
            'INPUT_ERDEN-ROOT': runtime,
            ERDEN_ACTION_FIXTURE_SCENARIO: scenario,
            ERDEN_ACTION_FIXTURE_LOG: log,
            ...inputs,
        },
    });
    const outputs = Object.fromEntries(
        readFileSync(output, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const commands = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    return { work, project, result, outputs, commands, summary: readFileSync(summary, 'utf8') };
}

test('validates a prepared runtime with frozen offline installation and publishes reports', (context) => {
    const run = fixture(context);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(run.commands, [
        ['--version'],
        ['doctor', '--json'],
        ['install', run.project, '--frozen-lockfile', '--offline', '--json'],
        ['check', run.project, '--offline', '--json'],
    ]);
    assert.equal(run.outputs.outcome, 'passed');
    assert.equal(run.outputs['exit-code'], '0');
    assert.equal(JSON.parse(readFileSync(run.outputs['report-path'], 'utf8')).outcome, 'passed');
    assert.equal(readFileSync(join(run.project, 'erden.lock'), 'utf8'), 'unchanged-lock\n');
    assert.match(run.summary, /shacl.*passed/u);
});

test('fails the action for invalid knowledge while retaining its check report', (context) => {
    const run = fixture(context, 'failed');
    assert.equal(run.result.status, 1);
    assert.equal(run.outputs.outcome, 'failed');
    assert.equal(run.outputs['exit-code'], '1');
    assert.equal(JSON.parse(readFileSync(run.outputs['report-path'], 'utf8')).outcome, 'failed');
    assert.match(run.result.stdout, /shacl-conformance/u);
    assert.match(run.summary, /failed/u);
});

test('distinguishes operational check failure from invalid knowledge and keeps diagnostics', (context) => {
    const run = fixture(context, 'runtime-error');
    assert.equal(run.result.status, 1);
    assert.equal(run.outputs.outcome, 'error');
    assert.equal(run.outputs['exit-code'], '3');
    assert.equal(run.outputs['report-path'], '');
    assert.match(
        readFileSync(join(run.outputs['reports-path'], 'check.stderr.txt'), 'utf8'),
        /CHECK_SHACL_ENGINE_UNAVAILABLE/u,
    );
    assert.doesNotMatch(run.result.stdout, /^::error::forged$/mu);
});

test('stops before checking when doctor or frozen install fails', (context) => {
    for (const [scenario, expected] of [
        ['engine-error', ['--version', 'doctor']],
        ['install-error', ['--version', 'doctor', 'install']],
    ]) {
        const run = fixture(context, scenario);
        assert.equal(run.result.status, 1);
        assert.equal(run.outputs.outcome, 'error');
        assert.deepEqual(
            run.commands.map((args) => args[0]),
            expected,
        );
    }
});

test('refuses a prepared runtime with a different version', (context) => {
    const run = fixture(context, 'wrong-version');
    assert.equal(run.result.status, 1);
    assert.equal(run.outputs.outcome, 'error');
    assert.equal(run.commands.length, 1);
});

test('refuses malformed reports and contradictory exit codes', (context) => {
    for (const scenario of ['malformed', 'contradiction']) {
        const run = fixture(context, scenario);
        assert.equal(run.result.status, 1);
        assert.equal(run.outputs.outcome, 'error');
    }
});

test('escapes untrusted diagnostic text in annotations and Markdown', (context) => {
    const run = fixture(context, 'failed');
    assert.doesNotMatch(run.result.stdout, /^::(?:notice|error)::forged$/mu);
    assert.match(run.result.stdout, /%0A::notice::forged/u);
    assert.doesNotMatch(run.summary, /<script>/u);
    assert.match(run.summary, /&lt;script&gt;/u);
});

test('online dependency restoration still freezes the lock', (context) => {
    const run = fixture(context, 'passed', { INPUT_OFFLINE: 'false' });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(run.commands[2], ['install', run.project, '--frozen-lockfile', '--json']);
    assert.deepEqual(run.commands[3], ['check', run.project, '--json']);
});

test('rejects non-exact versions and invalid booleans before invoking the runtime', (context) => {
    for (const inputs of [
        { INPUT_VERSION: 'latest' },
        { INPUT_VERSION: '^0.1.0' },
        { INPUT_VERSION: '0.1.0/../../main' },
        { INPUT_VERSION: '' },
        { INPUT_OFFLINE: 'yes' },
    ]) {
        const run = fixture(context, 'passed', inputs);
        assert.equal(run.result.status, 1);
        assert.equal(run.commands.length, 0);
        assert.equal(run.outputs.outcome, 'error');
    }
});

test('refuses a project outside the checkout', (context) => {
    const run = fixture(context, 'passed', { INPUT_PROJECT: '..' });
    assert.equal(run.result.status, 1);
    assert.equal(run.commands.length, 0);
    assert.equal(run.outputs.outcome, 'error');
});

test('downloads only an exact canonical release, checks its digest and extracts a usable runtime', async (context) => {
    const { prepareRuntime } = await import('../../actions/check/lib/runtime.mjs');
    const { createHash } = await import('node:crypto');
    const { gzipBytes, tarBytes, zipBytes } = await import('../../release/lib/archive.mjs');
    const work = mkdtempSync(join(realpathSync(tmpdir()), 'erden-action-download-'));
    context.after(() => rmSync(work, { recursive: true, force: true }));
    const platform = `${process.platform}-${process.arch}`;
    const base = `erden-0.1.0-${platform}`;
    const executable = process.platform === 'win32' ? 'node.exe' : 'node';
    const cliPath = join(work, 'fixture-bin.js');
    writeFileSync(cliPath, "console.log('0.1.0');\n");
    const entries = [
        { name: `${base}/node/${executable}`, directory: false, executable: true, path: process.execPath },
        { name: `${base}/lib/dist/bin.js`, directory: false, executable: false, path: cliPath },
    ];
    const archive = process.platform === 'win32' ? zipBytes(entries, 0) : gzipBytes(tarBytes(entries, 0));
    const name = `${base}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const digest = createHash('sha256').update(archive).digest('hex');
    const requests = [];
    async function fetchFixture(url) {
        requests.push(String(url));
        return new Response(String(url).endsWith('/SHA256SUMS') ? `${digest}  ${name}\n` : archive);
    }
    const runtime = await prepareRuntime({
        version: '0.1.0',
        workspace: work,
        temporary: work,
        fetchImpl: fetchFixture,
    });
    assert.deepEqual(requests, [
        `https://github.com/cbnsndwch/erden/releases/download/v0.1.0/SHA256SUMS`,
        `https://github.com/cbnsndwch/erden/releases/download/v0.1.0/${name}`,
    ]);
    const checked = spawnSync(runtime.node, [runtime.cli, '--version'], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.stdout.trim(), '0.1.0');
});

test('refuses a corrupt archive before extraction', async (context) => {
    const { prepareRuntime } = await import('../../actions/check/lib/runtime.mjs');
    const work = mkdtempSync(join(realpathSync(tmpdir()), 'erden-action-corrupt-'));
    context.after(() => rmSync(work, { recursive: true, force: true }));
    const name = `erden-0.1.0-${process.platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
    async function fetchFixture(url) {
        return new Response(
            String(url).endsWith('/SHA256SUMS') ? `${'0'.repeat(64)}  ${name}\n` : 'wrong archive bytes',
        );
    }
    await assert.rejects(
        prepareRuntime({ version: '0.1.0', workspace: work, temporary: work, fetchImpl: fetchFixture }),
        /SHA-256/u,
    );
    assert.equal(existsSync(join(work, 'runtime')), false);
});

test('reports an unavailable release without falling back to latest or a source build', async (context) => {
    const { prepareRuntime } = await import('../../actions/check/lib/runtime.mjs');
    const work = mkdtempSync(join(realpathSync(tmpdir()), 'erden-action-unavailable-'));
    context.after(() => rmSync(work, { recursive: true, force: true }));
    const requests = [];
    async function fetchFixture(url) {
        requests.push(String(url));
        return new Response('not found', { status: 404 });
    }
    await assert.rejects(
        prepareRuntime({ version: '0.1.0', workspace: work, temporary: work, fetchImpl: fetchFixture }),
        /404.*published.*erden-root/u,
    );
    assert.equal(requests.length, 1);
});

test('selects only the four published platform archive formats', async () => {
    const { releaseArchive, exactVersion } = await import('../../actions/check/lib/runtime.mjs');
    assert.equal(exactVersion('v0.1.0'), '0.1.0');
    for (const platform of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64']) {
        assert.equal(
            releaseArchive('0.1.0', platform),
            `erden-0.1.0-${platform}.${platform === 'win32-x64' ? 'zip' : 'tar.gz'}`,
        );
    }
    assert.throws(() => releaseArchive('0.1.0', 'darwin-x64'), /does not release/u);
    assert.throws(() => releaseArchive('0.1.0', 'win32-arm64'), /does not release/u);
});

test('requires exactly one checksum for the selected asset', async () => {
    const { verifyArchive } = await import('../../actions/check/lib/runtime.mjs');
    const { createHash } = await import('node:crypto');
    const bytes = Buffer.from('fixture');
    const name = 'erden-0.1.0-linux-x64.tar.gz';
    const sum = createHash('sha256').update(bytes).digest('hex');
    assert.throws(() => verifyArchive(`${sum}  other.tar.gz\n`, name, bytes), /exactly once/u);
    assert.throws(() => verifyArchive(`${sum}  ${name}\n${sum}  ${name}\n`, name, bytes), /exactly once/u);
    verifyArchive(`${sum}  ${name}\r\n`, name, bytes);
});

test('retains the structured doctor report when engines are unavailable', (context) => {
    const run = fixture(context, 'engine-error');
    const report = join(run.outputs['reports-path'], 'doctor.json');
    assert.equal(existsSync(report), true);
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).outcome, 'failed');
});

test('honors competency-question blocking policy rather than its raw match result', (context) => {
    const expected = fixture(context, 'expected-cq');
    assert.equal(expected.outputs.outcome, 'passed');
    assert.doesNotMatch(expected.result.stdout, /::error.*Competency question/u);
    const blocking = fixture(context, 'blocking-cq');
    assert.equal(blocking.outputs.outcome, 'failed');
    assert.match(blocking.result.stdout, /::error.*Competency question: Missing required question metadata/u);
});

test('keeps dependency SHACL diagnostics without inventing a checkout file location', (context) => {
    const run = fixture(context, 'dependency-shacl');
    assert.equal(run.outputs.outcome, 'failed');
    assert.match(run.result.stdout, /::error::SHACL: Required Supplier type/u);
    assert.doesNotMatch(run.result.stdout, /file=.*dependencies/u);
});
