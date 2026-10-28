import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = process.argv[2];
if (projectRoot === undefined || !isAbsolute(projectRoot) || projectRoot.includes('\0')) {
    throw new Error('The installed dependency fixture requires one absolute project root');
}

const installedRoot = process.cwd();
const projectManifest = resolve(installedRoot, 'node_modules', '@erden', 'project', 'package.json');
const contractsEntry = resolve(installedRoot, 'node_modules', '@erden', 'contracts', 'dist', 'index.js');
const projectEntry = resolve(installedRoot, 'node_modules', '@erden', 'project', 'dist', 'index.js');
const packageFormatEntry = resolve(installedRoot, 'node_modules', '@erden', 'package-format', 'dist', 'index.js');
const requireFromProject = createRequire(realpathSync(projectManifest));
const [{ Effect }, contracts, project, packageFormat] = await Promise.all([
    import(pathToFileURL(requireFromProject.resolve('effect')).href),
    import(pathToFileURL(contractsEntry).href),
    import(pathToFileURL(projectEntry).href),
    import(pathToFileURL(packageFormatEntry).href),
]);

const toolchain = await Effect.runPromise(contracts.nodeCurrentToolchainService.inspect());
const archive = packageFormat.encodePackage({
    canonicalIri: 'https://example.test/packed-package',
    version: '1.0.0',
    dependencies: [],
    validator: toolchain.validator,
    reasoner: toolchain.reasoner,
    files: [{ path: 'ontology.ttl', bytes: '<urn:packed> <urn:p> <urn:o> .\n', executable: false }],
});
const manifest = contracts.normalizeManifestV1({
    schemaVersion: 1,
    canonicalIri: 'https://example.test/packed-consumer',
    alias: '@example/packed-consumer',
    ownedIriPrefixes: ['https://example.test/packed-consumer#'],
    registry: 'https://registry.example',
    dependencies: { '@example/packed-package': '^1.0.0' },
    sources: { ontology: ['ontology.ttl'] },
});
await mkdir(projectRoot, { recursive: true });
await writeFile(join(projectRoot, 'erden.config.json'), contracts.serializeManifestV1(manifest, 'json'), {
    mode: 0o644,
});
await writeFile(join(projectRoot, 'ontology.ttl'), '<urn:consumer> <urn:p> <urn:o> .\n', { mode: 0o644 });
const registry = project.makeFixtureDependencyRegistry({
    registryOrigin: 'https://registry.example',
    aliases: [{ alias: '@example/packed-package', canonicalIri: 'https://example.test/packed-package' }],
    packages: [
        {
            canonicalIri: 'https://example.test/packed-package',
            version: '1.0.0',
            archiveSha256: archive.archiveSha256,
            manifest: archive.manifest,
            archive: archive.archiveBytes,
        },
    ],
});
await Effect.runPromise(
    project.makeNodeInstallProjectService(registry).install({
        from: projectRoot,
        storeRoot: project.resolveDefaultStoreRoot(project.nodeStoreEnvironment()),
    }),
);
