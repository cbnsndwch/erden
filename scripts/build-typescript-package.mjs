// Builds one open runtime package (run from its directory by its `build` script).
import { buildRuntimePackage } from './lib/runtime-build.mjs';
import { RUNTIME_DIST_FILES } from './lib/runtime-package-files.mjs';

buildRuntimePackage(RUNTIME_DIST_FILES);
