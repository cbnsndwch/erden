export interface TestTempRootHooks {
    readonly readMountInfo?: () => string;
    readonly readDescriptorMountId?: (fd: number) => string;
    readonly beforeDirectoryDescriptorMutation?: (path: string) => void;
    readonly beforeEntryRemoval?: (path: string, kind: 'directory' | 'entry') => void;
    readonly beforeRootRemoval?: (path: string) => void;
}

export declare const makeTestTempRoot: (prefix: string, hooks?: TestTempRootHooks) => string;
export declare const cleanupTestTempRoot: (path: string, hooks?: TestTempRootHooks) => void;
