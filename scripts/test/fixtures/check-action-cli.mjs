// A protocol fixture, not an Erden engine. Native CI tests use it to exercise the action adapter.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const phase = args[0];
const scenario = process.env.ERDEN_ACTION_FIXTURE_SCENARIO ?? 'passed';
if (process.env.ERDEN_ACTION_FIXTURE_LOG) {
    appendFileSync(process.env.ERDEN_ACTION_FIXTURE_LOG, `${JSON.stringify(args)}\n`);
}
if (phase === '--version') {
    console.log(scenario === 'wrong-version' ? '9.9.9' : '0.1.0');
} else if (phase === 'doctor') {
    console.log(
        JSON.stringify({
            schema: 'erden.doctor-report/v1',
            outcome: scenario === 'engine-error' ? 'failed' : 'passed',
        }),
    );
    process.exitCode = scenario === 'engine-error' ? 1 : 0;
} else if (phase === 'install') {
    if (scenario === 'install-error') {
        console.error('Locked artifact unavailable');
        process.exitCode = 3;
    } else {
        console.log(JSON.stringify({ schema: 'erden.install-report/v1', outcome: 'installed' }));
    }
} else if (phase === 'check') {
    if (scenario === 'runtime-error') {
        console.error('CHECK_SHACL_ENGINE_UNAVAILABLE\n::error::forged');
        process.exitCode = 3;
    } else if (scenario === 'malformed') {
        console.log('not a JSON report');
    } else {
        const failed = ['failed', 'contradiction', 'blocking-cq', 'dependency-shacl'].includes(scenario);
        const stages = Object.fromEntries(
            ['sources', 'core', 'reasoning', 'shacl', 'competencyQuestions', 'citations'].map((name) => [
                name,
                { status: 'passed', failureCodes: [] },
            ]),
        );
        if (['failed', 'contradiction', 'dependency-shacl'].includes(scenario)) {
            stages.shacl = {
                status: 'failed',
                failureCodes: ['shacl-conformance'],
                details: {
                    findings: [
                        {
                            severity: 'Violation',
                            message: 'Required Supplier type is absent\n::notice::forged',
                            shapeSourceIds: [
                                scenario === 'dependency-shacl' ? 'dependency:shape:1' : 'root:shapes:0000',
                            ],
                        },
                    ],
                },
            };
        }
        if (scenario === 'expected-cq' || scenario === 'blocking-cq') {
            const blocking = scenario === 'blocking-cq';
            stages.competencyQuestions = {
                status: blocking ? 'failed' : 'passed',
                failureCodes: blocking ? ['competency-question-conformance'] : [],
                details: {
                    questions: [
                        {
                            file: 'question.rq',
                            ok: blocking,
                            blocking,
                            reason: blocking ? 'Missing required question metadata' : 'Expected failure',
                        },
                    ],
                },
            };
        }
        console.log(
            JSON.stringify({
                schema: 'erden.check-report/v1',
                outcome: failed ? 'failed' : 'passed',
                stages,
                sources: {
                    files: [
                        {
                            id: scenario === 'dependency-shacl' ? 'dependency:shape:1' : 'root:shapes:0000',
                            file:
                                scenario === 'dependency-shacl' ? 'dependencies/archive-hash/shapes.ttl' : 'shapes.ttl',
                        },
                    ],
                },
                warnings: [
                    {
                        stage: 'citations',
                        code: 'fixture-warning',
                        message: 'Evidence <script> & | text\n::error::forged',
                    },
                ],
            }),
        );
        process.exitCode = failed && scenario !== 'contradiction' ? 1 : 0;
    }
} else {
    console.error(`Unexpected fixture phase: ${phase}`);
    process.exitCode = 2;
}
