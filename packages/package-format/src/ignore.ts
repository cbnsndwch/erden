import { PackageFixtureError, REFERENCE_EXTRACTION_LIMITS } from './contract.js';

export type PackageIgnoreFilename = '.erdenignore' | '.gitignore';

export interface PackageIgnorePolicyInput {
    readonly erdenIgnore?: Uint8Array;
    readonly gitIgnore?: Uint8Array;
}

export interface PackageIgnorePolicy {
    readonly selectedIgnoreFile: PackageIgnoreFilename | null;
    readonly isAlwaysExcluded: (path: string) => boolean;
    readonly isIgnored: (path: string) => boolean;
}

interface IgnoreRule {
    readonly negative: boolean;
    readonly regex: RegExp;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function copyBytes(value: unknown): Uint8Array {
    let length: number;
    try {
        if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
            throw new Error('byte shape');
        }
        length = (value as Uint8Array).byteLength;
    } catch {
        throw new PackageFixtureError('invalid-utf8', 'Ignore file bytes could not be read safely');
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > REFERENCE_EXTRACTION_LIMITS.maxEntryBytes) {
        throw new PackageFixtureError('limit-entry-size', 'Ignore file exceeds the V1 entry-size limit');
    }
    try {
        const copied = Uint8Array.prototype.slice.call(value) as Uint8Array;
        if (copied.byteLength !== length) {
            throw new Error('byte mutation');
        }
        return copied;
    } catch {
        throw new PackageFixtureError('invalid-utf8', 'Ignore file bytes could not be read safely');
    }
}

function escapeRegexCharacter(character: string): string {
    return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function globToRegexSource(glob: string): string {
    let source = '';
    for (let index = 0; index < glob.length; index += 1) {
        const character = glob[index];
        if (character === '*') {
            if (glob[index + 1] === '*') {
                index += 1;
                if (glob[index + 1] === '/') {
                    index += 1;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
            }
        } else if (character === '?') {
            source += '[^/]';
        } else if (character !== undefined) {
            source += escapeRegexCharacter(character);
        }
    }
    return source;
}

function parseIgnoreRules(bytes: Uint8Array): ReadonlyArray<IgnoreRule> {
    let text: string;
    try {
        text = decoder.decode(copyBytes(bytes));
    } catch (error) {
        if (error instanceof PackageFixtureError) {
            throw error;
        }
        throw new PackageFixtureError('invalid-utf8', 'Ignore file is not valid UTF-8');
    }
    if (text.startsWith('\uFEFF')) {
        throw new PackageFixtureError('invalid-utf8', 'Ignore file must not contain a UTF-8 BOM');
    }
    const rules: IgnoreRule[] = [];
    for (const rawLine of text.replaceAll('\r\n', '\n').split('\n')) {
        const withoutTrailingSpaces = rawLine.replace(/(?<!\\) +$/u, '');
        if (withoutTrailingSpaces.length === 0 || withoutTrailingSpaces.startsWith('#')) {
            continue;
        }
        const negative = withoutTrailingSpaces.startsWith('!');
        let pattern = negative ? withoutTrailingSpaces.slice(1) : withoutTrailingSpaces;
        pattern = pattern.replace(/^\\([#!])/u, '$1').replaceAll('\\ ', ' ');
        if (pattern.length === 0) {
            continue;
        }
        const rooted = pattern.startsWith('/');
        if (rooted) {
            pattern = pattern.slice(1);
        }
        const directoryOnly = pattern.endsWith('/');
        if (directoryOnly) {
            pattern = pattern.slice(0, -1);
        }
        const hasSlash = pattern.includes('/');
        const body = globToRegexSource(pattern.normalize('NFC'));
        const prefix = rooted || hasSlash ? '^' : '(?:^|/)';
        const suffix = directoryOnly ? '(?:$|/)' : '$';
        rules.push(Object.freeze({ negative, regex: new RegExp(`${prefix}${body}${suffix}`, 'u') }));
    }
    return Object.freeze(rules);
}

function canonicalCandidate(path: string): string {
    return path.replaceAll('\\', '/').normalize('NFC');
}

function directlyIgnored(path: string, rules: ReadonlyArray<IgnoreRule>): boolean {
    let ignored = false;
    for (const rule of rules) {
        if (rule.regex.test(path)) {
            ignored = !rule.negative;
        }
    }
    return ignored;
}

export function isAlwaysExcludedPackagePath(path: string): boolean {
    const candidate = canonicalCandidate(path);
    return (
        candidate === '.erdenignore' ||
        candidate === '.gitignore' ||
        candidate === '.git' ||
        candidate.startsWith('.git/') ||
        candidate === '.erden' ||
        candidate.startsWith('.erden/')
    );
}

export function makePackageIgnorePolicy(input: PackageIgnorePolicyInput): PackageIgnorePolicy {
    let rawErdenIgnore: unknown;
    let rawGitIgnore: unknown;
    let hasErdenIgnore = false;
    let hasGitIgnore = false;
    try {
        const candidate: unknown = input;
        if (
            candidate === null ||
            typeof candidate !== 'object' ||
            Array.isArray(candidate) ||
            Object.getPrototypeOf(candidate) !== Object.prototype ||
            Object.getOwnPropertySymbols(candidate).length !== 0
        ) {
            throw new Error('ignore policy shape');
        }
        const names = Object.getOwnPropertyNames(candidate);
        if (names.some((name) => name !== 'erdenIgnore' && name !== 'gitIgnore')) {
            throw new Error('ignore policy field');
        }
        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new Error('ignore policy descriptor');
            }
            if (name === 'erdenIgnore') {
                rawErdenIgnore = descriptor.value;
                hasErdenIgnore = true;
            } else {
                rawGitIgnore = descriptor.value;
                hasGitIgnore = true;
            }
        }
    } catch {
        throw new PackageFixtureError('invalid-utf8', 'Ignore policy input could not be read safely');
    }
    const erdenIgnore = hasErdenIgnore ? copyBytes(rawErdenIgnore) : undefined;
    const gitIgnore = hasGitIgnore ? copyBytes(rawGitIgnore) : undefined;
    const selectedIgnoreFile =
        erdenIgnore !== undefined
            ? ('.erdenignore' as const)
            : gitIgnore !== undefined
              ? ('.gitignore' as const)
              : null;
    const bytes = erdenIgnore ?? gitIgnore;
    const rules = bytes === undefined ? Object.freeze([]) : parseIgnoreRules(bytes);
    return Object.freeze({
        selectedIgnoreFile,
        isAlwaysExcluded: isAlwaysExcludedPackagePath,
        isIgnored: (path: string): boolean => {
            const candidate = canonicalCandidate(path);
            const segments = candidate.split('/');
            for (let length = 1; length < segments.length; length += 1) {
                if (directlyIgnored(segments.slice(0, length).join('/'), rules)) {
                    return true;
                }
            }
            return directlyIgnored(candidate, rules);
        },
    });
}
