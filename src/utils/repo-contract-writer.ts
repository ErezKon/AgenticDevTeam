/**
 * Repo Contract Writer — write, read, and render the architecture contract.
 *
 * The repo contract is the single source of truth for WHERE code goes and
 * WHAT it exports. This module handles persistence (JSON + Markdown),
 * reading with validation, compact prompt rendering, and inference from
 * an existing codebase analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    RepoContract,
    ModuleContract,
    ModuleExport,
    StackRootContract,
} from '../agents/_shared/schemas/repo-contract.schema';
import { RepoContractSchema } from '../agents/_shared/schemas/repo-contract.schema';
import type { CodebaseAnalysis } from '../agents/_shared/base-schemas';
import { CONTRACT_PROMPT_MAX_CHARS } from '../config';
import { getLogger } from './logger';

const log = getLogger('[ContractWriter]', 183);

// ─── Constants ──────────────────────────────────────────────────────────────

const CONTRACT_JSON_REL = '.agent/repo-contract.json';
const CONTRACT_MD_REL = 'docs/ARCHITECTURE-CONTRACT.md';

/** Common entry-point file names to scan for when deriving contracts. */
const ENTRY_POINT_NAMES = [
    'main.tsx', 'main.ts', 'main.js',
    'index.tsx', 'index.ts', 'index.js',
    'server.ts', 'server.js',
    'app.ts', 'app.js',
];

/** Directories commonly used for source code. */
const COMMON_SOURCE_DIRS = ['src', 'lib', 'app', 'pages', 'components', 'routes'];

/** Directories commonly used for tests. */
const COMMON_TEST_DIRS = [
    'test', 'tests', '__tests__',
    'src/__tests__', 'src/test', 'spec',
    'e2e', 'cypress',
];

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Persist the repo contract as both machine-readable JSON and human-readable Markdown.
 *
 * - `.agent/repo-contract.json` — canonical, parsed by agents
 * - `docs/ARCHITECTURE-CONTRACT.md` — human-readable, committed to the repo
 *
 * Directories are created automatically if they do not exist.
 *
 * @param workspacePath - Absolute path to the repository root.
 * @param contract - The validated repo contract to write.
 * @returns Paths to the written JSON and Markdown files.
 */
export function writeRepoContract(
    workspacePath: string,
    contract: RepoContract,
): { jsonPath: string; mdPath: string } {
    // ── JSON (canonical) ────────────────────────────────────────────────
    const jsonPath = path.join(workspacePath, CONTRACT_JSON_REL);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(contract, null, 2), 'utf-8');
    log.info(`Wrote contract JSON: ${jsonPath}`);

    // ── Markdown (human-readable) ───────────────────────────────────────
    const mdPath = path.join(workspacePath, CONTRACT_MD_REL);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const markdown = renderContractMarkdown(contract);
    fs.writeFileSync(mdPath, markdown, 'utf-8');
    log.info(`Wrote contract Markdown: ${mdPath}`);

    return { jsonPath, mdPath };
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Read and validate the repo contract from `.agent/repo-contract.json`.
 *
 * @param workspacePath - Absolute path to the repository root.
 * @returns The parsed and validated contract, or `null` if the file is
 *          missing or fails validation.
 */
export function readRepoContract(workspacePath: string): RepoContract | null {
    const jsonPath = path.join(workspacePath, CONTRACT_JSON_REL);
    if (!fs.existsSync(jsonPath)) {
        log.info(`No contract found at ${jsonPath}`);
        return null;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const result = RepoContractSchema.safeParse(raw);
        if (!result.success) {
            log.warn(`Contract validation failed: ${result.error.message}`);
            return null;
        }
        log.info(`Loaded contract from ${jsonPath} (${result.data.modules.length} modules)`);
        return result.data;
    } catch (err) {
        log.warn(`Failed to read contract: ${(err as Error).message}`);
        return null;
    }
}

// ─── Prompt Rendering ───────────────────────────────────────────────────────

/**
 * Options for {@link renderContractForPrompt}.
 */
export interface RenderContractOpts {
    /** Module IDs the current agent owns — always included in full detail. */
    moduleIds?: string[];
    /** Hard character budget (default {@link CONTRACT_PROMPT_MAX_CHARS}). */
    maxChars?: number;
}

/**
 * Render the contract as a compact, token-budgeted string for injection
 * into an agent's system prompt.
 *
 * Owning modules (matching `moduleIds`) are rendered in full (exports,
 * dependencies). All other modules are listed compactly (id + path only,
 * or with a one-line export summary if budget allows).
 *
 * @param contract - The repo contract.
 * @param opts - Optional rendering options.
 * @returns A string ready to splice into a prompt, capped at `maxChars`.
 */
export function renderContractForPrompt(
    contract: RepoContract,
    opts?: RenderContractOpts,
): string {
    const maxChars = opts?.maxChars ?? CONTRACT_PROMPT_MAX_CHARS;
    const ownIds = new Set(opts?.moduleIds ?? []);

    const lines: string[] = [];

    // ── Header ──────────────────────────────────────────────────────────
    lines.push('## Repo Contract (binding — do not deviate)');
    lines.push(`Layout: ${contract.layout}`);

    // ── Roots ────────────────────────────────────────────────────────────
    for (const root of contract.roots) {
        const entry = root.entryPoints.map(e => e).join(', ');
        const source = root.sourceDirs.join(', ');
        const tests = root.testDirs.join(', ');
        lines.push(
            `Root \`${root.dir}\` (${root.kind}/${root.stack}): ` +
            `entry ${entry} | source ${source} | tests ${tests}`,
        );

        // Scripts + build output
        const scriptParts: string[] = [];
        for (const [name, cmd] of Object.entries(root.scripts)) {
            scriptParts.push(`${name}: \`${cmd}\``);
        }
        if (root.buildOutputDir) {
            scriptParts.push(`-> ${root.buildOutputDir}/`);
        }
        if (scriptParts.length > 0) {
            lines.push(`  ${scriptParts.join('   ')}`);
        }
    }

    // ── Naming convention ───────────────────────────────────────────────
    if (contract.namingConvention) {
        lines.push(`Naming: ${contract.namingConvention}`);
    }

    // ── Shared types ────────────────────────────────────────────────────
    if (contract.sharedTypes.length > 0) {
        lines.push(`Shared types: ${contract.sharedTypes.join(', ')}`);
    }

    // ── Frozen paths ────────────────────────────────────────────────────
    if (contract.frozenPaths.length > 0) {
        lines.push(`Frozen (do not modify): ${contract.frozenPaths.join(', ')}`);
    }

    // ── Partition modules ───────────────────────────────────────────────
    const ownModules: ModuleContract[] = [];
    const otherModules: ModuleContract[] = [];
    for (const mod of contract.modules) {
        if (ownIds.has(mod.id)) {
            ownModules.push(mod);
        } else {
            otherModules.push(mod);
        }
    }

    // ── Own modules (full detail) ───────────────────────────────────────
    if (ownModules.length > 0) {
        lines.push('Your modules:');
        for (const mod of ownModules) {
            lines.push(`  ${mod.id}  ${mod.path}`);
            for (const exp of mod.exports) {
                lines.push(`    export ${exp.kind} ${exp.signature}`);
            }
            if (mod.dependsOn.length > 0) {
                lines.push(`    depends on: ${mod.dependsOn.join(', ')}`);
            }
        }
    }

    // ── Other modules (compact) ─────────────────────────────────────────
    if (otherModules.length > 0) {
        lines.push('Modules you may import (do not modify):');
        for (const mod of otherModules) {
            const exportSummary = mod.exports
                .map(e => `export ${e.kind} ${e.name}`)
                .join('  ');
            const line = `  ${mod.id}  ${mod.path}   ${exportSummary}`;
            lines.push(line);
        }
    }

    // ── Budget enforcement ──────────────────────────────────────────────
    let result = lines.join('\n');

    if (result.length > maxChars) {
        // Re-render other modules without export summaries
        const trimmedLines = lines.slice(
            0,
            lines.indexOf('Modules you may import (do not modify):') + 1,
        );
        if (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1] === 'Modules you may import (do not modify):') {
            for (const mod of otherModules) {
                trimmedLines.push(`  ${mod.id}  ${mod.path}`);
            }
        }
        result = trimmedLines.join('\n');
    }

    // Final hard-cap: truncate at last complete line
    if (result.length > maxChars) {
        const truncated = result.slice(0, maxChars);
        const lastNewline = truncated.lastIndexOf('\n');
        result = lastNewline > 0
            ? truncated.slice(0, lastNewline)
            : truncated;
    }

    return result;
}

// ─── Derive from Analysis ───────────────────────────────────────────────────

/**
 * Infer a repo contract from an existing {@link CodebaseAnalysis}.
 *
 * Used in **maintain mode** where the codebase already exists and the
 * Architect did not produce a contract. Scans the workspace for
 * `package.json` scripts, entry points, source directories, and test
 * directories.
 *
 * @param analysis - The codebase analysis produced by the analyzer agent.
 * @param workspacePath - Absolute path to the repository root.
 * @returns A best-effort repo contract derived from the analysis.
 */
export function deriveContractFromAnalysis(
    analysis: CodebaseAnalysis,
    workspacePath: string,
): RepoContract {
    // ── Detect layout ───────────────────────────────────────────────────
    let layout: 'single-root' | 'npm-workspaces' | 'multi-stack' = 'single-root';
    const rootPkgPath = path.join(workspacePath, 'package.json');
    let rootPkgScripts: Record<string, string> = {};

    if (fs.existsSync(rootPkgPath)) {
        try {
            const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
            if (rootPkg.workspaces) {
                layout = 'npm-workspaces';
            }
            if (rootPkg.scripts && typeof rootPkg.scripts === 'object') {
                rootPkgScripts = rootPkg.scripts as Record<string, string>;
            }
        } catch {
            log.warn('Failed to parse root package.json');
        }
    }

    // ── Scan entry points ───────────────────────────────────────────────
    const entryPoints: string[] = [];
    for (const name of ENTRY_POINT_NAMES) {
        const candidates = [
            path.join(workspacePath, name),
            path.join(workspacePath, 'src', name),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                entryPoints.push(path.relative(workspacePath, candidate));
            }
        }
    }

    // Also pull entry points from the analysis
    if (analysis.entryPoints) {
        for (const ep of analysis.entryPoints) {
            if (!entryPoints.includes(ep.file)) {
                entryPoints.push(ep.file);
            }
        }
    }

    // Ensure at least one entry point
    if (entryPoints.length === 0) {
        entryPoints.push('src/index.ts');
    }

    // ── Scan source dirs ────────────────────────────────────────────────
    const sourceDirs: string[] = [];
    for (const dir of COMMON_SOURCE_DIRS) {
        const abs = path.join(workspacePath, dir);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            sourceDirs.push(dir);
        }
    }
    // Also scan src/ subdirectories
    const srcDir = path.join(workspacePath, 'src');
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
        if (!sourceDirs.includes('src')) sourceDirs.push('src');
        try {
            for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.name.startsWith('__') && !entry.name.startsWith('.')) {
                    const rel = `src/${entry.name}`;
                    if (!sourceDirs.includes(rel)) {
                        sourceDirs.push(rel);
                    }
                }
            }
        } catch {
            // ignore readdir errors
        }
    }
    if (sourceDirs.length === 0) {
        sourceDirs.push('src');
    }

    // ── Scan test dirs ──────────────────────────────────────────────────
    const testDirs: string[] = [];
    for (const dir of COMMON_TEST_DIRS) {
        const abs = path.join(workspacePath, dir);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            testDirs.push(dir);
        }
    }
    if (testDirs.length === 0) {
        testDirs.push('src/__tests__');
    }

    // ── Detect stack kind ───────────────────────────────────────────────
    let stack = 'node';
    if (fs.existsSync(path.join(workspacePath, 'pom.xml'))) {
        stack = 'maven';
    } else if (fs.existsSync(path.join(workspacePath, 'go.mod'))) {
        stack = 'go';
    } else if (fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) {
        stack = 'cargo';
    } else if (fs.existsSync(path.join(workspacePath, 'requirements.txt')) ||
               fs.existsSync(path.join(workspacePath, 'pyproject.toml'))) {
        stack = 'python';
    }

    // ── Detect root kind ────────────────────────────────────────────────
    let kind: 'frontend' | 'backend' | 'shared' | 'infra' | 'e2e' = 'frontend';
    const hasFrontend = analysis.frameworks.some(
        f => /react|vue|angular|svelte|next/i.test(f),
    );
    const hasBackend = analysis.frameworks.some(
        f => /express|fastify|koa|nestjs|spring|flask|django/i.test(f),
    );
    if (hasFrontend && !hasBackend) {
        kind = 'frontend';
    } else if (hasBackend && !hasFrontend) {
        kind = 'backend';
    } else if (hasBackend && hasFrontend) {
        kind = 'frontend'; // default to frontend for full-stack single-root
    }

    // ── Filter scripts (remove no-ops) ──────────────────────────────────
    const scripts: Record<string, string> = {};
    const NO_OP_RE = /^\s*(?:echo\b|exit\s+0|true\s*$)/;
    for (const [key, val] of Object.entries(rootPkgScripts)) {
        if (!NO_OP_RE.test(val)) {
            scripts[key] = val;
        }
    }

    // Ensure essential scripts exist
    if (!scripts.build && !scripts.start) {
        scripts.build = 'echo "no build configured"';
    }
    if (!scripts.test) {
        scripts.test = 'echo "no test configured"';
    }

    // ── Build output dir ────────────────────────────────────────────────
    let buildOutputDir: string | null = null;
    for (const dir of ['dist', 'build', 'out', 'target']) {
        if (fs.existsSync(path.join(workspacePath, dir))) {
            buildOutputDir = dir;
            break;
        }
    }

    // ── Assemble root ───────────────────────────────────────────────────
    const root: StackRootContract = {
        dir: '.',
        kind,
        stack,
        entryPoints,
        sourceDirs,
        testDirs,
        scripts,
        buildOutputDir,
    };

    // ── Derive modules from analysis ────────────────────────────────────
    const modules: ModuleContract[] = [];

    for (const analysisModule of analysis.modules) {
        const modId = `MOD-${analysisModule.name.toUpperCase().replace(/[^A-Z0-9]/g, '-')}`;
        const modPath = analysisModule.path || `src/${analysisModule.name}`;

        // Map file entries to exports (best-effort)
        const exports = analysisModule.files
            .filter(f => f.type === 'source')
            .slice(0, 5)
            .map(f => ({
                name: path.basename(f.path, path.extname(f.path)),
                kind: inferExportKind(f.path),
                signature: f.summary || f.path,
            }));

        const dependsOn = analysisModule.dependencies
            .map(d => `MOD-${d.toUpperCase().replace(/[^A-Z0-9]/g, '-')}`);

        modules.push({
            id: modId,
            path: modPath,
            componentName: analysisModule.responsibility || analysisModule.name,
            exports,
            dependsOn,
        });
    }

    // ── Naming convention ───────────────────────────────────────────────
    const namingConvention = inferNamingConvention(analysis);

    // ── Shared types ────────────────────────────────────────────────────
    const sharedTypes: string[] = [];
    for (const mod of analysis.modules) {
        for (const file of mod.files) {
            if (/types?\.(ts|d\.ts)$/i.test(file.path) || /interfaces?\.(ts|d\.ts)$/i.test(file.path)) {
                sharedTypes.push(file.path);
            }
        }
    }

    return {
        layout,
        roots: [root],
        modules,
        namingConvention,
        sharedTypes,
        frozenPaths: [],
    };
}

// ─── Private Helpers ────────────────────────────────────────────────────────

/**
 * Render the repo contract as a human-readable Markdown document.
 */
function renderContractMarkdown(contract: RepoContract): string {
    const lines: string[] = [];

    lines.push('# Architecture Contract');
    lines.push('');
    lines.push('> Auto-generated by the Architect agent. Do not edit manually.');
    lines.push('');

    // ── Layout ──────────────────────────────────────────────────────────
    lines.push('## Layout');
    lines.push('');
    lines.push(`**Repository layout:** \`${contract.layout}\``);
    lines.push('');

    // ── Naming convention ───────────────────────────────────────────────
    lines.push('## Naming Convention');
    lines.push('');
    lines.push(contract.namingConvention);
    lines.push('');

    // ── Directory tree / roots ───────────────────────────────────────────
    lines.push('## Stack Roots');
    lines.push('');
    for (const root of contract.roots) {
        lines.push(`### \`${root.dir}\` (${root.kind} / ${root.stack})`);
        lines.push('');
        lines.push(`- **Entry points:** ${root.entryPoints.map(e => `\`${e}\``).join(', ')}`);
        lines.push(`- **Source dirs:** ${root.sourceDirs.map(d => `\`${d}\``).join(', ')}`);
        lines.push(`- **Test dirs:** ${root.testDirs.map(d => `\`${d}\``).join(', ')}`);
        if (root.buildOutputDir) {
            lines.push(`- **Build output:** \`${root.buildOutputDir}/\``);
        }
        lines.push('');

        // Scripts table
        const scriptEntries = Object.entries(root.scripts);
        if (scriptEntries.length > 0) {
            lines.push('| Script | Command |');
            lines.push('|--------|---------|');
            for (const [name, cmd] of scriptEntries) {
                lines.push(`| \`${name}\` | \`${cmd}\` |`);
            }
            lines.push('');
        }
    }

    // ── Module table ────────────────────────────────────────────────────
    lines.push('## Modules');
    lines.push('');
    if (contract.modules.length > 0) {
        lines.push('| ID | Path | Component | Exports | Depends On |');
        lines.push('|----|------|-----------|---------|------------|');
        for (const mod of contract.modules) {
            const exports = mod.exports
                .map(e => `\`${e.name}\` (${e.kind})`)
                .join(', ');
            const deps = mod.dependsOn.join(', ') || '—';
            lines.push(`| ${mod.id} | \`${mod.path}\` | ${mod.componentName} | ${exports} | ${deps} |`);
        }
        lines.push('');
    } else {
        lines.push('_No modules declared._');
        lines.push('');
    }

    // ── Shared types ────────────────────────────────────────────────────
    if (contract.sharedTypes.length > 0) {
        lines.push('## Shared Types');
        lines.push('');
        for (const t of contract.sharedTypes) {
            lines.push(`- \`${t}\``);
        }
        lines.push('');
    }

    // ── Frozen paths ────────────────────────────────────────────────────
    if (contract.frozenPaths.length > 0) {
        lines.push('## Frozen Paths');
        lines.push('');
        lines.push('These files are locked after scaffolding and must not be modified by agents:');
        lines.push('');
        for (const p of contract.frozenPaths) {
            lines.push(`- \`${p}\``);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Infer the export kind from a file path (best-effort heuristic).
 */
function inferExportKind(filePath: string): ModuleExport['kind'] {
    const base = path.basename(filePath, path.extname(filePath));
    if (/^[A-Z]/.test(base)) {
        if (/\.(tsx|jsx)$/.test(filePath)) return 'component';
        if (/^use[A-Z]/.test(base)) return 'hook';
        return 'class';
    }
    if (/types?$|interfaces?$/i.test(base)) return 'interface';
    return 'function';
}

/**
 * Infer a naming convention string from the analysis modules.
 */
function inferNamingConvention(analysis: CodebaseAnalysis): string {
    const parts: string[] = [];

    const hasReact = analysis.frameworks.some(f => /react|next/i.test(f));
    if (hasReact) {
        parts.push('PascalCase components');
    }

    // Check file names for patterns
    const fileNames = analysis.modules.flatMap(m => m.files.map(f => path.basename(f.path, path.extname(f.path))));
    const hasCamel = fileNames.some(n => /^[a-z][a-zA-Z]+$/.test(n));
    const hasKebab = fileNames.some(n => /^[a-z]+-[a-z]+/.test(n));

    if (hasCamel) parts.push('camelCase utils');
    if (hasKebab) parts.push('kebab-case files');

    return parts.length > 0
        ? parts.join(', ') + '.'
        : 'Follow existing codebase conventions.';
}
