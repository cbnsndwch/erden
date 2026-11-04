// Refuses the retired legal entity's name and the retired vocabulary addresses in tracked files: Ingenio Ventures Inc holds
// Erden's copyrights and trademarks from the first release on, and the vocabulary IRIs live under erden.sh/o/erden/. A repository
// may keep deliberate exceptions, each with its reason, in scripts/legal-entity-exceptions.json. The cbnsndwch name of
// the GitHub account and of aliases is neither.
//
// Usage: node scripts/check-legal-entity.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CURRENT_ENTITY = 'Ingenio Ventures Inc';
// Any spacing, comma or dotted form, in any case, across a line break too; the addresses in any case. None matches its
// own source.
const RETIRED = /cbnsndwch[\s,]*(?:llc|l\.l\.c)|erden[.]cbnsndwch[.]dev|erden[.]sh[/]onto[/]/iu;

/** Each exception names a file, or with a trailing slash a directory, and says why it may keep the name. */
export function isExcepted(path, exceptions) {
    return exceptions.some((exception) =>
        exception.path.endsWith('/') ? path.startsWith(exception.path) : path === exception.path,
    );
}

/** The tracked files of `root` that name the retired entity and are not excepted. */
export function retiredEntityFindings(root, exceptions = []) {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
        .split('\0')
        .filter((path) => {
            const file = join(root, path);
            if (path === '' || isExcepted(path, exceptions) || !existsSync(file) || !statSync(file).isFile()) {
                return false;
            }
            return RETIRED.test(readFileSync(file).toString('latin1'));
        });
}

export function readExceptions(root) {
    const file = join(root, 'scripts/legal-entity-exceptions.json');
    if (!existsSync(file)) {
        return [];
    }
    const { exceptions } = JSON.parse(readFileSync(file, 'utf8'));
    for (const exception of exceptions) {
        if (typeof exception.path !== 'string' || typeof exception.reason !== 'string' || exception.reason === '') {
            throw new Error(`A legal entity exception needs a path and a reason: ${JSON.stringify(exception)}`);
        }
    }
    return exceptions;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = process.cwd();
    const findings = retiredEntityFindings(root, readExceptions(root));
    if (findings.length > 0) {
        console.error(
            `These files name the retired legal entity or vocabulary address; use ${CURRENT_ENTITY} and erden.sh/o/erden/:\n- ${findings.join('\n- ')}`,
        );
        process.exit(1);
    }
    console.log('No tracked file names the retired legal entity or vocabulary address outside its exceptions.');
}
