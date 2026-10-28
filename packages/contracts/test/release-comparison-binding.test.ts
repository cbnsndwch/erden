import { describe, expect, it } from 'vitest';

import {
    COMPARISON_POLICY,
    ReleaseComparisonError,
    decodeReleaseComparisonSelection,
    isReleaseComparisonError,
    type ComparisonBasisV1,
    type ComparisonBindingV1,
} from '../src/index.js';

function basis(version = '0.1.0-eval.1', archive = 'a'): ComparisonBasisV1 {
    return {
        schema: 'erden.comparison-basis/v1',
        release: {
            archiveSha256: archive.repeat(64),
            canonicalIri: 'https://example.test/ontology',
            registryOrigin: 'https://registry.example',
            version,
        },
        manifestSha256: 'b'.repeat(64),
        dependencies: [],
        toolchain: {
            validator: { version: '0.1.0-eval.1', sha256: 'c'.repeat(64) },
            reasoner: { version: '0.1.0-eval.1', sha256: 'd'.repeat(64) },
        },
        reasoningProfile: { id: 'erden.reasoning-profile/v1', sha256: 'e'.repeat(64) },
        validationPolicy: { id: 'erden.validation-policy/v1', sha256: 'f'.repeat(64) },
    };
}
function binding(): ComparisonBindingV1 {
    return {
        schema: 'erden.comparison-binding/v1',
        comparisonPolicy: COMPARISON_POLICY,
        compatibility: 'not-assessed',
        before: basis(),
        after: basis('0.1.0-eval.2', '1'),
    };
}
function rejected(operation: () => unknown): void {
    try {
        operation();
        throw new Error('Expected comparison refusal');
    } catch (error) {
        expect(isReleaseComparisonError(error)).toBe(true);
        expect(error).toMatchObject({
            code: 'COMPARISON_INPUT_INVALID',
            message: 'The release comparison input is invalid',
        });
        expect(error).not.toHaveProperty('cause');
    }
}

describe('exact release comparison binding contract', () => {
    it('rejects two archives for one version and one archive for two versions', () => {
        const value = binding();
        for (const change of [
            { version: value.before.release.version },
            { archiveSha256: value.before.release.archiveSha256 },
        ]) {
            rejected(() =>
                decodeReleaseComparisonSelection({
                    before: value.before.release,
                    after: { ...value.after.release, ...change },
                }),
            );
        }
    });
    it('recognizes only locally constructed fixed failures', () => {
        const error = new ReleaseComparisonError('COMPARISON_STATE_CONFLICT');
        expect(isReleaseComparisonError(error)).toBe(true);
        expect(isReleaseComparisonError({ code: error.code, message: error.message, name: error.name })).toBe(false);
        expect(isReleaseComparisonError(new Error('private source path'))).toBe(false);
    });
});
