import { makeNodeProjectLockFileSystemPort, type ProjectLockNodeOperations } from '../project-lock/filesystem.js';

export type ProjectDependencyStateNodeOperations = ProjectLockNodeOperations;

export interface ProjectDependencyStateFileSystemPort {
    readonly operations: ProjectDependencyStateNodeOperations;
}

export function makeNodeProjectDependencyStateFileSystemPort(
    overrides: Partial<ProjectDependencyStateNodeOperations> = {},
): ProjectDependencyStateFileSystemPort {
    return makeNodeProjectLockFileSystemPort(overrides);
}
