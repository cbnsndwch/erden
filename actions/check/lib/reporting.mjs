import { appendFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const STAGES = ['sources', 'core', 'reasoning', 'shacl', 'competencyQuestions', 'citations'];

function commandText(value) {
    return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export function annotate(level, message, file) {
    const property = file ? ` file=${commandText(file).replaceAll(':', '%3A').replaceAll(',', '%2C')}` : '';
    process.stdout.write(`::${level}${property}::${commandText(String(message).slice(0, 4000))}\n`);
}

export function markdown(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('|', '&#124;')
        .replaceAll('`', '&#96;')
        .replaceAll('[', '&#91;')
        .replaceAll(']', '&#93;')
        .replace(/[\r\n]+/gu, ' ');
}

export function checkReport(stdout, exitCode) {
    const report = JSON.parse(stdout);
    if (report?.schema !== 'erden.check-report/v1' || !['passed', 'failed'].includes(report.outcome)) {
        throw new Error('The CLI did not produce a supported erden.check-report/v1 report');
    }
    if (
        !STAGES.every(
            (name) =>
                ['passed', 'failed', 'skipped', 'not-run'].includes(report.stages?.[name]?.status) &&
                Array.isArray(report.stages[name].failureCodes) &&
                report.stages[name].failureCodes.every((code) => typeof code === 'string'),
        )
    ) {
        throw new Error('The check report is missing valid stage summaries');
    }
    const failed = STAGES.some((name) => report.stages[name].status === 'failed');
    if (failed !== (report.outcome === 'failed') || exitCode !== (failed ? 1 : 0)) {
        throw new Error('The check report outcome, stage statuses and process exit code disagree');
    }
    return report;
}

export function reportAnnotations(report, project, workspace) {
    function fileInCheckout(file) {
        if (typeof file !== 'string') {
            return undefined;
        }
        const path = relative(workspace, resolve(project, file));
        return isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')
            ? undefined
            : path.replaceAll('\\', '/');
    }
    for (const stage of STAGES) {
        if (report.stages[stage].status === 'failed') {
            annotate('error', `Erden ${stage}: ${report.stages[stage].failureCodes.join(', ')}`);
        }
    }
    const sources = new Map(
        (report.sources?.files ?? [])
            .filter((source) => source.id.startsWith('root:'))
            .map((source) => [source.id, source.file]),
    );
    for (const finding of (report.stages.shacl.details?.findings ?? [])
        .filter((item) => item.severity === 'Violation')
        .slice(0, 20)) {
        annotate('error', `SHACL: ${finding.message}`, fileInCheckout(sources.get(finding.shapeSourceIds?.[0])));
    }
    for (const question of (report.stages.competencyQuestions.details?.questions ?? [])
        .filter((item) => item.blocking === true)
        .slice(0, 20)) {
        annotate(
            'error',
            `Competency question: ${question.reason}`,
            question.owner?.role === 'dependency' ? undefined : fileInCheckout(question.file),
        );
    }
    for (const warning of (report.warnings ?? []).slice(0, 20)) {
        annotate('warning', `Erden ${warning.stage} [${warning.code}]: ${warning.message}`);
    }
}

export function saveWorkflowResult(env, result, report) {
    if (env.GITHUB_OUTPUT) {
        for (const [name, value] of Object.entries({
            outcome: result.outcome,
            'exit-code': result.exitCode,
            'report-path': result.reportPath,
            'reports-path': result.reportsPath,
        })) {
            if (/[\r\n]/u.test(String(value))) {
                throw new Error('A workflow output unexpectedly contains a newline');
            }
            appendFileSync(env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
        }
    }
    const lines = [
        '## Erden validation',
        '',
        `**Outcome:** ${markdown(result.outcome)} · **Phase:** ${markdown(result.phase)} · **Exit code:** ${String(result.exitCode)}`,
        '',
        `Project: ${markdown(result.project ?? '(not selected)')}`,
        `CLI version: ${markdown(result.version ?? '(not selected)')}`,
        '',
    ];
    if (result.message) {
        lines.push(markdown(result.message), '');
    }
    if (report) {
        lines.push('| Stage | Result | Failure codes |', '| --- | --- | --- |');
        for (const name of STAGES) {
            lines.push(
                `| ${name} | ${report.stages[name].status} | ${markdown(report.stages[name].failureCodes.join(', '))} |`,
            );
        }
        for (const warning of (report.warnings ?? []).slice(0, 20)) {
            lines.push('', `Warning (${markdown(warning.code)}): ${markdown(warning.message)}`);
        }
    }
    lines.push(
        '',
        'The reports-path output contains the full reports and phase logs. Upload it in a subsequent step with always().',
        '',
    );
    if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n'));
    }
}
