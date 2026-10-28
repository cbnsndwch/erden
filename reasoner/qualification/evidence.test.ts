import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { REASONER_RELEASED } from '../distribution/src/index.js';
import { selectLicenses } from './license-policy.mjs';
import type { LicensePolicy } from './license-policy.mjs';

const qualification = import.meta.dirname;
function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(qualification, name), 'utf8')) as unknown;
}

interface Component { readonly 'bom-ref': string; readonly name: string; readonly type: string; readonly version: string }
interface Dependency { readonly dependsOn: ReadonlyArray<string>; readonly ref: string }
interface Sbom {
  readonly bomFormat: string;
  readonly components: ReadonlyArray<Component>;
  readonly dependencies: ReadonlyArray<Dependency>;
  readonly metadata: { readonly component: Component };
  readonly specVersion: string;
}
interface ReproRun { readonly bytes: number; readonly label: string; readonly sha256: string; readonly sourcePath: string }
interface ReproPackage { readonly bytes: number; readonly matchesAllRecordedRuns: boolean; readonly sha256: string; readonly sourcePath: string }
interface ReproPlatform { readonly package: ReproPackage; readonly result: string; readonly runs: ReadonlyArray<ReproRun> }
interface BinaryEvidence {
  readonly adapterCrateSourceTree: string;
  readonly cargoLockDigest: string;
  readonly linux: ReproPlatform;
  readonly notYetAvailable: ReadonlyArray<{ readonly package: string; readonly reason: string; readonly target: string }>;
  readonly qualificationBaseCommit: string;
  readonly qualificationReasonerCommitTree: string;
  readonly qualificationSourceCommit: string;
  readonly schemaVersion: number;
  readonly toolchain: { readonly rustc: string };
  readonly windows: NativeBuild;
  readonly linuxArm64: NativeBuild;
  readonly darwinArm64: NativeBuild;
  readonly crossPlatformDeterminism: {
    readonly excludedFields: ReadonlyArray<string>;
    readonly executables: Readonly<Record<string, { readonly sha256: string }>>;
    readonly requests: number;
    readonly result: string;
  };
}
type NativeBuild = ReproPlatform & {
  readonly build: { readonly adapterCrateSourceTree: string; readonly cargoLockDigest: string; readonly runnerLabel: string };
};
interface ValidationEvidence { readonly result: string; readonly schemaVersion: string; readonly validator: string }
interface GenerationEvidence { readonly checkouts: ReadonlyArray<string>; readonly result: string }

describe('reasoner qualification evidence', () => {
  test('CycloneDX graph has the real root and every stable locked identity', () => {
    const sbom = readJson('sbom.json') as Sbom;
    expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6' });
    expect(sbom.metadata.component).toMatchObject({
      'bom-ref': 'pkg:cargo/erden-reasoner@0.1.0',
      name: 'erden-reasoner',
      type: 'application',
      version: '0.1.0',
    });
    const references = new Set([sbom.metadata.component, ...sbom.components].map((component) => component['bom-ref']));
    expect(references.size).toBe(54);
    expect(sbom.dependencies).toHaveLength(54);
    for (const dependency of sbom.dependencies) {
      expect(references.has(dependency.ref)).toBe(true);
      expect(dependency.dependsOn.every((reference) => references.has(reference))).toBe(true);
    }
    expect(JSON.stringify(sbom)).not.toMatch(/[A-Z]:\\|\/home\/|\/Users\/|manifest_path|packageId/u);
  });

  test('official validation and two-checkout generation are recorded', () => {
    const validation = readJson('sbom-validation.json') as ValidationEvidence;
    expect(validation).toMatchObject({
      schemaVersion: 'CycloneDX 1.6 JSON',
      validator: 'CycloneDX/cyclonedx-cli',
    });
    expect(validation.result).toContain('BOM validated successfully.');
    expect(readJson('evidence-reproducibility.json') as GenerationEvidence).toMatchObject({
      checkouts: ['checkout-a', 'checkout-b'],
      result: 'byte-identical',
    });
  });

  test('license policy fails unknown, denied, unlicensed, and unselected expressions', () => {
    const policy = readJson('license-policy.json') as LicensePolicy;
    expect(selectLicenses('MIT OR Apache-2.0', policy, 'allowed')).toEqual(['MIT']);
    expect(() => selectLicenses(null, policy, 'unlicensed')).toThrow(/Unlicensed/u);
    expect(() => selectLicenses('GPL-3.0-only', policy, 'denied')).toThrow(/Denied/u);
    expect(() => selectLicenses('Made-Up-1.0', policy, 'unknown')).toThrow(/Unknown/u);
    expect(() => selectLicenses('MIT AND Apache-2.0', policy, 'unselected')).toThrow(/no approved selection/u);
  });

  test('every platform artifact varies both clean target and checkout path, and the four answer alike', () => {
    const evidence = readJson('binary-reproducibility.json') as BinaryEvidence;
    expect(evidence.schemaVersion).toBe(5);
    expect(evidence.toolchain.rustc).toBe('1.96.0');
    expect(evidence.qualificationBaseCommit).toBe('8c6db97adaf46fe76e628036d36bf18de906ec4b');
    expect(evidence.qualificationSourceCommit).toBe(evidence.qualificationBaseCommit);
    expect(evidence.qualificationReasonerCommitTree).toMatch(/^[0-9a-f]{40}$/u);
    expect(evidence.adapterCrateSourceTree).toMatch(/^[0-9a-f]{40}$/u);
    expect(evidence.notYetAvailable).toEqual([]);
    // Windows x64, Linux arm64 and macOS arm64 were built on their native GitHub runners from commits with the
    // accepted adapter crate and lock.
    for (const [platform, runnerLabel] of [
      [evidence.windows, 'windows-2025'],
      [evidence.linuxArm64, 'ubuntu-24.04-arm'],
      [evidence.darwinArm64, 'macos-15'],
    ] as const) {
      expect(platform.build).toMatchObject({
        runnerLabel,
        adapterCrateSourceTree: evidence.adapterCrateSourceTree,
        cargoLockDigest: evidence.cargoLockDigest,
      });
    }
    // The four executables answered the determinism request set alike, apart from their own digest.
    expect(evidence.crossPlatformDeterminism).toMatchObject({ result: 'identical', excludedFields: ['tool.executableDigest'] });
    expect(evidence.crossPlatformDeterminism.requests).toBeGreaterThanOrEqual(51);
    expect(Object.values(evidence.crossPlatformDeterminism.executables).map((item) => item.sha256).sort()).toEqual(
      [evidence.windows, evidence.linux, evidence.linuxArm64, evidence.darwinArm64].map((item) => item.package.sha256).sort(),
    );
    for (const platform of [evidence.windows, evidence.linux, evidence.linuxArm64, evidence.darwinArm64]) {
      expect(platform.result).toBe('byte-identical-and-package-matched');
      expect(new Set(platform.runs.map((run) => run.label)).size).toBe(2);
      expect(new Set(platform.runs.map((run) => run.sourcePath)).size).toBe(2);
      expect(new Set(platform.runs.map((run) => run.sha256)).size).toBe(1);
      expect(new Set(platform.runs.map((run) => run.bytes)).size).toBe(1);
      expect(platform.package).toMatchObject({ matchesAllRecordedRuns: true });
      expect(platform.runs.every((run) => run.sha256 === platform.package.sha256 && run.bytes === platform.package.bytes)).toBe(true);
    }
    const script = readFileSync(join(qualification, 'verify-binary-reproducible.ps1'), 'utf8');
    expect(script).toContain("$qualification = $PSScriptRoot");
    expect(script).toContain('& rustup run 1.96.0 cargo build');
    expect(script).toContain('git -c core.autocrlf=false -c core.eol=lf -C $repository archive');
    expect(script).toContain('checked package binary does not match both reproducible build runs');
  });

  // The closure binds the resolver's pins to the released binaries, which an unreleased version has none of: its first
  // mint is the tools release workflow (release.yml).
  test.skipIf(!REASONER_RELEASED)('checked binaries, package metadata, resolver anchors, artifacts, and handoff form one closed identity', () => {
    const output = execFileSync(process.execPath, [resolve(qualification, 'verify-distribution-closure.mjs')], {
      cwd: resolve(qualification, '..', '..'),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(JSON.parse(output)).toMatchObject({
      qualificationSourceCommit: '8c6db97adaf46fe76e628036d36bf18de906ec4b',
      status: 'closed',
    });
  });
});
