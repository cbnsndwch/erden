import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBoundaryFailures } from './lib/open-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
function requireFile(relativePath) {
    if (!existsSync(resolve(root, relativePath))) {
        failures.push(`Required path is missing: ${relativePath}`);
    }
}
function read(relativePath) {
    return readFileSync(resolve(root, relativePath), 'utf8');
}
const workspace = read('pnpm-workspace.yaml');
for (const member of ['apps/*', 'packages/*', 'reasoner/*', 'shacl/*']) {
    if (
        !workspace.includes(`"${member}"`) &&
        !workspace.includes(`'${member}'`) &&
        !workspace.includes(`- ${member}`)
    ) {
        failures.push(`pnpm-workspace.yaml must declare ${member}`);
    }
}
let manifest;
try {
    manifest = JSON.parse(read('package.json'));
} catch (error) {
    failures.push(`Root package.json is invalid JSON: ${error.message}`);
}

if (manifest) {
    if (manifest.private !== true) {
        failures.push('Root package.json must be private');
    }
    if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? '')) {
        failures.push('Root package.json must pin pnpm with packageManager');
    }
    for (const field of ['bin', 'exports', 'dependencies', 'peerDependencies', 'optionalDependencies']) {
        if (field in manifest) {
            failures.push(`Root package.json must not define ${field}`);
        }
    }
    if (!Array.isArray(manifest.files) || manifest.files.length !== 0) {
        failures.push('Root package.json must use an empty files allowlist');
    }
    if (manifest.scripts?.prepublishOnly !== 'node scripts/refuse-publish.mjs') {
        failures.push('Root package.json must explicitly refuse normal publishing');
    }
    for (const script of ['bootstrap:workspace', 'check:boundaries', 'prepublishOnly', 'test', 'check:fast', 'check']) {
        if (!(script in (manifest.scripts ?? {}))) {
            failures.push(`Root package.json is missing script: ${script}`);
        }
    }
    if (
        !/^pnpm install --frozen-lockfile --ignore-scripts(?: && node scripts\/restore-workspace-modes\.mjs)?$/u.test(
            manifest.scripts?.['bootstrap:workspace'] ?? '',
        )
    ) {
        failures.push('Root bootstrap must install only the exact native Erden workspace graph');
    }
    for (const script of ['test', 'check:fast', 'check']) {
        if (manifest.scripts?.[script] !== 'pnpm run check:workspace') {
            failures.push(`Root ${script} must be an exact native workspace-check alias`);
        }
    }
    if (manifest.scripts?.build !== 'turbo run build' || manifest.scripts?.['build:runtime'] !== 'turbo run build') {
        failures.push('Root builds must use the Turbo workspace graph');
    }
    if (!/^oxlint --type-aware \.(?: && |$)/u.test(manifest.scripts?.lint ?? '')) {
        failures.push('Root lint must run type-aware Oxlint');
    }
    if (manifest.scripts?.format !== 'oxfmt .' || manifest.scripts?.['format:check'] !== 'oxfmt --check .') {
        failures.push('Root formatting must use Oxfmt across the repository');
    }
    if (!manifest.scripts?.['check:workspace']?.includes('pnpm run format:check')) {
        failures.push('The workspace gate must enforce Oxfmt formatting');
    }
}
const oxlint = JSON.parse(read('.oxlintrc.json'));
if (oxlint.options?.typeAware !== true || oxlint.options?.maxWarnings !== 0) {
    failures.push('Oxlint must require type-aware analysis and reject warnings');
}
if (!oxlint.plugins?.includes('import')) {
    failures.push('Oxlint must enable the built-in import plugin');
}
if (JSON.stringify(oxlint.rules?.curly) !== JSON.stringify(['error', 'all'])) {
    failures.push('Oxlint must require braces around every control-flow body');
}
if (
    JSON.stringify(oxlint.rules?.['import/newline-after-import']) !==
    JSON.stringify(['error', { count: 1, exactCount: true, considerComments: true }])
) {
    failures.push('Oxlint must require exactly one blank line after imports, including adjacent comments');
}
const oxfmt = JSON.parse(read('.oxfmtrc.json'));
if (oxfmt.useTabs !== false || oxfmt.tabWidth !== 4) {
    failures.push('Oxfmt must use four spaces and no tabs');
}
const expectedImportSorting = {
    customGroups: [{ groupName: 'erden-workspace', elementNamePattern: ['@erden/**'] }],
    groups: ['builtin', 'external', 'erden-workspace', 'parent', ['sibling', 'index'], 'unknown'],
    newlinesBetween: true,
    sortSideEffects: false,
};
if (JSON.stringify(oxfmt.sortImports) !== JSON.stringify(expectedImportSorting)) {
    failures.push('Oxfmt must group imports as Node, external, Erden workspace, parent, then sibling');
}
const turbo = JSON.parse(read('turbo.json'));
const buildTask = turbo.tasks?.build;
if (JSON.stringify(buildTask?.dependsOn) !== JSON.stringify(['^build'])) {
    failures.push('Turbo builds must follow workspace dependency edges');
}
for (const output of ['dist/**', 'build/**']) {
    if (!buildTask?.outputs?.includes(output)) {
        failures.push(`Turbo build caching must track ${output}`);
    }
}
requireFile('scripts/refuse-publish.mjs');
requireFile('apps/cli/src/registry.ts');
requireFile('apps/cli/test/registry.test.ts');
// Open packages never depend on proprietary ones, in manifests or in any source or test file.
failures.push(...openBoundaryFailures(root));
const registrySource = read('packages/project/src/dependencies/registry.ts');
for (const forbidden of [
    "from 'node:http'",
    "from 'node:https'",
    "from 'node:dns'",
    "from 'node:fs'",
    "from 'undici'",
    'fetch(',
    'process.env',
    'LOCALAPPDATA',
    'XDG_DATA_HOME',
]) {
    if (registrySource.includes(forbidden)) {
        failures.push(
            `The production dependency-registry boundary must not gain transport or environment capability: ${forbidden}`,
        );
    }
}
for (const required of [
    'unavailableDependencyRegistry',
    'DependencyRegistryUnavailableError',
    'resolveAlias: unavailable',
    'listPublished: unavailable',
    'fetchArchive: unavailable',
]) {
    if (!registrySource.includes(required)) {
        failures.push(`The fail-closed production registry boundary is missing: ${required}`);
    }
}
const projectPathSource = read('packages/project/src/project-path/operation.ts');
for (const forbidden of [
    '.put(',
    '.repair(',
    '.materialize(',
    'DependencyRegistry',
    'fetchArchive',
    'listPublished',
    'resolveAlias',
]) {
    if (projectPathSource.includes(forbidden)) {
        failures.push(`ProjectPath must remain a narrow read-only operation: ${forbidden}`);
    }
}
for (const [label, path] of [
    ['CheckProject', 'packages/project/src/check/operation.ts'],
    ['InstallProject', 'packages/project/src/install/operation.ts'],
    ['PackProject', 'packages/project/src/pack/operation.ts'],
    ['ProjectPath', 'packages/project/src/project-path/operation.ts'],
]) {
    const source = read(path);
    for (const forbidden of ['nodeProjectLockService', 'ProjectLockService']) {
        if (source.includes(forbidden)) {
            failures.push(
                `${label} must read project dependency state atomically instead of using ProjectLock directly: ${forbidden}`,
            );
        }
    }
    if (!source.includes('recheck')) {
        failures.push(`${label} is missing its terminal ProjectDependencyState revision recheck`);
    }
}
const projectDependenciesSource = read('packages/project/src/project-dependencies/operation.ts');
for (const forbidden of ["from 'node:http'", "from 'node:https'", 'fetch(', 'store prune']) {
    if (projectDependenciesSource.includes(forbidden)) {
        failures.push(`ProjectDependencies must not gain transport, update, or prune capability: ${forbidden}`);
    }
}
for (const required of [
    'full-graph',
    'pruned-exact',
    'update-targeted-frozen',
    "manifest: { kind: 'preserve' }",
    'PROJECT_DEPENDENCIES_COMMITTED_NOT_INSTALLED',
]) {
    if (!projectDependenciesSource.includes(required)) {
        failures.push(`ProjectDependencies is missing its accepted lifecycle truth: ${required}`);
    }
}
const projectDependencyStateSource = read('packages/project/src/project-dependency-state/operation.ts');
for (const forbidden of [
    'DependencyRegistry',
    'LocalPackageStore',
    'CheckProject',
    'PackProject',
    '.materialize(',
    '.repair(',
    'fetchArchive',
    'listPublished',
    'resolveAlias',
    'rm(',
    'rename(',
]) {
    if (projectDependencyStateSource.includes(forbidden)) {
        failures.push(
            `ProjectDependencyState must remain a bounded manifest/lock transaction without registry, store, or recursive mutation capability: ${forbidden}`,
        );
    }
}
for (const required of [
    "const ACTIVE_MARKER_NAME = '.erden.dependencies.transaction.json'",
    "const TRANSACTION_PREFIX = '.erden.dependencies.'",
    "readonly manifestKind: 'preserve' | 'replace'",
    'scan.activeMarker !== null || scan.entries.length !== 0',
]) {
    if (!projectDependencyStateSource.includes(required)) {
        failures.push(`ProjectDependencyState is missing a paired-state boundary guard: ${required}`);
    }
}
const projectLockSource = read('packages/project/src/project-lock/operation.ts');
if (!projectLockSource.includes("portableKey('.erden.dependencies.')")) {
    failures.push('Direct ProjectLock access must reject paired dependency-state transaction residue');
}
const storePathSource = read('packages/project/src/store-path/operation.ts');
for (const forbidden of [
    "from 'node:fs'",
    'makeNodeStoreFileSystemPort',
    'nodeLocalPackageStore',
    '.mkdir(',
    '.open(',
]) {
    if (storePathSource.includes(forbidden)) {
        failures.push(`StorePath must remain an environment-only operation: ${forbidden}`);
    }
}
const storeMaintenanceSource = read('packages/project/src/store-maintenance/operation.ts');
for (const forbidden of [
    "from 'node:http'",
    "from 'node:https'",
    "from 'node:fs'",
    'DependencyRegistry',
    'fetchArchive',
    'listPublished',
    'resolveAlias',
    '.materialize(',
    '.repair(',
    '.write(',
]) {
    if (storeMaintenanceSource.includes(forbidden)) {
        failures.push(
            `StoreMaintenance must remain a zero-network store-index operation without project mutation: ${forbidden}`,
        );
    }
}
for (const required of ['inspectStoreIndex', 'pruneStore', 'dryRun', 'STORE_MAINTENANCE_PRUNE_BLOCKED']) {
    if (!storeMaintenanceSource.includes(required)) {
        failures.push(`StoreMaintenance is missing accepted local lifecycle truth: ${required}`);
    }
}
const packProjectSource = read('packages/project/src/pack/operation.ts');
for (const forbidden of [
    'CheckProject',
    'DependencyRegistry',
    'LocalPackageStore',
    '.materialize(',
    '.repair(',
    'fetchArchive',
    'listPublished',
    'resolveAlias',
]) {
    if (packProjectSource.includes(forbidden)) {
        failures.push(
            `PackProject must remain a snapshot-and-codec operation without semantic, registry, or store capabilities: ${forbidden}`,
        );
    }
}
for (const required of ['normalizePublicationManifestV1', 'PACK_PROJECT_MANIFEST_NOT_PORTABLE']) {
    if (!packProjectSource.includes(required)) {
        failures.push(`PackProject is missing publishable-package portability enforcement: ${required}`);
    }
}
const publicationManifestSource = read('packages/contracts/src/manifest/publication.ts');
for (const forbidden of ["from 'node:fs'", "from 'node:http'", "from 'node:https'", 'fetch(', 'process.env']) {
    if (publicationManifestSource.includes(forbidden)) {
        failures.push(`Publication manifest refinement must remain a pure package-path policy: ${forbidden}`);
    }
}
for (const required of [
    'normalizeManifestV1',
    'normalizePackagePath',
    'sources.ontology',
    'sources.shapes',
    'sources.competencyQuestions',
    'citationRoots',
]) {
    if (!publicationManifestSource.includes(required)) {
        failures.push(`Publication manifest refinement is missing a portable containment guard: ${required}`);
    }
}
const publicationModelSource = read('packages/contracts/src/publication/model.ts');
for (const required of [
    "'failed' | 'queued' | 'succeeded' | 'validating'",
    "'candidate' | 'operational' | 'operational-exhausted' | 'policy' | 'semantic'",
    'maxValidationExecutions: 3',
    'maxPreflightFailures: 3',
    'maxClaimRequestRecords:',
    'maxGeneratedIdSearch:',
    'retryBackoffMilliseconds',
    "'erden.publication-report-summary/v1'",
    'maxStatusBytes: 64 * 1_024',
    'maxReportSummaryBytes: 64 * 1_024',
]) {
    if (!publicationModelSource.includes(required)) {
        failures.push(`Publication coordination is missing an accepted closed-state invariant: ${required}`);
    }
}
const registryReleaseIndexModelSource = read('packages/contracts/src/registry-release-index/model.ts');
for (const forbidden of [
    'preferredAlias',
    'publishedAt',
    'manifestSha256',
    'byteSize',
    'projectId',
    'files',
    'provenance',
    'visibility',
    'closure',
]) {
    if (registryReleaseIndexModelSource.includes(forbidden)) {
        failures.push(
            `The compact registry release projection must not expose project policy or package inventories: ${forbidden}`,
        );
    }
}
for (const required of [
    'fixedPageItems: 32',
    'maxRowsExaminedPerPage: 33',
    'maxDependenciesPerRelease:',
    'maxDependencyEdgesPerPage:',
    'maxReleaseHistory: 2_048',
    'maxHistoryEncodedBytes: 128 * 1024 * 1024',
    'maxReleaseEncodedBytes: 14 * 1024 * 1024',
    'maxPageEncodedBytes: 16 * 1024 * 1024',
    'maxPages: 64',
    'maxResolverMetadataBytes: 128 * 1024 * 1024',
    'derivedMaximumReleaseBytes: 13_769_037',
    'decodeRegistryReleaseIndexPage',
    'decodeRegistryReleaseIndexEntry',
    'compareRegistryVersions',
]) {
    if (!registryReleaseIndexModelSource.includes(required)) {
        failures.push(
            `The compact registry release model is missing an accepted closed limit or identity: ${required}`,
        );
    }
}
const registryReleaseIndexWireSource = read('packages/contracts/src/registry-release-index/wire.ts');
for (const required of [
    'decodeRegistryIndexReleaseWire',
    'decodeRegistryAliasResolutionWire',
    'decodeRegistryReleaseIndexPageWire',
    'decodeRegistryReleaseIndexEntryWire',
    'fatal: true',
    'equalBytes(bytes, canonical)',
]) {
    if (!registryReleaseIndexWireSource.includes(required)) {
        failures.push(`The registry release-index wire codec is missing canonical closed decoding: ${required}`);
    }
}
const dependencyResolverSource = read('packages/project/src/dependencies/resolver.ts');
for (const required of [
    'interface ResolverRelease',
    'makeDependencyResolverFromReleaseIndex',
    'encodeRegistryIndexRelease',
    'decodeRegistryReleaseIndexPage',
    'maxCatalogMetadataBytes',
]) {
    if (!dependencyResolverSource.includes(required)) {
        failures.push(`The dependency resolver is missing its private compact release adapter: ${required}`);
    }
}
for (const forbidden of ['files: []', 'files: Object.freeze([])']) {
    if (dependencyResolverSource.includes(forbidden)) {
        failures.push(
            `The dependency resolver must not fabricate a package manifest or empty file inventory: ${forbidden}`,
        );
    }
}
const clientManifest = JSON.parse(read('packages/client/package.json'));
if (
    JSON.stringify(clientManifest.dependencies) !==
    JSON.stringify({
        '@erden/contracts': 'workspace:0.0.0',
        effect: '4.0.0-rc.111',
    })
) {
    failures.push('@erden/client must retain only its exact contracts and Effect dependencies');
}
const clientSource = [
    'packages/client/src/credentials.ts',
    'packages/client/src/device-login.ts',
    'packages/client/src/http.ts',
    'packages/client/src/publication.ts',
    'packages/client/src/registry.ts',
    'packages/client/src/wire.ts',
]
    .map(read)
    .join('\n');
for (const forbidden of [
    'better-auth',
    'drizzle',
    'postgres',
    "redirect: 'follow'",
    'listPublished',
    'S3Client',
    'presign',
    'arrayBuffer(',
]) {
    if (clientSource.includes(forbidden)) {
        failures.push(`Registry client must remain narrow and origin-fixed: ${forbidden}`);
    }
}
for (const required of [
    "redirect: 'manual'",
    "credentials: 'omit'",
    'CLIENT_ABORTED',
    'CLIENT_TIMEOUT',
    'erden.cli-credential/v1',
    "openSync(stage, 'wx', 0o600)",
    'deleteStoredCliCredentialRevision',
    'uploadPublication',
    'getPublicationAttempt',
    'getPublicationReport',
    'resolveRegistryAlias',
    'listRegistryReleases',
    'getExactRegistryRelease',
    'openRegistryArchive',
    'retryRegistryTransport',
    'hash.digest',
    'reader.cancel',
    'application/vnd.erden.package.v1',
]) {
    if (!clientSource.includes(required)) {
        failures.push(`Registry client is missing its accepted transport/file invariant: ${required}`);
    }
}
const cliSource = read('apps/cli/src/main.ts');
for (const command of [
    'erden install [project-dir]',
    'erden add <identifier>@<range>',
    'erden remove <identifier>',
    'erden path <layer>',
    'erden store path [--json]',
    'erden store status [--json]',
    'erden store prune [--dry-run] [--json]',
    'erden pack <version> [project-dir]',
    'erden publish <version> [project-dir]',
    'erden publication <attempt-id> [--registry <origin>]',
]) {
    if (!cliSource.includes(command)) {
        failures.push(`The local CLI help is missing the Batch 2.4b1 command: ${command}`);
    }
}
const cliRegistrySource = read('apps/cli/src/registry.ts');
for (const required of [
    'makeNodePublicationArchiveSource',
    'publicationIdempotencyKey',
    'erden.cli-publish-idempotency/v1\\0',
    'function registryFromManifest',
    'PUBLICATION_MAXIMUM_POLLS',
    'PUBLICATION_UPLOAD_MILLISECONDS',
    'readStoredCliCredential',
    'uploadPublication',
    'getPublicationAttempt',
    'getPublicationReport',
    'signal: cancellation.signal',
    "create === false ? 'existing' : `create:${create}`",
    'makeCliDependencyRegistryComposition',
    'makeNodeCliDependencyRegistryComposition',
    'resolveRegistryAlias',
    'listRegistryReleases',
    'getExactRegistryRelease',
    'openRegistryArchive',
    'DependencyArchiveReaderShape',
    'RegistryReleaseIndexReaderShape',
]) {
    if (!cliRegistrySource.includes(required)) {
        failures.push(`The CLI registry workflow is missing its closed boundary: ${required}`);
    }
}
for (const forbidden of [
    'makePublicationWorker',
    'makePersistedPublicationWorker',
    "from 'node:http'",
    "from 'node:https'",
    'fetch(',
    'process.env',
    'listPublished',
    'presign',
    'S3Client',
]) {
    if (cliRegistrySource.includes(forbidden)) {
        failures.push(`The CLI registry workflow must remain client-only: ${forbidden}`);
    }
}
function walkMarkdown(directory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
        if (['.git', 'legacy', 'node_modules'].includes(entry.name)) {
            continue;
        }
        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            paths.push(...walkMarkdown(absolutePath));
        }
        if (entry.isFile() && extname(entry.name) === '.md') {
            paths.push(absolutePath);
        }
    }
    return paths;
}
function isExternalLink(target) {
    return /^(?:[a-z][a-z+.-]*:|\/\/)/i.test(target);
}
for (const markdownPath of walkMarkdown(root)) {
    const markdown = readFileSync(markdownPath, 'utf8');
    const links = markdown.matchAll(/\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/g);
    for (const match of links) {
        const target = match[1].replace(/^<|>$/g, '');
        const localTarget = target.split(/[?#]/, 1)[0];
        if (!localTarget || isExternalLink(localTarget)) {
            continue;
        }
        const targetPath = localTarget.startsWith('/')
            ? resolve(root, `.${localTarget}`)
            : resolve(dirname(markdownPath), localTarget);
        if (!existsSync(targetPath)) {
            failures.push(`Broken local Markdown link: ${relative(root, markdownPath)} -> ${target}`);
        }
    }
}
// The reasoner trust boundary is enforced in code, not by convention: what the protocol computed while sealing a
// request or opening an answer, and the graph byte-backed assembly hands to the fused path, are reachable only from
// the modules that record and read them; and no production composition picks the reasoner a check runs.
function trustBoundarySources() {
    const sources = [];
    function visit(directory) {
        for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
            const entryPath = `${directory}/${entry.name}`;
            if (entry.isDirectory() && !['node_modules', 'dist', 'build', 'test'].includes(entry.name)) {
                visit(entryPath);
            } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
                sources.push({ path: entryPath, text: read(entryPath) });
            }
        }
    }
    for (const group of ['apps', 'packages', 'reasoner']) {
        for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
            if (entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src'))) {
                visit(`${group}/${entry.name}/src`);
            }
        }
    }
    return sources;
}
const trustBoundaryImports = [
    {
        module: /from '\.\/sealed\.js'|from '\.\.\/sealed\.js'|\/protocol\/src\/sealed/u,
        allowed: ['reasoner/protocol/src/compatibility.ts', 'reasoner/protocol/src/wire.ts'],
        label: 'the protocol memo of sealed requests and opened answers (reasoner/protocol/src/sealed.ts)',
    },
    {
        module: /reasoner\/ownership\.js'|from '\.\/ownership\.js'/u,
        allowed: ['packages/ontology/src/service.ts', 'packages/ontology/src/reasoner/process.ts'],
        label: 'the assembly hand-over (packages/ontology/src/reasoner/ownership.ts)',
    },
];
const reasonerSeamDefinitions = new Set([
    'packages/ontology/src/reasoner/process.ts',
    'packages/ontology/src/reasoner/service.ts',
]);
for (const { path, text } of trustBoundarySources()) {
    for (const guard of trustBoundaryImports) {
        if (guard.module.test(text) && !guard.allowed.includes(path)) {
            failures.push(`${path} must not import ${guard.label}`);
        }
    }
    if (/export \* from '\.\/(sealed|reasoner\/ownership|ownership)\.js'/u.test(text)) {
        failures.push(`${path} must not re-export a trust-boundary memo`);
    }
    if (!reasonerSeamDefinitions.has(path)) {
        if (/makeReasonerService\(\s*[^)\s][^)]*,/u.test(text) || text.includes('ReasonerArtifactResolver')) {
            failures.push(
                `${path} must not choose the reasoner a check runs: only measurement harnesses pass makeReasonerService an artifact`,
            );
        }
    }
}

if (failures.length > 0) {
    console.error('Repository boundary check failed:');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log('Repository boundaries are intact.');
}
