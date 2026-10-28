import type { ProjectPathError } from './errors.js';
import { decodeProjectPathReport, type ProjectPathReport } from './report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderProjectPathReport(report: ProjectPathReport): string {
    return `${decodeProjectPathReport(report).layer.path}\n`;
}

export function renderProjectPathError(error: ProjectPathError): string {
    return `Erden path failed [${terminalText(error.code)}]: ${terminalText(error.message)}\n`;
}
