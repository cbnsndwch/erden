import type { InitProjectError } from './errors.js';
import type { InitProjectReport } from './report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderInitProjectReport(report: InitProjectReport): string {
    const lines = [
        `Initialized ${terminalText(report.manifest.alias)} (${terminalText(report.manifest.canonicalIri)})`,
        ...report.files.map((file) => `- ${terminalText(file.path)}`),
    ];
    return `${lines.join('\n')}\n`;
}

export function renderInitProjectError(error: InitProjectError): string {
    return `Erden init failed [${terminalText(error.code)}]: ${terminalText(error.message)}\n`;
}
