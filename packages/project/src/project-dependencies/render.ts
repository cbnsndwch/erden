import { isProjectDependenciesError, type ProjectDependenciesError } from './errors.js';
import { decodeProjectDependenciesReport, type ProjectDependenciesReport } from './report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderProjectDependenciesReport(input: ProjectDependenciesReport): string {
    const report = decodeProjectDependenciesReport(input);
    const warnings = report.warnings.map((warning) => `Warning: ${terminalText(warning)}`);
    return [
        `${report.operation === 'add' ? 'Added' : 'Removed'} ${terminalText(report.dependency.identifier)}`,
        `State: ${report.state.status} (${report.state.lockSha256})`,
        `Resolution: ${report.resolution}; ${String(report.packageChanges.length)} exact package change(s)`,
        `Installation: ${report.installation.materialization.status}`,
        ...warnings,
        '',
    ].join('\n');
}

export function renderProjectDependenciesError(error: ProjectDependenciesError): string {
    if (!isProjectDependenciesError(error)) {
        return 'Erden dependency change failed [PROJECT_DEPENDENCIES_STATE_UNAVAILABLE]: The project dependency change could not complete\n';
    }
    const lines = [`Erden dependency change failed [${terminalText(error.code)}]: ${terminalText(error.message)}`];
    if (error.code === 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED') {
        lines.push('The manifest and lock are committed; run erden install to retry installation.');
    }
    return `${lines.join('\n')}\n`;
}
