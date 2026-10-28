import { compareCodePoints, MANIFEST_JSON_SCHEMA_URL, type ManifestSerializationFormat } from './constants.js';
import { normalizeManifestV1 } from './parsers.js';
import type { ManifestV1 } from './schema.js';

function sortedRecord(input: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(
        Object.keys(input)
            .sort(compareCodePoints)
            .map((key) => [key, input[key] as string]),
    );
}

function canonicalObject(manifest: ManifestV1, includeJsonSchema: boolean): object {
    return {
        ...(includeJsonSchema ? { $schema: MANIFEST_JSON_SCHEMA_URL } : {}),
        schemaVersion: manifest.schemaVersion,
        canonicalIri: manifest.canonicalIri,
        alias: manifest.alias,
        ownedIriPrefixes: [...manifest.ownedIriPrefixes],
        ...(manifest.title === undefined ? {} : { title: manifest.title }),
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        ...(manifest.registry === undefined ? {} : { registry: manifest.registry }),
        ...(manifest.outsideProfile === undefined ? {} : { outsideProfile: manifest.outsideProfile }),
        sources: {
            ontology: [...manifest.sources.ontology],
            ...(manifest.sources.shapes.length === 0 ? {} : { shapes: [...manifest.sources.shapes] }),
            ...(manifest.sources.competencyQuestions.length === 0
                ? {}
                : { competencyQuestions: [...manifest.sources.competencyQuestions] }),
        },
        ...(Object.keys(manifest.citationRoots).length === 0
            ? {}
            : { citationRoots: sortedRecord(manifest.citationRoots) }),
        ...(Object.keys(manifest.dependencies).length === 0
            ? {}
            : { dependencies: sortedRecord(manifest.dependencies) }),
    };
}

function quoted(value: string): string {
    return JSON.stringify(value);
}

function yamlQuoted(value: string): string {
    return quoted(value).replace(
        /[\u007f-\u009f\ufffe\uffff]/gu,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

// JSON leaves DEL unescaped, while TOML requires it to use a Unicode escape.
// JSON's other C0 control characters are already emitted as named or Unicode escapes.
function tomlQuoted(value: string): string {
    return quoted(value).replaceAll('\u007f', '\\u007f');
}

function yamlArray(lines: string[], indentation: string, values: ReadonlyArray<string>): void {
    for (const value of values) {
        lines.push(`${indentation}- ${yamlQuoted(value)}`);
    }
}

function serializeYaml(manifest: ManifestV1): string {
    const lines = [
        `schemaVersion: ${String(manifest.schemaVersion)}`,
        `canonicalIri: ${yamlQuoted(manifest.canonicalIri)}`,
        `alias: ${yamlQuoted(manifest.alias)}`,
        'ownedIriPrefixes:',
    ];
    yamlArray(lines, '  ', manifest.ownedIriPrefixes);
    if (manifest.title !== undefined) {
        lines.push(`title: ${yamlQuoted(manifest.title)}`);
    }
    if (manifest.description !== undefined) {
        lines.push(`description: ${yamlQuoted(manifest.description)}`);
    }
    if (manifest.registry !== undefined) {
        lines.push(`registry: ${yamlQuoted(manifest.registry)}`);
    }
    if (manifest.outsideProfile !== undefined) {
        lines.push(`outsideProfile: ${yamlQuoted(manifest.outsideProfile)}`);
    }
    lines.push('sources:', '  ontology:');
    yamlArray(lines, '    ', manifest.sources.ontology);
    if (manifest.sources.shapes.length > 0) {
        lines.push('  shapes:');
        yamlArray(lines, '    ', manifest.sources.shapes);
    }
    if (manifest.sources.competencyQuestions.length > 0) {
        lines.push('  competencyQuestions:');
        yamlArray(lines, '    ', manifest.sources.competencyQuestions);
    }
    const citationRootNames = Object.keys(manifest.citationRoots).sort(compareCodePoints);
    if (citationRootNames.length > 0) {
        lines.push('citationRoots:');
        for (const rootName of citationRootNames) {
            lines.push(`  ${yamlQuoted(rootName)}: ${yamlQuoted(manifest.citationRoots[rootName] as string)}`);
        }
    }
    const dependencyNames = Object.keys(manifest.dependencies).sort(compareCodePoints);
    if (dependencyNames.length > 0) {
        lines.push('dependencies:');
        for (const dependency of dependencyNames) {
            lines.push(`  ${yamlQuoted(dependency)}: ${yamlQuoted(manifest.dependencies[dependency] as string)}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

function tomlArray(values: ReadonlyArray<string>): string {
    return `[${values.map(tomlQuoted).join(', ')}]`;
}

function serializeToml(manifest: ManifestV1): string {
    const lines = [
        `schemaVersion = ${String(manifest.schemaVersion)}`,
        `canonicalIri = ${tomlQuoted(manifest.canonicalIri)}`,
        `alias = ${tomlQuoted(manifest.alias)}`,
        `ownedIriPrefixes = ${tomlArray(manifest.ownedIriPrefixes)}`,
    ];
    if (manifest.title !== undefined) {
        lines.push(`title = ${tomlQuoted(manifest.title)}`);
    }
    if (manifest.description !== undefined) {
        lines.push(`description = ${tomlQuoted(manifest.description)}`);
    }
    if (manifest.registry !== undefined) {
        lines.push(`registry = ${tomlQuoted(manifest.registry)}`);
    }
    if (manifest.outsideProfile !== undefined) {
        lines.push(`outsideProfile = ${tomlQuoted(manifest.outsideProfile)}`);
    }
    lines.push('', '[sources]', `ontology = ${tomlArray(manifest.sources.ontology)}`);
    if (manifest.sources.shapes.length > 0) {
        lines.push(`shapes = ${tomlArray(manifest.sources.shapes)}`);
    }
    if (manifest.sources.competencyQuestions.length > 0) {
        lines.push(`competencyQuestions = ${tomlArray(manifest.sources.competencyQuestions)}`);
    }
    const citationRootNames = Object.keys(manifest.citationRoots).sort(compareCodePoints);
    if (citationRootNames.length > 0) {
        lines.push('', '[citationRoots]');
        for (const rootName of citationRootNames) {
            lines.push(`${tomlQuoted(rootName)} = ${tomlQuoted(manifest.citationRoots[rootName] as string)}`);
        }
    }
    const dependencyNames = Object.keys(manifest.dependencies).sort(compareCodePoints);
    if (dependencyNames.length > 0) {
        lines.push('', '[dependencies]');
        for (const dependency of dependencyNames) {
            lines.push(`${tomlQuoted(dependency)} = ${tomlQuoted(manifest.dependencies[dependency] as string)}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

export function serializeManifestV1(input: unknown, format: ManifestSerializationFormat): string {
    const manifest = normalizeManifestV1(input);
    switch (format) {
        case 'json':
        case 'jsonc':
            return `${JSON.stringify(canonicalObject(manifest, true), null, 2)}\n`;
        case 'yml':
        case 'yaml':
            return serializeYaml(manifest);
        case 'toml':
            return serializeToml(manifest);
        default:
            throw new TypeError(`Unsupported Erden manifest serialization format: ${String(format)}`);
    }
}
