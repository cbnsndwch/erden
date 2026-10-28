import {
    InstallProjectTransactionPendingError,
    InstallProjectUnavailableError,
    type InstallProjectError,
} from './errors.js';
import { decodeInstallProjectReport, type InstallProjectReport } from './report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderInstallProjectReport(report: InstallProjectReport): string {
    const checked = decodeInstallProjectReport(report);
    return [
        `Installed ${terminalText(checked.project.alias)} (${terminalText(checked.project.canonicalIri)})`,
        `Lock: ${checked.lock.status} ${checked.lock.sha256} (${checked.lock.cleanup})`,
        `Packages: ${String(checked.packages.total)} total, ${String(checked.packages.reused.length)} reused, ${String(checked.packages.fetched.length)} fetched, ${String(checked.packages.repaired.length)} repaired`,
        `Materialization: ${checked.materialization.status} (${checked.materialization.cleanup}; clone ${String(checked.materialization.strategies.clone)}, hardlink ${String(checked.materialization.strategies.hardlink)}, copy ${String(checked.materialization.strategies.copy)})`,
        '',
    ].join('\n');
}

export function renderInstallProjectError(error: InstallProjectError): string {
    const lines = [`Erden install failed [${terminalText(error.code)}]: ${terminalText(error.message)}`];
    if (error instanceof InstallProjectUnavailableError) {
        for (const digest of error.availability.missing) {
            lines.push(`- missing ${digest}`);
        }
        for (const digest of error.availability.corrupt) {
            lines.push(`- corrupt ${digest}`);
        }
        for (const digest of error.availability.busy) {
            lines.push(`- busy ${digest}`);
        }
    }
    if (error instanceof InstallProjectTransactionPendingError) {
        for (const name of error.residue) {
            lines.push(`- leftover ${terminalText(name)}`);
        }
        lines.push(
            'Check that the project manifest and erden.lock are the versions you want, delete the leftover .erden.dependencies.* files in the project directory, then run erden install again.',
        );
    }
    return `${lines.join('\n')}\n`;
}
