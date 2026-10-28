import { describe, expect, it } from 'vitest';

import {
    CHECK_REPORT_VERSION,
    REASONER_PROTOCOL_VERSION,
    REASONING_COMPLETENESS,
    decodeCheckProjectReport,
    encodeCheckProjectReport,
    type CheckProjectReport,
} from '@erden/contracts';

import { renderCheckProjectReport } from '../src/index.js';

function digest(character: string): string {
    return `sha256:${character.repeat(64)}`;
}

type DeepMutable<A> =
    A extends ReadonlyArray<infer Item>
        ? DeepMutable<Item>[]
        : A extends object
          ? { -readonly [Key in keyof A]: DeepMutable<A[Key]> }
          : A;
type MutableReport = DeepMutable<CheckProjectReport>;

function validReport(): CheckProjectReport {
    return {
        schema: CHECK_REPORT_VERSION,
        manifest: {
            schemaVersion: 1,
            file: 'erden.config.json',
            canonicalIri: 'https://example.test/root',
            alias: '@example/root',
            title: null,
        },
        sources: {
            selectors: [
                { id: 'root:ontology-selector:0000', stage: 'ontology', kind: 'file', selector: 'ontology.ttl' },
            ],
            files: [{ stage: 'ontology', id: 'root:ontology:0000', file: 'ontology.ttl', contentDigest: digest('1') }],
            citationRoots: [],
        },
        reasoning: {
            protocolVersion: REASONER_PROTOCOL_VERSION,
            outcome: 'decided',
            negativeOutcome: null,
            consistency: 'consistent',
            requestId: 'request:1',
            inputDigest: digest('2'),
            profile: { id: 'erden-required-constructs-v1', digest: digest('3') },
            tool: {
                name: 'purr',
                version: '1',
                executableDigest: digest('4'),
                adapterDigest: digest('5'),
                calculusDigest: digest('6'),
            },
            diagnostics: [],
            inferred: [],
            unsatisfiableClasses: [],
            inferredStatementCount: 0,
            materializedStatementCount: 0,
        },
        stages: {
            sources: {
                status: 'passed',
                failureCodes: [],
                ontologyFiles: 1,
                shapeFiles: 0,
                competencyQuestionFiles: 0,
            },
            reasoning: { status: 'passed', failureCodes: [] },
            core: {
                status: 'passed',
                failureCodes: [],
                borrowedTerms: {
                    conforms: true,
                    used: [],
                    declared: [],
                    missing: [],
                },
                propertyDomainRange: { conforms: true, properties: [], findings: [] },
            },
            shacl: { status: 'skipped', failureCodes: [], details: null },
            competencyQuestions: { status: 'skipped', failureCodes: [], details: null },
            citations: { status: 'passed', failureCodes: [], details: { conforms: true, warnings: 0, citations: [] } },
        },
        warnings: [],
        outcome: 'passed',
    };
}

function mutableReport(): MutableReport {
    return structuredClone(validReport()) as unknown as MutableReport;
}

function first<A>(values: ReadonlyArray<A>): A {
    const value = values[0];
    if (value === undefined) {
        throw new TypeError('Expected a non-empty test fixture array');
    }
    return value;
}

function inferred(
    id: string,
    rule: CheckProjectReport['reasoning']['inferred'][number]['rule'],
): DeepMutable<CheckProjectReport['reasoning']['inferred'][number]> {
    return {
        id,
        rule,
        subject: 'https://example.test/root#subject',
        predicate: 'https://example.test/root#predicate',
        object: 'https://example.test/root#object',
        premiseIds: ['axiom:1'],
        contributingSourceIds: ['root:ontology:0000'],
        contributingOwners: [
            {
                role: 'root',
                canonicalIri: 'https://example.test/root',
                ownedIriPrefixes: ['https://example.test/root#'],
            },
        ],
        justificationDigest: digest('7'),
    };
}

function addPassingShape(report: MutableReport): void {
    report.sources.selectors.push({
        id: 'root:shapes-selector:0000',
        stage: 'shapes',
        kind: 'file',
        selector: 'shape.ttl',
    });
    report.sources.files.push({
        stage: 'shapes',
        id: 'root:shape:0000',
        file: 'shape.ttl',
        contentDigest: digest('8'),
    });
    report.stages.sources.shapeFiles = 1;
    report.stages.shacl = {
        status: 'passed',
        failureCodes: [],
        details: {
            conforms: true,
            counts: { violation: 0, warning: 0, info: 0 },
            findings: [],
            shapes: [
                {
                    shape: 'https://example.test/root#shape',
                    targetKind: 'none',
                    targetTerm: null,
                    targetCount: 0,
                    resultCount: 0,
                    sourceIds: ['root:shape:0000'],
                    owners: [
                        {
                            role: 'root',
                            canonicalIri: 'https://example.test/root',
                            ownedIriPrefixes: ['https://example.test/root#'],
                        },
                    ],
                },
            ],
            selfTest: [{ shape: 'https://example.test/root#shape', fired: true, reason: null }],
            sourceDigests: [{ sourceId: 'root:shape:0000', contentDigest: digest('8') }],
        },
    };
}

describe('erden.check-report/v1 schema and canonical encoding', () => {
    it('strictly decodes, freezes, and round-trips one canonical JSON document plus LF', () => {
        const decoded = decodeCheckProjectReport(validReport());
        const wire = encodeCheckProjectReport(decoded);
        expect(wire.endsWith('\n')).toBe(true);
        expect(wire.endsWith('\n\n')).toBe(false);
        expect(wire).toBe(encodeCheckProjectReport(decodeCheckProjectReport(JSON.parse(wire))));
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.sources.files)).toBe(true);
        expect(decoded.reasoning.protocolVersion).toBe(REASONER_PROTOCOL_VERSION);
    });

    it('states how completeness is checked only on a decided, consistent report', () => {
        const base = validReport();
        const stated = decodeCheckProjectReport({
            ...base,
            reasoning: { ...base.reasoning, completeness: REASONING_COMPLETENESS },
        });
        expect(renderCheckProjectReport(stated)).toContain('Completeness: checked at qualification, not on this run');
        const inconsistent = structuredClone(stated) as unknown as MutableReport;
        inconsistent.reasoning.consistency = 'inconsistent';
        expect(() => decodeCheckProjectReport(inconsistent)).toThrow(
            'Only a report that decided consistency states how completeness is checked',
        );
    });

    it('preserves well-formed control text in canonical JSON and visibly escapes it for terminals', () => {
        const report = mutableReport();
        report.manifest.title = 'title\u0000\r\n\u001b\t\u061c\u200e\u200f\u206aend';
        report.warnings = [
            {
                stage: 'shacl',
                code: 'shacl-warning',
                message: '[Warning] message\u0000\r\n\u001b\t\u061c\u200e\u200f\u206aend',
            },
        ];
        report.sources.files.push({
            stage: 'shapes',
            id: 'root:shape:0000',
            file: 'shape.ttl',
            contentDigest: digest('8'),
        });
        report.sources.selectors.push({
            id: 'root:shapes-selector:0000',
            stage: 'shapes',
            kind: 'file',
            selector: 'shape.ttl',
        });
        report.stages.sources.shapeFiles = 1;
        report.stages.shacl = {
            status: 'passed',
            failureCodes: [],
            details: {
                conforms: true,
                counts: { violation: 0, warning: 1, info: 0 },
                findings: [
                    {
                        focus: null,
                        path: null,
                        severity: 'Warning',
                        message: 'message\u0000\r\n\u001b\t\u061c\u200e\u200f\u206aend',
                        shape: 'https://example.test/root#shape',
                        shapeSourceIds: ['root:shape:0000'],
                        shapeOwners: [
                            {
                                role: 'root',
                                canonicalIri: 'https://example.test/root',
                                ownedIriPrefixes: ['https://example.test/root#'],
                            },
                        ],
                    },
                ],
                shapes: [
                    {
                        shape: 'https://example.test/root#shape',
                        targetKind: 'none',
                        targetTerm: null,
                        targetCount: 0,
                        resultCount: 1,
                        sourceIds: ['root:shape:0000'],
                        owners: [
                            {
                                role: 'root',
                                canonicalIri: 'https://example.test/root',
                                ownedIriPrefixes: ['https://example.test/root#'],
                            },
                        ],
                    },
                ],
                selfTest: [{ shape: 'https://example.test/root#shape', fired: true, reason: null }],
                sourceDigests: [{ sourceId: 'root:shape:0000', contentDigest: digest('8') }],
            },
        };
        const decoded = decodeCheckProjectReport(report);
        const wire = encodeCheckProjectReport(decoded);
        const roundTrip = decodeCheckProjectReport(JSON.parse(wire));
        expect(roundTrip.manifest.title).toBe(report.manifest.title);
        expect(first(roundTrip.warnings).message).toBe(first(report.warnings).message);
        const human = renderCheckProjectReport(decoded);
        expect(human).toContain('message\\u0000\\r\\n\\u001b\\t\\u061c\\u200e\\u200f\\u206aend');
        expect(human).not.toMatch(/[\u0000\r\u001b\u061c\u200e\u200f\u206a]/u);
        expect(human.split('\n').filter((line) => line.includes('shacl-warning'))).toHaveLength(1);
    });

    it.each([
        [
            'excess field',
            (report: MutableReport) => {
                Reflect.set(report, 'createdAt', '2026-01-01T00:00:00Z');
            },
        ],
        [
            'wrong version',
            (report: MutableReport) => {
                Reflect.set(report, 'schema', 'erden.check-report/v2');
            },
        ],
        [
            'wrong protocol version',
            (report: MutableReport) => {
                Reflect.set(report.reasoning, 'protocolVersion', 2);
            },
        ],
        [
            'malformed digest',
            (report: MutableReport) => {
                report.reasoning.inputDigest = 'sha256:nope';
            },
        ],
        [
            'malformed IRI',
            (report: MutableReport) => {
                report.manifest.canonicalIri = 'not an iri';
            },
        ],
        [
            'wrong enum',
            (report: MutableReport) => {
                Reflect.set(report, 'outcome', 'maybe');
            },
        ],
        [
            'absolute path',
            (report: MutableReport) => {
                first(report.sources.files).file = 'C:/secret/ontology.ttl';
            },
        ],
        [
            'drive-relative path',
            (report: MutableReport) => {
                first(report.sources.files).file = 'C:secret/ontology.ttl';
            },
        ],
        [
            'OS separator',
            (report: MutableReport) => {
                first(report.sources.files).file = 'ontology\\root.ttl';
            },
        ],
        [
            'parent traversal',
            (report: MutableReport) => {
                first(report.sources.files).file = '../secret/ontology.ttl';
            },
        ],
        [
            'dot segment',
            (report: MutableReport) => {
                first(report.sources.files).file = 'ontology/./root.ttl';
            },
        ],
        [
            'control character',
            (report: MutableReport) => {
                first(report.sources.files).file = 'ontology/\u0001root.ttl';
            },
        ],
        [
            'nondeterministic ordering',
            (report: MutableReport) => {
                report.sources.selectors = [
                    { id: 'root:shapes-selector:0000', stage: 'shapes', kind: 'file', selector: 'z.ttl' },
                    { id: 'root:ontology-selector:0000', stage: 'ontology', kind: 'file', selector: 'a.ttl' },
                ];
            },
        ],
    ])('rejects hostile %s', (_label, mutate) => {
        const report = mutableReport();
        mutate(report);
        expect(() => decodeCheckProjectReport(report)).toThrow();
    });

    it.each([
        [
            'failed stage without codes',
            (report: MutableReport) => {
                report.stages.core.status = 'failed';
                report.outcome = 'failed';
            },
        ],
        [
            'skipped stage with details',
            (report: MutableReport) => {
                report.stages.shacl.details = {
                    conforms: true,
                    counts: { violation: 0, warning: 0, info: 0 },
                    findings: [],
                    shapes: [],
                    selfTest: [],
                    sourceDigests: [],
                };
            },
        ],
        [
            'source count mismatch',
            (report: MutableReport) => {
                report.stages.sources.ontologyFiles = 2;
            },
        ],
        [
            'negative outcome with executed downstream stages',
            (report: MutableReport) => {
                report.reasoning.consistency = 'inconsistent';
                report.stages.reasoning = { status: 'failed', failureCodes: ['global-inconsistency'] };
                report.outcome = 'failed';
            },
        ],
        [
            'consistent result with a not-run stage',
            (report: MutableReport) => {
                report.stages.core = {
                    status: 'not-run',
                    failureCodes: [],
                    borrowedTerms: null,
                    propertyDomainRange: null,
                };
            },
        ],
        [
            'shape count without executed SHACL',
            (report: MutableReport) => {
                report.sources.files.push({
                    stage: 'shapes',
                    id: 'root:shape:0000',
                    file: 'shape.ttl',
                    contentDigest: digest('8'),
                });
                report.stages.sources.shapeFiles = 1;
            },
        ],
        [
            'refusal carrying inferred output',
            (report: MutableReport) => {
                report.reasoning.outcome = 'refused';
                report.reasoning.consistency = null;
                report.reasoning.inferred = [inferred('statement:1', 'subclass-type')];
                report.reasoning.inferredStatementCount = 1;
                report.stages.reasoning = { status: 'failed', failureCodes: ['unsupported-construct'] };
                report.stages.core = {
                    status: 'not-run',
                    failureCodes: [],
                    borrowedTerms: null,
                    propertyDomainRange: null,
                };
                report.stages.shacl = { status: 'not-run', failureCodes: [], details: null };
                report.stages.competencyQuestions = { status: 'not-run', failureCodes: [], details: null };
                report.stages.citations = { status: 'not-run', failureCodes: [], details: null };
                report.outcome = 'failed';
            },
        ],
    ])('rejects semantically contradictory %s reports', (_label, mutate) => {
        const report = mutableReport();
        mutate(report);
        expect(() => decodeCheckProjectReport(report)).toThrow();
    });

    it('locates a refusal diagnostic by file, line and column and renders the locations instead of axiom IDs', () => {
        function refused(locations?: DeepMutable<CheckProjectReport['reasoning']['diagnostics'][number]['locations']>) {
            const report = mutableReport();
            report.reasoning.outcome = 'refused';
            report.reasoning.negativeOutcome = { outcome: 'refused', reason: 'incomplete-certificate' };
            report.reasoning.consistency = null;
            report.reasoning.diagnostics = [
                {
                    severity: 'error',
                    code: 'uncheckable-inconsistency',
                    message:
                        '<https://example.test/root#report> <https://example.test/root#modified> "2026-09-03"^^xsd:string, but ...',
                    axiomIds: ['axiom:1', 'axiom:2'],
                    ...(locations === undefined ? {} : { locations }),
                },
            ];
            report.stages.reasoning = { status: 'failed', failureCodes: ['incomplete-certificate'] };
            report.stages.core = {
                status: 'not-run',
                failureCodes: [],
                borrowedTerms: null,
                propertyDomainRange: null,
            };
            report.stages.shacl = { status: 'not-run', failureCodes: [], details: null };
            report.stages.competencyQuestions = { status: 'not-run', failureCodes: [], details: null };
            report.stages.citations = { status: 'not-run', failureCodes: [], details: null };
            report.outcome = 'failed';
            return report;
        }
        const located = decodeCheckProjectReport(
            refused([
                { file: 'ontology.ttl', line: 9, column: 5 },
                { file: 'ontology.ttl', line: 12, column: 5 },
            ]),
        );
        expect(encodeCheckProjectReport(decodeCheckProjectReport(JSON.parse(encodeCheckProjectReport(located))))).toBe(
            encodeCheckProjectReport(located),
        );
        expect(renderCheckProjectReport(located)).toContain(
            '"2026-09-03"^^xsd:string, but ... (at ontology.ttl:9:5, ontology.ttl:12:5)',
        );
        expect(renderCheckProjectReport(decodeCheckProjectReport(refused()))).toContain(
            'but ... (axioms: axiom:1, axiom:2)',
        );
        expect(() =>
            decodeCheckProjectReport(
                refused([
                    { file: 'ontology.ttl', line: 12, column: 5 },
                    { file: 'ontology.ttl', line: 9, column: 5 },
                ]),
            ),
        ).toThrow('reasoner diagnostic locations must be strictly sorted and unique');
        expect(() => decodeCheckProjectReport(refused([{ file: 'elsewhere.ttl', line: 1, column: 1 }]))).toThrow(
            'A reasoner diagnostic location must name a reported ontology source file',
        );
        expect(() => decodeCheckProjectReport(refused([]))).toThrow();
        const unattributed = refused([{ file: 'ontology.ttl', line: 9, column: 5 }]);
        first(unattributed.reasoning.diagnostics).axiomIds = [];
        expect(() => decodeCheckProjectReport(unattributed)).toThrow(
            'A reasoner diagnostic without axioms has no locations',
        );
    });

    it('accepts all exact reasoner proof-rule literals and rejects renamed approximations', () => {
        const rules: ReadonlyArray<CheckProjectReport['reasoning']['inferred'][number]['rule']> = [
            'subclass-type',
            'subclass-transitive',
            'object-property-domain',
            'data-property-domain',
            'object-property-range',
            'equivalent-class-subclass',
            'equivalent-class-type',
            'inverse-object-property',
            'transitive-object-property',
            'union-domain-type',
            'thing-subclass-type',
        ];
        const report = mutableReport();
        report.reasoning.inferred = rules.map((rule, index) =>
            inferred(`statement:${String(index).padStart(2, '0')}`, rule),
        );
        report.reasoning.inferredStatementCount = rules.length;
        expect(decodeCheckProjectReport(report).reasoning.inferred.map((item) => item.rule)).toEqual(rules);
        Reflect.set(first(report.reasoning.inferred), 'rule', 'domain');
        expect(() => decodeCheckProjectReport(report)).toThrow();
    });

    it('accepts canonically sorted duplicate SHACL findings as a meaningful multiset', () => {
        const report = mutableReport();
        report.sources.files.push({
            stage: 'shapes',
            id: 'root:shape:0000',
            file: 'shape.ttl',
            contentDigest: digest('8'),
        });
        report.sources.selectors.push({
            id: 'root:shapes-selector:0000',
            stage: 'shapes',
            kind: 'file',
            selector: 'shape.ttl',
        });
        report.stages.sources.shapeFiles = 1;
        const finding = {
            focus: 'https://example.test/root#subject',
            path: 'https://example.test/root#predicate',
            severity: 'Violation',
            message: 'two distinct constraints produced the same projected finding',
            shape: 'https://example.test/root#shape',
            shapeSourceIds: ['root:shape:0000'],
            shapeOwners: [
                {
                    role: 'root' as const,
                    canonicalIri: 'https://example.test/root',
                    ownedIriPrefixes: ['https://example.test/root#'],
                },
            ],
        };
        report.stages.shacl = {
            status: 'failed',
            failureCodes: ['shacl-conformance'],
            details: {
                conforms: false,
                counts: { violation: 2, warning: 0, info: 0 },
                findings: [finding, { ...finding }],
                shapes: [
                    {
                        shape: 'https://example.test/root#shape',
                        targetKind: 'none',
                        targetTerm: null,
                        targetCount: 0,
                        resultCount: 2,
                        sourceIds: ['root:shape:0000'],
                        owners: [
                            {
                                role: 'root',
                                canonicalIri: 'https://example.test/root',
                                ownedIriPrefixes: ['https://example.test/root#'],
                            },
                        ],
                    },
                ],
                selfTest: [{ shape: 'https://example.test/root#shape', fired: true, reason: null }],
                sourceDigests: [{ sourceId: 'root:shape:0000', contentDigest: digest('8') }],
            },
        };
        report.outcome = 'failed';
        expect(decodeCheckProjectReport(report).stages.shacl.details?.findings).toHaveLength(2);
    });

    it.each([
        [
            'wrong nonempty stage code',
            (report: MutableReport) => {
                const borrowed = report.stages.core.borrowedTerms;
                if (borrowed === null) {
                    throw new TypeError('missing fixture details');
                }
                borrowed.used = ['https://example.test/dependency#Term'];
                borrowed.missing = ['https://example.test/dependency#Term'];
                borrowed.conforms = false;
                report.stages.core.status = 'failed';
                report.stages.core.failureCodes = ['wrong-code'];
                report.outcome = 'failed';
            },
        ],
        [
            'borrowed-term contradiction',
            (report: MutableReport) => {
                const borrowed = report.stages.core.borrowedTerms;
                if (borrowed === null) {
                    throw new TypeError('missing fixture details');
                }
                borrowed.used = ['https://example.test/dependency#Term'];
                borrowed.missing = [];
            },
        ],
        [
            'domain-range contradiction',
            (report: MutableReport) => {
                const domainRange = report.stages.core.propertyDomainRange;
                if (domainRange === null) {
                    throw new TypeError('missing fixture details');
                }
                domainRange.properties = ['https://example.test/root#property'];
                domainRange.findings = [{ property: 'https://example.test/root#property', missing: 'domain' }];
            },
        ],
        [
            'unknown reasoning source reference',
            (report: MutableReport) => {
                const statement = inferred('statement:1', 'subclass-type');
                statement.contributingSourceIds = ['missing:source'];
                report.reasoning.inferred = [statement];
                report.reasoning.inferredStatementCount = 1;
            },
        ],
        [
            'empty proof premises',
            (report: MutableReport) => {
                const statement = inferred('statement:1', 'subclass-type');
                statement.premiseIds = [];
                report.reasoning.inferred = [statement];
                report.reasoning.inferredStatementCount = 1;
            },
        ],
        [
            'omitted derived warning',
            (report: MutableReport) => {
                report.reasoning.diagnostics = [
                    { severity: 'warning', code: 'warning', message: 'visible warning', axiomIds: [] },
                ];
            },
        ],
        [
            'empty protocol diagnostic message',
            (report: MutableReport) => {
                report.reasoning.diagnostics = [{ severity: 'warning', code: 'warning', message: '', axiomIds: [] }];
                report.warnings = [{ stage: 'reasoning', code: 'warning', message: '' }];
            },
        ],
    ])('rejects deep report-truth violation: %s', (_label, mutate) => {
        const report = mutableReport();
        mutate(report);
        expect(() => decodeCheckProjectReport(report)).toThrow();
    });

    it('rejects a dropped SHACL self-test and a forged nonblocking CQ failure', () => {
        const shacl = mutableReport();
        shacl.sources.files.push({
            stage: 'shapes',
            id: 'root:shape:0000',
            file: 'shape.ttl',
            contentDigest: digest('8'),
        });
        shacl.sources.selectors.push({
            id: 'root:shapes-selector:0000',
            stage: 'shapes',
            kind: 'file',
            selector: 'shape.ttl',
        });
        shacl.stages.sources.shapeFiles = 1;
        shacl.stages.shacl = {
            status: 'passed',
            failureCodes: [],
            details: {
                conforms: true,
                counts: { violation: 0, warning: 0, info: 0 },
                findings: [],
                shapes: [
                    {
                        shape: 'https://example.test/root#shape',
                        targetKind: 'none',
                        targetTerm: null,
                        targetCount: 0,
                        resultCount: 0,
                        sourceIds: ['root:shape:0000'],
                        owners: [
                            {
                                role: 'root',
                                canonicalIri: 'https://example.test/root',
                                ownedIriPrefixes: ['https://example.test/root#'],
                            },
                        ],
                    },
                ],
                selfTest: [],
                sourceDigests: [{ sourceId: 'root:shape:0000', contentDigest: digest('8') }],
            },
        };
        expect(() => decodeCheckProjectReport(shacl)).toThrow();

        const cq = mutableReport();
        cq.sources.files.unshift({
            stage: 'competency-questions',
            id: 'root:cq:0000',
            file: 'question.rq',
            contentDigest: digest('9'),
        });
        cq.sources.selectors.unshift({
            id: 'root:competency-questions-selector:0000',
            stage: 'competency-questions',
            kind: 'file',
            selector: 'question.rq',
        });
        cq.stages.sources.competencyQuestionFiles = 1;
        cq.stages.competencyQuestions = {
            status: 'passed',
            failureCodes: [],
            details: {
                conforms: true,
                executed: 1,
                dormant: 0,
                questions: [
                    {
                        id: 'root:cq:0000',
                        owner: {
                            role: 'root',
                            canonicalIri: 'https://example.test/root',
                            ownedIriPrefixes: ['https://example.test/root#'],
                        },
                        file: 'question.rq',
                        execution: 'executed',
                        rows: 0,
                        ok: false,
                        expectedToFail: false,
                        closes: null,
                        blocking: false,
                        reason: 'failed',
                        metadataDiagnostics: [],
                    },
                ],
            },
        };
        expect(() => decodeCheckProjectReport(cq)).toThrow();
    });

    it('rejects citation status/evidence contradictions including a mixed missing-file row', () => {
        const report = mutableReport();
        report.stages.citations = {
            status: 'failed',
            failureCodes: ['citation-conformance'],
            details: {
                conforms: false,
                warnings: 0,
                citations: [
                    {
                        observation: 'https://example.test/root#observation',
                        label: null,
                        commit: null,
                        repository: null,
                        root: 'default',
                        affectedFacts: [],
                        metadataDiagnostics: [],
                        files: [
                            { path: 'missing.txt', exists: false, gitState: null },
                            { path: 'present.txt', exists: true, gitState: null },
                        ],
                        status: 'missing-source-path',
                        blocking: true,
                        warning: false,
                    },
                ],
            },
        };
        report.outcome = 'failed';
        expect(() => decodeCheckProjectReport(report)).toThrow();
    });

    it('preserves distinct same-class unsatisfiable evidence while deduplicating its warning projection', () => {
        const report = mutableReport();
        const owner = {
            role: 'root' as const,
            canonicalIri: 'https://example.test/root',
            ownedIriPrefixes: ['https://example.test/root#'],
        };
        report.reasoning.unsatisfiableClasses = [
            {
                classIri: 'https://example.test/root#Impossible',
                premiseIds: ['axiom:1'],
                contributingSourceIds: ['root:ontology:0000'],
                contributingOwners: [owner],
                justificationDigest: digest('7'),
            },
            {
                classIri: 'https://example.test/root#Impossible',
                premiseIds: ['axiom:2'],
                contributingSourceIds: ['root:ontology:0000'],
                contributingOwners: [owner],
                justificationDigest: digest('8'),
            },
        ];
        report.warnings = [
            {
                stage: 'reasoning',
                code: 'unsatisfiable-class',
                message: 'https://example.test/root#Impossible is unsatisfiable',
            },
        ];
        expect(decodeCheckProjectReport(report).reasoning.unsatisfiableClasses).toHaveLength(2);
    });

    it('rejects selector linkage/identity, core finding, SHACL state, and diagnostic-code forgeries', () => {
        const noShapeSelector = mutableReport();
        addPassingShape(noShapeSelector);
        noShapeSelector.sources.selectors = noShapeSelector.sources.selectors.filter((item) => item.stage !== 'shapes');
        expect(() => decodeCheckProjectReport(noShapeSelector)).toThrow();

        const duplicateSelectorId = mutableReport();
        addPassingShape(duplicateSelectorId);
        first(duplicateSelectorId.sources.selectors.filter((item) => item.stage === 'shapes')).id = first(
            duplicateSelectorId.sources.selectors.filter((item) => item.stage === 'ontology'),
        ).id;
        expect(() => decodeCheckProjectReport(duplicateSelectorId)).toThrow();

        const duplicateCoreFinding = mutableReport();
        const domainRange = duplicateCoreFinding.stages.core.propertyDomainRange;
        if (domainRange === null) {
            throw new TypeError('missing fixture details');
        }
        domainRange.conforms = false;
        domainRange.properties = ['https://example.test/root#property'];
        domainRange.findings = [
            { property: 'https://example.test/root#property', missing: 'domain' },
            { property: 'https://example.test/root#property', missing: 'range' },
        ];
        duplicateCoreFinding.stages.core.status = 'failed';
        duplicateCoreFinding.stages.core.failureCodes = ['property-domain-range'];
        duplicateCoreFinding.outcome = 'failed';
        expect(() => decodeCheckProjectReport(duplicateCoreFinding)).toThrow();

        const selfTestMismatch = mutableReport();
        addPassingShape(selfTestMismatch);
        const selfTest = first(
            selfTestMismatch.stages.shacl.details === null ? [] : selfTestMismatch.stages.shacl.details.selfTest,
        );
        selfTest.reason = 'a fired self-test cannot carry a failure reason';
        expect(() => decodeCheckProjectReport(selfTestMismatch)).toThrow();

        const targetMismatch = mutableReport();
        addPassingShape(targetMismatch);
        const shape = first(
            targetMismatch.stages.shacl.details === null ? [] : targetMismatch.stages.shacl.details.shapes,
        );
        shape.targetTerm = 'https://example.test/root#A';
        expect(() => decodeCheckProjectReport(targetMismatch)).toThrow();

        const shapeDigestMismatch = mutableReport();
        addPassingShape(shapeDigestMismatch);
        const details = shapeDigestMismatch.stages.shacl.details;
        if (details === null) {
            throw new TypeError('missing fixture details');
        }
        first(details.sourceDigests).contentDigest = digest('9');
        expect(() => decodeCheckProjectReport(shapeDigestMismatch)).toThrow();

        const diagnosticCode = mutableReport();
        diagnosticCode.reasoning.diagnostics = [
            {
                severity: 'warning',
                code: 'not a protocol identifier',
                message: 'warning',
                axiomIds: [],
            },
        ];
        diagnosticCode.warnings = [
            {
                stage: 'reasoning',
                code: 'not a protocol identifier',
                message: 'warning',
            },
        ];
        expect(() => decodeCheckProjectReport(diagnosticCode)).toThrow();
    });
});
