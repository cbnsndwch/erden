import type { PackProjectError } from './errors.js';
import { decodePackProjectReport, type PackProjectReport } from './report.js';

function terminal(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderPackProjectReport(input: PackProjectReport): string {
    const report = decodePackProjectReport(input);
    return [
        `Packed ${terminal(report.project.alias)}@${terminal(report.version)} (${terminal(report.project.canonicalIri)})`,
        `Output: ${terminal(report.output.path)} (${report.output.status}; ${report.output.cleanup})`,
        `Archive SHA-256: ${report.archive.sha256}`,
        `Archive bytes: ${String(report.archive.byteSize)}; files: ${String(report.archive.fileCount)}; direct dependencies: ${String(report.archive.directDependencyCount)}`,
        '',
    ].join('\n');
}

export function renderPackProjectError(error: PackProjectError): string {
    return `Erden pack failed [${terminal(error.code)}]: ${terminal(error.message)}\n`;
}
