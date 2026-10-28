import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { BundledReasonerDoctorInspection } from '@erden/ontology';

import {
    DoctorOperationalError,
    REASONER_SOURCE_BUILD_GUIDANCE,
    REQUIRED_NODE_VERSION,
    decodeDoctorReport,
    encodeDoctorReport,
    makeDoctorService,
    nodeDoctorService,
    renderDoctorReport,
    type DoctorReport,
} from '../src/index.js';

function digest(value: string): string {
    return `sha256:${value.repeat(64)}`;
}

function healthyReasoner(): BundledReasonerDoctorInspection {
    return {
        runtime: { platform: 'linux', arch: 'x64', libc: 'glibc' },
        availability: 'available',
        expectedPlatformPackage: '@erden/reasoner-linux-x64-gnu',
        actualPlatformPackage: '@erden/reasoner-linux-x64-gnu',
        packageVersion: '0.3.0+purrdf.0.12.0.dfb1df7',
        toolVersion: '0.3.0+purrdf.0.12.0.dfb1df7',
        size: 42,
        digest: digest('1'),
        target: 'x86_64-unknown-linux-gnu',
        requiredTool: {
            name: 'erden-reasoner',
            version: '0.3.0+purrdf.0.12.0.dfb1df7',
            executableDigest: digest('1'),
            adapterDigest: digest('2'),
            calculusDigest: digest('3'),
        },
        failureCode: null,
        supportedPlatforms: null,
        selfTest: { status: 'passed', failureCode: null },
    };
}

/** Runs `body` while Node reports an architecture no Erden reasoner package will ever target. */
function onUnsupportedArchitecture<A>(body: () => A): A {
    const original = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'arch', { ...original, value: 's390x' });
    try {
        return body();
    } finally {
        Object.defineProperty(process, 'arch', original ?? { value: 'x64' });
    }
}

describe('Doctor application operation', () => {
    it('runs the real bundled known-answer test and emits no executable path', async () => {
        const report = await Effect.runPromise(nodeDoctorService.inspect());
        expect(report).toMatchObject({
            outcome: 'passed',
            node: { requiredVersion: REQUIRED_NODE_VERSION, runtimeVersion: REQUIRED_NODE_VERSION, status: 'passed' },
            reasoner: { availability: 'available', selfTest: { status: 'passed' } },
        });
        const json = encodeDoctorReport(report);
        const human = renderDoctorReport(report);
        expect(json).not.toMatch(/[A-Za-z]:[\\/]|\/(?:home|repo|tmp)\//u);
        expect(human).not.toMatch(/[A-Za-z]:[\\/]|\/(?:home|repo|tmp)\//u);
    });

    it('reports exact Node and reasoner failures as completed unhealthy reports', async () => {
        const unavailable: BundledReasonerDoctorInspection = {
            runtime: { platform: 'linux', arch: 's390x', libc: 'glibc' },
            availability: 'unavailable',
            expectedPlatformPackage: null,
            actualPlatformPackage: null,
            packageVersion: null,
            toolVersion: null,
            size: null,
            digest: null,
            target: null,
            requiredTool: null,
            failureCode: 'UNSUPPORTED_PLATFORM',
            supportedPlatforms: ['linux x64 (glibc)', 'linux arm64 (glibc)', 'darwin arm64', 'win32 x64'],
            selfTest: { status: 'failed', failureCode: 'UNSUPPORTED_PLATFORM' },
        };
        const report = await Effect.runPromise(
            makeDoctorService({
                nodeVersion: () => '24.17.1',
                inspectReasoner: () => unavailable,
            }).inspect(),
        );
        expect(report).toMatchObject({ outcome: 'failed', node: { status: 'failed' } });
        expect(renderDoctorReport(report)).toContain('linux/s390x/glibc');
        expect(renderDoctorReport(report)).toContain('UNSUPPORTED_PLATFORM');
        expect(renderDoctorReport(report)).toContain(
            'Supported platforms: linux x64 (glibc), linux arm64 (glibc), darwin arm64, win32 x64',
        );
        expect(encodeDoctorReport(report)).toContain(
            '"supportedPlatforms":["linux x64 (glibc)","linux arm64 (glibc)","darwin arm64","win32 x64"]',
        );
    });

    it('names the next step when this source checkout has no reasoner build', async () => {
        const missing: BundledReasonerDoctorInspection = {
            ...healthyReasoner(),
            availability: 'unavailable',
            expectedPlatformPackage: 'source-build',
            actualPlatformPackage: null,
            packageVersion: null,
            toolVersion: null,
            size: null,
            digest: null,
            target: null,
            requiredTool: null,
            failureCode: 'SOURCE_BUILD_MISSING',
            selfTest: { status: 'failed', failureCode: 'SOURCE_BUILD_MISSING' },
        };
        const report = await Effect.runPromise(
            makeDoctorService({ nodeVersion: () => REQUIRED_NODE_VERSION, inspectReasoner: () => missing }).inspect(),
        );
        expect(report.outcome).toBe('failed');
        const human = renderDoctorReport(report);
        expect(human).toContain('Reasoner: unavailable (SOURCE_BUILD_MISSING)');
        expect(human).toContain(`\nNext step: ${REASONER_SOURCE_BUILD_GUIDANCE}\n`);
        expect(REASONER_SOURCE_BUILD_GUIDANCE).toContain('pnpm run reasoner:build');
        expect(encodeDoctorReport(report)).not.toContain('Next step');

        const broken = await Effect.runPromise(
            makeDoctorService({
                nodeVersion: () => REQUIRED_NODE_VERSION,
                inspectReasoner: () => ({
                    ...missing,
                    failureCode: 'BINARY_MISSING',
                    selfTest: { status: 'failed', failureCode: 'BINARY_MISSING' },
                }),
            }).inspect(),
        );
        expect(renderDoctorReport(broken)).not.toContain('Next step');
    });

    it('reports the bundled SHACL engine beside the reasoner, and fails when it fails', async () => {
        const healthyShacl = {
            availability: 'available' as const,
            expectedPlatformPackage: '@erden/shacl-linux-x64-gnu',
            actualPlatformPackage: '@erden/shacl-linux-x64-gnu',
            packageVersion: '0.1.0+purrdf.3.0.1',
            toolVersion: '0.1.0+purrdf.3.0.1',
            size: 42,
            digest: digest('4'),
            target: 'x86_64-unknown-linux-gnu',
            tool: {
                name: 'erden-shacl' as const,
                version: '0.1.0+purrdf.3.0.1' as const,
                engineDigest: digest('5'),
                executableDigest: digest('4'),
            },
            failureCode: null,
            supportedPlatforms: null,
            selfTest: { status: 'passed' as const, failureCode: null },
        };
        const passed = await Effect.runPromise(
            makeDoctorService({
                nodeVersion: () => REQUIRED_NODE_VERSION,
                inspectReasoner: healthyReasoner,
                inspectShaclEngine: () => healthyShacl,
            }).inspect(),
        );
        expect(passed.outcome).toBe('passed');
        expect(renderDoctorReport(passed)).toContain(
            `SHACL engine: 0.1.0+purrdf.3.0.1 x86_64-unknown-linux-gnu ${digest('4')} — known-answer passed`,
        );
        expect(encodeDoctorReport(passed)).toContain('"shaclEngine":{');
        const damaged = await Effect.runPromise(
            makeDoctorService({
                nodeVersion: () => REQUIRED_NODE_VERSION,
                inspectReasoner: healthyReasoner,
                inspectShaclEngine: () => ({
                    ...healthyShacl,
                    availability: 'unavailable',
                    tool: null,
                    failureCode: 'BINARY_DIGEST_MISMATCH',
                    selfTest: { status: 'failed', failureCode: 'BINARY_DIGEST_MISMATCH' },
                }),
            }).inspect(),
        );
        expect(damaged.outcome).toBe('failed');
        expect(renderDoctorReport(damaged)).toContain('SHACL engine: unavailable (BINARY_DIGEST_MISMATCH)');
        // A port without the engine reports the reasoner only, as before.
        const reasonerOnly = await Effect.runPromise(
            makeDoctorService({ nodeVersion: () => REQUIRED_NODE_VERSION, inspectReasoner: healthyReasoner }).inspect(),
        );
        expect(reasonerOnly).not.toHaveProperty('shaclEngine');
        expect(encodeDoctorReport(reasonerOnly)).not.toContain('shaclEngine');
    });

    it('tells the user which platforms are supported when the bundled reasoner refuses this one', () => {
        const report = onUnsupportedArchitecture(() => Effect.runSync(nodeDoctorService.inspect()));
        const human = renderDoctorReport(report);
        expect(report.reasoner.failureCode).toBe('UNSUPPORTED_PLATFORM');
        expect(human).toContain(`Runtime: ${process.platform}/s390x`);
        expect(human).toMatch(/^Supported platforms: .*linux x64 \(glibc\).*win32 x64/mu);
    });

    it.each([
        [
            'missing packages',
            (report: DoctorReport) => {
                Reflect.set(report.reasoner, 'expectedPlatformPackage', null);
            },
        ],
        [
            'zero size',
            (report: DoctorReport) => {
                Reflect.set(report.reasoner, 'size', 0);
            },
        ],
        [
            'wrong tool name',
            (report: DoctorReport) => {
                Reflect.set(report.reasoner.requiredTool ?? {}, 'name', 'other');
            },
        ],
        [
            'version mismatch',
            (report: DoctorReport) => {
                Reflect.set(report.reasoner, 'packageVersion', 'different');
            },
        ],
        [
            'failure code mismatch',
            (report: DoctorReport) => {
                Reflect.set(report.reasoner, 'availability', 'unavailable');
                Reflect.set(report.reasoner, 'requiredTool', null);
                Reflect.set(report.reasoner, 'failureCode', 'ONE');
                Reflect.set(report.reasoner.selfTest, 'status', 'failed');
                Reflect.set(report.reasoner.selfTest, 'failureCode', 'TWO');
                Reflect.set(report, 'outcome', 'failed');
            },
        ],
    ])('rejects contradictory %s doctor reports', async (_label, mutate) => {
        const valid = await Effect.runPromise(
            makeDoctorService({
                nodeVersion: () => REQUIRED_NODE_VERSION,
                inspectReasoner: healthyReasoner,
            }).inspect(),
        );
        const hostile = structuredClone(valid);
        mutate(hostile);
        expect(() => decodeDoctorReport(hostile)).toThrow();
    });

    it('wraps unexpected runtime failures without exposing the cause', async () => {
        const failure = await Effect.runPromise(
            Effect.flip(
                makeDoctorService({
                    nodeVersion: () => REQUIRED_NODE_VERSION,
                    inspectReasoner: () => {
                        throw new Error('C:\\secret\\reasoner.exe stack sentinel');
                    },
                }).inspect(),
            ),
        );
        expect(failure).toBeInstanceOf(DoctorOperationalError);
        expect(JSON.stringify(failure)).not.toContain('secret');
    });
});
