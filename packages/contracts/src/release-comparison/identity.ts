import { isCanonicalOntologyIri, isRegistryOrigin, normalizeRegistryOrigin } from '../manifest/index.js';
import { decodeRegistryExactVersion } from '../registry-release-index/model.js';

import {
    COMPARISON_BINDING_LIMITS as LIMITS,
    type ComparisonReleaseIdentity,
    type ReleaseComparisonSelection,
} from './model.js';
import { comparisonDigest, comparisonInvalid, comparisonRecord, comparisonText } from './shape.js';

export function decodeComparisonReleaseIdentity(input: unknown): ComparisonReleaseIdentity {
    try {
        const value = comparisonRecord(input, ['archiveSha256', 'canonicalIri', 'registryOrigin', 'version']);
        const canonicalIri = comparisonText(value['canonicalIri'], LIMITS.maxIriBytes);
        const registryOrigin = comparisonText(value['registryOrigin'], LIMITS.maxIriBytes);
        if (
            !isCanonicalOntologyIri(canonicalIri) ||
            /[\s<>"{}|^`\\\u0000-\u001f\u007f-\u009f]/u.test(canonicalIri) ||
            !isRegistryOrigin(registryOrigin) ||
            normalizeRegistryOrigin(registryOrigin) !== registryOrigin
        ) {
            return comparisonInvalid();
        }
        return Object.freeze({
            archiveSha256: comparisonDigest(value['archiveSha256']),
            canonicalIri,
            registryOrigin,
            version: decodeRegistryExactVersion(comparisonText(value['version'], LIMITS.maxVersionBytes)),
        });
    } catch {
        return comparisonInvalid();
    }
}

export function assertComparisonReleasePair(before: ComparisonReleaseIdentity, after: ComparisonReleaseIdentity): void {
    if (
        before.registryOrigin !== after.registryOrigin ||
        before.canonicalIri !== after.canonicalIri ||
        (before.version === after.version) !== (before.archiveSha256 === after.archiveSha256)
    ) {
        comparisonInvalid();
    }
}

export function decodeReleaseComparisonSelection(input: unknown): ReleaseComparisonSelection {
    try {
        const value = comparisonRecord(input, ['before', 'after']);
        const before = decodeComparisonReleaseIdentity(value['before']);
        const after = decodeComparisonReleaseIdentity(value['after']);
        assertComparisonReleasePair(before, after);
        return Object.freeze({ before, after });
    } catch {
        return comparisonInvalid();
    }
}
