import { REASONER_SOURCE_BUILD_GUIDANCE, REASONER_SOURCE_BUILD_MISSING } from '../toolchain-guidance.js';

import type { DoctorOperationalError } from './errors.js';
import type { DoctorReport } from './report.js';

function terminalText(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
}

function renderShaclEngine(shacl: NonNullable<DoctorReport['shaclEngine']>): string {
    const state =
        shacl.availability === 'available'
            ? `${shacl.toolVersion ?? '<unknown>'} ${shacl.target ?? '<unknown>'} ${shacl.digest ?? '<unknown>'}`
            : `unavailable (${shacl.failureCode ?? 'UNKNOWN_FAILURE'})`;
    return `SHACL engine: ${terminalText(state)} — ${shacl.selfTest.status === 'passed' ? 'known-answer passed' : 'known-answer failed'}${shacl.expectedPlatformPackage === null ? '' : ` (expected ${terminalText(shacl.expectedPlatformPackage)})`}`;
}

export function renderDoctorReport(report: DoctorReport): string {
    const reasoner =
        report.reasoner.availability === 'available'
            ? `${report.reasoner.toolVersion ?? '<unknown>'} ${report.reasoner.target ?? '<unknown>'} ${report.reasoner.digest ?? '<unknown>'}`
            : `unavailable (${report.reasoner.failureCode ?? 'UNKNOWN_FAILURE'})`;
    return [
        `Erden doctor: ${report.outcome.toUpperCase()}`,
        `Node: ${terminalText(report.node.runtimeVersion)} (required ${report.node.requiredVersion}) — ${report.node.status}`,
        `Runtime: ${terminalText(report.reasoner.runtime.platform)}/${terminalText(report.reasoner.runtime.arch)}${report.reasoner.runtime.libc === null ? '' : `/${terminalText(report.reasoner.runtime.libc)}`}`,
        `Reasoner: ${terminalText(reasoner)} — ${report.reasoner.selfTest.status === 'passed' ? 'known-answer passed' : 'known-answer failed'}${report.reasoner.expectedPlatformPackage === null ? '' : ` (expected ${terminalText(report.reasoner.expectedPlatformPackage)})`}`,
        ...(report.reasoner.supportedPlatforms === null
            ? []
            : [`Supported platforms: ${terminalText(report.reasoner.supportedPlatforms.join(', '))}`]),
        ...(report.reasoner.failureCode === REASONER_SOURCE_BUILD_MISSING
            ? [`Next step: ${REASONER_SOURCE_BUILD_GUIDANCE}`]
            : []),
        ...(report.shaclEngine === undefined ? [] : [renderShaclEngine(report.shaclEngine)]),
        '',
    ].join('\n');
}

export function renderDoctorError(error: DoctorOperationalError): string {
    return `Erden doctor could not complete [${error.code}]: ${terminalText(error.message)}\n`;
}
