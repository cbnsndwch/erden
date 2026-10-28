// Audits a tree that is to be, or is, the public repository. It fails on:
//
// - a private IPv4 address, a home directory path or an email address that is not a no-reply or example address, unless
//   scripts/open-tree-audit.json allows that hit in that file, with a reason;
// - a file over the size limit, or an executable or compressed file (by its first bytes or its extension) that the
//   config does not allow; compressed files on the allowlist are decompressed and their text audited too;
// - a secret gitleaks finds (`gitleaks dir`), or a `reuse lint` failure, both run in the container images the config
//   pins by version and digest, without network and with a memory cap;
// - with `--denylist <file>`, a term of that list, unless its allow section allows the hit, with a reason;
// - with `--paths <open-tree-paths.json>`, a file the export allowlist does not include or that it excludes;
// - with `--commit`, a Git history other than one commit by the config's identity whose message names nobody, ends in
//   no trailer and has the tree that is checked out, with nothing else in the working tree.
//
// In a Git working tree the audited files are the tracked ones; otherwise every file under the directory.
//
// Usage: node scripts/audit-open-tree.mjs <directory> [--denylist <file>] [--paths <file>] [--commit]
//        [--no-containers] [--report <file>]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), 'open-tree-audit.json');

/** The generic patterns: what no public file may hold without a reason, whoever's repository it is. */
export const GENERIC_PATTERNS = [
    {
        check: 'private-ip',
        pattern:
            /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/gu,
    },
    {
        check: 'home-path',
        pattern: /(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)/gu,
    },
    // Bounded, and starting only where a local part can start, so a long line costs linear time.
    {
        check: 'email',
        pattern:
            /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/gu,
    },
];

/** Email addresses no one reads, or that name no one: GitHub's no-reply addresses and the reserved example domains. */
const ANONYMOUS_EMAIL =
    /^(?:no-?reply@.+|.+@users\.noreply\.github\.com|.+@(?:[a-z0-9-]+\.)*(?:example(?:\.com|\.org|\.net)?|invalid|test|localhost))$/iu;

const COMPRESSED_EXTENSIONS =
    /\.(?:br|gz|tgz|zip|xz|zst|bz2|7z|tar|jar|whl|node|wasm|exe|dll|so|dylib|a|lib|o|obj|bin)$/iu;
const MAGIC = [
    ['gzip', [0x1f, 0x8b]],
    ['zip', [0x50, 0x4b, 0x03, 0x04]],
    ['ELF', [0x7f, 0x45, 0x4c, 0x46]],
    ['PE', [0x4d, 0x5a]],
    ['Mach-O', [0xcf, 0xfa, 0xed, 0xfe]],
    ['Mach-O', [0xca, 0xfe, 0xba, 0xbe]],
    ['wasm', [0x00, 0x61, 0x73, 0x6d]],
    ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a]],
    ['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
    ['bzip2', [0x42, 0x5a, 0x68]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf]],
];

/** What kind of non-text file `bytes` is, or undefined for text. */
export function binaryKind(path, bytes) {
    for (const [kind, magic] of MAGIC) {
        if (bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)) {
            return kind;
        }
    }
    if (COMPRESSED_EXTENSIONS.test(path)) {
        return 'compressed or executable (by extension)';
    }
    return bytes.subarray(0, 8192).includes(0) ? 'binary (NUL byte)' : undefined;
}

/** A path rule: an exact path, or a directory prefix ending in `/`. */
function pathMatches(rule, path) {
    return rule.endsWith('/') ? path.startsWith(rule) : path === rule;
}

/**
 * Parses a denylist: `[deny]` lines are case-insensitive regular expressions; `[allow]` lines are
 * `<path> <regular expression> -- <reason>`, where the path is exact or a directory ending in `/`, and the expression
 * (no spaces; use `\s`) matches the whole hit. `#` starts a comment line.
 */
export function parseDenylist(text) {
    const deny = [];
    const allow = [];
    let section;
    for (const [index, raw] of text.split(/\r?\n/u).entries()) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) {
            continue;
        }
        if (line === '[deny]' || line === '[allow]') {
            section = line.slice(1, -1);
            continue;
        }
        if (section === 'deny') {
            deny.push({ check: 'denylist', term: line, pattern: new RegExp(line, 'giu') });
        } else if (section === 'allow') {
            const match = /^(\S+)\s+(\S+)\s+--\s+(\S.*)$/u.exec(line);
            if (match === null) {
                throw new Error(
                    `denylist line ${String(index + 1)}: an allow line is "<path> <expression> -- <reason>"`,
                );
            }
            allow.push({ path: match[1], pattern: match[2], reason: match[3] });
        } else {
            throw new Error(`denylist line ${String(index + 1)} is outside a [deny] or [allow] section`);
        }
    }
    return { deny, allow };
}

/** Whether an allow rule (`{ path, pattern, reason }`, the pattern matching the whole hit) covers a hit. */
function allowed(rules, check, path, hit) {
    return rules.some(
        (rule) =>
            (rule.check === undefined || rule.check === check) &&
            pathMatches(rule.path, path) &&
            new RegExp(`^(?:${rule.pattern})$`, 'iu').test(hit),
    );
}

/** The findings of `patterns` in one file's text, minus the allowed hits. */
export function scanText(path, text, patterns, allowRules) {
    const findings = [];
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
        for (const { check, pattern, term } of patterns) {
            for (const match of line.matchAll(pattern)) {
                const hit = match[0];
                if (check === 'email' && ANONYMOUS_EMAIL.test(hit)) {
                    continue;
                }
                if (!allowed(allowRules, check, path, hit)) {
                    findings.push({ check, path, line: index + 1, hit, ...(term === undefined ? {} : { term }) });
                }
            }
        }
    }
    return findings;
}

function walk(directory, base = directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return path === join(base, '.git') ? [] : walk(path, base);
        }
        return [relative(base, path).replaceAll('\\', '/')];
    });
}

function git(directory, args) {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
    }
    return result.stdout;
}

/** The files to audit: the tracked ones in a Git working tree, otherwise all of them. */
export function auditedFiles(directory) {
    if (existsSync(join(directory, '.git'))) {
        return git(directory, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
    }
    return walk(directory).sort();
}

/** The findings of the export allowlist: a file it does not include, or one it excludes. */
export function pathFindings(files, paths) {
    const findings = [];
    const openPaths = new Set(Object.keys(paths.openVersions));
    for (const path of files) {
        const included =
            openPaths.has(path) || paths.include.some((entry) => pathMatches(entry, path) && !openPaths.has(entry));
        const excluded =
            path.split('/').slice(0, -1).includes('bin') || paths.exclude.some((entry) => pathMatches(entry, path));
        if (!included || excluded) {
            findings.push({
                check: 'path',
                path,
                hit: excluded ? 'excluded by the allowlist' : 'not on the allowlist',
            });
        }
    }
    return findings;
}

/** The findings of the identity check on a Git working tree: one commit, by the config's identity, clean. */
export function commitFindings(directory, identity, patterns) {
    const findings = [];
    function add(hit) {
        findings.push({ check: 'commit', path: '.git', hit });
    }
    const commits = git(directory, ['rev-list', '--all']).split('\n').filter(Boolean);
    if (commits.length !== 1) {
        add(`the history has ${String(commits.length)} commits, not one`);
    }
    const [authorName, authorEmail, committerName, committerEmail, parents] = git(directory, [
        'log',
        '-1',
        '--format=%an%n%ae%n%cn%n%ce%n%P',
        'HEAD',
    ]).split('\n');
    for (const [role, name, email] of [
        ['author', authorName, authorEmail],
        ['committer', committerName, committerEmail],
    ]) {
        if (name !== identity.name || email !== identity.email) {
            add(`the ${role} is "${String(name)} <${String(email)}>", not "${identity.name} <${identity.email}>"`);
        }
    }
    if ((parents ?? '') !== '') {
        add('the commit has a parent');
    }
    const message = git(directory, ['log', '-1', '--format=%B', 'HEAD']).trimEnd();
    const paragraphs = message.split(/\n\s*\n/u);
    if (paragraphs.length > 1 && /^[A-Za-z][A-Za-z0-9-]*:\s/mu.test(paragraphs.at(-1) ?? '')) {
        add('the commit message ends in a trailer');
    }
    for (const finding of scanText('.git/COMMIT_MESSAGE', message, patterns, [])) {
        add(`the commit message holds "${finding.hit}" (${finding.check})`);
    }
    if (git(directory, ['status', '--porcelain', '--untracked-files=all', '--ignored']).trim() !== '') {
        add('the working tree differs from the commit, or holds untracked or ignored files');
    }
    if (git(directory, ['for-each-ref', '--format=%(refname)']).trim() !== 'refs/heads/main') {
        add('the repository has refs other than refs/heads/main');
    }
    return findings;
}

function container(tool, directory, args, config) {
    const image = config.images[tool];
    const uid =
        typeof process.getuid === 'function' ? [`--user=${String(process.getuid())}:${String(process.getgid())}`] : [];
    return spawnSync(
        'docker',
        [
            'run',
            '--rm',
            '--network=none',
            `--memory=${config.containerMemory}`,
            `--memory-swap=${config.containerMemory}`,
            '--read-only',
            '--tmpfs=/tmp',
            ...uid,
            `--volume=${directory}:/src:ro`,
            '--workdir=/src',
            image,
            ...args,
        ],
        { encoding: 'utf8', maxBuffer: 1 << 28 },
    );
}

/**
 * gitleaks over the directory, in its pinned image, with the directory's `.gitleaks.toml` when it has one: one finding
 * per secret, by file and line, redacted.
 */
function gitleaksFindings(directory, config) {
    const result = container(
        'gitleaks',
        directory,
        [
            'dir',
            '/src',
            ...(existsSync(join(directory, '.gitleaks.toml')) ? ['--config=/src/.gitleaks.toml'] : []),
            '--no-banner',
            '--redact',
            '--exit-code=3',
            '--report-format=json',
            '--report-path=/dev/stdout',
        ],
        config,
    );
    if (result.status !== 0 && result.status !== 3) {
        throw new Error(`gitleaks failed (${String(result.status)}): ${result.stderr.trim()}`);
    }
    const start = result.stdout.indexOf('[');
    const leaks = start === -1 ? [] : JSON.parse(result.stdout.slice(start));
    if (result.status === 3 && leaks.length === 0) {
        throw new Error(`gitleaks reported leaks it did not list: ${result.stderr.trim()}`);
    }
    return leaks.map((leak) => ({
        check: 'gitleaks',
        path: String(leak.File).replace(/^\/src\//u, ''),
        line: leak.StartLine,
        hit: `${String(leak.RuleID)}: ${String(leak.Description)}`,
    }));
}

/** `reuse lint` over the directory, in its pinned image. */
function reuseFindings(directory, config) {
    const result = container('reuse', directory, ['lint'], config);
    if (result.status === 0) {
        return [];
    }
    return [{ check: 'reuse', path: 'REUSE.toml', hit: `reuse lint failed:\n${result.stdout.trim()}` }];
}

export function auditOpenTree(directoryArgument, options = {}) {
    const directory = resolve(directoryArgument);
    const config = options.config ?? JSON.parse(readFileSync(CONFIG, 'utf8'));
    const denylist = options.denylist === undefined ? { deny: [], allow: [] } : parseDenylist(options.denylist);
    const patterns = [...GENERIC_PATTERNS, ...denylist.deny];
    const allowRules = [...config.allow, ...denylist.allow];
    const files = auditedFiles(directory);
    const findings = [];
    let bytes = 0;
    for (const path of files) {
        const contents = readFileSync(join(directory, path));
        bytes += contents.length;
        if (contents.length > config.maxFileBytes) {
            findings.push({
                check: 'size',
                path,
                hit: `${String(contents.length)} bytes, over ${String(config.maxFileBytes)}`,
            });
            continue;
        }
        const kind = binaryKind(path, contents);
        let text = contents.toString('utf8');
        if (kind !== undefined) {
            const entry = config.binaryAllowlist.find((rule) => rule.path === path);
            if (entry === undefined) {
                findings.push({ check: 'binary', path, hit: kind });
                continue;
            }
            text = (entry.encoding === 'brotli' ? brotliDecompressSync(contents) : gunzipSync(contents)).toString(
                'utf8',
            );
        }
        findings.push(...scanText(path, text, patterns, allowRules));
    }
    if (options.paths !== undefined) {
        findings.push(...pathFindings(files, options.paths));
    }
    if (options.commit === true) {
        findings.push(...commitFindings(directory, config.identity, patterns));
    }
    if (options.containers !== false) {
        findings.push(...gitleaksFindings(directory, config), ...reuseFindings(directory, config));
    }
    return {
        directory,
        files: files.length,
        bytes,
        checks: [
            'generic',
            'size',
            'binary',
            ...(options.denylist === undefined ? [] : ['denylist']),
            ...(options.paths === undefined ? [] : ['paths']),
            ...(options.commit === true ? ['commit'] : []),
            ...(options.containers === false ? [] : ['gitleaks', 'reuse']),
        ],
        findings,
    };
}

function option(args, name) {
    const index = args.indexOf(name);
    if (index === -1) {
        return undefined;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} needs a value`);
    }
    return value;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const directory = args[0];
    if (directory === undefined || directory.startsWith('--')) {
        console.error(
            'Usage: node scripts/audit-open-tree.mjs <directory> [--denylist <file>] [--paths <file>] [--commit] [--no-containers] [--report <file>]',
        );
        process.exit(2);
    }
    const denylistPath = option(args, '--denylist');
    const pathsPath = option(args, '--paths');
    const reportPath = option(args, '--report');
    const report = auditOpenTree(directory, {
        denylist: denylistPath === undefined ? undefined : readFileSync(denylistPath, 'utf8'),
        paths: pathsPath === undefined ? undefined : JSON.parse(readFileSync(pathsPath, 'utf8')),
        commit: args.includes('--commit'),
        containers: !args.includes('--no-containers'),
    });
    if (reportPath !== undefined) {
        writeFileSync(reportPath, `${JSON.stringify(report, null, 4)}\n`);
    }
    for (const finding of report.findings) {
        const where = finding.line === undefined ? finding.path : `${finding.path}:${String(finding.line)}`;
        console.log(`${finding.check}\t${where}\t${finding.hit}`);
    }
    console.log(
        `Audited ${String(report.files)} files (${String(report.bytes)} bytes) with ${report.checks.join(', ')}: ${String(report.findings.length)} findings.`,
    );
    process.exit(report.findings.length === 0 ? 0 : 1);
}
