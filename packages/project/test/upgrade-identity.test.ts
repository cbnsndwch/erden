import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    checkLockConsistency,
    makeCurrentToolchainService,
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    parseLockfile,
    serializeLockfile,
    type LoadedManifestV1,
    type LockToolchain,
} from '@erden/contracts';
import {
    makeNodeOntologyPorts,
    makeOntologyService,
    makeReasonerService,
    nodeReasonerService,
    type ReasonerArtifact,
} from '@erden/ontology';
import { encodePackage, packageCodec } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    DependencyResolutionError,
    makeCheckProjectService,
    makeDependencyResolver,
    makeInstallProjectService,
    makeManifestService,
    makeNodePackFileSystemPort,
    makePackProjectService,
    nodeLocalPackageStore,
    nodeProjectDependencyStateService,
    nodeTransactionResidue,
    renderCheckProjectError,
    renderInstallProjectError,
    unavailableDependencyRegistry,
    type DependencyCatalogShape,
    type InstallProjectError,
    type PublishedPackageRecord,
} from '../src/index.js';

import { answeringReasonerPort } from './support/answering-reasoner.js';

// The 0.3.0 reasoner identity (profile V2, the Horn calculus) replaces the 0.2.0 one. Every lock
// and every published release records the reasoner version and its calculus digest, so each one written under 0.2.0
// must be re-locked or republished.

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

/** The toolchain the bundled 0.3.0 reasoner reports: what this release writes into every lock and release. */
const NEW: LockToolchain = Effect.runSync(nodeCurrentToolchainService.inspect());

/** The calculus contract of `reasoner/erden-reasoner/src/lib.rs` at 0.2.0; every 0.2.0 lock stores its SHA-256. */
const OLD_CALCULUS_CONTRACT =
    'purrdf-entail=0.12.0\nsource=https://github.com/Blackcat-Informatics/purrdf\nrev=dfb1df73199668720116dfbc737c0585e23afb5e\nservices=classify-hierarchy,satisfiability-per-signature,consistency-per-data-range\n';

/** The toolchain the 0.2.0 reasoner reported, which every lock and release written before 0.3.0 carries. */
const OLD: LockToolchain = Object.freeze({
    validator: NEW.validator,
    reasoner: Object.freeze({
        version: '0.2.0+purrdf.0.12.0.dfb1df7',
        sha256: createHash('sha256').update(OLD_CALCULUS_CONTRACT).digest('hex'),
    }),
});

/** The calculus contract of the bundled 0.3.0 reasoner (`reasoner/qualification/horn-identity.ts`). */
const NEW_CALCULUS_CONTRACT = `${OLD_CALCULUS_CONTRACT}erden-calculi=v1-closure,horn-saturation\n`;

const newToolchain = makeCurrentToolchainService(() => NEW);

const MANIFEST: LoadedManifestV1['manifest'] = {
    schemaVersion: 1,
    canonicalIri: 'https://example.test/upgrade',
    alias: '@example/upgrade',
    ownedIriPrefixes: ['https://example.test/upgrade#'],
    sources: { ontology: ['ontology.ttl'], shapes: [], competencyQuestions: [] },
    citationRoots: {},
    dependencies: {},
};

/** A project whose erden.lock was written by the 0.2.0 toolchain. */
function projectLockedUnderOldIdentity(): string {
    const root = makeTestTempRoot('erden-upgrade-identity-');
    tempRoots.push(root);
    writeFileSync(
        join(root, 'ontology.ttl'),
        `@prefix ex: <https://example.test/upgrade#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://example.test/upgrade> a owl:Ontology ; rdfs:label "upgrade" .
ex:A a owl:Class ; rdfs:label "A" .
`,
        'utf8',
    );
    writeFileSync(join(root, 'erden.config.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`, 'utf8');
    writeFileSync(join(root, 'erden.lock'), serializeLockfile(makeEmptyLockfile(MANIFEST, OLD)), 'utf8');
    return root;
}

/** A check under the 0.3.0 toolchain, on the bundled 0.3.0 reasoner unless `reasoner` names another. */
function checkService(reasoner = nodeReasonerService) {
    return makeCheckProjectService(
        makeManifestService(),
        makeOntologyService(makeNodeOntologyPorts()),
        reasoner,
        nodeProjectDependencyStateService,
        newToolchain,
    );
}

/** A reasoner that answers as the 0.2.0 identity, standing in for the 0.2.0 build a re-locked project no longer names. */
const oldReasoner = makeReasonerService(answeringReasonerPort(), () =>
    Object.freeze({
        path: '/nonexistent/erden-reasoner-0.2.0',
        requiredTool: Object.freeze({
            name: 'erden-reasoner',
            version: OLD.reasoner.version,
            executableDigest: `sha256:${'a'.repeat(64)}`,
            adapterDigest: `sha256:${'b'.repeat(64)}`,
            calculusDigest: `sha256:${OLD.reasoner.sha256}`,
        }) as unknown as ReasonerArtifact['requiredTool'],
    }),
);

function installService(root: string) {
    return makeInstallProjectService(
        nodeProjectDependencyStateService,
        newToolchain,
        unavailableDependencyRegistry,
        nodeLocalPackageStore,
        Object.freeze({ defaultStoreRoot: () => join(root, 'store'), transactionResidue: nodeTransactionResidue }),
    );
}

describe('upgrading to the 0.3.0 reasoner identity', () => {
    it('differs from the 0.2.0 identity in the reasoner only', () => {
        expect(NEW.reasoner).toEqual({
            version: '0.3.0+purrdf.0.12.0.dfb1df7',
            sha256: createHash('sha256').update(NEW_CALCULUS_CONTRACT).digest('hex'),
        });
        expect(OLD.reasoner).toEqual({
            version: '0.2.0+purrdf.0.12.0.dfb1df7',
            sha256: '830c38b936bb8a3655bcc15a1af4141384465a62a5f3c7993e067f77a8ddb3fd',
        });
        expect(NEW.validator).toEqual(OLD.validator);
    });

    it('reports a lock written under 0.2.0 as toolchain-changed', () => {
        const lock = makeEmptyLockfile(MANIFEST, OLD);
        expect(checkLockConsistency(MANIFEST, OLD, lock)).toEqual({ status: 'consistent', reasons: [] });
        expect(checkLockConsistency(MANIFEST, NEW, lock)).toEqual({ status: 'stale', reasons: ['toolchain-changed'] });
    });

    it('has erden check name the change and the command, then erden install re-locks and check passes', async () => {
        const root = projectLockedUnderOldIdentity();
        const before = readFileSync(join(root, 'erden.lock'));

        const stale = await Effect.runPromise(Effect.flip(checkService().check({ from: root, offline: true })));
        expect(stale.code).toBe('CHECK_LOCK_STALE');
        const rendered = renderCheckProjectError(stale);
        expect(rendered).toContain('(toolchain-changed)');
        expect(rendered).toContain(
            `erden.lock was written with reasoner ${OLD.reasoner.version}; this Erden release has reasoner ${NEW.reasoner.version}. Run erden install to re-lock the project with the current toolchain, then check again.`,
        );
        expect(rendered).not.toContain('validator');
        expect(readFileSync(join(root, 'erden.lock')).equals(before)).toBe(true);

        const installed = await Effect.runPromise(installService(root).install({ from: root, offline: true }));
        expect(installed.outcome).toBe('installed');
        const relocked = parseLockfile(readFileSync(join(root, 'erden.lock')));
        expect(relocked.toolchain).toEqual(NEW);
        expect(checkLockConsistency(MANIFEST, NEW, relocked).status).toBe('consistent');

        // The re-locked project names the 0.3.0 reasoner, so a check on a 0.2.0 build is refused before reasoning
        // and a check on the bundled 0.3.0 build passes.
        const unlocked = await Effect.runPromise(
            Effect.flip(checkService(oldReasoner).check({ from: root, offline: true })),
        );
        expect(unlocked.code).toBe('CHECK_REASONER_NOT_LOCKED');
        const checked = await Effect.runPromise(checkService().check({ from: root, offline: true }));
        expect(checked.outcome).toBe('passed');
        expect(checked.reasoning.tool).toMatchObject({ version: NEW.reasoner.version });
    }, 60_000);

    it.each([
        [
            'a rebuilt reasoner of the same version',
            { validator: OLD.validator, reasoner: { version: OLD.reasoner.version, sha256: 'f'.repeat(64) } },
            `erden.lock was written with a different build of reasoner ${OLD.reasoner.version} than this Erden release has.`,
        ],
        [
            'a new validator',
            { validator: { version: '9.9.9', sha256: OLD.validator.sha256 }, reasoner: OLD.reasoner },
            `erden.lock was written with validator ${OLD.validator.version}; this Erden release has validator 9.9.9.`,
        ],
    ] as const)('names %s in the stale-lock guidance', async (_label, current, expected) => {
        const root = projectLockedUnderOldIdentity();
        const service = makeCheckProjectService(
            makeManifestService(),
            makeOntologyService(makeNodeOntologyPorts()),
            nodeReasonerService,
            nodeProjectDependencyStateService,
            makeCurrentToolchainService(() => current),
        );
        const stale = await Effect.runPromise(Effect.flip(service.check({ from: root, offline: true })));
        expect(stale.code).toBe('CHECK_LOCK_STALE');
        expect(renderCheckProjectError(stale)).toContain(
            `${expected} Run erden install to re-lock the project with the current toolchain, then check again.`,
        );
    });

    it('refuses to pack, and so to publish, with a stale lock, naming erden install and writing nothing', async () => {
        const root = projectLockedUnderOldIdentity();
        const output = join(root, 'upgrade-1.0.0.erdenpkg');
        const pack = makePackProjectService(
            nodeProjectDependencyStateService,
            newToolchain,
            packageCodec,
            makeNodePackFileSystemPort(),
        );
        const failure = await Effect.runPromise(
            Effect.flip(pack.pack({ version: '1.0.0', from: root, outputPath: output })),
        );
        expect(failure.code).toBe('PACK_PROJECT_LOCK_INVALID');
        expect(failure.message).toContain('run erden install');
        expect(existsSync(output)).toBe(false);
    });

    it('refuses a dependency release published under 0.2.0 and says it must be republished', async () => {
        const dependency = 'https://example.test/dependency';
        const encoded = encodePackage({
            canonicalIri: dependency,
            version: '1.0.0',
            dependencies: [],
            validator: OLD.validator,
            reasoner: OLD.reasoner,
            files: [],
        });
        const release: PublishedPackageRecord = {
            canonicalIri: dependency,
            version: '1.0.0',
            archiveSha256: encoded.archiveSha256,
            manifest: encoded.manifest,
        };
        const catalog: DependencyCatalogShape = {
            resolveAlias: () => Promise.resolve(null),
            listPublished: () => Promise.resolve([release]),
        };
        const manifest = {
            ...MANIFEST,
            registry: 'https://registry.example',
            dependencies: { [dependency]: '^1.0.0' },
        };
        const resolver = makeDependencyResolver(catalog);

        await expect(Effect.runPromise(resolver.resolve({ manifest, toolchain: OLD }))).resolves.toBeDefined();
        const failure = await Effect.runPromise(Effect.flip(resolver.resolve({ manifest, toolchain: NEW })));
        expect(failure).toBeInstanceOf(DependencyResolutionError);
        expect(failure.code).toBe('toolchain-incompatible');
        expect(failure.message).toBe(
            `No release of ${dependency} was published under the current Erden toolchain (reasoner ${NEW.reasoner.version}, validator ${OLD.validator.version}); the dependency must be republished as a new version under the current toolchain before it can be installed, because a published version cannot be replaced`,
        );
    });

    function releaseUnder(dependency: string, version: string, toolchain: LockToolchain): PublishedPackageRecord {
        const encoded = encodePackage({
            canonicalIri: dependency,
            version,
            dependencies: [],
            validator: toolchain.validator,
            reasoner: toolchain.reasoner,
            files: [],
        });
        return { canonicalIri: dependency, version, archiveSha256: encoded.archiveSha256, manifest: encoded.manifest };
    }

    it('resolves a range to the new version an owner publishes under the current toolchain', async () => {
        const dependency = 'https://example.test/dependency';
        const catalog: DependencyCatalogShape = {
            resolveAlias: () => Promise.resolve(null),
            listPublished: () =>
                Promise.resolve([releaseUnder(dependency, '1.0.0', OLD), releaseUnder(dependency, '1.0.1', NEW)]),
        };
        const manifest = {
            ...MANIFEST,
            registry: 'https://registry.example',
            dependencies: { [dependency]: '^1.0.0' },
        };
        const resolved = await Effect.runPromise(makeDependencyResolver(catalog).resolve({ manifest, toolchain: NEW }));
        expect(resolved.lock.packages.map((node) => [node.canonicalIri, node.version])).toEqual([
            [dependency, '1.0.1'],
        ]);
    });

    it('tells a dependent pinned to an earlier-toolchain version to widen its requirement', async () => {
        const dependency = 'https://example.test/dependency';
        const catalog: DependencyCatalogShape = {
            resolveAlias: () => Promise.resolve(null),
            listPublished: () =>
                Promise.resolve([releaseUnder(dependency, '1.0.0', OLD), releaseUnder(dependency, '1.0.1', NEW)]),
        };
        const manifest = { ...MANIFEST, registry: 'https://registry.example', dependencies: { [dependency]: '1.0.0' } };
        const failure = await Effect.runPromise(
            Effect.flip(makeDependencyResolver(catalog).resolve({ manifest, toolchain: NEW })),
        );
        expect(failure.code).toBe('toolchain-incompatible');
        expect(failure.message).toBe(
            `Only releases of ${dependency} published under an earlier Erden toolchain (1.0.0) meet its requirements; the current toolchain (reasoner ${NEW.reasoner.version}, validator ${OLD.validator.version}) has 1.0.1, so widen the requirement to a version published under it`,
        );
    });

    it('shows the republish remedy when erden install meets such a dependency', async () => {
        const dependency = 'https://example.test/dependency';
        const encoded = encodePackage({
            canonicalIri: dependency,
            version: '1.0.0',
            dependencies: [],
            validator: OLD.validator,
            reasoner: OLD.reasoner,
            files: [],
        });
        const root = projectLockedUnderOldIdentity();
        const manifest = {
            ...MANIFEST,
            registry: 'https://registry.example',
            dependencies: { [dependency]: '^1.0.0' },
        };
        writeFileSync(join(root, 'erden.config.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const registry = Object.freeze({
            ...unavailableDependencyRegistry,
            resolveAlias: () => Promise.resolve(null),
            listPublished: () =>
                Promise.resolve([
                    {
                        canonicalIri: dependency,
                        version: '1.0.0',
                        archiveSha256: encoded.archiveSha256,
                        manifest: encoded.manifest,
                    },
                ]),
        });
        const service = makeInstallProjectService(
            nodeProjectDependencyStateService,
            newToolchain,
            registry,
            nodeLocalPackageStore,
            Object.freeze({ defaultStoreRoot: () => join(root, 'store'), transactionResidue: nodeTransactionResidue }),
        );
        let failure: InstallProjectError | undefined;
        try {
            await Effect.runPromise(service.install({ from: root }));
        } catch (cause) {
            failure = cause as InstallProjectError;
        }
        expect(failure?.code).toBe('INSTALL_PROJECT_RESOLUTION_FAILED');
        expect(renderInstallProjectError(failure as InstallProjectError)).toContain(
            'the dependency must be republished as a new version under the current toolchain',
        );
    }, 60_000);
});
