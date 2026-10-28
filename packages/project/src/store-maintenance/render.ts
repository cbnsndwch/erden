import type { StoreMaintenanceError } from './errors.js';
import {
    decodeStorePruneReport,
    decodeStoreStatusReport,
    type StorePruneReport,
    type StoreStatusReport,
} from './report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

export function renderStoreStatusReport(input: StoreStatusReport): string {
    const report = decodeStoreStatusReport(input);
    return [
        `Erden store: ${report.outcome}`,
        `Registrations: ${String(report.registrations.current.length)} current, ${String(report.registrations.superseded.length)} superseded, ${String(report.registrations.orphaned.length)} orphaned, ${String(report.registrations.stale.length)} stale`,
        `Objects: ${String(report.objects.referenced.length)} referenced, ${String(report.objects.unreferenced.length)} unreferenced, ${String(report.objects.missingReferenced.length)} missing referenced, ${String(report.objects.corrupt.length)} corrupt, ${String(report.objects.busy.length)} busy`,
        '',
    ].join('\n');
}

export function renderStoreMaintenanceError(error: StoreMaintenanceError): string {
    return `Erden store failed [${terminalText(error.code)}]: ${terminalText(error.message)}\n`;
}

export function renderStorePruneReport(input: StorePruneReport): string {
    const report = decodeStorePruneReport(input);
    return [
        `Erden store prune: ${report.outcome}`,
        report.warning,
        `Registrations: ${String(report.registrations.total)}`,
        `Objects: ${String(report.objects.total)} (${report.objects.logicalBytes} logical bytes)`,
        '',
    ].join('\n');
}
