import { createHash } from 'node:crypto';

/**
 * Canonical, versioned identity of the Erden validation pipeline which writes and
 * consumes v1 lockfiles. The trailing LF is part of the authenticated document.
 */
export const ERDEN_VALIDATOR_PROFILE_VERSION = '1.0.0' as const;

export const ERDEN_VALIDATOR_PROFILE_DOCUMENT = `${JSON.stringify({
    format: 'erden.validator-profile/v1',
    version: ERDEN_VALIDATOR_PROFILE_VERSION,
    checkReportFormat: 'erden.check-report/v1',
    lockfileVersion: 1,
    manifestSchemaVersion: 1,
    packageManifestFormat: 'erden.package-manifest/v1',
})}\n`;

export const ERDEN_VALIDATOR_PROFILE_SHA256 =
    '6b7bf9de052e8bef68025cc0c6102bb5b4bc04dad929d4278aa1d96ee2584519' as const;

export function assertValidatorProfileIntegrity(): void {
    const actual = createHash('sha256').update(ERDEN_VALIDATOR_PROFILE_DOCUMENT, 'utf8').digest('hex');
    if (actual !== ERDEN_VALIDATOR_PROFILE_SHA256) {
        throw new Error('The committed Erden validator profile failed its integrity check');
    }
}
