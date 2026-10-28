export declare const LINUX_BUILDER_IMAGE: string;
export declare const RUST_TOOLCHAIN: Readonly<{ rustc: string; commit: string; llvm: string }>;
export declare const REPRODUCIBLE_TARGETS: ReadonlyArray<string>;

export interface HostIdentity {
  readonly platform: string;
  readonly arch: string;
}

interface PlanCommon {
  readonly rustflagsRecord: string;
  readonly binaryRelativePath: string;
}
export interface DockerBuildPlan extends PlanCommon {
  readonly kind: 'docker';
  readonly image: string;
  readonly dockerPlatform: string;
  readonly command: string;
}
export interface NativeBuildPlan extends PlanCommon {
  readonly kind: 'native';
  readonly env: Readonly<Record<string, string>>;
  readonly args: ReadonlyArray<string>;
}

export declare const assertNativeHost: (
  target: string,
  host: HostIdentity,
) => Readonly<{ host: HostIdentity; builder: 'docker' | 'native' }>;

export declare const nativeBuildEnvironment: (
  ambient: Readonly<Record<string, string | undefined>>,
  plan: NativeBuildPlan,
  targetDirectory: string,
) => Record<string, string | undefined>;

export declare const cargoConfigurationFiles: (sourceDirectory: string, cargoHome: string) => string[];

export declare const planBuild: (
  target: string,
  host: HostIdentity,
  paths?: { readonly sourceDirectory?: string; readonly cargoHome?: string },
  sourceDateEpoch?: string,
) => DockerBuildPlan | NativeBuildPlan;
