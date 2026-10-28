export interface LicensePolicy {
  readonly allowedIdentifiers: ReadonlyArray<string>;
  readonly deniedIdentifiers: ReadonlyArray<string>;
  readonly selections: Readonly<Record<string, ReadonlyArray<string>>>;
}

export declare const licenseIdentifiers: (expression: string) => ReadonlyArray<string>;
export declare const selectLicenses: (
  expression: unknown,
  policy: LicensePolicy,
  component: string,
) => ReadonlyArray<string>;
