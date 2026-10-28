import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { RegistryClientError } from '@erden/client';
import { CurrentToolchainError } from '@erden/contracts';
import {
    nodeCheckProjectService,
    nodeDoctorService,
    nodeInitProjectService,
    nodeProjectPathService,
    nodePackProjectService,
    nodeStoreMaintenanceService,
    nodeStorePathService,
    makeNodeInstallProjectService,
    nodeProjectDependenciesService,
    unavailableDependencyRegistry,
    decodeInstallProjectReport,
    decodeProjectDependenciesReport,
    decodeProjectDependencyUpdateReport,
    decodeProjectPathReport,
    decodeStorePruneReport,
    decodeStoreStatusReport,
    decodeStorePathReport,
    STORE_PRUNE_REACQUISITION_WARNING,
    InstallProjectUnavailableError,
    InitProjectError,
    PackProjectError,
    REASONER_SOURCE_BUILD_GUIDANCE,
    makeDoctorService,
    type CheckProjectOptions,
    type DoctorRuntimePort,
    type InstallProjectOptions,
    type AddProjectDependencyOptions,
    type RemoveProjectDependencyOptions,
    type UpdateProjectDependenciesOptions,
    type ProjectPathOptions,
    type PackProjectOptions,
} from '@erden/project';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { CLI_EXIT, CLI_HELP, runCli, type CliRuntime, type CliServices } from '../src/index.js';
import type { CliAuthenticationRuntime } from '../src/index.js';

const roots: string[] = [];
function tempRoot(): string {
    const root = makeTestTempRoot('erden-cli-');
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

interface CapturedRuntime {
    readonly runtime: CliRuntime;
    readonly stdout: string[];
    readonly stderr: string[];
}

function captureRuntime(
    cwd: string,
    services: CliServices = {
        check: nodeCheckProjectService,
        init: nodeInitProjectService,
        doctor: nodeDoctorService,
        install: makeNodeInstallProjectService(unavailableDependencyRegistry),
        dependencies: nodeProjectDependenciesService,
        path: nodeProjectPathService,
        pack: nodePackProjectService,
        storePath: nodeStorePathService,
        storeMaintenance: nodeStoreMaintenanceService,
    },
): CapturedRuntime {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        runtime: {
            cwd: () => cwd,
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
        },
    };
}

async function initFixture(parent: string): Promise<string> {
    const target = join(parent, 'project');
    const captured = captureRuntime(parent);
    expect(await runCli(['init', 'project', '--json'], captured.runtime)).toBe(CLI_EXIT.success);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toHaveLength(1);
    expect(captured.stdout[0]?.endsWith('\n')).toBe(true);
    expect(readdirSync(target).sort()).toEqual(['erden.config.json', 'erden.lock', 'ontology.ttl']);
    return target;
}

describe('erden CLI adapter', () => {
    it('renders deterministic help on stdout', async () => {
        const captured = captureRuntime(tempRoot());
        expect(await runCli(['--help'], captured.runtime)).toBe(CLI_EXIT.success);
        expect(captured.stdout).toEqual([CLI_HELP]);
        expect(captured.stderr).toEqual([]);
        expect(CLI_HELP.endsWith('\n')).toBe(true);
        expect(CLI_HELP).toContain(
            'Add, install, login, logout, publish, publication status, and query use one origin-scoped credential when present.',
        );
        expect(CLI_HELP).not.toContain('Add/install registry composition remains unavailable.');
    });

    it.each([
        ['unknown command', ['unknown']],
        ['unknown check flag', ['check', '--wat']],
        ['duplicate check flag', ['check', '--offline', '--offline']],
        ['missing config value', ['check', '--config']],
        ['excess check operands', ['check', 'one', 'two']],
        ['conflicting selectors', ['check', 'one', '--config', 'erden.config.json']],
        ['missing init target', ['init']],
        ['duplicate init format', ['init', 'x', '--format', 'json', '--format', 'toml']],
        ['doctor operand', ['doctor', 'project']],
        ['duplicate doctor flag', ['doctor', '--json', '--json']],
        ['unknown install flag', ['install', '--wat']],
        ['duplicate frozen lock flag', ['install', '--frozen-lockfile', '--frozen-lockfile']],
        ['excess install operands', ['install', 'one', 'two']],
        ['conflicting install selectors', ['install', 'one', '--config', 'erden.config.json']],
        ['missing add spec', ['add']],
        ['invalid add spec', ['add', '@example/package@not-a-range']],
        ['unknown add flag', ['add', '@example/package@*', '--wat']],
        ['excess remove operands', ['remove', '@example/a', '@example/b']],
        ['unknown remove flag', ['remove', '@example/a', '--wat']],
        ['excess update operands', ['update', '@example/a', '@example/b']],
        ['invalid update target', ['update', 'not-an-identifier']],
        ['unknown update flag', ['update', '--offline']],
        ['missing pack version', ['pack']],
        ['unknown pack flag', ['pack', '1.0.0', '--wat']],
        ['duplicate pack output', ['pack', '1.0.0', '--output', 'a.erdenpkg', '--output', 'b.erdenpkg']],
        ['excess pack operands', ['pack', '1.0.0', 'one', 'two']],
        ['conflicting pack selectors', ['pack', '1.0.0', 'one', '--config', 'erden.config.json']],
        ['missing publish version', ['publish']],
        ['invalid publish version', ['publish', '^1.0.0']],
        ['unknown publish flag', ['publish', '1.0.0', '--registry', 'https://registry.test']],
        ['duplicate publish create', ['publish', '1.0.0', '--create', '--create']],
        ['excess publish operands', ['publish', '1.0.0', 'one', 'two']],
        ['conflicting publish selectors', ['publish', '1.0.0', 'one', '--config', 'erden.config.json']],
        ['publish visibility without create', ['publish', '1.0.0', '--visibility', 'public']],
        ['publish yes without visibility', ['publish', '1.0.0', '--create', '--yes']],
        ['missing publication attempt', ['publication']],
        ['invalid publication attempt', ['publication', '../attempt']],
        ['unknown publication flag', ['publication', 'attempt-1', '--wat']],
        [
            'duplicate publication registry',
            ['publication', 'attempt-1', '--registry', 'https://one.test', '--registry', 'https://two.test'],
        ],
        ['noncanonical publication registry', ['publication', 'attempt-1', '--registry', 'https://registry.test/']],
        ['excess publication operands', ['publication', 'attempt-1', 'attempt-2']],
        ['missing path layer', ['path']],
        ['excess path operands', ['path', '@example/a', 'other']],
        ['unknown path flag', ['path', '@example/a', '--wat']],
        ['missing store subcommand', ['store']],
        ['unknown store subcommand', ['store', 'unknown']],
        ['store subcommand extras', ['store', 'status', 'extra']],
        ['store path dry run', ['store', 'path', '--dry-run']],
        ['store status dry run', ['store', 'status', '--dry-run']],
        ['duplicate store dry run', ['store', 'prune', '--dry-run', '--dry-run']],
        ['unknown store flag', ['store', 'prune', '--wat']],
        ['duplicate store json', ['store', 'path', '--json', '--json']],
        ['unknown login flag', ['login', '--wat']],
        ['duplicate login registry', ['login', '--registry', 'https://one.test', '--registry', 'https://two.test']],
        ['logout operand', ['logout', 'https://registry.test']],
    ])('uses exit 2 and stderr only for %s', async (_label, arguments_) => {
        const captured = captureRuntime(tempRoot());
        expect(await runCli(arguments_, captured.runtime)).toBe(CLI_EXIT.usage);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toHaveLength(1);
        expect(captured.stderr[0]?.endsWith('\n')).toBe(true);
    });

    it('visibly escapes hostile argv in usage diagnostics', async () => {
        const captured = captureRuntime(tempRoot());
        const hostile = 'bad\\path\n\u001b\u061c';
        expect(await runCli([hostile], captured.runtime)).toBe(CLI_EXIT.usage);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr[0]).toContain('bad\\\\path\\n\\u001b\\u061c');
        expect(captured.stderr[0]).not.toContain('\u001b');
        expect(captured.stderr[0]).not.toContain('\u061c');
    });

    it('runs device login without exposing secrets and warns exactly before HTTP authentication', async () => {
        const root = tempRoot();
        const captured = captureRuntime(root);
        const deviceSecret = 'erden_dvc_v1_d1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const credential = 'erden_cli_v1_d1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        const written: unknown[] = [];
        const authentication: CliAuthenticationRuntime = {
            begin: (registryOrigin, requestId) =>
                Promise.resolve({
                    registryOrigin,
                    requestId,
                    deviceSecret,
                    userCode: 'ABCD-EFGH',
                    verificationUrl: `${registryOrigin}/api/v1/auth/device?user_code=ABCD-EFGH`,
                    expiresAt: 10_000,
                    intervalSeconds: 5,
                }),
            exchange: () => Promise.resolve({ status: 'credential', credential, expiresAt: 20_000 }),
            revoke: () => Promise.resolve(),
            read: () => null,
            write: (value) => {
                written.push(value);
                return {
                    path: '/credential',
                    device: 1n,
                    inode: 1n,
                    sha256: 'a'.repeat(64),
                    value,
                };
            },
            remove: () => true,
            requestId: () => 'ERERERERERERERERERERERERERERERERERERERERERE',
            sleep: () => Promise.resolve(),
            now: () => 0,
        };
        const runtime: CliRuntime = { ...captured.runtime, authentication };
        expect(await runCli(['login', '--registry', 'http://registry.test'], runtime)).toBe(CLI_EXIT.success);
        expect(written).toHaveLength(1);
        expect(captured.stderr).toEqual([
            'WARNING: This registry uses HTTP. Authentication secrets may be intercepted or altered in transit.\n',
        ]);
        const visible = [...captured.stdout, ...captured.stderr].join('');
        expect(visible).toContain('ABCD-EFGH');
        expect(visible).not.toContain(deviceSecret);
        expect(visible).not.toContain(credential);
    });

    it('retries one lost exchange response and writes exactly one credential', async () => {
        const captured = captureRuntime(tempRoot());
        const deviceSecret = 'erden_dvc_v1_d1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const credential = 'erden_cli_v1_d1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        const written: unknown[] = [];
        const sleeps: number[] = [];
        let exchangeCalls = 0;
        const authentication: CliAuthenticationRuntime = {
            begin: (registryOrigin, requestId) =>
                Promise.resolve({
                    registryOrigin,
                    requestId,
                    deviceSecret,
                    userCode: 'ABCD-EFGH',
                    expiresAt: 10_000,
                    intervalSeconds: 5,
                    verificationUrl: `${registryOrigin}/api/v1/auth/device?user_code=ABCD-EFGH`,
                }),
            exchange: () => {
                exchangeCalls += 1;
                return exchangeCalls === 1
                    ? Promise.reject(new RegistryClientError('CLIENT_TRANSPORT'))
                    : Promise.resolve({ status: 'credential', credential, expiresAt: 20_000 });
            },
            revoke: () => Promise.resolve(),
            read: () => null,
            write: (value) => {
                written.push(value);
                return {
                    path: '/credential',
                    device: 1n,
                    inode: 1n,
                    sha256: 'a'.repeat(64),
                    value,
                };
            },
            remove: () => true,
            requestId: () => 'ERERERERERERERERERERERERERERERERERERERERERE',
            sleep: (milliseconds) => {
                sleeps.push(milliseconds);
                return Promise.resolve();
            },
            now: () => 0,
        };
        expect(
            await runCli(['login', '--registry', 'https://registry.test'], {
                ...captured.runtime,
                authentication,
            }),
        ).toBe(CLI_EXIT.success);
        expect(exchangeCalls).toBe(2);
        expect(sleeps).toEqual([100]);
        expect(written).toHaveLength(1);
        expect([...captured.stdout, ...captured.stderr].join('')).not.toContain(deviceSecret);
        expect([...captured.stdout, ...captured.stderr].join('')).not.toContain(credential);
    });

    it('bounds retry exhaustion and hostile expiry polling without writing or leaking secrets', async () => {
        const deviceSecret = 'erden_dvc_v1_d1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const credential = 'erden_cli_v1_d1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        function makeAuthentication(exchange: CliAuthenticationRuntime['exchange'], expiresAt: number) {
            let writes = 0;
            const authentication: CliAuthenticationRuntime = {
                begin: (registryOrigin, requestId) =>
                    Promise.resolve({
                        registryOrigin,
                        requestId,
                        deviceSecret,
                        userCode: 'ABCD-EFGH',
                        expiresAt,
                        intervalSeconds: 5,
                        verificationUrl: `${registryOrigin}/api/v1/auth/device?user_code=ABCD-EFGH`,
                    }),
                exchange,
                revoke: () => Promise.resolve(),
                read: () => null,
                write: (value) => {
                    writes += 1;
                    return {
                        path: '/credential',
                        device: 1n,
                        inode: 1n,
                        sha256: 'a'.repeat(64),
                        value,
                    };
                },
                remove: () => true,
                requestId: () => 'ERERERERERERERERERERERERERERERERERERERERERE',
                sleep: () => Promise.resolve(),
                now: () => 0,
            };
            return { authentication, writes: () => writes };
        }

        let failures = 0;
        const exhausted = makeAuthentication(() => {
            failures += 1;
            return Promise.reject(new RegistryClientError('CLIENT_TRANSPORT'));
        }, 10_000);
        const failed = captureRuntime(tempRoot());
        expect(
            await runCli(['login', '--registry', 'https://registry.test'], {
                ...failed.runtime,
                authentication: exhausted.authentication,
            }),
        ).toBe(CLI_EXIT.operational);
        expect(failures).toBe(3);
        expect(exhausted.writes()).toBe(0);

        let polls = 0;
        const bounded = makeAuthentication(() => {
            polls += 1;
            return Promise.resolve({ status: 'pending', intervalSeconds: 5 });
        }, Number.MAX_SAFE_INTEGER);
        const expired = captureRuntime(tempRoot());
        expect(
            await runCli(['login', '--registry', 'https://registry.test'], {
                ...expired.runtime,
                authentication: bounded.authentication,
            }),
        ).toBe(CLI_EXIT.operational);
        expect(polls).toBe(121);
        expect(bounded.writes()).toBe(0);
        const visible = [...failed.stdout, ...failed.stderr, ...expired.stdout, ...expired.stderr].join('');
        expect(visible).not.toContain(deviceSecret);
        expect(visible).not.toContain(credential);
    });

    it('uses the nearest project manifest registry when --registry is omitted', async () => {
        const parent = tempRoot();
        const project = await initFixture(parent);
        const manifestPath = join(project, 'erden.config.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        manifest.registry = 'https://nearest-registry.test';
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const captured = captureRuntime(project);
        const origins: string[] = [];
        const credential = 'erden_cli_v1_d1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        const authentication: CliAuthenticationRuntime = {
            begin: (registryOrigin, requestId) => {
                origins.push(registryOrigin);
                return Promise.resolve({
                    registryOrigin,
                    requestId,
                    deviceSecret: 'erden_dvc_v1_d1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                    userCode: 'ABCD-EFGH',
                    verificationUrl: `${registryOrigin}/api/v1/auth/device?user_code=ABCD-EFGH`,
                    expiresAt: 10_000,
                    intervalSeconds: 5,
                });
            },
            exchange: () => Promise.resolve({ status: 'credential', credential, expiresAt: 20_000 }),
            revoke: () => Promise.resolve(),
            read: () => null,
            write: (value) => ({ path: '/credential', device: 1n, inode: 1n, sha256: 'a'.repeat(64), value }),
            remove: () => true,
            requestId: () => 'ERERERERERERERERERERERERERERERERERERERERERE',
            sleep: () => Promise.resolve(),
            now: () => 0,
        };
        expect(await runCli(['login'], { ...captured.runtime, authentication })).toBe(CLI_EXIT.success);
        expect(origins).toEqual(['https://nearest-registry.test']);
        expect(captured.stderr).toEqual([]);
    });

    it('revokes remotely before removing the exact read revision and emits no HTTPS warning', async () => {
        const captured = captureRuntime(tempRoot());
        const credential = 'erden_cli_v1_d1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        const revision = {
            path: '/credential',
            device: 1n,
            inode: 1n,
            sha256: 'a'.repeat(64),
            value: {
                schema: 'erden.cli-credential/v1' as const,
                origin: 'https://registry.test',
                credential,
                expiresAt: 20_000,
            },
        };
        const calls: string[] = [];
        const authentication: CliAuthenticationRuntime = {
            begin: () => Promise.reject(new Error()),
            exchange: () => Promise.reject(new Error()),
            revoke: () => {
                calls.push('revoke');
                return Promise.resolve();
            },
            read: () => revision,
            write: () => {
                throw new Error();
            },
            remove: () => {
                calls.push('remove');
                return true;
            },
            requestId: () => '',
            sleep: () => Promise.resolve(),
            now: () => 0,
        };
        expect(
            await runCli(['logout', '--registry', 'https://registry.test'], {
                ...captured.runtime,
                authentication,
            }),
        ).toBe(CLI_EXIT.success);
        expect(calls).toEqual(['revoke', 'remove']);
        expect(captured.stderr).toEqual([]);
        expect([...captured.stdout, ...captured.stderr].join('')).not.toContain(credential);
    });

    it('classifies unexpected runtime failures as redacted operational errors', async () => {
        const secret = 'secret-runtime-path';
        const captured = captureRuntime(tempRoot());
        const runtime: CliRuntime = {
            ...captured.runtime,
            cwd: () => {
                throw new Error(secret);
            },
        };
        expect(await runCli(['check'], runtime)).toBe(CLI_EXIT.operational);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toEqual([
            'Erden check could not complete [validation/CHECK_OPERATION_FAILED]: The project check could not complete\n',
        ]);
        expect(captured.stderr[0]).not.toContain(secret);
    });

    it('initializes once and checks the scaffold offline with canonical JSON', async () => {
        const parent = tempRoot();
        const project = await initFixture(parent);
        const captured = captureRuntime(parent);
        expect(await runCli(['check', 'project', '--offline', '--json'], captured.runtime)).toBe(CLI_EXIT.success);
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout).toHaveLength(1);
        const report = JSON.parse(captured.stdout[0] as string) as { readonly outcome: string };
        expect(report.outcome).toBe('passed');
        expect(readFileSync(join(project, 'erden.config.json'), 'utf8')).toContain(
            'https://example.invalid/erden/project',
        );
    });

    it('keeps offline and normal report bytes identical and invokes CheckProject once', async () => {
        const parent = tempRoot();
        await initFixture(parent);
        const calls: CheckProjectOptions[] = [];
        const services: CliServices = {
            check: {
                check: (options = {}) => {
                    calls.push(options);
                    return nodeCheckProjectService.check(options);
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
        const normal = captureRuntime(parent, services);
        const offline = captureRuntime(parent, services);
        expect(await runCli(['check', 'project', '--json'], normal.runtime)).toBe(CLI_EXIT.success);
        expect(await runCli(['check', 'project', '--offline', '--json'], offline.runtime)).toBe(CLI_EXIT.success);
        expect(normal.stdout).toEqual(offline.stdout);
        expect(calls).toHaveLength(2);
        expect(calls.map((call) => call.offline)).toEqual([false, true]);
    });

    it('names the next step when this source checkout has no reasoner build', async () => {
        const parent = tempRoot();
        const missing = new CurrentToolchainError(undefined, undefined, 'SOURCE_BUILD_MISSING');
        const services: CliServices = {
            ...captureRuntime(parent).runtime.services,
            init: Object.freeze({
                init: () =>
                    Effect.fail(
                        new InitProjectError(
                            'INIT_TRANSACTION_FAILED',
                            'The current validator and bundled reasoner identity is unavailable',
                            missing,
                        ),
                    ),
            }),
            pack: Object.freeze({
                pack: () =>
                    Effect.fail(
                        new PackProjectError(
                            'PACK_PROJECT_TOOLCHAIN_UNAVAILABLE',
                            'The current validator and reasoner identity is unavailable',
                            missing,
                        ),
                    ),
            }),
        };
        for (const command of [
            ['init', 'project'],
            ['pack', '0.1.0', 'project'],
        ]) {
            const captured = captureRuntime(parent, services);
            expect(await runCli(command, captured.runtime)).toBe(CLI_EXIT.operational);
            expect(captured.stdout).toEqual([]);
            expect(captured.stderr.join('')).toContain(`\nNext step: ${REASONER_SOURCE_BUILD_GUIDANCE}\n`);
        }

        // Any other toolchain failure keeps its message alone.
        const other = captureRuntime(parent, {
            ...services,
            init: Object.freeze({
                init: () =>
                    Effect.fail(
                        new InitProjectError(
                            'INIT_TRANSACTION_FAILED',
                            'The current validator and bundled reasoner identity is unavailable',
                            new CurrentToolchainError(undefined, undefined, 'BINARY_DIGEST_MISMATCH'),
                        ),
                    ),
            }),
        });
        expect(await runCli(['init', 'project'], other.runtime)).toBe(CLI_EXIT.operational);
        expect(other.stderr.join('')).not.toContain('Next step:');
    });

    it('packs a scaffold through the CLI with canonical JSON and one service call', async () => {
        const parent = tempRoot();
        await initFixture(parent);
        let calls = 0;
        const services: CliServices = {
            ...captureRuntime(parent).runtime.services,
            pack: Object.freeze({
                pack: (options: PackProjectOptions) => {
                    calls += 1;
                    return nodePackProjectService.pack(options);
                },
            }),
        };
        const captured = captureRuntime(parent, services);
        expect(await runCli(['pack', '1.2.3', 'project', '--json'], captured.runtime)).toBe(CLI_EXIT.success);
        expect(calls).toBe(1);
        expect(captured.stderr).toEqual([]);
        const report = JSON.parse(captured.stdout[0] as string) as {
            outcome: string;
            output: { path: string };
            archive: { sha256: string };
        };
        expect(report.outcome).toBe('packed');
        expect(report.output.path).toBe(join(parent, 'example-project-1.2.3.erdenpkg'));
        expect(report.archive.sha256).toBe('d4ff65542958e0c20264c191227984783bd3b93e6e5e1e3f51405ff9aac72462');
    });

    it('walks up to the nearest manifest and honors an explicit config from unrelated CWD', async () => {
        const parent = tempRoot();
        const project = await initFixture(parent);
        const nested = join(project, 'nested');
        const unrelated = tempRoot();
        mkdirSync(nested);
        const walkUp = captureRuntime(nested);
        const explicit = captureRuntime(unrelated);
        expect(await runCli(['check', '--offline', '--json'], walkUp.runtime)).toBe(CLI_EXIT.success);
        expect(
            await runCli(
                ['check', '--config', join(project, 'erden.config.json'), '--offline', '--json'],
                explicit.runtime,
            ),
        ).toBe(CLI_EXIT.success);
        expect(walkUp.stdout).toEqual(explicit.stdout);
    });

    it('selects the nearest nested project and fails at a same-level manifest ambiguity', async () => {
        const parent = tempRoot();
        const outer = await initFixture(parent);
        const innerInit = captureRuntime(outer);
        expect(
            await runCli(
                [
                    'init',
                    'inner',
                    '--canonical-iri',
                    'https://example.test/inner',
                    '--alias',
                    '@example/inner',
                    '--json',
                ],
                innerInit.runtime,
            ),
        ).toBe(CLI_EXIT.success);
        const leaf = join(outer, 'inner', 'leaf');
        mkdirSync(leaf);
        const nested = captureRuntime(leaf);
        expect(await runCli(['check', '--offline', '--json'], nested.runtime)).toBe(CLI_EXIT.success);
        expect(JSON.parse(nested.stdout[0] as string)).toMatchObject({ manifest: { alias: '@example/inner' } });

        writeFileSync(join(outer, 'erden.config.yaml'), readFileSync(join(outer, 'erden.config.json')));
        const ambiguous = captureRuntime(outer);
        expect(await runCli(['check', '--offline'], ambiguous.runtime)).toBe(CLI_EXIT.operational);
        expect(ambiguous.stdout).toEqual([]);
        expect(ambiguous.stderr[0]).toContain('CHECK_MANIFEST_AMBIGUOUS');
        expect(ambiguous.stderr[0]).toContain('More than one Erden manifest');
        expect(ambiguous.stderr[0]).not.toContain(outer);
    });

    it('returns exit 1 with a completed semantic failure report on stdout', async () => {
        const parent = tempRoot();
        const project = await initFixture(parent);
        const ontology = join(project, 'ontology.ttl');
        writeFileSync(
            ontology,
            `${readFileSync(ontology, 'utf8')}\nex:missingMetadata a owl:ObjectProperty .\n`,
            'utf8',
        );
        const captured = captureRuntime(parent);
        expect(await runCli(['check', 'project', '--offline', '--json'], captured.runtime)).toBe(
            CLI_EXIT.semanticFailure,
        );
        expect(captured.stderr).toEqual([]);
        expect(JSON.parse(captured.stdout[0] as string)).toMatchObject({ outcome: 'failed' });
    });

    it('returns exit 3 with a path-free operational diagnostic on stderr', async () => {
        const secret = `secret-root-${String(Date.now())}`;
        const parent = join(tempRoot(), secret);
        const captured = captureRuntime(parent);
        expect(await runCli(['check', '--offline'], captured.runtime)).toBe(CLI_EXIT.operational);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toHaveLength(1);
        expect(captured.stderr[0]).not.toContain(secret);
        expect(captured.stderr[0]).not.toContain('Error:');
    });

    it('runs the real doctor KAT without exposing physical paths', async () => {
        const captured = captureRuntime(tempRoot());
        expect(await runCli(['doctor', '--json'], captured.runtime)).toBe(CLI_EXIT.success);
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout[0]).not.toMatch(/[A-Za-z]:\\|node_modules|erden-reasoner\.exe/u);
        expect(JSON.parse(captured.stdout[0] as string)).toMatchObject({
            outcome: 'passed',
            reasoner: { availability: 'available', selfTest: { status: 'passed' } },
        });
    });

    it('uses exit 1 and stdout only for an unhealthy completed doctor report', async () => {
        const inspection: ReturnType<DoctorRuntimePort['inspectReasoner']> = {
            runtime: { platform: 'test', arch: 'test', libc: null },
            availability: 'unavailable',
            expectedPlatformPackage: null,
            actualPlatformPackage: null,
            packageVersion: null,
            toolVersion: null,
            size: null,
            digest: null,
            target: null,
            requiredTool: null,
            failureCode: 'PACKAGE_NOT_FOUND',
            supportedPlatforms: null,
            selfTest: { status: 'not-run', failureCode: 'PACKAGE_NOT_FOUND' },
        };
        const captured = captureRuntime(tempRoot(), {
            check: nodeCheckProjectService,
            init: nodeInitProjectService,
            doctor: makeDoctorService({
                nodeVersion: () => '24.17.0',
                inspectReasoner: () => inspection,
            }),
            install: makeNodeInstallProjectService(unavailableDependencyRegistry),
            dependencies: nodeProjectDependenciesService,
            path: nodeProjectPathService,
            pack: nodePackProjectService,
            storePath: nodeStorePathService,
            storeMaintenance: nodeStoreMaintenanceService,
        });
        expect(await runCli(['doctor', '--json'], captured.runtime)).toBe(CLI_EXIT.semanticFailure);
        expect(captured.stderr).toEqual([]);
        expect(JSON.parse(captured.stdout[0] as string)).toMatchObject({ outcome: 'failed' });
    });

    it('delegates install, path, and store path exactly once with canonical JSON', async () => {
        const cwd = tempRoot();
        const archiveSha256 = 'c'.repeat(64);
        const installCalls: InstallProjectOptions[] = [];
        const pathCalls: ProjectPathOptions[] = [];
        let storePathCalls = 0;
        const installReport = decodeInstallProjectReport({
            schema: 'erden.install-report/v1',
            project: { canonicalIri: 'https://example.test/project', alias: '@example/project' },
            mode: { offline: true, frozenLockfile: true },
            lock: { status: 'existing', cleanup: 'clean', sha256: 'a'.repeat(64) },
            packages: { total: 1, reused: [archiveSha256], fetched: [], repaired: [] },
            materialization: {
                status: 'hit',
                cleanup: 'clean',
                strategies: { clone: 0, hardlink: 0, copy: 0 },
            },
            outcome: 'installed',
        });
        const physicalPath = join(cwd, '.erden', 'layers', archiveSha256);
        const pathReport = decodeProjectPathReport({
            schema: 'erden.path-report/v1',
            project: { canonicalIri: 'https://example.test/project', alias: '@example/project' },
            layer: {
                identifier: '@example/package',
                canonicalIri: 'https://example.test/package',
                version: '1.0.0',
                archiveSha256,
                path: physicalPath,
            },
            outcome: 'resolved',
        });
        const storeReport = decodeStorePathReport({
            schema: 'erden.store-path-report/v1',
            storeRoot: join(cwd, 'store'),
            outcome: 'resolved',
        });
        const services: CliServices = {
            check: nodeCheckProjectService,
            init: nodeInitProjectService,
            doctor: nodeDoctorService,
            install: Object.freeze({
                install: (options = {}) => {
                    installCalls.push(options);
                    return Effect.succeed(installReport);
                },
            }),
            dependencies: nodeProjectDependenciesService,
            path: Object.freeze({
                path: (options: ProjectPathOptions) => {
                    pathCalls.push(options);
                    return Effect.succeed(pathReport);
                },
            }),
            pack: nodePackProjectService,
            storePath: Object.freeze({
                path: () => {
                    storePathCalls += 1;
                    return Effect.succeed(storeReport);
                },
            }),
            storeMaintenance: nodeStoreMaintenanceService,
        };
        const install = captureRuntime(cwd, services);
        expect(await runCli(['install', 'project', '--offline', '--frozen-lockfile', '--json'], install.runtime)).toBe(
            CLI_EXIT.success,
        );
        expect(install.stderr).toEqual([]);
        expect(JSON.parse(install.stdout[0] as string)).toMatchObject({ outcome: 'installed' });
        expect(installCalls).toEqual([
            {
                from: join(cwd, 'project'),
                offline: true,
                frozenLockfile: true,
            },
        ]);

        const path = captureRuntime(cwd, services);
        expect(
            await runCli(['path', '@example/package', '--config', 'project/erden.config.json', '--json'], path.runtime),
        ).toBe(CLI_EXIT.success);
        expect(path.stderr).toEqual([]);
        expect(JSON.parse(path.stdout[0] as string)).toMatchObject({ layer: { path: physicalPath } });
        expect(pathCalls).toEqual([
            {
                identifier: '@example/package',
                manifestPath: join(cwd, 'project', 'erden.config.json'),
            },
        ]);

        const store = captureRuntime(cwd, services);
        expect(await runCli(['store', 'path', '--json'], store.runtime)).toBe(CLI_EXIT.success);
        expect(store.stderr).toEqual([]);
        expect(JSON.parse(store.stdout[0] as string)).toEqual(JSON.parse(JSON.stringify(storeReport)));
        expect(storePathCalls).toBe(1);
    });

    it('delegates store status and prune once with deterministic streams and semantic status exit', async () => {
        const cwd = tempRoot();
        const healthy = decodeStoreStatusReport({
            schema: 'erden.store-status-report/v1',
            store: 'available',
            transaction: 'idle',
            registrations: { total: 0, current: [], superseded: [], orphaned: [], stale: [], corrupt: [], busy: [] },
            objects: {
                total: 1,
                referenced: [],
                unreferenced: ['a'.repeat(64)],
                missingReferenced: [],
                busy: [],
                corrupt: [],
                logicalBytes: '12',
                unreferencedLogicalBytes: '12',
            },
            outcome: 'healthy',
        });
        const issues = decodeStoreStatusReport({
            ...healthy,
            objects: {
                ...healthy.objects,
                total: 0,
                unreferenced: [],
                missingReferenced: ['b'.repeat(64)],
                logicalBytes: '0',
                unreferencedLogicalBytes: '0',
            },
            outcome: 'issues',
        });
        const busyRegistrationIssues = decodeStoreStatusReport({
            ...healthy,
            transaction: 'busy',
            registrations: {
                ...healthy.registrations,
                busy: ['c'.repeat(64)],
            },
            objects: {
                ...healthy.objects,
                total: 0,
                unreferenced: [],
                logicalBytes: '0',
                unreferencedLogicalBytes: '0',
            },
            outcome: 'issues',
        });
        const pruned = decodeStorePruneReport({
            schema: 'erden.store-prune-report/v1',
            warning: STORE_PRUNE_REACQUISITION_WARNING,
            dryRun: true,
            registrations: { total: 0, retired: [] },
            objects: { total: 1, removed: ['a'.repeat(64)], logicalBytes: '12' },
            outcome: 'planned',
        });
        let statusCalls = 0;
        const pruneCalls: Array<{ readonly dryRun?: boolean }> = [];
        let statusReport = healthy;
        const services: CliServices = {
            ...captureRuntime(cwd).runtime.services,
            storeMaintenance: Object.freeze({
                status: () => {
                    statusCalls += 1;
                    return Effect.succeed(statusReport);
                },
                prune: (options: { readonly dryRun?: boolean }) => {
                    pruneCalls.push(options);
                    return Effect.succeed(pruned);
                },
            }),
        };
        const status = captureRuntime(cwd, services);
        expect(await runCli(['store', 'status', '--json'], status.runtime)).toBe(CLI_EXIT.success);
        expect(status.stderr).toEqual([]);
        expect(status.stdout).toEqual([`${JSON.stringify(healthy)}\n`]);
        expect(statusCalls).toBe(1);

        statusReport = issues;
        const issueStatus = captureRuntime(cwd, services);
        expect(await runCli(['store', 'status'], issueStatus.runtime)).toBe(CLI_EXIT.semanticFailure);
        expect(issueStatus.stdout[0]).toContain('Erden store: issues');
        expect(issueStatus.stderr).toEqual([]);
        expect(statusCalls).toBe(2);

        statusReport = busyRegistrationIssues;
        const busyStatus = captureRuntime(cwd, services);
        expect(await runCli(['store', 'status', '--json'], busyStatus.runtime)).toBe(CLI_EXIT.semanticFailure);
        expect(busyStatus.stderr).toEqual([]);
        expect(JSON.parse(busyStatus.stdout[0] as string)).toMatchObject({
            outcome: 'issues',
            registrations: { current: [], corrupt: [], busy: ['c'.repeat(64)] },
        });
        expect(statusCalls).toBe(3);

        const prune = captureRuntime(cwd, services);
        expect(await runCli(['store', 'prune', '--dry-run', '--json'], prune.runtime)).toBe(CLI_EXIT.success);
        expect(prune.stderr).toEqual([]);
        expect(prune.stdout).toEqual([`${JSON.stringify(pruned)}\n`]);
        expect(pruneCalls).toEqual([{ dryRun: true }]);
    });

    it.each([
        ['human', []],
        ['json', ['--json']],
    ] as const)(
        'writes the fixed prune warning before the single %s deletion delegation',
        async (_label, formatArguments) => {
            const cwd = tempRoot();
            const events: string[] = [];
            const report = decodeStorePruneReport({
                schema: 'erden.store-prune-report/v1',
                warning: STORE_PRUNE_REACQUISITION_WARNING,
                dryRun: false,
                registrations: { total: 0, retired: [] },
                objects: { total: 1, removed: ['a'.repeat(64)], logicalBytes: '12' },
                outcome: 'pruned',
            });
            const captured = captureRuntime(cwd, {
                ...captureRuntime(cwd).runtime.services,
                storeMaintenance: Object.freeze({
                    status: () => Effect.die('unexpected status'),
                    prune: () => {
                        events.push('service');
                        return Effect.succeed(report);
                    },
                }),
            });
            const runtime: CliRuntime = {
                ...captured.runtime,
                stderr: {
                    write: (text) => {
                        events.push('stderr');
                        captured.stderr.push(text);
                    },
                },
            };
            expect(await runCli(['store', 'prune', ...formatArguments], runtime)).toBe(CLI_EXIT.success);
            expect(events).toEqual(['stderr', 'service']);
            expect(captured.stderr).toEqual([`${STORE_PRUNE_REACQUISITION_WARNING}\n`]);
            expect(captured.stdout).toHaveLength(1);
            expect(captured.stdout[0]).toContain(STORE_PRUNE_REACQUISITION_WARNING);
        },
    );

    it('delegates add, remove, and update exactly once with strict grammar and canonical JSON', async () => {
        const cwd = tempRoot();
        const calls: Array<
            AddProjectDependencyOptions | RemoveProjectDependencyOptions | UpdateProjectDependenciesOptions
        > = [];
        const installation = decodeInstallProjectReport({
            schema: 'erden.install-report/v1',
            project: { canonicalIri: 'https://example.test/root', alias: '@example/root' },
            mode: { offline: false, frozenLockfile: false },
            lock: { status: 'existing', cleanup: 'clean', sha256: 'a'.repeat(64) },
            packages: { total: 0, reused: [], fetched: [], repaired: [] },
            materialization: { status: 'hit', cleanup: 'clean', strategies: { clone: 0, hardlink: 0, copy: 0 } },
            outcome: 'installed',
        });
        const addReport = decodeProjectDependenciesReport({
            schema: 'erden.dependency-change-report/v1',
            operation: 'add',
            project: installation.project,
            dependency: {
                identifier: 'https://user@example.test/layer',
                previousRange: '*',
                nextRange: '*',
                canonicalIri: 'https://user@example.test/layer',
            },
            state: {
                status: 'unchanged',
                manifestFormat: 'json',
                manifestSha256: 'b'.repeat(64),
                lockSha256: 'a'.repeat(64),
            },
            resolution: 'existing-lock',
            packageChanges: [],
            installation,
            warnings: [],
            outcome: 'installed',
        });
        const removeReport = decodeProjectDependenciesReport({
            ...addReport,
            operation: 'remove',
            dependency: { ...addReport.dependency, nextRange: null },
            state: { ...addReport.state, status: 'written' },
            resolution: 'pruned-exact',
            installation: { ...installation, lock: { ...installation.lock, status: 'written' } },
        });
        const updateReport = decodeProjectDependencyUpdateReport({
            schema: 'erden.dependency-update-report/v1',
            project: installation.project,
            strategy: 'targeted-frozen',
            target: { identifier: 'https://user@example.test/layer', canonicalIri: 'https://user@example.test/layer' },
            state: {
                status: 'unchanged',
                manifestFormat: 'json',
                manifestSha256: 'b'.repeat(64),
                lockSha256: 'a'.repeat(64),
            },
            packageChanges: [],
            installation,
            outcome: 'unchanged',
        });
        const services: CliServices = {
            ...captureRuntime(cwd).runtime.services,
            dependencies: Object.freeze({
                add: (options: AddProjectDependencyOptions) => {
                    calls.push(options);
                    return Effect.succeed(addReport);
                },
                remove: (options: RemoveProjectDependencyOptions) => {
                    calls.push(options);
                    return Effect.succeed(removeReport);
                },
                update: (options: UpdateProjectDependenciesOptions) => {
                    calls.push(options);
                    return Effect.succeed(updateReport);
                },
            }),
        };
        const add = captureRuntime(cwd, services);
        expect(
            await runCli(
                ['add', 'https://user@example.test/layer@*', '--config', 'erden.config.json', '--json'],
                add.runtime,
            ),
        ).toBe(CLI_EXIT.success);
        expect(JSON.parse(add.stdout[0] as string)).toMatchObject({ operation: 'add', outcome: 'installed' });
        const remove = captureRuntime(cwd, services);
        expect(await runCli(['remove', 'https://user@example.test/layer', '--json'], remove.runtime)).toBe(
            CLI_EXIT.success,
        );
        const update = captureRuntime(cwd, services);
        expect(
            await runCli(
                ['update', 'https://user@example.test/layer', '--config', 'erden.config.json', '--json'],
                update.runtime,
            ),
        ).toBe(CLI_EXIT.success);
        expect(JSON.parse(update.stdout[0] as string)).toMatchObject({
            strategy: 'targeted-frozen',
            outcome: 'unchanged',
        });
        expect(calls).toEqual([
            { identifier: 'https://user@example.test/layer', range: '*', manifestPath: join(cwd, 'erden.config.json') },
            { identifier: 'https://user@example.test/layer', from: cwd },
            { identifier: 'https://user@example.test/layer', manifestPath: join(cwd, 'erden.config.json') },
        ]);
    });

    it('renders path commands as raw physical paths plus one LF', async () => {
        const cwd = tempRoot();
        const physicalPath = join(cwd, '.erden', 'layers', 'd'.repeat(64));
        const services: CliServices = {
            check: nodeCheckProjectService,
            init: nodeInitProjectService,
            doctor: nodeDoctorService,
            install: makeNodeInstallProjectService(unavailableDependencyRegistry),
            dependencies: nodeProjectDependenciesService,
            path: Object.freeze({
                path: () =>
                    Effect.succeed(
                        decodeProjectPathReport({
                            schema: 'erden.path-report/v1',
                            project: { canonicalIri: 'https://example.test/project', alias: '@example/project' },
                            layer: {
                                identifier: 'https://example.test/package',
                                canonicalIri: 'https://example.test/package',
                                version: '1.0.0',
                                archiveSha256: 'd'.repeat(64),
                                path: physicalPath,
                            },
                            outcome: 'resolved',
                        }),
                    ),
            }),
            pack: nodePackProjectService,
            storePath: Object.freeze({
                path: () =>
                    Effect.succeed(
                        decodeStorePathReport({
                            schema: 'erden.store-path-report/v1',
                            storeRoot: join(cwd, 'store'),
                            outcome: 'resolved',
                        }),
                    ),
            }),
            storeMaintenance: nodeStoreMaintenanceService,
        };
        const layer = captureRuntime(cwd, services);
        expect(await runCli(['path', 'https://example.test/package'], layer.runtime)).toBe(CLI_EXIT.success);
        expect(layer.stdout).toEqual([`${physicalPath}\n`]);
        expect(layer.stderr).toEqual([]);
        const store = captureRuntime(cwd, services);
        expect(
            await runCli(['store', 'path'], {
                ...store.runtime,
                cwd: () => {
                    throw new Error('must not read cwd');
                },
            }),
        ).toBe(CLI_EXIT.success);
        expect(store.stdout).toEqual([`${join(cwd, 'store')}\n`]);
        expect(store.stderr).toEqual([]);
    });

    it('uses exit 3 and stderr only for install unavailability with complete sorted issues', async () => {
        const cwd = tempRoot();
        const error = new InstallProjectUnavailableError({
            status: 'unavailable',
            packages: 3,
            missing: ['a'.repeat(64)],
            corrupt: ['b'.repeat(64)],
            busy: ['c'.repeat(64)],
        });
        const captured = captureRuntime(cwd, {
            check: nodeCheckProjectService,
            init: nodeInitProjectService,
            doctor: nodeDoctorService,
            install: Object.freeze({ install: () => Effect.fail(error) }),
            dependencies: nodeProjectDependenciesService,
            path: nodeProjectPathService,
            pack: nodePackProjectService,
            storePath: nodeStorePathService,
            storeMaintenance: nodeStoreMaintenanceService,
        });
        expect(await runCli(['install', '--offline'], captured.runtime)).toBe(CLI_EXIT.operational);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr).toHaveLength(1);
        expect(captured.stderr[0]).toContain(`- missing ${'a'.repeat(64)}`);
        expect(captured.stderr[0]).toContain(`- corrupt ${'b'.repeat(64)}`);
        expect(captured.stderr[0]).toContain(`- busy ${'c'.repeat(64)}`);
    });

    it.each(['install', 'path', 'pack', 'store'] as const)(
        'redacts unexpected %s service failures',
        async (command) => {
            const cwd = tempRoot();
            const secret = 'C:/private-service-secret';
            const captured = captureRuntime(cwd, {
                check: nodeCheckProjectService,
                init: nodeInitProjectService,
                doctor: nodeDoctorService,
                install: Object.freeze({ install: () => Effect.die(new Error(secret)) }),
                dependencies: nodeProjectDependenciesService,
                path: Object.freeze({ path: () => Effect.die(new Error(secret)) }),
                pack: Object.freeze({ pack: () => Effect.die(new Error(secret)) }),
                storePath: Object.freeze({ path: () => Effect.die(new Error(secret)) }),
                storeMaintenance: nodeStoreMaintenanceService,
            });
            const arguments_ =
                command === 'install'
                    ? ['install']
                    : command === 'path'
                      ? ['path', 'https://example.test/package']
                      : command === 'pack'
                        ? ['pack', '1.2.3']
                        : ['store', 'path'];
            expect(await runCli(arguments_, captured.runtime)).toBe(CLI_EXIT.operational);
            expect(captured.stdout).toEqual([]);
            expect(captured.stderr).toHaveLength(1);
            expect(captured.stderr[0]).not.toContain(secret);
            expect(captured.stderr[0]).not.toContain('Error:');
        },
    );
});
