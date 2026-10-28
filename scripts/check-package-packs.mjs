import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packFailures } from './lib/package-packs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = packFailures(root);

if (failures.length > 0) {
    console.error('Workspace package boundary check failed:');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log('Every workspace package matches its exact source or qualified-binary pack allowlist.');
}
