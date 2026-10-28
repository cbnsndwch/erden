export declare const PLACEHOLDER_EXECUTABLE_DIGEST: string;
export declare const EXCLUDED_MARKER: string;
export declare const DETERMINISM_TARGETS: ReadonlyArray<string>;

export declare const sha256: (bytes: string | Uint8Array) => string;
export declare const bindRequest: (wire: string, executableDigest: string) => string;
export declare const normalizeAnswer: (answer: string | Buffer, executableDigest: string) => Buffer;
export declare const answerLabel: (answer: string | Buffer) => string;
export declare const firstDifference: (
  left: Buffer,
  right: Buffer,
  context?: number,
) => { offset: number; leftBytes: number; rightBytes: number; left: string; right: string } | undefined;
export declare const jsonDifferences: (
  left: Buffer,
  right: Buffer,
  limit?: number,
) => Array<{ path: string; left: unknown; right: unknown }>;

export interface DeterminismComparison {
  readonly schema: string;
  readonly result: 'identical' | 'different';
  readonly excludedFields: ReadonlyArray<{ readonly field: string; readonly where: string; readonly why: string }>;
  readonly problems: ReadonlyArray<string>;
  readonly requestCount: number;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly expected: string;
    readonly identical: boolean;
    readonly differences: ReadonlyArray<{ readonly target: string; readonly jsonDifferences: ReadonlyArray<{ readonly path: string }> }>;
  }>;
}
export declare const compareAnswerSets: (
  requestsDirectory: string,
  answersDirectory: string,
  targets?: ReadonlyArray<string>,
) => DeterminismComparison;
