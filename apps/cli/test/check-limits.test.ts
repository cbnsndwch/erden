import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { CheckProjectOperationalError } from '@erden/contracts';
import {
    DEFAULT_REASONER_LIMITS,
    nodeDoctorService,
    nodeInitProjectService,
    nodePackProjectService,
    nodeProjectDependenciesService,
    nodeProjectPathService,
    nodeStoreMaintenanceService,
    nodeStorePathService,
    makeNodeInstallProjectService,
    unavailableDependencyRegistry,
    type CheckProjectOptions,
} from '@erden/project';

import { CLI_EXIT, runCli, type CliRuntime, type CliServices } from '../src/index.js';

function runtimeWith(environment: Readonly<Record<string, string | undefined>>) {
    const calls: CheckProjectOptions[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const services: CliServices = {
        check: {
            check: (options = {}) => {
                calls.push(options);
                return Effect.fail(
                    new CheckProjectOperationalError('CHECK_TEST_STOP', 'validation', 'stopped by the test'),
                );
            },
        },
        init: nodeInitProjectService,
        doctor: nodeDoctorService,
        install: makeNodeInstallProjectService(unavailableDependencyRegistry),
        dependencies: nodeProjectDependenciesService,
        path: nodeProjectPathService,
        pack: nodePackProjectService,
        storePath: nodeStorePathService,
        storeMaintenance: nodeStoreMaintenanceService,
    };
    const runtime: CliRuntime = {
        cwd: () => '/nonexistent/erden-cli-limits',
        stdout: {
            write: (text) => {
                stdout.push(text);
            },
        },
        stderr: {
            write: (text) => {
                stderr.push(text);
            },
        },
        services,
        environment: () => environment,
    };
    return { runtime, calls, stdout, stderr };
}

describe('erden check reasoner limits', () => {
    it('passes the documented defaults when no variable is set', async () => {
        const captured = runtimeWith({});
        expect(await runCli(['check'], captured.runtime)).toBe(CLI_EXIT.operational);
        expect(captured.calls).toHaveLength(1);
        expect(captured.calls[0]?.reasonerLimits).toEqual(DEFAULT_REASONER_LIMITS);
    });

    it('passes the values of the same variables the server reads', async () => {
        const captured = runtimeWith({
            ERDEN_REASONER_MAX_WALL_TIME_MS: '90000',
            ERDEN_REASONER_MAX_INPUT_AXIOMS: '200000',
            ERDEN_REASONER_MAX_INFERENCES: '300000',
            ERDEN_REASONER_MAX_REQUEST_BYTES: '67108864',
        });
        await runCli(['check', '--offline'], captured.runtime);
        expect(captured.calls[0]?.reasonerLimits).toEqual({
            maxWallTimeMs: 90_000,
            maxInputAxioms: 200_000,
            maxInferences: 300_000,
            maxRequestBytes: 67_108_864,
        });
    });

    it.each([
        ['ERDEN_REASONER_MAX_WALL_TIME_MS', '500'],
        ['ERDEN_REASONER_MAX_INPUT_AXIOMS', 'many'],
        ['ERDEN_REASONER_MAX_INFERENCES', '1000001'],
        ['ERDEN_REASONER_MAX_REQUEST_BYTES', '200000000'],
    ])('treats %s=%j as a usage error that names the variable', async (variable, value) => {
        const captured = runtimeWith({ [variable]: value });
        expect(await runCli(['check'], captured.runtime)).toBe(CLI_EXIT.usage);
        expect(captured.calls).toHaveLength(0);
        expect(captured.stderr.join('')).toContain(`Erden usage error: ${variable} must be a whole number`);
    });
});
