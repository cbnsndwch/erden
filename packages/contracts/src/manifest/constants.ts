export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_JSON_SCHEMA_URL = 'https://erden.dev/schemas/manifest/v1.json' as const;

export const MANIFEST_FILENAMES = [
    'erden.config.json',
    'erden.config.jsonc',
    'erden.config.yml',
    'erden.config.yaml',
    'erden.config.toml',
] as const;

export type ManifestFilename = (typeof MANIFEST_FILENAMES)[number];

export type ManifestFormat = 'json' | 'jsonc' | 'yaml' | 'toml';

export type ManifestSerializationFormat = 'json' | 'jsonc' | 'yml' | 'yaml' | 'toml';

const FORMAT_BY_FILENAME: Readonly<Record<ManifestFilename, ManifestFormat>> = {
    'erden.config.json': 'json',
    'erden.config.jsonc': 'jsonc',
    'erden.config.yml': 'yaml',
    'erden.config.yaml': 'yaml',
    'erden.config.toml': 'toml',
};

export function manifestFormatForFilename(filename: string): ManifestFormat | undefined {
    return Object.hasOwn(FORMAT_BY_FILENAME, filename) ? FORMAT_BY_FILENAME[filename as ManifestFilename] : undefined;
}

export const SUPPORTED_MANIFEST_EXTENSIONS = ['.json', '.jsonc', '.yml', '.yaml', '.toml'] as const;

export function manifestFormatForExplicitFilename(filename: string): ManifestFormat | undefined {
    if (filename.endsWith('.json')) {
        return 'json';
    }
    if (filename.endsWith('.jsonc')) {
        return 'jsonc';
    }
    if (filename.endsWith('.yml') || filename.endsWith('.yaml')) {
        return 'yaml';
    }
    if (filename.endsWith('.toml')) {
        return 'toml';
    }
    return undefined;
}

export function compareCodePoints(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
