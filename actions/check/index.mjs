import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { annotate, checkReport, reportAnnotations, saveWorkflowResult } from './lib/reporting.mjs';
import { exactVersion, prepareRuntime } from './lib/runtime.mjs';

function booleanInput(value) {
    if (value !== 'true' && value !== 'false') {
        throw new Error('offline must be true or false');
    }
    return value === 'true';
}

function projectDirectory(workspace, input) {
    const directory = realpathSync(resolve(workspace, input));
    const path = relative(workspace, directory);
    if (
        isAbsolute(path) ||
        path === '..' ||
        path.startsWith('../') ||
        path.startsWith('..\\') ||
        !statSync(directory).isDirectory()
    ) {
        throw new Error('project must be a directory inside GITHUB_WORKSPACE');
    }
    return directory;
}

async function main() {
    const env = process.env;
    if (!env.GITHUB_WORKSPACE || !env.RUNNER_TEMP) {
        throw new Error('GITHUB_WORKSPACE and RUNNER_TEMP are required');
    }
    const reportsPath = mkdtempSync(join(realpathSync(env.RUNNER_TEMP), 'erden-check-'));
    const result = { outcome: 'error', phase: 'inputs', exitCode: 1, reportPath: '', reportsPath };
    let report;
    let runtime;
    try {
        const workspace = realpathSync(env.GITHUB_WORKSPACE);
        result.version = exactVersion(env.INPUT_VERSION ?? '');
        const offline = booleanInput(env.INPUT_OFFLINE ?? 'false');
        result.project = projectDirectory(workspace, env.INPUT_PROJECT || '.');
        result.phase = 'runtime';
        runtime = await prepareRuntime({
            root: env['INPUT_ERDEN-ROOT'],
            version: result.version,
            workspace,
            temporary: env.RUNNER_TEMP,
        });
        function execute(phase, args) {
            result.phase = phase;
            const child = spawnSync(runtime.node, [runtime.cli, ...args], {
                cwd: workspace,
                env,
                encoding: 'utf8',
                windowsHide: true,
                timeout: 300_000,
                maxBuffer: 64 * 1024 * 1024,
            });
            writeFileSync(join(reportsPath, `${phase}.stdout.txt`), child.stdout ?? '');
            writeFileSync(join(reportsPath, `${phase}.stderr.txt`), child.stderr ?? '');
            result.exitCode = child.status ?? 1;
            if (child.error || child.signal) {
                throw new Error(`Erden ${phase} could not complete: ${child.error?.message ?? child.signal}`);
            }
            return { stdout: child.stdout, code: child.status };
        }
        function requireSuccess(phase, args, schema, outcome) {
            const child = execute(phase, args);
            let document;
            try {
                document = JSON.parse(child.stdout);
            } catch (error) {
                if (child.code === 0) {
                    throw error;
                }
            }
            if (document?.schema === schema) {
                writeFileSync(join(reportsPath, `${phase}.json`), child.stdout);
            }
            if (child.code !== 0) {
                throw new Error(
                    `Erden ${phase} exited ${String(child.code)}; inspect ${phase}.stderr.txt and ${phase}.stdout.txt`,
                );
            }
            if (document?.schema !== schema || document.outcome !== outcome) {
                throw new Error(`Erden ${phase} did not return the expected ${schema} outcome`);
            }
        }
        const version = execute('version', ['--version']);
        if (version.code !== 0 || version.stdout.trim() !== result.version) {
            throw new Error(`The selected CLI must report version ${result.version}; inspect version.stdout.txt`);
        }
        requireSuccess('doctor', ['doctor', '--json'], 'erden.doctor-report/v1', 'passed');
        const mode = offline ? ['--offline'] : [];
        requireSuccess(
            'install',
            ['install', result.project, '--frozen-lockfile', ...mode, '--json'],
            'erden.install-report/v1',
            'installed',
        );
        const check = execute('check', ['check', result.project, ...mode, '--json']);
        if (check.code !== 0 && check.code !== 1) {
            throw new Error(`Erden check could not complete (exit ${String(check.code)}); inspect check.stderr.txt`);
        }
        report = checkReport(check.stdout, check.code);
        result.reportPath = join(reportsPath, 'check.json');
        writeFileSync(result.reportPath, check.stdout);
        reportAnnotations(report, result.project, workspace);
        result.outcome = report.outcome;
    } catch (error) {
        result.message = error.message;
        if (result.exitCode === 0) {
            result.exitCode = 1;
        }
        annotate('error', `Erden ${result.phase}: ${error.message}`);
    }
    if (runtime?.ownedDirectory) {
        rmSync(runtime.ownedDirectory, { recursive: true, force: true });
    }
    writeFileSync(join(reportsPath, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    saveWorkflowResult(env, result, report);
    process.exitCode = result.outcome === 'passed' ? 0 : 1;
}

try {
    await main();
} catch (error) {
    annotate('error', `Erden action: ${error.message}`);
    process.exitCode = 1;
}
