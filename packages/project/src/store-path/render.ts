import type { StorePathError } from './errors.js';
import { decodeStorePathReport, type StorePathReport } from './report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderStorePathReport(report: StorePathReport): string {
    return `${decodeStorePathReport(report).storeRoot}\n`;
}

export function renderStorePathError(error: StorePathError): string {
    return `Erden store path failed [${terminalText(error.code)}]: ${terminalText(error.message)}\n`;
}
