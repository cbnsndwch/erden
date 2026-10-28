import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        fileParallelism: false,
        include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'reasoner/**/*.test.ts', 'shacl/**/*.test.ts'],
        // Windows runners take two to three times as long as Linux on the same tests, which puts tests that finish in
        // about 2 s on Linux past the 5 s default; tests that set their own timeout keep it.
        ...(process.platform === 'win32' ? { testTimeout: 20_000 } : {}),
        sequence: {
            concurrent: false,
            shuffle: false,
        },
    },
});
