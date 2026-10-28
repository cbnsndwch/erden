// Gates that need the released reasoner binaries (their pins and the packed platform packages) skip, and say so, while
// the reasoner version is unreleased: its first binaries come from the tools release workflow
// (release.yml). Everything else runs against a reasoner built from this source: the host build
// (`pnpm run reasoner:build`), or for the container gates the mint's builder-image build (`pnpm run reasoner:build:linux`).
import { REASONER_RELEASED, TOOL_VERSION } from '../../reasoner/distribution/src/index.js';

export const UNRELEASED_REASONER_REASON = `reasoner ${TOOL_VERSION} has no released binary yet; its first mint is the tools release workflow (release.yml)`;

/** Ends the process successfully, naming the gate and why, when the reasoner is unreleased. */
export function skipUntilReasonerRelease(gate) {
    if (REASONER_RELEASED) {
        return;
    }
    process.stdout.write(`${gate}: skipped: ${UNRELEASED_REASONER_REASON}\n`);
    process.exit(0);
}
