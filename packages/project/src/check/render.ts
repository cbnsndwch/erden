import type { CheckProjectOperationalError } from '@erden/contracts';
import { SHACL_UNSUPPORTED_CONSTRUCT_CODE, type CheckProjectReport } from '@erden/contracts';
import { REASONER_LIMIT_SETTINGS, type ReasonerLimitKey } from '@erden/ontology';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) =>
                character === '\n'
                    ? '\\n'
                    : character === '\r'
                      ? '\\r'
                      : character === '\t'
                        ? '\\t'
                        : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

function stageLine(
    name: string,
    stage: Readonly<{
        readonly status: string;
        readonly failureCodes: ReadonlyArray<string>;
    }>,
): string {
    // A refused SHACL step is a failed stage in the JSON report; people read the word that says what happened.
    const status = stage.failureCodes.includes(SHACL_UNSUPPORTED_CONSTRUCT_CODE) ? 'refused' : stage.status;
    return `${name}: ${status}${stage.failureCodes.length === 0 ? '' : ` (${stage.failureCodes.map(terminalText).join(', ')})`}`;
}

function limitSetting(key: ReasonerLimitKey) {
    const setting = REASONER_LIMIT_SETTINGS.find((item) => item.key === key);
    if (setting === undefined) {
        throw new TypeError(`Unknown reasoner limit ${key}`);
    }
    return setting;
}

/** A budget refusal names the limit it reached, its value when the report records it, and the setting behind it. */
function limitLines(report: CheckProjectReport): ReadonlyArray<string> {
    const limits = report.reasoning.limits;
    const codes = new Set(
        report.reasoning.diagnostics.filter((item) => item.severity === 'error').map((item) => item.code),
    );
    const lines: string[] = [];
    if (codes.has('wall-time-budget')) {
        const setting = limitSetting('maxWallTimeMs');
        lines.push(
            `[reasoning] the wall-time budget${limits === undefined ? '' : ` of ${String(limits.maxWallTimeMs)} ms`} elapsed; ${setting.variable} sets it (${String(setting.minimum)} to ${String(setting.maximum)} ms)`,
        );
    }
    if (codes.has('max-input-axioms')) {
        const setting = limitSetting('maxInputAxioms');
        const count = report.reasoning.inputAxiomCount;
        lines.push(
            `[reasoning] the ontology normalized to ${count === undefined ? 'more' : String(count)} input axioms${limits === undefined ? ' than the limit' : `, over the limit of ${String(limits.maxInputAxioms)}`}; ${setting.variable} sets it (up to ${String(setting.maximum)})`,
        );
    }
    if (codes.has('max-inferences')) {
        const setting = limitSetting('maxInferences');
        lines.push(
            `[reasoning] reasoning reached the limit${limits === undefined ? '' : ` of ${String(limits.maxInferences)}`} inferred statements; ${setting.variable} sets it (up to ${String(setting.maximum)})`,
        );
    }
    return lines;
}

/**
 * Where a reasoner diagnostic is in the sources: the file, line and column of each statement its axioms were read from,
 * or its axiom IDs when none of them could be located.
 */
function diagnosticWhere(diagnostic: CheckProjectReport['reasoning']['diagnostics'][number]): string {
    if (diagnostic.locations !== undefined) {
        const at = diagnostic.locations.map(
            (item) => `${terminalText(item.file)}:${String(item.line)}:${String(item.column)}`,
        );
        return ` (at ${at.join(', ')})`;
    }
    return diagnostic.axiomIds.length === 0 ? '' : ` (axioms: ${diagnostic.axiomIds.map(terminalText).join(', ')})`;
}

function plural(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** A summary of what report mode left out of reasoning; the JSON report carries the examples. */
function unreasonedLines(report: CheckProjectReport): ReadonlyArray<string> {
    const unreasoned = report.unreasoned;
    if (unreasoned === undefined) {
        return [];
    }
    const lines = [
        '',
        `Not reasoned: ${plural(unreasoned.statementCount, 'statement')} in ${plural(unreasoned.findingCount, 'finding')} that Erden does not reason over yet (${terminalText(unreasoned.rules.id)}). ${unreasoned.note}`,
    ];
    for (const construct of unreasoned.constructs) {
        const example = construct.examples[0];
        const owl = (construct.owlConstructs ?? []).map(
            (item) => `${terminalText(item.name)} ${String(item.findingCount)}`,
        );
        // An anonymous example has no subject; its description says what it is.
        const named = example?.subject ?? example?.description ?? '(anonymous)';
        const where =
            example?.location === undefined
                ? `in ${(example?.files ?? []).map(terminalText).join(', ')}`
                : `at ${terminalText(example.location.file)}:${String(example.location.line)}:${String(example.location.column)}`;
        lines.push(
            `- [${construct.group}/${terminalText(construct.construct)}] ${plural(construct.findingCount, 'finding')}, ${plural(construct.statementCount, 'statement')}${owl.length === 0 ? '' : ` (${owl.join(', ')})`}${example === undefined ? '' : `, e.g. ${terminalText(named)} ${where}`}`,
        );
    }
    for (const item of unreasoned.imports) {
        lines.push(`- [import/${item.status}] ${terminalText(item.iri)}`);
    }
    return lines;
}

export function renderCheckProjectReport(report: CheckProjectReport): string {
    const lines = [
        `Erden check ${terminalText(report.manifest.alias)}: ${report.outcome.toUpperCase()}`,
        `Manifest: ${terminalText(report.manifest.file)}`,
        `Ontology: ${terminalText(report.manifest.canonicalIri)}`,
        `Reasoner: ${terminalText(report.reasoning.tool.name)}@${terminalText(report.reasoning.tool.version)} (${report.reasoning.outcome}${report.reasoning.consistency === null ? '' : `, ${report.reasoning.consistency}`})`,
        ...(report.reasoning.completeness === undefined
            ? []
            : ['Completeness: checked at qualification, not on this run']),
        '',
        stageLine('Sources', report.stages.sources),
        stageLine('Reasoning', report.stages.reasoning),
        stageLine('Core ontology', report.stages.core),
        stageLine('SHACL', report.stages.shacl),
        stageLine('Competency questions', report.stages.competencyQuestions),
        stageLine('Citations', report.stages.citations),
    ];
    const failures: string[] = [];
    for (const iri of report.stages.core.borrowedTerms?.missing ?? []) {
        failures.push(`[core] borrowed term lacks a declaration: ${terminalText(iri)}`);
    }
    for (const finding of report.stages.core.propertyDomainRange?.findings ?? []) {
        failures.push(`[core] ${terminalText(finding.property)} is missing ${finding.missing}`);
    }
    for (const finding of report.stages.shacl.details?.findings ?? []) {
        if (finding.severity === 'Violation') {
            failures.push(
                `[shacl] ${terminalText(finding.message)}${finding.focus === null ? '' : ` (focus: ${terminalText(finding.focus)})`}`,
            );
        }
    }
    const unsupported = report.stages.shacl.details?.unsupported ?? [];
    if (unsupported.length > 0) {
        failures.push(
            `[shacl/${SHACL_UNSUPPORTED_CONSTRUCT_CODE}] the SHACL step was refused and no shape was checked: ${plural(unsupported.length, 'statement')} in the shapes use${unsupported.length === 1 ? 's' : ''} SHACL the bundled engine cannot run`,
        );
        for (const item of unsupported) {
            const where =
                item.location === undefined
                    ? item.file
                    : `${item.location.file}:${String(item.location.line)}:${String(item.location.column)}`;
            failures.push(
                `${terminalText(where)} [shacl/${item.kind}] ${item.shape === null ? 'the shapes graph' : terminalText(item.shape)} ${terminalText(item.message)} (${terminalText(item.construct)})`,
            );
        }
    }
    for (const selfTest of report.stages.shacl.details?.selfTest ?? []) {
        if (!selfTest.fired) {
            failures.push(
                `[shacl] self-test did not fire for ${terminalText(selfTest.shape)}${selfTest.reason === null ? '' : `: ${terminalText(selfTest.reason)}`}`,
            );
        }
    }
    for (const question of report.stages.competencyQuestions.details?.questions ?? []) {
        if (question.blocking) {
            failures.push(`[competency-questions] ${terminalText(question.id)}: ${terminalText(question.reason)}`);
        }
    }
    for (const citation of report.stages.citations.details?.citations ?? []) {
        if (citation.blocking) {
            failures.push(`[citations] ${terminalText(citation.observation)}: ${citation.status}`);
            for (const diagnostic of citation.metadataDiagnostics) {
                failures.push(
                    `[citations] ambiguous ${terminalText(diagnostic.predicate)}: ${diagnostic.values.map(terminalText).join(', ')}`,
                );
            }
        }
    }
    if (report.stages.reasoning.status === 'failed') {
        for (const code of report.stages.reasoning.failureCodes) {
            failures.push(`[reasoning] ${terminalText(code)}`);
        }
        for (const diagnostic of report.reasoning.diagnostics) {
            if (diagnostic.severity === 'error') {
                failures.push(
                    `[reasoning/${terminalText(diagnostic.code)}] ${terminalText(diagnostic.message)}${diagnosticWhere(diagnostic)}`,
                );
            }
        }
        for (const line of limitLines(report)) {
            failures.push(terminalText(line));
        }
    }
    if (failures.length > 0) {
        lines.push('', 'Failures:');
        for (const failure of failures) {
            lines.push(`- ${failure}`);
        }
    }
    if (report.reasoning.unsatisfiableClasses.length > 0) {
        lines.push('', 'Unsatisfiable named classes:');
        for (const item of report.reasoning.unsatisfiableClasses) {
            lines.push(`- ${terminalText(item.classIri)}`);
        }
    }
    lines.push(...unreasonedLines(report));
    if (report.warnings.length > 0) {
        lines.push('', 'Warnings:');
        for (const warning of report.warnings) {
            lines.push(`- [${warning.stage}/${terminalText(warning.code)}] ${terminalText(warning.message)}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

export function renderCheckProjectError(error: CheckProjectOperationalError): string {
    const lines = [
        `Erden check could not complete [${error.stage}/${terminalText(error.code)}]: ${terminalText(error.message)}`,
    ];
    for (const diagnostic of error.diagnostics) {
        const location =
            diagnostic.file === null
                ? ''
                : `${terminalText(diagnostic.file)}${diagnostic.line === null ? '' : `:${String(diagnostic.line)}:${String(diagnostic.column ?? 1)}`} `;
        lines.push(`- ${location}[${terminalText(diagnostic.code)}] ${terminalText(diagnostic.message)}`);
    }
    return `${lines.join('\n')}\n`;
}
