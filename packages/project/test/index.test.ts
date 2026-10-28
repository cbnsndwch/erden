import { Effect } from 'effect';
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as project from '../src/index.js';
import {
    defineApplicationOperation,
    DependencyArchiveReader,
    ProjectDependencyStateService,
    ProjectDependenciesService,
    StoreMaintenanceService,
    decodeStoreStatusReport,
    decodeProjectDependencyUpdateReport,
    parseAddDependencySpec,
    recoverProjectDependencyState,
} from '../src/index.js';

describe('@erden/project', () => {
    it('exports the local-project services the CLI runs, and not the contracts', () => {
        expect(project.makeCheckProjectService).toBeTypeOf('function');
        expect(project.makePackProjectService).toBeTypeOf('function');
        expect(project.makeManifestService).toBeTypeOf('function');
        expect('normalizeManifestV1' in project).toBe(false);
    });

    it('exports the paired project dependency state foundation', () => {
        expect(ProjectDependencyStateService).toBeDefined();
        expect(recoverProjectDependencyState).toBeTypeOf('function');
    });

    it('exports the dependency lifecycle operations and rightmost-at parser', () => {
        expect(DependencyArchiveReader).toBeDefined();
        expect(project.makeNodeInstallProjectServiceFromReleaseIndex).toBeTypeOf('function');
        expect(project.makeNodeProjectDependenciesServiceFromReleaseIndex).toBeTypeOf('function');
        expect(ProjectDependenciesService).toBeDefined();
        expect(parseAddDependencySpec('@example/layer@^1.0.0')).toEqual({
            identifier: '@example/layer',
            range: '^1.0.0',
        });
        expect(parseAddDependencySpec('https://user@example.test/layer@*')).toEqual({
            identifier: 'https://user@example.test/layer',
            range: '*',
        });
        expect(decodeProjectDependencyUpdateReport).toBeTypeOf('function');
    });

    it('exports path-free local store status and prune operations', () => {
        expect(StoreMaintenanceService).toBeDefined();
        expect(decodeStoreStatusReport).toBeTypeOf('function');
    });

    it('preserves a typed successful Effect operation', () => {
        const operation = defineApplicationOperation('ReadWorkspace', Effect.succeed({ status: 'ready' as const }));

        expect(operation.name).toBe('ReadWorkspace');
        expect(Object.isFrozen(operation)).toBe(true);
        expect(Effect.runSync(operation.effect)).toEqual({ status: 'ready' });
        expectTypeOf(operation.name).toEqualTypeOf<'ReadWorkspace'>();
    });

    it('preserves a typed application failure without throwing at definition time', () => {
        const failure = { _tag: 'WorkspaceUnavailable' as const, path: '/workspace' };
        const operation = defineApplicationOperation('ReadWorkspace', Effect.fail(failure));

        expect(Effect.runSync(Effect.flip(operation.effect))).toEqual(failure);
        expectTypeOf(operation.effect).toEqualTypeOf<Effect.Effect<never, typeof failure>>();
    });
});
