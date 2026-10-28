import { basename, dirname, isAbsolute, resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { Result, Schema, SchemaIssue } from 'effect';
import {
    getNodeValue,
    parseTree,
    printParseErrorCode,
    type Node as JsonNode,
    type ParseError as JsonParseError,
} from 'jsonc-parser';
import { isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml';

import {
    compareCodePoints,
    manifestFormatForExplicitFilename,
    manifestFormatForFilename,
    type ManifestFormat,
} from './constants.js';
import {
    locationAtOffset,
    ManifestParseError,
    pathKey,
    suggestKnownField,
    type ManifestDiagnostic,
    type SourceLocation,
} from './diagnostics.js';
import {
    isCanonicalOntologyIri,
    isCitationRootName,
    isScopedAlias,
    normalizeRegistryOrigin,
    RawManifestV1,
    type ManifestV1,
    type RawManifestV1 as RawManifestV1Type,
} from './schema.js';

type ManifestPathSegments = ReadonlyArray<string | number>;

interface ParsedSyntax {
    readonly value: unknown;
    readonly locations: ReadonlyMap<string, SourceLocation>;
}

export interface ResolvedManifestSourcesV1 {
    readonly ontology: ReadonlyArray<string>;
    readonly shapes: ReadonlyArray<string>;
    readonly competencyQuestions: ReadonlyArray<string>;
}

export interface LoadedManifestV1 {
    readonly format: ManifestFormat;
    readonly filePath: string;
    readonly projectRoot: string;
    readonly manifest: ManifestV1;
    readonly resolvedSources: ResolvedManifestSourcesV1;
    readonly resolvedCitationRoots: Readonly<Record<string, string>>;
}

export interface ParseManifestTextInput {
    readonly filePath: string;
    readonly text: string;
}

const ROOT_FIELDS = [
    '$schema',
    'alias',
    'canonicalIri',
    'citationRoots',
    'dependencies',
    'description',
    'outsideProfile',
    'registry',
    'schemaVersion',
    'sources',
    'title',
    'ownedIriPrefixes',
] as const;
const SOURCE_FIELDS = ['competencyQuestions', 'ontology', 'shapes'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function locationForPath(
    locations: ReadonlyMap<string, SourceLocation>,
    path: ManifestPathSegments,
    fallback: SourceLocation,
): SourceLocation {
    for (let length = path.length; length >= 0; length -= 1) {
        const found = locations.get(pathKey(path.slice(0, length)));
        if (found !== undefined) {
            return found;
        }
    }
    return fallback;
}

function jsonSyntax(filePath: string, text: string, format: 'json' | 'jsonc'): ParsedSyntax {
    const parseErrors: JsonParseError[] = [];
    const root = parseTree(text, parseErrors, {
        allowEmptyContent: false,
        allowTrailingComma: false,
        disallowComments: format === 'json',
    });
    const diagnostics: ManifestDiagnostic[] = parseErrors.map((error) => ({
        code: 'syntax',
        message: `Invalid ${format.toUpperCase()} syntax: ${printParseErrorCode(error.error)}`,
        path: [],
        location: locationAtOffset(filePath, text, error.offset),
    }));
    const locations = new Map<string, SourceLocation>();
    locations.set(pathKey([]), locationAtOffset(filePath, text, root?.offset ?? 0));
    function visit(node: JsonNode, path: ReadonlyArray<string | number>): void {
        locations.set(pathKey(path), locationAtOffset(filePath, text, node.offset));
        if (node.type === 'object') {
            const seen = new Set<string>();
            for (const property of node.children ?? []) {
                const keyNode = property.children?.[0];
                const valueNode = property.children?.[1];
                if (keyNode === undefined || typeof keyNode.value !== 'string') {
                    continue;
                }
                const key = keyNode.value;
                const childPath = [...path, key];
                const keyLocation = locationAtOffset(filePath, text, keyNode.offset);
                locations.set(pathKey(childPath), keyLocation);
                if (seen.has(key)) {
                    diagnostics.push({
                        code: 'duplicate-key',
                        message: `Duplicate key ${JSON.stringify(key)} is not allowed`,
                        path: childPath,
                        location: keyLocation,
                    });
                }
                seen.add(key);
                if (valueNode !== undefined) {
                    visit(valueNode, childPath);
                }
            }
            return;
        }
        if (node.type === 'array') {
            (node.children ?? []).forEach((child, index) => {
                visit(child, [...path, index]);
            });
        }
    }
    if (root !== undefined) {
        visit(root, []);
    }
    if (diagnostics.length > 0) {
        throw new ManifestParseError(diagnostics);
    }
    if (root === undefined) {
        throw new ManifestParseError([
            {
                code: 'syntax',
                message: `The ${format.toUpperCase()} manifest is empty`,
                path: [],
                location: locationAtOffset(filePath, text, 0),
            },
        ]);
    }
    return { value: getNodeValue(root) as unknown, locations };
}

function yamlNodeOffset(node: YamlNode | null | undefined): number {
    return node?.range?.[0] ?? 0;
}

function yamlSyntax(filePath: string, text: string): ParsedSyntax {
    const document = parseDocument(text, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
        version: '1.2',
    });
    const diagnostics: ManifestDiagnostic[] = document.errors.map((error) => ({
        code: error.code === 'DUPLICATE_KEY' ? 'duplicate-key' : 'syntax',
        message: error.message,
        path: [],
        location: locationAtOffset(filePath, text, error.pos[0]),
    }));
    if (diagnostics.length > 0) {
        throw new ManifestParseError(diagnostics);
    }
    const locations = new Map<string, SourceLocation>();
    const root = document.contents;
    locations.set(pathKey([]), locationAtOffset(filePath, text, yamlNodeOffset(root)));
    function visit(node: YamlNode | null | undefined, path: ReadonlyArray<string | number>): void {
        if (node === null || node === undefined) {
            return;
        }
        locations.set(pathKey(path), locationAtOffset(filePath, text, yamlNodeOffset(node)));
        if (isMap(node)) {
            for (const pair of node.items) {
                if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
                    diagnostics.push({
                        code: 'syntax',
                        message:
                            'YAML mapping keys must be strings; quote numeric, boolean, and other typed keys explicitly',
                        path,
                        location: locationAtOffset(filePath, text, yamlNodeOffset(pair.key as YamlNode)),
                    });
                    continue;
                }
                const key = pair.key.value;
                const childPath = [...path, key];
                locations.set(pathKey(childPath), locationAtOffset(filePath, text, yamlNodeOffset(pair.key)));
                visit(pair.value as YamlNode | null, childPath);
            }
            return;
        }
        if (isSeq(node)) {
            node.items.forEach((item, index) => {
                visit(item as YamlNode | null, [...path, index]);
            });
        }
    }
    visit(root, []);
    if (diagnostics.length > 0) {
        throw new ManifestParseError(diagnostics);
    }
    try {
        return { value: document.toJS({ maxAliasCount: 100 }) as unknown, locations };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ManifestParseError([
            {
                code: 'syntax',
                message,
                path: [],
                location: locationAtOffset(filePath, text, 0),
            },
        ]);
    }
}

function findUnquotedEquals(line: string): number {
    let quote: '"' | "'" | undefined;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote === '"' && escaped) {
            escaped = false;
            continue;
        }
        if (quote === '"' && character === '\\') {
            escaped = true;
            continue;
        }
        if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '=') {
            return index;
        } else if (character === '#') {
            return -1;
        }
    }
    return -1;
}

function parseTomlDottedKey(input: string): ReadonlyArray<string> | undefined {
    const segments: string[] = [];
    let index = 0;
    while (index < input.length) {
        while (input[index] === ' ' || input[index] === '\t') {
            index += 1;
        }
        const character = input[index];
        if (character === undefined) {
            break;
        }
        let segment = '';
        if (character === '"' || character === "'") {
            const quote = character;
            index += 1;
            let escaped = false;
            while (index < input.length) {
                const next = input[index];
                if (next === undefined) {
                    break;
                }
                if (quote === '"' && escaped) {
                    segment += next;
                    escaped = false;
                } else if (quote === '"' && next === '\\') {
                    escaped = true;
                } else if (next === quote) {
                    index += 1;
                    break;
                } else {
                    segment += next;
                }
                index += 1;
            }
        } else {
            const match = /^[A-Za-z0-9_-]+/u.exec(input.slice(index));
            if (match === null) {
                return undefined;
            }
            segment = match[0];
            index += segment.length;
        }
        segments.push(segment);
        while (input[index] === ' ' || input[index] === '\t') {
            index += 1;
        }
        if (index >= input.length) {
            break;
        }
        if (input[index] !== '.') {
            return undefined;
        }
        index += 1;
    }
    return segments.length > 0 ? segments : undefined;
}

function tomlLocations(filePath: string, text: string): ReadonlyMap<string, SourceLocation> {
    const locations = new Map<string, SourceLocation>();
    locations.set(pathKey([]), locationAtOffset(filePath, text, 0));
    let tablePath: ReadonlyArray<string> = [];
    let offset = 0;
    for (const line of text.split(/\r?\n/u)) {
        const first = line.search(/\S/u);
        const trimmed = line.trim();
        if (first >= 0 && trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
            const close = trimmed.indexOf(']');
            const parsed = close > 1 ? parseTomlDottedKey(trimmed.slice(1, close)) : undefined;
            if (parsed !== undefined) {
                tablePath = parsed;
                locations.set(pathKey(tablePath), locationAtOffset(filePath, text, offset + first + 1));
            }
        } else if (first >= 0 && !trimmed.startsWith('#')) {
            const equals = findUnquotedEquals(line);
            if (equals >= 0) {
                const parsed = parseTomlDottedKey(line.slice(0, equals).trim());
                if (parsed !== undefined) {
                    locations.set(pathKey([...tablePath, ...parsed]), locationAtOffset(filePath, text, offset + first));
                }
            }
        }
        offset += line.length + 1;
    }
    return locations;
}

function tomlDuplicateKeyLocation(filePath: string, text: string, zeroBasedLine: number): SourceLocation | undefined {
    if (!Number.isInteger(zeroBasedLine) || zeroBasedLine < 0) {
        return undefined;
    }
    let lineStart = 0;
    for (let line = 0; line < zeroBasedLine; line += 1) {
        const newline = text.indexOf('\n', lineStart);
        if (newline < 0) {
            return undefined;
        }
        lineStart = newline + 1;
    }
    const newline = text.indexOf('\n', lineStart);
    const lineText = text.slice(lineStart, newline < 0 ? text.length : newline).replace(/\r$/u, '');
    const firstNonWhitespace = lineText.search(/\S/u);
    if (firstNonWhitespace < 0) {
        return undefined;
    }
    const trimmed = lineText.slice(firstNonWhitespace);
    const keyOffset = trimmed.startsWith('[[')
        ? firstNonWhitespace + 2
        : trimmed.startsWith('[')
          ? firstNonWhitespace + 1
          : firstNonWhitespace;
    return locationAtOffset(filePath, text, lineStart + keyOffset);
}

interface TomlErrorLike {
    readonly message?: unknown;
    readonly line?: unknown;
    readonly col?: unknown;
    readonly pos?: unknown;
}

function removeTomlMetadata(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(removeTomlMetadata);
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, removeTomlMetadata(child)]));
    }
    return value;
}

function tomlSyntax(filePath: string, text: string): ParsedSyntax {
    const locations = tomlLocations(filePath, text);
    try {
        return { value: removeTomlMetadata(TOML.parse(text)), locations };
    } catch (error) {
        const detail = error as TomlErrorLike;
        const message = typeof detail.message === 'string' ? detail.message : String(error);
        const duplicate = /duplicate|redefine|already (?:defined|exists)/iu.test(message);
        const offset = typeof detail.pos === 'number' ? detail.pos : 0;
        const parsedLocation = locationAtOffset(filePath, text, offset);
        const parserLocation =
            typeof detail.line === 'number' && typeof detail.col === 'number'
                ? { ...parsedLocation, line: detail.line + 1, column: detail.col + 1 }
                : parsedLocation;
        const location =
            duplicate && typeof detail.line === 'number'
                ? (tomlDuplicateKeyLocation(filePath, text, detail.line) ?? parserLocation)
                : parserLocation;
        throw new ManifestParseError([
            {
                code: duplicate ? 'duplicate-key' : 'syntax',
                message,
                path: [],
                location,
            },
        ]);
    }
}

function parseSyntax(filePath: string, text: string, format: ManifestFormat): ParsedSyntax {
    switch (format) {
        case 'json':
            return jsonSyntax(filePath, text, format);
        case 'jsonc':
            return jsonSyntax(filePath, text, format);
        case 'yaml':
            return yamlSyntax(filePath, text);
        case 'toml':
            return tomlSyntax(filePath, text);
    }
}

function unknownFieldDiagnostics(
    value: unknown,
    locations: ReadonlyMap<string, SourceLocation>,
    fallback: SourceLocation,
    format: ManifestFormat,
): ReadonlyArray<ManifestDiagnostic> {
    if (!isRecord(value)) {
        return [];
    }
    const diagnostics: ManifestDiagnostic[] = [];
    function check(
        record: Record<string, unknown>,
        parentPath: ReadonlyArray<string>,
        fields: ReadonlyArray<string>,
    ): void {
        const known = new Set(fields);
        for (const key of Object.keys(record).sort(compareCodePoints)) {
            if (known.has(key)) {
                continue;
            }
            const path = [...parentPath, key];
            const suggestion = suggestKnownField(key, fields);
            diagnostics.push({
                code: 'unknown-field',
                message: `Unknown manifest field ${JSON.stringify(key)}`,
                path,
                location: locationForPath(locations, path, fallback),
                ...(suggestion === undefined ? {} : { suggestion }),
            });
        }
    }
    check(value, [], ROOT_FIELDS);
    if (isRecord(value.sources)) {
        check(value.sources, ['sources'], SOURCE_FIELDS);
    }
    if ((format === 'yaml' || format === 'toml') && Object.hasOwn(value, '$schema')) {
        const path = ['$schema'];
        diagnostics.push({
            code: 'unsupported-field',
            message: '$schema is supported only by JSON and JSONC manifests',
            path,
            location: locationForPath(locations, path, fallback),
        });
    }
    return diagnostics;
}

function schemaVersionDiagnostics(
    value: unknown,
    locations: ReadonlyMap<string, SourceLocation>,
    fallback: SourceLocation,
): ReadonlyArray<ManifestDiagnostic> {
    if (!isRecord(value)) {
        return [];
    }
    const path = ['schemaVersion'];
    const location = locationForPath(locations, path, fallback);
    if (!Object.hasOwn(value, 'schemaVersion')) {
        return [
            {
                code: 'missing-schema-version',
                message: 'schemaVersion is required and must be the integer 1; $schema does not replace it',
                path,
                location,
            },
        ];
    }
    if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion)) {
        return [
            {
                code: 'invalid-schema-version',
                message: 'schemaVersion must be an integer; the only supported value is 1',
                path,
                location,
            },
        ];
    }
    if (value.schemaVersion !== 1) {
        return [
            {
                code: 'unsupported-schema-version',
                message: `Unsupported schemaVersion ${String(value.schemaVersion)}; supported versions: 1`,
                path,
                location,
            },
        ];
    }
    return [];
}

function dependencyIdentifierDiagnostics(
    value: unknown,
    locations: ReadonlyMap<string, SourceLocation>,
    fallback: SourceLocation,
): ReadonlyArray<ManifestDiagnostic> {
    if (!isRecord(value) || !isRecord(value.dependencies)) {
        return [];
    }
    const diagnostics: ManifestDiagnostic[] = [];
    for (const identifier of Object.keys(value.dependencies).sort(compareCodePoints)) {
        if (isScopedAlias(identifier) || isCanonicalOntologyIri(identifier)) {
            continue;
        }
        const path = ['dependencies', identifier];
        diagnostics.push({
            code: 'invalid-dependency-identifier',
            message: 'Dependency identifiers must be a scoped alias or an absolute canonical ontology IRI',
            path,
            location: locationForPath(locations, path, fallback),
        });
    }
    return diagnostics;
}

function citationRootNameDiagnostics(
    value: unknown,
    locations: ReadonlyMap<string, SourceLocation>,
    fallback: SourceLocation,
): ReadonlyArray<ManifestDiagnostic> {
    if (!isRecord(value) || !isRecord(value.citationRoots)) {
        return [];
    }
    const diagnostics: ManifestDiagnostic[] = [];
    for (const rootName of Object.keys(value.citationRoots).sort(compareCodePoints)) {
        if (isCitationRootName(rootName)) {
            continue;
        }
        const path = ['citationRoots', rootName];
        diagnostics.push({
            code: 'validation',
            message:
                'Citation-root names must be non-empty, well-formed Unicode with no leading or trailing whitespace',
            path,
            location: locationForPath(locations, path, fallback),
        });
    }
    return diagnostics;
}

interface FlatSchemaIssue {
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
}

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

function flattenSchemaIssue(
    issue: SchemaIssue.Issue,
    path: ReadonlyArray<string | number> = [],
): ReadonlyArray<FlatSchemaIssue> {
    switch (issue._tag) {
        case 'Pointer':
            return flattenSchemaIssue(issue.issue, [
                ...path,
                ...issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
            ]);
        case 'Composite':
            return issue.issues.flatMap((child) => flattenSchemaIssue(child, path));
        case 'AnyOf':
            // A closed literal set such as outsideProfile fails as a whole, with no member issue to point at.
            return issue.issues.length === 0
                ? [{ path, message: formatSchemaIssue(issue) }]
                : issue.issues.flatMap((child) => flattenSchemaIssue(child, path));
        case 'Encoding':
        case 'Filter':
            return flattenSchemaIssue(issue.issue, path);
        default:
            return [{ path, message: formatSchemaIssue(issue) }];
    }
}

function decodeManifest(
    value: unknown,
    locations: ReadonlyMap<string, SourceLocation>,
    fallback: SourceLocation,
): RawManifestV1Type {
    const result = Schema.decodeUnknownResult(RawManifestV1, {
        errors: 'all',
        onExcessProperty: 'error',
        reportInput: false,
    })(value);
    if (Result.isSuccess(result)) {
        return result.success;
    }
    const diagnostics = flattenSchemaIssue(result.failure.issue).map((issue): ManifestDiagnostic => ({
        code: 'validation',
        message: issue.message,
        path: issue.path,
        location: locationForPath(locations, issue.path, fallback),
    }));
    throw new ManifestParseError(diagnostics);
}

function frozenDataRecord(entries: Iterable<readonly [string, string]>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(entries));
}

function sortedRecord(input: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
    const entries: Array<readonly [string, string]> = [];
    for (const key of Object.keys(input ?? {}).sort(compareCodePoints)) {
        const value = input?.[key];
        if (value !== undefined) {
            entries.push([key, value]);
        }
    }
    return frozenDataRecord(entries);
}

function normalizeManifest(raw: RawManifestV1Type): ManifestV1 {
    const manifest: ManifestV1 = {
        schemaVersion: raw.schemaVersion,
        canonicalIri: raw.canonicalIri,
        alias: raw.alias,
        ownedIriPrefixes: Object.freeze([...raw.ownedIriPrefixes].sort(compareCodePoints)),
        ...(raw.title === undefined ? {} : { title: raw.title }),
        ...(raw.description === undefined ? {} : { description: raw.description }),
        ...(raw.registry === undefined ? {} : { registry: normalizeRegistryOrigin(raw.registry) }),
        ...(raw.outsideProfile === undefined ? {} : { outsideProfile: raw.outsideProfile }),
        sources: Object.freeze({
            ontology: Object.freeze([...raw.sources.ontology]),
            shapes: Object.freeze([...(raw.sources.shapes ?? [])]),
            competencyQuestions: Object.freeze([...(raw.sources.competencyQuestions ?? [])]),
        }),
        citationRoots: sortedRecord(raw.citationRoots),
        dependencies: sortedRecord(raw.dependencies),
    };
    return Object.freeze(manifest);
}

function validateAndNormalizeManifest(
    value: unknown,
    locations: ReadonlyMap<string, SourceLocation>,
    fallback: SourceLocation,
    format: ManifestFormat,
): ManifestV1 {
    const preliminary = [
        ...unknownFieldDiagnostics(value, locations, fallback, format),
        ...schemaVersionDiagnostics(value, locations, fallback),
        ...dependencyIdentifierDiagnostics(value, locations, fallback),
        ...citationRootNameDiagnostics(value, locations, fallback),
    ];
    if (preliminary.length > 0) {
        throw new ManifestParseError(preliminary);
    }
    return normalizeManifest(decodeManifest(value, locations, fallback));
}

export function normalizeManifestV1(value: unknown): ManifestV1 {
    const filePath = '<manifest-value>';
    const fallback: SourceLocation = Object.freeze({
        file: filePath,
        line: 1,
        column: 1,
        offset: 0,
    });
    return validateAndNormalizeManifest(value, new Map([[pathKey([]), fallback]]), fallback, 'json');
}

function resolveSourcePaths(projectRoot: string, manifest: ManifestV1): ResolvedManifestSourcesV1 {
    function resolveOne(sourcePath: string): string {
        return isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(projectRoot, sourcePath);
    }
    return Object.freeze({
        ontology: Object.freeze(manifest.sources.ontology.map(resolveOne)),
        shapes: Object.freeze(manifest.sources.shapes.map(resolveOne)),
        competencyQuestions: Object.freeze(manifest.sources.competencyQuestions.map(resolveOne)),
    });
}

function resolveCitationRootPaths(projectRoot: string, manifest: ManifestV1): Readonly<Record<string, string>> {
    const entries: Array<readonly [string, string]> = [];
    for (const rootName of Object.keys(manifest.citationRoots).sort(compareCodePoints)) {
        const manifestPath = manifest.citationRoots[rootName];
        if (manifestPath !== undefined) {
            entries.push([
                rootName,
                isAbsolute(manifestPath) ? resolve(manifestPath) : resolve(projectRoot, manifestPath),
            ]);
        }
    }
    return frozenDataRecord(entries);
}

export function parseManifestText(input: ParseManifestTextInput): LoadedManifestV1 {
    const filePath = resolve(input.filePath);
    const filename = basename(filePath);
    const format = manifestFormatForFilename(filename) ?? manifestFormatForExplicitFilename(filename);
    if (format === undefined) {
        throw new TypeError(`Unsupported Erden manifest filename: ${basename(filePath)}`);
    }
    const text = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
    const parsed = parseSyntax(filePath, text, format);
    const fallback = locationAtOffset(filePath, text, 0);
    const manifest = validateAndNormalizeManifest(parsed.value, parsed.locations, fallback, format);
    const projectRoot = dirname(filePath);
    return Object.freeze({
        format,
        filePath,
        projectRoot,
        manifest,
        resolvedSources: resolveSourcePaths(projectRoot, manifest),
        resolvedCitationRoots: resolveCitationRootPaths(projectRoot, manifest),
    });
}
