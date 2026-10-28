#!/usr/bin/env node

import { CLI_EXIT, nodeCliRuntime, runCli } from './main.js';

try {
    process.exitCode = await runCli(process.argv.slice(2), nodeCliRuntime);
} catch {
    process.stderr.write('Erden could not start [CLI_OPERATIONAL_FAILURE]\n');
    process.exitCode = CLI_EXIT.operational;
}
