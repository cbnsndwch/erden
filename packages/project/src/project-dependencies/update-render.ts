import { isProjectDependenciesError, type ProjectDependenciesError } from './errors.js';
import { decodeProjectDependencyUpdateReport, type ProjectDependencyUpdateReport } from './update-report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderProjectDependencyUpdateReport(input: ProjectDependencyUpdateReport): string {
    const report = decodeProjectDependencyUpdateReport(input);
    return [
        report.target === null
            ? 'Updated the complete dependency graph'
            : `Updated ${terminalText(report.target.identifier)}`,
        `State: ${report.state.status} (${report.state.lockSha256})`,
        `Resolution: ${report.strategy}; ${String(report.packageChanges.length)} exact package change(s)`,
        `Installation: ${report.installation.materialization.status}`,
        `Outcome: ${report.outcome}`,
        '',
    ].join('\n');
}

export function renderProjectDependencyUpdateError(error: ProjectDependenciesError): string {
    if (!isProjectDependenciesError(error)) {
        return 'Erden dependency update failed [PROJECT_DEPENDENCIES_STATE_UNAVAILABLE]: The project dependency update could not complete\n';
    }
    const lines = [`Erden dependency update failed [${terminalText(error.code)}]: ${terminalText(error.message)}`];
    if (error.code === 'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED') {
        lines.push('The manifest and lock are committed; run erden install to retry installation.');
    }
    if (error.code === 'PROJECT_DEPENDENCIES_UPDATE_FROZEN_CONFLICT') {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'frozenCanonicalIris');
        const values =
            descriptor !== undefined && 'value' in descriptor && Array.isArray(descriptor.value)
                ? (descriptor.value as ReadonlyArray<unknown>)
                : [];
        for (const canonicalIri of values) {
            if (typeof canonicalIri === 'string') {
                lines.push(`Frozen shared package: ${terminalText(canonicalIri)}`);
            }
        }
    }
    return `${lines.join('\n')}\n`;
}
