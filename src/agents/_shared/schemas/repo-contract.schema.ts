import { z } from 'zod';
import { NO_OP_SCRIPT_RE } from '../../../conductor/gate-integrity';

// ─── Repo Contract ──────────────────────────────────────────────────────────
// The single source of truth for WHERE code goes and WHAT it exports.
// Produced by the Architect, enforced mechanically, read by every downstream agent.

export const ModuleExportSchema = z.object({
    name: z.string().describe('Export name (e.g. "chooseTarget", "Ghost", "default")'),
    kind: z.enum([
        'function', 'class', 'const', 'type', 'interface',
        'component', 'hook', 'router', 'default',
    ]).describe('Export kind'),
    signature: z.string().describe('TypeScript-ish signature (e.g. "chooseTarget(ghost: Ghost, pac: PacMan, mode: Mode): Tile")'),
});
export type ModuleExport = z.infer<typeof ModuleExportSchema>;

export const ModuleContractSchema = z.object({
    /** Stable id referenced by tasks and assignments, e.g. 'MOD-GHOST-AI'. */
    id: z.string().describe('Stable module id (e.g. "MOD-GHOST-AI")'),
    /** Exact file path relative to the repo root, e.g. 'packages/frontend/src/game/GhostAI.ts'. */
    path: z.string().describe('Exact file path relative to repo root')
        .refine(p => !p.includes('generated-projects/'), {
            message: 'Module path must not contain "generated-projects/"',
        }),
    /** Which architecture component this module belongs to. */
    componentName: z.string().describe('Architecture component this module belongs to'),
    /** Named exports this module MUST provide, with their shapes as TypeScript-ish signatures. */
    exports: z.array(ModuleExportSchema).describe('Named exports this module MUST provide'),
    /** Module ids or bare package names this module may import. Enforced by the layout linter. */
    dependsOn: z.array(z.string()).default([]).describe('Module ids or package names this module may import'),
});
export type ModuleContract = z.infer<typeof ModuleContractSchema>;

export const StackRootContractSchema = z.object({
    /** Directory relative to repo root; '.' for a single-root project. */
    dir: z.string().describe('Directory relative to repo root ("." for single-root)'),
    kind: z.enum(['frontend', 'backend', 'shared', 'infra', 'e2e']).describe('Root kind'),
    /** Stack: 'node' | 'maven' | ... matching quality-gates StackKind. */
    stack: z.string().describe('Stack kind matching quality-gates (e.g. "node", "maven")'),
    /** Entry point files that bootstrap this root, e.g. ['src/main.tsx'] or ['src/server.ts']. */
    entryPoints: z.array(z.string()).min(1).describe('Entry point files that bootstrap this root'),
    /** Directories agents may create files in, relative to `dir`. */
    sourceDirs: z.array(z.string()).min(1).describe('Directories agents may create source files in, relative to `dir`'),
    /** Where tests go, relative to `dir`. */
    testDirs: z.array(z.string()).min(1).describe('Directories for test files, relative to `dir`'),
    /** Exact npm/maven/... scripts this root must expose. FROZEN once set (Sub-Plan 02). */
    scripts: z.record(z.string(), z.string()).describe('Required scripts (e.g. { "build": "vite build", "test": "jest" })')
        .refine(scripts => {
            for (const val of Object.values(scripts)) {
                if (NO_OP_SCRIPT_RE.test(val)) return false;
            }
            return true;
        }, { message: 'Scripts must not be no-ops (echo, exit 0, true, etc.)' }),
    /** Build output directory relative to `dir`, or null for non-bundled roots. */
    buildOutputDir: z.string().nullable().describe('Build output directory relative to `dir`, or null for non-bundled roots'),
});
export type StackRootContract = z.infer<typeof StackRootContractSchema>;

export const RepoContractSchema = z.object({
    /** 'single-root' | 'npm-workspaces' | 'multi-stack' — decided ONCE by the Architect. */
    layout: z.enum(['single-root', 'npm-workspaces', 'multi-stack']).describe('Repository layout'),
    roots: z.array(StackRootContractSchema).min(1).describe('Stack roots in the repository'),
    modules: z.array(ModuleContractSchema).describe('Declared modules with paths and exports'),
    /** File naming convention, e.g. 'PascalCase for components, camelCase for utils, kebab-case for routes'. */
    namingConvention: z.string().describe('File naming convention (e.g. "PascalCase components, camelCase utils")'),
    /** Shared type/interface file paths every root may import. */
    sharedTypes: z.array(z.string()).default([]).describe('Shared type/interface file paths'),
    /** Paths that are frozen after scaffolding (config files). Informational; enforcement lives in Sub-Plan 02. */
    frozenPaths: z.array(z.string()).default([]).describe('Paths frozen after scaffolding'),
});
export type RepoContract = z.infer<typeof RepoContractSchema>;
