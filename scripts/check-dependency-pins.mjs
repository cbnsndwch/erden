import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    EXPECTED_NODE_ENGINE_RANGE,
    EXPECTED_NODE_TOOLCHAIN_VERSION,
    inspectWorkspace,
} from './lib/workspace-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = inspectWorkspace(root);

if (failures.length > 0) {
    console.error('Dependency pin check failed:');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log(
        `Declared workspace identities, dependency direction, exact dependency pins, Node engine ${EXPECTED_NODE_ENGINE_RANGE}, and Node toolchain ${EXPECTED_NODE_TOOLCHAIN_VERSION} are valid.`,
    );
}
